import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { configuredPaths, expandPath } from '../collector-config.ts';
import { buildStructuredUsageOutput } from './structured-usage.ts';
import { localDateFromTimestamp, normalizeModelForGrouping } from './utils.ts';

export const CLIENT_KEY = 'deepseek-harness';
export const SOURCE_LABEL = 'DeepSeek Harness';

export function roots() {
  return configuredPaths('deepseekHarness', 'roots', ['~/.dsh'])
    .map(expandPath)
    .filter(Boolean);
}

export async function collect(pricingData = null, options = {}) {
  const result = await readHarnessUsage(sessionRoots(roots()), options);
  return {
    ...buildStructuredUsageOutput(CLIENT_KEY, result.events, pricingData),
    reconciliation: deepseekReconciliation()
  };
}

export async function collectWithAudit(pricingData = null, options = {}) {
  const result = await readHarnessUsage(sessionRoots(roots()), options);
  return {
    ...buildStructuredUsageOutput(CLIENT_KEY, result.events, pricingData),
    reconciliation: deepseekReconciliation(),
    audit: result.audit
  };
}

export async function audit() {
  return (await readHarnessUsage(sessionRoots(roots()))).audit;
}

export async function collectFromRoots(roots, pricingData = null, options = {}) {
  const result = await readHarnessUsage(sessionRoots(roots), options);
  return {
    ...buildStructuredUsageOutput(CLIENT_KEY, result.events, pricingData),
    reconciliation: deepseekReconciliation(),
    audit: result.audit
  };
}

// Delta 计费只上报本次增量，声明事件 id 前缀供 collect.ts 重建 daily/session 聚合。
function deepseekReconciliation() {
  return { managedEventIdPrefix: `${CLIENT_KEY}:` };
}

function sessionRoots(paths) {
  return paths
    .map(path => join(path, 'storages', 'session_projcache', 'sessions'))
    .filter(Boolean);
}

async function readHarnessUsage(roots, options: {
  changedAfterMs?: number;
  getStoredSessionEvents?: (sessionId: string) => Array<Record<string, unknown>>;
} = {}) {
  const changedAfterMs = Number(options.changedAfterMs) || 0;
  const getStoredSessionEvents = typeof options.getStoredSessionEvents === 'function'
    ? options.getStoredSessionEvents
    : null;
  const files = await listSessionFiles(roots, changedAfterMs);
  const audit = emptyAuditSummary(files.length);
  const events = [];

  for (const filePath of files) {
    const result = await parseSessionUsage(filePath, getStoredSessionEvents);
    events.push(...result.events);
    addAudit(audit, result.audit);
  }

  return { events, audit };
}

async function listSessionFiles(roots, changedAfterMs) {
  const files = [];
  for (const root of roots.filter(Boolean)) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith('session-') || !entry.name.endsWith('.json')) continue;
      const filePath = join(root, entry.name);
      if (changedAfterMs && !(await fileChangedAfter(filePath, changedAfterMs))) continue;
      files.push(filePath);
    }
  }
  return files;
}

async function fileChangedAfter(filePath, changedAfterMs) {
  try {
    const info = await stat(filePath);
    return info.mtimeMs > changedAfterMs;
  } catch {
    return false;
  }
}

// The harness maintains cumulative per-session tokenUsage totals in its
// projcache in real time, while the event log (`session.v3.jsonl.zstd`) is only
// flushed when a session closes. Each collect emits only the usage accrued
// since the stored rows for the session (delta), so totals stay correct when a
// session switches models mid-flight and usage lands on the day it was
// observed. Sessions already fully imported produce no events, which keeps
// repeated full collects idempotent.
async function parseSessionUsage(filePath, getStoredSessionEvents) {
  const audit = emptyAuditSummary();
  let file;
  try {
    file = await stat(filePath);
    const record = JSON.parse(await readFile(filePath, 'utf8'));
    return sessionUsageFromRecord(record, filePath, file.mtimeMs, getStoredSessionEvents, audit);
  } catch {
    audit.parseErrors += 1;
    return { events: [], audit };
  }
}

