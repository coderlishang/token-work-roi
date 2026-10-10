import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildModelUsageRows,
  filterSessionsByDashboardFilters,
  sessionModel
} from '../src/client/dashboard/model-usage.ts';
import { U } from '../src/client/shared/utils.ts';

const sessions = [
  {
    device: 'devbox',
    source: 'Codex CLI',
    sessionId: 'codex-a',
    model: 'gpt-5.5',
    lastActivity: '2026-06-10',
    totalTokens: 100,
    costUSD: 0.01
  },
  {
    device: 'devbox',
    source: 'Claude Code',
    sessionId: 'claude-a',
    model: 'claude-opus-4-7',
    lastActivity: '2026-06-10',
    totalTokens: 50,
    costUSD: 0.02
  },
  {
    device: 'laptop',
    source: 'Codex CLI',
    sessionId: 'codex-b',
    pricingModel: 'gpt-5.3-codex',
    lastActivity: '2026-06-09',
    totalTokens: 30,
    costUSD: 0.03
  }
];

const daily = [
  {
    usageDate: '2026-06-10',
    source: 'Codex CLI',
    model: 'gpt-5.5',
    inputTokens: 60,
    outputTokens: 40,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 100,
    costUSD: 0.01,
    pricingStatus: 'priced'
  },
  {
    usageDate: '2026-06-10',
    source: 'Claude Code',
    model: 'claude-opus-4-7',
    inputTokens: 20,
    outputTokens: 30,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 50,
    costUSD: 0.02,
    pricingStatus: 'priced'
  }
];

test('sessionModel falls back to pricingModel when API model is absent', () => {
  assert.equal(sessionModel(sessions[2]), 'gpt-5.3-codex');
});

test('filterSessionsByDashboardFilters applies model filters to session data', () => {
  const rows = filterSessionsByDashboardFilters(sessions, {
    startDate: '2026-06-09',
    endDate: '2026-06-10',
    sources: new Set(),
    devices: new Set(),
    models: new Set(['gpt-5.5'])
  });
  assert.deepEqual(rows.map(row => row.sessionId), ['codex-a']);
});

test('buildModelUsageRows aggregates token cost and session counts by model', () => {
  const rows = buildModelUsageRows(daily, sessions);
  const byModel = Object.fromEntries(rows.map(row => [row.model, row]));

  assert.equal(byModel['gpt-5.5'].totalTokens, 100);
  assert.equal(byModel['gpt-5.5'].sessionCount, 1);
  assert.equal(byModel['gpt-5.5'].dayCount, 1);
  assert.equal(byModel['gpt-5.5'].pricingStatus, '已定价');

  assert.equal(byModel['claude-opus-4-7'].totalTokens, 50);
  assert.equal(byModel['claude-opus-4-7'].sources[0], 'Claude Code');

  assert.equal(byModel['gpt-5.3-codex'].totalTokens, 30);
  assert.equal(byModel['gpt-5.3-codex'].sessionCount, 1);
});

test('money4 keeps ordinary amounts compact and shows tiny priced amounts', () => {
  assert.equal(U.money4(114.2414), '$114.24 / ¥822.54');
  assert.equal(U.money4(0.0005389338907760648), '$0.0005 / ¥0.0039');
});

test('unifies deepseek v4.1-flash spellings under the dominant raw name', () => {
  const dailyRows = [
    {
      usageDate: '2026-10-08', source: 'WorkBuddy', model: 'deepseek-v4.1-flash',
      pricingModel: 'deepseek-flash', totalTokens: 800_000, costUSD: 0.4,
      inputTokens: 480_000, outputTokens: 320_000, cacheReadTokens: 0, cacheCreationTokens: 0,
      cachedInputTokens: 0, reasoningOutputTokens: 0, pricingStatus: 'priced'
    },
    {
      usageDate: '2026-10-09', source: 'WorkBuddy', model: 'deepseek-v4.1-flash',
      pricingModel: 'deepseek-flash', totalTokens: 200_000, costUSD: 0.1,
      inputTokens: 120_000, outputTokens: 80_000, cacheReadTokens: 0, cacheCreationTokens: 0,
      cachedInputTokens: 0, reasoningOutputTokens: 0, pricingStatus: 'priced'
    },
    {
      usageDate: '2026-10-09', source: 'Claude Code', model: 'deepseek-v4-1-flash',
      pricingModel: 'deepseek-flash', totalTokens: 20_000, costUSD: 0.01,
      inputTokens: 12_000, outputTokens: 8_000, cacheReadTokens: 0, cacheCreationTokens: 0,
      cachedInputTokens: 0, reasoningOutputTokens: 0, pricingStatus: 'priced'
    },
    {
      // 单行 token 大于任何一行 v4.1-flash,但写法总量(500k)不及 v4.1-flash(1M)
      usageDate: '2026-10-09', source: 'DeepSeek Harness', model: 'deepseek-flash',
      pricingModel: 'deepseek-flash', totalTokens: 500_000, costUSD: 0.2,
      inputTokens: 300_000, outputTokens: 200_000, cacheReadTokens: 0, cacheCreationTokens: 0,
      cachedInputTokens: 0, reasoningOutputTokens: 0, pricingStatus: 'priced'
    },
    {
      usageDate: '2026-10-09', source: 'WorkBuddy', model: 'deepseek-v4-flash',
      pricingModel: 'deepseek-v4-flash', totalTokens: 7_000, costUSD: 0.001,
      inputTokens: 4_000, outputTokens: 3_000, cacheReadTokens: 0, cacheCreationTokens: 0,
      cachedInputTokens: 0, reasoningOutputTokens: 0, pricingStatus: 'priced'
    }
  ];
  const labeled = U.withModelLabels({ daily: dailyRows, sessions: [] });

  assert.deepEqual(
    labeled.daily.map(row => row.modelLabel),
    ['deepseek-v4.1-flash', 'deepseek-v4.1-flash', 'deepseek-v4.1-flash', 'deepseek-v4.1-flash', 'deepseek-v4-flash']
  );

  const filters = {
    startDate: '2026-10-08', endDate: '2026-10-09',
    sources: new Set(), devices: new Set(),
    models: new Set(['deepseek-v4.1-flash'])
  };
  assert.equal(U.filterDaily(labeled.daily, filters).length, 4);
  assert.equal(U.filterDaily(labeled.daily, { ...filters, models: new Set(['deepseek-v4-flash']) }).length, 1);

  const usageRows = buildModelUsageRows(labeled.daily, []);
  const byModel = Object.fromEntries(usageRows.map(row => [row.model, row]));
  assert.deepEqual(Object.keys(byModel), ['deepseek-v4.1-flash', 'deepseek-v4-flash']);
  assert.equal(byModel['deepseek-v4.1-flash'].totalTokens, 1_520_000);
  assert.equal(byModel['deepseek-v4.1-flash'].sources.length, 3);
});
