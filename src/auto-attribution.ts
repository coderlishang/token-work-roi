export const AUTO_ATTRIBUTION_VERSION = 'v2.0.0';
export const AUTO_ATTRIBUTION_THRESHOLD = 80;

type InputRecord = Record<string, unknown>;

interface SuggestionOptions {
  now?: Date | string | number;
  generatedAt?: string;
  threshold?: number;
  projectAliasRules?: InputRecord[];
}

const DEFAULTS = {
  taskType: '未分类',
  outputStatus: '未标注',
  workPurpose: '未说明',
  workStage: '未说明',
  valueLevel: '未评估'
};

const OUTPUT_RULES = {
  PR: {
    taskType: '功能开发',
    outputStatus: '已完成',
    workPurpose: '功能开发',
    workStage: '实现',
    valueLevel: '中',
    confidence: 85,
    reason: '已有 PR 产出链接，结构化证据足以判断为已完成的功能开发。'
  },
  commit: {
    taskType: '功能开发',
    outputStatus: '已完成',
    workPurpose: '功能开发',
    workStage: '实现',
    valueLevel: '中',
    confidence: 85,
    reason: '已有 commit 产出链接，结构化证据足以判断为已完成的功能开发。'
  },
  部署: {
    taskType: '运维配置',
    outputStatus: '已发布',
    workPurpose: '部署运维',
    workStage: '发布',
    valueLevel: '高',
    confidence: 90,
    reason: '已有部署产出链接，结构化证据足以判断为已发布。'
  },
  文章: {
    taskType: '内容创作',
    outputStatus: '已完成',
    workPurpose: '文档内容',
    workStage: '发布',
    valueLevel: '中',
    confidence: 85,
    reason: '已有文章产出链接，结构化证据足以判断为已完成的内容产出。'
  },
  文档: {
    taskType: '内容创作',
    outputStatus: '已完成',
    workPurpose: '文档内容',
    workStage: '发布',
    valueLevel: '中',
    confidence: 85,
    reason: '已有文档产出链接，结构化证据足以判断为已完成的文档内容。'
  },
  截图: {
    taskType: '其他',
    outputStatus: '已完成',
    workPurpose: '文档内容',
    workStage: '验证',
    valueLevel: '中',
    confidence: 82,
    reason: '已有截图产出链接，结构化证据足以判断为已完成的可展示产出。'
  }
};

export function buildAutoAttributionPlan({
  sessions = [],
  projectAliasRules = [],
  now = new Date(),
  threshold = AUTO_ATTRIBUTION_THRESHOLD
} = {}) {
  const generatedAt = toIso(now);
  const suggestions = sessions
    .map(session => buildAutoAttributionSuggestion(session, { projectAliasRules, now, threshold, generatedAt }))
    .filter(Boolean)
    .sort((a, b) => Number(b.canApply) - Number(a.canApply)
      || b.annotationConfidence - a.annotationConfidence
      || Number(b.totalTokens || 0) - Number(a.totalTokens || 0));

  const highConfidence = suggestions.filter(item => item.canApply);
  const lowConfidence = suggestions.filter(item =>
    item.annotationConfidence >= 60 && item.annotationConfidence < threshold
  );
  const skipped = sessions.length - suggestions.length;
  const initiallyUnattributed = sessions.filter(isReviewIncomplete).length;
  const remainingAfterApply = sessions.filter(session => {
    const suggestion = highConfidence.find(item => sameSession(item, session));
    return isReviewIncomplete(suggestion ? { ...session, ...suggestion.applicableValues } : session);
  }).length;

  return {
    version: AUTO_ATTRIBUTION_VERSION,
    generatedAt,
    threshold,
    totalSessions: sessions.length,
    suggestionCount: suggestions.length,
    highConfidenceCount: highConfidence.length,
    lowConfidenceCount: lowConfidence.length,
    skippedCount: skipped,
    initiallyUnattributed,
    estimatedRemainingUnattributed: remainingAfterApply,
    estimatedReductionShare: initiallyUnattributed
      ? (initiallyUnattributed - remainingAfterApply) / initiallyUnattributed
      : 0,
    suggestions
  };
}

