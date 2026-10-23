import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDb, upsertDaily, upsertSession } from '../src/db.ts';
import { removeTempDir } from '../test-support/fs.ts';
import { startTestServer, stopTestServer, waitForTestServer } from '../test-support/server.ts';

test('v2 APIs cover alias rules, batch annotations, outputs, backup, export and import', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-work-api-v2-'));
  const dbPath = join(dir, 'usage.sqlite');
  const backupDir = join(dir, 'backups');
  seedDb(dbPath);
  const server = startTestServer({ dbPath, env: { BACKUP_DIR: backupDir } });

  try {
    const port = await waitForTestServer(server);
    const rulePayload = {
      pattern: 'D:\\HighROIProjects\\TokenWork',
      matchType: 'prefix',
      projectAlias: 'Token Work',
      enabled: true
    };
    const ruleSaved = await postJson(port, '/api/project-alias-rules', rulePayload);
    assert.equal(ruleSaved.rule.projectAlias, 'Token Work');

    const rules = await getJson(port, '/api/project-alias-rules');
    assert.equal(rules.rules.length, 1);
    assert.equal(rules.matchTypes.includes('prefix'), true);

    const withRule = await getJson(port, '/api/data');
    const codex = withRule.sessions.find(session => session.sessionId === 'codex:one');
    assert.equal(codex.projectAlias, 'Token Work');
    assert.equal(codex.manualProjectAlias, null);
    assert.equal(codex.ruleProjectAlias, 'Token Work');

    await postJson(port, '/api/session-annotations', {
      device: 'devbox',
      source: 'Codex CLI',
      sessionId: 'codex:one',
      projectAlias: 'Manual Studio',
      taskType: '功能开发',
      outputStatus: '已完成',
      workPurpose: '方案设计',
      workStage: '实现',
      valueLevel: '高'
    });
    const manual = await getJson(port, '/api/data');
    const manualSession = manual.sessions.find(session => session.sessionId === 'codex:one');
    assert.equal(manualSession.projectAlias, 'Manual Studio');
    assert.equal(manualSession.workPurpose, '方案设计');
    assert.equal(manualSession.workStage, '实现');
    assert.equal(manualSession.valueLevel, '高');
    assert.equal(manual.meta.workPurposes.includes('测试验证'), true);
    assert.equal(manual.meta.workStages.includes('探索'), true);
    assert.equal(manual.meta.valueLevels.includes('关键'), true);
    assert.equal(manual.meta.outputTypes.includes('PR'), true);

    await postJson(port, '/api/session-outputs', {
      device: 'devbox',
      source: 'Codex CLI',
      sessionId: 'codex:one',
      outputUrl: 'https://github.com/example/repo/pull/42',
      outputLabel: 'PR #42',
      outputType: 'PR'
    });
    const withOutput = await getJson(port, '/api/data');
    const outputSession = withOutput.sessions.find(session => session.sessionId === 'codex:one');
    assert.equal(outputSession.outputLabel, 'PR #42');
    assert.equal(outputSession.outputType, 'PR');

    await assertRejectsWithStatus(
      fetch(`http://127.0.0.1:${port}/api/session-annotations/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: '{}'
      }),
      415
    );

    await assertRejectsWithStatus(
      fetch(`http://127.0.0.1:${port}/api/session-outputs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://evil.example'
        },
        body: JSON.stringify({
          device: 'devbox',
          source: 'Codex CLI',
          sessionId: 'codex:one',
          outputUrl: 'https://example.com'
        })
      }),
      403
    );

    const batch = await postJson(port, '/api/session-annotations/batch', {
      sessions: [{ device: 'devbox', source: 'Claude Code', sessionId: 'claude:two' }],
      values: { taskType: '问题修复', outputStatus: '已废弃', workPurpose: '测试验证', workStage: '验证', valueLevel: '低', note: '批量处理' }
    });
    assert.equal(batch.updated, 1);

    const afterBatch = await getJson(port, '/api/data');
    const claude = afterBatch.sessions.find(session => session.sessionId === 'claude:two');
    assert.equal(claude.taskType, '问题修复');
    assert.equal(claude.outputStatus, '已废弃');
    assert.equal(claude.workPurpose, '测试验证');
    assert.equal(claude.workStage, '验证');
    assert.equal(claude.valueLevel, '低');

    const backup = await postJson(port, '/api/backup', {});
    assert.equal(backup.ok, true);
    assert.equal(existsSync(backup.backup.path), true);

    const exported = await getJson(port, '/api/export/annotations');
    assert.equal(exported.version, 3);
    assert.equal(exported.sessionAnnotations.length, 2);
    assert.equal(exported.sessionOutputs.length, 1);
    assert.equal(exported.projectAliasRules.length, 1);
    assert.equal(exported.sessionAnnotations.find(row => row.sessionId === 'codex:one').valueLevel, '高');
    assert.equal(exported.sessionOutputs[0].outputType, 'PR');

    const imported = await postJson(port, '/api/import/annotations', exported);
    assert.deepEqual(imported.imported, {
      sessionAnnotations: 2,
      sessionOutputs: 1,
      projectAliasRules: 1,
      skipped: { sessionAnnotations: 0, sessionOutputs: 0, projectAliasRules: 0 }
    });
    assert.equal(existsSync(imported.backup.path), true);
    assert.equal(existsSync(backup.backup.path), false);
    assert.equal(readdirSync(backupDir).length, 1);

    const emptyImport = await postJson(port, '/api/import/annotations', {});
    assert.equal(emptyImport.backup, null);
    assert.deepEqual(emptyImport.imported, {
      sessionAnnotations: 0,
      sessionOutputs: 0,
      projectAliasRules: 0,
      skipped: { sessionAnnotations: 0, sessionOutputs: 0, projectAliasRules: 0 }
    });

    const deletedOutput = await deleteJson(port, '/api/session-outputs', {
      device: 'devbox',
      source: 'Codex CLI',
      sessionId: 'codex:one'
    });
    assert.equal(deletedOutput.deleted, 1);

    const deletedRule = await deleteJson(port, '/api/project-alias-rules', { id: ruleSaved.rule.id });
    assert.equal(deletedRule.deleted, 1);
  } finally {
    await stopTestServer(server.child);
    await removeTempDir(dir);
  }
});

