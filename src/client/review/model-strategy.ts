import { modelTier } from './roi-advisor.ts';
import type { UsageRow } from '../shared/types.ts';

const DEFAULT_TASK_TYPE = '未分类';
const DEFAULT_WORK_PURPOSE = '未说明';
const DEFAULT_WORK_STAGE = '未说明';
const DEFAULT_VALUE_LEVEL = '未评估';
const PRODUCTIVE_STATUSES = new Set(['已完成', '已发布']);
const EXPLORATION_TASKS = new Set(['技术调研', '测试验证']);
const EXPLORATION_PURPOSES = new Set(['需求澄清', '测试验证', '技术调研', '上下文整理']);
const EXPLORATION_STAGES = new Set(['探索', '验证']);
const IMPLEMENTATION_TASKS = new Set(['功能开发', '问题修复']);
const IMPLEMENTATION_PURPOSES = new Set(['功能开发', '调试修复']);
const IMPLEMENTATION_STAGES = new Set(['实现', '维护']);
const REVIEW_TASKS = new Set(['代码审查']);
const REVIEW_PURPOSES = new Set(['代码审查', '部署运维']);
const REVIEW_STAGES = new Set(['发布']);
const HIGH_VALUE_LEVELS = new Set(['高', '关键']);
const LOW_VALUE_LEVELS = new Set(['低']);

export function buildModelStrategy({ sessions = [] }: { sessions?: UsageRow[] } = {}) {
  const annotated = sessions.filter(hasStrategyAnnotation);
  const total = aggregateSessions(sessions);
  const annotatedTotal = aggregateSessions(annotated);
  const modelRows = buildModelRowsFromSessions(sessions);

  return {
    coverage: {
      sessionCount: sessions.length,
      annotatedSessionCount: annotated.length,
      annotatedShare: sessions.length ? annotated.length / sessions.length : 0,
      totalTokens: total.totalTokens,
      annotatedTokens: annotatedTotal.totalTokens,
      annotatedTokenShare: total.totalTokens ? annotatedTotal.totalTokens / total.totalTokens : 0
    },
    byTaskType: buildDimensionRows(annotated, 'taskType', DEFAULT_TASK_TYPE),
    byStage: buildDimensionRows(annotated, 'workStage', DEFAULT_WORK_STAGE),
    byValue: buildDimensionRows(annotated, 'valueLevel', DEFAULT_VALUE_LEVEL),
    playbook: buildModelPolicyRows(annotated),
    riskModels: buildRiskModelRows(annotated),
    modelRows,
    recommendations: buildStrategyRecommendations({ sessions, annotated, modelRows })
  };
}

export function hasStrategyAnnotation(session: UsageRow = {}) {
  return (session.taskType || DEFAULT_TASK_TYPE) !== DEFAULT_TASK_TYPE
    || (session.workPurpose || DEFAULT_WORK_PURPOSE) !== DEFAULT_WORK_PURPOSE
    || (session.workStage || DEFAULT_WORK_STAGE) !== DEFAULT_WORK_STAGE
    || (session.valueLevel || DEFAULT_VALUE_LEVEL) !== DEFAULT_VALUE_LEVEL;
}

