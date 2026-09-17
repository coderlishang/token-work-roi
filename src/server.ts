import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import {
  attachOfficialPricing,
  loadPricing,
  officialPricingMetadata
} from './pricing.ts';
import { providerFromSource } from './provider.ts';
import {
  AUTO_ATTRIBUTION_THRESHOLD,
  buildAutoAttributionPlan
} from './auto-attribution.ts';
import {
  ANNOTATION_SOURCES,
  ADVISOR_ACTION_STATUSES,
  BUDGET_WINDOW_TYPES,
  DEFAULT_SESSION_ANNOTATION,
  OUTPUT_STATUSES,
  OUTPUT_TYPES,
  PROJECT_ALIAS_MATCH_TYPES,
  TASK_TYPES,
  VALUE_LEVELS,
  WORK_PURPOSES,
  WORK_STAGES,
  applyAutoSessionAnnotations,
  batchUpsertSessionAnnotations,
  createSqliteBackup,
  defaultDbPath,
  deleteProjectAliasRule,
  deleteAdvisorAction,
  deleteBudgetProfile,
  deleteSessionAnnotation,
  deleteSessionOutput,
  exportAnnotationData,
  importAnnotationData,
  linkWorkItemSessions,
  listProjectAliasRules,
  listAdvisorActions,
  listBudgetProfiles,
  listTokenEvents,
  listWorkItems,
  matchProjectAliasRule,
  openDb,
  recordRun,
  deleteWorkItem,
  undoAutoSessionAnnotations,
  upsertAdvisorAction,
  upsertBudgetProfile,
  upsertDailyBatch,
  upsertProjectAliasRule,
  upsertSession,
  upsertSessionAnnotation,
  upsertSessionOutput,
  upsertWorkItem
} from './db.ts';
import { loadCollectorConfig } from './collector-config.ts';
import { detectCollectors, LIVE_COLLECT_SOURCES } from './collector-registry.ts';
import { runPrivacyCheck } from './privacy-check.ts';
import { buildModelPolicy, formatModelPolicyMarkdown } from './model-policy.ts';
import { buildLiveSnapshot } from './live.ts';
import { getUsdCnyExchangeRate } from './exchange-rate.ts';
import { applyCcusageImport, assertCcusageImportCanApply, ccusageImportWouldChange, parseCcusageJsonText, planCcusageImport } from './ccusage-import.ts';
import { buildSourceHealth } from './source-health.ts';
import { buildProjectCoverage, buildReviewWorkflow } from './project-coverage.ts';
import { buildCoverageBridge } from './coverage-bridge.ts';
import { buildEvidenceFlywheel } from './evidence-flywheel.ts';
import { buildLocalTrust, buildLocalTrustSamples } from './local-trust.ts';
import {
  applyEvidenceSuggestions,
  buildEvidenceAutopilotPlan
} from './evidence-autopilot.ts';

type InputRecord = Record<string, unknown>;

interface CollectionState {
  status: string;
  message: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  backup: unknown;
  summary: unknown;
}

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || process.env.BIND_HOST || '127.0.0.1';
const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
validateHostConfiguration(host, {
  allowRemote: remoteAccessEnabled(),
  ingestToken: process.env.INGEST_TOKEN
});
const staticDir = existsSync(resolve(process.cwd(), 'dist'))
  ? resolve(process.cwd(), 'dist')
  : resolve(process.cwd(), 'public');
const dbPath = process.env.DB_PATH || defaultDbPath;
const pricingCachePath = process.env.TOKEN_WORK_PRICING_CACHE
  || resolve(process.cwd(), 'data', 'official-pricing.json');
const packageVersion = readPackageVersion();
const SPA_ROUTES = new Set(['/', '/review', '/live', '/trust']);
const MAX_INGEST_ROWS = 50_000;
const COLLECTION_STOP_GRACE_MS = 1_500;
const db = openDb(dbPath);
let activeCollection = null;
let lastCoverageGate = null;
let collectionState: CollectionState = {
  status: 'idle',
  message: '尚未启动采集',
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  stdout: '',
  stderr: '',
  backup: null,
  summary: null
};

const server = createServer((req, res) => {
  const url = parseRequestUrl(req, res);
  if (!url) return;
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, url, res).catch(error => {
      sendJson(res, { error: error.message }, 500);
    });
    return;
  }
  serveStatic(url.pathname, res);
});

function parseRequestUrl(req, res) {
  try {
    return new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  } catch {
    sendJson(res, { error: 'Bad request URL' }, 400);
    return null;
  }
}

let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  server.closeIdleConnections?.();
  const collectorStopped = activeCollection && activeCollection.exitCode == null
    ? stopCollectionAndWait(activeCollection)
    : Promise.resolve();
  const serverClosed = new Promise<void>(resolveClose => server.close(() => resolveClose()));

  Promise.all([collectorStopped, serverClosed]).then(() => process.exit(0));
  const forceExit = setTimeout(() => process.exit(0), 3000);
  forceExit.unref?.();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
if (process.send) process.once('disconnect', shutdown);
if (process.platform !== 'win32') {
  process.once('SIGHUP', shutdown);
}

function stopCollection(child, { force = false } = {}) {
  if (process.platform === 'win32' && child.pid) {
    const result = spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true
    });
    if (result.status === 0) return;
  }

  if (process.platform !== 'win32' && child.pid) {
    try {
      // Scheduled collectors run in their own process group so a timeout also
      // stops any descendants that inherited the collector's file handles.
      process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
      return;
    } catch {
      // A process group is unavailable only when spawning failed or the child
      // has already exited. The direct-child fallback below still covers both.
    }
  }

  child.kill(force ? 'SIGKILL' : 'SIGTERM');
}

function stopCollectionAndWait(child) {
  return new Promise<void>(resolveStop => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceKill);
      clearTimeout(giveUp);
      resolveStop();
    };
    const forceKill = setTimeout(() => stopCollection(child, { force: true }), COLLECTION_STOP_GRACE_MS);
    const giveUp = setTimeout(done, 2500);
    forceKill.unref?.();
    giveUp.unref?.();
    child.once('close', done);
    stopCollection(child);
  });
}

server.listen(port, host, () => {
  const address = server.address();
  const actualPort = address && typeof address === 'object' ? address.port : port;
  const displayHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  process.send?.({ type: 'listening', port: actualPort, host });
  console.log(`Token Work ROI: http://${displayHost}:${actualPort} (listening on ${host})`);
  startScheduledCollect();
});

