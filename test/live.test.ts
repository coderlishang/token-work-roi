import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLiveDataFreshness, buildLiveGuardrails, buildLiveSnapshot } from '../src/live.ts';
import { openDb, upsertTokenEvent } from '../src/db.ts';
import { removeTempDir } from '../test-support/fs.ts';
import { startTestServer, stopTestServer, waitForTestServer } from '../test-support/server.ts';

test('live snapshot uses recent token events for burn rate and cache hit', () => {
  const snapshot = buildLiveSnapshot({
    now: new Date('2026-06-17T02:15:00Z'),
    windowMinutes: 15,
    sessions: [{
      device: 'demo',
      source: 'Codex CLI',
      sessionId: 'old',
      lastActivity: '2026-06-17T01:00:00Z',
      totalTokens: 99999
    }],
    tokenEvents: [{
      eventId: 'e1',
      device: 'demo',
      source: 'Cursor',
      sessionId: 's1',
      timestamp: '2026-06-17T02:10:00Z',
      model: 'gpt-5.3-codex',
      inputTokens: 1000,
      outputTokens: 250,
      cacheReadTokens: 500
    }]
  });
  assert.equal(snapshot.status, 'active');
  assert.equal(snapshot.totals.totalTokens, 1750);
  assert.equal(snapshot.dataFreshness, 'fresh');
  assert.equal(snapshot.totals.burnRateTokensPerHour, 7000);
  assert.equal(snapshot.bySource[0].key, 'Cursor');
  assert.equal(snapshot.activeSessions.length, 0);
  assert.ok(snapshot.totals.cacheHitRate > 0);
});

test('live snapshot builds 24h pulse metrics from event-level rows', () => {
  const snapshot = buildLiveSnapshot({
    now: new Date('2026-06-17T12:00:00Z'),
    windowMinutes: 1440,
    tokenEvents: [{
      eventId: 'e1',
      device: 'demo',
      source: 'Codex CLI',
      sessionId: 's1',
      timestamp: '2026-06-17T01:10:00Z',
      model: 'gpt-5.5',
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 400
    }, {
      eventId: 'e2',
      device: 'demo',
      source: 'Claude Code',
      sessionId: 's2',
      timestamp: '2026-06-17T11:50:00Z',
      model: 'claude-opus-4-7',
      inputTokens: 2000,
      outputTokens: 300,
      cacheReadTokens: 700
    }]
  });
  assert.equal(snapshot.totals.requestCount, 2);
  assert.equal(snapshot.pulse.requestCount, 2);
  assert.equal(snapshot.pulse.timeline.length, 24);
  assert.equal(snapshot.pulse.agent.activeMinutes, 30);
  assert.equal(snapshot.pulse.agent.utilizationPercent, 2.083333333333333);
  assert.equal(snapshot.byModel[0].requests, 1);
});

test('live snapshot uses the same valid window for totals, burn rate and timeline', () => {
  for (const [requested, expected] of [[0, 15], [-1, 15], [NaN, 15], [Infinity, 15], [0.5, 1]]) {
    const snapshot = buildLiveSnapshot({
      now: new Date('2026-09-05T12:00:00Z'), windowMinutes: requested,
      tokenEvents: [{ timestamp: '2026-09-05T12:00:00Z', inputTokens: 100 }]
    });
    assert.equal(snapshot.windowMinutes, expected);
    assert.equal(snapshot.pulse.windowMinutes, expected);
    assert.equal(snapshot.totals.burnRateTokensPerHour, Math.round(6000 / expected));
    assert.equal(snapshot.pulse.timeline.reduce((total, row) => total + row.totalTokens, 0), 100);
  }
});

test('live snapshot reports idle empty state', () => {
  const snapshot = buildLiveSnapshot({
    now: new Date('2026-06-17T02:15:00Z'),
    sessions: [],
    tokenEvents: []
  });
  assert.equal(snapshot.status, 'idle');
  assert.equal(snapshot.totals.totalTokens, 0);
  assert.equal(snapshot.dataFreshness, 'empty');
  assert.deepEqual(snapshot.byModel, []);
});

