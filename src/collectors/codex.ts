/**
 * Codex local-session collector.
 *
 * Scans two roots:
 *   ~/.codex/sessions/          — active sessions (recursive JSONL)
 *   ~/.codex/archived_sessions/ — archived sessions (recursive JSONL)
 * (CODEX_HOME env var overrides ~/.codex)
 *
 * The Codex JSONL format has three relevant event types:
 *   session_meta  – workspace (cwd), session ID, provider, agent nickname
 *   turn_context  – current model for the upcoming turn
 *   event_msg     – when payload.type === "token_count", carries token usage
 *
 * Token counting strategy:
 *   • total_token_usage establishes deltas between consecutive counters.
 *   • last_token_usage covers the first record and counter resets.
 *   • Forked sessions start from their parent's counter at fork time, so copied
 *     history is not counted again as new usage.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { configuredPaths, configuredStrings, envPathList } from '../collector-config.ts';
import { calculateCost } from '../pricing.ts';
import { localDateFromTimestamp, normalizeModelForGrouping } from './utils.ts';

/** Recursively collect all .jsonl file paths under a directory. */
async function collectJsonlFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await collectJsonlFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      results.push(full);
    }
  }
  return results;
}

export const CLIENT_KEY = 'codex';
export const SOURCE_LABEL = 'Codex';

const CODEX_DESKTOP_SOURCE = 'Codex Desktop';
const CODEX_CLI_SOURCE = 'Codex CLI';
const CODEX_UNKNOWN_SOURCE = 'Codex (unidentified client)';

const SESSION_META_SCAN_BYTES = 64 * 1024;
const INCREMENTAL_TAIL_BYTES = 4 * 1024 * 1024;