async function handleApi(req, url, res) {
  if (url.pathname === '/api/summary' && req.method === 'GET') {
    if (!validateLocalRead(req, res, '汇总接口')) return;
    sendJson(res, {
      totals: one(`
        SELECT
          COALESCE(SUM(total_tokens), 0) AS totalTokens,
          COALESCE(SUM(input_tokens), 0) AS inputTokens,
          COALESCE(SUM(output_tokens), 0) AS outputTokens,
          COALESCE(SUM(cache_creation_tokens + cache_read_tokens + cached_input_tokens), 0) AS cacheTokens,
          COALESCE(SUM(reasoning_output_tokens), 0) AS reasoningTokens,
          COALESCE(SUM(cost_usd), 0) AS costUSD
        FROM daily_usage
      `),
      bySource: all(`
        SELECT source, device,
          SUM(total_tokens) AS totalTokens,
          SUM(input_tokens) AS inputTokens,
          SUM(output_tokens) AS outputTokens,
          SUM(cost_usd) AS costUSD
        FROM daily_usage
        GROUP BY source, device
        ORDER BY totalTokens DESC
      `),
      byDay: all(`
        SELECT usage_date AS date, source, SUM(total_tokens) AS totalTokens, SUM(cost_usd) AS costUSD
        FROM daily_usage
        GROUP BY usage_date, source
        ORDER BY usage_date
      `),
      byModel: all(`
        SELECT source, model, SUM(total_tokens) AS totalTokens, SUM(cost_usd) AS costUSD
        FROM daily_usage
        WHERE model != ''
        GROUP BY source, model
        ORDER BY totalTokens DESC
        LIMIT 20
      `),
      topSessions: all(`
        SELECT device, source, session_id AS sessionId, last_activity AS lastActivity,
          project_path AS projectPath, model, total_tokens AS totalTokens, cost_usd AS costUSD
        FROM session_usage
        ORDER BY total_tokens DESC
        LIMIT 30
      `),
      runs: all(`
        SELECT device, source, status, message, collected_at AS collectedAt
        FROM collection_runs
        ORDER BY id DESC
        LIMIT 20
      `)
    });
    return;
  }
  if (url.pathname === '/api/data' && req.method === 'GET') {
    if (!validateLocalRead(req, res, '数据接口')) return;
    const pricingData = await loadPricing(pricingCachePath);
    const aliasRules = listProjectAliasRules(db);
    const enabledAliasRules = aliasRules.filter(rule => rule.enabled);
    const rawSessions = all(`
      SELECT s.device, s.source,
        s.session_id AS sessionId,
        s.last_activity AS lastActivity,
        s.project_path AS projectPath,
        s.model,
        s.input_tokens AS inputTokens,
        s.output_tokens AS outputTokens,
        s.cache_creation_tokens AS cacheCreationTokens,
        s.cache_read_tokens AS cacheReadTokens,
        s.cached_input_tokens AS cachedInputTokens,
        s.reasoning_output_tokens AS reasoningOutputTokens,
        s.total_tokens AS totalTokens,
        s.cost_usd AS costUSD,
        a.project_alias AS manualProjectAlias,
        COALESCE(a.task_type, '未分类') AS taskType,
        COALESCE(a.output_status, '未标注') AS outputStatus,
        COALESCE(a.work_purpose, '未说明') AS workPurpose,
        COALESCE(a.work_stage, '未说明') AS workStage,
        COALESCE(a.value_level, '未评估') AS valueLevel,
        a.note,
        a.annotation_source AS annotationSource,
        a.annotation_confidence AS annotationConfidence,
        a.annotation_reason AS annotationReason,
        a.auto_version AS autoVersion,
        a.auto_run_id AS autoRunId,
        a.auto_updated_at AS autoUpdatedAt,
        a.updated_at AS annotationUpdatedAt,
        o.output_url AS outputUrl,
        o.output_label AS outputLabel,
        COALESCE(o.output_type, '未分类') AS outputType,
        o.updated_at AS outputUpdatedAt
      FROM session_usage s
      LEFT JOIN session_annotations a
        ON a.device = s.device
        AND a.source = s.source
        AND a.session_id = s.session_id
      LEFT JOIN session_outputs o
        ON o.device = s.device
        AND o.source = s.source
        AND o.session_id = s.session_id
      ORDER BY s.total_tokens DESC
    `);
    const rawRuns = all(`
      SELECT id, device, source, status, message,
        collected_at AS collectedAt
      FROM collection_runs
      ORDER BY id DESC
      LIMIT 1000
    `);

    // Normalize sessions
    const sessions = rawSessions.map(s => {
      const projectPath = (s.projectPath && s.projectPath !== 'Unknown Project')
        ? s.projectPath
        : (s.sessionId ? String(s.sessionId).split('/').slice(-1)[0] || s.sessionId : null);
      const ruleProjectAlias = matchProjectAliasRule(projectPath, enabledAliasRules);
      const manualProjectAlias = s.manualProjectAlias || null;
      const model = s.model || modelFromSessionId(s.sessionId);
      return {
        ...s,
        ...DEFAULT_SESSION_ANNOTATION,
        model,
        lastActivity: s.lastActivity ? String(s.lastActivity).slice(0, 10) : null,
        source: s.source,
        projectPath,
        projectAlias: manualProjectAlias || ruleProjectAlias || null,
        manualProjectAlias,
        ruleProjectAlias,
        taskType: s.taskType || DEFAULT_SESSION_ANNOTATION.taskType,
        outputStatus: s.outputStatus || DEFAULT_SESSION_ANNOTATION.outputStatus,
        workPurpose: s.workPurpose || DEFAULT_SESSION_ANNOTATION.workPurpose,
        workStage: s.workStage || DEFAULT_SESSION_ANNOTATION.workStage,
        valueLevel: s.valueLevel || DEFAULT_SESSION_ANNOTATION.valueLevel,
        note: s.note || null,
        annotationSource: s.annotationSource || null,
        annotationConfidence: s.annotationConfidence == null ? null : Number(s.annotationConfidence),
        annotationReason: s.annotationReason || null,
        autoVersion: s.autoVersion || null,
        autoRunId: s.autoRunId || null,
        autoUpdatedAt: s.autoUpdatedAt || null,
        attributionQuality: attributionQuality(s.annotationSource, s.annotationConfidence, s.annotationUpdatedAt),
        annotationUpdatedAt: s.annotationUpdatedAt || null,
        outputUrl: s.outputUrl || null,
        outputLabel: s.outputLabel || null,
        outputType: s.outputType || DEFAULT_SESSION_ANNOTATION.outputType,
        outputUpdatedAt: s.outputUpdatedAt || null
      };
    });

    // Build (device, source) -> projectPath map for enriching daily rows
    // Use the project with the most tokens for each (device, source) pair
    const projMap = new Map();
    for (const s of rawSessions) {
      const proj = (s.projectPath && s.projectPath !== 'Unknown Project')
        ? s.projectPath
        : (s.sessionId ? String(s.sessionId).split('/').slice(-1)[0] || s.sessionId : null);
      if (!proj) continue;
      const key = `${s.device}::${s.source}`;
      const cur = projMap.get(key);
      if (!cur || s.totalTokens > cur.tokens) {
        projMap.set(key, { project: proj, tokens: s.totalTokens });
      }
    }

    const rawDaily = all(`
      SELECT rowid AS id, device, source,
        usage_date AS usageDate, model,
        input_tokens AS inputTokens,
        output_tokens AS outputTokens,
        cache_creation_tokens AS cacheCreationTokens,
        cache_read_tokens AS cacheReadTokens,
        cached_input_tokens AS cachedInputTokens,
        reasoning_output_tokens AS reasoningOutputTokens,
        total_tokens AS totalTokens,
        cost_usd AS costUSD
      FROM daily_usage
      ORDER BY usage_date DESC
    `);
    const daily = rawDaily.map(d => attachOfficialPricing({
      ...d,
      projectPath: projMap.get(`${d.device}::${d.source}`)?.project || null
    }, d.model, providerFromSource(d.source), pricingData));
    const pricedSessions = sessions.map(s => attachOfficialPricing(
      s,
      s.model,
      providerFromSource(s.source),
      pricingData
    ));

    const workItems = listWorkItems(db);
    const budgetProfiles = listBudgetProfiles(db);
    const advisorActions = listAdvisorActions(db);
    const tokenEvents = listTokenEvents(db, { limit: 1000 });
    const tokenEventTotals = tokenEventTotalRows();
    const runtime = runtimeMetadata();
    const sourceHealthRows = sourceHealth();
    const coverageBridge = buildCoverageBridge({ sourceHealth: sourceHealthRows });
    const evidencePlan = buildEvidenceAutopilotPlan({
      sessions: pricedSessions,
      projectAliasRules: aliasRules,
      period: 'all',
      threshold: AUTO_ATTRIBUTION_THRESHOLD,
      scanGit: false
    });
    const evidenceFlywheel = buildEvidenceFlywheel({
      sessions: pricedSessions,
      workItems,
      advisorActions,
      evidencePlan,
      coverageBridge
    });
    const localTrust = buildLocalTrust({
      runtime,
      coverageBridge,
      sourceHealth: sourceHealthRows,
      daily,
      sessions: pricedSessions,
      tokenEvents,
      tokenEventTotals,
      runs: rawRuns,
      evidenceFlywheel
    });

    sendJson(res, {
      meta: {
        taskTypes: TASK_TYPES,
        outputStatuses: OUTPUT_STATUSES,
        workPurposes: WORK_PURPOSES,
        workStages: WORK_STAGES,
        valueLevels: VALUE_LEVELS,
        annotationSources: ANNOTATION_SOURCES,
        budgetWindowTypes: BUDGET_WINDOW_TYPES,
        advisorActionStatuses: ADVISOR_ACTION_STATUSES,
        outputTypes: OUTPUT_TYPES,
        projectAliasMatchTypes: PROJECT_ALIAS_MATCH_TYPES,
        projectAliasRules: aliasRules,
        demoMode: runtime.demoMode,
        dataMode: runtime.dataMode,
        runtime,
        officialPricing: officialPricingMetadata(daily, pricingData),
        sourceHealth: sourceHealthRows,
        coverageBridge,
        evidenceFlywheel,
        localTrust,
        projectCoverage: buildProjectCoverage({ sessions: pricedSessions }),
        reviewWorkflow: buildReviewWorkflow({ sessions: pricedSessions, advisorActions })
      },
      daily,
      sessions: pricedSessions,
      workItems,
      budgetProfiles,
      advisorActions,
      tokenEvents,
      // Normalize runs: strip newlines from messages, shorten device names
      runs: rawRuns.map(r => ({
        ...r,
        message: r.message ? String(r.message).replace(/\n/g, ' ').replace(/\s+/g, ' ').trim() : '',
        device: r.device ? String(r.device).replace(/\.local$/, '').replace(/^(.{30}).+$/, '$1…') : r.device
      }))
    });
    return;
  }
  if (url.pathname === '/api/collectors' && req.method === 'GET') {
    if (!validateLocalRead(req, res, '采集器接口')) return;
    const collectors = detectCollectors();
    sendJson(res, { collectors, sourceHealth: sourceHealth(collectors) });
    return;
  }
  if (url.pathname === '/api/source-health' && req.method === 'GET') {
    if (!validateLocalRead(req, res, '来源健康接口')) return;
    sendJson(res, { sources: sourceHealth() });
    return;
  }
  if (url.pathname === '/api/coverage-bridge' && req.method === 'GET') {
    if (!validateLocalRead(req, res, '覆盖桥接口')) return;
    const rows = sourceHealth();
    sendJson(res, { ok: true, coverageBridge: buildCoverageBridge({ sourceHealth: rows }) });
    return;
  }
  if (url.pathname === '/api/local-trust' && req.method === 'GET') {
    if (!validateLocalRead(req, res, '本地可信度接口')) return;
    const payload = buildLocalTrustPayload();
    sendJson(res, { ok: true, localTrust: payload.localTrust });
    return;
  }
  if (url.pathname === '/api/local-trust/samples' && req.method === 'GET') {
    if (!validateLocalRead(req, res, '本地可信度样本接口')) return;
    const source = url.searchParams.get('source');
    const limit = Number(url.searchParams.get('limit') || 20);
    const payload = buildLocalTrustPayload();
    sendJson(res, {
      ok: true,
      samples: buildLocalTrustSamples({
        tokenEvents: payload.tokenEvents,
        sessions: payload.sessions,
        source,
        limit
      })
    });
    return;
  }
  if (url.pathname === '/api/evidence-flywheel' && req.method === 'GET') {
    handleEvidenceFlywheel(req, url, res);
    return;
  }
  if (url.pathname === '/api/evidence-suggestions' && req.method === 'GET') {
    handleEvidenceSuggestions(req, url, res);
    return;
  }
  if (url.pathname === '/api/evidence-suggestions/apply' && req.method === 'POST') {
    handleEvidenceSuggestionsApply(req, res);
    return;
  }
  if (url.pathname === '/api/collection-coverage' && req.method === 'GET') {
    if (!validateLocalRead(req, res, '采集可信度接口')) return;
    if (demoModeEnabled()) {
      const coverage = demoCollectionCoverage();
      lastCoverageGate = summarizeCoverageGate(coverage);
      sendJson(res, coverage);
      return;
    }
    const coverage = await collectionCoverageDryRun({
      sources: url.searchParams.get('sources') || `${LIVE_COLLECT_SOURCES},cursor`
    });
    lastCoverageGate = summarizeCoverageGate(inputRecord(coverage));
    sendJson(res, coverage);
    return;
  }
  if (url.pathname === '/api/budget-profiles' && req.method === 'GET') {
    if (!validateLocalRead(req, res, '预算配置接口')) return;
    sendJson(res, { profiles: listBudgetProfiles(db), windowTypes: BUDGET_WINDOW_TYPES });
    return;
  }
  if (url.pathname === '/api/budget-profiles' && req.method === 'POST') {
    handleBudgetProfileUpsert(req, res);
    return;
  }
  if (url.pathname === '/api/budget-profiles' && req.method === 'DELETE') {
    handleBudgetProfileDelete(req, url, res);
    return;
  }
  if (url.pathname === '/api/exchange-rate' && req.method === 'GET') {
    if (!validateLocalRead(req, res, '汇率接口')) return;
    sendJson(res, await getUsdCnyExchangeRate());
    return;
  }
  if (url.pathname === '/api/advisor-actions' && req.method === 'GET') {
    if (!validateLocalRead(req, res, '建议行动接口')) return;
    sendJson(res, {
      actions: listAdvisorActions(db, {
        periodStart: url.searchParams.get('periodStart'),
        periodEnd: url.searchParams.get('periodEnd')
      }),
      statuses: ADVISOR_ACTION_STATUSES
    });
    return;
  }
  if (url.pathname === '/api/advisor-actions' && req.method === 'POST') {
    handleAdvisorActionUpsert(req, res);
    return;
  }
  if (url.pathname.startsWith('/api/advisor-actions/') && req.method === 'DELETE') {
    handleAdvisorActionDelete(req, url, res);
    return;
  }
  if (url.pathname === '/api/live' && req.method === 'GET') {
    if (!validateLocalRead(req, res, '实时监控接口')) return;
    const schedule = scheduledCollectConfig();
    const latestRun = latestCollectionRun();
    const windowMinutes = Number(url.searchParams.get('windowMinutes') || 15);
    if (!Number.isFinite(windowMinutes) || windowMinutes < 1 || windowMinutes > 10_080) {
      sendJson(res, { error: 'windowMinutes must be between 1 and 10080.' }, 400);
      return;
    }
    const budgetProfiles = listBudgetProfiles(db).filter(profile => profile.enabled);
    sendJson(res, buildLiveSnapshot({
      sessions: liveSessions(),
      tokenEvents: liveTokenEvents({ windowMinutes, budgetProfiles }),
      budgetProfiles,
      runs: all(`
        SELECT device, source, status, message, collected_at AS collectedAt
        FROM collection_runs
        ORDER BY id DESC
        LIMIT 5
      `),
      windowMinutes,
      latestEventAt: latestTokenEventAt(),
      latestCollectionRunAt: collectionState.finishedAt || latestRun?.collectedAt || null,
      collectionState,
      refreshIntervalSeconds: schedule.intervalSeconds,
      autoCollectEnabled: schedule.enabled,
      demoMode: demoModeEnabled()
    }));
    return;
  }
  if (url.pathname === '/api/privacy-check' && req.method === 'GET') {
    if (!validateLocalRead(req, res, '隐私检查接口')) return;
    sendJson(res, runPrivacyCheck());
    return;
  }
  if (url.pathname === '/api/model-policy.md' && req.method === 'GET') {
    if (!validateLocalRead(req, res, '模型策略接口')) return;
    const { sessions } = buildAutoAttributionContext();
    sendText(res, formatModelPolicyMarkdown(buildModelPolicy({ sessions })), 'text/markdown; charset=utf-8');
    return;
  }
  if (url.pathname === '/api/work-items' && req.method === 'GET') {
    if (!validateLocalRead(req, res, '工作项接口')) return;
    sendJson(res, { workItems: listWorkItems(db) });
    return;
  }
  if (url.pathname === '/api/work-items' && req.method === 'POST') {
    handleWorkItemUpsert(req, res);
    return;
  }
  if (url.pathname === '/api/work-items/link-sessions' && req.method === 'POST') {
    handleWorkItemLinkSessions(req, res);
    return;
  }
  if (url.pathname.startsWith('/api/work-items/') && req.method === 'DELETE') {
    handleWorkItemDelete(req, url, res);
    return;
  }
  if (url.pathname === '/api/project-alias-rules' && req.method === 'GET') {
    if (!validateLocalRead(req, res, '项目别名规则接口')) return;
    sendJson(res, { rules: listProjectAliasRules(db), matchTypes: PROJECT_ALIAS_MATCH_TYPES });
    return;
  }
  if (url.pathname === '/api/auto-attribution/suggestions' && req.method === 'GET') {
    handleAutoAttributionSuggestions(req, url, res);
    return;
  }
  if (url.pathname === '/api/auto-attribution/apply' && req.method === 'POST') {
    handleAutoAttributionApply(req, res);
    return;
  }
  if (url.pathname === '/api/auto-attribution/undo' && req.method === 'POST') {
    handleAutoAttributionUndo(req, res);
    return;
  }
  if (url.pathname === '/api/project-alias-rules' && req.method === 'POST') {
    handleProjectAliasRuleUpsert(req, res);
    return;
  }
  if (url.pathname === '/api/project-alias-rules' && req.method === 'DELETE') {
    handleProjectAliasRuleDelete(req, url, res);
    return;
  }
  if (url.pathname === '/api/session-annotations/batch' && req.method === 'POST') {
    handleSessionAnnotationBatch(req, res);
    return;
  }
  if (url.pathname === '/api/session-annotations' && req.method === 'POST') {
    handleSessionAnnotationUpsert(req, res);
    return;
  }
  if (url.pathname === '/api/session-annotations' && req.method === 'DELETE') {
    handleSessionAnnotationDelete(req, url, res);
    return;
  }
  if (url.pathname === '/api/session-outputs' && req.method === 'POST') {
    handleSessionOutputUpsert(req, res);
    return;
  }
  if (url.pathname === '/api/session-outputs' && req.method === 'DELETE') {
    handleSessionOutputDelete(req, url, res);
    return;
  }
  if (url.pathname === '/api/backup' && req.method === 'POST') {
    handleBackup(req, res);
    return;
  }
  if (url.pathname === '/api/export/annotations' && req.method === 'GET') {
    handleExportAnnotations(req, res);
    return;
  }
  if (url.pathname === '/api/import/annotations' && req.method === 'POST') {
    handleImportAnnotations(req, res);
    return;
  }
  if (url.pathname === '/api/import/ccusage-json' && req.method === 'POST') {
    handleImportCcusageJson(req, res);
    return;
  }
  if (url.pathname === '/api/ingest' && req.method === 'POST') {
    handleIngest(req, res);
    return;
  }
  if (url.pathname === '/api/collect' && req.method === 'POST') {
    handleCollect(req, res);
    return;
  }
  if (url.pathname === '/api/collect/status' && req.method === 'GET') {
    if (!validateLocalRead(req, res, '采集状态接口')) return;
    sendJson(res, collectionState);
    return;
  }
  sendJson(res, { error: 'Not found' }, 404);
}

