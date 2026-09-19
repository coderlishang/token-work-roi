import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_SESSION_ANNOTATION,
  OUTPUT_STATUSES,
  OUTPUT_TYPES,
  TASK_TYPES,
  VALUE_LEVELS,
  WORK_PURPOSES,
  WORK_STAGES,
  defaultDbPath,
  listProjectAliasRules,
  matchProjectAliasRule
} from './db.ts';
import { attachOfficialPricing } from './pricing.ts';
import { providerFromSource } from './provider.ts';
import { buildReviewClosureProgress } from './client/review/closure-progress.ts';
import { buildRoiAdvisor } from './client/review/roi-advisor.ts';
import type { UsageRow } from './client/shared/types.ts';

interface ClosureAuditOptions {
  targetAttributedSessions?: number;
  targetOutputLinks?: number;
  targetNonLabelAdvice?: number;
  topGapLimit?: number;
  dbPath?: string;
}

interface ClosureCheckArgs extends ClosureAuditOptions {
  json: boolean;
  failOnIncomplete: boolean;
  worklist: boolean;
  templateJson: boolean;
  outPath: string | null;
  worklistLimit: number;
  help?: boolean;
}

export function openReadOnlyDb(dbPath = defaultDbPath) {
  const resolved = resolve(dbPath);
  if (!existsSync(resolved)) {
    throw new Error(`SQLite database not found: ${resolved}`);
  }
  return new DatabaseSync(resolved, {
    readOnly: true,
    timeout: 10000
  });
}

export function buildClosureAuditFromDb(db, options: ClosureAuditOptions = {}) {
  assertRequiredTables(db);
  const daily = loadDailyRows(db);
  const sessions = loadSessionRows(db);
  const roiAdvice = buildRoiAdvisor({ sessions, daily });
  const progress = buildReviewClosureProgress({
    sessions,
    roiAdvice,
    targetAttributedSessions: options.targetAttributedSessions,
    targetOutputLinks: options.targetOutputLinks,
    targetNonLabelAdvice: options.targetNonLabelAdvice,
    topGapLimit: options.topGapLimit
  });
  const publicProgress = sanitizeProgress(progress);

  return {
    generatedAt: new Date().toISOString(),
    dbPath: options.dbPath || null,
    status: publicProgress.status,
    counts: {
      sessions: sessions.length,
      daily: daily.length,
      annotations: countRows(db, 'session_annotations'),
      outputs: countRows(db, 'session_outputs')
    },
    progress: publicProgress,
    roiAdvice
  };
}

export function formatClosureAudit(audit) {
  const lines = [
    'Token Work P0 Closure Check',
    '',
    `Status: ${audit.status === 'complete' ? 'complete' : 'needs-work'}`,
    audit.dbPath ? `DB: ${audit.dbPath}` : null,
    `Sessions: ${audit.counts.sessions}`,
    `Daily rows: ${audit.counts.daily}`,
    `Annotations: ${audit.counts.annotations}`,
    `Output links: ${audit.counts.outputs}`,
    '',
    'Checks:'
  ].filter(line => line != null);

  for (const check of audit.progress.checks) {
    lines.push(`- ${check.complete ? '[x]' : '[ ]'} ${check.label}: ${check.current}/${check.target} ${check.unit}`);
  }

  if (audit.progress.topGaps.length) {
    lines.push('', 'Top gaps:');
    for (const [index, row] of audit.progress.topGaps.slice(0, 5).entries()) {
      lines.push(`${index + 1}. ${row.project} | ${row.sessionId || 'unknown'} | missing ${row.missingFields.join(', ')} | ${formatInt(row.totalTokens)} tokens | ${money(row.costUSD)}`);
    }
  }

  if (audit.progress.nextActions.length) {
    lines.push('', 'Next actions:');
    audit.progress.nextActions.forEach((action, index) => {
      lines.push(`${index + 1}. ${action}`);
    });
  }

  lines.push(
    '',
    'Privacy: read-only SQLite audit; no collect command, no conversation content, no output-link fetching.'
  );

  return lines.join('\n');
}

