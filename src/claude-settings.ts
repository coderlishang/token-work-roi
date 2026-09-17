/**
 * Resolve the request-side model identity Claude Code is configured to use.
 *
 * Volcengine Ark's Coding Plan "Auto" scheduling answers every request with
 * model "auto"; neither the response body nor the response headers expose
 * which backend model actually served it (verified 2026-09 against the
 * coding-plan endpoint). The one locally knowable specific model is the
 * request model: the alias configured in Claude Code settings
 * (ANTHROPIC_MODEL / ANTHROPIC_DEFAULT_*_MODEL), which is sent with every
 * call regardless of the scheduling mode selected in the Ark console.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configuredPaths, envPathList } from './collector-config.ts';

const MODEL_ENV_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL'
];

let cachedName;

export function configuredClaudeRequestModel() {
  if (cachedName !== undefined) return cachedName;
  cachedName = null;
  for (const root of claudeConfigRoots()) {
    const env = readSettingsEnv(join(root, 'settings.json'));
    for (const key of MODEL_ENV_KEYS) {
      const value = String(env[key] || '').trim().toLowerCase();
      // A configured "auto" is exactly the opaque name we are trying to
      // replace; keep looking for a concrete alias instead.
      if (value && value !== 'auto') {
        cachedName = value;
        return cachedName;
      }
    }
  }
  return cachedName;
}

// Test hook: settings changes within a process lifetime are only picked up
// after clearing the memo.
export function resetClaudeRequestModelCache() {
  cachedName = undefined;
}

function claudeConfigRoots() {
  const envRoots = envPathList(process.env.CLAUDE_CONFIG_DIR);
  return envRoots.length ? envRoots : configuredPaths('claude', 'roots');
}

function readSettingsEnv(settingsPath) {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
    return parsed && typeof parsed.env === 'object' && parsed.env ? parsed.env : {};
  } catch {
    return {};
  }
}
