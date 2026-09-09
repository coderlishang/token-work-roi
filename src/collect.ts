import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { hostname } from 'node:os';
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createSqliteBackup, defaultDbPath, openDb, recordRun, repairUsageTotals, upsertDaily, upsertSession, upsertTokenEvent, usageTotalsNeedRepair } from './db.ts';
import { calculateCost, loadPricing } from './pricing.ts';
import { canonicalModelName, localDateFromTimestamp } from './collectors/utils.ts';
import { collectableCollectors, collectorLabel, enabledCollectorIds } from './collector-registry.ts';

type InputRecord = Record<string, unknown>;

const LEGACY_CODEX_SOURCE = 'Codex CLI';
const UNKNOWN_CODEX_SOURCE = 'Codex (unidentified client)';
const SCHEDULED_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CODEX_NATIVE_REASONING_VERSION = 1;
const CODEX_CCUSAGE_REASONING_VERSION = 2;
const CODEX_CLASSIFIED_CCUSAGE_REASONING_VERSION = 3;
const CODEX_ACCOUNTING_VERSION = 4;

interface CollectArgs {
  [key: string]: string | boolean | undefined;
  apply?: boolean;
  collectors?: string;
  db?: string;
  device?: string;
  dryRun?: boolean;
  experimental?: boolean;
  help?: boolean;
  json?: boolean;
  push?: string;
  sources?: string;
  token?: string;
  yes?: boolean;
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  validateMode(args);
  const mode = args.apply ? 'apply' : 'dry-run';
  await confirmApplyIfNeeded(args);

  const device = args.device || hostname();
  const collectedAt = new Date().toISOString();
  const pricingCachePath = resolve(process.cwd(), 'data', 'official-pricing.json');
  const pricingData = await loadPricing(pricingCachePath);
  const enabled = enabledCollectors(args);
  const scheduled = isScheduledCollection();
  const incrementalRefresh = isIncrementalMetadataRefresh();
  const fullRefreshSources = forcedFullRefreshSources();
  const includeExperimental = Boolean(args.sources || args.collectors || args.experimental);
  const collectors = collectableCollectors({ includeExperimental }).filter(({ id }) => enabled.has(id));
  const exportPayload = {
    device,
    collectedAt,
    daily: [],
    sessions: [],
    tokenEvents: [],
    runs: []
  };

  let db = null;
  const summary = {
    ok: true,
    mode,
    device,
    collectedAt,
    enabledCollectors: Array.from(enabled),
    before: null,
    after: null,
    backup: null,
    totals: {
      dailyRows: 0,
      sessionRows: 0,
      tokenEvents: 0,
      candidateFiles: 0,
      usableTokenRecords: 0,
      skippedNoTokenRecords: 0,
      skippedUnresolvedModel: 0,
      skippedConversationLikeRecords: 0,
      skippedOversizedFiles: 0,
      parseErrors: 0,
      auditSessionRows: 0,
      auditTokenEvents: 0,
      auditTotalTokens: 0,
      dailyTotalTokens: 0,
      sessionTotalTokens: 0,
      eventTotalTokens: 0,
      totalTokens: 0,
      firstTimestamp: null,
      lastTimestamp: null,
      fatalCoverageErrors: 0
    },
    sources: []
  };

  let collectionLock = null;

  try {
    if (mode === 'apply') {
      collectionLock = acquireCollectionLock(args.db);
      db = openDb(args.db);
      if (enabled.has('codex') && codexAccountingUpgradeNeeded(db)) {
        fullRefreshSources.add('codex');
      }
      summary.before = countRows(db);
    }
    await collectLocal({
      collectors,
      mode,
      db,
      dbPath: args.db,
      pricingData,
      device,
      collectedAt,
      exportPayload,
      summary,
      scheduled,
      incrementalRefresh,
      fullRefreshSources
    });
    if (args.push) {
      if (mode !== 'apply') throw new Error('--push is only available with --apply.');
      await pushPayload(args.push, exportPayload, args.token);
    }
  } finally {
    try {
      if (db) {
        summary.after = countRows(db);
        db.close();
      }
    } finally {
      releaseCollectionLock(collectionLock);
    }
  }

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    printSummary(summary);
  }

  if (summary.sources.some(source => source.status === 'error')) {
    process.exitCode = 1;
  }
}

function acquireCollectionLock(dbPath) {
  const resolvedDbPath = resolve(dbPath || defaultDbPath);
  const lockPath = `${resolvedDbPath}.collect.lock`;
  mkdirSync(dirname(resolvedDbPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      } finally {
        closeSync(fd);
      }
      return lockPath;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const owner = readCollectionLock(lockPath);
      if (owner?.pid && owner.pid !== process.pid && processExists(owner.pid)) {
        throw new Error(`A collection is already running for this SQLite database (PID ${owner.pid}).`);
      }
      if (!owner && collectionLockIsNew(lockPath)) {
        throw new Error('A collection is starting for this SQLite database. Please try again shortly.');
      }
      try {
        unlinkSync(lockPath);
      } catch (unlinkError) {
        if (unlinkError?.code !== 'ENOENT') throw unlinkError;
      }
    }
  }

  throw new Error('Unable to acquire the collection lock. Please try again.');
}

function collectionLockIsNew(lockPath) {
  try {
    return Date.now() - statSync(lockPath).mtimeMs < 5_000;
  } catch (error) {
    return error?.code !== 'ENOENT';
  }
}

