import type { UsageRow } from '../shared/types.ts';

interface DashboardFilters {
  sources?: Set<unknown>;
  devices?: Set<unknown>;
  models?: Set<unknown>;
  startDate?: string;
  endDate?: string;
  startDateTime?: string;
  endDateTime?: string;
}

export function sessionModel(session: UsageRow = {}) {
  return session.modelLabel || session.model || session.pricingModel || '';
}

export function filterSessionsByDashboardFilters(sessions: UsageRow[] = [], filters: DashboardFilters = {}) {
  const sources = filters.sources || new Set();
  const devices = filters.devices || new Set();
  const models = filters.models || new Set();
  const startDate = filters.startDate || '';
  const endDate = filters.endDate || '';
  const startDateTime = filters.startDateTime || '';
  const endDateTime = filters.endDateTime || '';

  return sessions.filter(session => {
    const lastActivity = session.lastActivity || '';
    const lastActivityTime = normalizeDateTime(lastActivity);
    const model = sessionModel(session);
    return (!lastActivity || inDateRange(lastActivity, startDate, endDate) && inDateTimeRange(lastActivityTime, startDateTime, endDateTime))
      && (sources.size === 0 || sources.has(session.source))
      && (devices.size === 0 || devices.has(session.device))
      && (models.size === 0 || models.has(model));
  });
}

function normalizeDateTime(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= 10) return `${text.slice(0, 10)}T23:59`;
  return text.replace(' ', 'T').slice(0, 16);
}

function inDateRange(value, startDate, endDate) {
  const day = String(value || '').slice(0, 10);
  return (!startDate || day >= startDate) && (!endDate || day <= endDate);
}

function inDateTimeRange(value, startDateTime, endDateTime) {
  if (!value) return true;
  return (!startDateTime || value >= startDateTime) && (!endDateTime || value <= endDateTime);
}

export function buildModelUsageRows(dailyRows: UsageRow[] = [], sessions: UsageRow[] = []) {
  const rows = new Map();

  const ensure = (model) => {
    const key = model || 'unknown';
    if (!rows.has(key)) {
      rows.set(key, {
        model: key,
        sources: new Set(),
        days: new Set(),
        sessionKeys: new Set(),
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
        costUSD: 0,
        pricingStatuses: new Set(),
        hasDaily: false
      });
    }
    return rows.get(key);
  };

  for (const row of dailyRows) {
    const model = row.modelLabel || row.model || 'unknown';
    const target = ensure(model);
    target.hasDaily = true;
    target.sources.add(row.source);
    if (row.usageDate) target.days.add(row.usageDate);
    target.inputTokens += row.inputTokens || 0;
    target.outputTokens += row.outputTokens || 0;
    target.cacheReadTokens += row.cacheReadTokens || 0;
    target.cacheCreationTokens += row.cacheCreationTokens || 0;
    target.cachedInputTokens += row.cachedInputTokens || 0;
    target.reasoningOutputTokens += row.reasoningOutputTokens || 0;
    target.totalTokens += row.totalTokens || 0;
    target.costUSD += row.costUSD || 0;
    if (row.pricingStatus) target.pricingStatuses.add(row.pricingStatus);
  }

  for (const session of sessions) {
    const model = sessionModel(session);
    if (!model) continue;
    const target = ensure(model);
    target.sources.add(session.source);
    if (session.lastActivity) target.days.add(session.lastActivity);
    target.sessionKeys.add(`${session.device || ''}::${session.source || ''}::${session.sessionId || ''}`);
    if (!target.hasDaily) {
      target.inputTokens += session.inputTokens || 0;
      target.outputTokens += session.outputTokens || 0;
      target.cacheReadTokens += session.cacheReadTokens || 0;
      target.cacheCreationTokens += session.cacheCreationTokens || 0;
      target.cachedInputTokens += session.cachedInputTokens || 0;
      target.reasoningOutputTokens += session.reasoningOutputTokens || 0;
      target.totalTokens += session.totalTokens || 0;
      target.costUSD += session.costUSD || 0;
      if (session.pricingStatus) target.pricingStatuses.add(session.pricingStatus);
    }
  }

  return Array.from(rows.values())
    .map(row => {
      const pricingStatus = row.pricingStatuses.has('priced')
        ? (row.pricingStatuses.size > 1 ? '部分定价' : '已定价')
        : (row.pricingStatuses.size > 0 ? '未定价' : '无价格');
      return {
        model: row.model,
        sourceCount: row.sources.size,
        sources: Array.from(row.sources).sort(),
        dayCount: row.days.size,
        sessionCount: row.sessionKeys.size,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheCreationTokens: row.cacheCreationTokens,
        cachedInputTokens: row.cachedInputTokens,
        reasoningOutputTokens: row.reasoningOutputTokens,
        totalTokens: row.totalTokens,
        costUSD: row.costUSD,
        pricingStatus
      };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens);
}