export function buildAutoAttributionSuggestion(session: InputRecord = {}, options: SuggestionOptions = {}) {
  if (!canAutoWrite(session)) return null;

  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const generatedAt = options.generatedAt || toIso(now);
  const threshold = Number(options.threshold || AUTO_ATTRIBUTION_THRESHOLD);
  const reasons = [];
  const values = {
    projectAlias: normalizeText(session.manualProjectAlias || session.projectAlias) || null,
    taskType: session.taskType || DEFAULTS.taskType,
    outputStatus: session.outputStatus || DEFAULTS.outputStatus,
    workPurpose: session.workPurpose || DEFAULTS.workPurpose,
    workStage: session.workStage || DEFAULTS.workStage,
    valueLevel: session.valueLevel || DEFAULTS.valueLevel,
    note: normalizeText(session.note) || null
  };
  const fieldConfidence: Record<string, number> = {};

  const alias = inferProjectAlias(session, options.projectAliasRules || []);
  if (!values.projectAlias && alias.value) {
    values.projectAlias = alias.value;
    fieldConfidence.projectAlias = alias.confidence;
    reasons.push(alias.reason);
  }

  const outputRule = inferFromOutput(session);
  if (outputRule) {
    applyIfDefault(values, fieldConfidence, 'taskType', outputRule.taskType, outputRule.confidence);
    applyIfDefault(values, fieldConfidence, 'outputStatus', outputRule.outputStatus, outputRule.confidence);
    applyIfDefault(values, fieldConfidence, 'workPurpose', outputRule.workPurpose, outputRule.confidence);
    applyIfDefault(values, fieldConfidence, 'workStage', outputRule.workStage, outputRule.confidence);
    applyIfDefault(values, fieldConfidence, 'valueLevel', outputRule.valueLevel, outputRule.confidence);
    reasons.push(outputRule.reason);
  } else {
    const active = inferActiveStatus(session, now);
    if (active && isDefault(values.outputStatus, 'outputStatus')) {
      values.outputStatus = active.outputStatus;
      fieldConfidence.outputStatus = active.confidence;
      reasons.push(active.reason);
    }
    const shape = inferFromTokenShape(session);
    if (shape) {
      applyIfDefault(values, fieldConfidence, 'taskType', shape.taskType, shape.confidence);
      applyIfDefault(values, fieldConfidence, 'workPurpose', shape.workPurpose, shape.confidence);
      applyIfDefault(values, fieldConfidence, 'workStage', shape.workStage, shape.confidence);
      reasons.push(shape.reason);
    } else {
      const modelContext = inferFromModelAndActivity(session, now);
      if (modelContext) {
        applyIfDefault(values, fieldConfidence, 'taskType', modelContext.taskType, modelContext.confidence);
        applyIfDefault(values, fieldConfidence, 'workPurpose', modelContext.workPurpose, modelContext.confidence);
        applyIfDefault(values, fieldConfidence, 'workStage', modelContext.workStage, modelContext.confidence);
        reasons.push(modelContext.reason);
      }
    }
  }

  const changedFields = Object.entries(values)
    .filter(([field, value]) => field !== 'note' && !sameValue(value, session[field]) && !isUnhelpfulDefault(field, value))
    .map(([field]) => field);
  if (!changedFields.length) return null;

  const confidenceValues = Object.values(fieldConfidence).filter(value => Number.isFinite(value));
  const annotationConfidence = confidenceValues.length
    ? Math.min(...confidenceValues)
    : 60;
  const applicableFields = changedFields.filter(field => Number(fieldConfidence[field] || 0) >= threshold);
  const applicableValues = Object.fromEntries(applicableFields.map(field => [field, values[field]]));
  const applyConfidenceValues = applicableFields.map(field => fieldConfidence[field]);
  const applyConfidence = applyConfidenceValues.length ? Math.min(...applyConfidenceValues) : 0;
  const annotationReason = reasons.join('；').slice(0, 500);
  const canApply = applicableFields.length > 0;

  return {
    device: session.device,
    source: session.source,
    sessionId: session.sessionId,
    projectPath: session.projectPath || null,
    totalTokens: session.totalTokens || 0,
    costUSD: session.costUSD || 0,
    model: session.model || session.pricingModel || null,
    values,
    changedFields,
    applicableFields,
    applicableValues,
    fieldConfidence,
    annotationSource: 'auto',
    annotationConfidence,
    applyConfidence,
    annotationReason,
    autoVersion: AUTO_ATTRIBUTION_VERSION,
    autoRunId: null,
    autoUpdatedAt: generatedAt,
    canApply,
    evidence: summarizeEvidence(session, changedFields, annotationConfidence)
  };
}