function readCollectionLock(lockPath) {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8'));
    const pid = Number(parsed?.pid);
    return Number.isInteger(pid) && pid > 0 ? { pid } : null;
  } catch {
    return null;
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function releaseCollectionLock(lockPath) {
  if (!lockPath) return;
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function collectLocal({ collectors, mode, db, dbPath, pricingData, device, collectedAt, exportPayload, summary, scheduled, incrementalRefresh, fullRefreshSources }) {
  if (!collectors.length) return;

  const payloads = [];

  for (const { id, module, label } of collectors) {
    let graphJson = {};
    let modelsJson = {};
    let tokenEvents = [];
    let reconciliation = null;
    let audit = emptyAuditSummary();
    const sourceSummary = {
      id,
      label,
      status: 'empty',
      message: '',
      dailyRows: 0,
      sessionRows: 0,
      tokenEvents: 0,
      candidateFiles: 0,
      usableTokenRecords: 0,
      skippedNoTokenRecords: 0,
      skippedUnresolvedModel: 0,
      skippedConversationLikeRecords: 0,
      skippedOversizedFiles: 0,
      parseErrors: 0,
      dailyTotalTokens: 0,
      sessionTotalTokens: 0,
      eventTotalTokens: 0,
      totalTokens: 0,
      firstTimestamp: null,
      lastTimestamp: null,
      coverageRisk: 'empty',
      coverageStatus: 'empty',
      fatalCoverageError: false,
      reconciliation: null
    };

    try {
      const collectorModule = await import(module);
      const changedAfterMs = incrementalRefresh && db && !fullRefreshSources.has(id)
        ? metadataRefreshSince(db, device, label)
        : null;
      const metadataSessionPrefixes = incrementalRefresh && db && id === 'codex'
        ? codexUnknownSessionPrefixes(db, device)
        : [];
      const storedResponse = id === 'workbuddy' && db ? db.prepare(`
        SELECT model, input_tokens AS inputTokens, output_tokens AS outputTokens,
          cache_read_tokens AS cacheReadTokens, cache_creation_tokens AS cacheCreationTokens,
          reasoning_tokens AS reasoningTokens
        FROM token_events WHERE event_id = ? AND device = ? AND source = ?
      `) : null;
      const collectorOptions = {
        changedAfterMs, metadataSessionPrefixes,
        getStoredResponse: storedResponse ? eventId => {
          const row = storedResponse.get(eventId, device, label);
          return row ? { model: row.model, tokens: eventTokens(row) } : null;
        } : undefined
      };
      if (typeof collectorModule.collectWithAudit === 'function') {
        const result = await collectorModule.collectWithAudit(pricingData, collectorOptions);
        audit = normalizeAuditSummary(result.audit);
        ({ graphJson = {}, modelsJson = {}, tokenEvents = [], reconciliation = null } = result);
      } else if (typeof collectorModule.collect === 'function') {
        if (typeof collectorModule.audit === 'function') {
          audit = normalizeAuditSummary(await collectorModule.audit());
        }
        ({ graphJson = {}, modelsJson = {}, tokenEvents = [], reconciliation = null } = await collectorModule.collect(pricingData, collectorOptions));
      } else {
        throw new Error(`Collector ${id} does not export collect()`);
      }
    } catch (error) {
      sourceSummary.status = 'error';
      sourceSummary.message = error.message;
      addAuditToSource(sourceSummary, audit);
      addCoverageReconciliation(sourceSummary, [], [], []);
      addSummary(summary, sourceSummary);
      payloads.push({ type: 'error', sourceSummary, label, module, message: error.message });
      continue;
    }

    const dailyRows = normalizeDailyRows(graphJson, device);
    const sessionRows = normalizeSessionRows(modelsJson, device);
    const eventRows = normalizeTokenEventRows(tokenEvents, device, collectedAt);
    sourceSummary.dailyRows = dailyRows.length;
    sourceSummary.sessionRows = sessionRows.length;
    sourceSummary.tokenEvents = eventRows.length;
    sourceSummary.status = dailyRows.length || sessionRows.length || eventRows.length ? 'ok' : 'empty';
    sourceSummary.message = [
      `daily=${dailyRows.length}`,
      `sessions=${sessionRows.length}`,
      `token_events=${eventRows.length}`
    ].join(', ');
    addAuditToSource(sourceSummary, audit);
    addCoverageReconciliation(sourceSummary, dailyRows, sessionRows, eventRows);
    addSummary(summary, sourceSummary);

    for (const row of dailyRows) exportPayload.daily.push(row);
    for (const row of sessionRows) exportPayload.sessions.push(row);
    for (const row of eventRows) exportPayload.tokenEvents.push(row);

    payloads.push({
      type: 'data', device, source: label, sourceSummary, label, module,
      dailyRows, sessionRows, eventRows, reconciliation,
      // Buddy project/log records may rotate; merge their stable event IDs.
      incremental: incrementalRefresh || id === 'codebuddy' || id === 'workbuddy'
    });
  }

  const fatal = summary.sources.filter(source => source.fatalCoverageError);
  if (mode === 'apply' && fatal.length) {
    summary.ok = false;
    throw new Error(`Coverage gate blocked collection apply: ${fatal.map(source => `${source.id}:${source.coverageRisk}`).join(', ')}`);
  }

  const needsStoredUsageRepair = mode === 'apply' && db && usageTotalsNeedRepair(db);
  const needsCodexAccountingUpgrade = mode === 'apply' && db
    && payloads.some(payload => payload.type === 'data' && payload.sourceSummary.id === 'codex')
    && codexAccountingUpgradeNeeded(db);
  if (mode === 'apply' && db) {
    const hasClaudePlaceholders = !incrementalRefresh && payloads.some(payload => payload.type === 'data'
      && payload.sourceSummary.candidateFiles > 0
      && payload.sourceSummary.id === 'claude'
      && hasClaudeSyntheticPlaceholders(db, payload));
    const hasCodexMigration = payloads.some(payload => payload.type === 'data'
      && payload.sourceSummary.candidateFiles > 0
      && payload.sourceSummary.id === 'codex'
      && (codexSourceMigrationWouldChange(db, payload)
        || (!payload.incremental && hasOrphanedUnknownCodexSessions(db, payload.device))));
    const deletesStoredUsage = storedUsageWouldBeDeleted(db, payloads);
    const rebuildsEventUsage = payloads.some(payload =>
      workBuddyLegacyEventCopies(db, payload).length > 0
      || workBuddyEventModelsWouldChange(db, payload)
      || codeBuddyEventModelsWouldChange(db, payload)
    );
    const protectedMutation = needsStoredUsageRepair
      || (needsCodexAccountingUpgrade && codexAccountingUpgradeChangesUsage(db))
      || hasClaudePlaceholders
      || hasCodexMigration || deletesStoredUsage || rebuildsEventUsage;
    const shouldBackup = protectedMutation || tokenUsageWouldChange(db, payloads);
    summary.backup = shouldBackup
      ? createSqliteBackup(db, dbPath, scheduled
          ? protectedMutation
            ? { reason: 'scheduled-collect-repair' }
            : { reason: 'scheduled-collect', minimumIntervalMs: SCHEDULED_BACKUP_INTERVAL_MS }
          : { reason: 'collect' })
      : null;
  }

  if (mode === 'apply' && db) {
    if (needsCodexAccountingUpgrade) {
      runInTransaction(db, () => repairCodexReasoningAccounting(db, pricingData));
    }
    for (const payload of payloads) {
      if (!incrementalRefresh && payload.type === 'data'
        && payload.sourceSummary.candidateFiles > 0 && payload.sourceSummary.id === 'claude') {
        removeClaudeSyntheticPlaceholders(db, payload);
      }
      if (payload.type === 'data' && payload.sourceSummary.candidateFiles > 0
        && payload.sourceSummary.id === 'codex') {
        runInTransaction(db, () => {
          migrateLegacyCodexClientSources(db, payload);
          if (!payload.incremental) removeOrphanedUnknownCodexSessions(db, payload.device);
        });
      }
    }
    for (const payload of payloads) {
      if (payload.type !== 'error') mergeHistoricalEventUsage(db, payload, pricingData);
    }
  }

  if (needsStoredUsageRepair) {
    runInTransaction(db, () => repairUsageTotals(db));
  }

  for (const payload of payloads) {
    if (mode === 'apply') {
      if (payload.type === 'error') {
        const run = runRecord({
          device,
          label: payload.label,
          status: 'error',
          message: payload.message,
          collectedAt,
          module: payload.module
        });
        recordCollectionRun(db, run, scheduled);
        exportPayload.runs.push(run);
        continue;
      }
      const { sourceSummary, label, module, dailyRows, sessionRows, eventRows } = payload;
      const run = runRecord({
        device,
        label,
        status: sourceSummary.status,
        message: `${sourceSummary.message}; candidate_files=${sourceSummary.candidateFiles}; usable_records=${sourceSummary.usableTokenRecords}; skipped_no_token=${sourceSummary.skippedNoTokenRecords}; skipped_unresolved_model=${sourceSummary.skippedUnresolvedModel}; skipped_unsafe=${sourceSummary.skippedConversationLikeRecords}`,
        collectedAt,
        module
      });
      runInTransaction(db, () => {
        const removedWorkBuddyEvents = removeWorkBuddyLegacyEventCopies(db, payload);
        const rebuildWorkBuddy = removedWorkBuddyEvents > 0 || workBuddyEventModelsWouldChange(db, payload);
        const rebuildCodeBuddy = codeBuddyEventModelsWouldChange(db, payload);
        applyEventReconciliation(db, payload);
        dailyRows.forEach(row => upsertDaily(db, row));
        sessionRows.forEach(row => upsertSession(db, row));
        const deleteLegacyEvent = db.prepare(`
          DELETE FROM token_events
          WHERE event_id = ? AND device = ? AND source = ?
        `);
        for (const row of eventRows) {
          for (const legacyEventId of row.legacyEventIds) {
            deleteLegacyEvent.run(legacyEventId, row.device, row.source);
          }
          upsertTokenEvent(db, row);
        }
        if (rebuildWorkBuddy || rebuildCodeBuddy) {
          rebuildNativeEventUsage(db, payload, pricingData);
        }
        recordCollectionRun(db, run, scheduled);
        if (needsCodexAccountingUpgrade && sourceSummary.id === 'codex'
          && sourceSummary.candidateFiles > 0) {
          db.exec(`PRAGMA user_version = ${CODEX_ACCOUNTING_VERSION}`);
        }
      });
      exportPayload.runs.push(run);
    }
  }
}

function codexAccountingUpgradeNeeded(db) {
  return codexAccountingVersion(db) < CODEX_ACCOUNTING_VERSION;
}

function codexAccountingUpgradeChangesUsage(db) {
  const version = codexAccountingVersion(db);
  return version < CODEX_NATIVE_REASONING_VERSION && hasReasoningEvents(db, "event_id LIKE 'codex:%'")
    || version < CODEX_CCUSAGE_REASONING_VERSION
      && hasReasoningEvents(db, "event_id LIKE 'ccusage:%' AND source = 'Codex'")
    || version < CODEX_CLASSIFIED_CCUSAGE_REASONING_VERSION
      && hasReasoningEvents(db, `event_id LIKE 'ccusage:%'
        AND source IN ('Codex CLI', 'Codex Desktop', 'Codex (unidentified client)', 'codex')`);
}

function repairCodexReasoningAccounting(db, pricingData) {
  const version = codexAccountingVersion(db);
  const events = [];
  if (version < CODEX_NATIVE_REASONING_VERSION) {
    events.push(...reasoningEvents(db, "event_id LIKE 'codex:%'"));
  }
  if (version < CODEX_CCUSAGE_REASONING_VERSION) {
    events.push(...reasoningEvents(db, "event_id LIKE 'ccusage:%' AND source = 'Codex'"));
  }
  if (version < CODEX_CLASSIFIED_CCUSAGE_REASONING_VERSION) {
    events.push(...reasoningEvents(db, `event_id LIKE 'ccusage:%'
      AND source IN ('Codex CLI', 'Codex Desktop', 'Codex (unidentified client)', 'codex')`));
  }
  const daily = new Map();
  const sessions = new Map();
  for (const row of events) {
    const correction = Number(row.correction || 0);
    if (!correction) continue;
    const cost = calculateCost(row.model, { reasoning: correction }, pricingData);
    addCorrection(daily, [row.device, row.source, row.usageDate, row.model], correction, cost);
    addCorrection(sessions, [row.device, row.source, row.sessionId], correction, cost);
  }

  const updateEvent = db.prepare(`
    UPDATE token_events
    SET output_tokens = MAX(0, output_tokens - reasoning_tokens), updated_at = datetime('now')
    WHERE event_id = ?
  `);
  for (const row of events) updateEvent.run(row.eventId);

  const updateDaily = db.prepare(`
    UPDATE daily_usage
    SET output_tokens = MAX(0, output_tokens - ?),
      total_tokens = MAX(0, total_tokens - ?), cost_usd = MAX(0, cost_usd - ?),
      updated_at = datetime('now')
    WHERE device = ? AND source = ? AND usage_date = ? AND model = ?
  `);
  for (const row of daily.values()) {
    updateDaily.run(row.tokens, row.tokens, row.cost, ...row.key);
  }

  const updateSession = db.prepare(`
    UPDATE session_usage
    SET output_tokens = MAX(0, output_tokens - ?),
      total_tokens = MAX(0, total_tokens - ?), cost_usd = MAX(0, cost_usd - ?),
      updated_at = datetime('now')
    WHERE device = ? AND source = ? AND session_id = ?
  `);
  for (const row of sessions.values()) {
    updateSession.run(row.tokens, row.tokens, row.cost, ...row.key);
  }
  db.exec(`PRAGMA user_version = ${CODEX_CLASSIFIED_CCUSAGE_REASONING_VERSION}`);
}

function codexAccountingVersion(db) {
  return Number(db.prepare('PRAGMA user_version').get()?.user_version || 0);
}

function hasReasoningEvents(db, where) {
  return Boolean(db.prepare(`SELECT 1 FROM token_events WHERE ${where} AND reasoning_tokens > 0 LIMIT 1`).get());
}

function reasoningEvents(db, where) {
  return db.prepare(`
    SELECT event_id AS eventId, device, source, session_id AS sessionId,
      date(timestamp, '+8 hours') AS usageDate, model,
      MIN(output_tokens, reasoning_tokens) AS correction
    FROM token_events
    WHERE ${where} AND reasoning_tokens > 0
  `).all();
}

function addCorrection(target, key, tokens, cost) {
  const id = JSON.stringify(key);
  const row = target.get(id) || { key, tokens: 0, cost: 0 };
  row.tokens += tokens;
  row.cost += cost;
  target.set(id, row);
}

function storedUsageWouldBeDeleted(db, payloads) {
  const legacyEvent = db.prepare(`
    SELECT 1 FROM token_events
    WHERE event_id = ? AND device = ? AND source = ?
  `);
  for (const payload of payloads) {
    if (payload.type === 'error') continue;
    for (const source of payloadSources(payload)) {
      const plan = eventReconciliationPlan(db, payload, source);
      if (plan.prefixes.length || plan.replaceManagedEvents) return true;
    }
    for (const row of payload.eventRows) {
      if (row.legacyEventIds.some(eventId => legacyEvent.get(eventId, row.device, row.source))) return true;
    }
  }
  return false;
}

function workBuddyLegacyEventCopies(db, payload) {
  if (payload.type !== 'data' || payload.sourceSummary.id !== 'workbuddy') return [];

  const expectedByFingerprint = new Map();
  for (const row of payload.eventRows) {
    const fingerprint = workBuddyEventFingerprint(row);
    const expected = expectedByFingerprint.get(fingerprint) || new Set();
    expected.add(row.eventId);
    expectedByFingerprint.set(fingerprint, expected);
  }
  if (!expectedByFingerprint.size) return [];

  const legacyRows = db.prepare(`
    SELECT event_id AS eventId, timestamp,
      input_tokens AS inputTokens, output_tokens AS outputTokens,
      cache_read_tokens AS cacheReadTokens, cache_creation_tokens AS cacheCreationTokens,
      reasoning_tokens AS reasoningTokens
    FROM token_events
    WHERE device = ? AND source = ?
      AND event_id LIKE 'workbuddy:%'
      AND session_id NOT GLOB 'workbuddy:trace_*'
  `).all(payload.device, payload.label);

  return legacyRows
    .filter(row => expectedByFingerprint.has(workBuddyEventFingerprint(row)))
    .filter(row => !expectedByFingerprint.get(workBuddyEventFingerprint(row)).has(row.eventId))
    .map(row => row.eventId);
}

function workBuddyEventModelsWouldChange(db, payload) {
  if (payload.type !== 'data' || payload.sourceSummary.id !== 'workbuddy') return false;
  const existing = db.prepare(`
    SELECT model, session_id AS sessionId FROM token_events
    WHERE event_id = ? AND device = ? AND source = ?
    LIMIT 1
  `);
  return payload.eventRows.some(row => {
    const stored = existing.get(row.eventId, row.device, row.source);
    return (stored && (stored.model !== row.model || stored.sessionId !== row.sessionId))
      || row.legacyEventIds.some(id => existing.get(id, row.device, row.source));
  });
}

function codeBuddyEventModelsWouldChange(db, payload) {
  if (payload.type !== 'data' || payload.sourceSummary.id !== 'codebuddy') return false;
  const existing = db.prepare(`
    SELECT model FROM token_events
    WHERE event_id = ? AND device = ? AND source = ?
    LIMIT 1
  `);
  return payload.eventRows.some(row => {
    const stored = existing.get(row.eventId, row.device, row.source);
    return stored && stored.model !== row.model;
  });
}

function workBuddyEventFingerprint(row) {
  return JSON.stringify([
    row.timestamp,
    Number(row.inputTokens || 0),
    Number(row.outputTokens || 0),
    Number(row.cacheReadTokens || 0),
    Number(row.cacheCreationTokens || 0),
    Number(row.reasoningTokens || 0)
  ]);
}

function removeWorkBuddyLegacyEventCopies(db, payload) {
  const eventIds = workBuddyLegacyEventCopies(db, payload);
  if (!eventIds.length) return 0;
  const remove = db.prepare(`
    DELETE FROM token_events
    WHERE event_id = ? AND device = ? AND source = ?
  `);
  for (const eventId of eventIds) {
    remove.run(eventId, payload.device, payload.label);
  }
  return eventIds.length;
}

function rebuildNativeEventUsage(db, payload, pricingData) {
  const source = payload.label;
  const dailyRows = db.prepare(`
    SELECT date(timestamp, '+8 hours') AS usageDate, model,
      COALESCE(SUM(input_tokens), 0) AS inputTokens,
      COALESCE(SUM(output_tokens), 0) AS outputTokens,
      COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
      COALESCE(SUM(cache_creation_tokens), 0) AS cacheCreationTokens,
      COALESCE(SUM(reasoning_tokens), 0) AS reasoningOutputTokens
    FROM token_events
    WHERE device = ? AND source = ?
    GROUP BY usageDate, model
  `).all(payload.device, source);
  db.prepare('DELETE FROM daily_usage WHERE device = ? AND source = ?').run(payload.device, source);
  for (const row of dailyRows) {
    const tokens = eventTokens(row);
    const daily = usageRow({
      device: payload.device, source, usageDate: row.usageDate, model: row.model || ''
    });
    addUsage(daily, tokens, calculateCost(row.model || '', tokens, pricingData));
    upsertDaily(db, daily);
  }

  const sessionRows = db.prepare(`
    SELECT session_id AS sessionId, model, MAX(timestamp) AS lastActivity,
      COALESCE(SUM(input_tokens), 0) AS inputTokens,
      COALESCE(SUM(output_tokens), 0) AS outputTokens,
      COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
      COALESCE(SUM(cache_creation_tokens), 0) AS cacheCreationTokens,
      COALESCE(SUM(reasoning_tokens), 0) AS reasoningOutputTokens
    FROM token_events
    WHERE device = ? AND source = ?
    GROUP BY session_id, model
  `).all(payload.device, source);
  const latestModel = db.prepare(`
    SELECT model FROM token_events
    WHERE device = ? AND source = ? AND session_id = ?
    ORDER BY timestamp DESC, event_id DESC
    LIMIT 1
  `);
  db.prepare(`
    UPDATE session_usage
    SET input_tokens = 0, output_tokens = 0, cache_creation_tokens = 0,
      cache_read_tokens = 0, cached_input_tokens = 0, reasoning_output_tokens = 0,
      total_tokens = 0, cost_usd = 0, updated_at = datetime('now')
    WHERE device = ? AND source = ?
  `).run(payload.device, source);
  const sessions = new Map();
  for (const row of sessionRows) {
    const model = latestModel.get(payload.device, source, row.sessionId)?.model || '';
    const tokens = eventTokens(row);
    const session = sessions.get(row.sessionId) || usageRow({
      device: payload.device, source, sessionId: row.sessionId,
      lastActivity: row.lastActivity, projectPath: null, model
    });
    addUsage(session, tokens, calculateCost(row.model, tokens, pricingData));
    if (row.lastActivity > session.lastActivity) session.lastActivity = row.lastActivity;
    sessions.set(row.sessionId, session);
  }
  for (const session of sessions.values()) upsertSession(db, session);
  db.prepare(`
    DELETE FROM session_usage
    WHERE device = ? AND source = ?
      AND NOT EXISTS (
        SELECT 1 FROM token_events AS event
        WHERE event.device = session_usage.device
          AND event.source = session_usage.source
          AND event.session_id = session_usage.session_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM session_annotations AS annotation
        WHERE annotation.device = session_usage.device
          AND annotation.source = session_usage.source
          AND annotation.session_id = session_usage.session_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM session_outputs AS output
        WHERE output.device = session_usage.device
          AND output.source = session_usage.source
          AND output.session_id = session_usage.session_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM work_item_sessions AS link
        WHERE link.device = session_usage.device AND link.source = session_usage.source
          AND link.session_id = session_usage.session_id
      )
  `).run(payload.device, source);
}

function hasClaudeSyntheticPlaceholders(db, payload) {
  const source = payload.label;
  return Boolean(db.prepare(`
    SELECT 1 FROM token_events
    WHERE device = ? AND source = ?
      AND (model = '<synthetic>' OR instr(session_id, '<synthetic>') > 0)
      AND input_tokens = 0 AND output_tokens = 0
      AND cache_read_tokens = 0 AND cache_creation_tokens = 0 AND reasoning_tokens = 0
    UNION ALL
    SELECT 1 FROM daily_usage
    WHERE device = ? AND source = ? AND model = '<synthetic>'
      AND input_tokens = 0 AND output_tokens = 0
      AND cache_creation_tokens = 0 AND cache_read_tokens = 0
      AND cached_input_tokens = 0 AND reasoning_output_tokens = 0
      AND total_tokens = 0 AND cost_usd = 0
    UNION ALL
    SELECT 1 FROM session_usage AS session
    WHERE session.device = ? AND session.source = ?
      AND (session.model = '<synthetic>' OR instr(session.session_id, '<synthetic>') > 0)
      AND session.input_tokens = 0 AND session.output_tokens = 0
      AND session.cache_creation_tokens = 0 AND session.cache_read_tokens = 0
      AND session.cached_input_tokens = 0 AND session.reasoning_output_tokens = 0
      AND session.total_tokens = 0 AND session.cost_usd = 0
      AND NOT EXISTS (SELECT 1 FROM token_events AS event
        WHERE event.device = session.device AND event.source = session.source AND event.session_id = session.session_id)
      AND NOT EXISTS (SELECT 1 FROM session_annotations AS annotation
        WHERE annotation.device = session.device AND annotation.source = session.source AND annotation.session_id = session.session_id)
      AND NOT EXISTS (SELECT 1 FROM session_outputs AS output
        WHERE output.device = session.device AND output.source = session.source AND output.session_id = session.session_id)
      AND NOT EXISTS (SELECT 1 FROM work_item_sessions AS link
        WHERE link.device = session.device AND link.source = session.source AND link.session_id = session.session_id)
    LIMIT 1
  `).get(
    payload.device, source,
    payload.device, source,
    payload.device, source
  ));
}

function removeClaudeSyntheticPlaceholders(db, payload) {
  if (!hasClaudeSyntheticPlaceholders(db, payload)) return;
  const source = payload.label;
  runInTransaction(db, () => {
    db.prepare(`
      DELETE FROM token_events
      WHERE device = ? AND source = ?
        AND (model = '<synthetic>' OR instr(session_id, '<synthetic>') > 0)
        AND input_tokens = 0 AND output_tokens = 0
        AND cache_read_tokens = 0 AND cache_creation_tokens = 0 AND reasoning_tokens = 0
    `).run(payload.device, source);
    db.prepare(`
      DELETE FROM session_usage AS session
      WHERE session.device = ? AND session.source = ?
        AND (session.model = '<synthetic>' OR instr(session.session_id, '<synthetic>') > 0)
        AND session.input_tokens = 0 AND session.output_tokens = 0
        AND session.cache_creation_tokens = 0 AND session.cache_read_tokens = 0
        AND session.cached_input_tokens = 0 AND session.reasoning_output_tokens = 0
        AND session.total_tokens = 0 AND session.cost_usd = 0
        AND NOT EXISTS (SELECT 1 FROM token_events AS event
          WHERE event.device = session.device AND event.source = session.source AND event.session_id = session.session_id)
        AND NOT EXISTS (SELECT 1 FROM session_annotations AS annotation
          WHERE annotation.device = session.device AND annotation.source = session.source AND annotation.session_id = session.session_id)
        AND NOT EXISTS (SELECT 1 FROM session_outputs AS output
          WHERE output.device = session.device AND output.source = session.source AND output.session_id = session.session_id)
        AND NOT EXISTS (SELECT 1 FROM work_item_sessions AS link
          WHERE link.device = session.device AND link.source = session.source AND link.session_id = session.session_id)
    `).run(payload.device, source);
    db.prepare(`
      DELETE FROM daily_usage
      WHERE device = ? AND source = ? AND model = '<synthetic>'
        AND input_tokens = 0 AND output_tokens = 0
        AND cache_creation_tokens = 0 AND cache_read_tokens = 0
        AND cached_input_tokens = 0 AND reasoning_output_tokens = 0
        AND total_tokens = 0 AND cost_usd = 0
    `).run(payload.device, source);
  });
}

function tokenUsageWouldChange(db, payloads) {
  const matchingDaily = db.prepare(`
    SELECT 1
    FROM daily_usage
    WHERE device = ? AND source = ? AND usage_date = ? AND model = ?
      AND input_tokens = ? AND output_tokens = ?
      AND cache_creation_tokens = ? AND cache_read_tokens = ?
      AND cached_input_tokens = ?
      AND reasoning_output_tokens = ? AND total_tokens = ? AND cost_usd = ?
  `);
  const matchingSession = db.prepare(`
    SELECT 1
    FROM session_usage
    WHERE device = ? AND source = ? AND session_id = ?
      AND last_activity IS COALESCE(?, last_activity)
      AND project_path IS COALESCE(?, project_path)
      AND model = CASE WHEN ? != '' THEN ? ELSE model END
      AND input_tokens = ? AND output_tokens = ?
      AND cache_creation_tokens = ? AND cache_read_tokens = ?
      AND cached_input_tokens = ?
      AND reasoning_output_tokens = ? AND total_tokens = ? AND cost_usd = ?
  `);
  const matchingEvent = db.prepare(`
    SELECT 1
    FROM token_events
    WHERE event_id = ? AND device = ? AND source = ? AND session_id = ? AND timestamp = ? AND model = ?
      AND input_tokens = ? AND output_tokens = ?
      AND cache_read_tokens = ? AND cache_creation_tokens = ? AND reasoning_tokens = ?
      AND tool_category IS ? AND file_extension IS ? AND repo_path_hash IS ? AND privacy_level = ?
    LIMIT 1
  `);
  const legacyEvent = db.prepare(`
    SELECT 1 FROM token_events
    WHERE event_id = ? AND device = ? AND source = ?
  `);
  for (const payload of payloads) {
    if (payload.type === 'error') continue;
    for (const source of payloadSources(payload)) {
      const reconciliationPlan = eventReconciliationPlan(db, payload, source);
      if (
        reconciliationPlan.prefixes.length > 0 ||
        reconciliationPlan.replaceManagedEvents
      ) return true;
    }
    for (const row of payload.dailyRows) {
      if (!matchingDaily.get(
        row.device, row.source, row.usageDate, row.model,
        row.inputTokens, row.outputTokens, row.cacheCreationTokens,
        row.cacheReadTokens, row.cachedInputTokens || 0, row.reasoningOutputTokens, row.totalTokens, row.costUSD
      )) return true;
    }
    for (const row of payload.sessionRows) {
      if (!matchingSession.get(
        row.device, row.source, row.sessionId, row.lastActivity, row.projectPath, row.model, row.model,
        row.inputTokens, row.outputTokens, row.cacheCreationTokens,
        row.cacheReadTokens, row.cachedInputTokens || 0, row.reasoningOutputTokens, row.totalTokens, row.costUSD
      )) return true;
    }
    for (const row of payload.eventRows) {
      if (row.legacyEventIds.some(eventId => legacyEvent.get(eventId, row.device, row.source))) return true;
      if (!matchingEvent.get(
        row.eventId, row.device, row.source, row.sessionId, row.timestamp, row.model,
        row.inputTokens, row.outputTokens, row.cacheReadTokens,
        row.cacheCreationTokens, row.reasoningTokens,
        row.toolCategory || null, row.fileExtension || null, row.repoPathHash || null, row.privacyLevel || 'safe'
      )) return true;
    }
  }
  return false;
}

function migrateLegacyCodexClientSources(db, payload) {
  const eventSources = new Map(payload.eventRows
    .filter(row => row.sessionId.startsWith('local:codex:'))
    .map(row => [row.eventId, row.source]));
  const sessionSources = new Map();
  for (const row of payload.sessionRows) {
    if (row.sessionId.startsWith('local:codex:')) sessionSources.set(row.sessionId, row.source);
  }
  const metadataSourcePrefixes = new Map((payload.reconciliation?.sessionSourcePrefixes || [])
    .filter(item => item && item.prefix && item.source && item.source !== UNKNOWN_CODEX_SOURCE)
    .map(item => [item.prefix, item.source]));

  for (const oldSource of [LEGACY_CODEX_SOURCE, UNKNOWN_CODEX_SOURCE]) {
    migrateCodexSource(db, payload, oldSource, eventSources, sessionSources, metadataSourcePrefixes, payload.incremental);
  }
  db.prepare(`
    UPDATE collection_runs
    SET source = 'Codex'
    WHERE device = ? AND source = ?
  `).run(payload.device, LEGACY_CODEX_SOURCE);
  db.prepare(`
    UPDATE budget_profiles
    SET source = 'Codex'
    WHERE source = ?
  `).run(LEGACY_CODEX_SOURCE);
}

function hasOrphanedUnknownCodexSessions(db, device) {
  return Boolean(db.prepare(`
    SELECT 1
    FROM session_usage AS session
    WHERE session.device = ? AND session.source LIKE 'Codex%' AND session.model = 'unknown'
      AND session.input_tokens = 0 AND session.output_tokens = 0
      AND session.cache_creation_tokens = 0 AND session.cache_read_tokens = 0
      AND session.cached_input_tokens = 0 AND session.reasoning_output_tokens = 0
      AND session.total_tokens = 0 AND session.cost_usd = 0
      AND NOT EXISTS (SELECT 1 FROM token_events AS event
        WHERE event.device = session.device AND event.source = session.source AND event.session_id = session.session_id)
      AND NOT EXISTS (SELECT 1 FROM session_annotations AS annotation
        WHERE annotation.device = session.device AND annotation.source = session.source AND annotation.session_id = session.session_id)
      AND NOT EXISTS (SELECT 1 FROM session_outputs AS output
        WHERE output.device = session.device AND output.source = session.source AND output.session_id = session.session_id)
      AND NOT EXISTS (SELECT 1 FROM work_item_sessions AS link
        WHERE link.device = session.device AND link.source = session.source AND link.session_id = session.session_id)
    LIMIT 1
  `).get(device));
}

function removeOrphanedUnknownCodexSessions(db, device) {
  db.prepare(`
    DELETE FROM session_usage AS session
    WHERE session.device = ? AND session.source LIKE 'Codex%' AND session.model = 'unknown'
      AND session.input_tokens = 0 AND session.output_tokens = 0
      AND session.cache_creation_tokens = 0 AND session.cache_read_tokens = 0
      AND session.cached_input_tokens = 0 AND session.reasoning_output_tokens = 0
      AND session.total_tokens = 0 AND session.cost_usd = 0
      AND NOT EXISTS (SELECT 1 FROM token_events AS event
        WHERE event.device = session.device AND event.source = session.source AND event.session_id = session.session_id)
      AND NOT EXISTS (SELECT 1 FROM session_annotations AS annotation
        WHERE annotation.device = session.device AND annotation.source = session.source AND annotation.session_id = session.session_id)
      AND NOT EXISTS (SELECT 1 FROM session_outputs AS output
        WHERE output.device = session.device AND output.source = session.source AND output.session_id = session.session_id)
      AND NOT EXISTS (SELECT 1 FROM work_item_sessions AS link
        WHERE link.device = session.device AND link.source = session.source AND link.session_id = session.session_id)
  `).run(device);
}

function codexSourceMigrationWouldChange(db, payload) {
  const eventSources = new Map(payload.eventRows
    .filter(row => row.sessionId.startsWith('local:codex:'))
    .map(row => [row.eventId, row.source]));
  const sessionSources = new Map(payload.sessionRows
    .filter(row => row.sessionId.startsWith('local:codex:'))
    .map(row => [row.sessionId, row.source]));
  const prefixes = (payload.reconciliation?.sessionSourcePrefixes || [])
    .filter(item => item && item.prefix && item.source && item.source !== UNKNOWN_CODEX_SOURCE);
  const metadataSourcePrefixes = new Map(prefixes.map(item => [item.prefix, item.source]));
  const events = db.prepare(`
    SELECT event_id AS eventId, session_id AS sessionId, source
    FROM token_events
    WHERE device = ? AND source IN (?, ?) AND session_id LIKE 'local:codex:%'
  `).all(payload.device, LEGACY_CODEX_SOURCE, UNKNOWN_CODEX_SOURCE);
  if (events.some((row) => {
    const fallback = payload.incremental
      ? row.source
      : row.source === LEGACY_CODEX_SOURCE ? UNKNOWN_CODEX_SOURCE : row.source;
    return codexSourceForSession(row.sessionId, eventSources.get(row.eventId), metadataSourcePrefixes, fallback) !== row.source;
  })) return true;

  const sessions = db.prepare(`
    SELECT session_id AS sessionId, source
    FROM session_usage
    WHERE device = ? AND source IN (?, ?) AND session_id LIKE 'local:codex:%'
  `).all(payload.device, LEGACY_CODEX_SOURCE, UNKNOWN_CODEX_SOURCE);
  if (sessions.some((row) => {
    const fallback = payload.incremental
      ? row.source
      : row.source === LEGACY_CODEX_SOURCE ? UNKNOWN_CODEX_SOURCE : row.source;
    return codexSourceForSession(row.sessionId, sessionSources.get(row.sessionId), metadataSourcePrefixes, fallback) !== row.source;
  })) return true;

  if (payload.incremental) return false;

  const currentLegacyDaily = new Set(payload.dailyRows
    .filter(row => row.source === LEGACY_CODEX_SOURCE)
    .map(row => dailyUsageKey(LEGACY_CODEX_SOURCE, row.usageDate, row.model)));
  return db.prepare(`
    SELECT usage_date AS usageDate, model
    FROM daily_usage
    WHERE device = ? AND source = ?
  `).all(payload.device, LEGACY_CODEX_SOURCE)
    .some(row => !currentLegacyDaily.has(dailyUsageKey(LEGACY_CODEX_SOURCE, row.usageDate, row.model)));
}

function migrateCodexSource(db, payload, oldSource, eventSources, sessionSources, metadataSourcePrefixes, incremental = false) {
  const fallbackSource = incremental
    ? oldSource
    : oldSource === LEGACY_CODEX_SOURCE ? UNKNOWN_CODEX_SOURCE : oldSource;
  const legacyEvents = db.prepare(`
    SELECT event_id AS eventId, session_id AS sessionId,
      date(timestamp, '+8 hours') AS usageDate, model,
      input_tokens AS inputTokens, output_tokens AS outputTokens,
      cache_creation_tokens AS cacheCreationTokens,
      cache_read_tokens AS cacheReadTokens,
      reasoning_tokens AS reasoningOutputTokens
    FROM token_events
    WHERE device = ? AND source = ? AND session_id LIKE 'local:codex:%'
  `).all(payload.device, oldSource);

  const classifiedDaily = new Map();
  for (const event of legacyEvents) {
    const source = codexSourceForSession(event.sessionId, eventSources.get(event.eventId), metadataSourcePrefixes, fallbackSource);
    if (source === oldSource) continue;
    const key = dailyUsageKey(oldSource, event.usageDate, event.model);
    const totals = classifiedDaily.get(key) || emptyUsage();
    addUsage(totals, eventTokens(event), 0);
    classifiedDaily.set(key, totals);
  }

  if ((!incremental && oldSource === LEGACY_CODEX_SOURCE) || classifiedDaily.size) {
    migrateLegacyCodexDailyUsage(db, payload, oldSource, classifiedDaily, incremental);
  }
  for (const row of db.prepare(`
    SELECT session_id AS sessionId
    FROM session_usage
    WHERE device = ? AND source = ? AND session_id LIKE 'local:codex:%'
  `).all(payload.device, oldSource)) {
    const source = codexSourceForSession(row.sessionId, sessionSources.get(row.sessionId), metadataSourcePrefixes, fallbackSource);
    moveSessionSource(db, payload.device, oldSource, row.sessionId, source);
  }

  const updateEventSource = db.prepare(`
    UPDATE token_events
    SET source = ?
    WHERE event_id = ? AND device = ? AND source = ?
  `);
  for (const event of legacyEvents) {
    const source = codexSourceForSession(event.sessionId, eventSources.get(event.eventId), metadataSourcePrefixes, fallbackSource);
    if (source !== oldSource) updateEventSource.run(source, event.eventId, payload.device, oldSource);
  }
}

function codexSourceForSession(sessionId, eventSource, metadataSourcePrefixes, fallbackSource) {
  if (eventSource) return eventSource;
  for (const [prefix, source] of metadataSourcePrefixes) {
    if (sessionId.startsWith(prefix)) return source;
  }
  return fallbackSource;
}

function migrateLegacyCodexDailyUsage(db, payload, oldSource, classifiedDaily, incremental = false) {
  const rows = db.prepare(`
    SELECT usage_date AS usageDate, model,
      input_tokens AS inputTokens, output_tokens AS outputTokens,
      cache_creation_tokens AS cacheCreationTokens,
      cache_read_tokens AS cacheReadTokens,
      cached_input_tokens AS cachedInputTokens,
      reasoning_output_tokens AS reasoningOutputTokens,
      total_tokens AS totalTokens, cost_usd AS costUSD
    FROM daily_usage
    WHERE device = ? AND source = ?
  `).all(payload.device, oldSource);
  const deleteDaily = db.prepare(`
    DELETE FROM daily_usage
    WHERE device = ? AND source = ? AND usage_date = ? AND model = ?
  `);
  const currentDaily = new Map();
  const currentCosts = new Map();
  for (const row of payload.dailyRows) {
    const key = dailyUsageKey(oldSource, row.usageDate, row.model);
    const cost = currentCosts.get(key) || 0;
    currentCosts.set(key, cost + Number(row.costUSD || 0));
    if (row.source === oldSource) {
      const totals = currentDaily.get(key) || emptyUsage();
      addUsage(totals, eventTokens(row), row.costUSD);
      currentDaily.set(key, totals);
    }
  }
  for (const row of rows) {
    const key = dailyUsageKey(oldSource, row.usageDate, row.model);
    if (incremental && !classifiedDaily.has(key)) continue;
    const classified = classifiedDaily.get(key) || emptyUsage();
    const current = currentDaily.get(key) || emptyUsage();
    if (!hasUsage(classified) && hasUsage(current)) continue;
    const remaining = subtractUsage(row, classified, currentCosts.get(key) || 0);
    deleteDaily.run(payload.device, oldSource, row.usageDate, row.model);
    if (hasUsage(remaining)) {
      appendDailyUsage(payload.dailyRows, {
        device: payload.device,
        source: incremental ? oldSource : oldSource === LEGACY_CODEX_SOURCE ? UNKNOWN_CODEX_SOURCE : oldSource,
        usageDate: row.usageDate,
        model: row.model,
        ...remaining
      });
    }
  }
}

function moveSessionSource(db, device, oldSource, sessionId, source) {
  if (source === oldSource) return;
  db.prepare(`
    INSERT OR IGNORE INTO session_usage (
      device, source, session_id, last_activity, project_path, model,
      input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
      cached_input_tokens, reasoning_output_tokens, total_tokens, cost_usd, updated_at
    )
    SELECT device, ?, session_id, last_activity, project_path, model,
      input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
      cached_input_tokens, reasoning_output_tokens, total_tokens, cost_usd, updated_at
    FROM session_usage
    WHERE device = ? AND source = ? AND session_id = ?
  `).run(source, device, oldSource, sessionId);
  for (const table of ['session_annotations', 'session_outputs']) {
    db.prepare(`
      DELETE FROM ${table}
      WHERE device = ? AND source = ? AND session_id = ?
        AND EXISTS (SELECT 1 FROM ${table} AS current WHERE current.device = ? AND current.source = ? AND current.session_id = ?)
    `).run(device, oldSource, sessionId, device, source, sessionId);
    db.prepare(`
      UPDATE ${table}
      SET source = ?
      WHERE device = ? AND source = ? AND session_id = ?
    `).run(source, device, oldSource, sessionId);
  }
  db.prepare(`
    DELETE FROM work_item_sessions
    WHERE device = ? AND source = ? AND session_id = ?
      AND EXISTS (
        SELECT 1 FROM work_item_sessions AS current
        WHERE current.work_item_id = work_item_sessions.work_item_id
          AND current.device = ? AND current.source = ? AND current.session_id = ?
      )
  `).run(device, oldSource, sessionId, device, source, sessionId);
  db.prepare(`
    UPDATE work_item_sessions
    SET source = ?
    WHERE device = ? AND source = ? AND session_id = ?
  `).run(source, device, oldSource, sessionId);
  db.prepare(`
    DELETE FROM session_usage
    WHERE device = ? AND source = ? AND session_id = ?
  `).run(device, oldSource, sessionId);
}

function emptyUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    costUSD: 0
  };
}