async function handleProjectAliasRuleUpsert(req, res) {
  if (!validateLocalJsonWrite(req, res, '项目别名规则接口')) return;

  try {
    const rule = upsertProjectAliasRule(db, await readJson(req, 64 * 1024));
    sendJson(res, { ok: true, rule: { ...rule, enabled: Boolean(rule.enabled) } });
  } catch (error) {
    sendJson(res, { error: error.message }, 400);
  }
}

async function handleBudgetProfileUpsert(req, res) {
  if (!validateLocalJsonWrite(req, res, '预算配置接口')) return;

  try {
    const profile = upsertBudgetProfile(db, await readJson(req, 64 * 1024));
    sendJson(res, { ok: true, profile });
  } catch (error) {
    sendJson(res, { error: error.message }, 400);
  }
}

async function handleBudgetProfileDelete(req, url, res) {
  if (!validateLocalJsonWrite(req, res, '预算配置接口')) return;

  try {
    const payload = req.headers['content-length'] === '0'
      ? Object.fromEntries(url.searchParams.entries())
      : { ...Object.fromEntries(url.searchParams.entries()), ...await readJson(req, 64 * 1024) };
    const deleted = deleteBudgetProfile(db, payload);
    sendJson(res, { ok: true, deleted });
  } catch (error) {
    sendJson(res, { error: error.message }, 400);
  }
}

