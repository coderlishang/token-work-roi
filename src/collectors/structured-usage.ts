import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { calculateCost } from '../pricing.ts';
import { localDateFromTimestamp, normalizeModelForGrouping } from './utils.ts';

const MAX_DEPTH = 4;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const ACCEPTED_EXTENSIONS = new Set(['.json', '.jsonl']);

export async function collectStructuredUsage({
  clientKey,
  roots,
  pricingData = null
}) {
  const files = await listUsageFiles(roots);
  const events = [];

  for (const filePath of files) {
    const parsed = await parseUsageFile(filePath);
    events.push(...parsed.map(event => ({ ...event, client: clientKey })));
  }

  return buildStructuredUsageOutput(clientKey, events, pricingData);
}

export async function collectStructuredUsageWithAudit({
  clientKey,
  roots,
  pricingData = null
}) {
  const files = await listUsageFiles(roots);
  const events = [];
  const audit = emptyAuditSummary(files.length);

  for (const filePath of files) {
    const file = await readUsageFile(filePath);
    events.push(...parseUsageFileContent(file).map(event => ({ ...event, client: clientKey })));
    addAuditSummary(audit, auditUsageFileContent(file));
  }

  return {
    output: buildStructuredUsageOutput(clientKey, events, pricingData),
    audit
  };
}

export async function listUsageFiles(roots) {
  const files = [];
  for (const root of roots.filter(Boolean)) {
    await walk(root, 0, files);
  }
  return files;
}

export async function auditStructuredUsage({ roots }) {
  const files = await listUsageFiles(roots);
  const summary = emptyAuditSummary(files.length);

  for (const filePath of files) {
    const result = await auditUsageFile(filePath);
    addAuditSummary(summary, result);
  }

  return summary;
}

async function walk(dir, depth, files) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, depth + 1, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = extname(entry.name).toLowerCase();
    if (!ACCEPTED_EXTENSIONS.has(ext)) continue;
    files.push(fullPath);
  }
}

async function parseUsageFile(filePath) {
  return parseUsageFileContent(await readUsageFile(filePath));
}

async function readUsageFile(filePath) {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    return { error: 'stat' };
  }
  if (info.size > MAX_FILE_BYTES) return { oversized: true };

  try {
    return { filePath, info, text: await readFile(filePath, 'utf8') };
  } catch {
    return { error: 'read' };
  }
}

function parseUsageFileContent(file) {
  if (!file?.info || typeof file.text !== 'string') return [];
  const { info, text } = file;
  const fallback = {
    sessionId: basename(file.filePath || '', extname(file.filePath || '')),
    timestamp: new Date(info.mtimeMs).toISOString()
  };
  if (extname(file.filePath || '').toLowerCase() === '.jsonl') {
    return text.split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .flatMap((line, index) => parseJsonLine(line, { ...fallback, index }));
  }

  try {
    const json = JSON.parse(text);
    const rows = Array.isArray(json)
      ? json
      : Array.isArray(json.events) ? json.events
        : Array.isArray(json.usage) ? json.usage
          : Array.isArray(json.records) ? json.records
            : [json];
    return rows.flatMap((row, index) => normalizeUsageRecord(row, { ...fallback, index }));
  } catch {
    return [];
  }
}

async function auditUsageFile(filePath) {
  return auditUsageFileContent(await readUsageFile(filePath));
}