function subtractUsage(row, classified, currentCostUSD) {
  const remaining = emptyUsage();
  for (const field of [
    'inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens',
    'cachedInputTokens', 'reasoningOutputTokens', 'totalTokens'
  ]) {
    remaining[field] = Math.max(0, Number(row[field] || 0) - Number(classified[field] || 0));
  }
  remaining.costUSD = Math.max(0, Number(row.costUSD || 0) - Number(currentCostUSD || 0));
  return remaining;
}

function hasUsage(row) {
  return row.inputTokens || row.outputTokens || row.cacheCreationTokens || row.cacheReadTokens
    || row.cachedInputTokens || row.reasoningOutputTokens || row.totalTokens || row.costUSD;
}

function appendDailyUsage(rows, addition) {
  const existing = rows.find(row =>
    row.source === addition.source
    && row.usageDate === addition.usageDate
    && row.model === addition.model
  );
  if (!existing) {
    rows.push(addition);
    return;
  }
  for (const field of [
    'inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens',
    'cachedInputTokens', 'reasoningOutputTokens', 'totalTokens', 'costUSD'
  ]) {
    existing[field] = Number(existing[field] || 0) + Number(addition[field] || 0);
  }
}

function applyEventReconciliation(db, payload) {
  const plans = payloadSources(payload)
    .map(source => ({ source, plan: eventReconciliationPlan(db, payload, source) }))
    .filter(({ plan }) => plan.prefixes.length || plan.replaceManagedEvents);
  if (!plans.length) return null;

  for (const { source, plan } of plans) {
    applyEventReconciliationPlan(db, payload, source, plan);
  }
  return plans;
}

