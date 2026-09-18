import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { configuredClaudeRequestModel } from './claude-settings.ts';
import { canonicalModelName, localDateFromTimestamp } from './collectors/utils.ts';
import { calculateCost } from './pricing.ts';

type InputRecord = Record<string, unknown>;

export const defaultDbPath = resolve(process.cwd(), 'data', 'usage.sqlite');
export const TASK_TYPES = ['未分类', '功能开发', '问题修复', '代码审查', '技术调研', '内容创作', '运维配置', '其他'];
export const OUTPUT_STATUSES = ['未标注', '进行中', '已完成', '已发布', '已废弃'];
const DEFAULT_MAX_BACKUPS = 1;
export const WORK_PURPOSES = ['未说明', '需求澄清', '方案设计', '功能开发', '调试修复', '测试验证', '代码审查', '技术调研', '文档内容', '部署运维', '上下文整理', '其他'];
export const WORK_STAGES = ['未说明', '探索', '实现', '验证', '发布', '维护'];
export const VALUE_LEVELS = ['未评估', '低', '中', '高', '关键'];
export const OUTPUT_TYPES = ['未分类', 'PR', 'commit', '文章', '部署', '文档', '截图', '其他'];
export const PROJECT_ALIAS_MATCH_TYPES = ['prefix', 'contains', 'regex'];
export const ANNOTATION_SOURCES = ['manual', 'auto', 'imported'];
export const PRIVACY_LEVELS = ['safe', 'hashed', 'redacted', 'unavailable'];
export const WORK_ITEM_TYPES = ['未分类', '功能开发', '问题修复', '代码审查', '技术调研', '内容创作', '运维配置', '其他'];
export const BUDGET_WINDOW_TYPES = ['rolling', 'fixed'];
export const ADVISOR_ACTION_STATUSES = ['open', 'done', 'dismissed'];
export const DEFAULT_SESSION_ANNOTATION = {
  projectAlias: null,
  taskType: TASK_TYPES[0],
  outputStatus: OUTPUT_STATUSES[0],
  workPurpose: WORK_PURPOSES[0],
  workStage: WORK_STAGES[0],
  valueLevel: VALUE_LEVELS[0],
  note: null,
  annotationUpdatedAt: null,
  annotationSource: null,
  annotationConfidence: null,
  annotationReason: null,
  autoVersion: null,
  autoRunId: null,
  autoUpdatedAt: null,
  attributionQuality: 'missing',
  manualProjectAlias: null,
  ruleProjectAlias: null,
  outputUrl: null,
  outputLabel: null,
  outputType: OUTPUT_TYPES[0],
  outputUpdatedAt: null
};

export function openDb(dbPath = defaultDbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 10000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  initSchema(db);
  repairModelNames(db, dbPath);
  repairArkAutoModelNames(db, dbPath);
  return db;
}

