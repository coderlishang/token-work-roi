import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { calculateOfficialCost } from './pricing.ts';
import { providerFromSource } from './provider.ts';
import { canonicalModelName } from './collectors/utils.ts';
import { recordRun, scopedTokenEventId, upsertDaily, upsertSession, upsertTokenEvent } from './db.ts';

const UNSAFE_KEYS = new Set([
  'prompt',
  'response',
  'messages',
  'message',
  'transcript',
  'conversation',
  'diff',
  'patch',
  'content',
  'text'
]);
const GENERIC_CODEX_SOURCE = 'Codex';
const LEGACY_UNKNOWN_CODEX_SOURCE = 'Codex (unidentified client)';
const CLAUDE_CODE_SOURCE = 'Claude Code';
const LEGACY_CLAUDE_SOURCE = 'claude';
const CHINA_TIME_OFFSET_MS = 8 * 60 * 60 * 1000;

interface ImportOptions {
  device?: string;
  now?: Date;
  importSource?: string;
  command?: string;
  toolCategory?: string;
}

export function readCcusageImportInput(file) {
  if (!file || file === '-') {
    return readFileSync(0, 'utf8');
  }
  return readFileSync(file, 'utf8');
}

export function parseCcusageJsonText(text) {
  let payload;
  try {
    payload = JSON.parse(String(text || '').trim());
  } catch (error) {
    const extracted = extractJsonPayload(String(text || ''));
    if (!extracted) throw new Error(`Invalid ccusage JSON: ${error.message}`);
    try {
      payload = JSON.parse(extracted);
    } catch {
      throw new Error(`Invalid ccusage JSON: ${error.message}`);
    }
  }
  const unsafePath = firstUnsafeKeyPath(payload);
  if (unsafePath) {
    throw new Error(`ccusage JSON contains conversation-like field: ${unsafePath}`);
  }
  return payload;
}

export function planCcusageImport(payload, options: ImportOptions = {}) {
  const device = cleanText(options.device, 120) || hostname();
  const now = options.now || new Date();
  const importSource = cleanText(options.importSource, 80) || 'import:ccusage-json';
  const command = cleanText(options.command, 240) || 'import-usage --format=ccusage-json';
  const toolCategory = cleanText(options.toolCategory, 80) || importSource;
  const detectedShape = detectShape(payload);
  const rows = extractUsageRows(payload, detectedShape);
  if (!rows.length) {
    throw new Error('No supported ccusage usage rows found');
  }

  const dailyByKey = new Map();
  const sessionsByKey = new Map();
  const eventsByKey = new Map();
  const warnings = [];

  for (const row of rows) {
    const parts = expandModelBreakdowns(row);
    assertBreakdownTotals(row, parts);
    for (const part of parts) {
      const source = sourceFromRow(part);
      const usageDate = usageDateFromRow(part);
      const timestamp = timestampFromRow(part, usageDate, now);
      const originalModel = cleanText(part.model, 160) || '<unknown>';
      const model = canonicalModelName(originalModel);
      const projectPath = cleanText(part.projectPath || part.project || part.projectName, 240) || null;
      const sessionId = sessionIdFromRow(part, detectedShape, usageDate, originalModel, projectPath);
      const tokens = tokenFields(part);
      const cost = calculateOfficialCost(model, {
        input: tokens.inputTokens,
        output: tokens.outputTokens,
        cacheRead: tokens.cacheReadTokens,
        cacheWrite: tokens.cacheCreationTokens,
        reasoning: tokens.reasoningOutputTokens
      }, { provider: providerFromSource(source) });

      if (!cost.priced && number(part.costUSD ?? part.totalCost) > 0) {
        warnings.push({
          type: 'ignored-imported-cost',
          model,
          reason: 'ccusage cost was present but Token Work keeps official-price conversion only.'
        });
      }

      const usageRow = {
        device,
        source,
        usageDate,
        model,
        ...tokens,
        totalTokens: tokens.totalTokens,
        costUSD: cost.totalUSD
      };
      const dailyKey = [usageRow.device, usageRow.source, usageRow.usageDate, usageRow.model].join('::');
      mergeUsageRow(dailyByKey, dailyKey, usageRow);

      const sessionRow = {
        device,
        source,
        sessionId,
        lastActivity: timestamp,
        projectPath,
        model,
        ...tokens,
        totalTokens: tokens.totalTokens,
        costUSD: cost.totalUSD
      };
      const sessionKey = [sessionRow.device, sessionRow.source, sessionRow.sessionId].join('::');
      mergeSessionRow(sessionsByKey, sessionKey, sessionRow);

      const eventRow = {
        eventId: eventIdFor({ detectedShape, source, sessionId, model: originalModel }),
        device,
        source,
        sessionId,
        timestamp,
        model,
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        cacheReadTokens: tokens.cacheReadTokens,
        cacheCreationTokens: tokens.cacheCreationTokens,
        reasoningTokens: tokens.reasoningOutputTokens,
        totalTokens: tokens.totalTokens,
        costUSD: cost.totalUSD,
        toolCategory,
        privacyLevel: 'safe'
      };
      eventsByKey.set(eventRow.eventId, eventRow);
    }
  }

  return {
    detectedShape,
    device,
    daily: [...dailyByKey.values()],
    sessions: [...sessionsByKey.values()],
    tokenEvents: [...eventsByKey.values()],
    warnings: dedupeWarnings(warnings),
    run: {
      device,
      source: importSource,
      status: 'ok',
      message: `shape=${detectedShape}, daily=${dailyByKey.size}, sessions=${sessionsByKey.size}, token_events=${eventsByKey.size}`,
      collectedAt: new Date(now).toISOString(),
      command
    }
  };
}

