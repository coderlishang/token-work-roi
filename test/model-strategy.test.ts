import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildModelRowsFromSessions,
  buildModelStrategy,
  hasStrategyAnnotation
} from '../src/client/review/model-strategy.ts';

const sessions = [
  {
    sessionId: 'explore-heavy',
    model: 'gpt-5.5',
    taskType: '技术调研',
    workStage: '探索',
    valueLevel: '中',
    outputStatus: '进行中',
    totalTokens: 1000,
    costUSD: 10,
    pricingStatus: 'priced'
  },
  {
    sessionId: 'ship-light',
    model: 'deepseek-v4-pro',
    taskType: '功能开发',
    workStage: '发布',
    valueLevel: '关键',
    outputStatus: '已发布',
    totalTokens: 500,
    costUSD: 0.1,
    pricingStatus: 'priced'
  },
  {
    sessionId: 'waste-mid',
    model: 'claude-sonnet-4-6',
    taskType: '技术调研',
    workStage: '验证',
    valueLevel: '低',
    outputStatus: '已废弃',
    totalTokens: 400,
    costUSD: 2,
    pricingStatus: 'priced'
  },
  {
    sessionId: 'unlabeled',
    model: 'gpt-5.3-codex-spark',
    taskType: '未分类',
    workStage: '未说明',
    valueLevel: '未评估',
    outputStatus: '未标注',
    totalTokens: 300,
    costUSD: 0,
    pricingStatus: 'unpriced'
  }
];

test('hasStrategyAnnotation requires at least one strategy field', () => {
  assert.equal(hasStrategyAnnotation(sessions[0]), true);
  assert.equal(hasStrategyAnnotation(sessions[3]), false);
});

test('buildModelRowsFromSessions aggregates model usage and risk shares', () => {
  const rows = buildModelRowsFromSessions(sessions);
  const heavy = rows.find(row => row.model === 'gpt-5.5');
  const risky = rows.find(row => row.model === 'claude-sonnet-4-6');

  assert.equal(rows[0].model, 'gpt-5.5');
  assert.equal(heavy.tier, 'heavy');
  assert.equal(heavy.totalTokens, 1000);
  assert.equal(risky.riskShare, 1);
});

test('buildModelStrategy groups by task stage and value', () => {
  const strategy = buildModelStrategy({ sessions });

  assert.equal(strategy.coverage.sessionCount, 4);
  assert.equal(strategy.coverage.annotatedSessionCount, 3);
  assert.equal(strategy.byTaskType[0].key, '技术调研');
  assert.equal(strategy.byTaskType[0].topModel, 'gpt-5.5');
  assert.equal(strategy.byStage.some(row => row.key === '发布'), true);
  assert.equal(strategy.byValue.some(row => row.key === '关键'), true);
});

test('buildModelStrategy builds a light mid heavy model playbook from annotations', () => {
  const strategy = buildModelStrategy({ sessions });

  assert.equal(strategy.playbook.length, 3);
  const light = strategy.playbook.find(row => row.id === 'light-default');
  const mid = strategy.playbook.find(row => row.id === 'mid-implementation');
  const heavy = strategy.playbook.find(row => row.id === 'heavy-review');

  assert.equal(light.label, '轻量默认');
  assert.equal(light.evidenceState, '待确认草稿');
  assert.equal(light.sessionCount, 2);
  assert.equal(light.topModel, 'gpt-5.5');
  assert.equal(mid.label, '中模型实现');
  assert.equal(mid.sessionCount, 1);
  assert.equal(heavy.label, '重模型审查');
  assert.equal(heavy.sessionCount, 1);
  assert.match(heavy.action, /关键发布/);
});

test('buildModelStrategy labels manual and auto evidence provenance', () => {
  const strategy = buildModelStrategy({
    sessions: [
      { ...sessions[0], annotationSource: 'auto', annotationConfidence: 88 },
      { ...sessions[1], annotationSource: 'manual', annotationConfidence: 100 }
    ]
  });
  const light = strategy.playbook.find(row => row.id === 'light-default');
  const heavy = strategy.playbook.find(row => row.id === 'heavy-review');

  assert.equal(light.evidenceState, '自动高置信');
  assert.equal(heavy.evidenceState, '人工确认');
  assert.equal(heavy.evidenceBreakdown.manual, 1);
});

test('buildModelStrategy emits model policy recommendations', () => {
  const strategy = buildModelStrategy({ sessions });
  const ids = strategy.recommendations.map(item => item.id);

  assert.equal(ids.includes('light-model-for-exploration'), true);
  assert.equal(ids.includes('keep-high-value-pattern'), true);
  assert.equal(ids.some(id => id.startsWith('risk-claude-sonnet')), true);
});

test('buildModelStrategy asks for labels when coverage is low', () => {
  const strategy = buildModelStrategy({ sessions: [sessions[3], { ...sessions[3], sessionId: 'u2' }] });
  assert.equal(strategy.coverage.annotatedSessionCount, 0);
  assert.equal(strategy.playbook[0].evidenceState, '待标注验证');
  assert.equal(strategy.recommendations[0].id, 'label-before-model-policy');
});

test('buildModelRowsFromSessions merges same-model spellings via modelLabel', () => {
  const rows = buildModelRowsFromSessions([
    { sessionId: 'a', model: 'deepseek-v4.1-flash', modelLabel: 'deepseek-v4.1-flash', totalTokens: 300, costUSD: 0.1, pricingStatus: 'priced', outputStatus: '已发布', valueLevel: '关键' },
    { sessionId: 'b', model: 'deepseek-flash', modelLabel: 'deepseek-v4.1-flash', totalTokens: 200, costUSD: 0.1, pricingStatus: 'priced', outputStatus: '已发布', valueLevel: '关键' },
    { sessionId: 'c', model: 'DeepSeek-V4.1-Flash', modelLabel: 'deepseek-v4.1-flash', totalTokens: 100, costUSD: 0.1, pricingStatus: 'priced', outputStatus: '已发布', valueLevel: '关键' }
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, 'deepseek-v4.1-flash');
  assert.equal(rows[0].sessionCount, 3);
  assert.equal(rows[0].totalTokens, 600);
});

test('topModelFor merges same-model spellings via modelLabel', async () => {
  const { RU } = await import('../src/client/review/utils.ts');
  const top = RU.topModelFor([
    { model: 'deepseek-flash', modelLabel: 'deepseek-v4.1-flash', totalTokens: 100 },
    { model: 'deepseek-v4.1-flash', modelLabel: 'deepseek-v4.1-flash', totalTokens: 50 }
  ], () => true);

  assert.equal(top, 'deepseek-v4.1-flash');
});
