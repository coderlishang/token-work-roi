import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCoverageBridge } from '../src/coverage-bridge.ts';
import { buildBudgetWindows } from '../src/live.ts';

test('coverage catch-up separates experimental audit from detected-only coverage', () => {
  const bridge = buildCoverageBridge({
    sourceHealth: [{
      id: 'cursor',
      label: 'Cursor',
      supportStatus: 'experimental',
      detected: true,
      tokenReliability: 'explicit-token-fields-only',
      readsConversationContent: false,
      sessions: 0,
      tokenEvents: 0,
      dailyRows: 0,
      totalTokens: 0
    }, {
      id: 'cline',
      label: 'Cline',
      supportStatus: 'detected-only',
      detected: true,
      tokenReliability: 'unknown-no-usage-import',
      readsConversationContent: false
    }, {
      id: 'codex',
      label: 'Codex CLI',
      supportStatus: 'stable',
      detected: true,
      tokenReliability: 'native-token-fields',
      readsConversationContent: false,
      sessions: 2,
      tokenEvents: 20,
      totalTokens: 1000
    }]
  });

  const cursor = bridge.rows.find(row => row.id === 'cursor');
  const cline = bridge.rows.find(row => row.id === 'cline');
  const codex = bridge.rows.find(row => row.id === 'codex');

  assert.equal(cursor.status, 'experimental-audit');
  assert.equal(cursor.successfulCoverage, false);
  assert.equal(cursor.canWriteUsage, false);
  assert.match(cursor.recommendedPath, /audit/i);
  assert.equal(cline.status, 'detected-only');
  assert.equal(codex.status, 'native-trusted');
  assert.equal(codex.successfulCoverage, true);
  assert.equal(bridge.summary.experimental, 1);
  assert.equal(bridge.summary.detectedOnly, 1);
  assert.equal(bridge.summary.successfulCoverage, 1);
});

test('budget windows can target heavy model groups and hard thresholds', () => {
  const now = new Date('2026-06-20T12:00:00.000Z').getTime();
  const rows = [{
    timestampMs: now - 5 * 60 * 1000,
    source: 'Claude Code',
    model: 'claude-opus-4-7',
    sessionId: 'heavy-1',
    inputTokens: 900,
    outputTokens: 100,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    totalTokens: 1000,
    costUSD: 2
  }, {
    timestampMs: now - 4 * 60 * 1000,
    source: 'Claude Code',
    model: 'claude-haiku-4-5',
    sessionId: 'light-1',
    inputTokens: 5000,
    outputTokens: 500,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    totalTokens: 5500,
    costUSD: 1
  }];

  const windows = buildBudgetWindows({
    rows,
    nowMs: now,
    budgetProfiles: [{
      id: 1,
      source: 'Claude Code',
      modelGroup: 'heavy',
      label: 'Heavy cap',
      windowType: 'rolling',
      windowMinutes: 15,
      tokenBudget: 1000,
      hardThreshold: 1.2,
      warningThreshold: 0.7,
      enabled: true
    }]
  });

  assert.equal(windows.length, 1);
  assert.equal(windows[0].totalTokens, 1000);
  assert.equal(windows[0].modelGroup, 'heavy');
  assert.equal(windows[0].hardThreshold, 1.2);
  assert.equal(windows[0].status, 'over-pace');
});

test('Codex budgets include generic, CLI and Desktop sources without matching other tools', () => {
  const nowMs = Date.parse('2026-09-05T12:00:00Z');
  const rows = ['Codex', 'Codex CLI', 'Codex Desktop', 'codex', 'CodexOther', 'Claude Code']
    .map(source => ({ source, timestampMs: nowMs, totalTokens: 100 }));
  const [budget] = buildBudgetWindows({
    rows, nowMs,
    budgetProfiles: [{ source: 'Codex', windowMinutes: 15, tokenBudget: 400 }]
  });
  assert.equal(budget.totalTokens, 400);
  assert.equal(budget.status, 'exceeded');
});

test('rolling budgets handle large event windows without truncation', () => {
  const nowMs = Date.parse('2026-09-05T12:00:00Z');
  const rows = Array.from({ length: 150_000 }, (_, index) => ({
    timestampMs: nowMs - (index % 60 + 1) * 60_000,
    inputTokens: 1, outputTokens: 0, cacheReadTokens: 0,
    cacheCreationTokens: 0, reasoningTokens: 0, totalTokens: 1, costUSD: 0
  }));
  const [budget] = buildBudgetWindows({
    rows, nowMs, budgetProfiles: [{ windowMinutes: 300, tokenBudget: 150_000 }]
  });
  assert.equal(budget.totalTokens, 150_000);
  assert.equal(budget.burnRateTokensPerHour, 150_000);
  assert.equal(budget.projectedTokens, 750_000);
  assert.equal(budget.status, 'exceeded');
});
