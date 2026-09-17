/**
 * Claude Code data collector.
 *
 * Reads JSONL session files from the Claude Code projects directory and
 * returns data in the common collector shape consumed by collect.ts.
 *
 * Supported platforms: macOS, Linux, Windows — no native binaries required.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { configuredClaudeRequestModel } from '../claude-settings.ts';
import { configuredBool, configuredPath, configuredPaths, envPathList } from '../collector-config.ts';
import { calculateCost } from '../pricing.ts';
import { localDateFromTimestamp, normalizeModelForGrouping } from './utils.ts';

export const CLIENT_KEY = 'claude';
export const SOURCE_LABEL = 'Claude Code';

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Return Claude Code data roots. Claude Code has used both ~/.claude and
 * ~/.config/claude layouts; CLAUDE_CONFIG_DIR may contain comma-separated
 * custom roots. Each root is expected to contain a projects/ directory.
 */
export function getClaudeRoots() {
  const envRoots = envPathList(process.env.CLAUDE_CONFIG_DIR);
  if (envRoots.length) return envRoots;

  return configuredPaths('claude', 'roots');
}

export async function getScanRoots() {
  const envRoots = envPathList(process.env.CLAUDE_CONFIG_DIR);
  const includeDesktopLocalAgent = configuredBool('claude', 'includeDesktopLocalAgent', true);
  const roots = envRoots.length
    ? envRoots
    : [
        ...getClaudeRoots(),
        ...(includeDesktopLocalAgent ? await getClaudeDesktopLocalAgentRoots() : [])
      ];

  return unique(roots).flatMap((root) => [
    { type: 'projects', path: join(root, 'projects') },
    { type: 'transcripts', path: join(root, 'transcripts') }
  ]);
}

async function collectJsonlFiles(dir) {
  const results = [];
  const entries = await safeReaddir(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await collectJsonlFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      results.push(fullPath);
    }
  }
  return results;
}

async function getClaudeDesktopLocalAgentRoots() {
  if (process.platform !== 'darwin') return [];

  const base = configuredPath(
    'claude',
    'desktopLocalAgentBase',
    `${homedir()}/Library/Application Support/Claude/local-agent-mode-sessions`
  );
  if (!base) return [];
  const sessionDirs = await collectClaudeDirs(base, 0, 4);
  return sessionDirs.filter((dir) => /[/\\]local_[^/\\]+[/\\]\.claude$/.test(dir));
}

async function collectClaudeDirs(dir, depth = 0, maxDepth = 4) {
  const results = [];
  if (depth > maxDepth) return results;
  const entries = await safeReaddir(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (!entry.isDirectory()) continue;

    if (entry.name === '.claude') {
      results.push(fullPath);
      continue;
    }

    results.push(...await collectClaudeDirs(fullPath, depth + 1, maxDepth));
  }
  return results;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Attempt to decode a project directory name into a human-readable path.
 * Claude Code URL-encodes the absolute project path as the directory name,
 * e.g. "%2FUsers%2Fjohn%2Fmy-project".  Fall back to the raw name when
 * decoding fails (older or unknown formats).
 */
function decodeWorkspaceLabel(dirName) {
  try {
    const decoded = decodeURIComponent(dirName);
    // Only use decoded form when it looks like an absolute path
    if (decoded.startsWith('/') || /^[A-Za-z]:\\/.test(decoded)) {
      return decoded;
    }
  } catch {
    // ignore
  }
  return dirName;
}

// ---------------------------------------------------------------------------
// JSONL parsing
// ---------------------------------------------------------------------------

/**
 * Read one session JSONL file and return an array of assistant-turn records.
 * Each record carries { timestamp, model, usage, costUSD, dedupKey }.
 *
 * Claude Code can write multiple assistant usage snapshots for the same
 * streamed response. Collapse message.id+requestId duplicates, fall back to
 * message.id when requestId is absent, and keep the largest token value seen
 * for each field.
 */
async function parseSessionFile(filePath) {
  const records = [];
  const dedupIndex = new Map();
  const anonymousRecordCount = new Map();
  try {
    const lines = createInterface({
      input: createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity
    });
    for await (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }

      // Only assistant turns carry usage information
      if (obj.type !== 'assistant' || !obj.message?.usage) continue;

      const dedupKey = dedupKeyForAssistant(obj);
      const anonymousCount = anonymousRecordCount.get(trimmed) || 0;
      anonymousRecordCount.set(trimmed, anonymousCount + 1);
      const model = normalizeModelForGrouping(arkAutoModel(obj.message.model || obj.model, obj.message.usage));
      if (model === '<synthetic>' || tokenTotal(extractTokens(obj.message.usage)) === 0) continue;

      const record = {
        timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : null,
        model,
        usage: obj.message.usage,
        costUSD: typeof obj.costUSD === 'number' ? obj.costUSD : 0,
        dedupKey,
        // Some local-agent records omit message and request IDs. Keep those
        // records distinct without depending on their position in the file.
        identityKey: dedupKey || `anonymous:${stableHash(trimmed)}:${anonymousCount}`
      };

      if (dedupKey && dedupIndex.has(dedupKey)) {
        const existing = records[dedupIndex.get(dedupKey)];
        mergeUsageMax(existing.usage, record.usage);
        existing.costUSD = Math.max(existing.costUSD || 0, record.costUSD || 0);
        if (!existing.timestamp && record.timestamp) existing.timestamp = record.timestamp;
        if (existing.model === 'unknown' && record.model !== 'unknown') existing.model = record.model;
        continue;
      }

      if (dedupKey) dedupIndex.set(dedupKey, records.length);
      records.push(record);
    }
  } catch {
    return [];
  }

  return records;
}