test('live snapshot does not count cumulative sessions when the current window has no events', () => {
  const snapshot = buildLiveSnapshot({
    now: new Date('2026-09-05T12:00:00Z'),
    windowMinutes: 1440,
    latestEventAt: '2026-09-04T00:00:00Z',
    sessions: [{
      source: 'Codex',
      sessionId: 'long-running-session',
      model: 'gpt-5.5',
      lastActivity: '2026-09-05T11:00:00Z',
      totalTokens: 200_000_000
    }],
    tokenEvents: []
  });

  assert.equal(snapshot.totals.totalTokens, 0);
  assert.equal(snapshot.totals.requestCount, 0);
  assert.equal(snapshot.pulse.requestCount, 0);
  assert.equal(snapshot.byModel.length, 0);
});

test('live snapshot excludes zero-token synthetic model placeholders', () => {
  const snapshot = buildLiveSnapshot({
    now: new Date('2026-06-17T02:15:00Z'),
    windowMinutes: 15,
    sessions: [{
      device: 'demo',
      source: 'Claude Code',
      sessionId: 'real-session',
      lastActivity: '2026-06-17T02:10:00Z',
      model: 'glm-5.2',
      inputTokens: 1000,
      outputTokens: 100,
      totalTokens: 1100
    }, {
      device: 'demo',
      source: 'Claude Code',
      sessionId: 'placeholder-session',
      lastActivity: '2026-06-17T02:11:00Z',
      model: '<synthetic>'
    }]
  });

  assert.equal(snapshot.totals.totalTokens, 1100);
  assert.deepEqual(snapshot.byModel.map(row => row.key), ['glm-5.2']);
  assert.deepEqual(snapshot.activeSessions.map(row => row.model), ['glm-5.2']);
});

test('live snapshot recalculates a zero stored cost for a priced session', () => {
  const snapshot = buildLiveSnapshot({
    now: new Date('2026-09-04T16:00:00Z'),
    windowMinutes: 60,
    sessions: [{
      device: 'macbook',
      source: 'WorkBuddy',
      sessionId: 'hy3-session',
      lastActivity: '2026-09-04T15:50:00Z',
      model: 'hy3',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      totalTokens: 2_000_000,
      costUSD: 0
    }]
  });

  assert.equal(snapshot.byModel[0].key, 'hy3');
  assert.ok(snapshot.byModel[0].costUSD > 0);
  assert.ok(snapshot.activeSessions[0].costUSD > 0);
});

test('live snapshot merges same-model spellings under the dominant raw name', () => {
  const snapshot = buildLiveSnapshot({
    now: new Date('2026-10-09T12:00:00Z'),
    windowMinutes: 1440,
    tokenEvents: [
      {
        source: 'WorkBuddy', sessionId: 'wb-1', model: 'deepseek-v4.1-flash',
        timestamp: '2026-10-09T10:00:00Z',
        inputTokens: 480_000, outputTokens: 320_000
      },
      {
        source: 'WorkBuddy', sessionId: 'wb-1', model: 'deepseek-v4.1-flash',
        timestamp: '2026-10-09T10:30:00Z',
        inputTokens: 120_000, outputTokens: 80_000
      },
      {
        source: 'Claude Code', sessionId: 'cc-1', model: 'deepseek-v4-1-flash',
        timestamp: '2026-10-09T11:00:00Z',
        inputTokens: 12_000, outputTokens: 8_000
      },
      {
        // 单事件 token 大于任何一个 v4.1-flash 事件,但写法总量(500k)不及 v4.1-flash(1M)
        source: 'DeepSeek Harness', sessionId: 'ds-1', model: 'deepseek-flash',
        timestamp: '2026-10-09T11:30:00Z',
        inputTokens: 300_000, outputTokens: 200_000
      },
      {
        source: 'WorkBuddy', sessionId: 'wb-1', model: 'deepseek-v4-flash',
        timestamp: '2026-10-09T11:45:00Z',
        inputTokens: 4_000, outputTokens: 3_000
      }
    ]
  });

  assert.deepEqual(snapshot.byModel.map(row => row.key), ['deepseek-v4.1-flash', 'deepseek-v4-flash']);
  assert.equal(snapshot.byModel[0].requests, 4);
  assert.equal(snapshot.byModel[0].totalTokens, 1_520_000);
  assert.equal(snapshot.byModel[1].totalTokens, 7_000);
});