function sessionUsageFromRecord(record, filePath, mtimeMs, getStoredSessionEvents, audit) {
  const rows = record?.record?.rows || {};
  const totals = rows.tokenUsage?.val?.totals;
  const current = {
    input: tokenCount(totals?.uncachedInputTokens),
    output: tokenCount(totals?.outputTokens),
    cacheRead: tokenCount(totals?.cacheReadTokens),
    cacheWrite: tokenCount(totals?.cacheWriteTokens),
    reasoning: 0
  };
  if (current.input == null || current.output == null || current.cacheRead == null || current.cacheWrite == null) {
    audit.skippedNoTokenRecords += 1;
    return { events: [], audit };
  }
  if (current.input + current.output + current.cacheRead + current.cacheWrite === 0) {
    audit.skippedNoTokenRecords += 1;
    return { events: [], audit };
  }

  const sessionId = basename(filePath).replace(/\.json$/, '');
  const storedRows = getStoredSessionEvents ? storedRowsFor(getStoredSessionEvents, sessionId) : [];
  if (storedRows == null) {
    audit.parseErrors += 1;
    return { events: [], audit };
  }
  const stored = sumTokens(storedRows);
  if (totalOf(current) <= totalOf(stored)) {
    // Nothing accrued since the last import (or the counters went backwards,
    // which lifetime-of-session totals are not expected to do).
    audit.skippedNoTokenRecords += 1;
    return { events: [], audit };
  }

  const model = normalizeModelForGrouping(rows.modelSelection?.val?.lastUsed?.model || 'unknown');
  const timestamp = storedRows.length
    ? new Date(mtimeMs).toISOString()
    : new Date(timestampOr(mtimeMs, record?.record?.identity?.createdAt)).toISOString();
  const seq = safeSequence(rows.tokenUsage?.seq) >= 0 ? rows.tokenUsage.seq : `mtime:${mtimeMs}`;

  const event = {
    eventId: stableEventId({ sessionId, seq }),
    sessionId,
    timestamp,
    date: localDateFromTimestamp(timestamp),
    model,
    projectLabel: projectLabelFrom(record?.record?.identity?.cwd),
    tokens: {
      input: deltaOf(current.input, stored.input),
      output: deltaOf(current.output, stored.output),
      cacheRead: deltaOf(current.cacheRead, stored.cacheRead),
      cacheWrite: deltaOf(current.cacheWrite, stored.cacheWrite),
      reasoning: 0
    },
    toolCategory: null,
    fileExtension: null,
    repoPathHash: null
  };
  audit.usableTokenRecords += 1;
  return { events: [event], audit };
}

function storedRowsFor(getStoredSessionEvents, sessionId) {
  try {
    const rows = getStoredSessionEvents(sessionId);
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

function projectLabelFrom(cwd) {
  const name = typeof cwd === 'string' ? cwd.trim().split('/').filter(Boolean).at(-1) : '';
  return name || SOURCE_LABEL;
}

function timestampOr(fallbackMs, value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallbackMs;
}

function deltaOf(current, stored) {
  return Math.max(0, current - stored);
}

function sumTokens(rows) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  for (const row of rows) {
    totals.input += tokenCount(row?.tokens?.input) || 0;
    totals.output += tokenCount(row?.tokens?.output) || 0;
    totals.cacheRead += tokenCount(row?.tokens?.cacheRead) || 0;
    totals.cacheWrite += tokenCount(row?.tokens?.cacheWrite) || 0;
    totals.reasoning += tokenCount(row?.tokens?.reasoning) || 0;
  }
  return totals;
}

function totalOf(tokens) {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite + tokens.reasoning;
}

function safeSequence(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : -1;
}

function tokenCount(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function stableEventId(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}

function emptyAuditSummary(candidateFiles = 0) {
  return {
    candidateFiles,
    usableTokenRecords: 0,
    skippedNoTokenRecords: 0,
    skippedConversationLikeRecords: 0,
    skippedOversizedFiles: 0,
    parseErrors: 0
  };
}

function addAudit(target, source) {
  for (const key of Object.keys(target)) target[key] += source[key] || 0;
}