function applyEventReconciliationPlan(db, payload, source, plan) {
  if (
    !plan.prefixes.length &&
    !plan.replaceManagedEvents
  ) return plan;

  const deleteEvents = db.prepare(`
    DELETE FROM token_events
    WHERE device = ? AND source = ? AND session_id LIKE ? ESCAPE '\\'
  `);
  const resetSessions = db.prepare(`
    UPDATE session_usage
    SET input_tokens = 0,
      output_tokens = 0,
      cache_creation_tokens = 0,
      cache_read_tokens = 0,
      cached_input_tokens = 0,
      reasoning_output_tokens = 0,
      total_tokens = 0,
      cost_usd = 0,
      updated_at = datetime('now')
    WHERE device = ? AND source = ? AND session_id LIKE ? ESCAPE '\\'
  `);
  const deleteDaily = db.prepare(`
    DELETE FROM daily_usage
    WHERE device = ? AND source = ? AND usage_date = ?
  `);

  if (plan.replaceManagedEvents) {
    for (const managedSession of plan.managedSessions) {
      deleteManagedEventsBySessionPrefix(
        db,
        payload,
        source,
        plan.managedEventIdPrefix,
        managedSession.sessionId,
        managedSession.exact
      );
      resetSessionsByPrefix(db, payload, source, managedSession.sessionId, managedSession.exact);
    }
  }
  for (const prefix of plan.prefixes) {
    const pattern = sqlLikePrefix(prefix);
    deleteEvents.run(payload.device, source, pattern);
    // Preserve annotations and output links while removing stale session totals.
    resetSessions.run(payload.device, source, pattern);
  }
  for (const date of plan.dates) {
    deleteDaily.run(payload.device, source, date);
  }
  return plan;
}