// Volcengine Ark's Coding Plan "Auto" scheduling answers with model "auto"
// and stamps Ark-only gateway fields on usage (inference_geo / speed /
// iterations). Only then is "auto" attributed to Ark; a bare "auto" from any
// other gateway stays unresolved instead of being mispriced. Ark does not
// expose the routed backend model in the response, so the specific model
// shown here is the configured request model (e.g. ark-code-latest). When no
// request model is configured locally, fall back to the ark-auto label.
function arkAutoModel(model, usage) {
  if (!model || String(model).trim().toLowerCase() !== 'auto') return model || 'unknown';
  const arkSignature = usage && typeof usage === 'object'
    && (Object.hasOwn(usage, 'inference_geo') || Object.hasOwn(usage, 'speed') || Array.isArray(usage.iterations));
  if (!arkSignature) return model;
  return configuredClaudeRequestModel() || 'ark-auto';
}

function dedupKeyForAssistant(obj) {
  const messageId = obj.message?.id;
  if (!messageId) return null;
  return obj.requestId ? `${messageId}:${obj.requestId}` : `message:${messageId}`;
}

function mergeUsageMax(target, source) {
  for (const key of [
    'input_tokens',
    'output_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
    'reasoning_tokens',
    'thinking_tokens'
  ]) {
    target[key] = Math.max(Number(target[key] || 0), Number(source[key] || 0));
  }
}

// ---------------------------------------------------------------------------
// Safe directory helpers
// ---------------------------------------------------------------------------

