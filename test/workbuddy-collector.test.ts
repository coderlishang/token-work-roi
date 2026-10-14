import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { collect, collectWithAudit, audit, CLIENT_KEY, SOURCE_LABEL } from '../src/collectors/workbuddy.ts';
import { resetConfigCache } from '../src/collector-config.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(tracesDir, sessionsDir) {
  const dir = mkdtempSync(join(tmpdir(), 'token-work-wb-config-'));
  const configPath = join(dir, 'collectors.json');
  writeFileSync(configPath, JSON.stringify({
    collectors: {
      workbuddy: {
        tracesDir,
        sessionsDir,
        root: dir
      }
    }
  }), 'utf8');
  return { dir, configPath };
}

function makeTraceFile(tracesDir, pid, traceId, spans, modelInfo = { models: ['glm-5.2'] }) {
  const pidDir = join(tracesDir, String(pid));
  if (!existsSync(pidDir)) mkdirSync(pidDir, { recursive: true });
  const trace = {
    trace: {
      traceId,
      name: 'Agent workflow',
      workerPid: pid,
      startedAt: '2026-06-17T02:06:00Z',
      endedAt: '2026-06-17T02:06:05Z',
      duration: 5000,
      status: 'ok',
      spanCount: spans.length,
      totalTokens: 0,
      ...(modelInfo ? { modelInfo } : {})
    },
    spans
  };
  const filePath = join(pidDir, `${traceId}.json`);
  writeFileSync(filePath, JSON.stringify(trace), 'utf8');
  return filePath;
}

function makeGenerationSpan(spanId, parentId, model, usage) {
  return {
    traceId: 'trace_test',
    spanId,
    parentId,
    name: 'generation',
    type: 'generation',
    startedAt: '2026-06-17T02:06:01Z',
    endedAt: '2026-06-17T02:06:04Z',
    duration: 3000,
    status: 'ok',
    error: null,
    toolOutput: JSON.stringify([{
      id: `resp_${spanId}`,
      created: 1750137961,
      model,
      object: 'chat.completion',
      choices: [],
      usage
    }])
  };
}

function makeSessionFile(sessionsDir, pid, sessionId, cwd) {
  if (!existsSync(sessionsDir)) mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(sessionsDir, `${pid}.json`), JSON.stringify({
    pid,
    sessionId,
    cwd,
    startedAt: 1750137960000,
    kind: 'interactive'
  }), 'utf8');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('WorkBuddy collector exports correct constants', () => {
  assert.equal(CLIENT_KEY, 'workbuddy');
  assert.equal(SOURCE_LABEL, 'WorkBuddy');
});

