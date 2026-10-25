import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRoiAdvisor,
  isRoiUnattributed,
  modelTier
} from '../src/client/review/roi-advisor.ts';

test('modelTier classifies heavy, mid, light and unpriced models', () => {
  assert.equal(modelTier('gpt-6-astra-20260903', 'priced'), 'heavy');
  assert.equal(modelTier('gpt-6-astral', 'priced'), 'unknown');
  assert.equal(modelTier('gpt-5.5', 'priced'), 'heavy');
  assert.equal(modelTier('claude-fable-5', 'priced'), 'heavy');
  assert.equal(modelTier('claude-mythos-5', 'priced'), 'heavy');
  assert.equal(modelTier('claude-opus-4-7', 'priced'), 'heavy');
  assert.equal(modelTier('grok-4.5', 'priced'), 'mid');
  assert.equal(modelTier('gpt-5.3-codex', 'priced'), 'mid');
  assert.equal(modelTier('claude-sonnet-4-6', 'priced'), 'mid');
  assert.equal(modelTier('deepseek-v4-pro', 'priced'), 'light');
  assert.equal(modelTier('mimo-v2.5-pro', 'priced'), 'light');
  assert.equal(modelTier('kimi-k2.7-code', 'priced'), 'mid');
  assert.equal(modelTier('kimi-k2-7-code', 'priced'), 'mid');
  assert.equal(modelTier('kimi-k2.5', 'priced'), 'light');
  assert.equal(modelTier('kimi-k2-5', 'priced'), 'light');
  assert.equal(modelTier('kimi-k3.1-pro', 'priced'), 'mid');
  assert.equal(modelTier('kimi-k3-1-pro-highspeed', 'priced'), 'mid');
  assert.equal(modelTier('gpt-5.3-codex-spark', 'unpriced'), 'unpriced');
  assert.equal(modelTier('<synthetic>', ''), 'unpriced');
});

test('isRoiUnattributed requires purpose and value, not just task status', () => {
  assert.equal(isRoiUnattributed({
    taskType: '功能开发',
    outputStatus: '已完成',
    workPurpose: '功能开发',
    workStage: '实现',
    valueLevel: '高'
  }), false);
  assert.equal(isRoiUnattributed({
    taskType: '功能开发',
    outputStatus: '已完成',
    workPurpose: '未说明',
    workStage: '实现',
    valueLevel: '高'
  }), true);
  assert.equal(isRoiUnattributed({
    taskType: '功能开发',
    outputStatus: '已完成',
    workPurpose: '功能开发',
    workStage: '未说明',
    valueLevel: '高'
  }), true);
});

test('advisor prioritizes high cost unattributed work', () => {
  const suggestions = buildRoiAdvisor({
    sessions: [{
      sessionId: 's1',
      projectPath: 'D:\\AIResume',
      model: 'gpt-5.5',
      taskType: '未分类',
      outputStatus: '未标注',
      workPurpose: '未说明',
      valueLevel: '未评估',
      inputTokens: 800_000,
      outputTokens: 40_000,
      cacheReadTokens: 0,
      totalTokens: 1_000_000,
      costUSD: 20,
      pricingStatus: 'priced'
    }]
  });

  assert.equal(suggestions[0].id, 'attribute-high-cost-work');
  assert.equal(suggestions[0].category, '补标注');
  assert.equal(suggestions[0].impact, '高');
  assert.match(suggestions[0].recommendation, /主要目的/);
});

test('advisor recommends light models for testing and exploration on heavy models', () => {
  const suggestions = buildRoiAdvisor({
    sessions: [{
      sessionId: 's1',
      model: 'claude-opus-4-7',
      taskType: '问题修复',
      outputStatus: '进行中',
      workPurpose: '测试验证',
      workStage: '验证',
      valueLevel: '中',
      inputTokens: 100_000,
      outputTokens: 20_000,
      cacheReadTokens: 0,
      totalTokens: 120_000,
      costUSD: 5,
      pricingStatus: 'priced'
    }]
  });

  const suggestion = suggestions.find(item => item.id === 'use-light-model-for-exploration');
  assert.ok(suggestion);
  assert.equal(suggestion.category, '模型切换');
});