async function safeReaddir(dirPath) {
  try {
    return await readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

function zeroTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

function extractTokens(usage) {
  return {
    input: usage.input_tokens || 0,
    output: usage.output_tokens || 0,
    cacheRead: usage.cache_read_input_tokens || 0,
    cacheWrite: usage.cache_creation_input_tokens || 0,
    // Newer models expose reasoning/thinking tokens
    reasoning: usage.reasoning_tokens || usage.thinking_tokens || 0
  };
}

function addInto(target, tokens) {
  target.input += tokens.input;
  target.output += tokens.output;
  target.cacheRead += tokens.cacheRead;
  target.cacheWrite += tokens.cacheWrite;
  target.reasoning += tokens.reasoning;
}

// ---------------------------------------------------------------------------
// Main collector
// ---------------------------------------------------------------------------

/**
 * Scan the Claude Code projects directory and return the common daily and
 * workspace/model objects consumed by collect.ts.
 *
 * @returns {{ graphJson: object, modelsJson: object }}
 */
export async function collect(pricingData = null, options = {}) {
  return collectFromFiles(await scanSessionFiles(options), pricingData);
}

export async function collectWithAudit(pricingData = null, options = {}) {
  const files = await scanSessionFiles(options);
  return {
    ...collectFromFiles(files, pricingData),
    audit: auditFromFiles(files)
  };
}

function collectFromFiles(files, pricingData) {
  // dailyKey ("YYYY-MM-DD::model") -> aggregated token counts
  const dailyMap = new Map();
  // sessionId -> true session-file aggregate
  const sessionMap = new Map();
  const tokenEvents = [];
  const managedEventSessionPrefixes = new Set();

  for (const { root, filePath, records } of files) {
    const workspaceKey = workspaceKeyFromPath(root, filePath);
    const workspaceLabel = decodeWorkspaceLabel(workspaceKey);
    if (!records.length) continue;
    const sessionFileId = basename(filePath).replace(/\.jsonl$/i, '');
    const sessionPrefix = `local:${CLIENT_KEY}:${hashableSessionPart(sessionFileId)}`;
    const modelSessionIds = new Map(
      [...new Set(records.map(record => normalizeModelForGrouping(record.model)))]
        .map(model => [model, `${sessionPrefix}:${model}`])
    );
    // Earlier releases stored Ark "auto" responses under the raw "auto" and
    // the interim "ark-auto" session/model labels. Include those variants so
    // re-collecting the same response replaces its stale copies even when the
    // current parse no longer produces those model names.
    const legacyVariants = new Set(modelSessionIds.values());
    for (const variant of ['auto', 'ark-auto']) {
      legacyVariants.add(`${sessionPrefix}:${variant}`);
    }
    const legacySessionIds = [...legacyVariants];
    managedEventSessionPrefixes.add(`${sessionPrefix}:`);

    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      const tokens = extractTokens(record.usage);
      const model = normalizeModelForGrouping(record.model);
      const normalized = {
        ...record,
        model,
        tokens,
        sessionId: modelSessionIds.get(model),
        legacySessionIds,
        workspaceKey,
        workspaceLabel,
      };
      aggregateRecord(normalized, dailyMap, sessionMap, pricingData);
      tokenEvents.push(tokenEventFor(normalized));
    }
  }

  // -----------------------------------------------------------------------
  // Convert to common daily JSON
  // -----------------------------------------------------------------------
  const byDate = new Map();
  for (const row of dailyMap.values()) {
    if (!byDate.has(row.date)) byDate.set(row.date, []);
    byDate.get(row.date).push(row);
  }

  const contributions = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, rows]) => ({
      date,
      clients: rows.map((row) => ({
        client: CLIENT_KEY,
        modelId: row.model,
        tokens: {
          input: row.input,
          output: row.output,
          cacheRead: row.cacheRead,
          cacheWrite: row.cacheWrite,
          reasoning: row.reasoning
        },
        cost: row.cost
      }))
    }));

  const graphJson = { contributions };

  // -----------------------------------------------------------------------
  // Convert to true session JSON
  // -----------------------------------------------------------------------
  const entries = [...sessionMap.values()].map((wm) => ({
    client: CLIENT_KEY,
    workspaceKey: wm.workspace,
    workspaceLabel: wm.workspaceLabel,
    sessionId: wm.sessionId,
    lastActivity: wm.lastActivity,
    model: wm.model,
    input: wm.input,
    output: wm.output,
    cacheRead: wm.cacheRead,
    cacheWrite: wm.cacheWrite,
    reasoning: wm.reasoning,
    cost: wm.cost
  }));

  const modelsJson = { entries };

  return {
    graphJson,
    modelsJson,
    tokenEvents,
    reconciliation: {
      managedEventIdPrefix: 'claude:',
      managedEventSessionPrefixes: [...managedEventSessionPrefixes]
    }
  };
}

export async function audit() {
  return auditFromFiles(await scanSessionFiles());
}

async function scanSessionFiles({ changedAfterMs = null } = {}) {
  const files = [];
  for (const root of await getScanRoots()) {
    for (const filePath of await collectJsonlFiles(root.path)) {
      if (!await changedSince(filePath, changedAfterMs)) continue;
      files.push({ root, filePath, records: await parseSessionFile(filePath) });
    }
  }
  return files;
}

async function changedSince(filePath, changedAfterMs) {
  if (!Number.isFinite(changedAfterMs)) return true;
  try {
    return (await stat(filePath)).mtimeMs > changedAfterMs;
  } catch {
    return false;
  }
}

