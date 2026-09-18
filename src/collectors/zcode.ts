import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { basename, join } from 'node:path';
import { configuredPath, configuredPaths, expandPath } from '../collector-config.ts';
import { buildStructuredUsageOutput } from './structured-usage.ts';
import { localDateFromTimestamp, normalizeModelForGrouping } from './utils.ts';

export const CLIENT_KEY = 'zcode';
export const SOURCE_LABEL = 'ZCode';

export function roots() {
  return configuredPaths('zcode', 'roots', ['~/.zcode/cli/rollout'])
    .map(expandPath)
    .filter(Boolean);
}

export async function collect(pricingData = null, options = {}) {
  const result = await readZcodeUsage(roots(), options);
  return {
    ...buildStructuredUsageOutput(CLIENT_KEY, result.events, pricingData),
    reconciliation: zcodeReconciliation()
  };
}

export async function collectWithAudit(pricingData = null, options = {}) {
  const result = await readZcodeUsage(roots(), options);
  return {
    ...buildStructuredUsageOutput(CLIENT_KEY, result.events, pricingData),
    reconciliation: zcodeReconciliation(),
    audit: result.audit
  };
}

export async function audit() {
  return (await readZcodeUsage(roots())).audit;
}

export async function collectFromRoots(roots, pricingData = null, options = {}) {
  const result = await readZcodeUsage(roots, options);
  return {
    ...buildStructuredUsageOutput(CLIENT_KEY, result.events, pricingData),
    reconciliation: zcodeReconciliation(),
    audit: result.audit
  };
}

// 事件 id 由 (sessionId, requestId, attempt) 稳定派生，重复采集靠 upsert 幂等；
// 全量采集时按前缀删除重建，容忍 rollout 文件被清理。
function zcodeReconciliation() {
  return { managedEventIdPrefix: `${CLIENT_KEY}:` };
}

async function readZcodeUsage(roots, options: { changedAfterMs?: number; sessionDirectories?: Map<string, string> } = {}) {
  const changedAfterMs = Number(options.changedAfterMs) || 0;
  const files = await listRolloutFiles(roots, changedAfterMs);
  const audit = emptyAuditSummary(files.length);
  const directories = options.sessionDirectories ?? sessionDirectories(configuredPath('zcode', 'sessionDb', '~/.zcode/cli/db/db.sqlite'));
  const events = [];
  // 会话续接会把旧行复制进新文件，同一请求须跨文件去重
  const seenRequests = new Set();

  for (const filePath of files) {
    const result = await parseRolloutFile(filePath, directories, seenRequests, audit);
    events.push(...result);
  }

  return { events, audit };
}

async function listRolloutFiles(roots, changedAfterMs) {
  const files = [];
  for (const root of roots.filter(Boolean)) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith('model-io-') || !entry.name.endsWith('.jsonl')) continue;
      const filePath = join(root, entry.name);
      if (changedAfterMs && !(await fileChangedAfter(filePath, changedAfterMs))) continue;
      files.push(filePath);
    }
  }
  return files.sort();
}

async function fileChangedAfter(filePath, changedAfterMs) {
  try {
    const info = await stat(filePath);
    return info.mtimeMs > changedAfterMs;
  } catch {
    return false;
  }
}

// 智谱 OpenAI 语义：cacheRead/cacheWrite ⊆ inputTokens，totalTokens = input + output。
// 入库 input 必须扣除缓存部分，否则 daily 缓存与输入双计。
function splitUsage(usage) {
  const inputTokens = nonNegativeInt(usage?.inputTokens);
  const outputTokens = nonNegativeInt(usage?.outputTokens);
  const cacheRead = Math.min(nonNegativeInt(usage?.cacheReadTokens), inputTokens);
  const cacheWrite = Math.min(nonNegativeInt(usage?.cacheWriteTokens), inputTokens - cacheRead);
  if (inputTokens == null || outputTokens == null) return null;
  return {
    input: Math.max(0, inputTokens - cacheRead - cacheWrite),
    output: outputTokens,
    cacheRead,
    cacheWrite,
    reasoning: 0
  };
}

async function parseRolloutFile(filePath, directories, seenRequests, audit) {
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    audit.parseErrors += 1;
    return [];
  }

  const events = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      audit.parseErrors += 1;
      continue;
    }
    if (!record || record.type !== 'model_io') {
      audit.skippedNoTokenRecords += 1;
      continue;
    }
    const tokens = splitUsage(record.response?.usage);
    if (!tokens || tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite === 0) {
      audit.skippedNoTokenRecords += 1;
      continue;
    }

    const sessionId = typeof record.sessionId === 'string' && record.sessionId ? record.sessionId : basename(filePath).replace(/\.jsonl$/i, '');
    const attempt = nonNegativeInt(record.attempt) ?? 0;
    const requestId = typeof record.requestId === 'string' && record.requestId ? record.requestId : `line:${basename(filePath)}:${index}`;
    const requestKey = `${sessionId}|${requestId}|${attempt}`;
    if (seenRequests.has(requestKey)) continue;
    seenRequests.add(requestKey);

    const timestamp = typeof record.completedAt === 'string' && record.completedAt
      ? record.completedAt
      : new Date((await stat(filePath)).mtimeMs).toISOString();
    const date = localDateFromTimestamp(timestamp);

    events.push({
      eventId: stableEventId({ sessionId, requestId, attempt }),
      sessionId,
      timestamp,
      date,
      model: normalizeModelForGrouping(record.model?.modelId || 'unknown', date),
      projectLabel: projectLabelFrom(directories.get(sessionId)),
      tokens,
      toolCategory: null,
      fileExtension: null,
      repoPathHash: null
    });
    audit.usableTokenRecords += 1;
  }
  return events;
}

// 会话工作区取自 ZCode CLI db.sqlite 的 session.directory；读不到时回退 source 名。
function sessionDirectories(dbPath) {
  const map = new Map();
  const resolved = expandPath(dbPath);
  let db;
  try {
    db = new DatabaseSync(resolved, { readOnly: true });
  } catch {
    return map;
  }
  try {
    for (const row of db.prepare('SELECT id, directory FROM session').all()) {
      if (row?.id && row?.directory) map.set(String(row.id), String(row.directory));
    }
  } catch {
    return new Map();
  } finally {
    db.close();
  }
  return map;
}

function projectLabelFrom(directory) {
  if (!directory) return SOURCE_LABEL;
  const name = String(directory).replace(/\\/g, '/').split('/').filter(Boolean).at(-1);
  return name || SOURCE_LABEL;
}

function nonNegativeInt(value) {
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
