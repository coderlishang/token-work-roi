import { U } from '../shared/utils.ts';
import type { UsageRow } from '../shared/types.ts';

const DEFAULT_TASK_TYPE = '未分类';
const DEFAULT_OUTPUT_STATUS = '未标注';
const DEFAULT_WORK_PURPOSE = '未说明';
const DEFAULT_WORK_STAGE = '未说明';
const DEFAULT_VALUE_LEVEL = '未评估';

const HEAVY_MODEL_PATTERNS = [/(?:^|[/:\s])gpt-6-astra(?:$|[-:])/i, /^gpt-6-sol/i, /^gpt-6[.-]1-sol/i, /^gpt-5\.6-sol/i, /^gpt-5\.5/i, /claude-(?:mythos|fable)/i, /claude-opus/i, /gemini-2\.5-pro-long-context/i];
const MID_MODEL_PATTERNS = [/^gpt-5\.6-terra/i, /^gpt-6[.-]1-terra/i, /^grok-4[.-]5/i, /^gpt-5\.3-codex$/i, /claude-sonnet/i, /gemini-2\.5-pro/i, /kimi-k2[.-][67]/i, /kimi-k3[.-]1/i];
const LIGHT_MODEL_PATTERNS = [/^gpt-5\.6-luna$/i, /^gpt-6-luna/i, /claude-haiku/i, /deepseek/i, /mimo/i, /gemini-2\.5-flash/i, /kimi-k2[.-]5/i];
const EXPLORATION_PURPOSES = new Set(['测试验证', '上下文整理']);
const EXPLORATION_STAGES = new Set(['探索', '验证']);
const PRODUCTIVE_STATUSES = new Set(['已完成', '已发布']);
const LOW_VALUE_LEVELS = new Set(['低']);
const HIGH_VALUE_LEVELS = new Set(['高', '关键']);
const HEALTHY_CACHE_HIT_RATE = 70;

export function buildRoiAdvisor({ sessions = [], daily = [] }: { sessions?: UsageRow[]; daily?: UsageRow[] } = {}) {
  const total = aggregateRows(sessions.length ? sessions : daily);
  const suggestions = [
    buildAttributionSuggestion(sessions, total),
    buildHeavyModelExplorationSuggestion(sessions, total),
    buildWasteSuggestion(sessions, total),
    buildHighValueKeepSuggestion(sessions, total),
    buildInputRatioSuggestion(sessions, daily),
    buildCacheSuggestion(sessions, daily),
    buildUnpricedSuggestion(sessions, daily, total)
  ].filter(Boolean);

  return suggestions
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ score, ...suggestion }) => suggestion);
}

export function modelTier(model, pricingStatus = '') {
  const name = String(model || '').trim();
  if (!name || name === '<synthetic>' || pricingStatus === 'unpriced') return 'unpriced';
  if (HEAVY_MODEL_PATTERNS.some(pattern => pattern.test(name))) return 'heavy';
  if (MID_MODEL_PATTERNS.some(pattern => pattern.test(name))) return 'mid';
  if (LIGHT_MODEL_PATTERNS.some(pattern => pattern.test(name))) return 'light';
  return 'unknown';
}

export function isRoiUnattributed(session: UsageRow = {}) {
  return (session.taskType || DEFAULT_TASK_TYPE) === DEFAULT_TASK_TYPE
    || (session.outputStatus || DEFAULT_OUTPUT_STATUS) === DEFAULT_OUTPUT_STATUS
    || (session.workPurpose || DEFAULT_WORK_PURPOSE) === DEFAULT_WORK_PURPOSE
    || (session.workStage || DEFAULT_WORK_STAGE) === DEFAULT_WORK_STAGE
    || (session.valueLevel || DEFAULT_VALUE_LEVEL) === DEFAULT_VALUE_LEVEL;
}

function buildAttributionSuggestion(sessions, total) {
  const rows = sessions.filter(isRoiUnattributed)
    .sort(compareCostThenTokens);
  if (!rows.length) return null;
  const aggregate = aggregateRows(rows);
  const top = rows[0];
  return suggestion({
    id: 'attribute-high-cost-work',
    category: '补标注',
    impact: '高',
    tone: 'risk',
    title: '先补齐高成本 session 的用途和价值',
    recommendation: '把当前最高成本的未归因 session 标上主要目的、工作阶段和产出价值。',
    reason: '没有用途和价值字段时，系统只能知道花了多少 token，无法判断这笔投入是否值得继续。',
    evidence: withAttributionEvidence(`${rows.length} 个 session 仍缺少任务/状态/目的/阶段/价值标注，占本期 ${pct(aggregate.totalTokens, total.totalTokens)} tokens；最高一条是 ${labelSession(top)}，官方价 ${money(top.costUSD)}。`, rows),
    action: '在看板按模型或项目筛选后使用“批量归因当前筛选”，先处理 token 最高的前 5 条。',
    score: 100 + shareScore(aggregate.totalTokens, total.totalTokens)
  });
}