test('live data freshness explains collecting, stale and empty states', () => {
  assert.equal(buildLiveDataFreshness({
    collectionState: { status: 'running' }
  }).dataFreshness, 'collecting');

  assert.equal(buildLiveDataFreshness({
    collectionState: { status: 'error', message: 'collector failed' },
    tokenEventCount: 10
  }).dataFreshness, 'error');

  assert.equal(buildLiveDataFreshness({
    nowMs: new Date('2026-06-20T10:00:00Z').getTime(),
    tokenEventCount: 10,
    latestEventAt: '2026-06-20T09:00:00Z',
    latestCollectionRunAt: '2026-06-20T09:59:30Z',
    refreshIntervalSeconds: 60
  }).dataFreshness, 'fresh');

  const stale = buildLiveDataFreshness({
    nowMs: new Date('2026-06-20T10:00:00Z').getTime(),
    tokenEventCount: 10,
    latestEventAt: '2026-06-20T09:00:00Z',
    latestCollectionRunAt: '2026-06-20T09:30:00Z',
    refreshIntervalSeconds: 60
  });
  assert.equal(stale.dataFreshness, 'stale');
  assert.match(stale.staleReason, /刷新/);
});

test('live snapshot keeps the last collection failure reason for the real-time page', () => {
  const snapshot = buildLiveSnapshot({
    collectionState: {
      status: 'error',
      message: '无法启动采集进程：spawn node ENOENT',
      finishedAt: '2026-06-20T10:00:00Z',
      exitCode: null
    }
  });

  assert.equal(snapshot.dataFreshness, 'error');
  assert.equal(snapshot.staleReason, '无法启动采集进程：spawn node ENOENT');
  assert.equal(snapshot.collectionState.message, '无法启动采集进程：spawn node ENOENT');
});

test('live guardrails warn on burn rate, low cache hit, low output/input and unpriced models', () => {
  const snapshot = buildLiveSnapshot({
    now: new Date('2026-06-17T02:15:00Z'),
    windowMinutes: 15,
    tokenEvents: [{
      eventId: 'e1',
      device: 'demo',
      source: 'Codex CLI',
      sessionId: 's1',
      timestamp: '2026-06-17T02:10:00Z',
      model: 'gpt-5.3-codex-spark',
      inputTokens: 20_000,
      outputTokens: 500,
      cacheReadTokens: 0
    }],
    guardrailConfig: { tokenBudgetPerHour: 50_000 }
  });
  const types = snapshot.warnings.map(item => item.type).sort();
  assert.deepEqual(types, [
    'current-model-focus',
    'high-burn-rate',
    'low-cache-hit',
    'low-output-input-ratio',
    'unpriced-model-active'
  ].sort());
  assert.equal(snapshot.guardrails.tokenBudgetPerHour, 50_000);
});

