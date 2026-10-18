import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  batchUpsertSessionAnnotations,
  deleteProjectAliasRule,
  deleteSessionOutput,
  exportAnnotationData,
  importAnnotationData,
  listProjectAliasRules,
  matchProjectAliasRule,
  openDb,
  upsertProjectAliasRule,
  upsertSession,
  upsertSessionAnnotation,
  upsertSessionOutput
} from '../src/db.ts';
import { resetClaudeRequestModelCache } from '../src/claude-settings.ts';
import { upsertDailyBatch, upsertTokenEvent } from '../src/db.ts';
import { canonicalModelName } from '../src/collectors/utils.ts';

test('GLM aliases normalize without changing other model families', () => {
  for (const [input, expected] of [
    ['glm-5-3-flash', 'glm-5.3-flash'], ['GLM-5.3-FLASH', 'glm-5.3-flash'],
    ['glm-5-2', 'glm-5.2'], ['glm-4-7-flashx', 'glm-4.7-flashx'],
    ['glm-5v-turbo', 'glm-5v-turbo'], ['claude-opus-4-7', 'claude-opus-4-7'],
    ['gpt-5.3-codex', 'gpt-5.3-codex'], ['custom-glm-5-3', 'custom-glm-5-3']
  ]) assert.equal(canonicalModelName(input), expected);
});