function eventReconciliationPlan(db, payload, source) {
  // Incremental collectors only read newly appended records. Missing rows are
  // therefore not evidence that stored history should be removed.
  if (payload.incremental && !payload.reconciliation?.reconcileIncrementally) {
    return {
      prefixes: [],
      dates: [],
      replaceManagedEvents: false
    };
  }
  const prefixes = normalizedEventSessionPrefixes(payload.reconciliation);
  const replayedForkPrefixes = normalizedEventSessionPrefixes({
    eventSessionPrefixes: payload.reconciliation?.replayedForkSessionPrefixes
  });
  const managedEventIdPrefix = normalizedReconciliationPrefix(payload.reconciliation?.managedEventIdPrefix);
  const managedEventSessionPrefixes = normalizedEventSessionPrefixes({
    eventSessionPrefixes: payload.reconciliation?.managedEventSessionPrefixes
  });
  const managedEventSessionIds = normalizedEventSessionIds(payload.reconciliation?.managedEventSessionIds);
  if (!prefixes.length && (!managedEventIdPrefix || (!managedEventSessionPrefixes.length && !managedEventSessionIds.length))) {
    return {
      prefixes: [],
      dates: [],
      replaceManagedEvents: false
    };
  }

  const eventRows = payload.eventRows.filter(row => row.source === source);
  const device = payload.device;
  const selectEvents = db.prepare(`
    SELECT event_id AS eventId, date(timestamp, '+8 hours') AS usageDate
    FROM token_events
    WHERE device = ? AND source = ? AND session_id LIKE ? ESCAPE '\\'
  `);
  const selectNonZeroSessions = db.prepare(`
    SELECT session_id AS sessionId
    FROM session_usage
    WHERE device = ? AND source = ? AND session_id LIKE ? ESCAPE '\\'
      AND total_tokens > 0
  `);
  const stalePrefixes = [];
  const dates = new Set();

  let replaceManagedEvents = false;
  const managedSessions = [
    ...managedEventSessionPrefixes.map(sessionId => ({ sessionId, exact: false })),
    ...managedEventSessionIds.map(sessionId => ({ sessionId, exact: true }))
  ];
  const staleManagedSessions = [];
  for (const managedSession of managedSessions) {
    const { sessionId, exact } = managedSession;
    const expectedIds = new Set(eventRows
      .filter(row => row.eventId.startsWith(managedEventIdPrefix)
        && (exact ? row.sessionId === sessionId : row.sessionId.startsWith(sessionId)))
      .map(row => row.eventId));
    const managedRows = db.prepare(exact ? `
      SELECT event_id AS eventId, date(timestamp, '+8 hours') AS usageDate
      FROM token_events
      WHERE device = ? AND source = ?
        AND event_id LIKE ? ESCAPE '\\'
        AND session_id = ?
    ` : `
      SELECT event_id AS eventId, date(timestamp, '+8 hours') AS usageDate
      FROM token_events
      WHERE device = ? AND source = ?
        AND event_id LIKE ? ESCAPE '\\'
        AND session_id LIKE ? ESCAPE '\\'
    `).all(
      device,
      source,
      sqlLikePrefix(managedEventIdPrefix),
      exact ? sessionId : sqlLikePrefix(sessionId)
    );
    if (managedRows.some(row => !expectedIds.has(row.eventId))) {
      replaceManagedEvents = true;
      staleManagedSessions.push(managedSession);
      for (const row of managedRows) {
        if (row.usageDate) dates.add(row.usageDate);
      }
    }
  }

  for (const prefix of prefixes) {
    const expectedIds = new Set(eventRows
      .filter(row => row.sessionId.startsWith(prefix))
      .map(row => row.eventId));
    const existing = selectEvents.all(device, source, sqlLikePrefix(prefix));
    if (!existing.some(row => !expectedIds.has(row.eventId))) continue;
    stalePrefixes.push(prefix);
    for (const row of existing) {
      if (row.usageDate) dates.add(row.usageDate);
    }
  }
  for (const prefix of replayedForkPrefixes) {
    if (stalePrefixes.includes(prefix)) continue;
    if (selectNonZeroSessions.all(device, source, sqlLikePrefix(prefix)).length > 0) {
      stalePrefixes.push(prefix);
    }
  }
  return {
    prefixes: stalePrefixes,
    dates: [...dates],
    replaceManagedEvents,
    managedEventIdPrefix,
    managedSessions: staleManagedSessions
  };
}