interface SessionParseOptions {
  tailBytes?: number;
  workspace?: string | null;
  sessionId?: string;
  source?: string;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function getCodexHomes() {
  return envPathList(process.env.CODEX_HOME, configuredPaths('codex', 'homes'));
}

function getSessionRoots() {
  const subdirs = configuredStrings('codex', 'sessionSubdirs', ['sessions', 'archived_sessions']);
  return getCodexHomes().flatMap((home) => subdirs.map((subdir) => join(home, subdir)));
}

function getHeadlessRoots() {
  const roots = envPathList(
    process.env.TOKEN_WORK_HEADLESS_DIR,
    configuredPaths('codex', 'headlessRoots')
  );
  return roots.map((root) => join(root, 'codex'));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pos(v) {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function zero() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

function addInto(agg, t) {
  agg.input     += t.input;
  agg.output    += t.output;
  agg.cacheRead  += t.cacheRead;
  agg.cacheWrite += t.cacheWrite;
  agg.reasoning  += t.reasoning;
}

/** Extract a { input, output, cached, reasoning } summary from a token-usage object. */
function usageSummary(u) {
  return {
    input:     pos(u.input_tokens),
    output:    pos(u.output_tokens),
    // Codex uses cached_input_tokens OR cache_read_input_tokens interchangeably
    cached:    Math.max(pos(u.cached_input_tokens), pos(u.cache_read_input_tokens)),
    reasoning: pos(u.reasoning_output_tokens)
  };
}

/**
 * Convert a Codex cumulative summary to our token breakdown.
 * Cached input and reasoning are subsets of input and output respectively.
 */
function summaryToTokens(s) {
  const cached = Math.min(s.cached, s.input);
  const reasoning = Math.min(s.reasoning, s.output);
  return {
    input:     Math.max(0, s.input - cached),
    output:    Math.max(0, s.output - reasoning),
    cacheRead: cached,
    cacheWrite: 0,
    reasoning
  };
}

function summaryIsZero(s) {
  return s.input === 0 && s.output === 0 && s.cached === 0 && s.reasoning === 0;
}

function summaryDelta(current, previous) {
  if (
    current.input < previous.input ||
    current.output < previous.output ||
    current.cached < previous.cached ||
    current.reasoning < previous.reasoning
  ) {
    return null;
  }

  return {
    input:     current.input     - previous.input,
    output:    current.output    - previous.output,
    cached:    current.cached    - previous.cached,
    reasoning: current.reasoning - previous.reasoning
  };
}

function summaryAtLeast(current, baseline) {
  return current.input >= baseline.input &&
    current.output >= baseline.output &&
    current.cached >= baseline.cached &&
    current.reasoning >= baseline.reasoning;
}

// ---------------------------------------------------------------------------
// JSONL session parser
// ---------------------------------------------------------------------------

/**
 * Parse a single Codex JSONL session file.
 * Returns an array of { timestamp, date, model, workspace, source, tokens }.
 */
async function parseSessionFile(filePath, sessionId, inheritedTotal = null, minimumTimestamp = null, options: SessionParseOptions = {}) {
  const tailBytes = Number(options.tailBytes) || 0;
  const text = tailBytes > 0 ? await readSessionTail(filePath, tailBytes) : null;
  if (tailBytes > 0 && text == null) return [];

  // Per-file state
  let currentModel     = null;
  let previousTotal    = inheritedTotal;
  let awaitingForkBase = Boolean(inheritedTotal);
  let workspace        = options.workspace || null;
  let metaSessionId    = options.sessionId || sessionId;
  let source           = options.source || CODEX_UNKNOWN_SOURCE;

  const events = [];
  const recordOccurrences = new Map();
  const minimumTime = minimumTimestamp ? new Date(minimumTimestamp).getTime() : null;

  try {
    const lines = tailBytes > 0 ? text.split('\n') : streamSessionLines(filePath);
    for await (const raw of lines) {
      const line = raw.trim();
      if (!isRelevantSessionLine(line)) continue;

      let entry;
      try { entry = JSON.parse(line); } catch { continue; }

      const type = entry.type;

      // ── session_meta ──────────────────────────────────────────────────
      if (type === 'session_meta') {
        const payload = entry.payload || {};
        metaSessionId = extractSessionId(payload) || metaSessionId;
        if (payload.cwd) {
          workspace = payload.cwd;
        }
        source = codexSource(payload.originator, payload.source);
        continue;
      }

      // ── turn_context ──────────────────────────────────────────────────
      if (type === 'turn_context') {
        const payload = entry.payload || {};
        currentModel = extractModel(payload) || currentModel;
        continue;
      }

      // ── event_msg / token_count ────────────────────────────────────────
      if (type === 'event_msg') {
        const payload = entry.payload || {};
        if (payload.type !== 'token_count') continue;

        const info = payload.info || {};

      // Model resolution: payload.model → info.model → state.currentModel
        const modelValue =
          extractModel(payload) ||
          extractModel(info)    ||
          currentModel;
      // A tail can begin in the middle of a session. Ignore rows before its
      // first model context instead of assigning them to an unknown model.
        if (!modelValue && tailBytes > 0) continue;
        const model = normalizeModelForGrouping(modelValue || 'unknown');

        currentModel = model;

        const totalUsage = info.total_token_usage ? usageSummary(info.total_token_usage) : null;

        const lastUsage = info.last_token_usage ? usageSummary(info.last_token_usage) : null;
        let increment;
        if (totalUsage) {
        // Forked Codex sessions replay the parent's history when created.
        // Keep their parent total as the baseline until the child exceeds it.
          if (awaitingForkBase && !summaryAtLeast(totalUsage, inheritedTotal)) {
            continue;
          }
          awaitingForkBase = false;
          increment = previousTotal ? summaryDelta(totalUsage, previousTotal) : lastUsage || totalUsage;
          if (!increment) {
            previousTotal = totalUsage;
            if (!lastUsage || summaryIsZero(lastUsage)) continue;
            increment = lastUsage;
          }
          previousTotal = totalUsage;
        } else {
          if (awaitingForkBase || !lastUsage || summaryIsZero(lastUsage)) continue;
          increment = lastUsage;
        }

        if (summaryIsZero(increment)) continue;

        const tokens = summaryToTokens(increment);
        const recordHash = stableHash(line);
        const occurrence = recordOccurrences.get(recordHash) || 0;
        recordOccurrences.set(recordHash, occurrence + 1);

      // Date from event timestamp
        const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : '';
        if (minimumTime != null && (!timestamp || new Date(timestamp).getTime() <= minimumTime)) continue;
        let date = 'unknown';
        if (timestamp) {
          date = localDateFromTimestamp(timestamp);
        }

        events.push({
          timestamp,
          date,
          model,
          workspace,
          source,
          tokens,
          sessionId: metaSessionId,
          identityKey: `${recordHash}:${occurrence}`
        });
      }
    }
  } catch {
    return [];
  }

  return events;
}

function isRelevantSessionLine(line) {
  if (!line) return false;
  if (line.includes('"session_meta"') || line.includes('"turn_context"')) return true;
  return line.includes('"event_msg"') && line.includes('"token_count"');
}

async function* streamSessionLines(filePath) {
  const stream = createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1024 * 1024 });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) yield line;
  } finally {
    lines.close();
    stream.destroy();
  }
}