export function formatClosureWorklist(audit, { limit = 10 } = {}) {
  const rows = audit.progress.topGaps.slice(0, Math.max(1, limit));
  const lines = [
    '# Token Work P0 Attribution Worklist',
    '',
    `- Generated at: ${audit.generatedAt}`,
    audit.dbPath ? `- SQLite: ${audit.dbPath}` : null,
    '- Scope: local structured usage and existing annotations only.',
    '- Privacy: no conversation content, no collect command, no SQLite writes, no output-link fetching.',
    '- Instructions: fill the blank columns manually after checking your real work, then save labels in the dashboard.',
    '',
    'Allowed values:',
    '- Task type: 未分类 / 功能开发 / 问题修复 / 代码审查 / 技术调研 / 内容创作 / 运维配置 / 其他',
    '- Output status: 未标注 / 进行中 / 已完成 / 已发布 / 已废弃',
    '- Work purpose: 未说明 / 需求澄清 / 方案设计 / 功能开发 / 调试修复 / 测试验证 / 代码审查 / 技术调研 / 文档内容 / 部署运维 / 上下文整理 / 其他',
    '- Work stage: 未说明 / 探索 / 实现 / 验证 / 发布 / 维护',
    '- Value level: 未评估 / 低 / 中 / 高 / 关键',
    ''
  ].filter(line => line != null);

  if (!rows.length) {
    return [
      ...lines,
      'No remaining P0 attribution gaps in the current SQLite database.'
    ].join('\n');
  }

  lines.push(markdownTable(
    [
      '#',
      'Project',
      'Session',
      'Missing fields',
      'Tokens',
      'Official price',
      'Project alias',
      'Task type',
      'Output status',
      'Work purpose',
      'Work stage',
      'Value level',
      'Output URL',
      'Output type'
    ],
    rows.map((row, index) => [
      index + 1,
      row.project,
      row.sessionId,
      row.missingFields.join(', '),
      formatInt(row.totalTokens),
      money(row.costUSD),
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      ''
    ])
  ));

  lines.push(
    '',
    'Completion gate:',
    `- Fully attributed sessions: ${audit.progress.checks.find(check => check.id === 'real-attribution')?.current || 0} / ${audit.progress.checks.find(check => check.id === 'real-attribution')?.target || 10}`,
    `- Output links: ${audit.progress.checks.find(check => check.id === 'output-links')?.current || 0} / ${audit.progress.checks.find(check => check.id === 'output-links')?.target || 3}`,
    `- Non-labeling Advisor items: ${audit.progress.checks.find(check => check.id === 'non-label-advice')?.current || 0} / ${audit.progress.checks.find(check => check.id === 'non-label-advice')?.target || 1}`
  );

  return lines.join('\n');
}

export function buildClosureImportTemplate(audit, { limit = 10 } = {}) {
  const rows = audit.progress.topGaps.slice(0, Math.max(1, limit));
  return {
    generatedAt: audit.generatedAt,
    dbPath: audit.dbPath,
    privacy: [
      'Generated from structured session_usage rows only.',
      'No collect command was run.',
      'No conversation content was read.',
      'No SQLite writes were performed.',
      'Fill labels manually from your real work before importing.'
    ],
    allowedValues: {
      taskType: TASK_TYPES,
      outputStatus: OUTPUT_STATUSES,
      workPurpose: WORK_PURPOSES,
      workStage: WORK_STAGES,
      valueLevel: VALUE_LEVELS,
      outputType: OUTPUT_TYPES
    },
    sessions: rows.map(row => ({
      device: row.device || '',
      source: row.source || '',
      sessionId: row.sessionId || '',
      projectPath: row.projectPath || '',
      projectHint: row.project || '',
      lastActivity: row.lastActivity || '',
      model: row.model || '',
      totalTokens: Number(row.totalTokens || 0),
      officialCostUSD: Number(row.costUSD || 0),
      missingFields: row.missingFields || [],
      projectAlias: '',
      taskType: '',
      outputStatus: '',
      workPurpose: '',
      workStage: '',
      valueLevel: '',
      note: '',
      outputUrl: '',
      outputLabel: '',
      outputType: ''
    }))
  };
}