function repairModelNames(db, dbPath) {
  const aliases = db.prepare(`
    SELECT model FROM daily_usage WHERE lower(model) LIKE 'glm-%'
    UNION SELECT model FROM session_usage WHERE lower(model) LIKE 'glm-%'
    UNION SELECT model FROM token_events WHERE lower(model) LIKE 'glm-%'
  `).all().filter(row => canonicalModelName(row.model) !== row.model);
  if (!aliases.length) return;
  createSqliteBackup(db, dbPath, { reason: 'model-name-repair' });
  db.exec('BEGIN IMMEDIATE');
  try {
    const counters = ['input_tokens', 'output_tokens', 'cache_creation_tokens', 'cache_read_tokens',
      'cached_input_tokens', 'reasoning_output_tokens', 'total_tokens', 'cost_usd'];
    const mergeDaily = db.prepare(`
      INSERT INTO daily_usage (device, source, usage_date, model, ${counters.join(',')}, updated_at)
      SELECT device, source, usage_date, ?, ${counters.join(',')}, updated_at
      FROM daily_usage WHERE model = ?
      ON CONFLICT(device, source, usage_date, model) DO UPDATE SET
        ${counters.map(column => `${column} = daily_usage.${column} + excluded.${column}`).join(',')},
        updated_at = MAX(daily_usage.updated_at, excluded.updated_at)
    `);
    for (const { model } of aliases) {
      const canonical = canonicalModelName(model);
      mergeDaily.run(canonical, model);
      db.prepare('DELETE FROM daily_usage WHERE model = ?').run(model);
      db.prepare('UPDATE session_usage SET model = ? WHERE model = ?').run(canonical, model);
      db.prepare('UPDATE token_events SET model = ? WHERE model = ?').run(canonical, model);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// Early builds recorded Volcengine Ark Coding Plan responses under the
// gateway's opaque "auto" (or the interim "ark-auto") label, keyed by
// model-suffixed session ids. Ark does not expose the routed backend model,
// so those rows move to the configured request model (e.g. ark-code-latest),
// or ark-auto when no concrete alias is configured locally.
//
// The same response can exist twice: once under a legacy session suffix and
// once re-captured under the canonical suffix by a newer collector. Merging
// blindly would double-count those, so legacy rows with a canonical twin are
// deleted and only orphaned legacy rows are renamed. Daily rows for the
// canonical model are then rebuilt from token_events, which are the single
// source of truth for Claude Code aggregates.
function repairArkAutoModelNames(db, dbPath) {
  const canonical = configuredClaudeRequestModel() || 'ark-auto';
  const legacyModels = ['auto', 'ark-auto'].filter(model => model !== canonical);
  const legacySuffixes = legacyModels;

  const legacyModelCount = db.prepare(`
    SELECT count(*) AS n FROM (
      SELECT model FROM daily_usage WHERE source = 'Claude Code' AND lower(model) IN ('auto', 'ark-auto')
      UNION ALL SELECT model FROM session_usage WHERE source = 'Claude Code' AND lower(model) IN ('auto', 'ark-auto')
      UNION ALL SELECT model FROM token_events WHERE source = 'Claude Code' AND lower(model) IN ('auto', 'ark-auto')
    )
  `).get().n;
  const legacySuffixRows = db.prepare(`
    SELECT event_id, device, session_id, timestamp, model,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, reasoning_tokens, privacy_level
    FROM token_events
    WHERE source = 'Claude Code'
      AND (session_id LIKE '%:auto' OR session_id LIKE '%:ark-auto')
  `).all();
  if (!legacyModelCount && !legacySuffixRows.length) return;

  const legacySuffixOf = sessionId => sessionId.endsWith(':ark-auto') && legacySuffixes.includes('ark-auto')
    ? 'ark-auto'
    : 'auto';
  const legacyBaseOf = sessionId => sessionId.slice(0, sessionId.length - legacySuffixOf(sessionId).length - 1);
  const canonicalTwin = db.prepare(`
    SELECT 1 FROM token_events
    WHERE device = ? AND source = 'Claude Code' AND session_id = ?
      AND timestamp = ? AND privacy_level = ?
      AND input_tokens = ? AND output_tokens = ?
      AND cache_read_tokens = ? AND cache_creation_tokens = ? AND reasoning_tokens = ?
    LIMIT 1
  `);
  const canonicalSessionTwin = db.prepare(`
    SELECT 1 FROM session_usage
    WHERE device = ? AND source = 'Claude Code' AND session_id = ? LIMIT 1
  `);
  const legacySessions = db.prepare(`
    SELECT device, session_id FROM session_usage
    WHERE source = 'Claude Code' AND (session_id LIKE '%:auto' OR session_id LIKE '%:ark-auto')
  `).all();
  // 无实际变更时不备份不开事务；孪生每次实时检查，晚到孪生仍会被下次修复清理。
  const legacyDailyCount = db.prepare(`
    SELECT count(*) AS n FROM daily_usage
    WHERE source = 'Claude Code' AND lower(model) IN ('auto', 'ark-auto')
  `).get().n;
  const willChange = legacyModelCount > 0
    || legacyDailyCount > 0
    || legacySuffixRows.some(row => canonicalTwin.get(
      row.device, `${legacyBaseOf(row.session_id)}:${canonical}`, row.timestamp, row.privacy_level,
      row.input_tokens, row.output_tokens, row.cache_read_tokens,
      row.cache_creation_tokens, row.reasoning_tokens
    ))
    || legacySessions.some(row => canonicalSessionTwin.get(row.device, `${legacyBaseOf(row.session_id)}:${canonical}`));
  if (!willChange) return;

  createSqliteBackup(db, dbPath, { reason: 'ark-auto-model-rename' });
  db.exec('BEGIN IMMEDIATE');
  try {
    // 1. Drop legacy-suffix events whose response was also captured under the
    //    canonical session suffix (same base, timestamp and token counters).
    const deleteEvent = db.prepare('DELETE FROM token_events WHERE event_id = ? AND source = ?');
    const affectedDates = new Set();
    for (const row of legacySuffixRows) {
      const base = legacyBaseOf(row.session_id);
      const twin = canonicalTwin.get(
        row.device, `${base}:${canonical}`, row.timestamp, row.privacy_level,
        row.input_tokens, row.output_tokens, row.cache_read_tokens,
        row.cache_creation_tokens, row.reasoning_tokens
      );
      if (twin) deleteEvent.run(row.event_id, 'Claude Code');
      affectedDates.add(localDateFromTimestamp(row.timestamp));
    }

    // 2. Rename surviving legacy-model rows to the canonical model.
    for (const model of legacyModels) {
      db.prepare(`
        UPDATE token_events SET model = ?
        WHERE source = 'Claude Code' AND lower(model) = ?
      `).run(canonical, model);
      db.prepare(`
        UPDATE session_usage SET model = ?
        WHERE source = 'Claude Code' AND lower(model) = ?
      `).run(canonical, model);
    }

    // 3. Legacy-suffix sessions with a canonical twin are duplicates; the
    //    rest keep their (renamed) model.
    const deleteSession = db.prepare(`
      DELETE FROM session_usage WHERE device = ? AND source = 'Claude Code' AND session_id = ?
    `);
    for (const row of legacySessions) {
      const base = legacyBaseOf(row.session_id);
      if (canonicalSessionTwin.get(row.device, `${base}:${canonical}`)) {
        deleteSession.run(row.device, row.session_id);
      }
    }

    // 4. Rebuild the canonical daily rows from token_events for every date
    //    touched by legacy rows, then drop the legacy daily rows.
    for (const row of db.prepare(`
      SELECT DISTINCT usage_date FROM daily_usage
      WHERE source = 'Claude Code' AND lower(model) IN ('auto', 'ark-auto')
    `).all()) {
      affectedDates.add(row.usage_date);
    }
    const rebuildDaily = db.prepare(`
      INSERT INTO daily_usage (
        device, source, usage_date, model, input_tokens, output_tokens,
        cache_creation_tokens, cache_read_tokens, cached_input_tokens,
        reasoning_output_tokens, total_tokens, cost_usd, updated_at
      ) VALUES (?, 'Claude Code', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, datetime('now'))
      ON CONFLICT(device, source, usage_date, model) DO UPDATE SET
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cache_creation_tokens = excluded.cache_creation_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        cached_input_tokens = excluded.cached_input_tokens,
        reasoning_output_tokens = excluded.reasoning_output_tokens,
        total_tokens = excluded.total_tokens,
        cost_usd = excluded.cost_usd,
        updated_at = datetime('now')
    `);
    const clearDaily = db.prepare(`
      DELETE FROM daily_usage
      WHERE device = ? AND source = 'Claude Code' AND usage_date = ? AND model = ?
    `);
    for (const model of legacyModels) {
      db.prepare(`DELETE FROM daily_usage WHERE source = 'Claude Code' AND lower(model) = ?`).run(model);
    }
    // token_events for the canonical model are exactly the Ark-era events, so
    // scanning them is cheap; daily dates follow the collector's China-local
    // calendar via localDateFromTimestamp.
    const canonicalEvents = db.prepare(`
      SELECT device, timestamp,
        input_tokens AS inputTokens, output_tokens AS outputTokens,
        cache_read_tokens AS cacheReadTokens, cache_creation_tokens AS cacheWriteTokens,
        reasoning_tokens AS reasoningTokens
      FROM token_events
      WHERE source = 'Claude Code' AND model = ?
    `).all(canonical);
    const devices = new Set(db.prepare(`
      SELECT DISTINCT device FROM token_events WHERE source = 'Claude Code'
    `).all().map(row => row.device));
    for (const device of devices) {
      const perDate = new Map();
      for (const event of canonicalEvents) {
        if (event.device !== device) continue;
        const date = localDateFromTimestamp(event.timestamp);
        if (!affectedDates.has(date)) continue;
        const totals = perDate.get(date) || {
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0
        };
        totals.inputTokens += event.inputTokens;
        totals.outputTokens += event.outputTokens;
        totals.cacheReadTokens += event.cacheReadTokens;
        totals.cacheWriteTokens += event.cacheWriteTokens;
        totals.reasoningTokens += event.reasoningTokens;
        perDate.set(date, totals);
      }
      for (const date of affectedDates) {
        const totals = perDate.get(date);
        if (!totals) {
          clearDaily.run(device, date, canonical);
          continue;
        }
        const totalTokens = totals.inputTokens + totals.outputTokens + totals.cacheReadTokens
          + totals.cacheWriteTokens + totals.reasoningTokens;
        const cost = calculateCost(canonical, {
          input: totals.inputTokens,
          output: totals.outputTokens,
          cacheRead: totals.cacheReadTokens,
          cacheWrite: totals.cacheWriteTokens,
          reasoning: totals.reasoningTokens
        }, null, null, date);
        rebuildDaily.run(
          device, date, canonical,
          totals.inputTokens, totals.outputTokens,
          totals.cacheWriteTokens, totals.cacheReadTokens,
          totals.reasoningTokens, totalTokens, cost
        );
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function openReadOnlyDb(dbPath = defaultDbPath) {
  const resolved = resolve(dbPath);
  if (!existsSync(resolved)) {
    throw new Error(`SQLite database not found: ${resolved}`);
  }
  const db = new DatabaseSync(resolved, {
    readOnly: true,
    timeout: 10000
  });
  db.exec('PRAGMA busy_timeout = 10000');
  return db;
}

export function createSqliteBackup(db, dbPath = defaultDbPath, {
  reason = 'manual',
  backupDir = null,
  minimumIntervalMs = 0,
  now = new Date()
} = {}) {
  const resolvedDbPath = resolve(dbPath);
  if (!existsSync(resolvedDbPath)) {
    throw new Error(`SQLite database not found: ${resolvedDbPath}`);
  }
  const createdAt = new Date(now).toISOString();
  const stamp = createdAt.replace(/[:.]/g, '-');
  const safeReason = String(reason || 'manual').replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
  const targetDir = backupDir || process.env.BACKUP_DIR || join(dirname(resolvedDbPath), 'backups');
  mkdirSync(targetDir, { recursive: true });
  const existing = minimumIntervalMs > 0 ? backupFiles(targetDir) : backupFiles(targetDir, safeReason);
  if (minimumIntervalMs > 0 && existing.length > 0) {
    const latest = statSync(join(targetDir, existing[0]));
    if (new Date(now).getTime() - latest.mtimeMs < minimumIntervalMs) {
      pruneBackupFiles(targetDir, backupFiles(targetDir));
      return null;
    }
  }
  const fileName = `usage-${stamp}-${safeReason}.sqlite`;
  const backupPath = join(targetDir, fileName);
  db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  const allBackups = backupFiles(targetDir).filter(name => name !== fileName);
  pruneBackupFiles(targetDir, [fileName, ...allBackups]);
  return { createdAt, path: backupPath, fileName };
}

export function usageTotalsNeedRepair(db) {
  return Boolean(db.prepare(`
    SELECT 1
    FROM daily_usage
    WHERE total_tokens < input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens + cached_input_tokens + reasoning_output_tokens
    UNION ALL
    SELECT 1
    FROM session_usage
    WHERE total_tokens < input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens + cached_input_tokens + reasoning_output_tokens
    LIMIT 1
  `).get());
}

export function repairUsageTotals(db) {
  const daily = db.prepare(`
    UPDATE daily_usage
    SET total_tokens = input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens + cached_input_tokens + reasoning_output_tokens,
      updated_at = datetime('now')
    WHERE total_tokens < input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens + cached_input_tokens + reasoning_output_tokens
  `).run().changes;
  const sessions = db.prepare(`
    UPDATE session_usage
    SET total_tokens = input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens + cached_input_tokens + reasoning_output_tokens,
      updated_at = datetime('now')
    WHERE total_tokens < input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens + cached_input_tokens + reasoning_output_tokens
  `).run().changes;
  return { daily, sessions };
}

function backupFiles(dir, reason = null) {
  return readdirSync(dir)
    .filter(name => backupReason(name) === reason || (reason === null && backupReason(name) !== null))
    .sort((left, right) => statSync(join(dir, right)).mtimeMs - statSync(join(dir, left)).mtimeMs);
}

function backupReason(name) {
  const match = /^usage-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-(.+)\.sqlite$/.exec(name);
  return match ? match[1] : null;
}

function pruneBackupFiles(dir, files) {
  for (const name of files.slice(DEFAULT_MAX_BACKUPS)) {
    unlinkSync(join(dir, name));
  }
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS collection_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT,
      collected_at TEXT NOT NULL DEFAULT (datetime('now')),
      command TEXT
    );

    CREATE TABLE IF NOT EXISTS collector_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daily_usage (
      device TEXT NOT NULL,
      source TEXT NOT NULL,
      usage_date TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (device, source, usage_date, model)
    );

    CREATE TABLE IF NOT EXISTS session_usage (
      device TEXT NOT NULL,
      source TEXT NOT NULL,
      session_id TEXT NOT NULL,
      last_activity TEXT,
      project_path TEXT,
      model TEXT NOT NULL DEFAULT '',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (device, source, session_id)
    );

    CREATE TABLE IF NOT EXISTS session_annotations (
      device TEXT NOT NULL,
      source TEXT NOT NULL,
      session_id TEXT NOT NULL,
      project_alias TEXT,
      task_type TEXT NOT NULL DEFAULT '未分类',
      output_status TEXT NOT NULL DEFAULT '未标注',
      work_purpose TEXT NOT NULL DEFAULT '未说明',
      work_stage TEXT NOT NULL DEFAULT '未说明',
      value_level TEXT NOT NULL DEFAULT '未评估',
      note TEXT,
      annotation_source TEXT NOT NULL DEFAULT 'manual',
      annotation_confidence INTEGER NOT NULL DEFAULT 100,
      annotation_reason TEXT,
      auto_version TEXT,
      auto_run_id TEXT,
      auto_updated_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (device, source, session_id),
      FOREIGN KEY (device, source, session_id)
        REFERENCES session_usage(device, source, session_id)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS project_alias_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern TEXT NOT NULL,
      match_type TEXT NOT NULL DEFAULT 'prefix',
      project_alias TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS session_outputs (
      device TEXT NOT NULL,
      source TEXT NOT NULL,
      session_id TEXT NOT NULL,
      output_url TEXT NOT NULL,
      output_label TEXT,
      output_type TEXT NOT NULL DEFAULT '未分类',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (device, source, session_id),
      FOREIGN KEY (device, source, session_id)
        REFERENCES session_usage(device, source, session_id)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS token_events (
      event_id TEXT PRIMARY KEY,
      device TEXT NOT NULL,
      source TEXT NOT NULL,
      session_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      tool_category TEXT,
      file_extension TEXT,
      repo_path_hash TEXT,
      privacy_level TEXT NOT NULL DEFAULT 'safe',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS work_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      project_alias TEXT,
      work_type TEXT NOT NULL DEFAULT '未分类',
      status TEXT NOT NULL DEFAULT '未标注',
      value_level TEXT NOT NULL DEFAULT '未评估',
      output_url TEXT,
      output_type TEXT NOT NULL DEFAULT '未分类',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS work_item_sessions (
      work_item_id INTEGER NOT NULL,
      device TEXT NOT NULL,
      source TEXT NOT NULL,
      session_id TEXT NOT NULL,
      linked_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (work_item_id, device, source, session_id),
      FOREIGN KEY (work_item_id) REFERENCES work_items(id) ON DELETE CASCADE,
      FOREIGN KEY (device, source, session_id)
        REFERENCES session_usage(device, source, session_id)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS budget_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL DEFAULT '',
      model_group TEXT NOT NULL DEFAULT '',
      label TEXT NOT NULL,
      window_type TEXT NOT NULL DEFAULT 'rolling',
      window_minutes INTEGER NOT NULL DEFAULT 300,
      token_budget INTEGER NOT NULL DEFAULT 0,
      cost_budget_usd REAL NOT NULL DEFAULT 0,
      reset_anchor TEXT,
      warning_threshold REAL NOT NULL DEFAULT 0.75,
      hard_threshold REAL NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS advisor_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      action TEXT NOT NULL,
      evidence TEXT,
      source_rule TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_daily_usage_date ON daily_usage(usage_date);
    CREATE INDEX IF NOT EXISTS idx_daily_usage_source ON daily_usage(source);
    CREATE INDEX IF NOT EXISTS idx_session_usage_total ON session_usage(total_tokens DESC);
    CREATE INDEX IF NOT EXISTS idx_session_annotations_task ON session_annotations(task_type);
    CREATE INDEX IF NOT EXISTS idx_session_annotations_status ON session_annotations(output_status);
    CREATE INDEX IF NOT EXISTS idx_project_alias_rules_enabled ON project_alias_rules(enabled, match_type);
    CREATE INDEX IF NOT EXISTS idx_session_outputs_updated ON session_outputs(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_token_events_session ON token_events(device, source, session_id);
    CREATE INDEX IF NOT EXISTS idx_token_events_time ON token_events(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(status, value_level);
    CREATE INDEX IF NOT EXISTS idx_budget_profiles_enabled ON budget_profiles(enabled, source);
    CREATE INDEX IF NOT EXISTS idx_advisor_actions_period ON advisor_actions(period_start, period_end, status);
    CREATE INDEX IF NOT EXISTS idx_advisor_actions_rule ON advisor_actions(period_start, period_end, source_rule);
  `);
  ensureColumn(db, 'session_annotations', 'work_purpose', "TEXT NOT NULL DEFAULT '未说明'");
  ensureColumn(db, 'session_usage', 'model', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'session_annotations', 'work_stage', "TEXT NOT NULL DEFAULT '未说明'");
  ensureColumn(db, 'session_annotations', 'value_level', "TEXT NOT NULL DEFAULT '未评估'");
  ensureColumn(db, 'session_annotations', 'annotation_source', "TEXT NOT NULL DEFAULT 'manual'");
  ensureColumn(db, 'session_annotations', 'annotation_confidence', 'INTEGER NOT NULL DEFAULT 100');
  ensureColumn(db, 'session_annotations', 'annotation_reason', 'TEXT');
  ensureColumn(db, 'session_annotations', 'auto_version', 'TEXT');
  ensureColumn(db, 'session_annotations', 'auto_run_id', 'TEXT');
  ensureColumn(db, 'session_annotations', 'auto_updated_at', 'TEXT');
  ensureColumn(db, 'budget_profiles', 'reset_anchor', 'TEXT');
  ensureColumn(db, 'budget_profiles', 'warning_threshold', 'REAL NOT NULL DEFAULT 0.75');
  ensureColumn(db, 'budget_profiles', 'model_group', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'budget_profiles', 'hard_threshold', 'REAL NOT NULL DEFAULT 1');
  ensureColumn(db, 'session_outputs', 'output_type', "TEXT NOT NULL DEFAULT '未分类'");
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_annotations_work ON session_annotations(work_purpose, work_stage, value_level)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_annotations_provenance ON session_annotations(annotation_source, annotation_confidence, auto_run_id)');
  ensureColumn(db, 'advisor_actions', 'updated_at', "TEXT NOT NULL DEFAULT (datetime('now'))");
}

export function upsertDaily(db, row) {
  const usage = normalizeDailyUsage(row);
  db.prepare(`
    INSERT INTO daily_usage (
      device, source, usage_date, model, input_tokens, output_tokens,
      cache_creation_tokens, cache_read_tokens, cached_input_tokens,
      reasoning_output_tokens, total_tokens, cost_usd, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(device, source, usage_date, model) DO UPDATE SET
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_creation_tokens = excluded.cache_creation_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      cached_input_tokens = excluded.cached_input_tokens,
      reasoning_output_tokens = excluded.reasoning_output_tokens,
      total_tokens = excluded.total_tokens,
      cost_usd = excluded.cost_usd,
      updated_at = datetime('now')
    WHERE daily_usage.input_tokens != excluded.input_tokens
      OR daily_usage.output_tokens != excluded.output_tokens
      OR daily_usage.cache_creation_tokens != excluded.cache_creation_tokens
      OR daily_usage.cache_read_tokens != excluded.cache_read_tokens
      OR daily_usage.cached_input_tokens != excluded.cached_input_tokens
      OR daily_usage.reasoning_output_tokens != excluded.reasoning_output_tokens
      OR daily_usage.total_tokens != excluded.total_tokens
      OR daily_usage.cost_usd != excluded.cost_usd
  `).run(
    usage.device,
    usage.source,
    usage.usageDate,
    usage.model,
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheCreationTokens,
    usage.cacheReadTokens,
    usage.cachedInputTokens,
    usage.reasoningOutputTokens,
    usage.totalTokens,
    usage.costUSD
  );
}

export function upsertDailyBatch(db, rows) {
  const snapshots = new Map();
  for (const row of rows) {
    const usage = normalizeDailyUsage(row);
    snapshots.set(JSON.stringify([usage.device, usage.source, usage.usageDate, row.model]), usage);
  }
  const grouped = new Map();
  for (const row of snapshots.values()) {
    const key = JSON.stringify([row.device, row.source, row.usageDate, row.model]);
    const previous = grouped.get(key);
    if (!previous) grouped.set(key, row);
    else for (const field of ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens',
      'cachedInputTokens', 'reasoningOutputTokens', 'totalTokens', 'costUSD']) previous[field] += row[field];
  }
  for (const row of grouped.values()) upsertDaily(db, row);
}

export function upsertSession(db, row) {
  const session = normalizeSessionUsage(row);
  db.prepare(`
    INSERT INTO session_usage (
      device, source, session_id, last_activity, project_path, model, input_tokens,
      output_tokens, cache_creation_tokens, cache_read_tokens,
      cached_input_tokens, reasoning_output_tokens, total_tokens, cost_usd, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(device, source, session_id) DO UPDATE SET
      last_activity = COALESCE(excluded.last_activity, session_usage.last_activity),
      project_path = COALESCE(excluded.project_path, session_usage.project_path),
      model = CASE WHEN excluded.model != '' THEN excluded.model ELSE session_usage.model END,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_creation_tokens = excluded.cache_creation_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      cached_input_tokens = excluded.cached_input_tokens,
      reasoning_output_tokens = excluded.reasoning_output_tokens,
      total_tokens = excluded.total_tokens,
      cost_usd = excluded.cost_usd,
      updated_at = datetime('now')
    WHERE session_usage.last_activity IS NOT COALESCE(excluded.last_activity, session_usage.last_activity)
      OR session_usage.project_path IS NOT COALESCE(excluded.project_path, session_usage.project_path)
      OR session_usage.model != CASE WHEN excluded.model != '' THEN excluded.model ELSE session_usage.model END
      OR session_usage.input_tokens != excluded.input_tokens
      OR session_usage.output_tokens != excluded.output_tokens
      OR session_usage.cache_creation_tokens != excluded.cache_creation_tokens
      OR session_usage.cache_read_tokens != excluded.cache_read_tokens
      OR session_usage.cached_input_tokens != excluded.cached_input_tokens
      OR session_usage.reasoning_output_tokens != excluded.reasoning_output_tokens
      OR session_usage.total_tokens != excluded.total_tokens
      OR session_usage.cost_usd != excluded.cost_usd
  `).run(
    session.device,
    session.source,
    session.sessionId,
    session.lastActivity,
    session.projectPath,
    session.model,
    session.inputTokens,
    session.outputTokens,
    session.cacheCreationTokens,
    session.cacheReadTokens,
    session.cachedInputTokens,
    session.reasoningOutputTokens,
    session.totalTokens,
    session.costUSD
  );
}

export function recordRun(db, row) {
  const run = normalizeCollectionRun(row);
  db.prepare(`
    INSERT INTO collection_runs(device, source, status, message, collected_at, command)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    run.device,
    run.source,
    run.status,
    run.message,
    run.collectedAt,
    run.command
  );
}

export function getCollectorMeta(db, key) {
  const row = db.prepare('SELECT value FROM collector_meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setCollectorMeta(db, key, value) {
  db.prepare(`
    INSERT INTO collector_meta(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

export function normalizeDailyUsage(row: InputRecord = {}) {
  const tokens = normalizeUsageTokens(row);
  return {
    device: normalizedRequiredMax(row.device, 'device', 120),
    source: normalizedRequiredMax(row.source, 'source', 120),
    usageDate: normalizeUsageDate(row.usageDate ?? row.usage_date),
    model: canonicalModelName(normalizeOptionalText(row.model, 'model', 160) || ''),
    ...tokens,
    totalTokens: normalizeUsageTotal(row.totalTokens ?? row.total_tokens, tokens),
    costUSD: normalizeNonNegativeNumber(row.costUSD ?? row.cost_usd, 'costUSD')
  };
}

export function normalizeSessionUsage(row: InputRecord = {}) {
  const tokens = normalizeUsageTokens(row);
  return {
    device: normalizedRequiredMax(row.device, 'device', 120),
    source: normalizedRequiredMax(row.source, 'source', 120),
    sessionId: normalizedRequiredMax(row.sessionId ?? row.session_id, 'sessionId', 300),
    lastActivity: normalizeOptionalTimestamp(row.lastActivity ?? row.last_activity, 'lastActivity'),
    projectPath: normalizeOptionalRawText(row.projectPath ?? row.project_path, 'projectPath', 1000),
    model: canonicalModelName(normalizeOptionalText(row.model, 'model', 160) || ''),
    ...tokens,
    totalTokens: normalizeUsageTotal(row.totalTokens ?? row.total_tokens, tokens),
    costUSD: normalizeNonNegativeNumber(row.costUSD ?? row.cost_usd, 'costUSD')
  };
}

export function normalizeCollectionRun(row: InputRecord = {}) {
  return {
    device: normalizedRequiredMax(row.device, 'device', 120),
    source: normalizedRequiredMax(row.source, 'source', 120),
    status: normalizedRequiredMax(row.status, 'status', 80),
    message: normalizeOptionalText(row.message, 'message', 2000),
    collectedAt: normalizeOptionalTimestamp(row.collectedAt ?? row.collected_at, 'collectedAt') || new Date().toISOString(),
    command: normalizeOptionalText(row.command, 'command', 500)
  };
}

export function normalizeSessionAnnotation(row: InputRecord = {}, { defaultSource = 'manual' } = {}) {
  const required = {
    device: normalizedRequired(row.device, 'device'),
    source: normalizedRequired(row.source, 'source'),
    sessionId: normalizedRequired(row.sessionId ?? row.session_id, 'sessionId')
  };
  const projectAlias = normalizeOptionalText(row.projectAlias ?? row.project_alias, 'projectAlias', 120);
  const taskType = normalizeEnum(row.taskType ?? row.task_type, TASK_TYPES, TASK_TYPES[0], 'taskType');
  const outputStatus = normalizeEnum(row.outputStatus ?? row.output_status, OUTPUT_STATUSES, OUTPUT_STATUSES[0], 'outputStatus');
  const workPurpose = normalizeEnum(row.workPurpose ?? row.work_purpose, WORK_PURPOSES, WORK_PURPOSES[0], 'workPurpose');
  const workStage = normalizeEnum(row.workStage ?? row.work_stage, WORK_STAGES, WORK_STAGES[0], 'workStage');
  const valueLevel = normalizeEnum(row.valueLevel ?? row.value_level, VALUE_LEVELS, VALUE_LEVELS[0], 'valueLevel');
  const note = normalizeOptionalText(row.note, 'note', 500);
  const annotationSource = normalizeEnum(row.annotationSource ?? row.annotation_source, ANNOTATION_SOURCES, defaultSource, 'annotationSource');
  const annotationConfidence = normalizeConfidence(
    row.annotationConfidence ?? row.annotation_confidence,
    annotationSource === 'manual' || annotationSource === 'imported' ? 100 : 0
  );
  const annotationReason = normalizeOptionalText(row.annotationReason ?? row.annotation_reason, 'annotationReason', 500);
  const autoVersion = normalizeOptionalText(row.autoVersion ?? row.auto_version, 'autoVersion', 40);
  const autoRunId = normalizeOptionalText(row.autoRunId ?? row.auto_run_id, 'autoRunId', 80);
  const autoUpdatedAt = normalizeOptionalText(row.autoUpdatedAt ?? row.auto_updated_at, 'autoUpdatedAt', 60);

  return {
    ...required,
    projectAlias,
    taskType,
    outputStatus,
    workPurpose,
    workStage,
    valueLevel,
    note,
    annotationSource,
    annotationConfidence,
    annotationReason,
    autoVersion,
    autoRunId,
    autoUpdatedAt
  };
}

export function upsertSessionAnnotation(db, row) {
  const annotation = normalizeSessionAnnotation(row);
  db.prepare(`
    INSERT INTO session_annotations (
      device, source, session_id, project_alias, task_type, output_status,
      work_purpose, work_stage, value_level, note,
      annotation_source, annotation_confidence, annotation_reason,
      auto_version, auto_run_id, auto_updated_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(device, source, session_id) DO UPDATE SET
      project_alias = excluded.project_alias,
      task_type = excluded.task_type,
      output_status = excluded.output_status,
      work_purpose = excluded.work_purpose,
      work_stage = excluded.work_stage,
      value_level = excluded.value_level,
      note = excluded.note,
      annotation_source = excluded.annotation_source,
      annotation_confidence = excluded.annotation_confidence,
      annotation_reason = excluded.annotation_reason,
      auto_version = excluded.auto_version,
      auto_run_id = excluded.auto_run_id,
      auto_updated_at = excluded.auto_updated_at,
      updated_at = datetime('now')
  `).run(
    annotation.device,
    annotation.source,
    annotation.sessionId,
    annotation.projectAlias,
    annotation.taskType,
    annotation.outputStatus,
    annotation.workPurpose,
    annotation.workStage,
    annotation.valueLevel,
    annotation.note,
    annotation.annotationSource,
    annotation.annotationConfidence,
    annotation.annotationReason,
    annotation.autoVersion,
    annotation.autoRunId,
    annotation.autoUpdatedAt
  );

  return db.prepare(`
    SELECT device, source, session_id AS sessionId,
      project_alias AS projectAlias,
      task_type AS taskType,
      output_status AS outputStatus,
      work_purpose AS workPurpose,
      work_stage AS workStage,
      value_level AS valueLevel,
      note,
      annotation_source AS annotationSource,
      annotation_confidence AS annotationConfidence,
      annotation_reason AS annotationReason,
      auto_version AS autoVersion,
      auto_run_id AS autoRunId,
      auto_updated_at AS autoUpdatedAt,
      updated_at AS annotationUpdatedAt
    FROM session_annotations
    WHERE device = ? AND source = ? AND session_id = ?
  `).get(annotation.device, annotation.source, annotation.sessionId);
}

export function deleteSessionAnnotation(db, row) {
  const device = normalizedRequired(row.device, 'device');
  const source = normalizedRequired(row.source, 'source');
  const sessionId = normalizedRequired(row.sessionId ?? row.session_id, 'sessionId');
  return db.prepare(`
    DELETE FROM session_annotations
    WHERE device = ? AND source = ? AND session_id = ?
  `).run(device, source, sessionId).changes;
}

export function batchUpsertSessionAnnotations(db, payload: InputRecord = {}) {
  const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
  if (!sessions.length) throw new Error('sessions must include at least one item');

  const values = inputRecord(payload.values);
  const hasProjectAlias = hasAny(values, ['projectAlias', 'project_alias']);
  const hasTaskType = hasAny(values, ['taskType', 'task_type']);
  const hasOutputStatus = hasAny(values, ['outputStatus', 'output_status']);
  const hasWorkPurpose = hasAny(values, ['workPurpose', 'work_purpose']);
  const hasWorkStage = hasAny(values, ['workStage', 'work_stage']);
  const hasValueLevel = hasAny(values, ['valueLevel', 'value_level']);
  const hasNote = hasAny(values, ['note']);
  if (!hasProjectAlias && !hasTaskType && !hasOutputStatus && !hasWorkPurpose && !hasWorkStage && !hasValueLevel && !hasNote) {
    throw new Error('values must include at least one annotation field');
  }

  const select = db.prepare(`
    SELECT project_alias AS projectAlias,
      task_type AS taskType,
      output_status AS outputStatus,
      work_purpose AS workPurpose,
      work_stage AS workStage,
      value_level AS valueLevel,
      note,
      annotation_source AS annotationSource,
      annotation_confidence AS annotationConfidence,
      annotation_reason AS annotationReason,
      auto_version AS autoVersion,
      auto_run_id AS autoRunId,
      auto_updated_at AS autoUpdatedAt
    FROM session_annotations
    WHERE device = ? AND source = ? AND session_id = ?
  `);
  let updated = 0;

  db.exec('BEGIN');
  try {
    for (const item of sessions) {
      const identity = normalizeSessionIdentity(item);
      const current = select.get(identity.device, identity.source, identity.sessionId) || DEFAULT_SESSION_ANNOTATION;
      upsertSessionAnnotation(db, {
        ...identity,
        projectAlias: hasProjectAlias ? (values.projectAlias ?? values.project_alias) : current.projectAlias,
        taskType: hasTaskType ? (values.taskType ?? values.task_type) : current.taskType,
        outputStatus: hasOutputStatus ? (values.outputStatus ?? values.output_status) : current.outputStatus,
        workPurpose: hasWorkPurpose ? (values.workPurpose ?? values.work_purpose) : current.workPurpose,
        workStage: hasWorkStage ? (values.workStage ?? values.work_stage) : current.workStage,
        valueLevel: hasValueLevel ? (values.valueLevel ?? values.value_level) : current.valueLevel,
        note: hasNote ? values.note : current.note,
        annotationSource: 'manual',
        annotationConfidence: 100,
        annotationReason: null,
        autoVersion: null,
        autoRunId: null,
        autoUpdatedAt: null
      });
      updated += 1;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return { updated };
}

export function listProjectAliasRules(db, { enabledOnly = false } = {}) {
  const where = enabledOnly ? 'WHERE enabled = 1' : '';
  return db.prepare(`
    SELECT id, pattern, match_type AS matchType, project_alias AS projectAlias,
      enabled, updated_at AS updatedAt
    FROM project_alias_rules
    ${where}
    ORDER BY enabled DESC, length(pattern) DESC, id ASC
  `).all().map(rule => ({
    ...rule,
    enabled: Boolean(rule.enabled)
  }));
}

export function normalizeProjectAliasRule(row: InputRecord = {}) {
  const id = normalizeOptionalId(row.id, 'id');
  const pattern = normalizedRequired(row.pattern, 'pattern');
  const matchType = normalizeEnum(row.matchType ?? row.match_type, PROJECT_ALIAS_MATCH_TYPES, 'prefix', 'matchType');
  const projectAlias = normalizedRequiredMax(row.projectAlias ?? row.project_alias, 'projectAlias', 120);
  const enabled = normalizeBoolean(row.enabled, true);
  return { id, pattern, matchType, projectAlias, enabled };
}

export function upsertProjectAliasRule(db, row) {
  const rule = normalizeProjectAliasRule(row);
  db.prepare(`
    INSERT INTO project_alias_rules (id, pattern, match_type, project_alias, enabled, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      pattern = excluded.pattern,
      match_type = excluded.match_type,
      project_alias = excluded.project_alias,
      enabled = excluded.enabled,
      updated_at = datetime('now')
  `).run(rule.id, rule.pattern, rule.matchType, rule.projectAlias, rule.enabled ? 1 : 0);

  const id = rule.id ?? db.prepare('SELECT last_insert_rowid() AS id').get().id;
  const saved = db.prepare(`
    SELECT id, pattern, match_type AS matchType, project_alias AS projectAlias,
      enabled, updated_at AS updatedAt
    FROM project_alias_rules
    WHERE id = ?
  `).get(id);
  return { ...saved, enabled: Boolean(saved.enabled) };
}

export function deleteProjectAliasRule(db, row: InputRecord = {}) {
  const id = normalizeRequiredId(row.id, 'id');
  return db.prepare('DELETE FROM project_alias_rules WHERE id = ?').run(id).changes;
}

export function matchProjectAliasRule(projectPath, rules = []) {
  const target = normalizeText(projectPath);
  if (!target) return null;
  const normalizedTarget = target.toLowerCase();

  for (const rule of rules) {
    if (!rule.enabled) continue;
    const pattern = normalizeText(rule.pattern);
    if (!pattern) continue;
    const normalizedPattern = pattern.toLowerCase();
    if (rule.matchType === 'prefix' && normalizedTarget.startsWith(normalizedPattern)) {
      return rule.projectAlias;
    }
    if (rule.matchType === 'contains' && normalizedTarget.includes(normalizedPattern)) {
      return rule.projectAlias;
    }
    if (rule.matchType === 'regex') {
      try {
        if (new RegExp(pattern, 'i').test(target)) return rule.projectAlias;
      } catch {
        continue;
      }
    }
  }

  return null;
}

export function normalizeSessionOutput(row: InputRecord = {}) {
  const identity = normalizeSessionIdentity(row);
  const outputUrl = normalizeOutputUrl(row.outputUrl ?? row.output_url);
  const outputLabel = normalizeOptionalText(row.outputLabel ?? row.output_label, 'outputLabel', 120);
  const outputType = normalizeEnum(row.outputType ?? row.output_type, OUTPUT_TYPES, OUTPUT_TYPES[0], 'outputType');
  return { ...identity, outputUrl, outputLabel, outputType };
}

export function upsertSessionOutput(db, row) {
  const output = normalizeSessionOutput(row);
  db.prepare(`
    INSERT INTO session_outputs (device, source, session_id, output_url, output_label, output_type, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(device, source, session_id) DO UPDATE SET
      output_url = excluded.output_url,
      output_label = excluded.output_label,
      output_type = excluded.output_type,
      updated_at = datetime('now')
  `).run(output.device, output.source, output.sessionId, output.outputUrl, output.outputLabel, output.outputType);

  return db.prepare(`
    SELECT device, source, session_id AS sessionId,
      output_url AS outputUrl,
      output_label AS outputLabel,
      output_type AS outputType,
      updated_at AS outputUpdatedAt
    FROM session_outputs
    WHERE device = ? AND source = ? AND session_id = ?
  `).get(output.device, output.source, output.sessionId);
}

export function deleteSessionOutput(db, row) {
  const { device, source, sessionId } = normalizeSessionIdentity(row);
  return db.prepare(`
    DELETE FROM session_outputs
    WHERE device = ? AND source = ? AND session_id = ?
  `).run(device, source, sessionId).changes;
}

export function exportAnnotationData(db) {
  return {
    version: 3,
    exportedAt: new Date().toISOString(),
    sessionAnnotations: db.prepare(`
      SELECT device, source, session_id AS sessionId,
        project_alias AS projectAlias,
        task_type AS taskType,
        output_status AS outputStatus,
        work_purpose AS workPurpose,
      work_stage AS workStage,
      value_level AS valueLevel,
      note,
      annotation_source AS annotationSource,
      annotation_confidence AS annotationConfidence,
      annotation_reason AS annotationReason,
      auto_version AS autoVersion,
      auto_run_id AS autoRunId,
      auto_updated_at AS autoUpdatedAt,
      updated_at AS annotationUpdatedAt
      FROM session_annotations
      ORDER BY updated_at DESC
    `).all(),
    sessionOutputs: db.prepare(`
      SELECT device, source, session_id AS sessionId,
        output_url AS outputUrl,
        output_label AS outputLabel,
        output_type AS outputType,
        updated_at AS outputUpdatedAt
      FROM session_outputs
      ORDER BY updated_at DESC
    `).all(),
    projectAliasRules: listProjectAliasRules(db)
  };
}

export function importAnnotationData(db, payload: InputRecord = {}) {
  const sessionAnnotations = Array.isArray(payload.sessionAnnotations)
    ? payload.sessionAnnotations
    : Array.isArray(payload.annotations) ? payload.annotations : [];
  const sessionOutputs = Array.isArray(payload.sessionOutputs) ? payload.sessionOutputs : [];
  const projectAliasRules = Array.isArray(payload.projectAliasRules) ? payload.projectAliasRules : [];
  const counts = {
    sessionAnnotations: 0,
    sessionOutputs: 0,
    projectAliasRules: 0
  };

  db.exec('BEGIN');
  try {
    for (const row of sessionAnnotations) {
      upsertSessionAnnotation(db, {
        ...row,
        annotationSource: row.annotationSource ?? row.annotation_source ?? 'imported',
        annotationConfidence: row.annotationConfidence ?? row.annotation_confidence ?? 100
      });
      counts.sessionAnnotations += 1;
    }
    for (const row of sessionOutputs) {
      upsertSessionOutput(db, row);
      counts.sessionOutputs += 1;
    }
    for (const row of projectAliasRules) {
      upsertProjectAliasRule(db, row);
      counts.projectAliasRules += 1;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return counts;
}

export function applyAutoSessionAnnotations(db, suggestions = [], { runId = autoRunId(), threshold = 80 } = {}) {
  const rows = Array.isArray(suggestions) ? suggestions : [];
  const eligible = rows.filter(row => Number(row.applyConfidence ?? row.annotationConfidence ?? 0) >= threshold);
  const select = db.prepare(`
    SELECT project_alias AS projectAlias,
      task_type AS taskType,
      output_status AS outputStatus,
      work_purpose AS workPurpose,
      work_stage AS workStage,
      value_level AS valueLevel,
      note,
      annotation_source AS annotationSource
    FROM session_annotations
    WHERE device = ? AND source = ? AND session_id = ?
  `);
  const result = {
    runId,
    threshold,
    applied: 0,
    skippedLowConfidence: rows.length - eligible.length,
    skippedProtected: 0
  };

  db.exec('BEGIN');
  try {
    for (const row of eligible) {
      const identity = normalizeSessionIdentity(row);
      const current = select.get(identity.device, identity.source, identity.sessionId);
      if (current && current.annotationSource !== 'auto') {
        result.skippedProtected += 1;
        continue;
      }
      const patchValues = row.applicableValues && typeof row.applicableValues === 'object'
        ? row.applicableValues
        : row.values && typeof row.values === 'object' ? row.values : row;
      const values = {
        ...DEFAULT_SESSION_ANNOTATION,
        ...(current || {}),
        ...patchValues
      };
      upsertSessionAnnotation(db, {
        ...identity,
        projectAlias: values.projectAlias,
        taskType: values.taskType,
        outputStatus: values.outputStatus,
        workPurpose: values.workPurpose,
        workStage: values.workStage,
        valueLevel: values.valueLevel,
        note: values.note,
        annotationSource: 'auto',
        annotationConfidence: row.applyConfidence ?? row.annotationConfidence,
        annotationReason: row.annotationReason,
        autoVersion: row.autoVersion,
        autoRunId: runId,
        autoUpdatedAt: row.autoUpdatedAt || new Date().toISOString()
      });
      result.applied += 1;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return result;
}

export function undoAutoSessionAnnotations(db, payload: InputRecord = {}) {
  const runId = normalizedRequiredMax(payload.runId ?? payload.autoRunId ?? payload.auto_run_id, 'runId', 80);
  return db.prepare(`
    DELETE FROM session_annotations
    WHERE annotation_source = 'auto' AND auto_run_id = ?
  `).run(runId).changes;
}

export function normalizeTokenEvent(row: InputRecord = {}) {
  const device = normalizedRequired(row.device, 'device');
  const source = normalizedRequired(row.source, 'source');
  const sessionId = normalizedRequired(row.sessionId ?? row.session_id, 'sessionId');
  const timestamp = normalizedRequiredMax(row.timestamp ?? row.createdAt ?? row.created_at, 'timestamp', 80);
  const originalModel = normalizeOptionalText(row.model, 'model', 120) || '';
  const model = canonicalModelName(originalModel);
  const inputTokens = normalizeTokenCount(row.inputTokens ?? row.input_tokens, 'inputTokens');
  const outputTokens = normalizeTokenCount(row.outputTokens ?? row.output_tokens, 'outputTokens');
  const cacheReadTokens = normalizeTokenCount(row.cacheReadTokens ?? row.cache_read_tokens, 'cacheReadTokens');
  const cacheCreationTokens = normalizeTokenCount(row.cacheCreationTokens ?? row.cache_creation_tokens, 'cacheCreationTokens');
  const reasoningTokens = normalizeTokenCount(row.reasoningTokens ?? row.reasoning_tokens, 'reasoningTokens');
  const toolCategory = normalizeOptionalText(row.toolCategory ?? row.tool_category, 'toolCategory', 80);
  const fileExtension = normalizeOptionalText(row.fileExtension ?? row.file_extension, 'fileExtension', 24);
  const repoPathHash = normalizeOptionalText(row.repoPathHash ?? row.repo_path_hash, 'repoPathHash', 128);
  const privacyLevel = normalizeEnum(row.privacyLevel ?? row.privacy_level, PRIVACY_LEVELS, 'safe', 'privacyLevel');
  const eventId = normalizeOptionalText(row.eventId ?? row.event_id, 'eventId', 240)
    || [
      device,
      source,
      sessionId,
      timestamp,
      originalModel,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      reasoningTokens,
      toolCategory || '',
      fileExtension || '',
      repoPathHash || ''
    ].join('::');

  return {
    eventId,
    device,
    source,
    sessionId,
    timestamp,
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    reasoningTokens,
    toolCategory,
    fileExtension,
    repoPathHash,
    privacyLevel
  };
}

const tokenEventStatements = new WeakMap<DatabaseSync, {
  upsert: ReturnType<DatabaseSync['prepare']>;
  owner: ReturnType<DatabaseSync['prepare']>;
}>();

function tokenEventStatementsFor(db: DatabaseSync) {
  const cached = tokenEventStatements.get(db);
  if (cached) return cached;

  const statements = {
    upsert: db.prepare(`
    INSERT INTO token_events (
      event_id, device, source, session_id, timestamp, model,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
      reasoning_tokens, tool_category, file_extension, repo_path_hash,
      privacy_level, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(event_id) DO UPDATE SET
      device = excluded.device,
      source = excluded.source,
      session_id = excluded.session_id,
      timestamp = excluded.timestamp,
      model = excluded.model,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      cache_creation_tokens = excluded.cache_creation_tokens,
      reasoning_tokens = excluded.reasoning_tokens,
      tool_category = excluded.tool_category,
      file_extension = excluded.file_extension,
      repo_path_hash = excluded.repo_path_hash,
      privacy_level = excluded.privacy_level,
      updated_at = datetime('now')
    WHERE token_events.device = excluded.device
      AND token_events.source = excluded.source
      AND (
        token_events.session_id != excluded.session_id
        OR token_events.timestamp != excluded.timestamp
        OR token_events.model != excluded.model
        OR token_events.input_tokens != excluded.input_tokens
        OR token_events.output_tokens != excluded.output_tokens
        OR token_events.cache_read_tokens != excluded.cache_read_tokens
        OR token_events.cache_creation_tokens != excluded.cache_creation_tokens
        OR token_events.reasoning_tokens != excluded.reasoning_tokens
        OR token_events.tool_category IS NOT excluded.tool_category
        OR token_events.file_extension IS NOT excluded.file_extension
        OR token_events.repo_path_hash IS NOT excluded.repo_path_hash
        OR token_events.privacy_level != excluded.privacy_level
      )
  `),
    owner: db.prepare(`
      SELECT 1 FROM token_events
      WHERE event_id = ? AND device = ? AND source = ?
    `)
  };
  tokenEventStatements.set(db, statements);
  return statements;
}

export function upsertTokenEvent(db: DatabaseSync, row: InputRecord = {}) {
  const event = normalizeTokenEvent(row);
  const statements = tokenEventStatementsFor(db);
  let result = runTokenEventUpsert(statements.upsert, event);
  if (result.changes === 0) {
    if (tokenEventHasOwner(statements.owner, event)) return event;
    event.eventId = scopedTokenEventId(event);
    result = runTokenEventUpsert(statements.upsert, event);
    if (result.changes === 0 && !tokenEventHasOwner(statements.owner, event)) {
      throw new Error('token event id collision could not be resolved');
    }
  }
  return event;
}

function tokenEventHasOwner(statement: ReturnType<DatabaseSync['prepare']>, event: ReturnType<typeof normalizeTokenEvent>) {
  return Boolean(statement.get(event.eventId, event.device, event.source));
}

function runTokenEventUpsert(statement, event) {
  return statement.run(
    event.eventId,
    event.device,
    event.source,
    event.sessionId,
    event.timestamp,
    event.model,
    event.inputTokens,
    event.outputTokens,
    event.cacheReadTokens,
    event.cacheCreationTokens,
    event.reasoningTokens,
    event.toolCategory,
    event.fileExtension,
    event.repoPathHash,
    event.privacyLevel
  );
}

export function scopedTokenEventId(event) {
  const suffix = createHash('sha256')
    .update(`${event.eventId}\0${event.device}\0${event.source}`)
    .digest('hex')
    .slice(0, 24);
  return `${event.eventId.slice(0, 214)}::${suffix}`;
}

export function listTokenEvents(db, { limit = 500, since = null } = {}) {
  const safeLimit = limit == null ? null : Math.max(1, Math.min(5000, Number(limit) || 500));
  const sinceValue = typeof since === 'string' && since ? since : null;
  const where = sinceValue ? 'WHERE timestamp >= ?' : '';
  const limitClause = safeLimit == null ? '' : 'LIMIT ?';
  const parameters = safeLimit == null
    ? sinceValue ? [sinceValue] : []
    : sinceValue ? [sinceValue, safeLimit] : [safeLimit];
  return db.prepare(`
    SELECT event_id AS eventId, device, source, session_id AS sessionId,
      timestamp, model,
      input_tokens AS inputTokens,
      output_tokens AS outputTokens,
      cache_read_tokens AS cacheReadTokens,
      cache_creation_tokens AS cacheCreationTokens,
      reasoning_tokens AS reasoningTokens,
      tool_category AS toolCategory,
      file_extension AS fileExtension,
      repo_path_hash AS repoPathHash,
      privacy_level AS privacyLevel,
      updated_at AS updatedAt
    FROM token_events
    ${where}
    ORDER BY timestamp DESC
    ${limitClause}
  `).all(...parameters);
}

export function normalizeWorkItem(row: InputRecord = {}) {
  const id = normalizeOptionalId(row.id, 'id');
  const title = normalizedRequiredMax(row.title, 'title', 160);
  const projectAlias = normalizeOptionalText(row.projectAlias ?? row.project_alias, 'projectAlias', 120);
  const workType = normalizeEnum(row.workType ?? row.work_type, WORK_ITEM_TYPES, WORK_ITEM_TYPES[0], 'workType');
  const status = normalizeEnum(row.status, OUTPUT_STATUSES, OUTPUT_STATUSES[0], 'status');
  const valueLevel = normalizeEnum(row.valueLevel ?? row.value_level, VALUE_LEVELS, VALUE_LEVELS[0], 'valueLevel');
  const outputUrl = row.outputUrl || row.output_url ? normalizeOutputUrl(row.outputUrl ?? row.output_url) : null;
  const outputType = normalizeEnum(row.outputType ?? row.output_type, OUTPUT_TYPES, OUTPUT_TYPES[0], 'outputType');
  return { id, title, projectAlias, workType, status, valueLevel, outputUrl, outputType };
}

export function upsertWorkItem(db, row: InputRecord = {}) {
  const item = normalizeWorkItem(row);
  db.prepare(`
    INSERT INTO work_items (
      id, title, project_alias, work_type, status, value_level,
      output_url, output_type, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      project_alias = excluded.project_alias,
      work_type = excluded.work_type,
      status = excluded.status,
      value_level = excluded.value_level,
      output_url = excluded.output_url,
      output_type = excluded.output_type,
      updated_at = datetime('now')
  `).run(
    item.id,
    item.title,
    item.projectAlias,
    item.workType,
    item.status,
    item.valueLevel,
    item.outputUrl,
    item.outputType
  );
  const id = item.id ?? db.prepare('SELECT last_insert_rowid() AS id').get().id;
  return getWorkItem(db, id);
}

export function getWorkItem(db, id) {
  const itemId = normalizeRequiredId(id, 'id');
  return db.prepare(`
    SELECT id, title,
      project_alias AS projectAlias,
      work_type AS workType,
      status,
      value_level AS valueLevel,
      output_url AS outputUrl,
      output_type AS outputType,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM work_items
    WHERE id = ?
  `).get(itemId);
}

export function listWorkItems(db) {
  const items = db.prepare(`
    SELECT id, title,
      project_alias AS projectAlias,
      work_type AS workType,
      status,
      value_level AS valueLevel,
      output_url AS outputUrl,
      output_type AS outputType,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM work_items
    ORDER BY updated_at DESC, id DESC
  `).all();
  const sessions = db.prepare(`
    SELECT work_item_id AS workItemId, device, source, session_id AS sessionId,
      linked_at AS linkedAt
    FROM work_item_sessions
    ORDER BY linked_at DESC
  `).all();
  const byItem = new Map();
  for (const session of sessions) {
    if (!byItem.has(session.workItemId)) byItem.set(session.workItemId, []);
    byItem.get(session.workItemId).push(session);
  }
  return items.map(item => ({
    ...item,
    sessions: byItem.get(item.id) || []
  }));
}

export function linkWorkItemSessions(db, payload: InputRecord = {}) {
  const workItemId = normalizeRequiredId(payload.workItemId ?? payload.work_item_id ?? payload.id, 'workItemId');
  const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
  if (!sessions.length) throw new Error('sessions must include at least one item');
  let linked = 0;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO work_item_sessions (work_item_id, device, source, session_id, linked_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `);
  db.exec('BEGIN');
  try {
    for (const row of sessions) {
      const identity = normalizeSessionIdentity(row);
      linked += insert.run(workItemId, identity.device, identity.source, identity.sessionId).changes;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { workItemId, linked };
}

export function deleteWorkItem(db, row: InputRecord = {}) {
  const id = normalizeRequiredId(row.id, 'id');
  return db.prepare('DELETE FROM work_items WHERE id = ?').run(id).changes;
}

export function normalizeBudgetProfile(row: InputRecord = {}) {
  const id = normalizeOptionalId(row.id, 'id');
  const source = normalizeOptionalText(row.source, 'source', 120) || '';
  const modelGroup = normalizeOptionalText(row.modelGroup ?? row.model_group, 'modelGroup', 120) || '';
  const label = normalizedRequiredMax(row.label, 'label', 140);
  const windowType = normalizeEnum(row.windowType ?? row.window_type, BUDGET_WINDOW_TYPES, 'rolling', 'windowType');
  const windowMinutes = normalizePositiveInteger(row.windowMinutes ?? row.window_minutes, 'windowMinutes', 10_080);
  const tokenBudget = normalizeTokenCount(row.tokenBudget ?? row.token_budget, 'tokenBudget');
  const costBudgetUSD = normalizeNonNegativeNumber(row.costBudgetUSD ?? row.cost_budget_usd, 'costBudgetUSD');
  const resetAnchor = normalizeResetAnchor(row.resetAnchor ?? row.reset_anchor, windowType);
  const warningThreshold = normalizeWarningThreshold(row.warningThreshold ?? row.warning_threshold);
  const hardThreshold = normalizeHardThreshold(row.hardThreshold ?? row.hard_threshold);
  const enabled = normalizeBoolean(row.enabled, true);
  if (tokenBudget === 0 && costBudgetUSD === 0) {
    throw new Error('tokenBudget or costBudgetUSD must be greater than 0');
  }
  return { id, source, modelGroup, label, windowType, windowMinutes, tokenBudget, costBudgetUSD, resetAnchor, warningThreshold, hardThreshold, enabled };
}

export function upsertBudgetProfile(db, row: InputRecord = {}) {
  const profile = normalizeBudgetProfile(row);
  db.prepare(`
    INSERT INTO budget_profiles (
      id, source, model_group, label, window_type, window_minutes,
      token_budget, cost_budget_usd, reset_anchor, warning_threshold, hard_threshold,
      enabled, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      source = excluded.source,
      model_group = excluded.model_group,
      label = excluded.label,
      window_type = excluded.window_type,
      window_minutes = excluded.window_minutes,
      token_budget = excluded.token_budget,
      cost_budget_usd = excluded.cost_budget_usd,
      reset_anchor = excluded.reset_anchor,
      warning_threshold = excluded.warning_threshold,
      hard_threshold = excluded.hard_threshold,
      enabled = excluded.enabled,
      updated_at = datetime('now')
  `).run(
    profile.id,
    profile.source,
    profile.modelGroup,
    profile.label,
    profile.windowType,
    profile.windowMinutes,
    profile.tokenBudget,
    profile.costBudgetUSD,
    profile.resetAnchor,
    profile.warningThreshold,
    profile.hardThreshold,
    profile.enabled ? 1 : 0
  );
  const id = profile.id ?? db.prepare('SELECT last_insert_rowid() AS id').get().id;
  return getBudgetProfile(db, id);
}

export function getBudgetProfile(db, id) {
  const profileId = normalizeRequiredId(id, 'id');
  const row = db.prepare(`
    SELECT id, source,
      model_group AS modelGroup,
      label,
      window_type AS windowType,
      window_minutes AS windowMinutes,
      token_budget AS tokenBudget,
      cost_budget_usd AS costBudgetUSD,
      reset_anchor AS resetAnchor,
      warning_threshold AS warningThreshold,
      hard_threshold AS hardThreshold,
      enabled,
      updated_at AS updatedAt
    FROM budget_profiles
    WHERE id = ?
  `).get(profileId);
  return row ? { ...row, enabled: Boolean(row.enabled) } : null;
}

export function listBudgetProfiles(db) {
  return db.prepare(`
    SELECT id, source,
      model_group AS modelGroup,
      label,
      window_type AS windowType,
      window_minutes AS windowMinutes,
      token_budget AS tokenBudget,
      cost_budget_usd AS costBudgetUSD,
      reset_anchor AS resetAnchor,
      warning_threshold AS warningThreshold,
      hard_threshold AS hardThreshold,
      enabled,
      updated_at AS updatedAt
    FROM budget_profiles
    ORDER BY enabled DESC, source ASC, updated_at DESC, id DESC
  `).all().map(row => ({ ...row, enabled: Boolean(row.enabled) }));
}

export function deleteBudgetProfile(db, row: InputRecord = {}) {
  const id = normalizeRequiredId(row.id, 'id');
  return db.prepare('DELETE FROM budget_profiles WHERE id = ?').run(id).changes;
}

export function normalizeAdvisorAction(row: InputRecord = {}) {
  const id = normalizeOptionalId(row.id, 'id');
  const periodStart = normalizedRequiredMax(row.periodStart ?? row.period_start, 'periodStart', 40);
  const periodEnd = normalizedRequiredMax(row.periodEnd ?? row.period_end, 'periodEnd', 40);
  const category = normalizedRequiredMax(row.category, 'category', 80);
  const title = normalizedRequiredMax(row.title, 'title', 180);
  const action = normalizedRequiredMax(row.action, 'action', 700);
  const evidence = normalizeOptionalText(row.evidence, 'evidence', 1200);
  const sourceRule = normalizeOptionalText(row.sourceRule ?? row.source_rule, 'sourceRule', 180);
  const status = normalizeEnum(row.status, ADVISOR_ACTION_STATUSES, 'open', 'status');
  const completedAt = status === 'open'
    ? null
    : normalizeOptionalText(row.completedAt ?? row.completed_at, 'completedAt', 80) || new Date().toISOString();
  return { id, periodStart, periodEnd, category, title, action, evidence, sourceRule, status, completedAt };
}

export function upsertAdvisorAction(db, row: InputRecord = {}) {
  const item = normalizeAdvisorAction(row);
  const existing = item.id ? null : item.sourceRule
    ? db.prepare(`
      SELECT id FROM advisor_actions
      WHERE period_start = ? AND period_end = ? AND source_rule = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(item.periodStart, item.periodEnd, item.sourceRule)
    : null;
  const id = item.id ?? existing?.id ?? null;

  db.prepare(`
    INSERT INTO advisor_actions (
      id, period_start, period_end, category, title, action,
      evidence, source_rule, status, completed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      period_start = excluded.period_start,
      period_end = excluded.period_end,
      category = excluded.category,
      title = excluded.title,
      action = excluded.action,
      evidence = excluded.evidence,
      source_rule = excluded.source_rule,
      status = excluded.status,
      completed_at = excluded.completed_at,
      updated_at = datetime('now')
  `).run(
    id,
    item.periodStart,
    item.periodEnd,
    item.category,
    item.title,
    item.action,
    item.evidence,
    item.sourceRule,
    item.status,
    item.completedAt
  );
  return getAdvisorAction(db, id ?? db.prepare('SELECT last_insert_rowid() AS id').get().id);
}

export function getAdvisorAction(db, id) {
  const itemId = normalizeRequiredId(id, 'id');
  return db.prepare(`
    SELECT id,
      period_start AS periodStart,
      period_end AS periodEnd,
      category, title, action, evidence,
      source_rule AS sourceRule,
      status,
      created_at AS createdAt,
      completed_at AS completedAt,
      updated_at AS updatedAt
    FROM advisor_actions
    WHERE id = ?
  `).get(itemId);
}

export function listAdvisorActions(db, filters: InputRecord = {}) {
  const periodStart = normalizeOptionalText(filters.periodStart ?? filters.period_start, 'periodStart', 40);
  const periodEnd = normalizeOptionalText(filters.periodEnd ?? filters.period_end, 'periodEnd', 40);
  if (periodStart && periodEnd) {
    return db.prepare(`
      SELECT id,
        period_start AS periodStart,
        period_end AS periodEnd,
        category, title, action, evidence,
        source_rule AS sourceRule,
        status,
        created_at AS createdAt,
        completed_at AS completedAt,
        updated_at AS updatedAt
      FROM advisor_actions
      WHERE period_start = ? AND period_end = ?
      ORDER BY status = 'open' DESC, updated_at DESC, id DESC
    `).all(periodStart, periodEnd);
  }
  return db.prepare(`
    SELECT id,
      period_start AS periodStart,
      period_end AS periodEnd,
      category, title, action, evidence,
      source_rule AS sourceRule,
      status,
      created_at AS createdAt,
      completed_at AS completedAt,
      updated_at AS updatedAt
    FROM advisor_actions
    ORDER BY status = 'open' DESC, updated_at DESC, id DESC
    LIMIT 200
  `).all();
}

export function deleteAdvisorAction(db, row: InputRecord = {}) {
  const id = normalizeRequiredId(row.id, 'id');
  return db.prepare('DELETE FROM advisor_actions WHERE id = ?').run(id).changes;
}

function normalizeSessionIdentity(row: InputRecord = {}) {
  return {
    device: normalizedRequired(row.device, 'device'),
    source: normalizedRequired(row.source, 'source'),
    sessionId: normalizedRequired(row.sessionId ?? row.session_id, 'sessionId')
  };
}

function inputRecord(value: unknown): InputRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as InputRecord
    : {};
}

function normalizedRequired(value, field) {
  return normalizedRequiredMax(value, field, 300);
}

function normalizedRequiredMax(value, field, maxLength) {
  const text = normalizeText(value);
  if (!text) throw new Error(`${field} is required`);
  if (text.length > maxLength) throw new Error(`${field} must be ${maxLength} characters or less`);
  return text;
}

function normalizeOptionalText(value, field, maxLength) {
  const text = normalizeText(value);
  if (!text) return null;
  if (text.length > maxLength) throw new Error(`${field} must be ${maxLength} characters or less`);
  return text;
}

function normalizeEnum(value, allowed, fallback, field) {
  const text = normalizeText(value) || fallback;
  if (!allowed.includes(text)) {
    throw new Error(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return text;
}

function normalizeBoolean(value, fallback) {
  if (value == null || value === '') return Boolean(fallback);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  throw new Error('enabled must be a boolean');
}

function normalizeConfidence(value, fallback) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 100) {
    throw new Error('annotationConfidence must be an integer from 0 to 100');
  }
  return number;
}

function normalizeTokenCount(value, field) {
  const number = Number(value || 0);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return number;
}

function normalizeUsageTokens(row: InputRecord) {
  return {
    inputTokens: normalizeTokenCount(row.inputTokens ?? row.input_tokens, 'inputTokens'),
    outputTokens: normalizeTokenCount(row.outputTokens ?? row.output_tokens, 'outputTokens'),
    cacheCreationTokens: normalizeTokenCount(row.cacheCreationTokens ?? row.cache_creation_tokens, 'cacheCreationTokens'),
    cacheReadTokens: normalizeTokenCount(row.cacheReadTokens ?? row.cache_read_tokens, 'cacheReadTokens'),
    cachedInputTokens: normalizeTokenCount(row.cachedInputTokens ?? row.cached_input_tokens, 'cachedInputTokens'),
    reasoningOutputTokens: normalizeTokenCount(row.reasoningOutputTokens ?? row.reasoning_output_tokens, 'reasoningOutputTokens')
  };
}

function normalizeUsageTotal(value: unknown, tokens: Record<string, number>) {
  const computed = Object.values(tokens).reduce((sum, count) => sum + count, 0);
  if (value == null || value === '') return computed;
  return Math.max(normalizeTokenCount(value, 'totalTokens'), computed);
}

function normalizeUsageDate(value) {
  const text = normalizedRequiredMax(value, 'usageDate', 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error('usageDate must use YYYY-MM-DD');
  }
  const date = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw new Error('usageDate must be a valid date');
  }
  return text;
}

function normalizeOptionalTimestamp(value, field) {
  const text = normalizeOptionalText(value, field, 80);
  if (!text) return null;
  if (Number.isNaN(new Date(text).getTime())) {
    throw new Error(`${field} must be a valid date/time`);
  }
  return text;
}

function normalizeOptionalRawText(value, field, maxLength) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (text.length > maxLength) throw new Error(`${field} must be ${maxLength} characters or less`);
  return text;
}

function normalizePositiveInteger(value, field, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0 || number > max) {
    throw new Error(`${field} must be a positive integer no greater than ${max}`);
  }
  return number;
}

function normalizeNonNegativeNumber(value, field) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${field} must be a non-negative number`);
  }
  return number;
}

function normalizeWarningThreshold(value) {
  if (value == null || value === '') return 0.75;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 1) {
    throw new Error('warningThreshold must be greater than 0 and no greater than 1');
  }
  return number;
}

function normalizeHardThreshold(value) {
  if (value == null || value === '') return 1;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0.5 || number > 2) {
    throw new Error('hardThreshold must be at least 0.5 and no greater than 2');
  }
  return number;
}

function normalizeResetAnchor(value, windowType) {
  const text = normalizeOptionalText(value, 'resetAnchor', 80);
  if (!text) return null;
  if (windowType !== 'fixed') return null;
  const ms = new Date(text).getTime();
  if (!Number.isFinite(ms)) {
    throw new Error('resetAnchor must be a valid date/time for fixed budget windows');
  }
  return new Date(ms).toISOString();
}

function autoRunId() {
  return `auto-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

function normalizeOptionalId(value, field) {
  if (value == null || value === '') return null;
  return normalizeRequiredId(value, field);
}

function normalizeRequiredId(value, field) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`${field} must be a positive integer`);
  return id;
}

function normalizeOutputUrl(value) {
  const text = normalizeOptionalText(value, 'outputUrl', 500);
  if (!text) throw new Error('outputUrl is required');
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error('outputUrl must be a valid URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('outputUrl must use http or https');
  }
  return parsed.href;
}

function hasAny(row, keys) {
  return keys.some(key => Object.prototype.hasOwnProperty.call(row, key));
}

function normalizeText(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function ensureColumn(db, table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all()
    .some(info => info.name === column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