function buildHeavyModelExplorationSuggestion(sessions, total) {
  const rows = sessions.filter(session => {
    const tier = modelTier(session.model || session.pricingModel, session.pricingStatus);
    return tier === 'heavy'
      && (EXPLORATION_PURPOSES.has(session.workPurpose) || EXPLORATION_STAGES.has(session.workStage));
  }).sort(compareCostThenTokens);
  if (!rows.length) return null;
  const aggregate = aggregateRows(rows);
  return suggestion({
    id: 'use-light-model-for-exploration',
    category: '模型切换',
    impact: aggregate.costUSD > total.costUSD * 0.1 ? '高' : '中',
    tone: 'optimize',
    title: '测试和探索阶段优先改用轻量模型',
    recommendation: '把测试验证、上下文整理和探索阶段默认切到 Haiku、Gemini Flash、DeepSeek、MiMo 或 Kimi K2.5，确认方向后再升级到重模型。',
    reason: '这些任务通常需要快速试错，不需要一开始就使用最高单价模型。',
    evidence: withAttributionEvidence(`${rows.length} 个探索/验证类 session 使用了重模型，合计 ${compact(aggregate.totalTokens)} tokens、官方价 ${money(aggregate.costUSD)}。`, rows),
    action: '把这类任务的默认模型改成轻量模型；只有进入实现收口、复杂调试或发布前审查时再切回重模型。',
    score: 88 + shareScore(aggregate.costUSD, total.costUSD)
  });
}

function buildWasteSuggestion(sessions, total) {
  const rows = sessions.filter(session =>
    session.outputStatus === '已废弃' || LOW_VALUE_LEVELS.has(session.valueLevel)
  ).sort(compareCostThenTokens);
  if (!rows.length) return null;
  const aggregate = aggregateRows(rows);
  return suggestion({
    id: 'stop-loss-low-value-work',
    category: '止损',
    impact: aggregate.costUSD > total.costUSD * 0.15 ? '高' : '中',
    tone: 'risk',
    title: '低价值或废弃任务要先轻量试错',
    recommendation: '对低价值和可能废弃的方向设置 token 止损线，先用轻量模型验证可行性。',
    reason: '这类投入即使完成，也不一定转化为长期产出；重模型成本应该留给高价值实现和审查。',
    evidence: withAttributionEvidence(`${rows.length} 个低价值/废弃 session 合计 ${compact(aggregate.totalTokens)} tokens、官方价 ${money(aggregate.costUSD)}。`, rows),
    action: '后续同类任务先用轻量模型做 1-2 轮方案验证，再决定是否进入实现阶段。',
    score: 82 + shareScore(aggregate.costUSD, total.costUSD)
  });
}

function buildHighValueKeepSuggestion(sessions, total) {
  const rows = sessions.filter(session => {
    const tier = modelTier(session.model || session.pricingModel, session.pricingStatus);
    return HIGH_VALUE_LEVELS.has(session.valueLevel)
      && PRODUCTIVE_STATUSES.has(session.outputStatus)
      && isLowCostSession(session, total)
      && ['light', 'mid'].includes(tier);
  }).sort(compareCostThenTokens);
  if (!rows.length) return null;
  const aggregate = aggregateRows(rows);
  return suggestion({
    id: 'keep-high-value-low-cost-pattern',
    category: '保留策略',
    impact: '中',
    tone: 'good',
    title: '保留高价值低成本的模型策略',
    recommendation: '这类高价值产出已经能用中轻量模型完成，后续相似任务优先复用同样模型组合。',
    reason: 'ROI 最高的模式不是最便宜，而是能稳定交付高价值产出且成本可控。',
    evidence: withAttributionEvidence(`${rows.length} 个高价值且已完成/已发布 session 使用中轻量模型，合计官方价 ${money(aggregate.costUSD)}。`, rows),
    action: '把这些 session 的项目、任务类型和模型作为后续默认模板。',
    score: 60 + shareScore(aggregate.totalTokens, total.totalTokens)
  });
}

function isLowCostSession(session, total) {
  const cost = session.costUSD || 0;
  return cost <= 1 || (total.costUSD > 0 && cost / total.costUSD <= 0.05);
}

function buildInputRatioSuggestion(sessions, daily) {
  const aggregate = aggregateRows(sessions.length ? sessions : daily);
  const ratio = aggregate.outputTokens ? aggregate.inputTokens / aggregate.outputTokens : 0;
  const cacheRate = U.cacheHitRate(aggregate.inputTokens, aggregate.cacheReadTokens);
  if (ratio < 4 || aggregate.inputTokens < 100_000 || cacheRate >= HEALTHY_CACHE_HIT_RATE) return null;
  return suggestion({
    id: 'reduce-context-bloat',
    category: '上下文压缩',
    impact: ratio >= 8 ? '高' : '中',
    tone: 'optimize',
    title: '压缩上下文，减少大段输入',
    recommendation: '把长上下文改成“目标 + 相关文件 + 约束 + 验收标准”，不要每轮重复喂全部背景。',
    reason: 'Input / Output 比偏高且 cache 命中偏低，说明重复读取上下文的可能性较高。',
    evidence: withAttributionEvidence(`本期 Input / Output 比为 ${ratio.toFixed(1)}:1，cache hit ${cacheRate.toFixed(1)}%，输入 ${compact(aggregate.inputTokens)}，输出 ${compact(aggregate.outputTokens)}。`, sessions),
    action: '为高频项目沉淀 README/任务摘要；每轮只附与当前问题直接相关的文件和错误信息。',
    score: 76 + Math.min(20, ratio)
  });
}

