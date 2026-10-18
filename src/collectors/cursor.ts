import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { configuredPaths, expandPath } from '../collector-config.ts';
import { calculateCost } from '../pricing.ts';
import { auditStructuredUsage, collectStructuredUsage, collectStructuredUsageWithAudit } from './structured-usage.ts';
import { localDateFromTimestamp, normalizeModelForGrouping } from './utils.ts';

export const CLIENT_KEY = 'cursor';
export const SOURCE_LABEL = 'Cursor';

export function roots() {
  const appData = process.env.APPDATA;
  const localAppData = process.env.LOCALAPPDATA;
  return configuredPaths('cursor', 'roots', [
    appData ? join(appData, 'Cursor') : null,
    localAppData ? join(localAppData, 'Cursor') : null,
    join(homedir(), '.cursor'),
    '~/.config/Cursor',
    '~/Library/Application Support/Cursor'
  ]).map(expandPath).filter(Boolean);
}

export async function collect(pricingData = null) {
  const dbEvents = [];
  for (const dbPath of cursorDbPaths()) {
    dbEvents.push(...collectCursorStateEvents(dbPath));
  }
  const structured = await collectStructuredUsage({
    clientKey: CLIENT_KEY,
    roots: roots(),
    pricingData
  });
  return mergeOutputs(buildOutput(dbEvents, pricingData), structured);
}

export async function collectWithAudit(pricingData = null) {
  const summary = emptyAuditSummary();
  const dbEvents = [];
  const dbPaths = cursorDbPaths();
  summary.candidateFiles = dbPaths.length;

  for (const dbPath of dbPaths) {
    const rows = readCursorStateRows(dbPath);
    if (!rows) {
      summary.parseErrors += 1;
      continue;
    }
    dbEvents.push(...rows.flatMap(row => normalizeCursorRow(row)));
    addAudit(summary, auditCursorStateRows(rows));
  }

  const structured = await collectStructuredUsageWithAudit({
    clientKey: CLIENT_KEY,
    roots: roots(),
    pricingData
  });
  addAudit(summary, structured.audit);

  return {
    ...mergeOutputs(buildOutput(dbEvents, pricingData), structured.output),
    audit: summary
  };
}

export async function audit() {
  const summary = emptyAuditSummary();
  const dbPaths = cursorDbPaths();
  summary.candidateFiles += dbPaths.length;
  for (const dbPath of dbPaths) {
    const result = auditCursorStateDb(dbPath);
    addAudit(summary, result);
  }
  const structured = await auditStructuredUsage({ roots: roots() });
  addAudit(summary, structured);
  return summary;
}

function cursorDbPaths() {
  const candidates = [];
  for (const root of roots()) {
    if (!root) continue;
    if (basename(root).toLowerCase() === 'state.vscdb') {
      candidates.push(root);
    }
    candidates.push(join(root, 'User', 'globalStorage', 'state.vscdb'));
    candidates.push(join(root, 'globalStorage', 'state.vscdb'));
  }
  return [...new Set(candidates)].filter(path => existsSync(path));
}

function collectCursorStateEvents(dbPath) {
  const rows = readCursorStateRows(dbPath);
  return rows ? rows.flatMap(row => normalizeCursorRow(row)) : [];
}

