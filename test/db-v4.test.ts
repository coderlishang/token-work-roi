import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deleteAdvisorAction,
  deleteBudgetProfile,
  createSqliteBackup,
  listAdvisorActions,
  listBudgetProfiles,
  linkWorkItemSessions,
  listTokenEvents,
  listWorkItems,
  openDb,
  repairStoredCosts,
  repairUsageTotals,
  storedCostsNeedRepair,
  upsertDaily,
  upsertAdvisorAction,
  upsertBudgetProfile,
  upsertSession,
  upsertTokenEvent,
  usageTotalsNeedRepair,
  upsertWorkItem
} from '../src/db.ts';
import { buildTerminalReport } from '../src/terminal-report.ts';
import { calculateCost } from '../src/pricing.ts';

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'token-work-roi-'));
  return openDb(join(dir, 'usage.sqlite'));
}

test('backup retention is rate limited and keeps only the latest full backup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-work-backup-'));
  const dbPath = join(dir, 'usage.sqlite');
  const backupDir = join(dir, 'backups');
  const db = openDb(dbPath);

  const first = createSqliteBackup(db, dbPath, {
    reason: 'scheduled-collect',
    backupDir,
    minimumIntervalMs: 60_000,
    now: new Date('2026-07-19T00:00:00.000Z')
  });
  assert.ok(first && existsSync(first.path));
  utimesSync(first.path, new Date('2026-07-19T00:00:00.000Z'), new Date('2026-07-19T00:00:00.000Z'));

  const skipped = createSqliteBackup(db, dbPath, {
    reason: 'scheduled-collect',
    backupDir,
    minimumIntervalMs: 60_000,
    now: new Date('2026-07-19T00:00:30.000Z')
  });
  assert.equal(skipped, null);

  for (const now of ['2026-07-19T01:00:00.000Z', '2026-07-19T02:00:00.000Z']) {
    const backup = createSqliteBackup(db, dbPath, {
      reason: 'scheduled-collect',
      backupDir,
      now: new Date(now)
    });
    assert.ok(backup && existsSync(backup.path));
  }
  assert.equal(readdirSync(backupDir).filter(name => name.endsWith('-scheduled-collect.sqlite')).length, 1);

  const manual = createSqliteBackup(db, dbPath, {
    reason: 'collect',
    backupDir,
    now: new Date('2026-07-19T02:00:00.000Z')
  });
  assert.ok(manual && existsSync(manual.path));
  const manualBackups = () => readdirSync(backupDir)
    .filter(name => name.endsWith('-collect.sqlite') && !name.endsWith('-scheduled-collect.sqlite'));
  assert.deepEqual(readdirSync(backupDir), [manual.fileName]);

  const newerManual = createSqliteBackup(db, dbPath, {
    reason: 'collect',
    backupDir,
    now: new Date('2026-07-19T03:00:00.000Z')
  });
  assert.ok(newerManual && existsSync(newerManual.path));
  assert.deepEqual(manualBackups(), [newerManual.fileName]);
  const scheduledAfterManual = createSqliteBackup(db, dbPath, {
    reason: 'scheduled-collect',
    backupDir,
    minimumIntervalMs: 24 * 60 * 60 * 1000,
    now: new Date('2026-07-19T03:01:00.000Z')
  });
  assert.equal(scheduledAfterManual, null);
  assert.deepEqual(readdirSync(backupDir), [newerManual.fileName]);
  db.close();
});

test('token_events upsert is idempotent and privacy bounded', () => {
  const db = tempDb();
  upsertTokenEvent(db, {
    eventId: 'evt-1',
    device: 'demo',
    source: 'Codex CLI',
    sessionId: 's1',
    timestamp: '2026-06-17T00:00:00Z',
    model: 'codex-mini',
    inputTokens: 10,
    outputTokens: 3,
    toolCategory: 'edit',
    fileExtension: '.js',
    repoPathHash: 'abc',
    privacyLevel: 'hashed'
  });
  upsertTokenEvent(db, {
    eventId: 'evt-1',
    device: 'demo',
    source: 'Codex CLI',
    sessionId: 's1',
    timestamp: '2026-06-17T00:00:00Z',
    model: 'codex-mini',
    inputTokens: 20,
    outputTokens: 5,
    privacyLevel: 'safe'
  });
  const rows = listTokenEvents(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].inputTokens, 20);
  assert.equal(rows[0].privacyLevel, 'safe');
  db.close();
});