function seedDb(dbPath) {
  const db = openDb(dbPath);
  try {
    for (const row of [
      {
        device: 'devbox',
        source: 'Codex CLI',
        usageDate: '2026-06-10',
        model: 'codex-mini',
        inputTokens: 200,
        outputTokens: 100,
        totalTokens: 300,
        costUSD: 0.03
      },
      {
        device: 'devbox',
        source: 'Claude Code',
        usageDate: '2026-06-10',
        model: 'claude-sonnet',
        inputTokens: 400,
        outputTokens: 100,
        totalTokens: 500,
        costUSD: 0.05
      }
    ]) {
      upsertDaily(db, row);
    }
    for (const row of [
      {
        device: 'devbox',
        source: 'Codex CLI',
        sessionId: 'codex:one',
        lastActivity: '2026-06-10T01:00:00.000Z',
        projectPath: 'D:\\HighROIProjects\\TokenWork',
        inputTokens: 200,
        outputTokens: 100,
        totalTokens: 300,
        costUSD: 0.03
      },
      {
        device: 'devbox',
        source: 'Claude Code',
        sessionId: 'claude:two',
        lastActivity: '2026-06-10T02:00:00.000Z',
        projectPath: 'D:\\HighROIProjects\\Other',
        inputTokens: 400,
        outputTokens: 100,
        totalTokens: 500,
        costUSD: 0.05
      }
    ]) {
      upsertSession(db, row);
    }
  } finally {
    db.close();
  }
}

async function getJson(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  if (!response.ok) assert.fail(await response.text());
  return response.json();
}

async function postJson(port, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) assert.fail(await response.text());
  return response.json();
}

async function deleteJson(port, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) assert.fail(await response.text());
  return response.json();
}

async function assertRejectsWithStatus(responsePromise, expectedStatus) {
  const response = await responsePromise;
  assert.equal(response.status, expectedStatus, await response.text());
}