function mergeHistoricalEventUsage(db, payload, pricingData) {
  const sources = payload.sourceSummary.id === 'codex'
    ? [...new Set([
        ...payloadSources(payload),
        UNKNOWN_CODEX_SOURCE,
        ...(payload.reconciliation?.sessionSourcePrefixes || []).map(item => item.source)
      ])]
    : payloadSources(payload);
  for (const source of sources) {
    if (payload.incremental && ['codex', 'workbuddy', 'codebuddy'].includes(payload.sourceSummary.id)) {
      rebuildIncrementalEventUsage(db, payload, source, pricingData);
      continue;
    }
    mergeHistoricalEventUsageForSource(db, payload, source, pricingData);
  }
}

function refreshedEventIds(payload, source) {
  return JSON.stringify(payload.eventRows
    .filter(row => row.source === source)
    .flatMap(row => [row.eventId, ...row.legacyEventIds]));
}

function rebuildIncrementalEventUsage(db, payload, source, pricingData) {
  const eventIdPrefix = normalizedReconciliationPrefix(payload.reconciliation?.managedEventIdPrefix);
  if (!eventIdPrefix) return;
  const currentPrefixes = normalizedEventSessionPrefixes({
    eventSessionPrefixes: payload.reconciliation?.managedEventSessionPrefixes
  });
  const currentSessionIds = normalizedEventSessionIds(payload.reconciliation?.managedEventSessionIds);
  const replacesChangedSessions = Boolean(payload.reconciliation?.reconcileIncrementally);
  const isCurrentSession = sessionId => currentPrefixes.some(prefix => sessionId.startsWith(prefix))
    || currentSessionIds.includes(sessionId);

  const historicalRows = db.prepare(`
    SELECT session_id AS sessionId, date(timestamp, '+8 hours') AS usageDate,
      model, MAX(timestamp) AS lastActivity,
      COALESCE(SUM(input_tokens), 0) AS inputTokens,
      COALESCE(SUM(output_tokens), 0) AS outputTokens,
      COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
      COALESCE(SUM(cache_creation_tokens), 0) AS cacheCreationTokens,
      COALESCE(SUM(reasoning_tokens), 0) AS reasoningOutputTokens
    FROM token_events
    WHERE device = ? AND source = ? AND event_id LIKE ? ESCAPE '\\'
      AND event_id NOT IN (SELECT value FROM json_each(?))
    GROUP BY session_id, usageDate, model
  `).all(payload.device, source, sqlLikePrefix(eventIdPrefix), refreshedEventIds(payload, source))
    .filter(row => !replacesChangedSessions || !isCurrentSession(row.sessionId));
  const projectPaths = new Map(payload.sessionRows
    .filter(row => row.source === source)
    .map(row => [row.sessionId, row.projectPath || null]));
  const sessions = new Map();
  const days = new Map();

  const addEvent = ({ sessionId, usageDate, lastActivity, model, tokens, projectPath = null }) => {
    const sessionKey = ['workbuddy', 'codebuddy'].includes(payload.sourceSummary.id) ? sessionId : `${sessionId}::${model}`;
    const session = sessions.get(sessionKey) || usageRow({
      device: payload.device, source, sessionId,
      lastActivity: lastActivity || null, projectPath, model: model || ''
    });
    addUsage(session, tokens, calculateCost(model || '', tokens, pricingData));
    if (lastActivity && (!session.lastActivity || lastActivity > session.lastActivity)) {
      session.lastActivity = lastActivity;
      session.model = model || '';
    }
    sessions.set(sessionKey, session);

    const dayKey = dailyUsageKey(source, usageDate || 'unknown', model || '');
    const day = days.get(dayKey) || usageRow({
      device: payload.device, source, usageDate: usageDate || 'unknown', model: model || ''
    });
    addUsage(day, tokens, calculateCost(model || '', tokens, pricingData));
    days.set(dayKey, day);
  };

  for (const row of historicalRows) {
    addEvent({ ...row, tokens: eventTokens(row) });
  }
  for (const row of payload.eventRows) {
    if (row.source !== source) continue;
    addEvent({
      sessionId: row.sessionId,
      usageDate: localDateFromTimestamp(row.timestamp),
      lastActivity: row.timestamp,
      model: row.model,
      tokens: eventTokens(row),
      projectPath: projectPaths.get(row.sessionId) || null
    });
  }

  payload.dailyRows = [
    ...payload.dailyRows.filter(row => row.source !== source),
    ...days.values()
  ];
  payload.sessionRows = [
    ...payload.sessionRows.filter(row => row.source !== source),
    ...sessions.values()
  ];
}

function mergeHistoricalEventUsageForSource(db, payload, source, pricingData) {
  const eventIdPrefix = normalizedReconciliationPrefix(payload.reconciliation?.managedEventIdPrefix);
  if (!eventIdPrefix) return;
  const currentPrefixes = normalizedEventSessionPrefixes({
    eventSessionPrefixes: payload.reconciliation?.managedEventSessionPrefixes
  });
  const currentSessionIds = normalizedEventSessionIds(payload.reconciliation?.managedEventSessionIds);
  const historicalRows = db.prepare(`
    SELECT session_id AS sessionId, date(timestamp, '+8 hours') AS usageDate,
      model, MAX(timestamp) AS lastActivity,
      COALESCE(SUM(input_tokens), 0) AS inputTokens,
      COALESCE(SUM(output_tokens), 0) AS outputTokens,
      COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
      COALESCE(SUM(cache_creation_tokens), 0) AS cacheCreationTokens,
      COALESCE(SUM(reasoning_tokens), 0) AS reasoningOutputTokens
    FROM token_events
    WHERE device = ? AND source = ? AND event_id LIKE ? ESCAPE '\\'
      AND event_id NOT IN (SELECT value FROM json_each(?))
    GROUP BY session_id, usageDate, model
  `).all(payload.device, source, sqlLikePrefix(eventIdPrefix), refreshedEventIds(payload, source))
    .filter(row => !currentPrefixes.some(prefix => row.sessionId.startsWith(prefix))
      && !currentSessionIds.includes(row.sessionId));
  if (!historicalRows.length) return;

  const sessions = new Map<string, InputRecord>();
  const days = new Map<string, InputRecord>();
  for (const row of historicalRows) {
    const tokens = eventTokens(row);
    const session = sessions.get(row.sessionId) || usageRow({
      device: payload.device, source, sessionId: row.sessionId,
      lastActivity: row.lastActivity, projectPath: null, model: row.model || ''
    });
    addUsage(session, tokens, calculateCost(row.model || '', tokens, pricingData));
    if (row.lastActivity > session.lastActivity) session.lastActivity = row.lastActivity;
    sessions.set(row.sessionId, session);

    const dayKey = dailyUsageKey(source, row.usageDate, row.model);
    const day = days.get(dayKey) || usageRow({
      device: payload.device, source, usageDate: row.usageDate, model: row.model || ''
    });
    addUsage(day, tokens, calculateCost(row.model || '', tokens, pricingData));
    days.set(dayKey, day);
  }
  for (const session of sessions.values()) payload.sessionRows.push(session);

  const dailyByKey = new Map(payload.dailyRows.map(row => [dailyUsageKey(row.source, row.usageDate, row.model), row]));
  for (const [key, historical] of days) {
    const current = dailyByKey.get(key);
    if (!current) {
      payload.dailyRows.push(historical);
      continue;
    }
    addUsage(current, eventTokens(historical), Number(historical.costUSD || 0));
  }
}

function usageRow(values) {
  return {
    ...values,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    costUSD: 0
  };
}

function addUsage(row, tokens, costUSD) {
  row.inputTokens += tokens.input;
  row.outputTokens += tokens.output;
  row.cacheReadTokens += tokens.cacheRead;
  row.cacheCreationTokens += tokens.cacheWrite;
  row.reasoningOutputTokens += tokens.reasoning;
  row.totalTokens += tokenTotal(tokens);
  row.costUSD += costUSD;
}

function eventTokens(row) {
  return {
    input: Number(row.inputTokens || 0),
    output: Number(row.outputTokens || 0),
    cacheRead: Number(row.cacheReadTokens || 0),
    cacheWrite: Number(row.cacheCreationTokens || 0),
    reasoning: Number(row.reasoningTokens ?? row.reasoningOutputTokens ?? 0)
  };
}

function normalizedEventSessionPrefixes(reconciliation) {
  const prefixes = reconciliation?.eventSessionPrefixes;
  if (!Array.isArray(prefixes)) return [];
  return [...new Set(prefixes.filter(prefix => typeof prefix === 'string' && prefix.trim()))];
}

function normalizedEventSessionIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(sessionId => typeof sessionId === 'string' && sessionId.trim()))];
}