test('identical usage upserts do not rewrite stored rows', () => {
  const db = tempDb();
  const daily = { device: 'demo', source: 'Codex', usageDate: '2026-08-09', model: 'gpt-5.6', inputTokens: 10, totalTokens: 10 };
  const session = { device: 'demo', source: 'Codex', sessionId: 'session-1', model: 'gpt-5.6', inputTokens: 10, totalTokens: 10 };
  const event = { eventId: 'event-1', device: 'demo', source: 'Codex', sessionId: 'session-1', timestamp: '2026-08-09T00:00:00Z', model: 'gpt-5.6', inputTokens: 10 };
  upsertDaily(db, daily);
  upsertSession(db, session);
  upsertTokenEvent(db, event);
  db.exec(`
    UPDATE daily_usage SET updated_at = '2000-01-01';
    UPDATE session_usage SET updated_at = '2000-01-01';
    UPDATE token_events SET updated_at = '2000-01-01';
  `);

  upsertDaily(db, daily);
  upsertSession(db, session);
  upsertTokenEvent(db, event);

  assert.equal(db.prepare(`SELECT updated_at FROM daily_usage`).get().updated_at, '2000-01-01');
  assert.equal(db.prepare(`SELECT updated_at FROM session_usage`).get().updated_at, '2000-01-01');
  assert.equal(db.prepare(`SELECT updated_at FROM token_events`).get().updated_at, '2000-01-01');
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM token_events`).get().count, 1);
  db.close();
});

test('stored usage totals include reasoning tokens after repair', () => {
  const db = tempDb();
  upsertDaily(db, {
    device: 'demo', source: 'codex', usageDate: '2026-07-20', model: 'gpt-5.6',
    inputTokens: 10, outputTokens: 5, cachedInputTokens: 7, reasoningOutputTokens: 3, totalTokens: 25
  });
  upsertSession(db, {
    device: 'demo', source: 'codex', sessionId: 's1', model: 'gpt-5.6',
    inputTokens: 10, outputTokens: 5, cachedInputTokens: 7, reasoningOutputTokens: 3, totalTokens: 25
  });
  db.prepare(`UPDATE daily_usage SET total_tokens = 15`).run();
  db.prepare(`UPDATE session_usage SET total_tokens = 15`).run();
  assert.equal(usageTotalsNeedRepair(db), true);
  assert.deepEqual(repairUsageTotals(db), { daily: 1, sessions: 1 });
  assert.equal(usageTotalsNeedRepair(db), false);
  db.close();
});

test('stored usage totals preserve a larger upstream total', () => {
  const db = tempDb();
  upsertDaily(db, {
    device: 'demo', source: 'aggregate', usageDate: '2026-07-20', model: 'unknown',
    inputTokens: 10, outputTokens: 5, totalTokens: 30
  });
  upsertSession(db, {
    device: 'demo', source: 'aggregate', sessionId: 's1', model: 'unknown',
    inputTokens: 10, outputTokens: 5, totalTokens: 30
  });
  assert.equal(usageTotalsNeedRepair(db), false);
  assert.deepEqual(repairUsageTotals(db), { daily: 0, sessions: 0 });
  assert.equal(db.prepare(`SELECT total_tokens FROM daily_usage`).get().total_tokens, 30);
  assert.equal(db.prepare(`SELECT total_tokens FROM session_usage`).get().total_tokens, 30);
  db.close();
});

test('token event ids do not overwrite another device or source', () => {
  const db = tempDb();
  const event = {
    eventId: 'shared-event-id',
    source: 'Codex CLI',
    sessionId: 'shared-session',
    timestamp: '2026-07-19T00:00:00Z',
    model: 'gpt-5.5',
    inputTokens: 10,
    outputTokens: 2
  };

  upsertTokenEvent(db, { ...event, device: 'workstation-a' });
  upsertTokenEvent(db, { ...event, device: 'workstation-b', inputTokens: 20 });
  upsertTokenEvent(db, { ...event, device: 'workstation-b', inputTokens: 30 });
  upsertTokenEvent(db, { ...event, device: 'workstation-a', source: 'Claude Code', inputTokens: 40 });

  const rows = listTokenEvents(db, { limit: 10 });
  assert.equal(rows.length, 3);
  assert.equal(rows.find(row => row.device === 'workstation-a' && row.source === 'Codex CLI').inputTokens, 10);
  assert.equal(rows.find(row => row.device === 'workstation-b').inputTokens, 30);
  assert.equal(rows.find(row => row.source === 'Claude Code').inputTokens, 40);
  db.close();
});

test('usage rows persist session models and reject malformed numeric data', () => {
  const db = tempDb();
  upsertDaily(db, {
    device: 'demo',
    source: 'Codex CLI',
    usageDate: '2026-07-15',
    model: 'gpt-5.5',
    inputTokens: 10,
    outputTokens: 5,
    cachedInputTokens: 7,
    costUSD: 0.0002
  });
  upsertSession(db, {
    device: 'demo',
    source: 'Codex CLI',
    sessionId: 'session-with-model',
    lastActivity: '2026-07-15T01:00:00.000Z',
    model: 'gpt-5.5',
    inputTokens: 10,
    outputTokens: 5,
    costUSD: 0.0002
  });
  upsertSession(db, {
    device: 'demo',
    source: 'Codex CLI',
    sessionId: 'session-with-model',
    inputTokens: 20,
    outputTokens: 10
  });

  const session = db.prepare('SELECT model, last_activity AS lastActivity, total_tokens AS totalTokens FROM session_usage').get();
  assert.equal(session.model, 'gpt-5.5');
  assert.equal(session.lastActivity, '2026-07-15T01:00:00.000Z');
  assert.equal(session.totalTokens, 30);
  const report = buildTerminalReport(db, { period: 'all' });
  assert.equal(report.totals.totalTokens, 22);
  assert.equal(report.totals.cacheReadTokens, 7);
  upsertDaily(db, {
    device: 'demo',
    source: 'Codex CLI',
    usageDate: '2026-07-16',
    model: 'gpt-5.5',
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 1
  });
  assert.equal(
    db.prepare("SELECT total_tokens AS totalTokens FROM daily_usage WHERE usage_date = '2026-07-16'").get().totalTokens,
    15
  );
  assert.throws(() => upsertDaily(db, {
    device: 'demo',
    source: 'Codex CLI',
    usageDate: '2026-02-30',
    inputTokens: 1
  }), /valid date/);
  assert.throws(() => upsertSession(db, {
    device: 'demo',
    source: 'Codex CLI',
    sessionId: 'bad-token-count',
    inputTokens: -1
  }), /non-negative integer/);
  db.close();
});

test('work items can be created and linked to sessions', () => {
  const db = tempDb();
  upsertSession(db, {
    device: 'demo',
    source: 'Codex CLI',
    sessionId: 's1',
    lastActivity: '2026-06-17',
    totalTokens: 100
  });
  const item = upsertWorkItem(db, {
    title: 'Ship Token Work ROI',
    projectAlias: 'Token Work ROI',
    workType: '功能开发',
    status: '已发布',
    valueLevel: '高',
    outputUrl: 'https://example.com/pr/1',
    outputType: 'PR'
  });
  const linked = linkWorkItemSessions(db, {
    workItemId: item.id,
    sessions: [{ device: 'demo', source: 'Codex CLI', sessionId: 's1' }]
  });
  assert.equal(linked.linked, 1);
  const items = listWorkItems(db);
  assert.equal(items.length, 1);
  assert.equal(items[0].sessions.length, 1);
  db.close();
});

test('budget profiles validate custom local budgets', () => {
  const db = tempDb();
  const profile = upsertBudgetProfile(db, {
    source: 'claude',
    label: 'Claude 5h',
    windowMinutes: 300,
    tokenBudget: 500000
  });
  assert.equal(profile.source, 'claude');
  assert.equal(profile.enabled, true);
  assert.equal(listBudgetProfiles(db).length, 1);
  assert.throws(() => upsertBudgetProfile(db, {
    source: 'codex',
    label: 'invalid',
    windowMinutes: 0,
    tokenBudget: 100
  }), /windowMinutes/);
  assert.equal(deleteBudgetProfile(db, { id: profile.id }), 1);
  db.close();
});

test('budget profiles support fixed reset windows and warning thresholds', () => {
  const db = tempDb();
  const profile = upsertBudgetProfile(db, {
    source: 'Codex CLI',
    label: 'Codex fixed 5h',
    windowType: 'fixed',
    windowMinutes: 300,
    resetAnchor: '2026-06-17T00:00:00Z',
    warningThreshold: 0.6,
    tokenBudget: 100000
  });
  assert.equal(profile.windowType, 'fixed');
  assert.equal(profile.resetAnchor, '2026-06-17T00:00:00.000Z');
  assert.equal(profile.warningThreshold, 0.6);

  const rolling = upsertBudgetProfile(db, {
    id: profile.id,
    source: 'Codex CLI',
    label: 'Codex rolling',
    windowType: 'rolling',
    windowMinutes: 60,
    resetAnchor: '2026-06-17T00:00:00Z',
    warningThreshold: 0.75,
    tokenBudget: 100000
  });
  assert.equal(rolling.windowType, 'rolling');
  assert.equal(rolling.resetAnchor, null);
  assert.throws(() => upsertBudgetProfile(db, {
    source: 'Codex CLI',
    label: 'bad threshold',
    windowType: 'fixed',
    windowMinutes: 300,
    resetAnchor: '2026-06-17T00:00:00Z',
    warningThreshold: 1.5,
    tokenBudget: 1000
  }), /warningThreshold/);
  db.close();
});

test('advisor actions upsert by period and source rule', () => {
  const db = tempDb();
  const first = upsertAdvisorAction(db, {
    periodStart: '2026-06-01',
    periodEnd: '2026-06-07',
    category: '节省模拟',
    title: '测试验证换轻量模型',
    action: '下周测试验证默认先用轻量模型',
    evidence: '2 sessions',
    sourceRule: 'savings:test',
    status: 'open'
  });
  const updated = upsertAdvisorAction(db, {
    periodStart: '2026-06-01',
    periodEnd: '2026-06-07',
    category: '节省模拟',
    title: '测试验证换轻量模型',
    action: '下周测试验证默认先用轻量模型',
    evidence: '2 sessions',
    sourceRule: 'savings:test',
    status: 'done'
  });
  assert.equal(updated.id, first.id);
  assert.equal(updated.status, 'done');
  assert.ok(updated.completedAt);
  assert.equal(listAdvisorActions(db, { periodStart: '2026-06-01', periodEnd: '2026-06-07' }).length, 1);
  assert.equal(deleteAdvisorAction(db, { id: updated.id }), 1);
  db.close();
});

test('stored cost repair reprices stale rows by current official rates', () => {
  const db = tempDb();
  try {
    // 已定价模型:落库时价为 0(如价目后补的 ccusage 导入行),应按当前价目重算
    upsertDaily(db, {
      device: 'dev1', source: 'Claude Code', usageDate: '2026-05-06', model: 'doubao-seed-2-0-code',
      inputTokens: 720788, outputTokens: 7466, cacheReadTokens: 1572504, costUSD: 0
    });
    upsertSession(db, {
      device: 'dev1', source: 'Claude Code', sessionId: 'import:2026-05-06', lastActivity: '2026-05-06T00:00:00.000Z',
      model: 'doubao-seed-2-0-code', inputTokens: 720788, outputTokens: 7466, cacheReadTokens: 1572504, costUSD: 0
    });
    // 未定价模型保持写入值,不得被清零或改写
    upsertDaily(db, {
      device: 'dev1', source: 'Codex CLI', usageDate: '2026-05-11', model: 'gpt-5.4-mini',
      inputTokens: 4396955, outputTokens: 100407, cacheReadTokens: 39721088, costUSD: 0.123
    });
    assert.equal(usageTotalsNeedRepair(db), false);
    assert.equal(storedCostsNeedRepair(db), true);
    const result = repairStoredCosts(db);
    assert.deepEqual(result, { daily: 1, sessions: 1 });
    const dailyCost = db.prepare(`SELECT cost_usd FROM daily_usage WHERE model='doubao-seed-2-0-code'`).get().cost_usd;
    const sessionCost = db.prepare(`SELECT cost_usd FROM session_usage WHERE model='doubao-seed-2-0-code'`).get().cost_usd;
    const expected = calculateCost('doubao-seed-2-0-code', {
      input: 720788, output: 7466, cacheRead: 1572504, cacheWrite: 0, reasoning: 0
    }, null, null, '2026-05-06');
    assert.equal(dailyCost, expected);
    assert.equal(sessionCost, expected);
    assert.equal(db.prepare(`SELECT cost_usd FROM daily_usage WHERE model='gpt-5.4-mini'`).get().cost_usd, 0.123);
    // 重跑幂等
    assert.equal(storedCostsNeedRepair(db), false);
    assert.deepEqual(repairStoredCosts(db), { daily: 0, sessions: 0 });
  } finally { db.close(); }
});

test('stored cost repair reprices event-backed sessions per event date and model', () => {
  const db = tempDb();
  try {
    // 跨 glm-5.3-flash 调价日(2026-09-18)的事件:重算须逐 (本地日期, 模型) 复现
    const events = [
      { timestamp: '2026-09-17T10:00:00.000Z', model: 'glm-5.3-flash', input: 1000, output: 200, cacheRead: 5000 },
      { timestamp: '2026-09-19T10:00:00.000Z', model: 'glm-5.3-flash', input: 3000, output: 400, cacheRead: 7000 },
      { timestamp: '2026-09-19T11:00:00.000Z', model: 'deepseek-v4-1-flash', input: 800, output: 100, cacheRead: 900 }
    ];
    let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, reasoning = 0, cost = 0;
    const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' });
    events.forEach((event, index) => {
      upsertTokenEvent(db, {
        device: 'dev1', source: 'Claude Code', sessionId: 'sess-mixed', eventId: `ev-${index}`,
        timestamp: event.timestamp, model: event.model,
        inputTokens: event.input, outputTokens: event.output, cacheReadTokens: event.cacheRead
      });
      input += event.input; output += event.output; cacheRead += event.cacheRead;
      cost += calculateCost(event.model, {
        input: event.input, output: event.output, cacheRead: event.cacheRead, cacheWrite: 0, reasoning: 0
      }, null, null, fmt.format(new Date(event.timestamp)));
    });
    upsertSession(db, {
      device: 'dev1', source: 'Claude Code', sessionId: 'sess-mixed', lastActivity: events[events.length - 1].timestamp,
      model: 'glm-5.3-flash', inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, costUSD: cost
    });
    // 逐事件复现值与存储一致 → 不改写
    assert.equal(storedCostsNeedRepair(db), false);
    // 写入坏值后修复,须精确回到逐事件值(单日期粗算会偏离,以此保证测试判别力)
    db.prepare(`UPDATE session_usage SET cost_usd = 0 WHERE session_id='sess-mixed'`).run();
    assert.equal(storedCostsNeedRepair(db), true);
    assert.deepEqual(repairStoredCosts(db), { daily: 0, sessions: 1 });
    const repaired = db.prepare(`SELECT cost_usd FROM session_usage WHERE session_id='sess-mixed'`).get().cost_usd;
    assert.equal(repaired, cost);
    const naive = calculateCost('glm-5.3-flash', {
      input, output, cacheRead, cacheWrite: 0, reasoning: 0
    }, null, null, '2026-09-19');
    assert.notEqual(naive, cost);
  } finally { db.close(); }
});