function auditUsageFileContent(file) {
  const summary = emptyAuditSummary();
  if (file?.oversized) {
    summary.skippedOversizedFiles += 1;
    return summary;
  }
  if (!file?.info || typeof file.text !== 'string') {
    summary.parseErrors += 1;
    return summary;
  }

  const { text } = file;

  if (extname(file.filePath || '').toLowerCase() === '.jsonl') {
    for (const line of text.split(/\r?\n/).map(item => item.trim()).filter(Boolean)) {
      auditJsonLine(line, summary);
    }
    return summary;
  }

  if (hasUnsafeConversationText(text)) {
    summary.skippedConversationLikeRecords += 1;
    return summary;
  }

  try {
    const json = JSON.parse(text);
    const rows = Array.isArray(json)
      ? json
      : Array.isArray(json.events) ? json.events
        : Array.isArray(json.usage) ? json.usage
          : Array.isArray(json.records) ? json.records
            : [json];
    for (const row of rows) {
      auditRecord(row, summary);
    }
  } catch {
    summary.parseErrors += 1;
  }

  return summary;
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

function addAuditSummary(target, source) {
  target.usableTokenRecords += source.usableTokenRecords;
  target.skippedNoTokenRecords += source.skippedNoTokenRecords;
  target.skippedConversationLikeRecords += source.skippedConversationLikeRecords;
  target.skippedOversizedFiles += source.skippedOversizedFiles;
  target.parseErrors += source.parseErrors;
}

function auditJsonLine(line, summary) {
  if (hasUnsafeConversationText(line)) {
    summary.skippedConversationLikeRecords += 1;
    return;
  }
  try {
    auditRecord(JSON.parse(line), summary);
  } catch {
    summary.parseErrors += 1;
  }
}

function auditRecord(row, summary) {
  if (!row || typeof row !== 'object') {
    summary.skippedNoTokenRecords += 1;
    return;
  }
  if (looksLikeConversation(row)) {
    summary.skippedConversationLikeRecords += 1;
    return;
  }
  const tokens = normalizeTokens(row);
  if (!hasReliableTokens(tokens)) {
    summary.skippedNoTokenRecords += 1;
    return;
  }
  summary.usableTokenRecords += 1;
}

function parseJsonLine(line, fallback) {
  try {
    return normalizeUsageRecord(JSON.parse(line), fallback);
  } catch {
    return [];
  }
}

export function normalizeUsageRecord(row, fallback: Record<string, unknown> = {}) {
  if (!row || typeof row !== 'object') return [];
  if (looksLikeConversation(row)) return [];

  const tokens = normalizeTokens(row);
  if (!hasReliableTokens(tokens)) return [];

  const model = normalizeModelForGrouping(firstString(
    row.model,
    row.modelId,
    row.model_id,
    row.modelName,
    row.model_name,
    row.request?.model,
    row.response?.model
  ) || 'unknown');
  const timestamp = normalizeTimestamp(firstString(
    row.timestamp,
    row.createdAt,
    row.created_at,
    row.time,
    row.date,
    fallback.timestamp
  ));
  const sessionId = firstString(
    row.sessionId,
    row.session_id,
    row.conversationId,
    row.conversation_id,
    row.threadId,
    row.thread_id,
    row.id,
    fallback.sessionId
  ) || 'unknown-session';
  const projectLabel = projectLabelFrom(row);
  const eventId = firstString(row.eventId, row.event_id)
    || stableEventId({ sessionId, timestamp, model, tokens, index: fallback.index });

  return [{
    eventId,
    sessionId,
    timestamp,
    date: localDateFromTimestamp(timestamp),
    model,
    projectLabel,
    tokens,
    toolCategory: sanitizeSmallText(firstString(row.toolCategory, row.tool_category, row.tool, row.kind), 80),
    fileExtension: sanitizeExtension(firstString(row.fileExtension, row.file_extension, row.ext)),
    repoPathHash: hashPath(firstString(row.repoPath, row.repo_path, row.workspacePath, row.workspace_path, row.cwd))
  }];
}

function normalizeTokens(row) {
  const tokenSource = row.tokens && typeof row.tokens === 'object' ? row.tokens : row.usage && typeof row.usage === 'object' ? row.usage : row;
  return {
    input: positive(tokenSource.inputTokens ?? tokenSource.input_tokens ?? tokenSource.promptTokens ?? tokenSource.prompt_tokens ?? tokenSource.input ?? tokenSource.prompt),
    output: positive(tokenSource.outputTokens ?? tokenSource.output_tokens ?? tokenSource.completionTokens ?? tokenSource.completion_tokens ?? tokenSource.output ?? tokenSource.completion),
    cacheRead: positive(tokenSource.cacheReadTokens ?? tokenSource.cache_read_tokens ?? tokenSource.cacheRead ?? tokenSource.cache_read ?? tokenSource.cachedTokens ?? tokenSource.cached_tokens),
    cacheWrite: positive(tokenSource.cacheCreationTokens ?? tokenSource.cache_creation_tokens ?? tokenSource.cacheWriteTokens ?? tokenSource.cache_write_tokens ?? tokenSource.cacheWrite ?? tokenSource.cache_write),
    reasoning: positive(tokenSource.reasoningTokens ?? tokenSource.reasoning_tokens ?? tokenSource.thoughtsTokens ?? tokenSource.thoughts_tokens ?? tokenSource.reasoning)
  };
}

function hasReliableTokens(tokens) {
  return tokens.input > 0 || tokens.output > 0 || tokens.cacheRead > 0 || tokens.cacheWrite > 0 || tokens.reasoning > 0;
}

export function buildStructuredUsageOutput(clientKey, events, pricingData) {
  const dailyMap = new Map();
  const workspaceMap = new Map();

  for (const event of events) {
    const dailyKey = `${event.date}::${event.model}`;
    if (!dailyMap.has(dailyKey)) dailyMap.set(dailyKey, { date: event.date, model: event.model, tokens: zero() });
    add(dailyMap.get(dailyKey).tokens, event.tokens);

    const workspace = event.projectLabel || event.sessionId;
    const workspaceKey = `${workspace}::${event.model}`;
    if (!workspaceMap.has(workspaceKey)) {
      workspaceMap.set(workspaceKey, {
        workspace,
        workspaceLabel: workspace,
        model: event.model,
        tokens: zero()
      });
    }
    add(workspaceMap.get(workspaceKey).tokens, event.tokens);
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
        client: clientKey,
        modelId: row.model,
        tokens: toTokenPayload(row.tokens),
        cost: calculateCost(row.model, toTokenPayload(row.tokens), pricingData)
      }))
    }));

  const entries = [...workspaceMap.values()].map(row => ({
    client: clientKey,
    workspaceKey: row.workspace,
    workspaceLabel: row.workspaceLabel,
    model: row.model,
    ...toTokenPayload(row.tokens),
    cost: calculateCost(row.model, toTokenPayload(row.tokens), pricingData)
  }));

  const tokenEvents = events.map(event => ({
    eventId: `${clientKey}:${event.eventId}`,
    source: clientKey,
    sessionId: event.sessionId,
    timestamp: event.timestamp,
    model: event.model,
    inputTokens: event.tokens.input,
    outputTokens: event.tokens.output,
    cacheReadTokens: event.tokens.cacheRead,
    cacheCreationTokens: event.tokens.cacheWrite,
    reasoningTokens: event.tokens.reasoning,
    toolCategory: event.toolCategory,
    fileExtension: event.fileExtension,
    repoPathHash: event.repoPathHash,
    privacyLevel: event.repoPathHash ? 'hashed' : 'safe'
  }));

  return { graphJson: { contributions }, modelsJson: { entries }, tokenEvents };
}