test('WorkBuddy reads in-progress responses for any actual model and deduplicates message snapshots', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'token-work-wb-project-'));
  const { dir, configPath } = makeConfig(join(baseDir, 'traces'), join(baseDir, 'sessions'));
  const projects = join(dir, 'projects', 'workspace', 'session', 'subagents');
  mkdirSync(projects, { recursive: true });
  const models = ['glm-5.3-flash', 'hy4-preview', 'deepseek-v4-pro', 'claude-opus-5', 'gemini-3.8-flash', 'gpt-6-astra', 'future-provider-model'];
  const rows = models.map((model, i) => ({
    id: `row-${i}`, type: i % 2 ? 'function_call' : 'message', role: 'assistant',
    timestamp: Date.parse('2026-09-05T15:24:00Z'), sessionId: 'auto-session',
    content: 'private response', arguments: 'private arguments',
    providerData: {
      messageId: `response-${i}`, model, requestModelId: 'auto',
      rawUsage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 60, prompt_cache_write_tokens: 10, completion_thinking_tokens: 5 }
    },
    message: { usage: { input_tokens: 100, output_tokens: 20 } }
  }));
  // SDK response_done and persisted providerData.usage use this schema.
  for (const i of [1, 3, 5]) {
    const sdkUsage = {
      requests: 1, inputTokens: 100, outputTokens: 20, totalTokens: 120,
      inputTokensDetails: i === 1 ? { cached_tokens: 60 } : [{ cached_tokens: 60 }],
      outputTokensDetails: i === 1 ? { reasoning_tokens: 5 } : [{ reasoning_tokens: 5 }],
      cacheCreationInputTokens: 10
    };
    const provider = rows[i].providerData as Record<string, unknown>;
    if (i === 5) {
      delete provider.rawUsage;
      provider.usage = sdkUsage;
      rows[i].type = 'reasoning';
    } else provider.rawUsage = sdkUsage;
  }
  writeFileSync(join(projects, 'agent.jsonl'), [
    { ...rows[0], timestamp: 1e20 },
    ...rows, ...rows,
    { ...rows[0], type: 'function_call_result', providerData: { ...rows[0].providerData, messageId: 'tool-result' } },
    { ...rows[0], providerData: { ...rows[0].providerData, model: 'auto', messageId: 'unresolved' } },
    { ...rows[0], providerData: { ...rows[0].providerData, messageId: 'invalid', rawUsage: { prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 20 } } }
  ].map(row => JSON.stringify(row)).join('\r\n') + '\r\n{"unfinished":');
  process.env.TOKEN_WORK_CONFIG = configPath;
  resetConfigCache();
  try {
    const result = await collect();
    assert.deepEqual(result.tokenEvents.map(event => event.model), models);
    for (const event of result.tokenEvents) {
      assert.deepEqual([event.inputTokens, event.outputTokens, event.cacheReadTokens, event.cacheCreationTokens, event.reasoningTokens], [30, 15, 60, 10, 5]);
    }
    assert.equal(result.audit.usableTokenRecords, models.length);
    assert.equal(result.modelsJson.entries.length, 1);
    const session = result.modelsJson.entries[0];
    assert.equal(session.input + session.output + session.cacheRead + session.cacheWrite + session.reasoning, models.length * 120);
    assert.equal(result.audit.skippedUnresolvedModel, 1);
    assert.equal(result.audit.parseErrors, 3);
    assert.doesNotMatch(JSON.stringify(result), /private response|private arguments/);
    assert.equal((await collect(null, { changedAfterMs: Date.now() + 60_000 })).tokenEvents.length, 0);
  } finally {
    delete process.env.TOKEN_WORK_CONFIG;
    resetConfigCache();
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WorkBuddy keeps the actual response model and complete usage when a partial auto trace arrives', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'token-work-wb-stream-'));
  const tracesDir = join(baseDir, 'traces');
  const { dir, configPath } = makeConfig(tracesDir, join(baseDir, 'sessions'));
  const projectDir = join(dir, 'projects');
  mkdirSync(projectDir);
  const record = {
    id: 'streamed-response', type: 'message', role: 'assistant',
    timestamp: '2026-09-05T15:24:00Z', sessionId: 'session',
    providerData: {
      messageId: 'streamed-response', model: 'glm-5.3-flash', requestModelId: 'auto',
      usage: { requests: 1, inputTokens: 100, outputTokens: 20, totalTokens: 120 }
    }
  };
  writeFileSync(join(projectDir, 'session.jsonl'), [record, {
    ...record, providerData: { ...record.providerData, usage: { ...record.providerData.usage, outputTokens: 5, totalTokens: 105 } }
  }].map(row => JSON.stringify(row)).join('\n'));
  const span = makeGenerationSpan('span-partial', null, 'auto', { prompt_tokens: 100, completion_tokens: 5 });
  const response = JSON.parse(span.toolOutput);
  response[0].id = record.id;
  span.toolOutput = JSON.stringify(response);
  makeTraceFile(tracesDir, 12345, 'trace_partial', [span], { models: ['hy3'] });
  process.env.TOKEN_WORK_CONFIG = configPath;
  resetConfigCache();
  try {
    const result = await collect();
    assert.equal(result.tokenEvents.length, 1);
    assert.equal(result.tokenEvents[0].model, 'glm-5.3-flash');
    assert.equal(result.tokenEvents[0].inputTokens + result.tokenEvents[0].outputTokens, 120);
    assert.equal(result.tokenEvents[0].sessionId, 'workbuddy:trace_partial');
    assert.equal(result.tokenEvents[0].legacyEventIds.length, 1);
  } finally {
    delete process.env.TOKEN_WORK_CONFIG;
    resetConfigCache();
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WorkBuddy collector returns empty result when traces dir does not exist', async () => {
  const { dir, configPath } = makeConfig('/nonexistent/traces', '/nonexistent/sessions');
  process.env.TOKEN_WORK_CONFIG = configPath;
  resetConfigCache();
  try {
    const result = await collect();
    assert.deepEqual(result.graphJson.contributions, []);
    assert.deepEqual(result.modelsJson.entries, []);
    assert.deepEqual(result.tokenEvents, []);
  } finally {
    delete process.env.TOKEN_WORK_CONFIG;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WorkBuddy collector parses trace files and extracts token events', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'token-work-wb-'));
  const tracesDir = join(baseDir, 'traces');
  const sessionsDir = join(baseDir, 'sessions');
  const { dir, configPath } = makeConfig(tracesDir, sessionsDir);

  makeSessionFile(sessionsDir, 12345, 'wb-test-session-001', '/tmp/test-project');
  makeTraceFile(tracesDir, 12345, 'trace_test_001', [
    makeGenerationSpan('span_001', null, 'auto', {
      prompt_tokens: 1500,
      completion_tokens: 420,
      total_tokens: 1920,
      prompt_tokens_details: { cached_tokens: 800, reasoning_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 60, cached_tokens: 0 }
    })
  ]);

  process.env.TOKEN_WORK_CONFIG = configPath;
  resetConfigCache();
  try {
    const result = await collect();

    // Should have one token event
    assert.equal(result.tokenEvents.length, 1);
    const event = result.tokenEvents[0];
    assert.equal(event.source, 'workbuddy');
    assert.equal(event.sessionId, 'workbuddy:trace_test_001');
    assert.equal(event.model, 'glm-5.2');

    // prompt_tokens is cache-inclusive; reasoning_tokens is part of completion_tokens.
    assert.equal(event.inputTokens, 700);
    assert.equal(event.outputTokens, 360);
    assert.equal(event.cacheReadTokens, 800);
    assert.equal(event.cacheCreationTokens, 0);
    assert.equal(event.reasoningTokens, 60);
    assert.equal(
      event.inputTokens + event.outputTokens + event.cacheReadTokens
        + event.cacheCreationTokens + event.reasoningTokens,
      1920
    );

    // Event ID should be prefixed with workbuddy:
    assert.ok(event.eventId.startsWith('workbuddy:'));

    // Should have repo path hash
    assert.ok(event.repoPathHash);
    assert.equal(event.privacyLevel, 'hashed');

    // Should have daily contributions
    assert.equal(result.graphJson.contributions.length, 1);
    const contribution = result.graphJson.contributions[0];
    assert.equal(contribution.date, '2026-06-17');
    assert.equal(contribution.clients.length, 1);
    assert.equal(contribution.clients[0].client, 'workbuddy');
    assert.equal(contribution.clients[0].modelId, 'glm-5.2');
    assert.equal(contribution.clients[0].tokens.input, 700);

    // Should have session entries
    assert.equal(result.modelsJson.entries.length, 1);
    const entry = result.modelsJson.entries[0];
    assert.equal(entry.client, 'workbuddy');
    assert.equal(entry.sessionId, 'workbuddy:trace_test_001');
    assert.equal(entry.workspaceLabel, 'test-project');
  } finally {
    delete process.env.TOKEN_WORK_CONFIG;
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WorkBuddy resolves auto mode from a unique trace model', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'token-work-wb-model-'));
  const tracesDir = join(baseDir, 'traces');
  const sessionsDir = join(baseDir, 'sessions');
  const { dir, configPath } = makeConfig(tracesDir, sessionsDir);

  makeTraceFile(tracesDir, 12346, 'trace_model_001', [
    makeGenerationSpan('span_model_001', null, 'auto', {
      prompt_tokens: 100,
      completion_tokens: 20
    })
  ], { models: ['glm-5.2'] });

  process.env.TOKEN_WORK_CONFIG = configPath;
  resetConfigCache();
  try {
    const result = await collect();
    assert.equal(result.tokenEvents[0].model, 'glm-5.2');
  } finally {
    delete process.env.TOKEN_WORK_CONFIG;
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WorkBuddy groups Hy3-X traces under Hy3', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'token-work-wb-hy3-'));
  const tracesDir = join(baseDir, 'traces');
  const sessionsDir = join(baseDir, 'sessions');
  const { dir, configPath } = makeConfig(tracesDir, sessionsDir);
  makeTraceFile(tracesDir, 12356, 'trace_hy3_001', [
    makeGenerationSpan('span_hy3_001', null, 'hy3-x', { prompt_tokens: 100, completion_tokens: 20 })
  ], null);

  process.env.TOKEN_WORK_CONFIG = configPath;
  resetConfigCache();
  try {
    assert.equal((await collect()).tokenEvents[0].model, 'hy3');
  } finally {
    delete process.env.TOKEN_WORK_CONFIG;
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WorkBuddy resolves auto mode from its local session metadata', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'token-work-wb-db-model-'));
  const tracesDir = join(baseDir, 'traces');
  const sessionsDir = join(baseDir, 'sessions');
  const { dir, configPath } = makeConfig(tracesDir, sessionsDir);
  const pid = 12350;
  const metadataSessionId = 'workbuddy-session-with-model';
  const db = new DatabaseSync(join(dir, 'workbuddy.db'));
  try {
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        cwd TEXT,
        model TEXT
      )
    `);
    db.prepare('INSERT INTO sessions (id, cwd, model) VALUES (?, ?, ?)')
      .run(metadataSessionId, '/tmp/workbuddy-db-project', 'glm-5.2');
  } finally {
    db.close();
  }
  makeSessionFile(sessionsDir, pid, metadataSessionId, null);
  makeTraceFile(tracesDir, pid, 'trace_db_model_001', [
    makeGenerationSpan('span_db_model_001', null, 'auto', { prompt_tokens: 100, completion_tokens: 20 })
  ], null);

  process.env.TOKEN_WORK_CONFIG = configPath;
  resetConfigCache();
  try {
    const result = await collect();
    assert.equal(result.tokenEvents.length, 1);
    assert.equal(result.tokenEvents[0].model, 'glm-5.2');
  } finally {
    delete process.env.TOKEN_WORK_CONFIG;
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WorkBuddy resolves auto mode from the trace session after PID metadata is removed', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'token-work-wb-trace-session-model-'));
  const tracesDir = join(baseDir, 'traces');
  const sessionsDir = join(baseDir, 'sessions');
  const { dir, configPath } = makeConfig(tracesDir, sessionsDir);
  const db = new DatabaseSync(join(dir, 'workbuddy.db'));
  try {
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        cwd TEXT,
        model TEXT,
        created_at TEXT,
        updated_at TEXT,
        last_activity_at TEXT,
        deleted_at TEXT
      )
    `);
    db.prepare('INSERT INTO sessions (id, model) VALUES (?, ?)').run('completed-session', 'glm-5.3');
  } finally {
    db.close();
  }
  const filePath = makeTraceFile(tracesDir, 12351, 'trace_completed_session', [
    makeGenerationSpan('span_completed_session', null, 'auto', { prompt_tokens: 100, completion_tokens: 20 })
  ], null);
  const trace = JSON.parse(readFileSync(filePath, 'utf8'));
  trace.trace.sessionId = 'completed-session';
  writeFileSync(filePath, JSON.stringify(trace), 'utf8');

  process.env.TOKEN_WORK_CONFIG = configPath;
  resetConfigCache();
  try {
    const result = await collect();
    assert.equal(result.tokenEvents.length, 1);
    assert.equal(result.tokenEvents[0].model, 'glm-5.3');
  } finally {
    delete process.env.TOKEN_WORK_CONFIG;
    resetConfigCache();
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WorkBuddy does not use a reused PID model for a different trace session', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'token-work-wb-reused-pid-'));
  const tracesDir = join(baseDir, 'traces');
  const sessionsDir = join(baseDir, 'sessions');
  const { dir, configPath } = makeConfig(tracesDir, sessionsDir);
  makeSessionFile(sessionsDir, 12352, 'current-session', '/tmp/workbuddy-project');
  const session = JSON.parse(readFileSync(join(sessionsDir, '12352.json'), 'utf8'));
  session.model = 'deepseek-v4-flash';
  writeFileSync(join(sessionsDir, '12352.json'), JSON.stringify(session), 'utf8');
  const filePath = makeTraceFile(tracesDir, 12352, 'trace_old_session', [
    makeGenerationSpan('span_old_session', null, 'auto', { prompt_tokens: 100, completion_tokens: 20 })
  ], null);
  const trace = JSON.parse(readFileSync(filePath, 'utf8'));
  trace.trace.sessionId = 'completed-session-without-model';
  writeFileSync(filePath, JSON.stringify(trace), 'utf8');

  process.env.TOKEN_WORK_CONFIG = configPath;
  resetConfigCache();
  try {
    const result = await collect();
    assert.equal(result.tokenEvents.length, 0);
    assert.equal(result.audit.skippedUnresolvedModel, 1);
  } finally {
    delete process.env.TOKEN_WORK_CONFIG;
    resetConfigCache();
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WorkBuddy keeps trace event identities after PID session metadata is removed', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'token-work-wb-identity-'));
  const tracesDir = join(baseDir, 'traces');
  const sessionsDir = join(baseDir, 'sessions');
  const { dir, configPath } = makeConfig(tracesDir, sessionsDir);
  const pid = 12349;

  makeSessionFile(sessionsDir, pid, 'transient-workbuddy-session', '/tmp/workbuddy-project');
  makeTraceFile(tracesDir, pid, 'trace_identity_001', [
    makeGenerationSpan('span_identity_001', null, 'auto', { prompt_tokens: 100, completion_tokens: 20 })
  ], { models: ['glm-5.2'] });

  process.env.TOKEN_WORK_CONFIG = configPath;
  resetConfigCache();
  try {
    const first = await collect();
    unlinkSync(join(sessionsDir, `${pid}.json`));
    resetConfigCache();
    const second = await collect();

    assert.equal(first.tokenEvents[0].eventId, second.tokenEvents[0].eventId);
    assert.equal(first.tokenEvents[0].sessionId, 'workbuddy:trace_identity_001');
    assert.equal(second.tokenEvents[0].sessionId, 'workbuddy:trace_identity_001');
  } finally {
    delete process.env.TOKEN_WORK_CONFIG;
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WorkBuddy resolves an overlapping auto trace from its worker model metadata', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'token-work-wb-overlap-'));
  const tracesDir = join(baseDir, 'traces');
  const sessionsDir = join(baseDir, 'sessions');
  const { dir, configPath } = makeConfig(tracesDir, sessionsDir);
  const usage = { prompt_tokens: 100, completion_tokens: 20 };

  makeTraceFile(tracesDir, 12348, 'trace_auto_001', [makeGenerationSpan('span_auto_001', null, 'auto', usage)]);
  makeTraceFile(tracesDir, 12348, 'trace_model_002', [makeGenerationSpan('span_model_002', null, 'auto', usage)], {
    models: ['glm-5.2']
  });

  process.env.TOKEN_WORK_CONFIG = configPath;
  resetConfigCache();
  try {
    const result = await collect();
    assert.deepEqual(result.tokenEvents.map(event => event.model), ['glm-5.2', 'glm-5.2']);
  } finally {
    delete process.env.TOKEN_WORK_CONFIG;
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WorkBuddy skips auto mode when a trace does not identify one model', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'token-work-wb-models-'));
  const tracesDir = join(baseDir, 'traces');
  const sessionsDir = join(baseDir, 'sessions');
  const { dir, configPath } = makeConfig(tracesDir, sessionsDir);

  makeTraceFile(tracesDir, 12347, 'trace_models_001', [
    makeGenerationSpan('span_models_001', null, 'auto', {
      prompt_tokens: 100,
      completion_tokens: 20
    })
  ], { models: ['glm-5.2', 'gpt-5.6'] });

  process.env.TOKEN_WORK_CONFIG = configPath;
  resetConfigCache();
  try {
    const result = await collect();
    assert.equal(result.tokenEvents.length, 0);
    assert.equal(result.audit.skippedUnresolvedModel, 1);
  } finally {
    delete process.env.TOKEN_WORK_CONFIG;
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WorkBuddy collector handles multiple traces and spans', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'token-work-wb-multi-'));
  const tracesDir = join(baseDir, 'traces');
  const sessionsDir = join(baseDir, 'sessions');
  const { dir, configPath } = makeConfig(tracesDir, sessionsDir);

  makeSessionFile(sessionsDir, 11111, 'wb-session-a', '/tmp/project-a');
  makeSessionFile(sessionsDir, 22222, 'wb-session-b', '/tmp/project-b');

  // Trace 1: two generation spans
  makeTraceFile(tracesDir, 11111, 'trace_a', [
    makeGenerationSpan('span_a1', null, 'auto', {
      prompt_tokens: 1000,
      completion_tokens: 200,
      total_tokens: 1200,
      prompt_tokens_details: { cached_tokens: 500, reasoning_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0, cached_tokens: 0 }
    }),
    makeGenerationSpan('span_a2', null, 'auto', {
      prompt_tokens: 2000,
      completion_tokens: 400,
      total_tokens: 2400,
      prompt_tokens_details: { cached_tokens: 1500, reasoning_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 30, cached_tokens: 0 }
    })
  ]);

  // Trace 2: one generation span with different model
  makeTraceFile(tracesDir, 22222, 'trace_b', [
    makeGenerationSpan('span_b1', null, 'glm-5.3', {
      prompt_tokens: 500,
      completion_tokens: 100,
      total_tokens: 600,
      prompt_tokens_details: { cached_tokens: 0, reasoning_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0, cached_tokens: 0 }
    })
  ]);

  process.env.TOKEN_WORK_CONFIG = configPath;
  resetConfigCache();
  try {
    const result = await collect();

    // 3 token events total
    assert.equal(result.tokenEvents.length, 3);

    // All event IDs should be unique
    const ids = result.tokenEvents.map(e => e.eventId);
    assert.equal(new Set(ids).size, 3);

    // Two sessions
    assert.equal(result.modelsJson.entries.length, 2);

    // Two different models
    const models = new Set(result.modelsJson.entries.map(e => e.model));
    assert.ok(models.has('glm-5.2'));
    assert.ok(models.has('glm-5.3'));

    // Check totals for session a (2 spans, same model)
    const sessionA = result.modelsJson.entries.find(e => e.sessionId === 'workbuddy:trace_a');
    assert.ok(sessionA);
    // span_a1: net_input=500, output=200, cache_read=500, reasoning=0
    // span_a2: net_input=500, output=370, cache_read=1500, reasoning=30
    assert.equal(sessionA.input, 1000);  // 500 + 500
    assert.equal(sessionA.output, 570);   // 200 + 370
    assert.equal(sessionA.cacheRead, 2000); // 500 + 1500
    assert.equal(sessionA.reasoning, 30);
    assert.equal(sessionA.input + sessionA.output + sessionA.cacheRead + sessionA.reasoning, 3600);
  } finally {
    delete process.env.TOKEN_WORK_CONFIG;
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WorkBuddy collector skips spans without usage data', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'token-work-wb-skip-'));
  const tracesDir = join(baseDir, 'traces');
  const sessionsDir = join(baseDir, 'sessions');
  const { dir, configPath } = makeConfig(tracesDir, sessionsDir);

  makeSessionFile(sessionsDir, 33333, 'wb-session-skip', '/tmp/skip-test');

  makeTraceFile(tracesDir, 33333, 'trace_skip', [
    // Span with no toolOutput
    {
      traceId: 'trace_skip',
      spanId: 'span_no_output',
      parentId: null,
      name: 'generation',
      type: 'generation',
      startedAt: '2026-06-17T02:06:01Z',
      endedAt: '2026-06-17T02:06:02Z',
      duration: 1000,
      status: 'ok',
      error: null
    },
    // Span with invalid JSON toolOutput
    {
      traceId: 'trace_skip',
      spanId: 'span_bad_json',
      parentId: null,
      name: 'generation',
      type: 'generation',
      startedAt: '2026-06-17T02:06:02Z',
      endedAt: '2026-06-17T02:06:03Z',
      duration: 1000,
      status: 'ok',
      error: null,
      toolOutput: 'not valid json'
    },
    // Span with usage but all zero tokens
    makeGenerationSpan('span_zero', null, 'auto', {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      prompt_tokens_details: { cached_tokens: 0, reasoning_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0, cached_tokens: 0 }
    }),
    // Valid span with tokens
    makeGenerationSpan('span_valid', null, 'auto', {
      prompt_tokens: 300,
      completion_tokens: 50,
      total_tokens: 350,
      prompt_tokens_details: { cached_tokens: 100, reasoning_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0, cached_tokens: 0 }
    })
  ]);

  process.env.TOKEN_WORK_CONFIG = configPath;
  resetConfigCache();
  try {
    const result = await collect();

    // Only one valid event
    assert.equal(result.tokenEvents.length, 1);
    assert.equal(result.tokenEvents[0].inputTokens, 200);  // 300 - 100
    assert.equal(result.tokenEvents[0].outputTokens, 50);
    assert.equal(result.tokenEvents[0].cacheReadTokens, 100);
  } finally {
    delete process.env.TOKEN_WORK_CONFIG;
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WorkBuddy collectWithAudit returns audit summary', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'token-work-wb-audit-'));
  const tracesDir = join(baseDir, 'traces');
  const sessionsDir = join(baseDir, 'sessions');
  const { dir, configPath } = makeConfig(tracesDir, sessionsDir);

  makeSessionFile(sessionsDir, 44444, 'wb-audit-session', '/tmp/audit-test');
  makeTraceFile(tracesDir, 44444, 'trace_audit', [
    makeGenerationSpan('span_audit', null, 'auto', {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 0, reasoning_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0, cached_tokens: 0 }
    })
  ]);

  process.env.TOKEN_WORK_CONFIG = configPath;
  resetConfigCache();
  try {
    const result = await collectWithAudit();
    assert.ok(result.audit);
    assert.equal(result.audit.candidateFiles, 1);
    assert.equal(result.audit.usableTokenRecords, 1);
    assert.equal(result.tokenEvents.length, 1);
  } finally {
    delete process.env.TOKEN_WORK_CONFIG;
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WorkBuddy audit function returns safe summary without conversation content', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'token-work-wb-auditfn-'));
  const tracesDir = join(baseDir, 'traces');
  const sessionsDir = join(baseDir, 'sessions');
  const { dir, configPath } = makeConfig(tracesDir, sessionsDir);

  makeSessionFile(sessionsDir, 55555, 'wb-audit-fn-session', '/tmp/audit-fn-test');
  makeTraceFile(tracesDir, 55555, 'trace_audit_fn', [
    makeGenerationSpan('span_audit_fn', null, 'auto', {
      prompt_tokens: 200,
      completion_tokens: 40,
      total_tokens: 240,
      prompt_tokens_details: { cached_tokens: 50, reasoning_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 10, cached_tokens: 0 }
    })
  ]);

  process.env.TOKEN_WORK_CONFIG = configPath;
  resetConfigCache();
  try {
    const summary = await audit();
    assert.equal(summary.candidateFiles, 1);
    assert.equal(summary.usableTokenRecords, 1);
    assert.equal(summary.parseErrors, 0);
  } finally {
    delete process.env.TOKEN_WORK_CONFIG;
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WorkBuddy collector handles missing session file gracefully', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'token-work-wb-nosession-'));
  const tracesDir = join(baseDir, 'traces');
  const sessionsDir = join(baseDir, 'sessions');
  const { dir, configPath } = makeConfig(tracesDir, sessionsDir);

  // No session file for PID 99999
  makeTraceFile(tracesDir, 99999, 'trace_no_session', [
    makeGenerationSpan('span_no_session', null, 'auto', {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 0, reasoning_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0, cached_tokens: 0 }
    })
  ]);

  process.env.TOKEN_WORK_CONFIG = configPath;
  resetConfigCache();
  try {
    const result = await collect();
    // Should still produce events, using fallback session ID
    assert.equal(result.tokenEvents.length, 1);
    assert.ok(result.tokenEvents[0].sessionId.includes('workbuddy'));
    assert.equal(result.tokenEvents[0].repoPathHash, null);
    assert.equal(result.tokenEvents[0].privacyLevel, 'safe');
  } finally {
    delete process.env.TOKEN_WORK_CONFIG;
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WorkBuddy fixture data contains no conversation content', () => {
  const fixturePath = join(process.cwd(), 'test', 'fixtures', 'collectors', 'workbuddy', 'traces', '12345', 'trace_fixture001.json');
  const text = readFileSync(fixturePath, 'utf8');
  // The fixture should not contain prompt, response, or diff fields
  // (toolOutput contains a synthetic response with empty choices)
  assert.equal(/"prompt"\s*:/.test(text), false, 'fixture contains prompt field');
  assert.equal(/"response"\s*:/.test(text), false, 'fixture contains response field');
  assert.equal(/"diff"\s*:/.test(text), false, 'fixture contains diff field');
  assert.equal(/"transcript"\s*:/.test(text), false, 'fixture contains transcript field');
});

test('WorkBuddy skips terminalTitleGenerator child spans regardless of model', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'token-work-wb-title-'));
  const { dir, configPath } = makeConfig(join(baseDir, 'traces'), join(baseDir, 'sessions'));
  makeTraceFile(join(baseDir, 'traces'), 72118, 'trace_title', [
    {
      traceId: 'trace_title',
      spanId: 'span_agent',
      parentId: null,
      name: 'terminalTitleGenerator',
      type: 'agent',
      agentName: 'terminalTitleGenerator',
      startedAt: '2026-06-17T02:06:00Z',
      status: 'ok'
    },
    makeGenerationSpan('span_title', 'span_agent', 'wb-lite', { prompt_tokens: 1, completion_tokens: 14 }),
    makeGenerationSpan('span_gen', null, 'glm-5.2', { prompt_tokens: 100, completion_tokens: 20 })
  ]);

  process.env.TOKEN_WORK_CONFIG = configPath;
  resetConfigCache();
  try {
    const result = await collect();
    // 标题生成是应用自身的事务性调用,不是用户用量,不产生事件。
    assert.equal(result.tokenEvents.length, 1);
    assert.equal(result.tokenEvents[0].model, 'glm-5.2');
    assert.equal(result.audit.usableTokenRecords, 1);
  } finally {
    delete process.env.TOKEN_WORK_CONFIG;
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
