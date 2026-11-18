import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEfficiencyGuidance } from '../src/client/review/efficiency-guidance.ts';
import { buildEvidenceZeroState, buildSavingsEmptyReason } from '../src/client/review/review-empty-states.ts';
import { buildReviewTrustState } from '../src/client/review/review-trust.ts';
import { RU } from '../src/client/review/utils.ts';

test('review trust state labels verified event-level data as real', () => {
  const state = buildReviewTrustState({
    demoMode: false,
    dataMode: { id: 'real-event-verified' },
    runtime: {
      counts: { sessionRows: 12, tokenEventRows: 99 },
      dataMode: { id: 'real-event-verified' },
      coverageGate: { status: 'passed' },
      latestCollectionRun: { source: 'Codex CLI', status: 'ok', message: 'token_events=99' }
    }
  });

  assert.equal(state.id, 'real-event-verified');
  assert.equal(state.trusted, true);
  assert.match(state.summary, /真实|event|官方公开价/);
});

test('review trust state catches demo, aggregate-only and old service states', () => {
  assert.equal(buildReviewTrustState({ demoMode: true }).id, 'demo');
  assert.equal(buildReviewTrustState({
    dataMode: { id: 'real-aggregate-only' },
    runtime: { counts: { sessionRows: 3, tokenEventRows: 0 }, dataMode: { id: 'real-aggregate-only' } }
  }).id, 'real-aggregate-only');
  assert.equal(buildReviewTrustState({ dataMode: { id: 'real-event-verified' } }).id, 'old-service');
});

test('evidence zero state explains attribution gaps instead of treating tokens as fake', () => {
  const state = buildEvidenceZeroState({
    evidenceScore: 0,
    sessionCount: 10,
    manualConfirmed: 0,
    withOutput: 0,
    complete: 0
  }, {
    sessionCount: 10
  });

  assert.equal(state.isZero, true);
  assert.match(state.summary, /缺的是归因和产出证据/);
  assert.ok(state.missing.some(item => item.includes('人工确认')));
});

test('savings empty reason distinguishes missing labels, unpriced models and protected work', () => {
  const reason = buildSavingsEmptyReason({
    simulation: { suggestions: [], unpriced: { sessionCount: 1 } },
    sessions: [
      {
        taskType: '未分类',
        workPurpose: '未说明',
        workStage: '未说明',
        valueLevel: '未评估',
        outputStatus: '未标注'
      },
      {
        taskType: '功能开发',
        workPurpose: '功能开发',
        workStage: '发布',
        valueLevel: '高',
        outputStatus: '已发布'
      }
    ]
  });

  assert.match(reason.reasons.join('\n'), /未公开官方美元价/);
  assert.match(reason.reasons.join('\n'), /被保护/);
});

test('efficiency guidance covers cache, input/output and missing reasoning ranges', () => {
  const low = buildEfficiencyGuidance({
    cacheReuseRate: 0,
    inputOutputRatio: 35,
    reasoningShare: 0,
    hasReasoningTokens: false
  });
  assert.equal(low.cache.label, '无复用');
  assert.equal(low.io.label, '高风险浪费');
  assert.equal(low.reasoning.label, '未记录');

  const high = buildEfficiencyGuidance({
    cacheReuseRate: 95,
    inputOutputRatio: 5,
    reasoningShare: 12,
    hasReasoningTokens: true
  });
  assert.equal(high.cache.label, '很高');
  assert.equal(high.io.label, '健康');
  assert.equal(high.reasoning.label, '深度推理');

  const highReuseInput = buildEfficiencyGuidance({
    cacheReuseRate: 95,
    inputOutputRatio: 35,
    reasoningShare: 0,
    hasReasoningTokens: true
  });
  assert.equal(highReuseInput.io.label, '缓存复用良好');
});

test('sessions without lastActivity only join the all period', () => {
  const stub = { sessionId: 'stub', source: 'Codex CLI', lastActivity: null, totalTokens: 5 };
  const period = { id: '7d', start: '2026-11-12', end: '2026-11-18', startDateTime: '', endDateTime: '' };
  assert.deepEqual(RU.filterSessionsByPeriod([stub], period), []);
  assert.equal(RU.filterSessionsByPeriod([stub], { ...period, id: 'all' }).length, 1);
});
