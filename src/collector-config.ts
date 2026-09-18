import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

interface ScheduledCollectConfig {
  enabled?: boolean;
  intervalSeconds?: number;
  runOnStart?: boolean;
  device?: string;
}

interface CollectorConfigRoot {
  collectors?: Record<string, Record<string, unknown>>;
  scheduledCollect?: ScheduledCollectConfig;
  modelAliases?: Record<string, string | { to: string; from: string }>;
}

let cachedConfig: CollectorConfigRoot | undefined;

export function loadCollectorConfig(): CollectorConfigRoot {
  if (cachedConfig) return cachedConfig;

  const configPath = process.env.TOKEN_WORK_CONFIG ||
    resolve(process.cwd(), 'config', 'collectors.json');

  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
    cachedConfig = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as CollectorConfigRoot
      : { collectors: {} };
  } catch {
    cachedConfig = { collectors: {} };
  }

  return cachedConfig;
}

export function resetConfigCache(): void {
  cachedConfig = undefined;
}

export function collectorConfig(name: string): Record<string, unknown> {
  return loadCollectorConfig().collectors?.[name] || {};
}

export function configuredPaths(name: string, key: string, fallback: string[] = []): string[] {
  const value = collectorConfig(name)[key];
  const paths = Array.isArray(value) ? value : fallback;
  return paths
    .map((item) => expandPath(item))
    .filter(Boolean);
}

export function configuredPath(name: string, key: string, fallback: string | null = null): string | null {
  const value = collectorConfig(name)[key] ?? fallback;
  return expandPath(value);
}

export function configuredBool(name: string, key: string, fallback = false): boolean {
  const value = collectorConfig(name)[key];
  return typeof value === 'boolean' ? value : fallback;
}

export function configuredStrings(name: string, key: string, fallback: string[] = []): string[] {
  const value = collectorConfig(name)[key];
  return Array.isArray(value)
    ? value.map((item) => String(item)).filter(Boolean)
    : fallback;
}

export function envPathList(value: unknown, fallback: string[] = []): string[] {
  const paths = String(value || '')
    .split(',')
    .map((item) => expandPath(item.trim()))
    .filter(Boolean);
  return paths.length ? paths : fallback;
}

export function existingPaths(paths: string[]): string[] {
  return paths.filter((path) => existsSync(path));
}

export function expandPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;

  let expanded = value.trim();
  if (expanded === '~') {
    expanded = homedir();
  } else if (expanded.startsWith('~/')) {
    expanded = `${homedir()}${expanded.slice(1)}`;
  }

  expanded = expanded.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    return process.env[name] || '';
  });
  expanded = expanded.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
    return process.env[name] || '';
  });

  return expanded;
}