async function handleAdvisorActionUpsert(req, res) {
  if (!validateLocalJsonWrite(req, res, '建议行动接口')) return;

  try {
    const action = upsertAdvisorAction(db, await readJson(req, 128 * 1024));
    sendJson(res, { ok: true, action });
  } catch (error) {
    sendJson(res, { error: error.message }, 400);
  }
}

async function handleAdvisorActionDelete(req, url, res) {
  if (!validateLocalJsonWrite(req, res, '建议行动接口')) return;

  try {
    const id = url.pathname.split('/').pop();
    const deleted = deleteAdvisorAction(db, { id });
    sendJson(res, { ok: true, deleted });
  } catch (error) {
    sendJson(res, { error: error.message }, 400);
  }
}

async function handleWorkItemUpsert(req, res) {
  if (!validateLocalJsonWrite(req, res, '工作项接口')) return;

  try {
    const workItem = upsertWorkItem(db, await readJson(req, 128 * 1024));
    sendJson(res, { ok: true, workItem });
  } catch (error) {
    sendJson(res, { error: error.message }, 400);
  }
}

async function handleWorkItemLinkSessions(req, res) {
  if (!validateLocalJsonWrite(req, res, '工作项绑定接口')) return;

  try {
    const result = linkWorkItemSessions(db, await readJson(req, 256 * 1024));
    sendJson(res, { ok: true, ...result });
  } catch (error) {
    sendJson(res, { error: error.message }, 400);
  }
}

async function handleWorkItemDelete(req, url, res) {
  if (!validateLocalJsonWrite(req, res, '工作项接口')) return;

  try {
    const id = url.pathname.split('/').pop();
    const deleted = deleteWorkItem(db, { id });
    sendJson(res, { ok: true, deleted });
  } catch (error) {
    sendJson(res, { error: error.message }, 400);
  }
}

async function handleProjectAliasRuleDelete(req, url, res) {
  if (!validateLocalJsonWrite(req, res, '项目别名规则接口')) return;

  try {
    const payload = req.headers['content-length'] === '0'
      ? Object.fromEntries(url.searchParams.entries())
      : { ...Object.fromEntries(url.searchParams.entries()), ...await readJson(req, 64 * 1024) };
    const deleted = deleteProjectAliasRule(db, payload);
    sendJson(res, { ok: true, deleted });
  } catch (error) {
    sendJson(res, { error: error.message }, 400);
  }
}

function handleAutoAttributionSuggestions(req, url, res) {
  if (!validateLocalRead(req, res, '自动归因建议接口')) return;

  const threshold = parseThreshold(url.searchParams.get('threshold'));
  const { sessions, projectAliasRules } = buildAutoAttributionContext();
  const plan = buildAutoAttributionPlan({ sessions, projectAliasRules, threshold });
  sendJson(res, { ok: true, plan });
}

function handleEvidenceSuggestions(req, url, res) {
  if (!validateLocalRead(req, res, '复盘证据建议接口')) return;

  try {
    const { sessions, projectAliasRules } = buildAutoAttributionContext();
    const plan = buildEvidenceAutopilotPlan({
      sessions,
      projectAliasRules,
      period: url.searchParams.get('period') || 'month',
      threshold: parseThreshold(url.searchParams.get('threshold'))
    });
    sendJson(res, { ok: true, plan });
  } catch (error) {
    sendJson(res, { error: error.message }, 400);
  }
}

function handleEvidenceFlywheel(req, url, res) {
  if (!validateLocalRead(req, res, '证据飞轮接口')) return;

  try {
    const { sessions, projectAliasRules } = buildAutoAttributionContext();
    const sourceHealthRows = sourceHealth();
    const coverageBridge = buildCoverageBridge({ sourceHealth: sourceHealthRows });
    const evidencePlan = buildEvidenceAutopilotPlan({
      sessions,
      projectAliasRules,
      period: url.searchParams.get('period') || 'month',
      threshold: parseThreshold(url.searchParams.get('threshold')),
      scanGit: false
    });
    const flywheel = buildEvidenceFlywheel({
      sessions,
      workItems: listWorkItems(db),
      advisorActions: listAdvisorActions(db),
      evidencePlan,
      coverageBridge
    });
    sendJson(res, { ok: true, flywheel, coverageBridge });
  } catch (error) {
    sendJson(res, { error: error.message }, 400);
  }
}

async function handleEvidenceSuggestionsApply(req, res) {
  if (!validateLocalJsonWrite(req, res, '复盘证据建议接口')) return;

  try {
    const payload = await readJson(req, 256 * 1024);
    const { sessions, projectAliasRules } = buildAutoAttributionContext();
    const plan = buildEvidenceAutopilotPlan({
      sessions,
      projectAliasRules,
      period: typeof payload.period === 'string' ? payload.period : 'month',
      threshold: parseThreshold(payload.threshold)
    });
    const requested = suggestionIdSet(payload.suggestionIds || payload.suggestions);
    const hasApplicable = plan.suggestions.some(item => requested.has(item.suggestionId) && item.canApply);
    const backup = hasApplicable ? createDbBackup({ reason: 'evidence-autopilot' }) : null;
    const result = applyEvidenceSuggestions(db, plan, payload);
    sendJson(res, { ok: true, ...result, backup, plan });
  } catch (error) {
    sendJson(res, { error: error.message }, 400);
  }
}

async function handleAutoAttributionApply(req, res) {
  if (!validateLocalJsonWrite(req, res, '自动归因接口')) return;

  try {
    const payload = await readJson(req, 256 * 1024);
    const threshold = parseThreshold(payload.threshold);
    const requested = identitySet(payload.sessions);
    const { sessions, projectAliasRules } = buildAutoAttributionContext();
    const plan = buildAutoAttributionPlan({ sessions, projectAliasRules, threshold });
    const suggestions = plan.suggestions.filter(item =>
      item.canApply && (!requested || requested.has(identityKey(item)))
    );
    if (!suggestions.length) {
      sendJson(res, { ok: true, applied: 0, skippedLowConfidence: plan.lowConfidenceCount, skippedProtected: 0, runId: null, backup: null, plan });
      return;
    }
    const backup = createDbBackup({ reason: 'auto-attribution' });
    const result = applyAutoSessionAnnotations(db, suggestions, {
      threshold,
      runId: typeof payload.runId === 'string' ? payload.runId : undefined
    });
    sendJson(res, { ok: true, ...result, backup, plan });
  } catch (error) {
    sendJson(res, { error: error.message }, 400);
  }
}

async function handleAutoAttributionUndo(req, res) {
  if (!validateLocalJsonWrite(req, res, '自动归因撤销接口')) return;

  try {
    const payload = await readJson(req, 64 * 1024);
    const backup = createDbBackup({ reason: 'auto-attribution-undo' });
    const deleted = undoAutoSessionAnnotations(db, payload);
    sendJson(res, { ok: true, deleted, runId: payload.runId || payload.autoRunId || payload.auto_run_id, backup });
  } catch (error) {
    sendJson(res, { error: error.message }, 400);
  }
}

async function handleSessionAnnotationBatch(req, res) {
  if (!validateLocalJsonWrite(req, res, '批量标注接口')) return;

  try {
    const result = batchUpsertSessionAnnotations(db, await readJson(req, 512 * 1024));
    sendJson(res, { ok: true, ...result });
  } catch (error) {
    sendJson(res, { error: error.message }, 400);
  }
}

async function handleSessionAnnotationUpsert(req, res) {
  if (!validateLocalJsonWrite(req, res, '标注接口')) return;

  try {
    const annotation = upsertSessionAnnotation(db, await readJson(req, 64 * 1024));
    sendJson(res, { ok: true, annotation });
  } catch (error) {
    sendJson(res, { error: error.message }, 400);
  }
}

async function handleSessionAnnotationDelete(req, url, res) {
  if (!validateLocalJsonWrite(req, res, '标注接口')) return;

  try {
    const payload = req.headers['content-length'] === '0'
      ? Object.fromEntries(url.searchParams.entries())
      : { ...Object.fromEntries(url.searchParams.entries()), ...await readJson(req, 64 * 1024) };
    const deleted = deleteSessionAnnotation(db, payload);
    sendJson(res, { ok: true, deleted });
  } catch (error) {
    sendJson(res, { error: error.message }, 400);
  }
}

async function handleSessionOutputUpsert(req, res) {
  if (!validateLocalJsonWrite(req, res, '产出链接接口')) return;

  try {
    const output = upsertSessionOutput(db, await readJson(req, 64 * 1024));
    sendJson(res, { ok: true, output });
  } catch (error) {
    sendJson(res, { error: error.message }, 400);
  }
}