export function attachAutoSuggestions(sessions = [], suggestions = []) {
  const byKey = new Map(suggestions.map(item => [sessionKey(item), item]));
  return sessions.map(session => ({
    ...session,
    autoSuggestion: byKey.get(sessionKey(session)) || null
  }));
}

export function autoAttributionIdentity(suggestion: InputRecord = {}) {
  return {
    device: suggestion.device,
    source: suggestion.source,
    sessionId: suggestion.sessionId
  };
}

function canAutoWrite(session) {
  const source = normalizeText(session.annotationSource);
  return !source || source === 'auto';
}

function inferProjectAlias(session, rules = []) {
  if (session.ruleProjectAlias) {
    return {
      value: session.ruleProjectAlias,
      confidence: 92,
      reason: `命中项目别名规则：${session.ruleProjectAlias}`
    };
  }
  const projectPath = normalizeText(session.projectPath);
  const matchedRuleAlias = matchProjectAliasRule(projectPath, rules);
  if (matchedRuleAlias) {
    return {
      value: matchedRuleAlias,
      confidence: 92,
      reason: `命中项目别名规则：${matchedRuleAlias}`
    };
  }
  const fromPath = basename(session.projectPath);
  if (fromPath) {
    return {
      value: fromPath,
      confidence: 80,
      reason: `根据项目路径末级目录推断项目别名：${fromPath}`
    };
  }
  const fromSession = basename(projectPathFromSessionId(session.sessionId));
  if (fromSession) {
    return {
      value: fromSession,
      confidence: 65,
      reason: `根据 session_id 中的本地路径片段粗略推断项目别名：${fromSession}`
    };
  }
  return { value: null, confidence: 0, reason: '' };
}

function matchProjectAliasRule(projectPath, rules = []) {
  const target = normalizeText(projectPath);
  if (!target) return null;
  const normalizedTarget = target.toLowerCase();
  for (const rule of rules) {
    if (!rule?.enabled) continue;
    const pattern = normalizeText(rule.pattern);
    if (!pattern) continue;
    const normalizedPattern = pattern.toLowerCase();
    if (rule.matchType === 'prefix' && normalizedTarget.startsWith(normalizedPattern)) return rule.projectAlias;
    if (rule.matchType === 'contains' && normalizedTarget.includes(normalizedPattern)) return rule.projectAlias;
    if (rule.matchType === 'regex') {
      try {
        if (new RegExp(pattern, 'i').test(target)) return rule.projectAlias;
      } catch {
        continue;
      }
    }
  }
  return null;
}

function inferFromOutput(session) {
  if (!session.outputUrl) return null;
  const type = normalizeText(session.outputType) || '未分类';
  if (OUTPUT_RULES[type]) return OUTPUT_RULES[type];
  return {
    taskType: '其他',
    outputStatus: '已完成',
    workPurpose: '其他',
    workStage: '验证',
    valueLevel: '中',
    confidence: 80,
    reason: '已有产出链接，但类型未分类，因此仅按已完成产出做保守归因。'
  };
}

function inferActiveStatus(session, now) {
  const last = parseDate(session.lastActivity);
  if (!last) return null;
  const ageHours = (now.getTime() - last.getTime()) / 36e5;
  if (ageHours < 0 || ageHours > 48) return null;
  return {
    outputStatus: '进行中',
    confidence: 70,
    reason: '最近 48 小时内仍有活动且暂无产出链接，保守建议为进行中。'
  };
}

function inferFromTokenShape(session) {
  const input = Number(session.inputTokens || 0);
  const output = Number(session.outputTokens || 0);
  const total = Number(session.totalTokens || 0);
  const ratio = output > 0 ? input / output : input ? Infinity : 0;
  if (input >= 100_000 && total >= 120_000 && ratio >= 8) {
    return {
      taskType: '技术调研',
      workPurpose: '上下文整理',
      workStage: '探索',
      confidence: 65,
      reason: '输入显著高于输出，且没有产出链接，仅能低置信建议为技术调研或上下文整理。'
    };
  }
  return null;
}