test('live advice uses observed model cost, cache reuse and nearby project sessions without a default budget', () => {
  const now = new Date('2026-08-09T12:00:00Z');
  const snapshot = buildLiveSnapshot({
    now,
    windowMinutes: 60,
    sessions: [{
      device: 'macbook',
      source: 'Codex Desktop',
      sessionId: 'textweave-session',
      projectPath: '/Users/coderlishang/projects/TextWeaveFlutter',
      lastActivity: '2026-08-09T11:55:00Z',
      model: 'gpt-5.6-sol',
      inputTokens: 100_000,
      cacheReadTokens: 1_900_000,
      outputTokens: 5_000,
      totalTokens: 2_005_000
    }, {
      device: 'macbook',
      source: 'Codex Desktop',
      sessionId: 'token-work-session',
      projectPath: '/Users/coderlishang/projects/token-work-roi',
      lastActivity: '2026-08-09T11:42:00Z',
      model: 'gpt-5.6-sol',
      inputTokens: 80_000,
      cacheReadTokens: 1_500_000,
      outputTokens: 4_000,
      totalTokens: 1_584_000
    }],
    tokenEvents: [{
      eventId: 'textweave-event',
      device: 'macbook',
      source: 'Codex Desktop',
      sessionId: 'textweave-session',
      timestamp: '2026-08-09T11:55:00Z',
      model: 'gpt-5.6-sol',
      inputTokens: 100_000,
      cacheReadTokens: 1_900_000,
      outputTokens: 5_000,
      costUSD: 10
    }, {
      eventId: 'token-work-event',
      device: 'macbook',
      source: 'Codex Desktop',
      sessionId: 'token-work-session',
      timestamp: '2026-08-09T11:42:00Z',
      model: 'gpt-5.6-sol',
      inputTokens: 80_000,
      cacheReadTokens: 1_500_000,
      outputTokens: 4_000,
      costUSD: 8
    }]
  });
  const types = snapshot.warnings.map(item => item.type);

  assert.equal(snapshot.guardrails.tokenBudgetPerHour, 0);
  assert.equal(types.includes('high-burn-rate'), false);
  assert.equal(types.includes('low-output-input-ratio'), false);
  assert.equal(types.includes('heavy-model-stop-today'), false);
  assert.ok(types.includes('dominant-heavy-model-cost'));
  assert.ok(types.includes('parallel-heavy-contexts'));
  assert.ok(types.includes('current-model-focus'));
  assert.equal(types.includes('healthy-cache-reuse'), false);
});

test('live advice does not keep parallel-window guidance after activity ends', () => {
  const now = new Date('2026-08-09T12:00:00Z');
  const snapshot = buildLiveSnapshot({
    now,
    windowMinutes: 1440,
    sessions: [{
      device: 'macbook',
      source: 'Codex Desktop',
      sessionId: 'textweave-session',
      projectPath: '/Users/coderlishang/projects/TextWeaveFlutter',
      lastActivity: '2026-08-09T09:55:00Z',
      model: 'gpt-5.6-sol',
      totalTokens: 2_005_000
    }, {
      device: 'macbook',
      source: 'Codex Desktop',
      sessionId: 'token-work-session',
      projectPath: '/Users/coderlishang/projects/token-work-roi',
      lastActivity: '2026-08-09T09:42:00Z',
      model: 'gpt-5.6-sol',
      totalTokens: 1_584_000
    }],
    tokenEvents: [{
      eventId: 'textweave-event',
      device: 'macbook',
      source: 'Codex Desktop',
      sessionId: 'textweave-session',
      timestamp: '2026-08-09T09:55:00Z',
      model: 'gpt-5.6-sol',
      inputTokens: 100_000,
      outputTokens: 5_000,
      costUSD: 10
    }, {
      eventId: 'token-work-event',
      device: 'macbook',
      source: 'Codex Desktop',
      sessionId: 'token-work-session',
      timestamp: '2026-08-09T09:42:00Z',
      model: 'gpt-5.6-sol',
      inputTokens: 80_000,
      outputTokens: 4_000,
      costUSD: 8
    }]
  });

  assert.equal(snapshot.warnings.some(item => item.type === 'parallel-heavy-contexts'), false);
});

test('live advice follows the active session instead of an older session with more daily tokens', () => {
  const now = new Date('2026-08-12T12:00:00Z');
  const snapshot = buildLiveSnapshot({
    now,
    windowMinutes: 1440,
    tokenEvents: [{
      eventId: 'older-heavy-session',
      device: 'macbook',
      source: 'Codex Desktop',
      sessionId: 'older-heavy-session',
      timestamp: '2026-08-12T10:20:00Z',
      model: 'gpt-5.6-sol',
      inputTokens: 900_000,
      outputTokens: 100_000
    }, {
      eventId: 'active-session',
      device: 'macbook',
      source: 'Codex Desktop',
      sessionId: 'active-session',
      timestamp: '2026-08-12T11:55:00Z',
      model: 'gpt-5.6-terra',
      inputTokens: 12_000,
      outputTokens: 3_000
    }]
  });
  const warning = snapshot.warnings.find(item => item.type === 'current-model-focus');

  assert.ok(warning);
  assert.equal(warning.message, '当前主窗口使用 gpt-5.6-terra');
  assert.match(warning.evidence, /近 60 分钟 15,000 tokens/);
  assert.match(warning.evidence, /窗口 active-session/);
  assert.equal(snapshot.warnings.some(item => item.type === 'healthy-cache-reuse'), false);
});