async function handleSessionOutputDelete(req, url, res) {
  if (!validateLocalJsonWrite(req, res, '产出链接接口')) return;

  try {
    const payload = req.headers['content-length'] === '0'
      ? Object.fromEntries(url.searchParams.entries())
      : { ...Object.fromEntries(url.searchParams.entries()), ...await readJson(req, 64 * 1024) };
    const deleted = deleteSessionOutput(db, payload);
    sendJson(res, { ok: true, deleted });
  } catch (error) {
    sendJson(res, { error: error.message }, 400);
  }
}

async function handleBackup(req, res) {
  if (!validateLocalJsonWrite(req, res, '备份接口')) return;

  try {
    await readJson(req, 64 * 1024);
    const backup = createDbBackup({ reason: 'manual' });
    sendJson(res, { ok: true, backup });
  } catch (error) {
    sendJson(res, { error: error.message }, 500);
  }
}

function handleExportAnnotations(req, res) {
  if (!validateLocalRead(req, res, '导出接口')) return;
  sendJson(res, exportAnnotationData(db));
}

async function handleImportAnnotations(req, res) {
  if (!validateLocalJsonWrite(req, res, '导入接口')) return;

  try {
    const payload = await readJson(req, 5 * 1024 * 1024);
    const hasRows = ['sessionAnnotations', 'annotations', 'sessionOutputs', 'projectAliasRules']
      .some(key => Array.isArray(payload[key]) && payload[key].length > 0);
    const backup = hasRows ? createDbBackup({ reason: 'annotation-import' }) : null;
    const result = importAnnotationData(db, payload);
    sendJson(res, { ok: true, imported: result, backup });
  } catch (error) {
    sendJson(res, { error: error.message }, 400);
  }
}

async function handleImportCcusageJson(req, res) {
  if (!validateLocalJsonWrite(req, res, 'ccusage 导入接口')) return;

  try {
    const body = await readJson(req, 8 * 1024 * 1024);
    const requestedDevice = body.device ?? process.env.COLLECT_DEVICE;
    if (typeof requestedDevice !== 'string' || !requestedDevice.trim()) {
      throw new Error('来源设备不能为空；同一台电脑请始终使用相同名称');
    }
    if (body.apply != null && typeof body.apply !== 'boolean') {
      throw new Error('apply 必须是布尔值');
    }
    const apply = body.apply === true;
    const input = body.payload != null
      ? parseCcusageJsonText(JSON.stringify(body.payload))
      : parseCcusageJsonText(body.text || body.json || '');
    const plan = planCcusageImport(input, {
      device: requestedDevice.trim()
    });
    const summary: InputRecord = {
      ok: true,
      mode: apply ? 'apply' : 'dry-run',
      detectedShape: plan.detectedShape,
      daily: plan.daily.length,
      sessions: plan.sessions.length,
      tokenEvents: plan.tokenEvents.length,
      warnings: plan.warnings,
      run: plan.run
    };
    if (apply) {
      assertCcusageImportCanApply(db, plan);
      const backup = ccusageImportWouldChange(db, plan)
        ? createDbBackup({ reason: 'ccusage-import' })
        : null;
      summary.applied = applyCcusageImport(db, plan);
      summary.backup = backup;
    }
    sendJson(res, summary);
  } catch (error) {
    sendJson(res, { error: error.message }, 400);
  }
}

async function handleCollect(req, res) {
  if (!validateLocalJsonWrite(req, res, '采集接口')) return;
  if (demoModeEnabled()) {
    sendJson(res, { error: 'Demo Mode 只使用合成数据，不允许扫描本机 AI 日志。请使用 token-work start 打开真实 SQLite 后再采集。' }, 400);
    return;
  }

  try {
    const payload = await readJson(req, 8 * 1024);
    const reason = payload.reason === 'live-refresh' ? 'live-refresh' : 'manual';
    const started = startCollection({ reason });
    if (!started) {
      sendJson(res, { ...collectionState, error: '采集正在运行' }, 409);
      return;
    }
    sendJson(res, collectionState, 202);
  } catch (error) {
    sendJson(res, { error: error.message }, 500);
  }
}

function startCollection({ reason = 'manual' } = {}) {
  if (activeCollection && (activeCollection.exitCode != null || activeCollection.signalCode != null)) {
    activeCollection = null;
  }
  if (shuttingDown || activeCollection) {
    return false;
  }

  const sources = LIVE_COLLECT_SOURCES;
  const args = [collectionEntryPoint(), '--apply', '--yes', '--sources', sources, '--json'];
  const device = collectionDevice();
  if (device) args.push('--device', device);
  if (process.env.DB_PATH) args.push('--db', process.env.DB_PATH);

  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TOKEN_WORK_COLLECTORS: sources,
      TOKEN_WORK_COLLECT_CONFIRMED: '1',
      TOKEN_WORK_COLLECT_REASON: reason,
      // The server refreshes an existing database. A first run has no prior
      // collection record and therefore still falls back to a full scan.
      TOKEN_WORK_SCHEDULED_INCREMENTAL: '1',
      // WorkBuddy may keep a trace open without advancing its file mtime.
      // A user-requested refresh must still reread its structured usage.
      TOKEN_WORK_FULL_REFRESH_SOURCES: reason === 'live-refresh' || reason === 'manual'
        ? 'workbuddy'
        : ''
    },
    detached: process.platform !== 'win32',
    windowsHide: true
  });

  activeCollection = child;
  let stdout = '';
  let stderr = '';
  let completed = false;
  const startedAt = new Date().toISOString();
  collectionState = {
    status: 'running',
    message: reason === 'scheduled' ? '正在定时采集本机用量' : '正在采集本机用量',
    startedAt,
    finishedAt: null,
    exitCode: null,
    stdout: '',
    stderr: '',
    backup: null,
    summary: null
  };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });

  const complete = code => {
    if (completed || activeCollection !== child) return;
    completed = true;
    activeCollection = null;
    if (collectionAlreadyRunning(stderr)) {
      collectionState = {
        status: 'idle',
        message: '已有采集正在运行，本次请求未重复执行',
        startedAt: null,
        finishedAt: null,
        exitCode: null,
        stdout: '',
        stderr: '',
        backup: null,
        summary: null
      };
      return;
    }
    const parsedSummary = parseCollectSummary(stdout);
    if (parsedSummary) {
      lastCoverageGate = summarizeCoverageGate(parsedSummary);
    }
    collectionState = {
      status: code === 0 ? 'ok' : 'error',
      message: collectionResultMessage({ code, stderr }),
      exitCode: code,
      startedAt,
      finishedAt: new Date().toISOString(),
      stdout: trimOutput(stdout),
      stderr: trimOutput(stderr),
      backup: parsedSummary?.backup || null,
      summary: parsedSummary ? summarizeCollectState(parsedSummary) : null
    };
    if (collectionState.status === 'error') {
      console.error(`[collect] ${collectionState.message}`);
    }
  };

  child.on('error', error => {
    if (completed || activeCollection !== child) return;
    completed = true;
    activeCollection = null;
    collectionState = {
      ...collectionState,
      status: 'error',
      message: `无法启动采集进程：${error.message}`,
      finishedAt: new Date().toISOString(),
      stderr: error.message,
      backup: null
    };
    console.error(`[collect] ${collectionState.message}`);
  });

  child.on('close', complete);
  child.on('exit', code => {
    // `close` normally follows `exit` immediately. An inherited stdio handle
    // must not keep the collection state occupied after the child is gone.
    setTimeout(() => complete(code), 250).unref?.();
  });

  return true;
}

function collectionEntryPoint() {
  const runtimeEntry = resolve(SERVER_DIR, 'collect.mjs');
  return existsSync(runtimeEntry)
    ? runtimeEntry
    : resolve(SERVER_DIR, '..', 'src', 'collect.ts');
}

function collectionResultMessage({ code, stderr }) {
  if (code === 0) return '采集完成';
  const detail = String(stderr || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean);
  const exitCode = code == null ? '未知' : String(code);
  return detail
    ? `采集失败（退出码 ${exitCode}）：${detail.slice(0, 300)}`
    : `采集失败（退出码 ${exitCode}）。`;
}

function collectionAlreadyRunning(stderr) {
  return /A collection is (already running|starting) for this SQLite database/.test(String(stderr || ''));
}

function startScheduledCollect() {
  if (demoModeEnabled()) return;
  const schedule = scheduledCollectConfig();
  if (!schedule.enabled) return;

  console.log(`[collect:schedule] enabled interval=${schedule.intervalSeconds}s runOnStart=${schedule.runOnStart}`);

  const nextDelay = Math.min(schedule.intervalSeconds * 1000, 30_000);
  const scheduleNext = (delay = schedule.intervalSeconds * 1000) => {
    const timer = setTimeout(run, delay);
    timer.unref?.();
  };
  const run = () => {
    if (shuttingDown) return;
    if (activeCollection) {
      // A manual refresh owns the collector. Try again later without creating
      // another child process or emitting a misleading scheduling failure.
      scheduleNext(nextDelay);
      return;
    }
    try {
      startCollection({ reason: 'scheduled' });
    } catch (error) {
      console.log(`[collect:schedule] ${error.message}`);
    }
    scheduleNext();
  };

  if (schedule.runOnStart) {
    scheduleNext(1000);
  } else {
    scheduleNext();
  }
}