function inferFromModelAndActivity(session, now) {
  if (session.outputUrl) return null;
  const input = Number(session.inputTokens || 0);
  const total = Number(session.totalTokens || 0);
  if (input < 50_000 || total < 60_000) return null;
  const tier = modelTier(session.model || session.pricingModel, session.pricingStatus);
  const last = parseDate(session.lastActivity);
  const recentlyActive = last
    ? (now.getTime() - last.getTime()) / 36e5 >= 0 && (now.getTime() - last.getTime()) / 36e5 <= 72
    : false;
  if (!['heavy', 'mid'].includes(tier) && !recentlyActive) return null;
  return {
    taskType: '技术调研',
    workPurpose: '技术调研',
    workStage: '探索',
    confidence: 60,
    reason: '高输入 session 暂无产出链接，只能结合模型层级和最近活动低置信建议为技术调研或探索，需人工确认。'
  };
}

function modelTier(model, pricingStatus = '') {
  const name = normalizeText(model).toLowerCase();
  if (!name || name === '<synthetic>' || pricingStatus === 'unpriced') return 'unpriced';
  if (/(?:^|[/:\s])gpt-6-astra(?:$|[-:])/.test(name) || name.startsWith('gpt-5.6-sol') || name.startsWith('gpt-5.5') || name.includes('claude-mythos') || name.includes('claude-fable') || name.includes('claude-opus') || name.includes('gemini-2.5-pro-long-context')) return 'heavy';
  if (name.startsWith('gpt-5.6-terra') || name === 'gpt-5.3-codex' || /^grok-4[.-]5/.test(name) || name.includes('claude-sonnet') || name.includes('gemini-2.5-pro') || /kimi-k2[.-][67]/.test(name) || /kimi-k3[.-]1/.test(name)) return 'mid';
  if (name === 'gpt-5.6-luna' || name.includes('claude-haiku') || name.includes('deepseek') || name.includes('mimo') || name.includes('gemini-2.5-flash') || /kimi-k2[.-]5/.test(name)) return 'light';
  return 'unknown';
}

function applyIfDefault(values, fieldConfidence, field, value, confidence) {
  if (!isDefault(values[field], field)) return;
  values[field] = value;
  fieldConfidence[field] = confidence;
}

function isDefault(value, field) {
  return (value || DEFAULTS[field]) === DEFAULTS[field];
}

function isUnhelpfulDefault(field, value) {
  return field in DEFAULTS && (value || DEFAULTS[field]) === DEFAULTS[field];
}

function isReviewIncomplete(session: InputRecord = {}) {
  return Object.entries(DEFAULTS).some(([field, fallback]) => (session[field] || fallback) === fallback);
}

function summarizeEvidence(session, fields, confidence) {
  const bits = [
    `${fields.length} 个字段`,
    `置信度 ${confidence}%`
  ];
  if (session.outputType && session.outputUrl) bits.push(`产出类型 ${session.outputType}`);
  if (session.ruleProjectAlias) bits.push('命中别名规则');
  if (session.projectPath) bits.push('本地项目路径');
  return bits.join(' · ');
}

function sameSession(left, right) {
  return sessionKey(left) === sessionKey(right);
}

function sessionKey(row: InputRecord = {}) {
  return `${row.device || ''}::${row.source || ''}::${row.sessionId || ''}`;
}

function sameValue(left, right) {
  return normalizeText(left) === normalizeText(right);
}

function basename(value) {
  const text = normalizeText(value);
  if (!text || text === 'Unknown Project') return null;
  const cleaned = text.replace(/[\\/]+$/, '');
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || null;
}

function projectPathFromSessionId(sessionId) {
  const text = normalizeText(sessionId);
  if (!text.startsWith('local:')) return '';
  const lastColon = text.lastIndexOf(':');
  if (lastColon <= 'local:'.length) return '';
  const withoutModel = text.slice(0, lastColon);
  return withoutModel.replace(/^local:[^:]+:/, '');
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function normalizeText(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}