test('live advice does not describe session summaries as recent event usage', () => {
  const snapshot = buildLiveSnapshot({
    now: new Date('2026-08-12T12:00:00Z'),
    windowMinutes: 1440,
    sessions: [{
      device: 'macbook',
      source: 'Codex Desktop',
      sessionId: 'summary-only-session',
      lastActivity: '2026-08-12T11:55:00Z',
      model: 'gpt-5.6-sol',
      inputTokens: 40_000,
      outputTokens: 5_000,
      totalTokens: 45_000
    }]
  });

  assert.equal(snapshot.warnings.some(item => item.type === 'current-model-focus'), false);
});

test('live guardrail thresholds can be overridden', () => {
  const warnings = buildLiveGuardrails({
    totals: {
      inputTokens: 20_000,
      outputTokens: 500,
      cacheReadTokens: 0,
      totalTokens: 20_500,
      burnRateTokensPerHour: 60_000,
      cacheHitRate: 50
    },
    byModel: [{ key: 'gpt-5.3-codex', totalTokens: 20_500 }]
  }, {
    tokenBudgetPerHour: 100_000,
    minCacheHitRate: 0.1,
    minOutputInputRatio: 0.01,
    highInputTokens: 10_000
  });
  assert.deepEqual(warnings, []);
});

test('live guardrails include reasoning tokens before warning on low response ratio', () => {
  const warnings = buildLiveGuardrails({
    totals: {
      inputTokens: 20_000,
      outputTokens: 500,
      reasoningTokens: 4_000,
      burnRateTokensPerHour: 10_000,
      cacheHitRate: 50
    },
    byModel: [{ key: 'gpt-5.6-sol', totalTokens: 24_500 }]
  }, {
    highInputTokens: 10_000,
    minOutputInputRatio: 0.15,
    tokenBudgetPerHour: 100_000
  });

  assert.equal(warnings.some(item => item.type === 'low-output-input-ratio'), false);
});

test('live guardrails point advice at the highest token active window', () => {
  const snapshot = buildLiveSnapshot({
    now: new Date('2026-06-17T02:15:00Z'),
    windowMinutes: 15,
    sessions: [{
      device: 'demo',
      source: 'Codex CLI',
      sessionId: 'small-window',
      lastActivity: '2026-06-17T02:12:00Z',
      model: 'gpt-5.3-codex',
      inputTokens: 4_000,
      outputTokens: 500,
      totalTokens: 4_500
    }, {
      device: 'demo',
      source: 'Claude Code',
      sessionId: 'large-window-with-repeated-context',
      lastActivity: '2026-06-17T02:13:00Z',
      model: 'claude-fable-5',
      inputTokens: 30_000,
      outputTokens: 500,
      totalTokens: 30_500
    }]
  });
  const warning = snapshot.warnings.find(item => item.type === 'low-output-input-ratio');

  assert.ok(warning);
  assert.match(warning.evidence, /large-wi…ontext/);
  assert.match(warning.evidence, /来源 Claude Code/);
  assert.match(warning.evidence, /模型 claude-fable-5/);
  assert.match(warning.action, /token 最高的窗口/);
});