function scheduledCollectConfig() {
  const config = loadCollectorConfig().scheduledCollect || {};
  const enabled = envBool('SCHEDULED_COLLECT_ENABLED', config.enabled ?? false);
  const intervalSeconds = Math.max(
    30,
    envNumber(
      'SCHEDULED_COLLECT_INTERVAL_SECONDS',
      envNumber('TOKEN_WORK_LIVE_COLLECT_INTERVAL_SECONDS',
        envNumber('COLLECT_INTERVAL_SECONDS', config.intervalSeconds ?? 300))
      )
  );
  const runOnStart = envBool('SCHEDULED_COLLECT_RUN_ON_START', config.runOnStart ?? false);
  return { enabled, intervalSeconds, runOnStart };
}

function collectionDevice() {
  const config = loadCollectorConfig().scheduledCollect || {};
  return process.env.COLLECT_DEVICE || process.env.SCHEDULED_COLLECT_DEVICE || config.device || null;
}

function envBool(name, fallback) {
  const value = process.env[name];
  if (value == null || value === '') return Boolean(fallback);
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function demoModeEnabled() {
  return envBool('TOKEN_WORK_DEMO_MODE', false);
}

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : Number(fallback);
}

async function handleIngest(req, res) {
  if (!validateIngestJsonWrite(req, res)) return;

  try {
    const payload = await readJson(req, 8 * 1024 * 1024);
    const pricingData = await loadPricing(pricingCachePath);
    const rawDailyRows = ingestRows(payload, 'daily');
    const rawSessionRows = ingestRows(payload, 'sessions');
    const runRows = ingestRows(payload, 'runs');
    const rowCount = rawDailyRows.length + rawSessionRows.length + runRows.length;
    if (rowCount > MAX_INGEST_ROWS) {
      throw new Error(`ingest accepts at most ${MAX_INGEST_ROWS} rows per request`);
    }
    const dailyRows = rawDailyRows.map(row => attachOfficialPricing(
      row,
      row.model,
      providerFromSource(row.source),
      pricingData
    ));
    const sessionRows = rawSessionRows.map(row => attachOfficialPricing(
      row,
      row.model,
      providerFromSource(row.source),
      pricingData
    ));

    db.exec('BEGIN');
    try {
      upsertDailyBatch(db, dailyRows);
      sessionRows.forEach((row) => upsertSession(db, row));
      runRows.forEach((row) => recordRun(db, row));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    sendJson(res, { ok: true, daily: dailyRows.length, sessions: sessionRows.length, runs: runRows.length });
  } catch (error) {
    sendJson(res, { error: error.message }, 400);
  }
}

function serveStatic(pathname, res) {
  const filePath = SPA_ROUTES.has(pathname)
    ? join(staticDir, 'index.html')
    : join(staticDir, pathname);
  let isFile = false;
  try {
    isFile = filePath.startsWith(`${staticDir}${sep}`) && statSync(filePath).isFile();
  } catch {
    // Missing or inaccessible assets are not served.
  }
  if (!isFile) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  res.writeHead(200, { 'content-type': contentType(filePath) });
  const stream = createReadStream(filePath);
  stream.on('error', () => {
    if (res.headersSent) res.destroy();
    else {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Unable to read asset');
    }
  });
  res.once('close', () => stream.destroy());
  stream.pipe(res);
}

function one(sql) {
  return db.prepare(sql).get();
}

function all(sql) {
  return db.prepare(sql).all();
}

function liveSessions() {
  return all(`
    SELECT device, source, session_id AS sessionId, last_activity AS lastActivity,
      project_path AS projectPath, model,
      input_tokens AS inputTokens,
      output_tokens AS outputTokens,
      cache_creation_tokens AS cacheCreationTokens,
      cache_read_tokens AS cacheReadTokens,
      cached_input_tokens AS cachedInputTokens,
      reasoning_output_tokens AS reasoningOutputTokens,
      total_tokens AS totalTokens,
      cost_usd AS costUSD
    FROM session_usage
    ORDER BY last_activity DESC
    LIMIT 100
  `).map(session => ({
    ...session,
    model: session.model || modelFromSessionId(session.sessionId)
  }));
}

function liveTokenEvents({ windowMinutes = 15, budgetProfiles = [] } = {}) {
  const windows = [
    Number(windowMinutes),
    ...budgetProfiles.map(profile => Number(profile.windowMinutes))
  ].filter(value => Number.isFinite(value) && value > 0);
  const maxWindowMinutes = Math.min(10_080, Math.max(1, ...windows));
  const since = new Date(Date.now() - maxWindowMinutes * 60 * 1000).toISOString();
  return db.prepare(`
    SELECT event_id AS eventId, device, source, session_id AS sessionId,
      timestamp, model,
      input_tokens AS inputTokens,
      output_tokens AS outputTokens,
      cache_read_tokens AS cacheReadTokens,
      cache_creation_tokens AS cacheCreationTokens,
      reasoning_tokens AS reasoningTokens,
      tool_category AS toolCategory,
      file_extension AS fileExtension
    FROM token_events
    WHERE timestamp >= ?
    ORDER BY timestamp DESC
  `).all(since);
}

function buildLocalTrustPayload() {
  const { sessions, projectAliasRules } = buildAutoAttributionContext();
  const daily = all(`
    SELECT rowid AS id, device, source,
      usage_date AS usageDate, model,
      input_tokens AS inputTokens,
      output_tokens AS outputTokens,
      cache_creation_tokens AS cacheCreationTokens,
      cache_read_tokens AS cacheReadTokens,
      cached_input_tokens AS cachedInputTokens,
      reasoning_output_tokens AS reasoningOutputTokens,
      total_tokens AS totalTokens,
      cost_usd AS costUSD
    FROM daily_usage
    ORDER BY usage_date DESC
  `).map(row => attachOfficialPricing(row, row.model, providerFromSource(row.source)));
  const runs = all(`
    SELECT id, device, source, status, message, collected_at AS collectedAt
    FROM collection_runs
    ORDER BY id DESC
    LIMIT 1000
  `);
  const workItems = listWorkItems(db);
  const advisorActions = listAdvisorActions(db);
  const tokenEvents = listTokenEvents(db, { limit: 1000 });
  const tokenEventTotals = tokenEventTotalRows();
  const runtime = runtimeMetadata();
  const sourceHealthRows = sourceHealth();
  const coverageBridge = buildCoverageBridge({ sourceHealth: sourceHealthRows });
  const evidencePlan = buildEvidenceAutopilotPlan({
    sessions,
    projectAliasRules,
    period: 'all',
    threshold: AUTO_ATTRIBUTION_THRESHOLD,
    scanGit: false
  });
  const evidenceFlywheel = buildEvidenceFlywheel({
    sessions,
    workItems,
    advisorActions,
    evidencePlan,
    coverageBridge
  });
  return {
    daily,
    sessions,
    runs,
    tokenEvents,
    localTrust: buildLocalTrust({
      runtime,
      coverageBridge,
      sourceHealth: sourceHealthRows,
      daily,
      sessions,
      tokenEvents,
      tokenEventTotals,
      runs,
      evidenceFlywheel
    })
  };
}

function tokenEventTotalRows() {
  return all(`
    SELECT source,
      COALESCE(SUM(input_tokens), 0) AS inputTokens,
      COALESCE(SUM(output_tokens), 0) AS outputTokens,
      COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
      COALESCE(SUM(cache_creation_tokens), 0) AS cacheCreationTokens,
      COALESCE(SUM(reasoning_tokens), 0) AS reasoningTokens
    FROM token_events
    GROUP BY source
  `);
}

function sourceHealth(collectors = detectCollectors()) {
  return buildSourceHealth({
    collectors,
    dailyRows: all(`
      SELECT source,
        COUNT(*) AS count,
        COALESCE(SUM(total_tokens), 0) AS totalTokens,
        MAX(usage_date) AS latestDailyAt
      FROM daily_usage
      GROUP BY source
    `),
    sessionRows: all(`
      SELECT source,
        COUNT(*) AS count,
        COALESCE(SUM(total_tokens), 0) AS totalTokens,
        MAX(last_activity) AS latestSessionAt
      FROM session_usage
      GROUP BY source
    `),
    eventRows: all(`
      SELECT source,
        COUNT(*) AS count,
        COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens + reasoning_tokens), 0) AS totalTokens,
        MAX(timestamp) AS latestEventAt
      FROM token_events
      GROUP BY source
    `),
    runs: all(`
      SELECT r.source, r.status, r.message, r.collected_at AS collectedAt
      FROM collection_runs r
      JOIN (
        SELECT source, MAX(id) AS id
        FROM collection_runs
        GROUP BY source
      ) latest ON latest.id = r.id
      ORDER BY r.id DESC
    `)
  });
}

function runtimeMetadata() {
  const counts = databaseCounts();
  const demoMode = demoModeEnabled();
  const coverageGate = lastCoverageGate || defaultCoverageGate(demoMode);
  const dataMode = dataModeFor({
    demoMode,
    counts,
    coverageGate,
    hasVerifiedEventRun: hasTrustedEventCollectionRun()
  });
  return {
    packageVersion,
    demoMode,
    db: {
      kind: demoMode ? 'demo sqlite' : 'real sqlite',
      fileName: basename(dbPath || defaultDbPath)
    },
    server: serverSecurityMetadata(),
    counts,
    dataMode,
    latestCollectionRun: latestCollectionRun(),
    collectionCoverageAvailable: true,
    coverageGate
  };
}

function serverSecurityMetadata() {
  const bindHost = String(host || '').trim();
  const loopbackBind = isLoopbackBindHost(bindHost);
  const allowRemote = remoteAccessEnabled();
  const ingestTokenConfigured = Boolean(String(process.env.INGEST_TOKEN || '').trim());
  return {
    bindHost: loopbackBind ? bindHost : 'non-loopback',
    loopbackBind,
    allowRemote,
    remoteIngestMode: !loopbackBind && allowRemote && ingestTokenConfigured,
    ingestTokenConfigured,
    dashboardApiRemoteAccess: false,
    readGuard: 'loopback + local Origin',
    writeGuard: 'local writes: loopback + local Origin + JSON; ingest: disabled unless INGEST_TOKEN Bearer JSON',
    xForwardedForTrusted: false
  };
}

function databaseCounts() {
  return one(`
    SELECT
      (SELECT COUNT(*) FROM daily_usage) AS dailyRows,
      (SELECT COUNT(*) FROM session_usage) AS sessionRows,
      (SELECT COUNT(*) FROM token_events) AS tokenEventRows,
      (SELECT COUNT(*) FROM collection_runs) AS collectionRuns
  `);
}

function latestCollectionRun() {
  const row = one(`
    SELECT source, status, message, collected_at AS collectedAt
    FROM collection_runs
    ORDER BY id DESC
    LIMIT 1
  `);
  if (!row) return null;
  return {
    source: row.source || null,
    status: row.status || null,
    message: row.message ? String(row.message).replace(/\n/g, ' ').replace(/\s+/g, ' ').slice(0, 300) : null,
    collectedAt: row.collectedAt || null
  };
}

function latestTokenEventAt() {
  const row = one(`
    SELECT MAX(timestamp) AS latestEventAt
    FROM token_events
  `);
  return row?.latestEventAt || null;
}

function hasTrustedEventCollectionRun() {
  const rows = all(`
    SELECT status, message
    FROM collection_runs
    ORDER BY id DESC
    LIMIT 20
  `);
  return rows.some(row => {
    if (row.status !== 'ok') return false;
    const match = String(row.message || '').match(/token_events=(\d+)/);
    return match && Number(match[1]) > 0;
  });
}

function defaultCoverageGate(demoMode) {
  return {
    status: 'not-run',
    checkedAt: null,
    message: demoMode
      ? 'Demo mode uses synthetic data.'
      : '尚未运行本机历史 coverage gate。'
  };
}

function dataModeFor({ demoMode, counts, coverageGate, hasVerifiedEventRun = false }) {
  if (demoMode) {
    return {
      id: 'demo',
      label: 'Demo Mode',
      severity: 'demo',
      message: '当前是合成演示数据，不代表真实采集成功。'
    };
  }
  const dailyRows = Number(counts.dailyRows || 0);
  const sessionRows = Number(counts.sessionRows || 0);
  const tokenEventRows = Number(counts.tokenEventRows || 0);
  if (dailyRows + sessionRows + tokenEventRows === 0) {
    return {
      id: 'empty',
      label: 'Empty DB',
      severity: 'empty',
      message: '当前 SQLite 没有真实 token 数据，需要先导入或运行真实采集。'
    };
  }
  const coverageVerified = coverageGate?.status === 'passed' || hasVerifiedEventRun;
  if (tokenEventRows > 0 && coverageVerified) {
    return {
      id: 'real-event-verified',
      label: 'Local SQLite · event-level',
      severity: 'ok',
      message: '当前本地 SQLite 存在 event 级 token 记录，并且最近只读 coverage 或采集运行可追溯。'
    };
  }
  if (tokenEventRows > 0) {
    return {
      id: 'real-event-unverified',
      label: 'Local SQLite · needs coverage',
      severity: 'warn',
      message: '当前本地 SQLite 有 token_events，但当前服务还没看到通过的只读 coverage；请先检查后再判断可信度。'
    };
  }
  return {
    id: 'real-aggregate-only',
    label: 'Local SQLite · aggregate only',
    severity: 'warn',
    message: '当前本地 SQLite 只有 daily/session 聚合行，没有 token_events；只能看趋势，不能证明 event 级历史。'
  };
}

function summarizeCoverageGate(summary: InputRecord = {}) {
  const sources = Array.isArray(summary.sources) ? summary.sources : [];
  const totals = inputRecord(summary.totals);
  const fatal = Number(totals.fatalCoverageErrors || 0);
  const eventSources = sources.filter(source => Number(source.tokenEvents || 0) > 0);
  const trustedSources = sources.filter(source => source.coverageRisk === 'trusted-event-level');
  const cursorNoToken = sources.some(source => source.id === 'cursor' && source.coverageRisk === 'detected-no-token-fields');
  const ok = fatal === 0 && trustedSources.length > 0;
  return {
    status: ok ? 'passed' : 'failed',
    checkedAt: summary.collectedAt || new Date().toISOString(),
    mode: summary.mode || null,
    trustedSourceCount: trustedSources.length,
    eventSourceCount: eventSources.length,
    fatalCoverageErrors: fatal,
    cursorNoTokenFields: cursorNoToken,
    totalTokenEvents: Number(totals.tokenEvents || 0),
    firstTimestamp: totals.firstTimestamp || null,
    lastTimestamp: totals.lastTimestamp || null,
    message: ok
      ? 'coverage gate passed for event-level token history.'
      : 'coverage gate did not find trusted event-level token history.'
  };
}

function parseCollectSummary(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function summarizeCollectState(summary) {
  return {
    ok: Boolean(summary.ok),
    mode: summary.mode,
    dailyRows: Number(summary.totals?.dailyRows || 0),
    sessionRows: Number(summary.totals?.sessionRows || 0),
    tokenEvents: Number(summary.totals?.tokenEvents || 0),
    coverageRisks: (summary.sources || []).map(source => ({
      id: source.id,
      risk: source.coverageRisk,
      tokenEvents: Number(source.tokenEvents || 0)
    }))
  };
}

function collectionCoverageDryRun({ sources = `${LIVE_COLLECT_SOURCES},cursor` } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [
      collectionEntryPoint(),
      '--dry-run',
      '--sources',
      sources,
      '--json'
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TOKEN_WORK_COLLECTORS: sources
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', rejectRun);
    child.on('close', code => {
      if (code !== 0) {
        rejectRun(new Error((stderr || stdout || `collection coverage dry-run failed with exit code ${code}`).trim()));
        return;
      }
      try {
        resolveRun(JSON.parse(stdout));
      } catch (error) {
        rejectRun(new Error(`collection coverage dry-run returned invalid JSON: ${error.message}`));
      }
    });
  });
}

function demoCollectionCoverage() {
  return {
    ok: true,
    mode: 'demo',
    demoMode: true,
    collectedAt: new Date().toISOString(),
    totals: {
      dailyRows: 2,
      sessionRows: 3,
      tokenEvents: 3,
      candidateFiles: 0,
      usableTokenRecords: 0,
      dailyTotalTokens: 1042000,
      sessionTotalTokens: 1042000,
      eventTotalTokens: 1042000,
      firstTimestamp: null,
      lastTimestamp: null,
      fatalCoverageErrors: 0
    },
    sources: [
      {
        id: 'demo',
        label: 'Demo Mode',
        status: 'ok',
        coverageRisk: 'demo-data',
        coverageStatus: '合成演示数据，不代表真实采集成功。请运行 token-work coverage 查看本机历史覆盖。',
        dailyRows: 2,
        sessionRows: 3,
        tokenEvents: 3,
        candidateFiles: 0,
        usableTokenRecords: 0,
        eventTotalTokens: 1042000
      }
    ]
  };
}

function buildAutoAttributionContext() {
  const aliasRules = listProjectAliasRules(db);
  const enabledAliasRules = aliasRules.filter(rule => rule.enabled);
  const rawSessions = all(`
    SELECT s.device, s.source,
      s.session_id AS sessionId,
      s.last_activity AS lastActivity,
      s.project_path AS projectPath,
      s.model,
      s.input_tokens AS inputTokens,
      s.output_tokens AS outputTokens,
      s.cache_creation_tokens AS cacheCreationTokens,
      s.cache_read_tokens AS cacheReadTokens,
      s.cached_input_tokens AS cachedInputTokens,
      s.reasoning_output_tokens AS reasoningOutputTokens,
      s.total_tokens AS totalTokens,
      s.cost_usd AS costUSD,
      a.project_alias AS manualProjectAlias,
      COALESCE(a.task_type, '未分类') AS taskType,
      COALESCE(a.output_status, '未标注') AS outputStatus,
      COALESCE(a.work_purpose, '未说明') AS workPurpose,
      COALESCE(a.work_stage, '未说明') AS workStage,
      COALESCE(a.value_level, '未评估') AS valueLevel,
      a.note,
      a.annotation_source AS annotationSource,
      a.annotation_confidence AS annotationConfidence,
      a.annotation_reason AS annotationReason,
      a.auto_version AS autoVersion,
      a.auto_run_id AS autoRunId,
      a.auto_updated_at AS autoUpdatedAt,
      a.updated_at AS annotationUpdatedAt,
      o.output_url AS outputUrl,
      o.output_label AS outputLabel,
      COALESCE(o.output_type, '未分类') AS outputType,
      o.updated_at AS outputUpdatedAt
    FROM session_usage s
    LEFT JOIN session_annotations a
      ON a.device = s.device
      AND a.source = s.source
      AND a.session_id = s.session_id
    LEFT JOIN session_outputs o
      ON o.device = s.device
      AND o.source = s.source
      AND o.session_id = s.session_id
    ORDER BY s.total_tokens DESC
  `);
  const sessions = rawSessions.map(s => {
    const projectPath = normalizeProjectPath(s.projectPath, s.sessionId);
    const ruleProjectAlias = matchProjectAliasRule(projectPath, enabledAliasRules);
    const model = s.model || modelFromSessionId(s.sessionId);
    return attachOfficialPricing({
      ...s,
      ...DEFAULT_SESSION_ANNOTATION,
      model,
      lastActivity: s.lastActivity ? String(s.lastActivity).slice(0, 10) : null,
      projectPath,
      projectAlias: s.manualProjectAlias || ruleProjectAlias || null,
      manualProjectAlias: s.manualProjectAlias || null,
      ruleProjectAlias,
      taskType: s.taskType || DEFAULT_SESSION_ANNOTATION.taskType,
      outputStatus: s.outputStatus || DEFAULT_SESSION_ANNOTATION.outputStatus,
      workPurpose: s.workPurpose || DEFAULT_SESSION_ANNOTATION.workPurpose,
      workStage: s.workStage || DEFAULT_SESSION_ANNOTATION.workStage,
      valueLevel: s.valueLevel || DEFAULT_SESSION_ANNOTATION.valueLevel,
      note: s.note || null,
      annotationSource: s.annotationSource || null,
      annotationConfidence: s.annotationConfidence == null ? null : Number(s.annotationConfidence),
      annotationReason: s.annotationReason || null,
      autoVersion: s.autoVersion || null,
      autoRunId: s.autoRunId || null,
      autoUpdatedAt: s.autoUpdatedAt || null,
      attributionQuality: attributionQuality(s.annotationSource, s.annotationConfidence, s.annotationUpdatedAt),
      annotationUpdatedAt: s.annotationUpdatedAt || null,
      outputUrl: s.outputUrl || null,
      outputLabel: s.outputLabel || null,
      outputType: s.outputType || DEFAULT_SESSION_ANNOTATION.outputType,
      outputUpdatedAt: s.outputUpdatedAt || null
    }, model, providerFromSource(s.source));
  });
  return { sessions, projectAliasRules: aliasRules };
}

function normalizeProjectPath(projectPath, sessionId) {
  return (projectPath && projectPath !== 'Unknown Project')
    ? projectPath
    : (sessionId ? sessionId.split('/').slice(-1)[0] || sessionId : null);
}

function attributionQuality(source, confidence, updatedAt) {
  if (!updatedAt) return 'missing';
  if (source === 'auto') return Number(confidence || 0) >= AUTO_ATTRIBUTION_THRESHOLD ? 'auto-high' : 'auto-low';
  return 'manual';
}

function parseThreshold(value) {
  const parsed = Number(value ?? AUTO_ATTRIBUTION_THRESHOLD);
  if (!Number.isFinite(parsed)) return AUTO_ATTRIBUTION_THRESHOLD;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function identitySet(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  return new Set(rows.map(identityKey));
}

function suggestionIdSet(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return new Set(list.map(row => typeof row === 'string' ? row : row?.suggestionId).filter(Boolean));
}

function identityKey(row: InputRecord = {}) {
  return `${row.device || ''}::${row.source || ''}::${row.sessionId || row.session_id || ''}`;
}

function inputRecord(value: unknown): InputRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as InputRecord
    : {};
}

function modelFromSessionId(sessionId) {
  const text = String(sessionId || '').trim();
  if (!text) return null;
  if (text.startsWith('local:')) return text.split(':').at(-1) || null;
  return null;
}

function sendJson(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function sendText(res, value, contentType = 'text/plain; charset=utf-8', status = 200) {
  res.writeHead(status, { 'content-type': contentType });
  res.end(value);
}

function createDbBackup({ reason = 'manual' } = {}) {
  return createSqliteBackup(db, dbPath, { reason });
}

function trimOutput(value) {
  const text = String(value || '').trim();
  return text.length > 12000 ? `${text.slice(-12000)}` : text;
}

function validateHostConfiguration(bindHost, { allowRemote = false, ingestToken = '' } = {}) {
  if (isLoopbackBindHost(bindHost)) return;
  if (!allowRemote) {
    console.error(
      `Refusing to listen on non-loopback host "${bindHost}". `
      + 'Use HOST=127.0.0.1, or set TOKEN_WORK_ALLOW_REMOTE=1 with INGEST_TOKEN for explicit remote ingest mode.'
    );
    process.exit(1);
  }
  if (!String(ingestToken || '').trim()) {
    console.error(
      'Refusing remote bind without INGEST_TOKEN. '
      + 'TOKEN_WORK_ALLOW_REMOTE=1 requires INGEST_TOKEN; Dashboard APIs remain loopback/local-origin only.'
    );
    process.exit(1);
  }
}

function isLoopbackBindHost(bindHost = '') {
  const value = String(bindHost || '').trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (!value) return false;
  if (value === '0.0.0.0' || value === '::') return false;
  return isLoopback(value);
}

function envFlag(name) {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env[name] || '').trim().toLowerCase());
}