function normalizedReconciliationPrefix(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function deleteManagedEventsBySessionPrefix(db, payload, source, eventIdPrefix, sessionId, exact = false) {
  if (!eventIdPrefix || !sessionId) return;
  db.prepare(exact ? `
    DELETE FROM token_events
    WHERE device = ? AND source = ?
      AND event_id LIKE ? ESCAPE '\\'
      AND session_id = ?
  ` : `
    DELETE FROM token_events
    WHERE device = ? AND source = ?
      AND event_id LIKE ? ESCAPE '\\'
      AND session_id LIKE ? ESCAPE '\\'
  `).run(payload.device, source, sqlLikePrefix(eventIdPrefix), exact ? sessionId : sqlLikePrefix(sessionId));
}

function resetSessionsByPrefix(db, payload, source, sessionId, exact = false) {
  if (!sessionId) return;
  db.prepare(exact ? `
    UPDATE session_usage
    SET input_tokens = 0,
      output_tokens = 0,
      cache_creation_tokens = 0,
      cache_read_tokens = 0,
      cached_input_tokens = 0,
      reasoning_output_tokens = 0,
      total_tokens = 0,
      cost_usd = 0,
      updated_at = datetime('now')
    WHERE device = ? AND source = ? AND session_id = ?
  ` : `
    UPDATE session_usage
    SET input_tokens = 0,
      output_tokens = 0,
      cache_creation_tokens = 0,
      cache_read_tokens = 0,
      cached_input_tokens = 0,
      reasoning_output_tokens = 0,
      total_tokens = 0,
      cost_usd = 0,
      updated_at = datetime('now')
    WHERE device = ? AND source = ? AND session_id LIKE ? ESCAPE '\\'
  `).run(payload.device, source, exact ? sessionId : sqlLikePrefix(sessionId));
}

function dailyUsageKey(source, usageDate, model) {
  return JSON.stringify([source, usageDate, model]);
}

function payloadSources(payload) {
  return [...new Set([
    ...payload.dailyRows.map(row => row.source),
    ...payload.sessionRows.map(row => row.source),
    ...payload.eventRows.map(row => row.source)
  ].filter(Boolean))];
}

function sqlLikePrefix(value) {
  return `${String(value).replace(/[\\%_]/g, '\\$&')}%`;
}

function isScheduledCollection() {
  const reason = process.env.TOKEN_WORK_COLLECT_REASON;
  return reason === 'scheduled'
    || (!reason && ['1', 'true', 'yes', 'on'].includes(String(process.env.SCHEDULED_COLLECT_ENABLED || '').toLowerCase()));
}

function isIncrementalMetadataRefresh() {
  return ['scheduled', 'live-refresh', 'manual'].includes(process.env.TOKEN_WORK_COLLECT_REASON)
    && process.env.TOKEN_WORK_SCHEDULED_INCREMENTAL === '1';
}

function forcedFullRefreshSources() {
  return new Set(
    String(process.env.TOKEN_WORK_FULL_REFRESH_SOURCES || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
  );
}

function metadataRefreshSince(db, device, source) {
  const previous = db.prepare(`
    SELECT collected_at AS collectedAt
    FROM collection_runs
    WHERE device = ? AND source = ? AND status IN ('ok', 'empty')
    ORDER BY id DESC
    LIMIT 1
  `).get(device, source);
  if (previous?.collectedAt) {
    const timestamp = new Date(previous.collectedAt).getTime();
    if (Number.isFinite(timestamp)) return timestamp;
  }

  return null;
}

function codexUnknownSessionPrefixes(db, device) {
  const rows = db.prepare(`
    SELECT session_id AS sessionId
    FROM session_usage
    WHERE device = ? AND source = ? AND session_id LIKE 'local:codex:%'
    UNION
    SELECT session_id AS sessionId
    FROM token_events
    WHERE device = ? AND source = ? AND session_id LIKE 'local:codex:%'
  `).all(device, UNKNOWN_CODEX_SOURCE, device, UNKNOWN_CODEX_SOURCE);
  return [...new Set(rows.map(row => {
    const separator = String(row.sessionId || '').lastIndexOf(':');
    return separator > 0 ? String(row.sessionId).slice(0, separator + 1) : null;
  }).filter(Boolean))];
}

function recordCollectionRun(db, run, scheduled) {
  if (!scheduled) {
    recordRun(db, run);
    return;
  }
  const previous = db.prepare(`
    SELECT status, message, collected_at AS collectedAt
    FROM collection_runs
    WHERE device = ? AND source = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(run.device, run.source);
  const elapsed = previous
    ? new Date(run.collectedAt).getTime() - new Date(previous.collectedAt).getTime()
    : Number.POSITIVE_INFINITY;
  const sameOutcome = previous?.status === run.status
    && (run.status === 'ok' || previous?.message === run.message);
  if (sameOutcome && elapsed >= 0 && elapsed < 60 * 60 * 1000) {
    db.prepare(`
      UPDATE collection_runs
      SET collected_at = ?
      WHERE id = (
        SELECT id
        FROM collection_runs
        WHERE device = ? AND source = ?
        ORDER BY id DESC
        LIMIT 1
      )
    `).run(run.collectedAt, run.device, run.source);
    return;
  }
  recordRun(db, run);
}

function validateMode(args) {
  if (args.dryRun && args.apply) {
    throw new Error('Choose either --dry-run or --apply, not both.');
  }
  if (!args.dryRun && !args.apply) {
    throw new Error('collect requires --dry-run or --apply. No local AI logs were scanned and SQLite was not modified.');
  }
  if (args.push && !args.apply) {
    throw new Error('--push requires --apply.');
  }
}

async function confirmApplyIfNeeded(args) {
  if (!args.apply) return;
  if (args.yes || process.env.TOKEN_WORK_COLLECT_CONFIRMED === '1') return;
  if (!process.stdin.isTTY) {
    throw new Error('collect --apply requires --yes in non-interactive shells.');
  }
  const sources = args.sources || args.collectors || 'configured defaults';
  const rl = createInterface({ input, output });
  try {
    console.log('This will scan local AI coding logs for structured token usage and write SQLite.');
    console.log(`Sources: ${sources}`);
    console.log('Token Work only imports token/model/time/session metadata. It does not save prompt, response, transcript, diff, or full file paths.');
    const answer = await rl.question('Type APPLY to continue: ');
    if (answer.trim() !== 'APPLY') {
      throw new Error('Collection cancelled. SQLite was not modified.');
    }
  } finally {
    rl.close();
  }
}

function enabledCollectors(args) {
  const sourceArg = args.sources || args.collectors;
  if (sourceArg) {
    return enabledCollectorIds({ includeExperimental: true, values: sourceArg });
  }
  return enabledCollectorIds({ includeExperimental: Boolean(args.experimental) });
}

function runInTransaction(database, work) {
  database.exec('BEGIN');
  try {
    work();
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function countRows(db) {
  const count = table => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
  return {
    dailyRows: count('daily_usage'),
    sessionRows: count('session_usage'),
    tokenEvents: count('token_events'),
    collectionRuns: count('collection_runs')
  };
}

function normalizeDailyRows(json, deviceName) {
  const days = Array.isArray(json.contributions) ? json.contributions : [];
  const rows = days.flatMap((day) => {
    const clients = Array.isArray(day.clients) ? day.clients : [];
    return clients.map((entry) => {
      const tokens = normalizeTokens(entry.tokens);
      return {
        device: deviceName,
        source: sourceLabel(entry.client),
        usageDate: day.date,
        model: canonicalModelName(entry.modelId || entry.model_id || 'unknown'),
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        cacheCreationTokens: tokens.cacheWrite,
        cacheReadTokens: tokens.cacheRead,
        reasoningOutputTokens: tokens.reasoning,
        totalTokens: tokenTotal(tokens),
        costUSD: entry.cost || 0
      };
    });
  });
  const grouped = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.source, row.usageDate, row.model]);
    const previous = grouped.get(key);
    if (previous) addUsage(previous, eventTokens(row), row.costUSD);
    else grouped.set(key, row);
  }
  return [...grouped.values()];
}

function normalizeSessionRows(json, deviceName) {
  const entries = Array.isArray(json.entries) ? json.entries : [];
  return entries.map((entry) => {
    const tokens = {
      input: positiveNumber(entry.input),
      output: positiveNumber(entry.output),
      cacheRead: positiveNumber(entry.cacheRead),
      cacheWrite: positiveNumber(entry.cacheWrite),
      reasoning: positiveNumber(entry.reasoning)
    };
    const source = sourceLabel(entry.client);
    const workspace = entry.workspaceLabel || entry.workspaceKey || '';
    const model = entry.model || 'unknown';
    return {
      device: deviceName,
      source,
      sessionId: entry.sessionId || ['local', entry.client || 'unknown', workspace || 'no-workspace', model].join(':'),
      lastActivity: entry.lastActivity || null,
      projectPath: workspace || null,
      model: canonicalModelName(model),
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      cacheCreationTokens: tokens.cacheWrite,
      cacheReadTokens: tokens.cacheRead,
      reasoningOutputTokens: tokens.reasoning,
      totalTokens: tokenTotal(tokens),
      costUSD: entry.cost || 0
    };
  });
}

function normalizeTokenEventRows(events, deviceName, collectedAt) {
  if (!Array.isArray(events)) return [];
  return events.map((event) => {
    const eventId = event.eventId ?? event.event_id ?? null;
    return {
      device: deviceName,
      source: sourceLabel(event.source || event.client),
      sessionId: event.sessionId || event.session_id || 'unknown-session',
      timestamp: event.timestamp || collectedAt,
      model: canonicalModelName(event.model || 'unknown'),
      inputTokens: positiveNumber(event.inputTokens ?? event.input_tokens),
      outputTokens: positiveNumber(event.outputTokens ?? event.output_tokens),
      cacheReadTokens: positiveNumber(event.cacheReadTokens ?? event.cache_read_tokens),
      cacheCreationTokens: positiveNumber(event.cacheCreationTokens ?? event.cache_creation_tokens),
      reasoningTokens: positiveNumber(event.reasoningTokens ?? event.reasoning_tokens),
      toolCategory: event.toolCategory ?? event.tool_category ?? null,
      fileExtension: event.fileExtension ?? event.file_extension ?? null,
      repoPathHash: event.repoPathHash ?? event.repo_path_hash ?? null,
      privacyLevel: event.privacyLevel ?? event.privacy_level ?? 'safe',
      eventId,
      legacyEventIds: [...new Set(Array.isArray(event.legacyEventIds) ? event.legacyEventIds : [])]
        .filter(candidate => typeof candidate === 'string' && candidate && candidate !== eventId)
    };
  });
}

function normalizeTokens(tokens: InputRecord = {}) {
  return {
    input: positiveNumber(tokens.input),
    output: positiveNumber(tokens.output),
    cacheRead: positiveNumber(tokens.cacheRead ?? tokens.cache_read),
    cacheWrite: positiveNumber(tokens.cacheWrite ?? tokens.cache_write),
    reasoning: positiveNumber(tokens.reasoning)
  };
}

function tokenTotal(tokens) {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite + tokens.reasoning;
}

function positiveNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function sourceLabel(client) {
  return collectorLabel(client) || client || 'unknown';
}

function runRecord({ device, label, status, message, collectedAt, module }) {
  return {
    device,
    source: label,
    status,
    message,
    collectedAt,
    command: `js-collector:${module}`
  };
}

function emptyAuditSummary() {
  return {
    candidateFiles: 0,
    usableTokenRecords: 0,
    skippedNoTokenRecords: 0,
    skippedUnresolvedModel: 0,
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

function normalizeAuditSummary(value: InputRecord = {}) {
  const summary = emptyAuditSummary();
  for (const key of [
    'candidateFiles',
    'usableTokenRecords',
    'skippedNoTokenRecords',
    'skippedUnresolvedModel',
    'skippedConversationLikeRecords',
    'skippedOversizedFiles',
    'parseErrors',
    'sessionRows',
    'tokenEvents',
    'totalTokens'
  ]) {
    summary[key] = positiveNumber(value[key]);
  }
  summary.firstTimestamp = safeTimestamp(value.firstTimestamp);
  summary.lastTimestamp = safeTimestamp(value.lastTimestamp);
  return summary;
}

function addAuditToSource(sourceSummary, audit) {
  const normalized = normalizeAuditSummary(audit);
  for (const key of [
    'candidateFiles',
    'usableTokenRecords',
    'skippedNoTokenRecords',
    'skippedUnresolvedModel',
    'skippedConversationLikeRecords',
    'skippedOversizedFiles',
    'parseErrors'
  ]) {
    sourceSummary[key] = normalized[key];
  }
  sourceSummary.auditSessionRows = normalized.sessionRows;
  sourceSummary.auditTokenEvents = normalized.tokenEvents;
  sourceSummary.auditTotalTokens = normalized.totalTokens;
  sourceSummary.firstTimestamp = normalized.firstTimestamp || sourceSummary.firstTimestamp;
  sourceSummary.lastTimestamp = normalized.lastTimestamp || sourceSummary.lastTimestamp;
}

function addSummary(summary, sourceSummary) {
  summary.sources.push(sourceSummary);
  for (const key of Object.keys(summary.totals)) {
    if (typeof summary.totals[key] === 'number') {
      summary.totals[key] += Number(sourceSummary[key] || 0);
    }
  }
  summary.totals.firstTimestamp = earlierTimestamp(summary.totals.firstTimestamp, sourceSummary.firstTimestamp);
  summary.totals.lastTimestamp = laterTimestamp(summary.totals.lastTimestamp, sourceSummary.lastTimestamp);
}

function printSummary(summary) {
  console.log(`[collect] mode=${summary.mode} enabled=${summary.enabledCollectors.join(',') || 'none'}`);
  for (const source of summary.sources) {
    console.log(`[${source.label}] status=${source.status} risk=${source.coverageRisk} daily=${source.dailyRows} sessions=${source.sessionRows} token_events=${source.tokenEvents} candidate_files=${source.candidateFiles} usable_records=${source.usableTokenRecords} skipped_no_token=${source.skippedNoTokenRecords} skipped_unresolved_model=${source.skippedUnresolvedModel} skipped_unsafe=${source.skippedConversationLikeRecords} parse_errors=${source.parseErrors} tokens(event/session/daily)=${source.eventTotalTokens}/${source.sessionTotalTokens}/${source.dailyTotalTokens}`);
    if (source.firstTimestamp || source.lastTimestamp) console.log(`  range=${source.firstTimestamp || '-'}..${source.lastTimestamp || '-'}`);
    if (source.coverageStatus) console.log(`  coverage=${source.coverageStatus}`);
    if (source.status === 'error' && source.message) console.log(`  error=${source.message}`);
  }
  if (summary.mode === 'dry-run') {
    console.log('[collect] dry-run only. Re-run with --apply --yes after reviewing this summary to write SQLite.');
    return;
  }
  if (summary.backup?.path) console.log(`[collect] backup=${summary.backup.path}`);
  if (summary.before && summary.after) {
    console.log(`[collect] rows before daily=${summary.before.dailyRows} sessions=${summary.before.sessionRows} events=${summary.before.tokenEvents} runs=${summary.before.collectionRuns}`);
    console.log(`[collect] rows after  daily=${summary.after.dailyRows} sessions=${summary.after.sessionRows} events=${summary.after.tokenEvents} runs=${summary.after.collectionRuns}`);
  }
}

function addCoverageReconciliation(sourceSummary, dailyRows, sessionRows, eventRows) {
  if (eventRows.length > 0) {
    sourceSummary.usableTokenRecords = eventRows.length;
  }
  const dailyTotalTokens = sumDailyTokens(dailyRows);
  const sessionTotalTokens = sumSessionTokens(sessionRows);
  const eventTotalTokens = sumEventTokens(eventRows);
  const firstEventTimestamp = firstTimestamp(eventRows.map(row => row.timestamp));
  const lastEventTimestamp = lastTimestamp(eventRows.map(row => row.timestamp));
  sourceSummary.dailyTotalTokens = dailyTotalTokens;
  sourceSummary.sessionTotalTokens = sessionTotalTokens;
  sourceSummary.eventTotalTokens = eventTotalTokens;
  sourceSummary.totalTokens = eventTotalTokens || sessionTotalTokens || dailyTotalTokens || sourceSummary.totalTokens || 0;
  sourceSummary.firstTimestamp = firstEventTimestamp || sourceSummary.firstTimestamp;
  sourceSummary.lastTimestamp = lastEventTimestamp || sourceSummary.lastTimestamp;
  sourceSummary.reconciliation = {
    candidateRecords: sourceSummary.usableTokenRecords,
    tokenEvents: eventRows.length,
    sessions: sessionRows.length,
    dailyRows: dailyRows.length,
    dailyTotalTokens,
    sessionTotalTokens,
    eventTotalTokens,
    dailyVsEventDiffPct: diffPct(dailyTotalTokens, eventTotalTokens),
    sessionVsEventDiffPct: diffPct(sessionTotalTokens, eventTotalTokens)
  };

  const hasUsableRecords = sourceSummary.usableTokenRecords > 0;
  const needsEventLevel = sourceSummary.id === 'claude' || sourceSummary.id === 'codex';

  if (sourceSummary.status === 'error') {
    sourceSummary.coverageRisk = 'collector-error';
    sourceSummary.coverageStatus = 'collector failed before producing rows';
    return;
  }
  if (needsEventLevel && hasUsableRecords && eventRows.length === 0) {
    sourceSummary.coverageRisk = 'blocking-no-events';
    sourceSummary.coverageStatus = 'usable token records were found but no token_events would be written';
    sourceSummary.fatalCoverageError = true;
    sourceSummary.fatalCoverageErrors = 1;
    return;
  }
  if (eventRows.length > 0 && (
    diffPct(dailyTotalTokens, eventTotalTokens) > 0.01 ||
    diffPct(sessionTotalTokens, eventTotalTokens) > 0.01
  )) {
    sourceSummary.coverageRisk = 'blocking-reconciliation-mismatch';
    sourceSummary.coverageStatus = 'daily/session/event token totals differ by more than 1%';
    sourceSummary.fatalCoverageError = true;
    sourceSummary.fatalCoverageErrors = 1;
    return;
  }
  if (sourceSummary.id === 'cursor' && sourceSummary.candidateFiles > 0 && sourceSummary.usableTokenRecords === 0) {
    sourceSummary.coverageRisk = 'detected-no-token-fields';
    sourceSummary.coverageStatus = 'Cursor was detected, but no reliable tokenCount fields were found';
    return;
  }
  if (sourceSummary.candidateFiles === 0) {
    sourceSummary.coverageRisk = 'not-detected';
    sourceSummary.coverageStatus = 'no candidate local metadata files were found';
    return;
  }
  if (eventRows.length > 0) {
    sourceSummary.coverageRisk = 'trusted-event-level';
    sourceSummary.coverageStatus = 'event/session/daily totals reconcile within 1%';
    return;
  }
  if (dailyRows.length || sessionRows.length) {
    sourceSummary.coverageRisk = 'aggregate-only';
    sourceSummary.coverageStatus = 'only aggregate rows would be written; historical event coverage is incomplete';
    return;
  }
  sourceSummary.coverageRisk = 'empty';
  sourceSummary.coverageStatus = 'candidate files did not produce token usage rows';
}

function sumDailyTokens(rows) {
  return rows.reduce((sum, row) => sum + positiveNumber(row.totalTokens), 0);
}

function sumSessionTokens(rows) {
  return rows.reduce((sum, row) => sum + positiveNumber(row.totalTokens), 0);
}

function sumEventTokens(rows) {
  return rows.reduce((sum, row) => sum
    + positiveNumber(row.inputTokens)
    + positiveNumber(row.outputTokens)
    + positiveNumber(row.cacheReadTokens)
    + positiveNumber(row.cacheCreationTokens)
    + positiveNumber(row.reasoningTokens), 0);
}

function diffPct(left, right) {
  const max = Math.max(Number(left || 0), Number(right || 0), 1);
  return Math.abs(Number(left || 0) - Number(right || 0)) / max;
}

function safeTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? value : null;
}

function firstTimestamp(values) {
  return values.reduce((best, value) => earlierTimestamp(best, value), null);
}

function lastTimestamp(values) {
  return values.reduce((best, value) => laterTimestamp(best, value), null);
}

function earlierTimestamp(left, right) {
  const safeRight = safeTimestamp(right);
  if (!safeRight) return safeTimestamp(left);
  const safeLeft = safeTimestamp(left);
  if (!safeLeft) return safeRight;
  return new Date(safeRight) < new Date(safeLeft) ? safeRight : safeLeft;
}

function laterTimestamp(left, right) {
  const safeRight = safeTimestamp(right);
  if (!safeRight) return safeTimestamp(left);
  const safeLeft = safeTimestamp(left);
  if (!safeLeft) return safeRight;
  return new Date(safeRight) > new Date(safeLeft) ? safeRight : safeLeft;
}

function parseArgs(argv) {
  const booleanKeys = new Set(['apply', 'dryRun', 'experimental', 'help', 'json', 'yes']);
  const valueKeys = new Set(['collectors', 'db', 'device', 'push', 'sources', 'token']);
  const parsed: CollectArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--') && arg.includes('=')) {
      const [key, value] = arg.slice(2).split(/=(.*)/s);
      const camelKey = toCamel(key);
      parsed[camelKey] = parseArgValue(camelKey, value, booleanKeys);
    } else if (arg.startsWith('--')) {
      const key = toCamel(arg.slice(2));
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        if (valueKeys.has(key)) throw new Error(`--${arg.slice(2)} requires a value`);
        parsed[key] = true;
      } else {
        parsed[key] = parseArgValue(key, next, booleanKeys);
        i += 1;
      }
    }
  }
  return parsed;
}

function parseArgValue(key, value, booleanKeys) {
  if (!booleanKeys.has(key)) return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`--${key.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`)} must be true or false`);
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function printHelp() {
  console.log([
    'Token Work collector',
    '',
    'Examples:',
    '  token-work collect --dry-run --sources=claude,codex,cursor',
    '  token-work collect --apply --yes --sources=claude,codex',
    '',
    'Modes:',
    '  --dry-run   Scan candidate local metadata and print a summary without writing SQLite',
    '  --apply     Write SQLite after explicit confirmation or --yes',
    '',
    'Safety:',
    '  The collector imports token/model/time/session metadata only.',
    '  It does not save prompt, response, transcript, diff, or full file paths.'
  ].join('\n'));
}

async function pushPayload(url, payload, token) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`Push failed: HTTP ${response.status} ${await response.text()}`);
  }
  console.log(`[push] ${url}`);
}