test('live guardrails use complete current-window session totals for advice context', () => {
  const now = new Date('2026-06-17T02:15:00Z');
  const sessions = Array.from({ length: 12 }, (_, index) => ({
    device: 'demo',
    source: 'Codex CLI',
    sessionId: `recent-${index + 1}`,
    lastActivity: new Date(now.getTime() - (index + 1) * 1_000).toISOString(),
    model: 'gpt-5.3-codex',
    inputTokens: 3_000,
    outputTokens: 100,
    totalTokens: 3_100
  }));
  sessions.push({
    device: 'demo',
    source: 'Claude Code',
    sessionId: 'highest-window-outside-active-list',
    lastActivity: new Date(now.getTime() - 13_000).toISOString(),
    model: 'claude-fable-5',
    inputTokens: 40_000,
    outputTokens: 500,
    totalTokens: 40_500
  });

  const snapshot = buildLiveSnapshot({ now, windowMinutes: 15, sessions });
  const warning = snapshot.warnings.find(item => item.type === 'low-output-input-ratio');

  assert.equal(snapshot.activeSessions.some(item => item.sessionId === 'highest-window-outside-active-list'), false);
  assert.equal('adviceContext' in snapshot, false);
  assert.ok(warning);
  assert.match(warning.evidence, /highest-…e-list/);
  assert.match(warning.evidence, /来源 Claude Code/);
  assert.match(warning.evidence, /模型 claude-fable-5/);
});

test('live snapshot builds budget windows and budget warnings', () => {
  const snapshot = buildLiveSnapshot({
    now: new Date('2026-06-17T02:15:00Z'),
    windowMinutes: 15,
    budgetProfiles: [{
      id: 1,
      source: 'Codex CLI',
      label: 'Codex 15m',
      windowMinutes: 15,
      tokenBudget: 10_000,
      costBudgetUSD: 0,
      enabled: true
    }],
    tokenEvents: [{
      eventId: 'e1',
      device: 'demo',
      source: 'Codex CLI',
      sessionId: 's1',
      timestamp: '2026-06-17T02:10:00Z',
      model: 'gpt-5.3-codex',
      inputTokens: 9_000,
      outputTokens: 1_000
    }]
  });
  assert.equal(snapshot.budgetWindows.length, 1);
  assert.equal(snapshot.budgetWindows[0].status, 'exceeded');
  assert.ok(snapshot.warnings.some(item => item.type === 'budget-exceeded'));
});

test('live guardrails use a custom budget without inventing a model-stop instruction', () => {
  const snapshot = buildLiveSnapshot({
    now: new Date('2026-06-17T02:15:00Z'),
    windowMinutes: 15,
    budgetProfiles: [{
      id: 1,
      source: 'Claude Code',
      label: 'Claude 15m',
      windowMinutes: 15,
      tokenBudget: 10_000,
      enabled: true
    }],
    tokenEvents: [{
      eventId: 'heavy-budget',
      device: 'demo',
      source: 'Claude Code',
      sessionId: 's1',
      timestamp: '2026-06-17T02:10:00Z',
      model: 'claude-opus-4-7',
      inputTokens: 9_000,
      outputTokens: 2_000
    }]
  });
  assert.ok(snapshot.warnings.some(item => item.type === 'budget-exceeded'));
  assert.equal(snapshot.warnings.some(item => item.type === 'heavy-model-stop-today'), false);
});

test('live snapshot warns when current pace will exceed custom budget', () => {
  const snapshot = buildLiveSnapshot({
    now: new Date('2026-06-17T02:15:00Z'),
    windowMinutes: 15,
    budgetProfiles: [{
      id: 1,
      source: 'Codex CLI',
      label: 'Codex 15m',
      windowMinutes: 15,
      tokenBudget: 12_000,
      enabled: true
    }],
    tokenEvents: [{
      eventId: 'e1',
      device: 'demo',
      source: 'Codex CLI',
      sessionId: 's1',
      timestamp: '2026-06-17T02:12:00Z',
      model: 'gpt-5.3-codex',
      inputTokens: 8_000,
      outputTokens: 1_000
    }]
  });
  assert.equal(snapshot.budgetWindows[0].status, 'over-pace');
  assert.ok(snapshot.warnings.some(item => item.type === 'over-budget-pace'));
});

