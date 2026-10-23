import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectFromRoots, collect, roots as configuredRoots } from '../src/collectors/zcode.ts';

const ROLLOUT_DIR = join(import.meta.dirname, 'fixtures', 'collectors', 'zcode', 'rollout');

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'token-work-zcode-'));
  const rollout = join(root, 'rollout');
  mkdirSync(rollout, { recursive: true });
  return { root, rollout };
}

// fixture 不含任何会话正文，仅元数据与 usage 字段
function modelIoLine(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    completedAt: '2026-09-17T01:00:00.000Z',
    durationMs: 8439,
    requestId: 'req-1',
    attempt: 1,
    model: { modelId: 'GLM-5.3', providerId: 'account:bigmodel-individual-coding-plan' },
    response: {
      finishReason: 'tool-calls',
      usage: { inputTokens: 139227, outputTokens: 372, totalTokens: 139599, cacheReadTokens: 128704, cacheWriteTokens: 0 }
    },
    sessionId: 'sess_fixture',
    querySource: 'main_turn',
    type: 'model_io',
    ...overrides
  });
}

test('first collect splits cached input out of inputTokens', async () => {
  const { root, rollout } = fixtureRoot();
  writeFileSync(join(rollout, 'model-io-sess_fixture.jsonl'), modelIoLine());
  try {
    const result = await collectFromRoots([rollout], null, { sessionDirectories: new Map([['sess_fixture', '/Users/dev/project-a']]) });
    assert.equal(result.audit.candidateFiles, 1);
    assert.equal(result.audit.usableTokenRecords, 1);
    assert.equal(result.tokenEvents.length, 1);
    const event = result.tokenEvents[0];
    assert.equal(event.source, 'zcode');
    assert.equal(event.sessionId, 'sess_fixture');
    assert.equal(event.model, 'glm-5.3');
    assert.equal(event.timestamp, '2026-09-17T01:00:00.000Z');
    // 智谱语义 cache ⊆ input：入库 input 必须扣除缓存，总量不变
    assert.equal(event.inputTokens, 10523);
    assert.equal(event.outputTokens, 372);
    assert.equal(event.cacheReadTokens, 128704);
    assert.equal(event.cacheCreationTokens, 0);
    assert.equal(event.inputTokens + event.outputTokens + event.cacheReadTokens + event.cacheCreationTokens, 139599);
    assert.equal(event.privacyLevel, 'safe');
    assert.equal(result.modelsJson.entries[0].workspaceLabel, 'project-a');
    // 会话行按真实会话 id 归并，否则会与 token_events 对不上并重复计入总量
    assert.equal(result.modelsJson.entries[0].sessionId, 'sess_fixture');
    assert.equal(result.modelsJson.entries[0].lastActivity, '2026-09-17T01:00:00.000Z');
    assert.equal(result.reconciliation.managedEventIdPrefix, 'zcode:');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sessions without rollout files keep their workspace from the CLI session table', async () => {
  const { root, rollout } = fixtureRoot();
  writeFileSync(join(rollout, 'model-io-sess_fixture.jsonl'), modelIoLine());
  try {
    const result = await collectFromRoots([rollout], null, {
      sessionDirectories: new Map([
        ['sess_fixture', '/Users/dev/project-a'],
        ['sess_cleaned', '/Users/dev/project-b']
      ])
    });
    const cleaned = result.modelsJson.entries.find(entry => entry.sessionId === 'sess_cleaned');
    assert.equal(cleaned.workspaceLabel, 'project-b');
    assert.equal(cleaned.input, 0);
    assert.equal(result.tokenEvents.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('full scans never declare event deletion because rollouts rotate', async () => {
  const { root, rollout } = fixtureRoot();
  writeFileSync(join(rollout, 'model-io-sess_fixture.jsonl'), modelIoLine());
  try {
    // 真实 rollout 文件会被滚动截断(当前文件只剩最近数小时),本次未解析到不代表请求被删除
    const full = await collectFromRoots([rollout]);
    // 只声明前缀：出现任何按缺失删除的字段都意味着滚动截断会丢历史
    assert.deepEqual(Object.keys(full.reconciliation), ['managedEventIdPrefix']);
    assert.equal(full.reconciliation.managedEventIdPrefix, 'zcode:');
    const incremental = await collectFromRoots([rollout], null, { changedAfterMs: Date.now() - 120_000 });
    assert.deepEqual(Object.keys(incremental.reconciliation), ['managedEventIdPrefix']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stable event ids keep repeated full collects idempotent', async () => {
  const { root, rollout } = fixtureRoot();
  writeFileSync(join(rollout, 'model-io-sess_fixture.jsonl'), modelIoLine());
  try {
    const first = await collectFromRoots([rollout]);
    const second = await collectFromRoots([rollout]);
    assert.deepEqual(second.tokenEvents, first.tokenEvents);
    assert.deepEqual(second.modelsJson, first.modelsJson);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unknown sessions fall back to the source label as workspace', async () => {
  const { root, rollout } = fixtureRoot();
  writeFileSync(join(rollout, 'model-io-sess_fixture.jsonl'), modelIoLine());
  try {
    const result = await collectFromRoots([rollout], null, { sessionDirectories: new Map() });
    assert.equal(result.modelsJson.entries[0].workspaceLabel, 'ZCode');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('malformed and non-model_io lines are skipped without failing the collect', async () => {
  const { root, rollout } = fixtureRoot();
  writeFileSync(join(rollout, 'model-io-sess_fixture.jsonl'), [
    modelIoLine({ requestId: 'req-ok' }),
    '{not json',
    JSON.stringify({ type: 'other', sessionId: 'sess_fixture' })
  ].join('\n'));
  try {
    const result = await collectFromRoots([rollout]);
    assert.equal(result.tokenEvents.length, 1);
    assert.equal(result.audit.parseErrors, 1);
    assert.equal(result.audit.skippedNoTokenRecords, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ZCode collector honors incremental changedAfterMs via file mtime', async () => {
  const { root, rollout } = fixtureRoot();
  const filePath = join(rollout, 'model-io-sess_fixture.jsonl');
  writeFileSync(filePath, modelIoLine());
  try {
    const old = new Date(Date.now() - 60_000);
    utimesSync(filePath, old, old);
    const stale = await collectFromRoots([rollout], null, { changedAfterMs: Date.now() - 30_000 });
    assert.equal(stale.tokenEvents.length, 0);
    assert.equal(stale.audit.candidateFiles, 0);
    const fresh = await collectFromRoots([rollout], null, { changedAfterMs: Date.now() - 120_000 });
    assert.equal(fresh.tokenEvents.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the same request duplicated across rollout files dedups to one event', async () => {
  const { root, rollout } = fixtureRoot();
  const line = modelIoLine();
  writeFileSync(join(rollout, 'model-io-sess_fixture.jsonl'), line);
  // 会话续接后旧记录被整体复制进新文件，事件 id 稳定去重
  writeFileSync(join(rollout, 'model-io-sess_fixture_continued.jsonl'), line);
  try {
    const result = await collectFromRoots([rollout]);
    assert.equal(result.tokenEvents.length, 1);
    assert.equal(result.audit.usableTokenRecords, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('one session with two models collapses into a single session entry', async () => {
  const { root, rollout } = fixtureRoot();
  writeFileSync(join(rollout, 'model-io-sess_fixture.jsonl'), [
    modelIoLine({ requestId: 'req-1', model: { modelId: 'GLM-5.3' } }),
    modelIoLine({ requestId: 'req-2', completedAt: '2026-09-17T02:00:00.000Z', model: { modelId: 'GLM-4.6' } })
  ].join('\n'));
  try {
    const result = await collectFromRoots([rollout], null, { sessionDirectories: new Map([['sess_fixture', '/Users/dev/project-a']]) });
    assert.equal(result.tokenEvents.length, 2);
    // 会话行主键只认 session_id：同一会话的两个模型合计成一行，模型取最后活动
    assert.equal(result.modelsJson.entries.length, 1);
    const entry = result.modelsJson.entries[0];
    assert.equal(entry.sessionId, 'sess_fixture');
    assert.equal(entry.input, 2 * 10523);
    assert.equal(entry.output, 2 * 372);
    assert.equal(entry.cacheRead, 2 * 128704);
    assert.equal(entry.model, 'glm-4.6');
    assert.equal(entry.lastActivity, '2026-09-17T02:00:00.000Z');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sanitized fixture parses with usage-only records', async () => {
  const result = await collectFromRoots([ROLLOUT_DIR], null, { sessionDirectories: new Map() });
  assert.equal(result.audit.usableTokenRecords, 3);
  assert.equal(result.tokenEvents.length, 3);
  const main = result.tokenEvents[0];
  const cacheWriteEvent = result.tokenEvents[1];
  assert.equal(main.inputTokens, 10523);
  assert.equal(main.outputTokens, 372);
  // cacheWrite 同样从 input 中扣除
  assert.equal(cacheWriteEvent.inputTokens, 3500);
  assert.equal(cacheWriteEvent.cacheReadTokens, 1000);
  assert.equal(cacheWriteEvent.cacheCreationTokens, 500);
  // 子代理会话独立成 session
  assert.equal(result.tokenEvents[2].sessionId, 'sess_fixture_subagent_agent_a1');
});

test('default roots follow the configured rollout path', () => {
  assert.deepEqual(configuredRoots(), [join(process.env.HOME || '', '.zcode/cli/rollout')]);
  assert.equal(typeof collect, 'function');
});