function codexSource(originator, source) {
  const client = String(originator || '').trim().toLowerCase();
  const transport = String(source || '').trim().toLowerCase();
  if (client === 'codex desktop') return CODEX_DESKTOP_SOURCE;
  if (client === 'codex-tui' || transport === 'cli') return CODEX_CLI_SOURCE;
  return CODEX_UNKNOWN_SOURCE;
}

function extractModel(obj) {
  if (!obj) return null;
  const v =
    obj.model ||
    obj.model_name ||
    obj.model_info?.slug ||
    null;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function extractSessionId(obj) {
  if (!obj) return null;
  const v = obj.id || obj.session_id || obj.sessionId || null;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

// ---------------------------------------------------------------------------
// Main collector
// ---------------------------------------------------------------------------

export async function collect(pricingData = null, options = {}) {
  const parsed = await parseSessionFiles(options);
  return collectFromSessionFiles(parsed.files, pricingData, parsed.metadataSourcePrefixes);
}

export async function collectWithAudit(pricingData = null, options = {}) {
  const parsed = await parseSessionFiles(options);
  return {
    ...collectFromSessionFiles(parsed.files, pricingData, parsed.metadataSourcePrefixes),
    audit: auditFromSessionFiles(parsed.files)
  };
}

function collectFromSessionFiles(sessionFiles, pricingData, metadataSourcePrefixes = []) {
  const dailyMap = new Map();   // "date::source::model" → aggregated
  const sessionMap = new Map(); // true rollout session aggregate
  const seenEventKeys = new Set();
  const tokenEvents = [];
  const forkedSessionPrefixes = new Set();
  const managedEventSessionPrefixes = new Set();
  const sessionSourcePrefixes = new Map();
  const conflictingSessionSourcePrefixes = new Set();

  const rememberSessionSourcePrefix = (prefix, source) => {
    if (source === CODEX_UNKNOWN_SOURCE || conflictingSessionSourcePrefixes.has(prefix)) return;
    const previousSource = sessionSourcePrefixes.get(prefix);
    if (previousSource && previousSource !== source) {
      sessionSourcePrefixes.delete(prefix);
      conflictingSessionSourcePrefixes.add(prefix);
      return;
    }
    sessionSourcePrefixes.set(prefix, source);
  };

  for (const { prefix, source } of metadataSourcePrefixes) {
    rememberSessionSourcePrefix(prefix, source);
  }

  for (const { fileSessionId, lineage, events } of sessionFiles) {
    const metadataSessionPrefix = `local:${CLIENT_KEY}:${hashableSessionPart(lineage.sessionId)}:`;
    rememberSessionSourcePrefix(metadataSessionPrefix, lineage.source);
    if (lineage.parentSessionId) {
      forkedSessionPrefixes.add(`local:${CLIENT_KEY}:${hashableSessionPart(lineage.sessionId)}:`);
    }
    if (!events.length) continue;
    const rawSessionId = events.find(event => event.sessionId)?.sessionId || fileSessionId;
    const sessionPrefix = `local:${CLIENT_KEY}:${hashableSessionPart(rawSessionId)}`;
    const modelSessionIds = new Map(
      [...new Set(events.map(event => event.model))]
        .map(model => [model, `${sessionPrefix}:${model}`])
    );
    const legacySessionIds = [...modelSessionIds.values()];
    managedEventSessionPrefixes.add(`${sessionPrefix}:`);

    for (let index = 0; index < events.length; index += 1) {
      const { timestamp, date, model, workspace, source, tokens, identityKey } = events[index];
      const sessionId = modelSessionIds.get(model);
      const eventKey = codexEventDedupKey({ source, sessionId, identityKey });
      if (eventKey && seenEventKeys.has(eventKey)) continue;
      if (eventKey) seenEventKeys.add(eventKey);

      const workspaceKey = workspace || rawSessionId;

      // Daily
      const dk = `${date}::${source}::${model}`;
      if (!dailyMap.has(dk)) dailyMap.set(dk, { date, source, model, ...zero(), cost: 0 });
      addInto(dailyMap.get(dk), tokens);

      // True rollout session
      const sessionKey = `${source}::${sessionId}`;
      if (!sessionMap.has(sessionKey)) {
        sessionMap.set(sessionKey, {
          sessionId,
          source,
          workspace: workspaceKey,
          workspaceLabel: decodeWorkspace(workspaceKey),
          model,
          ...zero(),
          lastActivity: timestamp || null
        });
      }
      const sessionAgg = sessionMap.get(sessionKey);
      addInto(sessionAgg, tokens);
      if (timestamp && (!sessionAgg.lastActivity || timestamp > sessionAgg.lastActivity)) {
        sessionAgg.lastActivity = timestamp;
      }
      tokenEvents.push(tokenEventFor({ source, sessionId, legacySessionIds, timestamp, model, tokens, identityKey }));
    }
  }

  return {
    ...buildOutput(dailyMap, sessionMap, tokenEvents, pricingData),
    reconciliation: {
      eventSessionPrefixes: [...forkedSessionPrefixes],
      managedEventIdPrefix: 'codex:',
      managedEventSessionPrefixes: [...managedEventSessionPrefixes],
      sessionSourcePrefixes: [...sessionSourcePrefixes].map(([prefix, source]) => ({ prefix, source }))
    }
  };
}

export async function audit() {
  const parsed = await parseSessionFiles();
  return auditFromSessionFiles(parsed.files);
}

function auditFromSessionFiles(sessionFiles) {
  const summary = emptyAuditSummary();
  const sessions = new Set();
  summary.candidateFiles = sessionFiles.length;
  for (const { fileSessionId, events } of sessionFiles) {
    if (events.length) {
      summary.usableTokenRecords += events.length;
      sessions.add(events.find(event => event.sessionId)?.sessionId || fileSessionId);
      for (const event of events) {
        summary.totalTokens += tokenTotal(event.tokens);
        summary.firstTimestamp = earlierTimestamp(summary.firstTimestamp, event.timestamp);
        summary.lastTimestamp = laterTimestamp(summary.lastTimestamp, event.timestamp);
      }
    } else {
      summary.skippedNoTokenRecords += 1;
    }
  }
  summary.sessionRows = sessions.size;
  summary.tokenEvents = summary.usableTokenRecords;
  return summary;
}

async function parseSessionFiles({ changedAfterMs = null, metadataSessionPrefixes = [] } = {}) {
  const allFilePaths = await collectSessionFiles();
  const filePaths = Number.isFinite(changedAfterMs)
    ? await changedSessionFiles(allFilePaths, changedAfterMs)
    : allFilePaths;
  const files = [];
  for (const filePath of filePaths) {
    const fileSessionId = basename(filePath).replace(/\.jsonl$/, '');
    files.push({
      filePath,
      fileSessionId,
      lineage: await readSessionLineage(filePath, fileSessionId)
    });
  }
  const bySessionId = new Map();
  const usageTimelines = new Map();
  for (const file of files) {
    const matches = bySessionId.get(file.lineage.sessionId) || [];
    matches.push(file);
    bySessionId.set(file.lineage.sessionId, matches);
  }

  const parsedFiles = [];
  for (const file of files) {
    const parents = file.lineage.parentSessionId
      ? bySessionId.get(file.lineage.parentSessionId) || []
      : [];
    const baselines = [];
    for (const parent of parents) {
      const baseline = file.lineage.forkedAt
        ? await totalUsageAt(parent.filePath, file.lineage.forkedAt, usageTimelines)
        : null;
      if (baseline) baselines.push(baseline);
    }
    const inheritedTotal = baselines
      .sort((left, right) => right.timestamp - left.timestamp)[0]?.summary || null;
    const unresolvedFork = Boolean(file.lineage.parentSessionId) && !inheritedTotal;
    const canParseWithoutParent = !unresolvedFork || Boolean(file.lineage.forkedAt);
    parsedFiles.push({
      ...file,
      events: !canParseWithoutParent
        ? []
        : await parseSessionFile(
            file.filePath,
            file.fileSessionId,
            inheritedTotal,
            unresolvedFork ? file.lineage.forkedAt : null,
            Number.isFinite(changedAfterMs)
              ? {
                  tailBytes: INCREMENTAL_TAIL_BYTES,
                  sessionId: file.lineage.sessionId,
                  source: file.lineage.source,
                  workspace: file.lineage.workspace
                }
              : undefined
          )
    });
  }
  return {
    files: parsedFiles,
    metadataSourcePrefixes: await resolveMetadataSourcePrefixes(allFilePaths, metadataSessionPrefixes)
  };
}

async function resolveMetadataSourcePrefixes(filePaths, prefixes) {
  const requested = new Set(prefixes);
  if (!requested.size) return [];

  const sources = new Map();
  const conflicts = new Set();
  for (const filePath of filePaths) {
    const fallbackSessionId = basename(filePath).replace(/\.jsonl$/, '');
    // This repair intentionally reads only the fixed-size header. Do not fall
    // back to the full transcript while a periodic refresh is running.
    const lineage = sessionLineageFromText(await readSessionHeader(filePath), fallbackSessionId);
    if (!lineage || lineage.source === CODEX_UNKNOWN_SOURCE) continue;
    const prefix = `local:${CLIENT_KEY}:${hashableSessionPart(lineage.sessionId)}:`;
    if (!requested.has(prefix) || conflicts.has(prefix)) continue;
    const previousSource = sources.get(prefix);
    if (previousSource && previousSource !== lineage.source) {
      sources.delete(prefix);
      conflicts.add(prefix);
      continue;
    }
    sources.set(prefix, lineage.source);
  }
  return [...sources].map(([prefix, source]) => ({ prefix, source }));
}

async function readSessionLineage(filePath, fallbackSessionId) {
  const header = await readSessionHeader(filePath);
  const fromHeader = sessionLineageFromText(header, fallbackSessionId);
  if (fromHeader) return fromHeader;

  // session_meta normally starts each Codex JSONL file. Keep the fallback
  // for older files that place it after an unusually large first record.
  const text = await readSessionText(filePath);
  return sessionLineageFromText(text, fallbackSessionId) || unknownLineage(fallbackSessionId);
}

async function readSessionHeader(filePath) {
  let handle;
  try {
    handle = await open(filePath, 'r');
    const buffer = Buffer.allocUnsafe(SESSION_META_SCAN_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function sessionLineageFromText(text, fallbackSessionId) {
  if (text == null) return null;
  for (const raw of text.split('\n')) {
    if (!raw.includes('"session_meta"')) continue;
    let entry;
    try { entry = JSON.parse(raw); } catch { continue; }
    if (entry.type !== 'session_meta') continue;
    const payload = entry.payload || {};
    return {
      sessionId: extractSessionId(payload) || fallbackSessionId,
      parentSessionId: normalizeSessionId(payload.parent_thread_id || payload.forked_from_id),
      forkedAt: validTimestamp(payload.timestamp || entry.timestamp),
      source: codexSource(payload.originator, payload.source),
      workspace: typeof payload.cwd === 'string' && payload.cwd.trim() ? payload.cwd : null
    };
  }
  return null;
}

function unknownLineage(fallbackSessionId) {
  return {
    sessionId: fallbackSessionId,
    parentSessionId: null,
    forkedAt: null,
    source: CODEX_UNKNOWN_SOURCE,
    workspace: null
  };
}

async function totalUsageAt(filePath, timestamp, cache = null) {
  let pending = cache?.get(filePath);
  if (!pending) {
    pending = usageTimelineFor(filePath);
    cache?.set(filePath, pending);
  }
  const usageTimeline = await pending;
  if (!usageTimeline.length) return null;
  const forkTime = new Date(timestamp).getTime();
  if (!Number.isFinite(forkTime)) return null;

  let left = 0;
  let right = usageTimeline.length - 1;
  let match = null;
  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    const point = usageTimeline[middle];
    if (point.timestamp <= forkTime) {
      match = point;
      left = middle + 1;
    } else {
      right = middle - 1;
    }
  }
  return match ? { summary: match.summary, timestamp: match.timestamp } : null;
}

async function readSessionText(filePath) {
  return readFile(filePath, 'utf8').catch(() => null);
}

async function readSessionTail(filePath, maxBytes) {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    return null;
  }
  if (info.size <= maxBytes) return readSessionText(filePath);

  let handle;
  try {
    handle = await open(filePath, 'r');
    const buffer = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, info.size - maxBytes);
    const text = buffer.toString('utf8', 0, bytesRead);
    const firstLine = text.indexOf('\n');
    return firstLine === -1 ? '' : text.slice(firstLine + 1);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function usageTimelineFor(filePath) {
  return buildUsageTimeline(filePath);
}

async function buildUsageTimeline(filePath) {
  const timeline = [];
  try {
    for await (const raw of streamSessionLines(filePath)) {
      if (!raw.includes('"event_msg"') || !raw.includes('"token_count"')) continue;
      let entry;
      try { entry = JSON.parse(raw); } catch { continue; }
      if (entry.type !== 'event_msg' || entry.payload?.type !== 'token_count') continue;
      const timestamp = new Date(entry.timestamp).getTime();
      const total = entry.payload?.info?.total_token_usage;
      if (!Number.isFinite(timestamp) || !total) continue;
      timeline.push({ timestamp, summary: usageSummary(total) });
    }
  } catch {
    return [];
  }
  timeline.sort((left, right) => left.timestamp - right.timestamp);
  return timeline;
}

function normalizeSessionId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function validTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return Number.isFinite(new Date(value).getTime()) ? value : null;
}

async function collectSessionFiles() {
  const roots = [...getSessionRoots(), ...getHeadlessRoots()];
  const nestedPaths = await Promise.all(roots.map((root) => collectJsonlFiles(root)));
  return [...new Set(nestedPaths.flat())];
}

async function changedSessionFiles(filePaths, changedAfterMs) {
  const changed = await Promise.all(filePaths.map(async filePath => {
    try {
      return (await stat(filePath)).mtimeMs > changedAfterMs ? filePath : null;
    } catch {
      return null;
    }
  }));
  return changed.filter(Boolean);
}

function codexEventDedupKey({ source, sessionId, identityKey }) {
  return identityKey ? `${source}:${sessionId}:${identityKey}` : null;
}

/**
 * Attempt to produce a human-readable label from a raw workspace path.
 * Codex cwd values are already absolute paths, so just return as-is.
 */
function decodeWorkspace(raw) {
  return raw;
}

// ---------------------------------------------------------------------------
// Convert to common collector JSON
// ---------------------------------------------------------------------------

function buildOutput(dailyMap, sessionMap, tokenEvents, pricingData) {
  const byDate = new Map();
  for (const row of dailyMap.values()) {
    if (!byDate.has(row.date)) byDate.set(row.date, []);
    byDate.get(row.date).push(row);
  }

  const contributions = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, rows]) => ({
      date,
      clients: rows.map(row => {
        const tokens = {
          input:     row.input,
          output:    row.output,
          cacheRead:  row.cacheRead,
          cacheWrite: row.cacheWrite,
          reasoning:  row.reasoning,
        };
        return {
          client:  row.source,
          modelId: row.model,
          tokens,
          cost: calculateCost(row.model, tokens, pricingData),
        };
      })
    }));

  const entries = [...sessionMap.values()].map(wm => {
    const tokens = {
      input:     wm.input,
      output:    wm.output,
      cacheRead:  wm.cacheRead,
      cacheWrite: wm.cacheWrite,
      reasoning:  wm.reasoning,
    };
    return {
      client:         wm.source,
      workspaceKey:   wm.workspace,
      workspaceLabel: wm.workspaceLabel,
      sessionId:       wm.sessionId,
      lastActivity:    wm.lastActivity,
      model:          wm.model,
      ...tokens,
      cost: calculateCost(wm.model, tokens, pricingData),
    };
  });

  return { graphJson: { contributions }, modelsJson: { entries }, tokenEvents };
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

function tokenEventFor({ source, sessionId, legacySessionIds = [], timestamp, model, tokens, identityKey }) {
  const eventId = codexEventId({ sessionId, identityKey });
  return {
    eventId,
    legacyEventIds: legacySessionIds
      .map(candidate => codexEventId({ sessionId: candidate, identityKey }))
      .filter(candidate => candidate !== eventId),
    source,
    sessionId,
    timestamp: timestamp || new Date().toISOString(),
    model,
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    cacheReadTokens: tokens.cacheRead,
    cacheCreationTokens: tokens.cacheWrite,
    reasoningTokens: tokens.reasoning,
    privacyLevel: 'safe'
  };
}

function codexEventId({ sessionId, identityKey }) {
  return `codex:${stableHash({ sessionId, identityKey })}`;
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