function auditFromFiles(files) {
  const summary = emptyAuditSummary();
  const sessions = new Set();
  summary.candidateFiles = files.length;
  for (const { filePath, records } of files) {
    if (records.length) {
      summary.usableTokenRecords += records.length;
      sessions.add(basename(filePath).replace(/\.jsonl$/i, ''));
      for (const record of records) {
        const tokens = extractTokens(record.usage);
        summary.totalTokens += tokenTotal(tokens);
        summary.firstTimestamp = earlierTimestamp(summary.firstTimestamp, record.timestamp);
        summary.lastTimestamp = laterTimestamp(summary.lastTimestamp, record.timestamp);
      }
    } else {
      summary.skippedNoTokenRecords += 1;
    }
  }
  summary.sessionRows = sessions.size;
  summary.tokenEvents = summary.usableTokenRecords;
  return summary;
}

function workspaceKeyFromPath(root, filePath) {
  const rel = relative(root.path, filePath);
  const firstSegment = rel.split(/[\\/]/).find(Boolean);
  if (root.type === 'projects' && firstSegment) return firstSegment;
  return `transcripts:${firstSegment || filePath}`;
}

function aggregateRecord(record, dailyMap, sessionMap, pricingData) {
  const date = localDateFromTimestamp(record.timestamp);
  const model = normalizeModelForGrouping(record.model);
  const tokens = record.tokens || extractTokens(record.usage);
  const costUSD = calculateCost(model, tokens, pricingData);

  // --- daily ---
  const dk = `${date}::${model}`;
  if (!dailyMap.has(dk)) {
    dailyMap.set(dk, { date, model, ...zeroTokens(), cost: 0 });
  }
  const dayAgg = dailyMap.get(dk);
  addInto(dayAgg, tokens);
  dayAgg.cost += costUSD;

  // --- true session file ---
  if (!sessionMap.has(record.sessionId)) {
    sessionMap.set(record.sessionId, {
      sessionId: record.sessionId,
      workspace: record.workspaceKey,
      workspaceLabel: record.workspaceLabel,
      model,
      ...zeroTokens(),
      cost: 0,
      lastActivity: record.timestamp || null
    });
  }
  const wmAgg = sessionMap.get(record.sessionId);
  addInto(wmAgg, tokens);
  wmAgg.cost += costUSD;
  if (record.timestamp && (!wmAgg.lastActivity || record.timestamp > wmAgg.lastActivity)) {
    wmAgg.lastActivity = record.timestamp;
  }
}

function emptyAuditSummary() {
  return {
    candidateFiles: 0,
    usableTokenRecords: 0,
    skippedNoTokenRecords: 0,
    skippedConversationLikeRecords: 0,
    skippedOversizedFiles: 0,
    parseErrors: 0,
    sessionRows: 0,
    tokenEvents: 0,
    totalTokens: 0,
    firstTimestamp: null,
    lastTimestamp: null
  };
}

function tokenEventFor(record) {
  const model = normalizeModelForGrouping(record.model);
  const eventId = claudeEventId({ ...record, model, sessionId: record.sessionId });
  return {
    eventId,
    legacyEventIds: (record.legacySessionIds || [])
      .map(sessionId => claudeEventId({ ...record, model, sessionId }))
      .filter(candidate => candidate !== eventId),
    source: CLIENT_KEY,
    sessionId: record.sessionId,
    timestamp: record.timestamp || new Date().toISOString(),
    model,
    inputTokens: record.tokens.input,
    outputTokens: record.tokens.output,
    cacheReadTokens: record.tokens.cacheRead,
    cacheCreationTokens: record.tokens.cacheWrite,
    reasoningTokens: record.tokens.reasoning,
    privacyLevel: 'safe'
  };
}

function claudeEventId({ sessionId, identityKey }) {
  return `claude:${stableHash({ sessionId, identityKey })}`;
}

function tokenTotal(tokens) {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite + tokens.reasoning;
}

function stableHash(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32);
}

function hashableSessionPart(value) {
  const text = String(value || '').trim();
  if (!text) return 'unknown-session';
  return text.replace(/[^a-z0-9_.-]+/gi, '-').slice(0, 96) || stableHash(text);
}

function earlierTimestamp(left, right) {
  if (!right) return left || null;
  if (!left) return right;
  return new Date(right) < new Date(left) ? right : left;
}

function laterTimestamp(left, right) {
  if (!right) return left || null;
  if (!left) return right;
  return new Date(right) > new Date(left) ? right : left;
}