test('advisor flags discarded or low value high cost work as stop-loss risk', () => {
  const suggestions = buildRoiAdvisor({
    sessions: [{
      sessionId: 's1',
      model: 'gpt-5.5',
      taskType: '技术调研',
      outputStatus: '已废弃',
      workPurpose: '技术调研',
      workStage: '探索',
      valueLevel: '低',
      inputTokens: 400_000,
      outputTokens: 20_000,
      cacheReadTokens: 0,
      totalTokens: 500_000,
      costUSD: 15,
      pricingStatus: 'priced'
    }]
  });

  const suggestion = suggestions.find(item => item.id === 'stop-loss-low-value-work');
  assert.ok(suggestion);
  assert.equal(suggestion.category, '止损');
});

test('advisor preserves high value completed work on light or mid models', () => {
  const suggestions = buildRoiAdvisor({
    sessions: [{
      sessionId: 's1',
      model: 'deepseek-v4-pro',
      taskType: '功能开发',
      outputStatus: '已发布',
      workPurpose: '功能开发',
      workStage: '发布',
      valueLevel: '关键',
      inputTokens: 100_000,
      outputTokens: 50_000,
      cacheReadTokens: 10_000,
      totalTokens: 160_000,
      costUSD: 0.2,
      pricingStatus: 'priced'
    }]
  });

  const suggestion = suggestions.find(item => item.id === 'keep-high-value-low-cost-pattern');
  assert.ok(suggestion);
  assert.equal(suggestion.category, '保留策略');
});

test('advisor does not preserve high value work when the session is still high cost', () => {
  const suggestions = buildRoiAdvisor({
    sessions: [{
      sessionId: 's1',
      model: 'claude-sonnet-4-6',
      taskType: '功能开发',
      outputStatus: '已发布',
      workPurpose: '功能开发',
      workStage: '发布',
      valueLevel: '关键',
      inputTokens: 900_000,
      outputTokens: 100_000,
      cacheReadTokens: 0,
      totalTokens: 1_000_000,
      costUSD: 20,
      pricingStatus: 'priced'
    }]
  });

  assert.equal(suggestions.some(item => item.id === 'keep-high-value-low-cost-pattern'), false);
});

test('advisor emits context compression and unpriced model advice without fake cost', () => {
  const suggestions = buildRoiAdvisor({
    sessions: [{
      sessionId: 's1',
      model: 'gpt-5.3-codex-spark',
      taskType: '功能开发',
      outputStatus: '已完成',
      workPurpose: '功能开发',
      workStage: '实现',
      valueLevel: '中',
      inputTokens: 900_000,
      outputTokens: 50_000,
      cacheReadTokens: 0,
      totalTokens: 1_000_000,
      costUSD: 0,
      pricingStatus: 'unpriced'
    }]
  });

  assert.equal(suggestions.some(item => item.id === 'reduce-context-bloat'), true);
  assert.equal(suggestions.find(item => item.id === 'reduce-context-bloat')?.category, '上下文压缩');
  const unpriced = suggestions.find(item => item.id === 'keep-unpriced-models-out-of-cost-decisions');
  assert.ok(unpriced);
  assert.equal(unpriced.category, '未定价模型');
  assert.match(unpriced.recommendation, /不把 \$0 当成免费/);
});

test('advisor does not treat high input/output with healthy cache reuse as context waste', () => {
  const suggestions = buildRoiAdvisor({
    sessions: [{
      sessionId: 'cached-session',
      model: 'gpt-5.6-sol',
      taskType: '功能开发',
      outputStatus: '已完成',
      workPurpose: '功能开发',
      workStage: '实现',
      valueLevel: '中',
      inputTokens: 900_000,
      outputTokens: 50_000,
      cacheReadTokens: 18_000_000,
      totalTokens: 18_950_000,
      costUSD: 20,
      pricingStatus: 'priced'
    }]
  });

  assert.equal(suggestions.some(item => item.id === 'reduce-context-bloat'), false);
  assert.equal(suggestions.some(item => item.id === 'improve-cache-and-task-continuity'), false);
});