test('GLM history repair preserves identities and counters across reopen and repeated writes', () => {
  withDb((db, dbPath) => {
    upsertDailyBatch(db, [
      { device: 'test', source: 'WorkBuddy', usageDate: '2026-09-05', model: 'glm-5-3-flash', inputTokens: 100 },
      { device: 'test', source: 'WorkBuddy', usageDate: '2026-09-05', model: 'glm-5.3-flash', inputTokens: 200 }
    ]);
    assert.equal(db.prepare("SELECT total_tokens FROM daily_usage WHERE device='test'").get().total_tokens, 300);
    db.exec("UPDATE daily_usage SET model='glm-5-3-flash' WHERE device='test'");
    db.exec(`INSERT INTO daily_usage (device,source,usage_date,model,input_tokens,total_tokens)
      VALUES ('test','WorkBuddy','2026-09-05','glm-5.3-flash',50,50)`);
    upsertSession(db, { device: 'test', source: 'WorkBuddy', sessionId: 'original-session', model: 'glm-5-3-flash', inputTokens: 350 });
    upsertSessionAnnotation(db, { device: 'test', source: 'WorkBuddy', sessionId: 'original-session', note: 'keep annotation' });
    upsertTokenEvent(db, { device: 'test', source: 'WorkBuddy', sessionId: 'original-session', eventId: 'original-event', timestamp: '2026-09-05T12:00:00Z', model: 'glm-5-3-flash', inputTokens: 350 });
    db.exec("UPDATE session_usage SET model='glm-5-3-flash' WHERE device='test'; UPDATE token_events SET model='glm-5-3-flash' WHERE device='test'");
    for (let i = 0; i < 2; i++) {
      const reopened = openDb(dbPath);
      try {
        for (const table of ['daily_usage', 'session_usage', 'token_events']) {
          const rows = reopened.prepare(`SELECT model,input_tokens FROM ${table} WHERE device='test'`).all();
          assert.deepEqual(rows.map(row => ({ ...row })), [{ model: 'glm-5.3-flash', input_tokens: 350 }]);
        }
        assert.equal(reopened.prepare("SELECT event_id FROM token_events WHERE device='test'").get().event_id, 'original-event');
        assert.equal(reopened.prepare("SELECT note FROM session_annotations WHERE device='test'").get().note, 'keep annotation');
      } finally { reopened.close(); }
    }
    for (let i = 0; i < 2; i++) upsertDailyBatch(db, [
      { device: 'test', source: 'WorkBuddy', usageDate: '2026-09-05', model: 'glm-5-3-flash', inputTokens: 300 },
      { device: 'test', source: 'WorkBuddy', usageDate: '2026-09-05', model: 'glm-5.3-flash', inputTokens: 50 }
    ]);
    assert.equal(db.prepare("SELECT total_tokens FROM daily_usage WHERE device='test'").get().total_tokens, 350);
  });
});

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'token-work-db-'));
  const dbPath = join(dir, 'usage.sqlite');
  const db = openDb(dbPath);
  try {
    seedSessions(db);
    fn(db, dbPath);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedSessions(db) {
  for (const row of [
    {
      device: 'devbox',
      source: 'Codex CLI',
      sessionId: 'codex:one',
      lastActivity: '2026-06-10T01:00:00.000Z',
      projectPath: 'D:\\HighROIProjects\\TokenWork',
      totalTokens: 500,
      costUSD: 0.05
    },
    {
      device: 'devbox',
      source: 'Claude Code',
      sessionId: 'claude:two',
      lastActivity: '2026-06-10T02:00:00.000Z',
      projectPath: 'D:\\HighROIProjects\\Other',
      totalTokens: 100,
      costUSD: 0.01
    }
  ]) {
    upsertSession(db, row);
  }
}

test('v2 schema migration is repeatable', () => withDb((_db, dbPath) => {
  const reopened = openDb(dbPath);
  try {
    const tables = reopened.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('project_alias_rules', 'session_outputs')
      ORDER BY name
    `).all().map(row => row.name);
    assert.deepEqual(tables, ['project_alias_rules', 'session_outputs']);
    const annotationColumns = reopened.prepare('PRAGMA table_info(session_annotations)').all().map(row => row.name);
    const sessionColumns = reopened.prepare('PRAGMA table_info(session_usage)').all().map(row => row.name);
    const outputColumns = reopened.prepare('PRAGMA table_info(session_outputs)').all().map(row => row.name);
    assert.equal(annotationColumns.includes('work_purpose'), true);
    assert.equal(annotationColumns.includes('work_stage'), true);
    assert.equal(annotationColumns.includes('value_level'), true);
    assert.equal(sessionColumns.includes('model'), true);
    assert.equal(outputColumns.includes('output_type'), true);
  } finally {
    reopened.close();
  }
}));

test('existing session_usage tables gain the model column without losing rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-work-db-migration-'));
  const dbPath = join(dir, 'usage.sqlite');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE session_usage (
      device TEXT NOT NULL,
      source TEXT NOT NULL,
      session_id TEXT NOT NULL,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (device, source, session_id)
    );
    INSERT INTO session_usage(device, source, session_id, total_tokens)
    VALUES ('legacy', 'Codex CLI', 'legacy-session', 42);
  `);
  legacy.close();

  const migrated = openDb(dbPath);
  try {
    const columns = migrated.prepare('PRAGMA table_info(session_usage)').all().map(row => row.name);
    assert.equal(columns.includes('model'), true);
    const row = migrated.prepare('SELECT session_id AS sessionId, model, total_tokens AS totalTokens FROM session_usage').get();
    assert.equal(row.sessionId, 'legacy-session');
    assert.equal(row.model, '');
    assert.equal(row.totalTokens, 42);
  } finally {
    migrated.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('project alias rules match by prefix and can be disabled', () => withDb((db) => {
  const rule = upsertProjectAliasRule(db, {
    pattern: 'D:\\HighROIProjects\\TokenWork',
    matchType: 'prefix',
    projectAlias: 'Token Work',
    enabled: true
  });

  assert.equal(matchProjectAliasRule('D:\\HighROIProjects\\TokenWork\\src', [rule]), 'Token Work');

  const disabled = upsertProjectAliasRule(db, { ...rule, enabled: false });
  assert.equal(matchProjectAliasRule('D:\\HighROIProjects\\TokenWork\\src', [disabled]), null);
  assert.equal(listProjectAliasRules(db)[0].enabled, false);

  assert.equal(deleteProjectAliasRule(db, { id: rule.id }), 1);
}));

test('session outputs upsert and delete by session identity', () => withDb((db) => {
  const saved = upsertSessionOutput(db, {
    device: 'devbox',
    source: 'Codex CLI',
    sessionId: 'codex:one',
    outputUrl: 'https://github.com/example/repo/pull/42',
    outputLabel: 'PR #42',
    outputType: 'PR'
  });

  assert.equal(saved.outputUrl, 'https://github.com/example/repo/pull/42');
  assert.equal(saved.outputLabel, 'PR #42');
  assert.equal(saved.outputType, 'PR');
  assert.throws(() => upsertSessionOutput(db, {
    device: 'devbox',
    source: 'Codex CLI',
    sessionId: 'codex:one',
    outputUrl: 'file:///secret.txt'
  }), /http or https/);

  assert.equal(deleteSessionOutput(db, {
    device: 'devbox',
    source: 'Codex CLI',
    sessionId: 'codex:one'
  }), 1);
}));

test('batch annotation only changes selected sessions', () => withDb((db) => {
  const result = batchUpsertSessionAnnotations(db, {
    sessions: [{ device: 'devbox', source: 'Codex CLI', sessionId: 'codex:one' }],
    values: { taskType: '功能开发', outputStatus: '已完成', workPurpose: '调试修复', workStage: '验证', valueLevel: '中', note: '批量标注' }
  });
  assert.equal(result.updated, 1);

  const rows = db.prepare(`
    SELECT source, task_type AS taskType, output_status AS outputStatus,
      work_purpose AS workPurpose, work_stage AS workStage, value_level AS valueLevel, note
    FROM session_annotations
    ORDER BY source
  `).all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'Codex CLI');
  assert.equal(rows[0].taskType, '功能开发');
  assert.equal(rows[0].outputStatus, '已完成');
  assert.equal(rows[0].workPurpose, '调试修复');
  assert.equal(rows[0].workStage, '验证');
  assert.equal(rows[0].valueLevel, '中');
  assert.equal(rows[0].note, '批量标注');
}));

test('annotation export and import round-trip v3 data', () => withDb((db) => {
  upsertSessionAnnotation(db, {
    device: 'devbox',
    source: 'Codex CLI',
    sessionId: 'codex:one',
    projectAlias: 'Token Work',
    taskType: '功能开发',
    outputStatus: '已发布',
    workPurpose: '功能开发',
    workStage: '发布',
    valueLevel: '关键'
  });
  upsertSessionOutput(db, {
    device: 'devbox',
    source: 'Codex CLI',
    sessionId: 'codex:one',
    outputUrl: 'https://example.com/token-work',
    outputLabel: 'Demo',
    outputType: '部署'
  });
  upsertProjectAliasRule(db, {
    pattern: 'D:\\HighROIProjects\\TokenWork',
    matchType: 'prefix',
    projectAlias: 'Token Work',
    enabled: true
  });

  const exported = exportAnnotationData(db);
  assert.equal(exported.version, 3);
  assert.equal(exported.sessionAnnotations.length, 1);
  assert.equal(exported.sessionAnnotations[0].workPurpose, '功能开发');
  assert.equal(exported.sessionAnnotations[0].workStage, '发布');
  assert.equal(exported.sessionAnnotations[0].valueLevel, '关键');
  assert.equal(exported.sessionOutputs.length, 1);
  assert.equal(exported.sessionOutputs[0].outputType, '部署');
  assert.equal(exported.projectAliasRules.length, 1);

  db.prepare('DELETE FROM session_annotations').run();
  db.prepare('DELETE FROM session_outputs').run();
  db.prepare('DELETE FROM project_alias_rules').run();

  const imported = importAnnotationData(db, exported);
  assert.deepEqual(imported, {
    sessionAnnotations: 1,
    sessionOutputs: 1,
    projectAliasRules: 1,
    skipped: { sessionAnnotations: 0, sessionOutputs: 0 }
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM session_outputs').get().total, 1);
  const importedAnnotation = db.prepare('SELECT work_purpose AS workPurpose, work_stage AS workStage, value_level AS valueLevel FROM session_annotations').get();
  const importedOutput = db.prepare('SELECT output_type AS outputType FROM session_outputs').get();
  assert.equal(importedAnnotation.workPurpose, '功能开发');
  assert.equal(importedAnnotation.workStage, '发布');
  assert.equal(importedAnnotation.valueLevel, '关键');
  assert.equal(importedOutput.outputType, '部署');
}));

test('annotation import skips rows whose session row is gone instead of failing the batch', () => withDb((db) => {
  const imported = importAnnotationData(db, {
    sessionAnnotations: [
      { device: 'devbox', source: 'Codex CLI', sessionId: 'codex:one', projectAlias: 'live', taskType: '功能开发' },
      { device: 'devbox', source: 'Codex CLI', sessionId: 'deleted-session', projectAlias: 'stale' }
    ],
    sessionOutputs: [
      { device: 'devbox', source: 'Claude Code', sessionId: 'claude:two', outputUrl: 'https://example.com/live' },
      { device: 'devbox', source: 'Claude Code', sessionId: 'deleted-session', outputUrl: 'https://example.com/stale' }
    ]
  });
  assert.deepEqual(imported, {
    sessionAnnotations: 1,
    sessionOutputs: 1,
    projectAliasRules: 0,
    skipped: { sessionAnnotations: 1, sessionOutputs: 1 }
  });
  assert.equal(db.prepare(`SELECT project_alias FROM session_annotations WHERE session_id='codex:one'`).get().project_alias, 'live');
  assert.equal(db.prepare(`SELECT output_url FROM session_outputs WHERE session_id='claude:two'`).get().output_url, 'https://example.com/live');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM session_annotations WHERE session_id='deleted-session'`).get().n, 0);
}));

test('ark-auto legacy session dedup moves annotations/outputs/links to the canonical twin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-work-db-ark-'));
  const dbPath = join(dir, 'usage.sqlite');
  const configDir = join(dir, 'claude-config');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_MODEL: 'ark-code-latest' } }));
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  resetClaudeRequestModelCache();
  try {
    let db = openDb(dbPath);
    db.prepare(`INSERT INTO session_usage (device, source, session_id, model, updated_at) VALUES
      ('dev1', 'Claude Code', 'sess-base:auto', 'auto', datetime('now')),
      ('dev1', 'Claude Code', 'sess-base:ark-code-latest', 'ark-code-latest', datetime('now'))`).run();
    // 孪生行已有自己的标注：去重时保留孪生侧，不产生主键冲突
    db.prepare(`INSERT INTO session_annotations (device, source, session_id, project_alias, note) VALUES
      ('dev1', 'Claude Code', 'sess-base:auto', 'legacy-alias', 'legacy note'),
      ('dev1', 'Claude Code', 'sess-base:ark-code-latest', 'twin-alias', 'twin note')`).run();
    db.prepare(`INSERT INTO session_outputs (device, source, session_id, output_url)
      VALUES ('dev1', 'Claude Code', 'sess-base:auto', 'https://example.com/pr/9')`).run();
    db.prepare(`INSERT INTO work_items (title) VALUES ('ark dedup')`).run();
    db.prepare(`INSERT INTO work_item_sessions (work_item_id, device, source, session_id)
      SELECT id, 'dev1', 'Claude Code', 'sess-base:auto' FROM work_items LIMIT 1`).run();
    db.close();

    // 重新打开触发 legacy 去重；再开两次确认副作用归零
    for (let round = 0; round < 3; round++) {
      db = openDb(dbPath);
      try {
        assert.deepEqual(db.prepare(`SELECT session_id FROM session_usage WHERE device='dev1'`).all().map(row => row.session_id),
          ['sess-base:ark-code-latest']);
        assert.deepEqual(db.prepare(`SELECT session_id, project_alias, note FROM session_annotations WHERE device='dev1'`).all().map(row => ({ ...row })),
          [{ session_id: 'sess-base:ark-code-latest', project_alias: 'twin-alias', note: 'twin note' }]);
        assert.deepEqual(db.prepare(`SELECT session_id FROM session_outputs WHERE device='dev1'`).all().map(row => row.session_id),
          ['sess-base:ark-code-latest']);
        assert.deepEqual(db.prepare(`SELECT session_id FROM work_item_sessions WHERE device='dev1'`).all().map(row => row.session_id),
          ['sess-base:ark-code-latest']);
      } finally { db.close(); }
    }
  } finally {
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    resetClaudeRequestModelCache();
    rmSync(dir, { recursive: true, force: true });
  }
});