export function buildModelRowsFromSessions(sessions: UsageRow[] = []) {
  const rows = new Map();
  const totalTokens = sessions.reduce((sum, session) => sum + (session.totalTokens || 0), 0);
  for (const session of sessions) {
    // 同一模型多种写法归并到 modelLabel,避免同模型拆成多行
    const model = session.modelLabel || session.model || session.pricingModel || '<unknown>';
    if (!rows.has(model)) {
      rows.set(model, {
        model,
        tier: modelTier(model, session.pricingStatus),
        sessionCount: 0,
        totalTokens: 0,
        costUSD: 0,
        productiveTokens: 0,
        riskTokens: 0,
        discardedTokens: 0,
        highValueTokens: 0,
        lowValueTokens: 0
      });
    }
    const row = rows.get(model);
    const tokens = session.totalTokens || 0;
    row.sessionCount += 1;
    row.totalTokens += tokens;
    row.costUSD += session.costUSD || 0;
    if (PRODUCTIVE_STATUSES.has(session.outputStatus)) row.productiveTokens += tokens;
    if (session.outputStatus === '已废弃' || LOW_VALUE_LEVELS.has(session.valueLevel)) row.riskTokens += tokens;
    if (session.outputStatus === '已废弃') row.discardedTokens += tokens;
    if (HIGH_VALUE_LEVELS.has(session.valueLevel)) row.highValueTokens += tokens;
    if (LOW_VALUE_LEVELS.has(session.valueLevel)) row.lowValueTokens += tokens;
  }
  return Array.from(rows.values())
    .map(row => ({
      ...row,
      share: totalTokens ? row.totalTokens / totalTokens : 0,
      productiveShare: row.totalTokens ? row.productiveTokens / row.totalTokens : 0,
      riskShare: row.totalTokens ? row.riskTokens / row.totalTokens : 0
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

function buildDimensionRows(sessions, field, defaultValue) {
  const rows = new Map();
  for (const session of sessions) {
    const key = session[field] || defaultValue;
    if (key === defaultValue) continue;
    if (!rows.has(key)) {
      rows.set(key, {
        key,
        sessionCount: 0,
        totalTokens: 0,
        costUSD: 0,
        models: new Map()
      });
    }
    const row = rows.get(key);
    const model = session.modelLabel || session.model || session.pricingModel || '<unknown>';
    const tokens = session.totalTokens || 0;
    row.sessionCount += 1;
    row.totalTokens += tokens;
    row.costUSD += session.costUSD || 0;
    row.models.set(model, (row.models.get(model) || 0) + tokens);
  }
  return Array.from(rows.values())
    .map(row => ({
      ...row,
      topModel: topModel(row.models),
      models: Array.from(row.models.entries()).sort((a, b) => b[1] - a[1])
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

function buildRiskModelRows(sessions) {
  return buildModelRowsFromSessions(sessions.filter(session =>
    session.outputStatus === '已废弃' || LOW_VALUE_LEVELS.has(session.valueLevel)
  )).slice(0, 5);
}

function buildModelPolicyRows(sessions) {
  return [
    {
      id: 'light-default',
      label: '轻量默认',
      title: '测试验证、探索和上下文整理',
      targetTier: 'light',
      action: '默认用 Haiku、Gemini Flash、DeepSeek、MiMo 或 Kimi K2.5 快速试错，方向确认后再升级。',
      sessions: sessions.filter(isLightPolicyWork)
    },
    {
      id: 'mid-implementation',
      label: '中模型实现',
      title: '功能开发、调试修复和维护实现',
      targetTier: 'mid',
      action: '复杂实现和调试默认用 Sonnet、Gemini Pro、Codex 或 Kimi Code 中模型，兼顾上下文理解和成本。',
      sessions: sessions.filter(isMidPolicyWork)
    },
    {
      id: 'heavy-review',
      label: '重模型审查',
      title: '关键价值、代码审查和发布前确认',
      targetTier: 'heavy',
      action: '只在关键发布、复杂审查或高价值收口时使用 Opus / GPT 重模型。',
      sessions: sessions.filter(isHeavyPolicyWork)
    }
  ].map(({ sessions: matching, ...row }) => {
    const aggregate = aggregateSessions(matching);
    const modelRows = buildModelRowsFromSessions(matching);
    const top = modelRows[0];
    return {
      ...row,
      sessionCount: aggregate.sessionCount,
      totalTokens: aggregate.totalTokens,
      costUSD: aggregate.costUSD,
      topModel: top?.model || '待标注验证',
      observedTier: top?.tier || 'unknown',
      evidenceState: modelEvidenceState(matching),
      evidenceBreakdown: modelEvidenceBreakdown(matching)
    };
  });
}

function modelEvidenceState(sessions: UsageRow[] = []) {
  if (!sessions.length) return '待标注验证';
  const breakdown = modelEvidenceBreakdown(sessions);
  if (breakdown.manual >= Math.ceil(sessions.length / 2)) return '人工确认';
  if (breakdown.autoHigh >= Math.ceil(sessions.length / 2)) return '自动高置信';
  if (breakdown.autoLow > 0 || breakdown.draft > 0) return '待确认草稿';
  return '缺证据';
}

function modelEvidenceBreakdown(sessions: UsageRow[] = []) {
  return sessions.reduce<{ manual: number; autoHigh: number; autoLow: number; draft: number }>((acc, session) => {
    if (session.annotationSource === 'manual' || session.annotationSource === 'imported') acc.manual += 1;
    else if (session.annotationSource === 'auto' && Number(session.annotationConfidence || 0) >= 80) acc.autoHigh += 1;
    else if (session.annotationSource === 'auto') acc.autoLow += 1;
    else acc.draft += 1;
    return acc;
  }, { manual: 0, autoHigh: 0, autoLow: 0, draft: 0 });
}

function isLightPolicyWork(session: UsageRow = {}) {
  return EXPLORATION_TASKS.has(session.taskType)
    || EXPLORATION_PURPOSES.has(session.workPurpose)
    || EXPLORATION_STAGES.has(session.workStage);
}

function isMidPolicyWork(session: UsageRow = {}) {
  return IMPLEMENTATION_TASKS.has(session.taskType)
    || IMPLEMENTATION_PURPOSES.has(session.workPurpose)
    || IMPLEMENTATION_STAGES.has(session.workStage);
}

function isHeavyPolicyWork(session: UsageRow = {}) {
  return REVIEW_TASKS.has(session.taskType)
    || REVIEW_PURPOSES.has(session.workPurpose)
    || REVIEW_STAGES.has(session.workStage)
    || HIGH_VALUE_LEVELS.has(session.valueLevel);
}

function buildStrategyRecommendations({ sessions, annotated, modelRows }) {
  const recommendations = [];
  const coverage = sessions.length ? annotated.length / sessions.length : 0;
  if (sessions.length && coverage < 0.5) {
    recommendations.push({
      id: 'label-before-model-policy',
      title: '先补齐标注再固化模型策略',
      detail: `当前只有 ${(coverage * 100).toFixed(0)}% session 有任务、阶段或价值标注，模型策略结论还不够稳。`,
      action: '优先标注最高成本的 10 个 session，再观察不同任务和阶段的模型表现。'
    });
  }

  const heavyExploration = annotated.filter(session => {
    const tier = modelTier(session.model || session.pricingModel, session.pricingStatus);
    return tier === 'heavy'
      && (EXPLORATION_TASKS.has(session.taskType) || EXPLORATION_STAGES.has(session.workStage));
  });
  if (heavyExploration.length) {
    const agg = aggregateSessions(heavyExploration);
    recommendations.push({
      id: 'light-model-for-exploration',
      title: '探索和验证默认用轻量模型',
      detail: `${heavyExploration.length} 个探索/验证 session 使用了重模型，合计 ${compactCN(agg.totalTokens)} tokens。`,
      action: '测试验证、上下文整理、技术调研先用 Haiku、Gemini Flash、DeepSeek、MiMo 或 Kimi K2.5，进入复杂实现再升级。'
    });
  }

  const reusable = annotated.filter(session => {
    const tier = modelTier(session.model || session.pricingModel, session.pricingStatus);
    return PRODUCTIVE_STATUSES.has(session.outputStatus)
      && HIGH_VALUE_LEVELS.has(session.valueLevel)
      && ['light', 'mid'].includes(tier);
  });
  if (reusable.length) {
    const models = Array.from(new Set(reusable.map(session => session.modelLabel || session.model || session.pricingModel).filter(Boolean))).slice(0, 3);
    recommendations.push({
      id: 'keep-high-value-pattern',
      title: '保留高价值低成本模型组合',
      detail: `${reusable.length} 个高价值完成/发布 session 使用中轻量模型完成，代表可复用模式。`,
      action: `相似任务优先复用 ${models.join('、') || '当前中轻量模型'}，重模型留给关键审查和复杂调试。`
    });
  }

  const risky = modelRows.filter(row => row.riskShare > 0.2 && row.totalTokens > 0).slice(0, 2);
  for (const row of risky) {
    recommendations.push({
      id: `risk-${row.model}`,
      title: `${row.model} 的低价值/废弃占比较高`,
      detail: `${row.model} 有 ${(row.riskShare * 100).toFixed(0)}% tokens 落在低价值或废弃任务上。`,
      action: '后续同类任务先设 token 止损线，用轻量模型验证方向后再升级。'
    });
  }

  return recommendations.slice(0, 5);
}

function aggregateSessions(sessions: UsageRow[] = []) {
  return sessions.reduce<{ sessionCount: number; totalTokens: number; costUSD: number }>((acc, session) => {
    acc.sessionCount += 1;
    acc.totalTokens += session.totalTokens || 0;
    acc.costUSD += session.costUSD || 0;
    return acc;
  }, { sessionCount: 0, totalTokens: 0, costUSD: 0 });
}

function topModel(models) {
  let best = '—';
  let bestTokens = -1;
  for (const [model, tokens] of models) {
    if (tokens > bestTokens) {
      best = model;
      bestTokens = tokens;
    }
  }
  return best;
}

function compactCN(value) {
  const v = Number(value || 0);
  const abs = Math.abs(v);
  if (abs >= 1e8) return `${(v / 1e8).toFixed(2).replace(/\.?0+$/, '')} 亿`;
  if (abs >= 1e4) return `${(v / 1e4).toFixed(1).replace(/\.0$/, '')} 万`;
  return String(Math.round(v));
}