function looksLikeConversation(row) {
  return typeof row.prompt === 'string'
    || typeof row.response === 'string'
    || typeof row.content === 'string'
    || typeof row.diff === 'string'
    || typeof row.transcript === 'string'
    || Array.isArray(row.messages);
}

function hasUnsafeConversationText(text) {
  return /"(prompt|response|content|diff|transcript|messages)"\s*:/i.test(String(text || ''));
}

function projectLabelFrom(row) {
  const direct = firstString(row.projectAlias, row.project_alias, row.project, row.workspace, row.repo, row.repository);
  if (direct) return sanitizeSmallText(direct, 120);
  const pathValue = firstString(row.projectPath, row.project_path, row.workspacePath, row.workspace_path, row.repoPath, row.repo_path, row.cwd);
  return pathValue ? sanitizeSmallText(basename(String(pathValue).replace(/\\/g, '/')), 120) : null;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
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

function positive(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function zero() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

function add(target, tokens) {
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

function stableEventId(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32);
}

function hashPath(value) {
  if (!value) return null;
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
}

function sanitizeSmallText(value, maxLength) {
  if (!value) return null;
  return String(value).trim().replace(/\s+/g, ' ').slice(0, maxLength) || null;
}

function sanitizeExtension(value) {
  if (!value) return null;
  const text = String(value).trim().toLowerCase();
  const match = text.match(/^\.[a-z0-9]{1,12}$/);
  return match ? match[0] : null;
}