export function formatClosureImportTemplate(audit, { limit = 10 } = {}) {
  return `${JSON.stringify(buildClosureImportTemplate(audit, { limit }), null, 2)}\n`;
}

export function parseArgs(argv = process.argv.slice(2)) {
  const options: ClosureCheckArgs = {
    dbPath: process.env.DB_PATH || defaultDbPath,
    json: false,
    failOnIncomplete: false,
    worklist: false,
    templateJson: false,
    outPath: null,
    worklistLimit: 10
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--fail-on-incomplete') {
      options.failOnIncomplete = true;
      continue;
    }
    if (arg === '--worklist') {
      options.worklist = true;
      continue;
    }
    if (arg === '--template-json') {
      options.templateJson = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--db') {
      options.dbPath = argv[++i];
      continue;
    }
    if (arg.startsWith('--db=')) {
      options.dbPath = arg.slice('--db='.length);
      continue;
    }
    if (arg === '--out') {
      options.outPath = argv[++i];
      continue;
    }
    if (arg.startsWith('--out=')) {
      options.outPath = arg.slice('--out='.length);
      continue;
    }
    if (arg.startsWith('--target-sessions=')) {
      options.targetAttributedSessions = parsePositiveInt(arg.slice('--target-sessions='.length), 'target-sessions');
      continue;
    }
    if (arg.startsWith('--target-outputs=')) {
      options.targetOutputLinks = parsePositiveInt(arg.slice('--target-outputs='.length), 'target-outputs');
      continue;
    }
    if (arg === '--limit') {
      options.worklistLimit = parsePositiveInt(argv[++i], 'limit');
      continue;
    }
    if (arg.startsWith('--limit=')) {
      options.worklistLimit = parsePositiveInt(arg.slice('--limit='.length), 'limit');
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (options.worklist || options.templateJson) {
    options.topGapLimit = options.worklistLimit;
  }

  return options;
}

function runCli() {
  try {
    const options = parseArgs();
    if (options.help) {
      console.log(helpText());
      return;
    }

    const dbPath = resolve(options.dbPath || defaultDbPath);
    const db = openReadOnlyDb(dbPath);
    try {
      const audit = buildClosureAuditFromDb(db, { ...options, dbPath });
      const output = options.templateJson
        ? formatClosureImportTemplate(audit, { limit: options.worklistLimit })
        : options.worklist
        ? formatClosureWorklist(audit, { limit: options.worklistLimit })
        : options.json ? JSON.stringify(audit, null, 2) : formatClosureAudit(audit);
      if (options.outPath) {
        const outPath = resolve(options.outPath);
        writeFileSync(outPath, output, 'utf8');
        console.log(`Wrote ${outPath}`);
      } else {
        console.log(output);
      }
      if (options.failOnIncomplete && audit.status !== 'complete') {
        process.exitCode = 1;
      }
    } finally {
      db.close();
    }
  } catch (error) {
    console.error(`closure:check failed: ${error.message}`);
    process.exitCode = 2;
  }
}

function assertRequiredTables(db) {
  const required = ['daily_usage', 'session_usage', 'session_annotations', 'session_outputs', 'project_alias_rules'];
  const existing = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
  const missing = required.filter(table => !existing.has(table));
  if (missing.length) {
    throw new Error(`SQLite schema is missing required table(s): ${missing.join(', ')}`);
  }
}

function loadSessionRows(db) {
  const aliasRules = listProjectAliasRules(db, { enabledOnly: true });
  return db.prepare(`
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
      o.output_url AS outputUrl,
      o.output_label AS outputLabel,
      COALESCE(o.output_type, '未分类') AS outputType
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
  `).all().map(row => {
    const projectPath = (row.projectPath && row.projectPath !== 'Unknown Project')
      ? row.projectPath
      : (row.sessionId ? row.sessionId.split('/').slice(-1)[0] || row.sessionId : null);
    const ruleProjectAlias = matchProjectAliasRule(projectPath, aliasRules);
    const model = row.model || modelFromSessionId(row.sessionId);
    return attachOfficialPricing({
      ...row,
      ...DEFAULT_SESSION_ANNOTATION,
      model,
      lastActivity: row.lastActivity ? String(row.lastActivity).slice(0, 10) : null,
      projectPath,
      projectAlias: row.manualProjectAlias || ruleProjectAlias || null,
      manualProjectAlias: row.manualProjectAlias || null,
      ruleProjectAlias,
      taskType: row.taskType || DEFAULT_SESSION_ANNOTATION.taskType,
      outputStatus: row.outputStatus || DEFAULT_SESSION_ANNOTATION.outputStatus,
      workPurpose: row.workPurpose || DEFAULT_SESSION_ANNOTATION.workPurpose,
      workStage: row.workStage || DEFAULT_SESSION_ANNOTATION.workStage,
      valueLevel: row.valueLevel || DEFAULT_SESSION_ANNOTATION.valueLevel,
      note: row.note || null,
      outputUrl: row.outputUrl || null,
      outputLabel: row.outputLabel || null,
      outputType: row.outputType || DEFAULT_SESSION_ANNOTATION.outputType
    }, model, providerFromSource(row.source));
  });
}

function loadDailyRows(db) {
  return db.prepare(`
    SELECT device, source,
      usage_date AS usageDate,
      model,
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
  `).all().map(row => attachOfficialPricing(
    row,
    row.model,
    providerFromSource(row.source),
    null,
    row.usageDate
  ));
}

function countRows(db, table) {
  return db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total;
}

function sanitizeProgress(progress) {
  return {
    ...progress,
    annotatedSessions: progress.annotatedSessions.map(summarizeSession),
    outputSessions: progress.outputSessions.map(summarizeSession),
    topGaps: progress.topGaps.map(({ session, ...row }) => row)
  };
}

function summarizeSession(session: UsageRow = {}) {
  return {
    device: session.device || '',
    source: session.source || '',
    sessionId: session.sessionId || '',
    project: session.projectAlias || session.projectPath || '',
    taskType: session.taskType || '',
    outputStatus: session.outputStatus || '',
    workPurpose: session.workPurpose || '',
    workStage: session.workStage || '',
    valueLevel: session.valueLevel || '',
    outputUrl: session.outputUrl || null,
    outputLabel: session.outputLabel || null,
    outputType: session.outputType || null,
    totalTokens: session.totalTokens || 0,
    costUSD: session.costUSD || 0
  };
}

function modelFromSessionId(sessionId) {
  const text = String(sessionId || '').trim();
  if (!text) return null;
  if (text.startsWith('local:')) return text.split(':').at(-1) || null;
  return null;
}

function parsePositiveInt(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return number;
}

function helpText() {
  return [
    'Usage: npm run closure:check -- [options]',
    '',
    'Options:',
    '  --db <path>              SQLite database path. Defaults to DB_PATH or data/usage.sqlite.',
    '  --json                   Print machine-readable JSON.',
    '  --worklist               Print a Markdown worksheet for the highest-cost attribution gaps.',
    '  --template-json          Print a fillable closure:import JSON template for the highest-cost attribution gaps.',
    '  --out <path>             Write command output as a UTF-8 file.',
    '  --limit=<n>              Worklist/template row limit. Default: 10.',
    '  --fail-on-incomplete     Exit 1 when the P0 closure gate is incomplete.',
    '  --target-sessions=<n>    Required fully attributed session count. Default: 10.',
    '  --target-outputs=<n>     Required completed/published output link count. Default: 3.',
    '  -h, --help               Show this help.',
    '',
    'This command is read-only: it does not run collect, write SQLite, read conversation content, or fetch output links.'
  ].join('\n');
}

function formatInt(value) {
  return new Intl.NumberFormat('zh-CN').format(Math.round(Number(value || 0)));
}

function money(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Number(value || 0));
}

function markdownTable(headers, rows) {
  return [
    `| ${headers.map(markdownCell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${row.map(markdownCell).join(' | ')} |`)
  ].join('\n');
}

function markdownCell(value) {
  const text = String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const formulaSafe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return formulaSafe.replace(/\|/g, '\\|');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runCli();
}