export function applyCcusageImport(db, plan) {
  assertCcusageImportCanApply(db, plan);
  db.exec('BEGIN');
  try {
    migrateLegacyGenericCodexImport(db, plan);
    migrateLegacyClaudeImport(db, plan);
    migrateLegacySnapshotSources(db, plan);
    migrateLegacySnapshotEvents(db, plan);
    migrateLegacyCcusageUtcDailyUsage(db, plan);
    const staleSnapshotEvents = removeStaleCcusageSnapshotEvents(db, plan);
    for (const row of plan.daily) upsertDaily(db, row);
    for (const row of plan.sessions) upsertSession(db, row);
    for (const row of plan.tokenEvents) {
      const applied = upsertTokenEvent(db, row);
      if (row.source === GENERIC_CODEX_SOURCE) {
        removeAppliedLegacyCodexEvent(db, row, applied.eventId);
      }
      if (row.source === CLAUDE_CODE_SOURCE) {
        removeAppliedLegacyClaudeEvent(db, row, applied.eventId);
      }
    }
    removeStaleCcusageDailyUsage(db, plan, staleSnapshotEvents);
    recordRun(db, plan.run);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return {
    daily: plan.daily.length,
    sessions: plan.sessions.length,
    tokenEvents: plan.tokenEvents.length,
    warnings: plan.warnings.length
  };
}

export function assertCcusageImportCanApply(db, plan) {
  const nativeRun = db.prepare(`
    SELECT 1 FROM collection_runs
    WHERE device = ? AND source = ? AND source NOT LIKE 'import:ccusage%'
    LIMIT 1
  `);
  const nativeEvent = db.prepare(`
    SELECT 1 FROM token_events
    WHERE device = ? AND source = ? AND event_id NOT LIKE 'ccusage:%'
    LIMIT 1
  `);
  const targets = new Set<string>(plan.tokenEvents.map(row => `${row.device}\0${row.source}`));
  for (const target of targets) {
    const [device, source] = target.split('\0');
    if (nativeRun.get(device, source) || nativeEvent.get(device, source)) {
      throw new Error(`ccusage 导入会覆盖设备“${device}”中的原生 ${source} 数据；请为外部电脑使用不同的 --device 名称。`);
    }
    assertCcusageReportShapeIsConsistent(db, plan.detectedShape, device, source);
  }
}

function assertCcusageReportShapeIsConsistent(db, shape, device, source) {
  const sources = [source, ...legacySourcesFor(source)];
  const placeholders = sources.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT event_id AS eventId
    FROM token_events
    WHERE device = ? AND source IN (${placeholders}) AND event_id LIKE 'ccusage:%'
  `).all(device, ...sources);
  const existing = new Set(rows
    .map(row => /^ccusage:([^:]+):/.exec(row.eventId)?.[1])
    .filter(Boolean));
  const conflicting = [...existing].filter(existingShape => existingShape !== shape);
  if (conflicting.length) {
    throw new Error(`设备“${device}”中的 ${source} 已导入 ${conflicting.join('、')} 格式的 ccusage 快照；混合报告格式可能重复统计。请继续使用同一种报告格式，或指定新的 --device 名称。`);
  }
}

export function ccusageImportWouldChange(db, plan) {
  if (legacyGenericCodexImportWouldChange(db, plan)) return true;
  if (legacyClaudeImportWouldChange(db, plan)) return true;
  if (legacySnapshotSourcesWouldChange(db, plan)) return true;
  if (legacySnapshotEventsWouldChange(db, plan)) return true;
  if (hasStaleCcusageSnapshotEvents(db, plan)) return true;
  const daily = db.prepare(`
    SELECT 1 FROM daily_usage
    WHERE device = ? AND source = ? AND usage_date = ? AND model = ?
      AND input_tokens = ? AND output_tokens = ?
      AND cache_creation_tokens = ? AND cache_read_tokens = ?
      AND cached_input_tokens = ? AND reasoning_output_tokens = ?
      AND total_tokens = ? AND cost_usd = ?
  `);
  const sessions = db.prepare(`
    SELECT 1 FROM session_usage
    WHERE device = ? AND source = ? AND session_id = ?
      AND last_activity IS COALESCE(?, last_activity)
      AND project_path IS COALESCE(?, project_path)
      AND model = CASE WHEN ? != '' THEN ? ELSE model END
      AND input_tokens = ? AND output_tokens = ?
      AND cache_creation_tokens = ? AND cache_read_tokens = ?
      AND cached_input_tokens = ? AND reasoning_output_tokens = ?
      AND total_tokens = ? AND cost_usd = ?
  `);
  const events = db.prepare(`
    SELECT 1 FROM token_events
    WHERE event_id = ? AND device = ? AND source = ? AND session_id = ? AND timestamp = ? AND model = ?
      AND input_tokens = ? AND output_tokens = ?
      AND cache_read_tokens = ? AND cache_creation_tokens = ? AND reasoning_tokens = ?
      AND tool_category IS ? AND file_extension IS ? AND repo_path_hash IS ? AND privacy_level = ?
  `);

  for (const row of plan.daily) {
    if (!daily.get(
      row.device, row.source, row.usageDate, row.model,
      row.inputTokens, row.outputTokens, row.cacheCreationTokens, row.cacheReadTokens,
      row.cachedInputTokens || 0, row.reasoningOutputTokens, row.totalTokens, row.costUSD
    )) return true;
  }
  for (const row of plan.sessions) {
    if (!sessions.get(
      row.device, row.source, row.sessionId, row.lastActivity, row.projectPath, row.model, row.model,
      row.inputTokens, row.outputTokens, row.cacheCreationTokens, row.cacheReadTokens,
      row.cachedInputTokens || 0, row.reasoningOutputTokens, row.totalTokens, row.costUSD
    )) return true;
  }
  for (const row of plan.tokenEvents) {
    const matches = eventId => events.get(
      eventId, row.device, row.source, row.sessionId, row.timestamp, row.model,
      row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheCreationTokens, row.reasoningTokens,
      row.toolCategory || null, row.fileExtension || null, row.repoPathHash || null, row.privacyLevel || 'safe'
    );
    if (!matches(row.eventId) && !matches(scopedTokenEventId(row))) return true;
  }
  return false;
}

function legacyGenericCodexImportWouldChange(db, plan) {
  if (!plan.tokenEvents.some(row => row.source === GENERIC_CODEX_SOURCE)) return false;
  const legacyEvent = db.prepare(`
    SELECT 1 FROM token_events
    WHERE device = ? AND source IN ('codex', ?)
      AND event_id IN (?, ?)
    LIMIT 1
  `);
  for (const row of plan.tokenEvents.filter(row => row.source === GENERIC_CODEX_SOURCE)) {
    const unidentifiedEventId = row.eventId.replace(/^(ccusage:[^:]+:)[^:]+:/, '$1codex-unidentified-client:');
    if (legacyEvent.get(row.device, LEGACY_UNKNOWN_CODEX_SOURCE, row.eventId, unidentifiedEventId)) return true;
  }
  const legacyDaily = db.prepare(`
    SELECT 1 FROM daily_usage
    WHERE device = ? AND source IN ('codex', ?) AND usage_date = ? AND model = ?
    LIMIT 1
  `);
  if (plan.daily.filter(row => row.source === GENERIC_CODEX_SOURCE).some(row => legacyDaily.get(
    row.device, LEGACY_UNKNOWN_CODEX_SOURCE, row.usageDate, row.model
  ))) return true;
  const legacySession = db.prepare(`
    SELECT 1 FROM session_usage
    WHERE device = ? AND source IN ('codex', ?) AND session_id = ?
    LIMIT 1
  `);
  return plan.sessions.filter(row => row.source === GENERIC_CODEX_SOURCE).some(row => legacySession.get(
    row.device, LEGACY_UNKNOWN_CODEX_SOURCE, row.sessionId
  ));
}

function detectShape(payload) {
  if (Array.isArray(payload?.daily)) return 'daily';
  if (payload?.projects && typeof payload.projects === 'object' && !Array.isArray(payload.projects)) return 'project-daily';
  if (Array.isArray(payload?.data) && payload.type) {
    const type = String(payload.type).toLowerCase();
    if (['daily', 'weekly', 'session', 'blocks', 'monthly'].includes(type)) return type;
  }
  for (const type of ['weekly', 'session', 'blocks', 'monthly']) {
    if (Array.isArray(payload?.[type])) return type;
  }
  throw new Error('Unsupported ccusage JSON shape. Expected daily, project daily, weekly, session, blocks, monthly, or top-level report output.');
}

function extractUsageRows(payload, shape) {
  if (shape === 'daily') return payload.daily.map(row => ({ ...row }));
  if (shape === 'project-daily') {
    const rows = [];
    for (const [project, entries] of Object.entries(payload.projects || {})) {
      if (!Array.isArray(entries)) continue;
      for (const row of entries) rows.push({ ...row, projectPath: project });
    }
    return rows;
  }
  if (Array.isArray(payload[shape])) return payload[shape].map(row => ({ ...row }));
  return (payload.data || []).map(row => ({ ...row }));
}

function expandModelBreakdowns(row) {
  const breakdown = row.modelBreakdowns || row.modelBreakdown || row.breakdowns;
  if (!breakdown) {
    return [{ ...row, model: primaryModel(row) }];
  }

  if (Array.isArray(breakdown)) {
    const usable = breakdown.filter(item => item && typeof item === 'object' && hasTokenField(item));
    if (!usable.length) return [{ ...row, model: primaryModel(row) }];
    return usable.map((item, index) => breakdownPart(row, item, primaryModel(row, index), usable.length > 1));
  }

  if (typeof breakdown === 'object') {
    const usable = Object.entries(breakdown)
      .filter(([, item]) => item && typeof item === 'object' && hasTokenField(item));
    if (!usable.length) return [{ ...row, model: primaryModel(row) }];
    return usable.map(([model, item]) => breakdownPart(row, item, model, usable.length > 1));
  }

  return [{ ...row, model: primaryModel(row) }];
}

function breakdownPart(row, item, fallbackModel, removeAggregateTokens) {
  const shared = removeAggregateTokens ? withoutAggregateTokenFields(row) : row;
  return {
    ...shared,
    ...inputRecord(item),
    model: item.model || item.modelName || fallbackModel
  };
}

function withoutAggregateTokenFields(row) {
  const copy = { ...row };
  for (const key of [
    'inputTokens', 'input_tokens', 'input',
    'outputTokens', 'output_tokens', 'output',
    'cacheCreationTokens', 'cacheCreationInputTokens', 'cache_creation_tokens', 'cacheWriteTokens',
    'cacheReadTokens', 'cacheReadInputTokens', 'cache_read_tokens', 'cachedInputTokens',
    'reasoningTokens', 'reasoningOutputTokens', 'reasoning_output_tokens',
    'totalTokens', 'total_tokens'
  ]) {
    delete copy[key];
  }
  const metadata = inputRecord(copy.metadata);
  delete metadata.reasoningTokens;
  delete metadata.reasoningOutputTokens;
  copy.metadata = metadata;
  return copy;
}

function assertBreakdownTotals(row, parts) {
  if (parts.length < 2) return;
  const parent = tokenFields(row).totalTokens;
  const breakdown = parts.reduce((sum, part) => sum + tokenFields(part).totalTokens, 0);
  if (parent !== breakdown) {
    throw new Error('ccusage modelBreakdowns totals cannot be reconciled; export a report with complete per-model token fields.');
  }
}

function inputRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function primaryModel(row, index = 0) {
  const models = row.modelsUsed || row.models || row.model;
  if (Array.isArray(models)) return models[index] || models[0] || '<unknown>';
  return models || row.modelName || '<unknown>';
}

function tokenFields(row) {
  const inputTokens = integer(row.inputTokens ?? row.input_tokens ?? row.input);
  let outputTokens = integer(row.outputTokens ?? row.output_tokens ?? row.output);
  const cacheCreationTokens = integer(
    row.cacheCreationTokens
    ?? row.cacheCreationInputTokens
    ?? row.cache_creation_tokens
    ?? row.cacheWriteTokens
  );
  const cacheReadTokens = integer(
    row.cacheReadTokens
    ?? row.cacheReadInputTokens
    ?? row.cache_read_tokens
    ?? row.cachedInputTokens
  );
  const reasoningOutputTokens = integer(
    row.reasoningTokens
    ?? row.reasoningOutputTokens
    ?? row.reasoning_output_tokens
    ?? row.metadata?.reasoningTokens
    ?? row.metadata?.reasoningOutputTokens
  );
  const explicitTotal = integer(row.totalTokens ?? row.total_tokens);
  const inclusiveTotal = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;
  if (reasoningOutputTokens > 0 && reasoningOutputTokens <= outputTokens && explicitTotal === inclusiveTotal) {
    outputTokens -= reasoningOutputTokens;
  }
  const computedTotal = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens + reasoningOutputTokens;
  return {
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    cachedInputTokens: 0,
    reasoningOutputTokens,
    totalTokens: Math.max(explicitTotal, computedTotal)
  };
}

function hasTokenField(row) {
  return [
    'inputTokens',
    'input_tokens',
    'outputTokens',
    'output_tokens',
    'cacheCreationTokens',
    'cacheCreationInputTokens',
    'cacheReadTokens',
    'cacheReadInputTokens',
    'cachedInputTokens',
    'cached_input_tokens',
    'cacheWriteTokens',
    'reasoningTokens',
    'reasoningOutputTokens',
    'reasoning_output_tokens',
    'totalTokens',
    'total_tokens'
  ].some(key => row[key] != null);
}

function sourceFromRow(row) {
  const source = cleanText(row.source || row.tool || row.instance || row.provider || row.agent, 80);
  const normalized = source?.toLowerCase();
  if (normalized === 'codex') return GENERIC_CODEX_SOURCE;
  if (normalized === LEGACY_CLAUDE_SOURCE) return CLAUDE_CODE_SOURCE;
  return source || 'ccusage';
}

function migrateLegacyClaudeImport(db, plan) {
  const legacyEvents = new Map(plan.tokenEvents
    .filter(row => row.source === CLAUDE_CODE_SOURCE)
    .map(row => [legacyClaudeEventId(row.eventId), row.eventId]));
  if (!legacyEvents.size) return;

  const rows = db.prepare(`
    SELECT event_id AS eventId
    FROM token_events
    WHERE device = ? AND source = ? AND event_id LIKE 'ccusage:%:%:%'
  `).all(plan.device, LEGACY_CLAUDE_SOURCE);
  for (const { eventId } of rows) {
    const canonicalEventId = legacyEvents.get(eventId);
    if (!canonicalEventId) continue;
    const current = db.prepare('SELECT device, source FROM token_events WHERE event_id = ?').get(canonicalEventId);
    if (current?.device === plan.device && current?.source === CLAUDE_CODE_SOURCE) {
      db.prepare('DELETE FROM token_events WHERE event_id = ?').run(eventId);
      continue;
    }
    if (!current) {
      db.prepare(`UPDATE token_events SET event_id = ?, source = ? WHERE event_id = ? AND device = ? AND source = ?`)
        .run(canonicalEventId, CLAUDE_CODE_SOURCE, eventId, plan.device, LEGACY_CLAUDE_SOURCE);
    }
  }

  for (const row of plan.daily.filter(row => row.source === CLAUDE_CODE_SOURCE)) {
    moveImportedDailySource(db, CLAUDE_CODE_SOURCE, row.device, LEGACY_CLAUDE_SOURCE, row.usageDate, row.model);
  }
  for (const row of plan.sessions.filter(row => row.source === CLAUDE_CODE_SOURCE)) {
    moveImportedSessionSource(db, CLAUDE_CODE_SOURCE, row.device, LEGACY_CLAUDE_SOURCE, row.sessionId);
  }
}

function legacyClaudeImportWouldChange(db, plan) {
  const legacyEvent = db.prepare(`
    SELECT 1 FROM token_events
    WHERE device = ? AND source = ? AND event_id = ?
    LIMIT 1
  `);
  const legacyDaily = db.prepare(`
    SELECT 1 FROM daily_usage
    WHERE device = ? AND source = ? AND usage_date = ? AND model = ?
    LIMIT 1
  `);
  const legacySession = db.prepare(`
    SELECT 1 FROM session_usage
    WHERE device = ? AND source = ? AND session_id = ?
    LIMIT 1
  `);
  return plan.tokenEvents
    .filter(row => row.source === CLAUDE_CODE_SOURCE)
    .some(row => legacyEvent.get(row.device, LEGACY_CLAUDE_SOURCE, legacyClaudeEventId(row.eventId)))
    || plan.daily
      .filter(row => row.source === CLAUDE_CODE_SOURCE)
      .some(row => legacyDaily.get(row.device, LEGACY_CLAUDE_SOURCE, row.usageDate, row.model))
    || plan.sessions
      .filter(row => row.source === CLAUDE_CODE_SOURCE)
      .some(row => legacySession.get(row.device, LEGACY_CLAUDE_SOURCE, row.sessionId));
}

function migrateLegacySnapshotEvents(db, plan) {
  const remove = db.prepare(`
    DELETE FROM token_events
    WHERE device = ? AND source = ? AND session_id = ? AND model = ?
      AND event_id LIKE 'ccusage:%' AND event_id NOT LIKE '%::%' AND event_id != ?
  `);
  for (const row of plan.tokenEvents) {
    remove.run(row.device, row.source, row.sessionId, row.model, row.eventId);
  }
}

function migrateLegacyCcusageUtcDailyUsage(db, plan) {
  const dailyByKey = new Map<string, any>(plan.daily.map(row => [
    `${row.device}\0${row.source}\0${row.usageDate}\0${row.model}`,
    row
  ]));
  const storedEvent = db.prepare(`
    SELECT input_tokens AS inputTokens, output_tokens AS outputTokens,
      cache_read_tokens AS cacheReadTokens, cache_creation_tokens AS cacheCreationTokens,
      reasoning_tokens AS reasoningTokens
    FROM token_events
    WHERE device = ? AND source = ? AND session_id = ? AND model = ?
      AND event_id LIKE 'ccusage:%'
    LIMIT 1
  `);
  const matchingDaily = db.prepare(`
    SELECT 1 FROM daily_usage
    WHERE device = ? AND source = ? AND usage_date = ? AND model = ?
      AND input_tokens = ? AND output_tokens = ?
      AND cache_creation_tokens = ? AND cache_read_tokens = ?
      AND cached_input_tokens = ? AND reasoning_output_tokens = ?
      AND total_tokens = ? AND cost_usd = ?
  `);
  const legacyByDaily = new Map();

  for (const row of plan.tokenEvents) {
    const oldUsageDate = formatUtcDate(new Date(row.timestamp));
    const newUsageDate = formatDate(new Date(row.timestamp));
    if (oldUsageDate === newUsageDate) continue;
    const planned = dailyByKey.get(`${row.device}\0${row.source}\0${newUsageDate}\0${row.model}`);
    if (!planned || matchingDaily.get(
      planned.device, planned.source, planned.usageDate, planned.model,
      planned.inputTokens, planned.outputTokens, planned.cacheCreationTokens, planned.cacheReadTokens,
      planned.cachedInputTokens || 0, planned.reasoningOutputTokens, planned.totalTokens, planned.costUSD
    )) continue;

    const stored = storedEvent.get(row.device, row.source, row.sessionId, row.model);
    if (!stored) continue;
    const key = `${row.device}\0${row.source}\0${oldUsageDate}\0${row.model}`;
    const legacy = legacyByDaily.get(key) || {
      device: row.device,
      source: row.source,
      usageDate: oldUsageDate,
      model: row.model,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      reasoningOutputTokens: 0,
      costUSD: 0
    };
    legacy.inputTokens += stored.inputTokens || 0;
    legacy.outputTokens += stored.outputTokens || 0;
    legacy.cacheCreationTokens += stored.cacheCreationTokens || 0;
    legacy.cacheReadTokens += stored.cacheReadTokens || 0;
    legacy.reasoningOutputTokens += stored.reasoningTokens || 0;
    legacy.costUSD += calculateOfficialCost(row.model, {
      input: stored.inputTokens,
      output: stored.outputTokens,
      cacheRead: stored.cacheReadTokens,
      cacheWrite: stored.cacheCreationTokens,
      reasoning: stored.reasoningTokens
    }, { provider: providerFromSource(row.source) }).totalUSD;
    legacyByDaily.set(key, legacy);
  }

  subtractDailyUsage(db, [...legacyByDaily.values()]);
}

function removeStaleCcusageSnapshotEvents(db, plan) {
  if (plan.detectedShape !== 'session') return [];
  const currentModelsBySession = new Map();
  for (const row of plan.tokenEvents) {
    const key = `${row.device}\0${row.source}\0${row.sessionId}`;
    const models = currentModelsBySession.get(key) || new Set();
    models.add(row.model);
    currentModelsBySession.set(key, models);
  }

  const find = db.prepare(`
    SELECT event_id AS eventId, device, source, session_id AS sessionId, timestamp, model,
      input_tokens AS inputTokens, output_tokens AS outputTokens,
      cache_read_tokens AS cacheReadTokens, cache_creation_tokens AS cacheCreationTokens,
      reasoning_tokens AS reasoningTokens
    FROM token_events
    WHERE device = ? AND source = ? AND session_id = ?
      AND event_id LIKE 'ccusage:session:%'
  `);
  const remove = db.prepare(`
    DELETE FROM token_events
    WHERE event_id = ? AND device = ? AND source = ?
  `);
  const stale = [];
  for (const [key, models] of currentModelsBySession) {
    const [device, source, sessionId] = key.split('\0');
    for (const row of find.all(device, source, sessionId)) {
      if (models.has(row.model)) continue;
      remove.run(row.eventId, row.device, row.source);
      stale.push(row);
    }
  }
  return stale;
}

function hasStaleCcusageSnapshotEvents(db, plan) {
  if (plan.detectedShape !== 'session') return false;
  const currentModelsBySession = new Map();
  for (const row of plan.tokenEvents) {
    const key = `${row.device}\0${row.source}\0${row.sessionId}`;
    const models = currentModelsBySession.get(key) || new Set();
    models.add(row.model);
    currentModelsBySession.set(key, models);
  }
  const find = db.prepare(`
    SELECT model
    FROM token_events
    WHERE device = ? AND source = ? AND session_id = ?
      AND event_id LIKE 'ccusage:session:%'
  `);
  for (const [key, models] of currentModelsBySession) {
    const [device, source, sessionId] = key.split('\0');
    if (find.all(device, source, sessionId).some(row => !models.has(row.model))) return true;
  }
  return false;
}

function removeStaleCcusageDailyUsage(db, plan, staleEvents) {
  if (!staleEvents.length) return;
  const plannedDaily = new Set(plan.daily.map(row => `${row.device}\0${row.source}\0${row.usageDate}\0${row.model}`));
  const staleByDaily = new Map();
  for (const row of staleEvents) {
    const usageDate = formatDate(new Date(row.timestamp));
    const key = `${row.device}\0${row.source}\0${usageDate}\0${row.model}`;
    const existing = staleByDaily.get(key) || {
      device: row.device,
      source: row.source,
      usageDate,
      model: row.model,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      reasoningOutputTokens: 0,
      costUSD: 0
    };
    existing.inputTokens += row.inputTokens || 0;
    existing.outputTokens += row.outputTokens || 0;
    existing.cacheCreationTokens += row.cacheCreationTokens || 0;
    existing.cacheReadTokens += row.cacheReadTokens || 0;
    existing.reasoningOutputTokens += row.reasoningTokens || 0;
    existing.costUSD += calculateOfficialCost(row.model, {
      input: row.inputTokens,
      output: row.outputTokens,
      cacheRead: row.cacheReadTokens,
      cacheWrite: row.cacheCreationTokens,
      reasoning: row.reasoningTokens
    }, { provider: providerFromSource(row.source) }).totalUSD;
    staleByDaily.set(key, existing);
  }

  const remaining = db.prepare(`
    SELECT 1 FROM token_events
    WHERE device = ? AND source = ? AND model = ? AND date(timestamp, '+8 hours') = ?
    LIMIT 1
  `);
  const remove = db.prepare(`
    DELETE FROM daily_usage
    WHERE device = ? AND source = ? AND usage_date = ? AND model = ?
  `);
  const subtractRows = [];
  for (const [key, row] of staleByDaily) {
    if (plannedDaily.has(key)) continue;
    if (!remaining.get(row.device, row.source, row.model, row.usageDate)) {
      remove.run(row.device, row.source, row.usageDate, row.model);
      continue;
    }
    subtractRows.push(row);
  }
  subtractDailyUsage(db, subtractRows);
}

function subtractDailyUsage(db, rows) {
  const subtract = db.prepare(`
    UPDATE daily_usage
    SET input_tokens = MAX(0, input_tokens - ?),
      output_tokens = MAX(0, output_tokens - ?),
      cache_creation_tokens = MAX(0, cache_creation_tokens - ?),
      cache_read_tokens = MAX(0, cache_read_tokens - ?),
      reasoning_output_tokens = MAX(0, reasoning_output_tokens - ?),
      total_tokens = MAX(0, total_tokens - ?),
      cost_usd = MAX(0, cost_usd - ?),
      updated_at = datetime('now')
    WHERE device = ? AND source = ? AND usage_date = ? AND model = ?
  `);
  const removeEmpty = db.prepare(`
    DELETE FROM daily_usage
    WHERE device = ? AND source = ? AND usage_date = ? AND model = ?
      AND input_tokens = 0 AND output_tokens = 0
      AND cache_creation_tokens = 0 AND cache_read_tokens = 0
      AND cached_input_tokens = 0 AND reasoning_output_tokens = 0
      AND total_tokens = 0
  `);
  for (const row of rows) {
    const totalTokens = row.inputTokens + row.outputTokens + row.cacheCreationTokens
      + row.cacheReadTokens + row.reasoningOutputTokens;
    subtract.run(
      row.inputTokens, row.outputTokens, row.cacheCreationTokens, row.cacheReadTokens,
      row.reasoningOutputTokens, totalTokens, row.costUSD || 0,
      row.device, row.source, row.usageDate, row.model
    );
    removeEmpty.run(row.device, row.source, row.usageDate, row.model);
  }
}

function migrateLegacySnapshotSources(db, plan) {
  const legacyEvents = db.prepare(`
    SELECT event_id AS eventId
    FROM token_events
    WHERE device = ? AND source = ? AND session_id = ? AND model = ?
      AND event_id LIKE 'ccusage:%'
  `);
  const current = db.prepare('SELECT device, source FROM token_events WHERE event_id = ?');
  const move = db.prepare('UPDATE token_events SET source = ? WHERE event_id = ? AND device = ? AND source = ?');
  const remove = db.prepare('DELETE FROM token_events WHERE event_id = ? AND device = ? AND source = ?');

  for (const row of plan.tokenEvents) {
    for (const legacySource of legacySourcesFor(row.source)) {
      for (const { eventId } of legacyEvents.all(row.device, legacySource, row.sessionId, row.model)) {
        const owner = current.get(row.eventId);
        if (owner && !(owner.device === row.device && owner.source === legacySource && eventId === row.eventId)) {
          remove.run(eventId, row.device, legacySource);
        } else {
          move.run(row.source, eventId, row.device, legacySource);
        }
      }
    }
  }
}

function legacySnapshotSourcesWouldChange(db, plan) {
  const legacy = db.prepare(`
    SELECT 1 FROM token_events
    WHERE device = ? AND source = ? AND session_id = ? AND model = ?
      AND event_id LIKE 'ccusage:%'
    LIMIT 1
  `);
  return plan.tokenEvents.some(row => legacySourcesFor(row.source).some(source =>
    legacy.get(row.device, source, row.sessionId, row.model)
  ));
}

function legacySourcesFor(source) {
  if (source === GENERIC_CODEX_SOURCE) return ['codex', LEGACY_UNKNOWN_CODEX_SOURCE];
  if (source === CLAUDE_CODE_SOURCE) return [LEGACY_CLAUDE_SOURCE];
  return [];
}

function legacySnapshotEventsWouldChange(db, plan) {
  const legacy = db.prepare(`
    SELECT 1 FROM token_events
    WHERE device = ? AND source = ? AND session_id = ? AND model = ?
      AND event_id LIKE 'ccusage:%' AND event_id NOT LIKE '%::%' AND event_id != ?
    LIMIT 1
  `);
  return plan.tokenEvents.some(row => legacy.get(
    row.device, row.source, row.sessionId, row.model, row.eventId
  ));
}

function migrateLegacyGenericCodexImport(db, plan) {
  if (!plan.tokenEvents.some(row => row.source === GENERIC_CODEX_SOURCE)) return;
  const legacyEvents = new Map(plan.tokenEvents
    .filter(row => row.source === GENERIC_CODEX_SOURCE)
    .map((row) => [
    row.eventId,
    row.eventId
  ]));
  if (!legacyEvents.size) return;

  const rows = db.prepare(`
    SELECT event_id AS eventId
    FROM token_events
    WHERE device = ? AND source IN ('codex', ?) AND event_id LIKE 'ccusage:%:%:%'
  `).all(plan.device, LEGACY_UNKNOWN_CODEX_SOURCE);
  for (const { eventId } of rows) {
    const canonicalEventId = legacyEvents.get(legacyGenericCodexEventId(eventId));
    if (!canonicalEventId) continue;
    if (eventId === canonicalEventId) {
      db.prepare(`UPDATE token_events SET source = ? WHERE event_id = ?`).run(GENERIC_CODEX_SOURCE, eventId);
      continue;
    }
    const current = db.prepare('SELECT device, source FROM token_events WHERE event_id = ?').get(canonicalEventId);
    if (current?.device === plan.device && current?.source === GENERIC_CODEX_SOURCE) {
      db.prepare('DELETE FROM token_events WHERE event_id = ?').run(eventId);
      continue;
    }
    if (current) continue;
    db.prepare(`
      UPDATE token_events
      SET event_id = ?, source = ?
      WHERE event_id = ? AND device = ? AND source IN ('codex', ?)
    `).run(canonicalEventId, GENERIC_CODEX_SOURCE, eventId, plan.device, LEGACY_UNKNOWN_CODEX_SOURCE);
  }

  for (const row of plan.daily.filter(row => row.source === GENERIC_CODEX_SOURCE)) {
    for (const source of ['codex', LEGACY_UNKNOWN_CODEX_SOURCE]) {
      moveImportedDailySource(db, GENERIC_CODEX_SOURCE, row.device, source, row.usageDate, row.model);
    }
  }
  for (const row of plan.sessions.filter(row => row.source === GENERIC_CODEX_SOURCE)) {
    for (const source of ['codex', LEGACY_UNKNOWN_CODEX_SOURCE]) {
      moveImportedSessionSource(db, GENERIC_CODEX_SOURCE, row.device, source, row.sessionId);
    }
  }

}

function moveImportedDailySource(db, targetSource, device, source, usageDate, model) {
  const target = db.prepare(`
    SELECT 1 FROM daily_usage
    WHERE device = ? AND source = ? AND usage_date = ? AND model = ?
  `).get(device, targetSource, usageDate, model);
  if (target) {
    db.prepare(`DELETE FROM daily_usage WHERE device = ? AND source = ? AND usage_date = ? AND model = ?`)
      .run(device, source, usageDate, model);
    return;
  }
  db.prepare(`UPDATE daily_usage SET source = ? WHERE device = ? AND source = ? AND usage_date = ? AND model = ?`)
    .run(targetSource, device, source, usageDate, model);
}

function removeAppliedLegacyCodexEvent(db, row, appliedEventId) {
  const unidentifiedEventId = row.eventId.replace(/^(ccusage:[^:]+:)[^:]+:/, '$1codex-unidentified-client:');
  db.prepare(`
    DELETE FROM token_events
    WHERE device = ? AND source IN ('codex', ?)
      AND event_id IN (?, ?)
      AND event_id != ?
  `).run(
    row.device,
    LEGACY_UNKNOWN_CODEX_SOURCE,
    row.eventId,
    unidentifiedEventId,
    appliedEventId
  );
}

function removeAppliedLegacyClaudeEvent(db, row, appliedEventId) {
  db.prepare(`
    DELETE FROM token_events
    WHERE device = ? AND source = ? AND event_id = ? AND event_id != ?
  `).run(row.device, LEGACY_CLAUDE_SOURCE, legacyClaudeEventId(row.eventId), appliedEventId);
}

function moveImportedSessionSource(db, targetSource, device, source, sessionId) {
  if (source === targetSource) return;
  db.prepare(`
    INSERT OR IGNORE INTO session_usage (
      device, source, session_id, last_activity, project_path, model, input_tokens,
      output_tokens, cache_creation_tokens, cache_read_tokens, cached_input_tokens,
      reasoning_output_tokens, total_tokens, cost_usd, updated_at
    ) SELECT device, ?, session_id, last_activity, project_path, model, input_tokens,
      output_tokens, cache_creation_tokens, cache_read_tokens, cached_input_tokens,
      reasoning_output_tokens, total_tokens, cost_usd, updated_at
    FROM session_usage WHERE device = ? AND source = ? AND session_id = ?
  `).run(targetSource, device, source, sessionId);
  for (const table of ['session_annotations', 'session_outputs']) {
    db.prepare(`
      DELETE FROM ${table} WHERE device = ? AND source = ? AND session_id = ?
        AND EXISTS (SELECT 1 FROM ${table} AS current
          WHERE current.device = ? AND current.source = ? AND current.session_id = ?
            AND COALESCE(julianday(current.updated_at), 0) >= COALESCE(julianday(${table}.updated_at), 0))
    `).run(device, source, sessionId, device, targetSource, sessionId);
    db.prepare(`
      DELETE FROM ${table} WHERE device = ? AND source = ? AND session_id = ?
        AND EXISTS (SELECT 1 FROM ${table} AS legacy
          WHERE legacy.device = ? AND legacy.source = ? AND legacy.session_id = ?
            AND COALESCE(julianday(legacy.updated_at), 0) > COALESCE(julianday(${table}.updated_at), 0))
    `).run(device, targetSource, sessionId, device, source, sessionId);
    db.prepare(`UPDATE ${table} SET source = ? WHERE device = ? AND source = ? AND session_id = ?`)
      .run(targetSource, device, source, sessionId);
  }
  db.prepare(`
    DELETE FROM work_item_sessions WHERE device = ? AND source = ? AND session_id = ?
      AND EXISTS (SELECT 1 FROM work_item_sessions AS current WHERE current.work_item_id = work_item_sessions.work_item_id AND current.device = ? AND current.source = ? AND current.session_id = ?)
  `).run(device, source, sessionId, device, targetSource, sessionId);
  db.prepare(`UPDATE work_item_sessions SET source = ? WHERE device = ? AND source = ? AND session_id = ?`)
    .run(targetSource, device, source, sessionId);
  db.prepare(`DELETE FROM session_usage WHERE device = ? AND source = ? AND session_id = ?`)
    .run(device, source, sessionId);
}

function legacyGenericCodexEventId(eventId) {
  return String(eventId).replace(/^(ccusage:[^:]+:)[^:]+:/, '$1codex:');
}

function legacyClaudeEventId(eventId) {
  return String(eventId).replace(/^(ccusage:[^:]+:)[^:]+:/, '$1claude:');
}

function usageDateFromRow(row) {
  const raw = row.date || row.usageDate || row.week || row.weekStart || row.startDate || row.month || row.blockStart || row.firstActivity || row.lastActivity || row.metadata?.lastActivity || row.metadata?.firstActivity;
  const date = parseDate(raw);
  if (!date) throw new Error('ccusage row is missing a usable date/month/activity field');
  return formatDate(date);
}

function timestampFromRow(row, usageDate, now) {
  const raw = row.lastActivity || row.metadata?.lastActivity || row.blockEnd || row.firstActivity || row.metadata?.firstActivity || row.blockStart || row.date || row.week || row.weekStart || row.startDate || row.month;
  const date = parseDate(raw) || parseDate(usageDate) || new Date(now);
  return date.toISOString();
}

function sessionIdFromRow(row, shape, usageDate, model, projectPath) {
  const raw = row.session || row.sessionId || row.session_id || row.id || row.period || null;
  if (raw) return cleanText(raw, 240);
  const project = projectPath ? hashable(projectPath) : 'all';
  return `ccusage:${shape}:${project}:${usageDate}:${hashable(model)}`;
}

function eventIdFor({ detectedShape, source, sessionId, model }) {
  return [
    'ccusage',
    detectedShape,
    hashable(source),
    hashable(sessionId),
    hashable(model)
  ].join(':');
}

function mergeUsageRow(map, key, row) {
  const existing = map.get(key);
  if (!existing) {
    map.set(key, { ...row });
    return;
  }
  addTokenFields(existing, row);
  existing.costUSD += row.costUSD || 0;
}

function mergeSessionRow(map, key, row) {
  const existing = map.get(key);
  if (!existing) {
    map.set(key, { ...row });
    return;
  }
  addTokenFields(existing, row);
  existing.costUSD += row.costUSD || 0;
  if (row.lastActivity && (!existing.lastActivity || row.lastActivity > existing.lastActivity)) {
    existing.lastActivity = row.lastActivity;
  }
  if (!existing.projectPath && row.projectPath) existing.projectPath = row.projectPath;
}

function addTokenFields(target, row) {
  target.inputTokens += row.inputTokens || 0;
  target.outputTokens += row.outputTokens || 0;
  target.cacheCreationTokens += row.cacheCreationTokens || 0;
  target.cacheReadTokens += row.cacheReadTokens || 0;
  target.cachedInputTokens += row.cachedInputTokens || 0;
  target.reasoningOutputTokens += row.reasoningOutputTokens || 0;
  target.totalTokens += row.totalTokens || 0;
}

function firstUnsafeKeyPath(value, path = '$') {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = firstUnsafeKeyPath(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(String(key).toLowerCase())) return `${path}.${key}`;
    const found = firstUnsafeKeyPath(child, `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

function parseDate(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const normalized = /^\d{4}-\d{2}$/.test(text) ? `${text}-01` : text;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(date) {
  return formatUtcDate(new Date(date.getTime() + CHINA_TIME_OFFSET_MS));
}

function formatUtcDate(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0')
  ].join('-');
}

function cleanText(value, maxLength) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function integer(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.round(number);
}

function number(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function hashable(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'unknown';
}

function extractJsonPayload(text) {
  const value = String(text || '');
  const candidates = [
    [value.indexOf('{'), value.lastIndexOf('}')],
    [value.indexOf('['), value.lastIndexOf(']')]
  ].filter(([start, end]) => start >= 0 && end > start);
  for (const [start, end] of candidates) {
    const candidate = value.slice(start, end + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Try the next possible JSON payload shape.
    }
  }
  return null;
}

function dedupeWarnings(warnings) {
  const seen = new Set();
  return warnings.filter(warning => {
    const key = `${warning.type}:${warning.model}:${warning.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