function buildCacheSuggestion(sessions, daily) {
  const aggregate = aggregateRows(sessions.length ? sessions : daily);
  const cacheRate = U.cacheHitRate(aggregate.inputTokens, aggregate.cacheReadTokens);
  if (cacheRate >= 10 || aggregate.inputTokens < 100_000) return null;
  return suggestion({
    id: 'improve-cache-and-task-continuity',
    category: '上下文压缩',
    impact: '中',
    tone: 'optimize',
    title: '提高上下文连续性，减少重新读项目',
    recommendation: '把同一项目的相关任务集中处理，减少频繁开新上下文。',
    reason: 'cache 命中低且输入高，说明模型经常重新读取类似背景。',
    evidence: withAttributionEvidence(`本期 cache hit ${cacheRate.toFixed(1)}%，输入 ${compact(aggregate.inputTokens)} tokens。`, sessions),
    action: '同一项目尽量连续完成“方案-实现-验证”，并用项目摘要替代重复粘贴长上下文。',
    score: 70
  });
}

function buildUnpricedSuggestion(sessions, daily, total) {
  const rows = (sessions.length ? sessions : daily).filter(row =>
    row.totalTokens > 0 && (row.pricingStatus === 'unpriced' || modelTier(row.model || row.pricingModel, row.pricingStatus) === 'unpriced')
  );
  if (!rows.length) return null;
  const aggregate = aggregateRows(rows);
  const models = Array.from(new Set(rows.map(row => row.model || row.pricingModel).filter(Boolean))).slice(0, 3);
  return suggestion({
    id: 'keep-unpriced-models-out-of-cost-decisions',
    category: '未定价模型',
    impact: '中',
    tone: 'neutral',
    title: '未定价模型不要参与成本决策',
    recommendation: '把未公开官方美元价的模型单独标记，只用 token 量观察，不把 $0 当成免费，也不按 ¥0 估算。',
    reason: '没有官方公开单价时，强行换算会污染 ROI 判断。',
    evidence: withAttributionEvidence(`${models.join('、')} 等模型合计 ${compact(aggregate.totalTokens)} tokens，目前没有纳入官方价成本。`, rows),
    action: '涉及未定价模型时，用产出状态和价值判断是否继续，而不是用账单金额排序。',
    score: 58 + shareScore(aggregate.totalTokens, total.totalTokens)
  });
}

function suggestion(value) {
  return value;
}

function withAttributionEvidence(text, rows: UsageRow[] = []) {
  const autoCount = rows.filter(row => row.annotationSource === 'auto').length;
  if (!autoCount) return text;
  return `${text} 其中 ${autoCount} 条基于自动归因，建议抽查高成本项。`;
}

function aggregateRows(rows: UsageRow[] = []) {
  return rows.reduce<{
    sessionCount: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    totalTokens: number;
    costUSD: number;
  }>((acc, row) => {
    acc.sessionCount += 1;
    acc.inputTokens += row.inputTokens || 0;
    acc.outputTokens += row.outputTokens || 0;
    acc.cacheReadTokens += row.cacheReadTokens || 0;
    acc.totalTokens += row.totalTokens || 0;
    acc.costUSD += row.costUSD || 0;
    return acc;
  }, {
    sessionCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    costUSD: 0
  });
}

function compareCostThenTokens(a, b) {
  return (b.costUSD || 0) - (a.costUSD || 0)
    || (b.totalTokens || 0) - (a.totalTokens || 0);
}

function labelSession(session: UsageRow = {}) {
  return session.projectAlias || session.projectPath || session.sessionId || '未命名 session';
}

function shareScore(value, total) {
  return Math.round(Math.min(30, total ? (value / total) * 100 : 0));
}

function pct(value, total) {
  return total ? `${((value / total) * 100).toFixed(1)}%` : '0%';
}

function money(value) {
  return U.money4(Number(value || 0));
}

function compact(value) {
  const v = Number(value || 0);
  const abs = Math.abs(v);
  if (abs >= 1e8) return `${(v / 1e8).toFixed(2).replace(/\.?0+$/, '')} 亿`;
  if (abs >= 1e4) return `${(v / 1e4).toFixed(1).replace(/\.0$/, '')} 万`;
  return String(Math.round(v));
}