test('live snapshot supports fixed budget reset windows and custom near threshold', () => {
  const snapshot = buildLiveSnapshot({
    now: new Date('2026-06-17T02:15:00Z'),
    windowMinutes: 15,
    budgetProfiles: [{
      id: 1,
      source: 'Codex CLI',
      label: 'Codex fixed hour',
      windowType: 'fixed',
      windowMinutes: 60,
      resetAnchor: '2026-06-17T00:00:00Z',
      warningThreshold: 0.2,
      tokenBudget: 10_000,
      enabled: true
    }],
    tokenEvents: [{
      eventId: 'e1',
      device: 'demo',
      source: 'Codex CLI',
      sessionId: 's1',
      timestamp: '2026-06-17T02:10:00Z',
      model: 'gpt-5.3-codex',
      inputTokens: 1_800,
      outputTokens: 400
    }]
  });
  const window = snapshot.budgetWindows[0];
  assert.equal(window.windowType, 'fixed');
  assert.equal(window.windowStart, '2026-06-17T02:00:00.000Z');
  assert.equal(window.windowEnd, '2026-06-17T03:00:00.000Z');
  assert.equal(window.resetInMinutes, 45);
  assert.equal(window.warningThreshold, 0.2);
  assert.equal(window.status, 'near-limit');
  assert.ok(snapshot.warnings.some(item => item.type === 'near-budget-limit'));
});


test('live API returns guardrails and warnings from temporary SQLite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-work-live-api-'));
  const dbPath = join(dir, 'usage.sqlite');
  const db = openDb(dbPath);
  try {
    upsertTokenEvent(db, {
      eventId: 'live-api-warning',
      device: 'devbox',
      source: 'Codex CLI',
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      model: 'gpt-5.3-codex-spark',
      inputTokens: 20_000,
      outputTokens: 100
    });
  } finally {
    db.close();
  }

  const server = startTestServer({ dbPath });

  try {
    const port = await waitForTestServer(server, { path: '/api/live' });
    const response = await fetch(`http://127.0.0.1:${port}/api/live`);
    if (!response.ok) assert.fail(await response.text());
    const body = await response.json();
    assert.equal(body.guardrails.tokenBudgetPerHour, 0);
    assert.equal(body.dataFreshness, 'fresh');
    assert.equal(typeof body.latestEventAt, 'string');
    assert.equal(body.collectionState.status, 'idle');
    assert.equal(body.warnings.some(item => item.type === 'high-burn-rate'), false);
    assert.ok(body.warnings.some(item => item.type === 'low-cache-hit'));
    for (const window of ['0', '-1', '0.5', 'NaN', 'Infinity', '10081']) {
      const invalid = await fetch(`http://127.0.0.1:${port}/api/live?windowMinutes=${window}`);
      assert.equal(invalid.status, 400, window);
    }
    const daily = await fetch(`http://127.0.0.1:${port}/api/live?windowMinutes=1440`);
    assert.equal(daily.status, 200);
    assert.equal((await daily.json()).windowMinutes, 1440);
  } finally {
    await stopTestServer(server.child);
    await removeTempDir(dir);
  }
});

test('live API does not cap 24h token event counts at 500', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-work-live-window-'));
  const dbPath = join(dir, 'usage.sqlite');
  const db = openDb(dbPath);
  try {
    const now = Date.now();
    for (let index = 0; index < 620; index += 1) {
      upsertTokenEvent(db, {
        eventId: `live-window-${index}`,
        device: 'devbox',
        source: 'Codex CLI',
        sessionId: `s${index % 5}`,
        timestamp: new Date(now - index * 60 * 1000).toISOString(),
        model: 'gpt-5.3-codex',
        inputTokens: 100,
        outputTokens: 20
      });
    }
  } finally {
    db.close();
  }

  const server = startTestServer({ dbPath });

  try {
    const port = await waitForTestServer(server, { path: '/api/live' });
    const response = await fetch(`http://127.0.0.1:${port}/api/live?windowMinutes=1440`);
    if (!response.ok) assert.fail(await response.text());
    const body = await response.json();
    assert.equal(body.totals.requestCount, 620);
    assert.equal(body.pulse.requestCount, 620);
    assert.equal(body.bySource[0].requests, 620);
  } finally {
    await stopTestServer(server.child);
    await removeTempDir(dir);
  }
});