function remoteAccessEnabled() {
  return envFlag('TOKEN_WORK_ALLOW_REMOTE');
}

function isLoopback(address = '') {
  const value = String(address || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  return value.startsWith('127.')
    || value === '::1'
    || value.startsWith('::ffff:127.')
    || value === 'localhost';
}

function validateLocalJsonWrite(req, res, label) {
  if (!validateLocalRead(req, res, label)) return false;
  if (!isJsonRequest(req)) {
    sendJson(res, { error: 'Content-Type must be application/json' }, 415);
    return false;
  }
  return true;
}

function validateIngestJsonWrite(req, res) {
  const expectedToken = String(process.env.INGEST_TOKEN || '').trim();
  if (!expectedToken) {
    sendJson(res, { error: 'Ingest disabled. Set INGEST_TOKEN to enable /api/ingest.' }, 403);
    return false;
  }
  if (!isLocalOrigin(req.headers.origin)) {
    sendJson(res, { error: 'ingest 仅允许来自本机页面或无 Origin 的机器请求' }, 403);
    return false;
  }
  if (!isJsonRequest(req)) {
    sendJson(res, { error: 'Content-Type must be application/json' }, 415);
    return false;
  }
  const actualToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!tokensEqual(actualToken, expectedToken)) {
    sendJson(res, { error: 'Unauthorized' }, 401);
    return false;
  }
  return true;
}