function readCursorStateRows(dbPath) {
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
    const rows = db.prepare(`
      SELECT
        key AS rowKey,
        json_extract(value, '$.tokenCount.inputTokens') AS inputTokens,
        json_extract(value, '$.tokenCount.outputTokens') AS outputTokens,
        json_extract(value, '$.tokenCount.cacheReadTokens') AS cacheReadTokens,
        json_extract(value, '$.tokenCount.cacheCreationTokens') AS cacheCreationTokens,
        json_extract(value, '$.tokenCount.reasoningTokens') AS reasoningTokens,
        json_extract(value, '$.modelInfo.modelName') AS modelFromInfo,
        json_extract(value, '$.modelName') AS modelName,
        json_extract(value, '$.model') AS model,
        json_extract(value, '$.createdAt') AS createdAt,
        json_extract(value, '$.timestamp') AS timestamp,
        json_extract(value, '$.conversationId') AS conversationId
      FROM cursorDiskKV
      WHERE key LIKE 'bubbleId:%'
    `).all();
    return rows;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function auditCursorStateDb(dbPath) {
  const summary = emptyAuditSummary();
  const rows = readCursorStateRows(dbPath);
  if (!rows) {
    summary.parseErrors += 1;
    return summary;
  }
  return auditCursorStateRows(rows);
}

function auditCursorStateRows(rows) {
  const summary = emptyAuditSummary();
  for (const row of rows) {
    const tokens = cursorTokens(row);
    if (tokenTotal(tokens) > 0) {
      summary.usableTokenRecords += 1;
    } else {
      summary.skippedNoTokenRecords += 1;
    }
  }
  return summary;
}

function normalizeCursorRow(row) {
  const tokens = cursorTokens(row);
  if (tokenTotal(tokens) <= 0) return [];
  const timestamp = normalizeTimestamp(row.createdAt || row.timestamp);
  const model = normalizeModelForGrouping(firstString(row.modelFromInfo, row.modelName, row.model) || 'unknown');
  const sessionId = firstString(row.conversationId) || sessionFromBubbleKey(row.rowKey);
  return [{
    eventId: `cursor:${stableEventId({ key: row.rowKey, timestamp, model, tokens })}`,
    source: CLIENT_KEY,
    sessionId,
    timestamp,
    date: localDateFromTimestamp(timestamp),
    model,
    projectLabel: 'Cursor',
    tokens,
    privacyLevel: 'safe'
  }];
}

function cursorTokens(row) {
  return {
    input: positive(row.inputTokens),
    output: positive(row.outputTokens),
    cacheRead: positive(row.cacheReadTokens),
    cacheWrite: positive(row.cacheCreationTokens),
    reasoning: positive(row.reasoningTokens)
  };
}

function sessionFromBubbleKey(value) {
  const parts = String(value || '').split(':').filter(Boolean);
  return parts.length >= 2 ? `cursor:${parts[1]}` : 'cursor:unknown-session';
}

function buildOutput(events, pricingData) {
  const dailyMap = new Map();
  const workspaceMap = new Map();

  for (const event of events) {
    const dailyKey = `${event.date}::${event.model}`;
    if (!dailyMap.has(dailyKey)) dailyMap.set(dailyKey, { date: event.date, model: event.model, tokens: zero(), cost: 0 });
    const daily = dailyMap.get(dailyKey);
    daily.cost += calculateCost(event.model, event.tokens, pricingData, null, event.date);
    addTokens(daily.tokens, event.tokens);

    const workspaceKey = `${event.projectLabel || event.sessionId}::${event.model}`;
    if (!workspaceMap.has(workspaceKey)) {
      workspaceMap.set(workspaceKey, {
        workspace: event.projectLabel || event.sessionId,
        workspaceLabel: event.projectLabel || event.sessionId,
        model: event.model,
        sessionId: event.sessionId,
        tokens: zero(),
        cost: 0
      });
    }
    const workspaceRow = workspaceMap.get(workspaceKey);
    workspaceRow.cost += calculateCost(event.model, event.tokens, pricingData, null, event.date);
    addTokens(workspaceRow.tokens, event.tokens);
  }

  const byDate = new Map();
  for (const row of dailyMap.values()) {
    if (!byDate.has(row.date)) byDate.set(row.date, []);
    byDate.get(row.date).push(row);
  }

  const contributions = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, rows]) => ({
      date,
      clients: rows.map(row => ({
        client: CLIENT_KEY,
        modelId: row.model,
        tokens: toTokenPayload(row.tokens),
        cost: row.cost
      }))
    }));

  const entries = [...workspaceMap.values()].map(row => ({
    client: CLIENT_KEY,
    workspaceKey: row.workspace,
    workspaceLabel: row.workspaceLabel,
    sessionId: row.sessionId,
    model: row.model,
    ...toTokenPayload(row.tokens),
    cost: row.cost
  }));

  const tokenEvents = events.map(event => ({
    eventId: event.eventId,
    source: CLIENT_KEY,
    sessionId: event.sessionId,
    timestamp: event.timestamp,
    model: event.model,
    inputTokens: event.tokens.input,
    outputTokens: event.tokens.output,
    cacheReadTokens: event.tokens.cacheRead,
    cacheCreationTokens: event.tokens.cacheWrite,
    reasoningTokens: event.tokens.reasoning,
    privacyLevel: event.privacyLevel || 'safe'
  }));

  return { graphJson: { contributions }, modelsJson: { entries }, tokenEvents };
}

function mergeOutputs(primary, secondary) {
  return {
    graphJson: {
      contributions: [
        ...(primary.graphJson?.contributions || []),
        ...(secondary.graphJson?.contributions || [])
      ]
    },
    modelsJson: {
      entries: [
        ...(primary.modelsJson?.entries || []),
        ...(secondary.modelsJson?.entries || [])
      ]
    },
    tokenEvents: [
      ...(primary.tokenEvents || []),
      ...(secondary.tokenEvents || [])
    ]
  };
}

function normalizeTimestamp(value) {
  if (!value) return new Date().toISOString();
  const number = Number(value);
  const ms = Number.isFinite(number) && /^\d+(\.\d+)?$/.test(String(value))
    ? (number > 1e12 ? number : number * 1000)
    : new Date(value).getTime();
  if (!Number.isFinite(ms)) return new Date().toISOString();
  return new Date(ms).toISOString();
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function zero() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

function addTokens(target, tokens) {
  target.input += tokens.input;
  target.output += tokens.output;
  target.cacheRead += tokens.cacheRead;
  target.cacheWrite += tokens.cacheWrite;
  target.reasoning += tokens.reasoning;
}

function toTokenPayload(tokens) {
  return {
    input: tokens.input,
    output: tokens.output,
    cacheRead: tokens.cacheRead,
    cacheWrite: tokens.cacheWrite,
    reasoning: tokens.reasoning
  };
}

function tokenTotal(tokens) {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite + tokens.reasoning;
}

function positive(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function stableEventId(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32);
}

function emptyAuditSummary() {
  return {
    candidateFiles: 0,
    usableTokenRecords: 0,
    skippedNoTokenRecords: 0,
    skippedConversationLikeRecords: 0,
    skippedOversizedFiles: 0,
    parseErrors: 0
  };
}

function addAudit(target, source) {
  for (const key of Object.keys(emptyAuditSummary())) {
    target[key] += Number(source[key] || 0);
  }
}