function tokensEqual(actual, expected) {
  const actualBytes = Buffer.from(String(actual || ''), 'utf8');
  const expectedBytes = Buffer.from(String(expected || ''), 'utf8');
  return actualBytes.length === expectedBytes.length
    && timingSafeEqual(actualBytes, expectedBytes);
}

function ingestRows(payload, key) {
  if (payload[key] == null) return [];
  if (!Array.isArray(payload[key])) throw new Error(`${key} must be an array`);
  return payload[key];
}

function validateLocalRead(req, res, label) {
  if (!isLoopback(req.socket.remoteAddress)) {
    sendJson(res, { error: `${label}仅允许本机访问` }, 403);
    return false;
  }
  if (!isLocalOrigin(req.headers.origin)) {
    sendJson(res, { error: `${label}仅允许来自本机页面` }, 403);
    return false;
  }
  return true;
}

function isLocalOrigin(origin) {
  if (!origin) return true;
  try {
    const { hostname } = new URL(origin);
    return isLoopback(hostname);
  } catch {
    return false;
  }
}

function isJsonRequest(req) {
  const contentType = req.headers['content-type'] || '';
  return /^application\/json(?:\s*;|$)/i.test(contentType);
}

function readJson(req, maxBytes = 50 * 1024 * 1024): Promise<InputRecord> {
  return new Promise((resolveRequest, rejectRequest) => {
    let body = '';
    let byteLength = 0;
    let tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      if (tooLarge) return;
      byteLength += Buffer.byteLength(chunk, 'utf8');
      if (byteLength > maxBytes) {
        tooLarge = true;
        rejectRequest(new Error('请求体过大'));
        req.resume();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (tooLarge) return;
      try {
        const parsed: unknown = JSON.parse(body || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('JSON 请求体必须是对象');
        }
        resolveRequest(parsed as InputRecord);
      } catch (error) {
        rejectRequest(error);
      }
    });
    req.on('error', error => {
      if (!tooLarge) rejectRequest(error);
    });
  });
}

function contentType(filePath) {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.ts': 'application/javascript; charset=utf-8',
    '.tsx': 'application/javascript; charset=utf-8',
    '.svg': 'image/svg+xml; charset=utf-8',
    '.png': 'image/png',
    '.webmanifest': 'application/manifest+json; charset=utf-8'
  };
  return types[extname(filePath)] || 'application/octet-stream';
}

function readPackageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}
