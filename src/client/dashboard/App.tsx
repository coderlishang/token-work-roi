/* =============================================================
   Main App — real data from /api/data
   ============================================================= */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { U } from '../shared/utils.ts';
import { cachedAppData, loadAppData } from '../shared/runtime-data.ts';
import {
  attachAutoSuggestions,
  autoAttributionIdentity,
  buildAutoAttributionPlan
} from '../../auto-attribution.ts';
import { Topbar, FilterBar, KPI } from './components-top.tsx';
import { TrendChart, SourceDonut, TopModels, Gauge, GrowthPanel, Heatmap } from './components-charts.tsx';
import { BatchAnnotationModal, TablePanel, DrillDrawer } from './components-tables.tsx';
import {
  aggregateSessions,
  buildAttributionStatusSummary,
  buildPendingConfirmationSessions,
  buildProjectRoiRows,
  buildRiskDistribution,
  buildWeeklyReview
} from './attribution.ts';
import {
  buildModelUsageRows,
  filterSessionsByDashboardFilters,
  sessionModel
} from './model-usage.ts';
import {
  BUDGET_TEMPLATES,
  CCUSAGE_BRIDGE_REPORTS,
  applyBudgetTemplate,
  buildCcusageBridgeCommand,
  buildCcusageJsonExportCommand,
  defaultResetAnchor
} from './import-budget.ts';
import type { BudgetForm } from './import-budget.ts';
import type { PeriodRange, UsageRow } from '../shared/types.ts';
import { buildFirstRunState } from './onboarding.ts';
import { buildTrustEvidenceQueue } from './trust-evidence-queue.ts';
import { readAnnotationPresets } from './annotation-presets.ts';
import './styles.css';

function formatApiConnectionError(error, action = '请求') {
  const message = error?.message || '';
  if (message === 'Failed to fetch' || error?.name === 'TypeError') {
    return `${action}失败：本地 API 服务没有连上。请关闭旧页面，重新运行 npx token-work，并打开终端输出的最新本地 URL。`;
  }
  return message || `${action}失败`;
}

function dashboardModel(data) {
  if (!data) return null;
  const sourceNames = [...new Set(data.daily.map(row => row.source))];
  const SOURCES = sourceNames.map(name => ({ name, color: U.getSourceColor(name) }));
  const rawHourly = [
    0.005, 0.003, 0.002, 0.001, 0.001, 0.003,
    0.008, 0.025, 0.045, 0.075, 0.092, 0.082,
    0.055, 0.078, 0.092, 0.088, 0.080, 0.060,
    0.045, 0.038, 0.045, 0.040, 0.025, 0.012
  ];
  const total = rawHourly.reduce((sum, value) => sum + value, 0);
  return {
    ...data,
    SOURCES,
    HOURLY: rawHourly.map(value => value / total),
    today: U.daysAgo(0)
  };
}

function periodLabelForFilters(filters: PeriodRange = {}) {
  const start = (filters.startDateTime || `${filters.startDate || ''}T00:00`).replace('T', ' ');
  const end = (filters.endDateTime || `${filters.endDate || ''}T23:59`).replace('T', ' ');
  if (!start.trim() && !end.trim()) return '当前筛选范围';
  return `${start} 至 ${end}`;
}

function summarizeCollectOutput(stdout) {
  return stdout
    ? stdout.split('\n').filter(Boolean).slice(-5).join(' · ')
    : '采集完成';
}

export function App({ routeMode = 'dashboard' }) {
  const [M, setM] = useState(() => dashboardModel(cachedAppData()));
  const [loadError, setLoadError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [collectStatus, setCollectStatus] = useState(null);
  const [collectConfirmOpen, setCollectConfirmOpen] = useState(false);
  const [collectionCoverage, setCollectionCoverage] = useState(null);
  const [coverageLoading, setCoverageLoading] = useState(false);
  const [coverageError, setCoverageError] = useState(null);
  const lastCompletedCollectionRef = useRef(null);
  const waitingForCollectionRef = useRef(false);

  // ───── Load data from API ─────
  const loadData = useCallback((force = true) => {
    setRefreshing(true);
    return loadAppData({ force })
      .then(data => {
        setM(dashboardModel(data));
        setLoadError(null);
      })
      .catch(err => setLoadError(err.message))
      .finally(() => setRefreshing(false));
  }, []);

  useEffect(() => { loadData(false); }, [loadData]);

  const loadCollectionCoverage = useCallback(() => {
    setCoverageLoading(true);
    return fetch('/api/collection-coverage')
      .then(async r => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
        setCollectionCoverage(data);
        setCoverageError(null);
        return data;
      })
      .catch(error => {
        setCoverageError(error.message || '采集可信度检查失败');
        return null;
      })
      .finally(() => setCoverageLoading(false));
  }, []);

  useEffect(() => {
    if (M?.meta?.demoMode) loadCollectionCoverage();
  }, [M?.meta?.demoMode, loadCollectionCoverage]);

  const syncCollectStatus = useCallback((options: { refreshOnDone?: boolean; refreshCoverage?: boolean } = {}) => {
    return fetch('/api/collect/status')
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(data => {
        if (data.status === 'running') {
          setCollecting(true);
          setCollectStatus({ type: 'running', message: data.message || '正在采集本机用量…' });
        } else if (data.status === 'ok') {
          setCollecting(false);
          setCollectStatus({ type: 'ok', message: summarizeCollectOutput(data.stdout) });
          const collectionFinishedAt = data.finishedAt || null;
          const hasNewCollection = collectionFinishedAt
            && collectionFinishedAt !== lastCompletedCollectionRef.current;
          if (hasNewCollection) lastCompletedCollectionRef.current = collectionFinishedAt;
          if (options.refreshOnDone && hasNewCollection) {
            loadData();
          }
          if (options.refreshCoverage && hasNewCollection) {
            loadCollectionCoverage();
          }
        } else if (data.status === 'error') {
          setCollecting(false);
          setCollectStatus({ type: 'error', message: data.stderr || data.message || '采集失败' });
        } else {
          setCollecting(false);
        }
        return data;
      });
  }, [loadData, loadCollectionCoverage]);

  const waitForCollectDone = useCallback(async ({ refreshCoverage = false } = {}) => {
    if (waitingForCollectionRef.current) return null;
    waitingForCollectionRef.current = true;
    try {
      for (;;) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        const data = await syncCollectStatus({ refreshOnDone: true, refreshCoverage });
        if (data.status !== 'running') return data;
      }
    } finally {
      waitingForCollectionRef.current = false;
    }
  }, [syncCollectStatus]);

  useEffect(() => {
    let cancelled = false;
    const inspectCollection = () => {
      syncCollectStatus({ refreshOnDone: true })
        .then(data => {
          if (!cancelled && data.status === 'running') waitForCollectDone();
        })
        .catch(() => {});
    };
    inspectCollection();
    const timer = setInterval(inspectCollection, 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [syncCollectStatus, waitForCollectDone]);

  const runCollect = useCallback(() => {
    setCollecting(true);
    setCollectStatus({ type: 'running', message: '正在采集本机用量…' });
    fetch('/api/collect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'live-refresh' })
    })
      .then(async r => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok && r.status !== 202) {
          throw new Error(data.error || data.stderr || `HTTP ${r.status}`);
        }
        setCollectStatus({ type: 'running', message: data.message || '正在采集本机用量…' });
        return waitForCollectDone({ refreshCoverage: true });
      })
      .catch(err => {
        setCollecting(false);
        setCollectStatus({ type: 'error', message: err.message || '采集失败' });
      });
  }, [waitForCollectDone]);

  const requestCollect = useCallback(() => {
    setCollectConfirmOpen(true);
  }, []);

  const saveSessionAnnotation = useCallback((payload) => {
    return fetch('/api/session-annotations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(async r => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
        await loadData();
        return data.annotation;
      });
  }, [loadData]);

  const batchSaveSessionAnnotations = useCallback((payload) => {
    return fetch('/api/session-annotations/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(async r => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
        await loadData();
        return data.updated;
      });
  }, [loadData]);

  const deleteSessionAnnotation = useCallback((payload) => {
    return fetch('/api/session-annotations', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(async r => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
        await loadData();
        return data.deleted;
      });
  }, [loadData]);

  const saveSessionOutput = useCallback((payload) => {
    return fetch('/api/session-outputs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(async r => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
        await loadData();
        return data.output;
      });
  }, [loadData]);

  const deleteSessionOutput = useCallback((payload) => {
    return fetch('/api/session-outputs', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(async r => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
        await loadData();
        return data.deleted;
      });
  }, [loadData]);

  const saveProjectAliasRule = useCallback((payload) => {
    return fetch('/api/project-alias-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(async r => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
        await loadData();
        return data.rule;
      });
  }, [loadData]);

  const deleteProjectAliasRule = useCallback((payload) => {
    return fetch('/api/project-alias-rules', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(async r => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
        await loadData();
        return data.deleted;
      });
  }, [loadData]);

  const createBackup = useCallback(() => {
    return fetch('/api/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    })
      .then(async r => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
        return data.backup;
      });
  }, []);

  const exportAnnotations = useCallback(() => {
    return fetch('/api/export/annotations')
      .then(async r => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `token-work-annotations-${U.daysAgo(0)}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return data;
      });
  }, []);

  const importAnnotations = useCallback((file) => {
    return file.text()
      .then(text => JSON.parse(text))
      .then(payload => fetch('/api/import/annotations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }))
      .then(async r => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
        await loadData();
        return { ...data.imported, backup: data.backup };
      });
  }, [loadData]);

  const importCcusageJson = useCallback((payload) => {
    return fetch('/api/import/ccusage-json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(async r => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
        if (payload.apply) {
          await loadData();
          if (window.location.pathname !== '/trust') {
            window.location.assign('/trust?imported=1');
          }
        }
        return data;
      });
  }, [loadData]);

  const saveBudgetProfile = useCallback((payload) => {
    return fetch('/api/budget-profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(async r => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
        await loadData();
        return data.profile;
      });
  }, [loadData]);

  const deleteBudgetProfile = useCallback((payload) => {
    return fetch('/api/budget-profiles', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(async r => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
        await loadData();
        return data.deleted;
      });
  }, [loadData]);

  const applyAutoAttribution = useCallback((payload) => {
    return fetch('/api/auto-attribution/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {})
    })
      .then(async r => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
        await loadData();
        return data;
      });
  }, [loadData]);

  const undoAutoAttribution = useCallback((payload) => {
    return fetch('/api/auto-attribution/undo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {})
    })
      .then(async r => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
        await loadData();
        return data;
      });
  }, [loadData]);

  // ───── Loading / error screens ─────
  if (loadError) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', height: '100vh', gap: 16,
        color: 'var(--text-2)', fontFamily: 'var(--font)'
      }}>
        <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
          <circle cx="20" cy="20" r="18" stroke="oklch(0.65 0.16 25)" strokeWidth="2"/>
          <path d="M20 12v10M20 28v2" stroke="oklch(0.65 0.16 25)" strokeWidth="2.5" strokeLinecap="round"/>
        </svg>
        <p style={{fontSize: 15, margin: 0}}>加载失败：{loadError}</p>
        <button className="btn btn-primary" onClick={() => loadData()}>重试</button>
      </div>
    );
  }

  if (!M) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', height: '100vh', gap: 14,
        color: 'var(--text-2)', fontFamily: 'var(--font)'
      }}>
        <svg className="spin" width="32" height="32" viewBox="0 0 32 32" fill="none">
          <circle cx="16" cy="16" r="13" stroke="var(--c-indigo)" strokeWidth="2.5"
            strokeDasharray="60" strokeDashoffset="20" strokeLinecap="round"/>
        </svg>
        <p style={{fontSize: 14, margin: 0}}>正在加载数据…</p>
      </div>
    );
  }

  return (
    <>
      <Dashboard
        M={M}
        refreshing={refreshing}
        collecting={collecting}
        collectStatus={collectStatus}
        collectionCoverage={collectionCoverage}
        coverageLoading={coverageLoading}
        coverageError={coverageError}
        onRefresh={loadData}
        onCollect={requestCollect}
        onLoadCollectionCoverage={loadCollectionCoverage}
        onSaveAnnotation={saveSessionAnnotation}
        onBatchSaveAnnotations={batchSaveSessionAnnotations}
        onDeleteAnnotation={deleteSessionAnnotation}
        onSaveOutput={saveSessionOutput}
        onDeleteOutput={deleteSessionOutput}
        onSaveProjectAliasRule={saveProjectAliasRule}
        onDeleteProjectAliasRule={deleteProjectAliasRule}
        onCreateBackup={createBackup}
        onExportAnnotations={exportAnnotations}
        onImportAnnotations={importAnnotations}
        onImportCcusageJson={importCcusageJson}
        onSaveBudgetProfile={saveBudgetProfile}
        onDeleteBudgetProfile={deleteBudgetProfile}
        onApplyAutoAttribution={applyAutoAttribution}
        onUndoAutoAttribution={undoAutoAttribution}
        routeMode={routeMode} />
      {collectConfirmOpen && (
        <CollectConfirmModal
          busy={collecting}
          onClose={() => setCollectConfirmOpen(false)}
          onConfirm={() => {
            setCollectConfirmOpen(false);
            runCollect();
          }} />
      )}
    </>
  );
}

/* =============================================================
   Dashboard (extracted so App stays clean)
   ============================================================= */
function Dashboard({
  M,
  refreshing,
  collecting,
  collectStatus,
  collectionCoverage,
  coverageLoading,
  coverageError,
  onRefresh,
  onCollect,
  onLoadCollectionCoverage,
  onSaveAnnotation,
  onBatchSaveAnnotations,
  onDeleteAnnotation,
  onSaveOutput,
  onDeleteOutput,
  onSaveProjectAliasRule,
  onDeleteProjectAliasRule,
  onCreateBackup,
  onExportAnnotations,
  onImportAnnotations,
  onImportCcusageJson,
  onSaveBudgetProfile,
  onDeleteBudgetProfile,
  onApplyAutoAttribution,
  onUndoAutoAttribution,
  routeMode = 'dashboard'
}) {
  // ───── Filter state ─────
  const [filters, setFilters] = useState(() => ({
    rangeId: 'today',
    startDate: U.daysAgo(0),
    endDate: U.daysAgo(0),
    startDateTime: `${U.daysAgo(0)}T00:00`,
    endDateTime: `${U.daysAgo(0)}T23:59`,
    sources: new Set(),
    devices: new Set(),
    models: new Set(),
    compare: true
  }));
  const showImportedHistory = new URLSearchParams(window.location.search).get('imported') === '1';
  const importedHistoryAppliedRef = useRef(false);

  const [trendMode, setTrendMode] = useState('stacked');
  const [drill, setDrill] = useState(null);
  const [focusedSource, setFocusedSource] = useState(null);
  const [quickAttributionOpen, setQuickAttributionOpen] = useState(false);
  const [quickAttributionBusy, setQuickAttributionBusy] = useState(false);
  const [quickAttributionError, setQuickAttributionError] = useState(null);
  const [autoAttributionBusy, setAutoAttributionBusy] = useState(false);
  const [autoAttributionMessage, setAutoAttributionMessage] = useState(null);
  const [lastAutoRunId, setLastAutoRunId] = useState(null);
  const [importBudgetOpen, setImportBudgetOpen] = useState(false);
  const [, setExchangeRateVersion] = useState(0);
  const [trustEvidenceState, setTrustEvidenceState] = useState({
    busy: false,
    applyingId: null,
    plan: null,
    queue: null,
    message: null,
    error: null
  });

  useEffect(() => {
    return U.startExchangeRateRefresh(() => {
      setExchangeRateVersion(version => version + 1);
    });
  }, []);

  // Build option lists
  const allSources = useMemo(() => Array.from(new Set(M.daily.map(r => r.source))), [M.daily]);
  const allDevices = useMemo(() => Array.from(new Set(M.daily.map(r => r.device))), [M.daily]);
  const allModels  = useMemo(() => Array.from(new Set([
    ...M.daily.map(r => r.model),
    ...M.sessions.map(sessionModel)
  ])).filter(Boolean), [M.daily, M.sessions]);
  const availableRange = useMemo(() => {
    const dates = M.daily.map(r => r.usageDate).filter(Boolean).sort();
    return {
      startDate: dates[0] || U.daysAgo(0),
      endDate: dates[dates.length - 1] || U.daysAgo(0)
    };
  }, [M.daily]);

  useEffect(() => {
    if (!showImportedHistory || importedHistoryAppliedRef.current) return;
    importedHistoryAppliedRef.current = true;
    setFilters(current => ({
      ...current,
      rangeId: 'all',
      startDate: availableRange.startDate,
      endDate: availableRange.endDate,
      startDateTime: `${availableRange.startDate}T00:00`,
      endDateTime: `${availableRange.endDate}T23:59`
    }));
  }, [availableRange, showImportedHistory]);
  const taskTypes = M.meta?.taskTypes || ['未分类', '功能开发', '问题修复', '代码审查', '技术调研', '内容创作', '运维配置', '其他'];
  const outputStatuses = M.meta?.outputStatuses || ['未标注', '进行中', '已完成', '已发布', '已废弃'];
  const workPurposes = M.meta?.workPurposes || ['未说明', '需求澄清', '方案设计', '功能开发', '调试修复', '测试验证', '代码审查', '技术调研', '文档内容', '部署运维', '上下文整理', '其他'];
  const workStages = M.meta?.workStages || ['未说明', '探索', '实现', '验证', '发布', '维护'];
  const valueLevels = M.meta?.valueLevels || ['未评估', '低', '中', '高', '关键'];
  const outputTypes = M.meta?.outputTypes || ['未分类', 'PR', 'commit', '文章', '部署', '文档', '截图', '其他'];
  const effectiveFilters = useMemo(() => {
    if (!focusedSource) return filters;
    return { ...filters, sources: new Set([focusedSource]) };
  }, [filters, focusedSource]);
  const modelScopeFilters = useMemo(() => ({
    ...effectiveFilters,
    models: new Set()
  }), [effectiveFilters]);

  // ───── Filtered data ─────
  const filtered = useMemo(() => {
    return U.filterDaily(M.daily, effectiveFilters);
  }, [effectiveFilters, M.daily]);

  const totals = useMemo(() => U.aggregateTotals(filtered), [filtered]);

  const dates = useMemo(() => U.rangeDates(filters.startDate, filters.endDate), [filters.startDate, filters.endDate]);
  const presentSources = useMemo(() => {
    const set = effectiveFilters.sources.size ? effectiveFilters.sources : new Set(allSources);
    return Array.from(set);
  }, [effectiveFilters.sources, allSources]);

  // ───── Comparison period ─────
  const compareData = useMemo(() => {
    if (!effectiveFilters.compare) return { rows: null, dates: null, totals: null };
    const days = dates.length;
    const endStr = U.addDays(filters.startDate, -1);
    const startStr = U.addDays(endStr, -(days - 1));
    const rows  = U.filterDaily(M.daily, { ...effectiveFilters, startDate: startStr, endDate: endStr });
    const cDates = U.rangeDates(startStr, endStr);
    return { rows, dates: cDates, totals: U.aggregateTotals(rows) };
  }, [effectiveFilters, filters.startDate, dates.length, M.daily]);

  // ───── Sparklines ─────
  const dailyTotalsByDay = useMemo(() => {
    const m = new Map();
    for (const r of filtered) m.set(r.usageDate, (m.get(r.usageDate) || 0) + r.totalTokens);
    return m;
  }, [filtered]);

  const sparkValues = useMemo(() => dates.map(d => dailyTotalsByDay.get(d) || 0), [dates, dailyTotalsByDay]);

  const sparkBy = useMemo(() => (key) => {
    const m = new Map();
    for (const r of filtered) m.set(r.usageDate, (m.get(r.usageDate) || 0) + (r[key] || 0));
    return dates.map(d => m.get(d) || 0);
  }, [filtered, dates]);

  // ───── Sessions filtered ─────
  const filteredSessions = useMemo(() => {
    return filterSessionsByDashboardFilters(M.sessions, effectiveFilters)
      .sort((a, b) => b.totalTokens - a.totalTokens);
  }, [effectiveFilters, M.sessions]);

  const modelScopeDaily = useMemo(() => U.filterDaily(M.daily, modelScopeFilters), [M.daily, modelScopeFilters]);
  const modelScopeSessions = useMemo(() => filterSessionsByDashboardFilters(M.sessions, modelScopeFilters), [M.sessions, modelScopeFilters]);
  const modelUsageRows = useMemo(() => buildModelUsageRows(modelScopeDaily, modelScopeSessions), [modelScopeDaily, modelScopeSessions]);

  const autoAttributionPlan = useMemo(() => buildAutoAttributionPlan({
    sessions: filteredSessions,
    projectAliasRules: M.meta?.projectAliasRules || []
  }), [filteredSessions, M.meta?.projectAliasRules]);
  const filteredSessionsWithAutoSuggestions = useMemo(() =>
    attachAutoSuggestions(filteredSessions, autoAttributionPlan.suggestions)
  , [filteredSessions, autoAttributionPlan]);

  const sessionTotals = useMemo(() => aggregateSessions(filteredSessions), [filteredSessions]);
  const attributionStatusSummary = useMemo(() => buildAttributionStatusSummary(filteredSessions), [filteredSessions]);
  const riskDistribution = useMemo(() => buildRiskDistribution(filteredSessions), [filteredSessions]);
  const projectRoiRows = useMemo(() => buildProjectRoiRows(filteredSessions), [filteredSessions]);
  const weeklyReview = useMemo(() => buildWeeklyReview(M.sessions, { today: M.today }), [M.sessions, M.today]);
  const unattributedSessions = useMemo(() =>
    buildPendingConfirmationSessions(filteredSessionsWithAutoSuggestions)
  , [filteredSessionsWithAutoSuggestions]);
  const firstRunState = useMemo(() => buildFirstRunState(M), [M]);
  const filteredRuns = useMemo(() => {
    return M.runs.filter(r =>
      (effectiveFilters.sources.size === 0 || effectiveFilters.sources.has(r.source)) &&
      (effectiveFilters.devices.size === 0 || effectiveFilters.devices.has(r.device))
    );
  }, [effectiveFilters.sources, effectiveFilters.devices, M.runs]);
  const visibleSourceUsage = useMemo(() => {
    const map = new Map();
    const ensure = (source) => {
      const key = String(source || 'unknown');
      if (!map.has(key)) {
        map.set(key, { sessions: 0, dailyRows: 0, totalTokens: 0 });
      }
      return map.get(key);
    };
    for (const row of filtered) {
      const target = ensure(row.source);
      target.dailyRows += 1;
      target.totalTokens += Number(row.totalTokens || 0);
    }
    for (const session of filteredSessions) {
      ensure(session.source).sessions += 1;
    }
    return map;
  }, [filtered, filteredSessions]);
  const visibleLocalTrust = useMemo(() => {
    const base = M.meta?.localTrust;
    if (!base) return null;
    const sampleRows = (base.samples || []).filter(row => {
      const day = String(row.timestamp || '').slice(0, 10);
      return (!day || (!effectiveFilters.startDate || day >= effectiveFilters.startDate) && (!effectiveFilters.endDate || day <= effectiveFilters.endDate))
        && (effectiveFilters.sources.size === 0 || effectiveFilters.sources.has(row.source))
        && (effectiveFilters.models.size === 0 || effectiveFilters.models.has(row.model));
    });
    const trustedSourceIds = new Set<string>((base.sources || [])
      .filter(source => source.successfulCoverage || source.status === 'native-trusted')
      .flatMap(source => [source.id, source.label].filter(Boolean).map(value => String(value).toLowerCase())));
    const trustedSessions = filteredSessions.filter(session => {
      const source = String(session.source || '').toLowerCase();
      return trustedSourceIds.has(source) || Array.from(trustedSourceIds).some(id => id && source.includes(id));
    });
    const trustedTokenTotal = trustedSessions.reduce((sum, session) => sum + Number(session.totalTokens || 0), 0);
    return {
      ...base,
      counts: {
        ...(base.counts || {}),
        dailyRows: filtered.length,
        sessionRows: filteredSessions.length,
        collectionRuns: filteredRuns.length
      },
      evidence: {
        ...(base.evidence || {}),
        trustedSessionCount: trustedSessions.length,
        trustedTokenTotal,
        untrustedSessionCount: Math.max(0, filteredSessions.length - trustedSessions.length),
        untrustedTokenTotal: Math.max(0, sessionTotals.totalTokens - trustedTokenTotal)
      },
      samples: sampleRows
    };
  }, [
    M.meta?.localTrust,
    effectiveFilters,
    filtered,
    filteredSessions,
    filteredRuns,
    sessionTotals.totalTokens
  ]);

  const toggleModelFilter = useCallback((model) => {
    setFilters(prev => {
      const next = new Set(prev.models);
      if (next.has(model)) next.delete(model); else next.add(model);
      return { ...prev, models: next };
    });
  }, []);

  const clearModelFilter = useCallback(() => {
    setFilters(prev => ({ ...prev, models: new Set() }));
  }, []);

  const saveQuickAttribution = async (values) => {
    setQuickAttributionBusy(true);
    setQuickAttributionError(null);
    try {
      const payloadValues: UsageRow = {};
      if (values.projectAlias) payloadValues.projectAlias = values.projectAlias;
      if (values.taskType) payloadValues.taskType = values.taskType;
      if (values.outputStatus) payloadValues.outputStatus = values.outputStatus;
      if (values.workPurpose) payloadValues.workPurpose = values.workPurpose;
      if (values.workStage) payloadValues.workStage = values.workStage;
      if (values.valueLevel) payloadValues.valueLevel = values.valueLevel;
      if (values.note) payloadValues.note = values.note;
      if (Object.keys(payloadValues).length === 0) throw new Error('至少选择一个要批量更新的字段');
      await onBatchSaveAnnotations({
        sessions: unattributedSessions.map(sessionIdentity),
        values: payloadValues
      });
      setQuickAttributionOpen(false);
    } catch (error) {
      setQuickAttributionError(error.message || '批量归因失败');
    } finally {
      setQuickAttributionBusy(false);
    }
  };

  const applyHighConfidenceAutoAttribution = async () => {
    setAutoAttributionBusy(true);
    setAutoAttributionMessage(null);
    try {
      const rows = autoAttributionPlan.suggestions.filter(item => item.canApply);
      const result = await onApplyAutoAttribution({
        threshold: autoAttributionPlan.threshold,
        sessions: rows.map(autoAttributionIdentity)
      });
      setLastAutoRunId(result.runId || null);
      setAutoAttributionMessage({ type: 'ok', text: `已自动归因 ${result.applied || 0} 个 session` });
    } catch (error) {
      setAutoAttributionMessage({ type: 'error', text: formatApiConnectionError(error, '自动归因') });
    } finally {
      setAutoAttributionBusy(false);
    }
  };

  const undoLastAutoAttribution = async () => {
    if (!lastAutoRunId) return;
    setAutoAttributionBusy(true);
    setAutoAttributionMessage(null);
    try {
      const result = await onUndoAutoAttribution({ runId: lastAutoRunId });
      setLastAutoRunId(null);
      setAutoAttributionMessage({ type: 'ok', text: `已撤销 ${result.deleted || 0} 个自动归因` });
    } catch (error) {
      setAutoAttributionMessage({ type: 'error', text: formatApiConnectionError(error, '撤销自动归因') });
    } finally {
      setAutoAttributionBusy(false);
    }
  };

  const loadTrustEvidenceQueue = useCallback(async () => {
    setTrustEvidenceState(prev => ({ ...prev, busy: true, error: null, message: null }));
    try {
      const response = await fetch('/api/evidence-suggestions?period=all');
      const plan = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(plan.error || `HTTP ${response.status}`);
      const queue = buildTrustEvidenceQueue({
        trust: visibleLocalTrust,
        evidencePlan: plan,
        limit: 10
      });
      setTrustEvidenceState(prev => ({
        ...prev,
        busy: false,
        plan,
        queue,
        message: queue.rows.length
          ? `已生成 ${queue.rows.length} 条可信证据候选`
          : queue.nextAction,
        error: null
      }));
      return queue;
    } catch (error) {
      setTrustEvidenceState(prev => ({
        ...prev,
        busy: false,
        error: formatApiConnectionError(error, '生成证据队列'),
        message: null
      }));
      return null;
    }
  }, [visibleLocalTrust]);

  const applyTrustEvidenceSuggestion = useCallback(async (suggestionId) => {
    if (!suggestionId) return;
    setTrustEvidenceState(prev => ({ ...prev, applyingId: suggestionId, error: null, message: null }));
    try {
      const response = await fetch('/api/evidence-suggestions/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period: 'all', suggestionIds: [suggestionId] })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      await onRefresh();
      setTrustEvidenceState(prev => ({
        ...prev,
        applyingId: null,
        message: `已写入 ${Number(result.appliedAnnotations || 0) + Number(result.appliedOutputs || 0)} 条自动证据`,
        error: null
      }));
      await loadTrustEvidenceQueue();
    } catch (error) {
      setTrustEvidenceState(prev => ({
        ...prev,
        applyingId: null,
        error: formatApiConnectionError(error, '写入证据建议'),
        message: null
      }));
    }
  }, [loadTrustEvidenceQueue, onRefresh]);

  // ───── Export ─────
  const onExportAll = () => {
    U.downloadCSV(`tokens-daily-${filters.startDate}-${filters.endDate}.csv`, filtered, [
      { title: 'date',             field: 'usageDate' },
      { title: 'source',           field: 'source' },
      { title: 'device',           field: 'device' },
      { title: 'model',            field: 'model' },
      { title: 'input',            field: 'inputTokens' },
      { title: 'output',           field: 'outputTokens' },
      { title: 'cache_read',       field: 'cacheReadTokens' },
      { title: 'cache_creation',   field: 'cacheCreationTokens' },
      { title: 'reasoning',        field: 'reasoningOutputTokens' },
      { title: 'total',            field: 'totalTokens' },
      { title: 'official_price_usd', field: 'costUSD' },
      { title: 'official_price_cny_est', value: row => Number(row.costUSD || 0) * U.getExchangeRate().rate },
      { title: 'pricing_status',     field: 'pricingStatus' },
      { title: 'pricing_model',      field: 'pricingModel' },
      { title: 'pricing_source',     field: 'pricingSource' }
    ]);
  };

  const onExportTrend = () => {
    const rows = dates.map(d => {
      const r = { date: d };
      for (const s of presentSources) {
        let v = 0;
        for (const x of filtered) if (x.usageDate === d && x.source === s) v += x.totalTokens;
        r[s] = v;
      }
      return r;
    });
    U.downloadCSV(`trend-${filters.startDate}-${filters.endDate}.csv`,
      rows,
      [{ title: 'date', field: 'date' }, ...presentSources.map(s => ({ title: s, field: s }))]
    );
  };

  const lastSync = M.runs[0] ? U.formatTs(M.runs[0].collectedAt.replace(' ', 'T')) : '—';
  const trustOnly = routeMode === 'trust';
  const dashboardOverview = (
    <>
      {/* Charts grid */}
      <div className="grid dashboard-chart-grid">
        <div className="col-8">
          <TrendChart
            rows={filtered}
            dates={dates}
            sources={presentSources}
            compareRows={compareData.rows}
            compareDates={compareData.dates}
            mode={trendMode}
            onModeChange={setTrendMode}
            totals={totals}
            onExport={onExportTrend} />
        </div>
        <div className="col-4">
          <SourceDonut
            rows={filtered}
            sources={Array.from(new Set(filtered.map(r => r.source)))}
            focused={focusedSource}
            onFocusSource={setFocusedSource} />
        </div>

        <div className="col-6">
          <TopModels rows={filtered} onDrillModel={r => setDrill({ kind: 'model', row: r })} />
        </div>
        <div className="col-3">
          <Gauge
            rate={totals.cacheHitRate}
            cacheRead={totals.cacheReadTokens}
            cacheCreation={totals.cacheCreationTokens}
            prevRate={compareData.totals?.cacheHitRate} />
        </div>
        <div className="col-3">
          <GrowthPanel totalsByDay={dailyTotalsByDay} />
        </div>
      </div>

      {/* KPI row */}
      <div className="kpi-row">
        <KPI label="总 Token" value={U.compactCN(totals.totalTokens)}
          sub="vs 上周期"
          delta={U.deltaPct(totals.totalTokens, compareData.totals?.totalTokens)}
          sparkValues={sparkValues} sparkColor="oklch(0.55 0.16 265)" />
        <KPI label="输入 Token" value={U.compactCN(totals.inputTokens)}
          sub="输入"
          delta={U.deltaPct(totals.inputTokens, compareData.totals?.inputTokens)}
          sparkValues={sparkBy('inputTokens')} sparkColor="oklch(0.62 0.13 240)" />
        <KPI label="输出 Token" value={U.compactCN(totals.outputTokens)}
          sub="生成"
          delta={U.deltaPct(totals.outputTokens, compareData.totals?.outputTokens)}
          sparkValues={sparkBy('outputTokens')} sparkColor="oklch(0.60 0.15 295)" />
        <KPI label="缓存 Token" value={U.compactCN(totals.cacheTokens)}
          sub={`命中 ${totals.cacheHitRate.toFixed(0)}%`}
          delta={U.deltaPct(totals.cacheTokens, compareData.totals?.cacheTokens)}
          sparkValues={sparkBy('cacheReadTokens')} sparkColor="oklch(0.65 0.11 200)" />
        <KPI label="推理 Token" value={U.compactCN(totals.reasoningTokens)}
          sub="推理"
          delta={U.deltaPct(totals.reasoningTokens, compareData.totals?.reasoningTokens)}
          sparkValues={sparkBy('reasoningOutputTokens')} sparkColor="oklch(0.65 0.12 150)" />
        <KPI label="官方价账单" value={U.money(totals.costUSD)}
          sub="按官网单价"
          delta={U.deltaPct(totals.costUSD, compareData.totals?.costUSD)}
          sparkValues={sparkBy('costUSD')} sparkColor="oklch(0.72 0.14 75)" />
      </div>
    </>
  );

  return (
    <div className="app">
      <Topbar
        lastSync={lastSync}
        onRefresh={onRefresh}
        refreshing={refreshing}
        onCollect={onCollect}
        collecting={collecting}
        collectStatus={collectStatus}
        demoMode={M.meta?.demoMode}
        activePage={trustOnly ? 'trust' : 'dashboard'}
        onOpenImportBudget={() => setImportBudgetOpen(true)} />

      <FilterBar
        f={filters}
        setF={setFilters}
        allSources={allSources}
        allDevices={allDevices}
        allModels={allModels}
        availableRange={availableRange}
        onExport={onExportAll} />

      {focusedSource && (
        <div style={{
          margin: '0 0 12px',
          padding: '10px 14px',
          background: 'oklch(0.97 0.02 265)',
          border: '1px solid oklch(0.85 0.04 265)',
          borderRadius: 10,
          display: 'flex', alignItems: 'center', gap: 10,
          fontSize: 12.5
        }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M3 7l3 3 5-6" stroke="var(--c-indigo)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <span>聚焦中：<b style={{ color: 'var(--c-indigo)' }}>{focusedSource}</b> · 所有图表已联动</span>
          <button className="btn" style={{ marginLeft: 'auto', height: 24, fontSize: 11.5 }}
            onClick={() => setFocusedSource(null)}>取消聚焦</button>
        </div>
      )}

      {!trustOnly && dashboardOverview}

      <DataSourceStatusPanel
        runtime={M.meta?.runtime}
        visibleCounts={{
          dailyRows: filtered.length,
          sessionRows: filteredSessions.length,
          tokenEventRows: M.meta?.runtime?.counts?.tokenEventRows || 0
        }}
        periodLabel={periodLabelForFilters(filters)}
        coverage={collectionCoverage}
        coverageLoading={coverageLoading}
        coverageError={coverageError}
        collecting={collecting}
        collectStatus={collectStatus}
        onRunCoverage={onLoadCollectionCoverage}
        onStartCollect={onCollect}
        onRefresh={onRefresh} />

      <LocalTrustWorkbenchPanel
        trust={visibleLocalTrust}
        periodLabel={periodLabelForFilters(filters)}
        onRunCoverage={onLoadCollectionCoverage}
        onOpenImportBudget={() => setImportBudgetOpen(true)} />

      <TrustEvidenceQueuePanel
        state={trustEvidenceState}
        trust={visibleLocalTrust}
        onGenerate={loadTrustEvidenceQueue}
        onApply={applyTrustEvidenceSuggestion} />

      {trustOnly ? (
        <>
          <CollectionCoveragePanel
            coverage={collectionCoverage}
            loading={coverageLoading}
            error={coverageError}
            demoMode={M.meta?.demoMode}
            onRefresh={onLoadCollectionCoverage} />
          <SourceHealthPanel
            rows={M.meta?.sourceHealth || []}
            coverageBridge={M.meta?.coverageBridge}
            visibleUsage={visibleSourceUsage}
            periodLabel={periodLabelForFilters(filters)}
            onOpenImportBudget={() => setImportBudgetOpen(true)} />
          {importBudgetOpen && (
            <ImportBudgetModal
              sources={allSources}
              budgetProfiles={M.budgetProfiles || []}
              onImportCcusageJson={onImportCcusageJson}
              onSaveBudgetProfile={onSaveBudgetProfile}
              onDeleteBudgetProfile={onDeleteBudgetProfile}
              onClose={() => setImportBudgetOpen(false)} />
          )}
        </>
      ) : (
      <>

      <OfficialPricingNotice meta={M.meta?.officialPricing} visibleCostUSD={totals.costUSD} />
      <CollectionCoveragePanel
        coverage={collectionCoverage}
        loading={coverageLoading}
        error={coverageError}
        demoMode={M.meta?.demoMode}
        onRefresh={onLoadCollectionCoverage} />
      <ProjectCoveragePanel
        coverage={M.meta?.projectCoverage}
        workflow={M.meta?.reviewWorkflow}
        autoPlan={autoAttributionPlan}
        busy={autoAttributionBusy}
        message={autoAttributionMessage}
        lastRunId={lastAutoRunId}
        onApply={applyHighConfidenceAutoAttribution}
        onUndo={undoLastAutoAttribution} />
      <ModelUsageOverview
        rows={modelUsageRows}
        selectedModels={filters.models}
        onToggleModel={toggleModelFilter}
        onClearModels={clearModelFilter} />
      <AutoAttributionPanel
        plan={autoAttributionPlan}
        coverage={M.meta?.projectCoverage} />
      <AttributionOverview
        rows={attributionStatusSummary}
        totalTokens={sessionTotals.totalTokens}
        totalSessions={sessionTotals.sessionCount}
        onQuickAttribute={() => {
          setQuickAttributionError(null);
          setQuickAttributionOpen(true);
        }} />
      <RoiReview
        riskRows={riskDistribution}
        projectRows={projectRoiRows}
        weeklyReview={weeklyReview}
        totalTokens={sessionTotals.totalTokens} />

      <FirstRunPanel
        state={firstRunState}
        onOpenImportBudget={() => setImportBudgetOpen(true)} />
      <SourceHealthPanel
        rows={M.meta?.sourceHealth || []}
        coverageBridge={M.meta?.coverageBridge}
        visibleUsage={visibleSourceUsage}
        periodLabel={periodLabelForFilters(filters)}
        onOpenImportBudget={() => setImportBudgetOpen(true)} />

      <div className="grid">
        <div className="col-12">
          <TablePanel
            daily={filtered}
            sessions={filteredSessionsWithAutoSuggestions}
            unattributedSessions={unattributedSessions}
            runs={filteredRuns}
            taskTypes={taskTypes}
            outputStatuses={outputStatuses}
            workPurposes={workPurposes}
            workStages={workStages}
            valueLevels={valueLevels}
            outputTypes={outputTypes}
            projectAliasRules={M.meta?.projectAliasRules || []}
            projectAliasMatchTypes={M.meta?.projectAliasMatchTypes || ['prefix']}
            totalTokens={totals.totalTokens}
            sessionTotalTokens={sessionTotals.totalTokens}
            onSaveAnnotation={onSaveAnnotation}
            onBatchSaveAnnotations={onBatchSaveAnnotations}
            onDeleteAnnotation={onDeleteAnnotation}
            onSaveOutput={onSaveOutput}
            onDeleteOutput={onDeleteOutput}
            onSaveProjectAliasRule={onSaveProjectAliasRule}
            onDeleteProjectAliasRule={onDeleteProjectAliasRule}
            onCreateBackup={onCreateBackup}
            onExportAnnotations={onExportAnnotations}
            onImportAnnotations={onImportAnnotations}
            onDrill={setDrill} />
        </div>
      </div>

      <div className="grid">
        <div className="col-12">
          <Heatmap rows={filtered} dates={dates} hourlyPattern={M.HOURLY} />
        </div>
      </div>

      <DrillDrawer drill={drill} daily={M.daily} onClose={() => setDrill(null)} />
      {quickAttributionOpen && (
        <BatchAnnotationModal
          count={unattributedSessions.length}
          taskTypes={taskTypes}
          outputStatuses={outputStatuses}
          workPurposes={workPurposes}
          workStages={workStages}
          valueLevels={valueLevels}
          annotationPresets={readAnnotationPresets()}
          busy={quickAttributionBusy}
          error={quickAttributionError}
          onSave={saveQuickAttribution}
          onClose={() => {
            if (!quickAttributionBusy) {
              setQuickAttributionOpen(false);
              setQuickAttributionError(null);
            }
          }} />
      )}
      {importBudgetOpen && (
        <ImportBudgetModal
          sources={allSources}
          budgetProfiles={M.budgetProfiles || []}
          onImportCcusageJson={onImportCcusageJson}
          onSaveBudgetProfile={onSaveBudgetProfile}
          onDeleteBudgetProfile={onDeleteBudgetProfile}
          onClose={() => setImportBudgetOpen(false)} />
      )}
      </>
      )}
      <footer className="app-legal-notice">{U.LEGAL_NOTICE}</footer>
    </div>
  );
}

function DataSourceStatusPanel({
  runtime,
  visibleCounts,
  periodLabel,
  coverage,
  coverageLoading,
  coverageError,
  collecting,
  collectStatus,
  onRunCoverage,
  onStartCollect,
  onRefresh
}) {
  const dataMode = runtime?.dataMode || {};
  const counts = visibleCounts || runtime?.counts || {};
  const coverageGate = runtime?.coverageGate || {};
  const modeClass = dataMode.severity || dataMode.id || 'unknown';
  const canCollect = !runtime?.demoMode && !collecting;
  const hasCoverage = Boolean(coverage);
  const coverageSummary = hasCoverage
    ? coverageTrustSentence(coverage)
    : coverageGate.status === 'passed'
      ? `最近 coverage gate 通过：${coverageRangeText(coverageGate.firstTimestamp, coverageGate.lastTimestamp)}`
      : '还没有在当前浏览器运行只读 coverage gate。';

  return (
    <section className={`data-source-status-panel mode-${modeClass}`} aria-label="数据来源状态">
      <div className="data-source-status-main">
        <div>
          <div className="eyebrow">数据来源状态</div>
          <h2>{dataMode.label || 'Unknown data mode'}</h2>
          <p>{dataMode.message || '正在读取本地 SQLite 状态。'}</p>
          {periodLabel && <p className="data-source-period">当前时间范围：{periodLabel}</p>}
        </div>
        <div className="data-source-version">
          <span>元衡</span>
          <strong>v{runtime?.packageVersion || 'unknown'}</strong>
        </div>
      </div>

      <div className="data-source-status-grid">
        <DataSourceMetric label="日汇总行" value={U.compactCN(counts.dailyRows || 0)} />
        <DataSourceMetric label="Session 行" value={U.compactCN(counts.sessionRows || 0)} />
        <DataSourceMetric label="Event token 行" value={U.compactCN(counts.tokenEventRows || 0)} detail="全量 event 计数" />
        <DataSourceMetric label="SQLite" value={runtime?.db?.kind || 'unknown'} detail={runtime?.db?.fileName || ''} />
      </div>

      <div className="real-collect-guide">
        <div className="real-collect-step">
          <span>1</span>
          <div>
            <strong>先做只读 coverage</strong>
            <p>{coverageSummary}</p>
            {coverageError && <em>{coverageError}</em>}
          </div>
        </div>
        <div className="real-collect-step">
          <span>2</span>
          <div>
            <strong>按可信来源采集写入</strong>
            <p>通过检查后才写入本地 SQLite；写入前会备份，detected-only 来源不会当作成功采集。</p>
            {collectStatus?.message && <em>{collectStatus.message}</em>}
          </div>
        </div>
        <div className="real-collect-step">
          <span>3</span>
          <div>
            <strong>刷新后查看 token_events</strong>
            <p>token_events 大于 0 表示当前看板读到了 event 级 token 记录；可信度仍以只读检查结果为准。</p>
          </div>
        </div>
      </div>

      <div className="data-source-actions">
        <button className="btn btn-primary" onClick={onRunCoverage} disabled={coverageLoading || collecting || runtime?.demoMode}>
          {coverageLoading ? '只读检查中' : '运行只读 coverage'}
        </button>
        <button className="btn" onClick={onStartCollect} disabled={!canCollect}>
          {collecting ? '采集中' : '采集写入 SQLite'}
        </button>
        <button className="btn" onClick={onRefresh}>刷新看板</button>
      </div>
      {runtime?.demoMode && (
        <div className="data-source-footnote">Demo 模式不会扫描真实 `.claude` / `.codex` 日志。要看真实数据，请用 `token-work start` 打开真实 SQLite。</div>
      )}
    </section>
  );
}

function DataSourceMetric({ label, value, detail = '' }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}

function coverageTrustSentence(coverage) {
  const trusted = (coverage.sources || []).filter(source => source.coverageRisk === 'trusted-event-level');
  const cursor = (coverage.sources || []).find(source => source.id === 'cursor');
  const cursorText = cursor?.coverageRisk === 'detected-no-token-fields'
    ? '；Cursor 检测到但无可靠 token 字段'
    : '';
  if (trusted.length) {
    return `${trusted.map(source => source.label || source.id).join(' / ')} 已通过 event/session/daily 校验${cursorText}。`;
  }
  return `还没有可信 event 级来源${cursorText}。`;
}

function LocalTrustWorkbenchPanel({ trust, periodLabel, onRunCoverage, onOpenImportBudget }) {
  if (!trust) return null;
  const conclusion = trust.conclusion || {};
  const reconciliation = trust.reconciliation || {};
  const sources = (trust.sources || []).slice(0, 8);
  const samples = trust.samples || [];
  const evidence = trust.evidence || {};
  const security = trust.security || {};
  const level = conclusion.level || 'unknown';

  return (
    <section className={`local-trust-panel trust-${level}`} aria-label="本地可信工作台">
      <div className="local-trust-head">
        <div>
          <div className="eyebrow">Local Trust Workbench</div>
          <h2>{conclusion.title || '当前数据可信度待确认'}</h2>
          <p>{conclusion.decision || '这里集中解释数据模式、coverage、总量校验、来源失败原因和脱敏样本。'}</p>
          {periodLabel && <p className="local-trust-period">当前时间范围：{periodLabel}</p>}
        </div>
        <div className="local-trust-actions">
          <span className={`trust-badge trust-badge-${level}`}>{trustDecisionLabel(level)}</span>
          <button className="btn" onClick={onRunCoverage}>只读 coverage</button>
          <button className="btn btn-primary" onClick={onOpenImportBudget}>导入 ccusage JSON</button>
        </div>
      </div>

      <div className="local-trust-summary">
        <TrustStat label="数据模式" value={trust.dataMode?.label || 'Unknown'} detail={trust.dataMode?.message || ''} />
        <TrustStat label="API 边界" value={security.title || '本机保护待确认'} detail={security.decision || '普通 API 应保持 loopback + local Origin。'} />
        <TrustStat label="总量校验" value={reconciliation.statusLabel || '未校验'} detail={reconciliation.note || ''} />
        <TrustStat label="Token Events" value={U.compactCN(trust.counts?.tokenEventRows || 0)} detail={`${U.compactCN(reconciliation.eventTotalTokens || 0)} tokens`} />
        <TrustStat label="可信证据" value={U.compactCN(evidence.trustedTokenTotal || 0)} detail={`${evidence.trustedSessionCount || 0} sessions 可进入证据飞轮`} />
      </div>

      <div className="local-trust-body">
        <div className="local-trust-card">
          <div className="local-trust-card-head">
            <strong>来源结论</strong>
            <span>为什么有 / 没有数据</span>
          </div>
          <div className="local-trust-source-list">
            {sources.length === 0 && <div className="empty compact-empty">暂无来源可信度数据</div>}
            {sources.map(source => (
              <article key={source.id} className={`local-trust-source status-${source.status || 'unknown'}`}>
                <div>
                  <strong>{source.label}</strong>
                  <span>{source.statusLabel} · {source.conclusion}</span>
                </div>
                <p>{source.reason}</p>
                <small>
                  {U.compactCN(source.sessions || 0)} sessions · {U.compactCN(source.tokenEvents || 0)} events · {U.compactCN(source.totalTokens || 0)} tokens
                </small>
              </article>
            ))}
          </div>
        </div>

        <div className="local-trust-card">
          <div className="local-trust-card-head">
            <strong>API 本机保护</strong>
            <span>{security.level === 'remote-ingest' ? '远程 ingest 已开启' : '默认本机模式'}</span>
          </div>
          <div className={`local-trust-security security-${security.level || 'unknown'}`}>
            <div>
              <span>绑定</span>
              <strong>{security.bindHost || '127.0.0.1'}</strong>
            </div>
            <div>
              <span>读取</span>
              <strong>{security.readGuard || 'loopback + local Origin'}</strong>
            </div>
            <div>
              <span>写入</span>
              <strong>{security.writeGuard || 'loopback + local Origin + JSON'}</strong>
            </div>
            <p>{security.action || '保持默认本机启动，不要把 Dashboard API 当远程服务暴露。'}</p>
          </div>

          <div className="local-trust-card-head local-trust-card-head-spaced">
            <strong>Coverage → Evidence</strong>
            <span>可信来源如何变成复盘证据</span>
          </div>
          <div className="local-trust-evidence-flow">
            <div>
              <span>已覆盖来源</span>
              <strong>{evidence.successfulCoverageSources || 0}</strong>
            </div>
            <div>
              <span>可信 session</span>
              <strong>{U.compactCN(evidence.trustedSessionCount || 0)}</strong>
            </div>
            <div>
              <span>待确认草稿</span>
              <strong>{U.compactCN(evidence.draftCount || 0)}</strong>
            </div>
            <p>{evidence.conclusion || evidence.nextAction || '先确认最高成本证据缺口。'}</p>
          </div>
        </div>

        <div className="local-trust-card">
          <div className="local-trust-card-head">
            <strong>脱敏 sample rows</strong>
            <span>只看 source / model / session / token / time</span>
          </div>
          <div className="local-trust-sample-wrap">
            {samples.length === 0 ? (
              <div className="empty compact-empty">暂无 event 级样本。聚合旧库只能看趋势。</div>
            ) : (
              <table className="local-trust-sample-table">
                <thead>
                  <tr>
                    <th>来源</th>
                    <th>模型</th>
                    <th>Session</th>
                    <th>Tokens</th>
                    <th>时间</th>
                  </tr>
                </thead>
                <tbody>
                  {samples.slice(0, 8).map((row, index) => (
                    <tr key={`${row.source}-${row.model}-${row.session}-${row.timestamp}-${index}`}>
                      <td>{row.source || '—'}</td>
                      <td>{row.model || '—'}</td>
                      <td>{row.session || '—'}</td>
                      <td>{U.compactCN(row.totalTokens || 0)}</td>
                      <td>{String(row.timestamp || '').slice(0, 16) || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <p className="local-trust-privacy">{trust.privacy?.note}</p>
        </div>
      </div>

      <div className="local-trust-next">
        <strong>下一步：</strong>
        <span>{conclusion.action || evidence.nextAction || '先确认 coverage，再进入 /review 生成复盘证据。'}</span>
      </div>
    </section>
  );
}

function TrustEvidenceQueuePanel({ state, trust, onGenerate, onApply }) {
  const queue = state.queue;
  const rows = queue?.rows || [];
  const trustConclusion = trust?.conclusion || {};
  const canReview = Boolean(trustConclusion.canUseForRoiReview);

  return (
    <section className="trust-evidence-panel" aria-label="可信证据队列">
      <div className="trust-evidence-head">
        <div>
          <div className="eyebrow">Trust-to-Evidence Autopilot</div>
          <h2>把可信 token 变成待处理证据队列</h2>
          <p>只从可信来源 session 里挑最高价值的 10 条，按官方价和 token 降序；自动建议带置信度和原因，不覆盖人工确认。</p>
        </div>
        <div className="trust-evidence-actions">
          <span className={`trust-badge ${canReview ? 'trust-badge-trusted' : 'trust-badge-needs-coverage'}`}>
            {canReview ? '可信来源可复盘' : '先确认可信来源'}
          </span>
          <button className="btn btn-primary" onClick={onGenerate} disabled={state.busy}>
            {state.busy ? '生成中' : '生成证据队列'}
          </button>
        </div>
      </div>

      <div className="trust-evidence-summary">
        <TrustStat label="可信来源" value={queue?.trustedSourceCount ?? trust?.evidence?.successfulCoverageSources ?? 0}
          detail={(queue?.trustedSourceLabels || []).join(' / ') || '来自 Local Trust 的可信覆盖来源'} />
        <TrustStat label="队列候选" value={rows.length}
          detail={`${queue?.canApplyCount || 0} 条可自动写入，${queue?.draftCount || 0} 条待确认`} />
        <TrustStat label="覆盖 tokens" value={U.compactCN(queue?.totalTokens || 0)}
          detail={queue?.totalCostUSD ? `${U.money(queue.totalCostUSD)} 官方价换算` : '未定价或尚未生成'} />
      </div>

      {state.error && <div className="inline-error">{state.error}</div>}
      {state.message && !state.error && <div className="inline-success">{state.message}</div>}

      {!queue && (
        <div className="trust-evidence-empty">
          <strong>先生成队列</strong>
          <p>系统会读取当前可信来源 session，找出项目、任务、阶段、价值或产出链接缺口。不会读取正文、diff 或完整路径。</p>
        </div>
      )}

      {queue && rows.length === 0 && (
        <div className="trust-evidence-empty">
          <strong>暂时没有可操作证据</strong>
          <p>{queue.nextAction}</p>
        </div>
      )}

      {rows.length > 0 && (
        <div className="trust-evidence-list">
          {rows.map((row, index) => (
            <article key={row.suggestionId || `${row.source}-${row.sessionId}-${index}`} className={`trust-evidence-row ${row.canApply ? 'can-apply' : 'draft'}`}>
              <div className="trust-evidence-rank">{String(index + 1).padStart(2, '0')}</div>
              <div className="trust-evidence-main">
                <div className="trust-evidence-row-head">
                  <strong>{row.project}</strong>
                  <span>{row.provenance} · {row.confidence}%</span>
                </div>
                <h3>{row.title}</h3>
                <p>{row.reason}</p>
                <div className="trust-evidence-tags">
                  <span>{row.source}</span>
                  {row.model && <span>{row.model}</span>}
                  <span>{row.whyTrusted}</span>
                </div>
                <div className="trust-evidence-missing">
                  {(row.missingFields.length ? row.missingFields : ['证据字段']).map(field => (
                    <span key={field}>{field}</span>
                  ))}
                </div>
              </div>
              <div className="trust-evidence-side">
                <strong>{U.compactCN(row.totalTokens)}</strong>
                <span>{row.costUSD > 0 ? U.money(row.costUSD) : '未定价'}</span>
                {row.canApply ? (
                  <button
                    className="btn btn-primary"
                    disabled={state.applyingId === row.suggestionId}
                    onClick={() => onApply(row.suggestionId)}
                  >
                    {state.applyingId === row.suggestionId ? '写入中' : '接受建议'}
                  </button>
                ) : (
                  <a className="btn" href="/review">编辑确认</a>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function TrustStat({ label, value, detail }) {
  return (
    <article>
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{detail}</p>
    </article>
  );
}

function trustDecisionLabel(level) {
  return ({
    trusted: '可强复盘',
    'trend-only': '只能看趋势',
    'needs-coverage': '需重新检查',
    demo: 'Demo',
    empty: '空库'
  })[level] || '待确认';
}

function FirstRunPanel({ state, onOpenImportBudget }) {
  if (!state?.shouldShow) return null;
  const primaryNotice = state.notices[0] || null;

  const runAction = (notice) => {
    if (!notice) return;
    if (notice.id === 'no-data') {
      onOpenImportBudget();
    } else if (notice.id === 'no-actions') {
      window.location.href = '/review';
    } else if (notice.id === 'budget-no-live-events') {
      window.location.href = '/live';
    }
  };

  return (
    <section className="first-run-panel" aria-label="首次使用引导">
      <div className="first-run-main">
        <div>
          <div className="eyebrow">首次使用</div>
          <h2>{primaryNotice?.title || '5 分钟跑通元衡 Token Work ROI'}</h2>
          <p>{primaryNotice?.detail || '按顺序准备数据、设置预算，再把 ROI 建议加入行动清单。'}</p>
        </div>
        <div className="first-run-actions">
          {primaryNotice && (
            <button className="btn btn-primary" onClick={() => runAction(primaryNotice)}>
              {primaryNotice.action}
            </button>
          )}
          <a className="btn" href="/review">打开 /review</a>
          <a className="btn" href="/live">打开 /live</a>
        </div>
      </div>
      <div className="first-run-steps">
        {state.steps.map(step => (
          <article key={step.id} className={`first-run-step ${step.status}`}>
            <span>{step.status === 'done' ? '已完成' : '待处理'}</span>
            <strong>{step.title}</strong>
            <p>{step.detail}</p>
          </article>
        ))}
      </div>
      {state.notices.length > 1 && (
        <div className="first-run-notices">
          {state.notices.slice(1).map(notice => (
            <button key={notice.id} type="button" onClick={() => runAction(notice)}>
              <strong>{notice.title}</strong>
              <span>{notice.action}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function SourceHealthPanel({ rows = [], coverageBridge = null, visibleUsage = null, periodLabel, onOpenImportBudget }) {
  const bridgeRows = coverageBridge?.rows || [];
  if (!rows.length && !bridgeRows.length) return null;
  const bridgeById = new Map(bridgeRows.map(row => [row.id, row]));
  const hasVisibleUsage = visibleUsage instanceof Map;
  const visibleUsageMap = hasVisibleUsage ? visibleUsage : new Map();
  const activeRows = rows.filter(row => row.detected || row.sessions || row.tokenEvents || row.dailyRows || row.supportStatus === 'import-only');
  const visibleRows = (bridgeRows.length ? bridgeRows.map(row => ({
    ...(rows.find(source => source.id === row.id) || {}),
    ...row,
    bridgeStatus: row.status,
    bridgeStatusLabel: row.statusLabel
  })) : [
    ...activeRows,
    ...rows.filter(row => !activeRows.includes(row)).slice(0, Math.max(0, 8 - activeRows.length))
  ]).slice(0, 10).map(row => {
    const bridge = bridgeById.get(row.id) || row;
    const usage = findVisibleSourceUsage(visibleUsageMap, row);
    const reconciliationRisk = row.reconciliation?.status === 'risk';
    return {
      ...row,
      sessions: usage ? usage.sessions : hasVisibleUsage ? 0 : row.sessions,
      dailyRows: usage ? usage.dailyRows : hasVisibleUsage ? 0 : row.dailyRows,
      totalTokens: usage ? usage.totalTokens : hasVisibleUsage ? 0 : row.totalTokens,
      bridgeStatus: reconciliationRisk ? 'native-unverified' : bridge.status || bridge.bridgeStatus || supportStatusToBridgeStatus(row),
      bridgeStatusLabel: reconciliationRisk ? '原生数据待核查' : bridge.statusLabel || bridge.bridgeStatusLabel || bridgeStatusLabel(supportStatusToBridgeStatus(row)),
      recommendedAction: reconciliationRisk ? row.reconciliation.note : bridge.recommendedAction || row.recommendedImport || sourceHealthStatusLabel(row),
      privacy: bridge.privacy || (row.readsConversationContent ? '可能读取内容' : '不读取正文')
    };
  });
  const periodRowsWithUsage = visibleRows.filter(row =>
    Number(row.sessions || 0) > 0 || Number(row.dailyRows || 0) > 0 || Number(row.totalTokens || 0) > 0
  );
  const visibleSourcesWithUsage = periodRowsWithUsage.length;
  const periodGroups = {
    nativeTrusted: periodRowsWithUsage.filter(row => row.bridgeStatus === 'native-trusted').length,
    importable: periodRowsWithUsage.filter(row => row.bridgeStatus === 'ccusage-importable').length,
    experimental: periodRowsWithUsage.filter(row => row.bridgeStatus === 'experimental-audit').length,
    detectedOnly: periodRowsWithUsage.filter(row => row.bridgeStatus === 'detected-only').length,
    unsupported: periodRowsWithUsage.filter(row => row.bridgeStatus === 'unsupported' || row.bridgeStatus === 'no-token-fields').length
  };

  return (
    <section className="source-health-panel" aria-label="Coverage Bridge Center">
      <div className="source-health-head">
        <div>
          <div className="eyebrow">Coverage Bridge Center</div>
          <h2>覆盖方式要分清：原生可信、ccusage 可导入、仅检测到</h2>
          <p>这里解释每个工具为什么有或没有 token 数据。只有“原生可信采集”和成功导入的结构化 JSON 才算用量覆盖；“实验采集”和“仅检测到”不会伪造成 token。</p>
          {periodLabel && <p className="source-health-period">当前时间范围：{periodLabel}</p>}
        </div>
        <div className="source-health-actions">
          <button className="btn btn-primary" onClick={onOpenImportBudget}>生成 ccusage 命令</button>
          <a className="btn" href="/live">查看实时限额</a>
        </div>
      </div>
      <div className="source-health-stats">
        <SourceHealthStat label="原生可信来源" value={periodGroups.nativeTrusted} />
        <SourceHealthStat label="可导入来源" value={periodGroups.importable} />
        <SourceHealthStat label="实验采集来源" value={periodGroups.experimental} />
        <SourceHealthStat label="仅检测到来源" value={periodGroups.detectedOnly} />
        <SourceHealthStat label="无 token 字段来源" value={periodGroups.unsupported} />
        <SourceHealthStat label="当前有用量来源" value={visibleSourcesWithUsage} />
      </div>
      <div className="source-health-grid">
        {visibleRows.map(row => (
          <article key={row.id} className={`source-health-card status-${row.bridgeStatus || row.supportStatus} health-${row.health}`}>
            <div className="source-health-card-top">
              <strong>{sourceHealthLabel(row)}</strong>
              <span>{row.bridgeStatusLabel || sourceTierLabel(row)}</span>
            </div>
            <div className="source-health-card-meta">
              <span>{row.detected ? '已检测到' : '未检测到'}</span>
              <span>{row.privacy || (row.readsConversationContent ? '可能读取内容' : '不读取正文')}</span>
              <span>{row.tokenReliabilityLabel || tokenReliabilityLabel(row.tokenReliability)}</span>
            </div>
            <div className="source-health-card-counts">
              <b>{U.compactCN(row.sessions || 0)}</b>
              <span>会话数</span>
              <b>{U.compactCN(row.tokenEvents || 0)}</b>
              <span>事件数（全量）</span>
              <b>{U.compactCN(row.totalTokens || 0)}</b>
              <span>Token</span>
            </div>
            <div className="source-health-run">
              <span>{sourceHealthStatusLabel(row)}</span>
              {row.lastRunMessage && <small>{row.lastRunMessage}</small>}
            </div>
            <div className="source-health-recommendation">
              <span>{row.workflow?.label || '推荐方式'}</span>
              <p>{row.whyNoData || row.workflow?.reason || row.failureReason || row.recommendedAction || row.recommendedImport || '先看 coverage，再决定是否原生采集或导入 ccusage JSON。'}</p>
              <strong>{row.recommendedPath ? `${row.recommendedPath}：` : ''}{row.workflow?.nextStep || row.recommendedAction || '先 dry-run，再确认写入。'}</strong>
            </div>
            {Array.isArray(row.importReports) && row.importReports.length > 0 && (
              <div className="source-health-reports">
                {row.importReports.slice(0, 5).map(report => (
                  <button
                    key={report.report}
                    type="button"
                    onClick={onOpenImportBudget}
                    title={report.exportCommand}
                  >
                    {report.report}
                  </button>
                ))}
              </div>
            )}
            <code>{row.commandHint}</code>
          </article>
        ))}
      </div>
    </section>
  );
}

function SourceHealthStat({ label, value }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function sourceHealthLabel(row) {
  if (row.id === 'ccusage') return 'ccusage 导入桥';
  return row.label;
}

function findVisibleSourceUsage(visibleUsage, row) {
  const candidates = [row.id, row.label, row.name, row.source]
    .filter(Boolean)
    .map(value => String(value).toLowerCase());
  for (const [key, usage] of visibleUsage.entries()) {
    const normalized = String(key || '').toLowerCase();
    if (candidates.some(candidate =>
      normalized === candidate || normalized.includes(candidate) || candidate.includes(normalized)
    )) {
      return usage;
    }
  }
  return null;
}

function sourceTierLabel(row) {
  if (row.supportStatus === 'stable') return '原生稳定';
  if (row.supportStatus === 'experimental') return '实验支持';
  if (row.supportStatus === 'import-only') return '导入桥';
  return '仅检测';
}

function supportStatusToBridgeStatus(row) {
  if (row.supportStatus === 'stable' && row.tokenReliability === 'native-token-fields') return 'native-trusted';
  if (row.supportStatus === 'import-only' || row.id === 'ccusage') return 'ccusage-importable';
  if (row.supportStatus === 'experimental') return 'experimental-audit';
  if (row.detected || row.supportStatus === 'detected-only') return 'detected-only';
  return 'unsupported';
}

function bridgeStatusLabel(status) {
  const labels = {
    'native-trusted': '原生可信采集',
    'native-unverified': '原生数据待核查',
    'ccusage-importable': 'ccusage 可导入',
    'experimental-audit': '实验采集',
    'detected-only': '仅检测到',
    unsupported: '不支持 / 无 token 字段'
  };
  return labels[status] || '待确认';
}

function tokenReliabilityLabel(value) {
  const labels = {
    'native-token-fields': '原生 token 字段',
    'explicit-token-fields-only': '只认显式 token 字段',
    'external-json-token-fields': '外部 JSON token 字段',
    'unknown-no-usage-import': '未知，不导入用量'
  };
  return labels[value] || '未知 token 口径';
}

function sourceHealthStatusLabel(row) {
  const labels = {
    'has-data': '已有真实用量',
    'reconciliation-risk': '总量待核查',
    'last-run-error': '上次采集失败',
    'detected-no-data': '检测到工具，但还没有采到 token',
    'import-ready': '可通过导入桥接入',
    seen: '曾经看到用量',
    'not-detected': '未检测到本机数据'
  };
  return labels[row.health] || '待确认';
}

function CollectConfirmModal({ busy, onClose, onConfirm }) {
  return (
    <>
      <div className="modal-backdrop open" onClick={onClose}/>
      <div className="annotation-modal collect-confirm-modal" role="dialog" aria-modal="true" aria-label="确认真实采集">
        <div className="annotation-modal-header">
          <div>
            <div className="eyebrow">真实采集确认</div>
            <h3>扫描本机 Claude / Codex 用量日志</h3>
          </div>
          <button className="drawer-close" onClick={onClose} disabled={busy}>
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path d="M3 3l7 7M10 3l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
        <div className="annotation-modal-body">
          <div className="notice-list">
            <div>本次写入只使用本机可信来源的结构化 token 日志。</div>
            <div>采集器只统计 token、模型、时间、项目路径等用量字段，不读取或展示对话正文。</div>
            <div>Cursor 当前只有明确 token 字段才会进入 coverage；不会用文本长度估算，也不会把 detected-only 写入 usage。</div>
            <div>服务端会在写入前自动复制当前 SQLite 到 `data/backups/`。</div>
          </div>
        </div>
        <div className="annotation-modal-actions">
          <button className="btn" onClick={onClose} disabled={busy}>取消</button>
          <span className="form-spacer"/>
          <button className="btn btn-primary" onClick={onConfirm} disabled={busy}>
            {busy ? '采集中' : '确认采集'}
          </button>
        </div>
      </div>
    </>
  );
}

function ImportBudgetModal({
  sources,
  budgetProfiles,
  onImportCcusageJson,
  onSaveBudgetProfile,
  onDeleteBudgetProfile,
  onClose
}) {
  const [importText, setImportText] = useState('');
  const [importDevice, setImportDevice] = useState('');
  const [importResult, setImportResult] = useState(null);
  const [importError, setImportError] = useState(null);
  const [importBusy, setImportBusy] = useState(false);
  const [bridgeReport, setBridgeReport] = useState('session');
  const [bridgeMode, setBridgeMode] = useState('dry-run');
  const [bridgeCopied, setBridgeCopied] = useState(false);
  const [budgetBusy, setBudgetBusy] = useState(false);
  const [budgetError, setBudgetError] = useState(null);
  const [budgetForm, setBudgetForm] = useState<BudgetForm>(() => ({
    source: sources[0] || 'Codex',
    modelGroup: '',
    label: '',
    windowType: 'rolling',
    windowMinutes: 60,
    resetAnchor: defaultResetAnchor(),
    warningThreshold: 0.75,
    hardThreshold: 1,
    tokenBudget: '',
    costBudgetUSD: '',
    enabled: true
  }));
  const bridgeCommand = buildCcusageBridgeCommand({
    report: bridgeReport,
    apply: bridgeMode === 'apply'
  });
  const bridgeExportCommand = buildCcusageJsonExportCommand({ report: bridgeReport });

  const runImport = async (apply) => {
    setImportBusy(true);
    setImportError(null);
    try {
      const result = await onImportCcusageJson({
        text: importText,
        device: importDevice.trim(),
        apply
      });
      setImportResult(result);
    } catch (error) {
      setImportError(error.message || 'ccusage JSON 导入失败');
    } finally {
      setImportBusy(false);
    }
  };

  const readImportFile = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setImportText(await file.text());
    setImportResult(null);
    setImportError(null);
  };

  const saveBudget = async () => {
    setBudgetBusy(true);
    setBudgetError(null);
    try {
      await onSaveBudgetProfile({
        source: budgetForm.source.trim(),
        modelGroup: budgetForm.modelGroup.trim(),
        label: budgetForm.label.trim()
          || (budgetForm.source.trim()
            ? `${budgetForm.source.trim()} custom budget`
            : budgetForm.modelGroup.trim()
              ? `${budgetForm.modelGroup.trim()} model budget`
              : 'Custom token budget'),
        windowType: budgetForm.windowType,
        windowMinutes: Number(budgetForm.windowMinutes) || 60,
        resetAnchor: budgetForm.windowType === 'fixed' ? budgetForm.resetAnchor : '',
        warningThreshold: Number(budgetForm.warningThreshold) || 0.75,
        hardThreshold: Number(budgetForm.hardThreshold) || 1,
        tokenBudget: budgetForm.tokenBudget === '' ? 0 : Number(budgetForm.tokenBudget),
        costBudgetUSD: budgetForm.costBudgetUSD === '' ? 0 : Number(budgetForm.costBudgetUSD),
        enabled: budgetForm.enabled
      });
      setBudgetForm(current => ({
        ...current,
        label: '',
        resetAnchor: defaultResetAnchor(),
        tokenBudget: '',
        costBudgetUSD: ''
      }));
    } catch (error) {
      setBudgetError(error.message || '保存预算失败');
    } finally {
      setBudgetBusy(false);
    }
  };

  const deleteBudget = async (profile) => {
    setBudgetBusy(true);
    setBudgetError(null);
    try {
      await onDeleteBudgetProfile({ id: profile.id });
    } catch (error) {
      setBudgetError(error.message || '删除预算失败');
    } finally {
      setBudgetBusy(false);
    }
  };

  const canDryRun = importText.trim().length > 0 && importDevice.trim().length > 0 && !importBusy;
  const canApply = canDryRun && importResult?.mode === 'dry-run' && !importResult.error;
  const copyBridgeCommand = async () => {
    try {
      await navigator.clipboard?.writeText(`${bridgeExportCommand}\n${bridgeCommand}`);
      setBridgeCopied(true);
      window.setTimeout(() => setBridgeCopied(false), 1600);
    } catch {
      setBridgeCopied(false);
    }
  };

  return (
    <>
      <div className="modal-backdrop open" onClick={onClose}/>
      <div className="annotation-modal import-budget-modal" role="dialog" aria-modal="true" aria-label="导入与预算">
        <div className="annotation-modal-header">
          <div>
            <div className="eyebrow">导入与预算</div>
            <h3>把 ccusage JSON 和自定义预算接入 ROI 复盘</h3>
          </div>
          <button className="drawer-close" onClick={onClose} disabled={importBusy || budgetBusy}>
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path d="M3 3l7 7M10 3l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        <div className="annotation-modal-body import-budget-body">
          <section className="import-budget-section">
            <div className="import-budget-section-head">
              <div>
                <h4>ccusage Saved JSON Import</h4>
                <p>只接受结构化 token/model/session/time/cache 字段；发现 prompt、response、transcript、diff、content 等正文风险字段会拒绝。</p>
              </div>
              <span className="tag tag-soft">默认 dry-run</span>
            </div>
            <div className="form-grid">
              <label className="form-field form-field-wide">
                <span>来源设备（必填）</span>
                <input
                  value={importDevice}
                  onChange={(event) => {
                    setImportDevice(event.target.value);
                    setImportResult(null);
                    setImportError(null);
                  }}
                  placeholder="例如：work-laptop"
                  maxLength={120}
                  required
                />
              </label>
              <label className="form-field form-field-wide">
                <span>粘贴 ccusage JSON</span>
                <textarea
                  value={importText}
                  onChange={(event) => {
                    setImportText(event.target.value);
                    setImportResult(null);
                    setImportError(null);
                  }}
                  placeholder='{"daily":[{"date":"2026-06-17","model":"claude-sonnet-4-5","inputTokens":1200,"outputTokens":300}]}'
                />
              </label>
              <label className="form-field">
                <span>或选择本地 JSON 文件</span>
                <input type="file" accept="application/json,.json" onChange={readImportFile}/>
              </label>
              <div className="import-budget-actions">
                <button className="btn" onClick={() => runImport(false)} disabled={!canDryRun}>
                  {importBusy ? '预检中' : 'Dry-run 预检'}
                </button>
                <button className="btn btn-primary" onClick={() => runImport(true)} disabled={!canApply}>
                  {importBusy ? '写入中' : 'Apply 写入 SQLite'}
                </button>
              </div>
            </div>

            {importError && <div className="form-error">{importError}</div>}
            {importResult && (
              <ImportPreview result={importResult}/>
            )}
          </section>

          <section className="import-budget-section">
            <div className="import-budget-section-head">
              <div>
                <h4>ccusage CLI Bridge</h4>
                <p>这里不从浏览器运行外部扫描器，只生成可复制命令。先用 ccusage 导出结构化 JSON，再粘贴到上方 dry-run；确认后才写入 SQLite。</p>
              </div>
              <span className="tag tag-soft">copy only</span>
            </div>
            <div className="form-grid form-grid-3">
              <label className="form-field">
                <span>Report</span>
                <select value={bridgeReport} onChange={(event) => setBridgeReport(event.target.value)}>
                  {CCUSAGE_BRIDGE_REPORTS.map(report => <option key={report} value={report}>{report}</option>)}
                </select>
              </label>
              <label className="form-field">
                <span>模式</span>
                <select value={bridgeMode} onChange={(event) => setBridgeMode(event.target.value)}>
                  <option value="dry-run">dry-run</option>
                  <option value="apply">apply</option>
                </select>
              </label>
              <div className="import-budget-actions import-budget-command-actions">
                <button className="btn" type="button" onClick={copyBridgeCommand}>
                  {bridgeCopied ? '已复制' : '复制两条命令'}
                </button>
              </div>
              <label className="form-field form-field-wide">
                <span>1. 导出 ccusage JSON</span>
                <textarea value={bridgeExportCommand} readOnly rows={2}/>
              </label>
              <label className="form-field form-field-wide">
                <span>2. Token Work bridge 命令</span>
                <textarea value={bridgeCommand} readOnly rows={2}/>
              </label>
              <div className="import-budget-note form-field-wide">
                不采用 ccusage cost 字段；Token Work 会重新按官方公开 token 价格换算。浏览器不会直接运行外部扫描器。
              </div>
            </div>
          </section>

          <section className="import-budget-section">
            <div className="import-budget-section-head">
              <div>
                <h4>Budget Wizard</h4>
                <p>只创建你自己的 source 级限额窗口，不内置或声称知道 Claude/Codex/Cursor 的真实套餐额度。</p>
              </div>
              <a className="btn" href="/live">打开 /live</a>
            </div>
            <div className="budget-template-row">
              {BUDGET_TEMPLATES.map(template => (
                <button
                  key={template.id}
                  type="button"
                  className="btn btn-mini"
                  onClick={() => setBudgetForm(current => applyBudgetTemplate(current, template))}
                >
                  {template.label}
                </button>
              ))}
            </div>
            <div className="form-grid form-grid-3">
              <label className="form-field">
                <span>Source</span>
                <input
                  list="budget-source-options"
                  value={budgetForm.source}
                  onChange={(event) => setBudgetForm({ ...budgetForm, source: event.target.value })}
                />
                <datalist id="budget-source-options">
                  {sources.some(source => /^Codex(?:\s|\()/i.test(source)) && <option value="Codex"/>}
                  {sources.map(source => <option key={source} value={source}/>)}
                </datalist>
              </label>
              <label className="form-field">
                <span>名称</span>
                <input
                  value={budgetForm.label}
                  placeholder="Codex 15m budget"
                  onChange={(event) => setBudgetForm({ ...budgetForm, label: event.target.value })}
                />
              </label>
              <label className="form-field">
                <span>模型组</span>
                <select
                  value={budgetForm.modelGroup}
                  onChange={(event) => setBudgetForm({ ...budgetForm, modelGroup: event.target.value })}
                >
                  <option value="">all models</option>
                  <option value="heavy">heavy</option>
                  <option value="mid">mid</option>
                  <option value="light">light</option>
                  <option value="unpriced">unpriced</option>
                </select>
              </label>
              <label className="form-field">
                <span>窗口类型</span>
                <select
                  value={budgetForm.windowType}
                  onChange={(event) => setBudgetForm({ ...budgetForm, windowType: event.target.value })}
                >
                  <option value="rolling">rolling</option>
                  <option value="fixed">fixed</option>
                </select>
              </label>
              <label className="form-field">
                <span>窗口分钟</span>
                <input
                  type="number"
                  min="1"
                  value={budgetForm.windowMinutes}
                  onChange={(event) => setBudgetForm({ ...budgetForm, windowMinutes: event.target.value })}
                />
              </label>
              <label className="form-field">
                <span>Reset anchor</span>
                <input
                  type="datetime-local"
                  value={budgetForm.resetAnchor}
                  disabled={budgetForm.windowType !== 'fixed'}
                  onChange={(event) => setBudgetForm({ ...budgetForm, resetAnchor: event.target.value })}
                />
              </label>
              <label className="form-field">
                <span>预警阈值</span>
                <input
                  type="number"
                  min="0.1"
                  max="1"
                  step="0.05"
                  value={budgetForm.warningThreshold}
                  onChange={(event) => setBudgetForm({ ...budgetForm, warningThreshold: event.target.value })}
                />
              </label>
              <label className="form-field">
                <span>硬阈值</span>
                <input
                  type="number"
                  min="0.5"
                  max="2"
                  step="0.05"
                  value={budgetForm.hardThreshold}
                  onChange={(event) => setBudgetForm({ ...budgetForm, hardThreshold: event.target.value })}
                />
              </label>
              <label className="form-field">
                <span>Token 预算</span>
                <input
                  type="number"
                  min="0"
                  value={budgetForm.tokenBudget}
                  placeholder="500000"
                  onChange={(event) => setBudgetForm({ ...budgetForm, tokenBudget: event.target.value })}
                />
              </label>
              <label className="form-field">
                <span>官方价预算 USD / 人民币估算</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={budgetForm.costBudgetUSD}
                  placeholder="25"
                  onChange={(event) => setBudgetForm({ ...budgetForm, costBudgetUSD: event.target.value })}
                />
              </label>
              <label className="form-field import-budget-toggle">
                <span>启用</span>
                <input
                  type="checkbox"
                  checked={budgetForm.enabled}
                  onChange={(event) => setBudgetForm({ ...budgetForm, enabled: event.target.checked })}
                />
              </label>
            </div>
            {budgetError && <div className="form-error">{budgetError}</div>}
            <div className="import-budget-actions">
              <button className="btn btn-primary" onClick={saveBudget} disabled={budgetBusy || (!budgetForm.tokenBudget && !budgetForm.costBudgetUSD)}>
                {budgetBusy ? '保存中' : '保存预算'}
              </button>
            </div>
            <BudgetProfileList profiles={budgetProfiles} busy={budgetBusy} onDelete={deleteBudget}/>
          </section>
        </div>

        <div className="annotation-modal-actions">
          <span className="muted">写入前会由服务端创建 SQLite 备份；导入完成后去 `/review` 查看 ROI 变化。</span>
          <span className="form-spacer"/>
          <button className="btn btn-primary" onClick={onClose} disabled={importBusy || budgetBusy}>完成</button>
        </div>
      </div>
    </>
  );
}

function ImportPreview({ result }) {
  const backupName = result.backup?.fileName || result.backup?.path?.split(/[\\/]/).pop();
  return (
    <div className={`import-preview import-preview-${result.mode}`}>
      <div className="import-preview-grid">
        <div><span>模式</span><strong>{result.mode}</strong></div>
        <div><span>JSON shape</span><strong>{result.detectedShape}</strong></div>
        <div><span>Daily</span><strong>{result.daily}</strong></div>
        <div><span>Sessions</span><strong>{result.sessions}</strong></div>
        <div><span>Events</span><strong>{result.tokenEvents}</strong></div>
        <div><span>写入</span><strong>{result.applied ? '已写入' : '未写入'}</strong></div>
      </div>
      {backupName && <p>备份：{backupName}</p>}
      {result.warnings?.length > 0 && (
        <div className="import-warning-list">
          {result.warnings.slice(0, 4).map((warning, index) => (
            <div key={`${warning.type}:${warning.model}:${index}`}>
              <strong>{warning.type}</strong>
              <span>{warning.model || 'unknown'} · {warning.reason}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BudgetProfileList({ profiles, busy, onDelete }) {
  if (!profiles.length) {
    return <div className="empty compact-empty">还没有预算窗口。先给常用 source 建一个自定义 token 或官方价预算。</div>;
  }
  return (
    <div className="budget-profile-list">
      {profiles.map(profile => (
        <article key={profile.id} className={`budget-profile-row ${profile.enabled ? 'enabled' : 'disabled'}`}>
          <div>
            <strong>{profile.label}</strong>
            <span>
              {profile.source || 'all sources'} · {profile.windowType || 'rolling'} · {profile.windowMinutes} min
              {profile.modelGroup ? ` · ${profile.modelGroup} models` : ''}
              {profile.resetAnchor ? ` · reset ${profile.resetAnchor}` : ''}
              {' '}· warn {Math.round(Number(profile.warningThreshold || 0.75) * 100)}%
              {' '}· hard {Math.round(Number(profile.hardThreshold || 1) * 100)}% · {profile.enabled ? '生效中' : '已停用'}
            </span>
          </div>
          <div>
            <b>{profile.tokenBudget ? `${U.compactCN(profile.tokenBudget)} tokens` : '— tokens'}</b>
            <span>{profile.costBudgetUSD ? U.money(profile.costBudgetUSD) : '—'}</span>
          </div>
          <button className="btn btn-mini" onClick={() => onDelete(profile)} disabled={busy}>删除</button>
        </article>
      ))}
    </div>
  );
}

function OfficialPricingNotice({ meta, visibleCostUSD }) {
  if (!meta) return null;
  const unpriced = (meta.unpricedModels || []).filter(item => (item.totalTokens || 0) > 0);
  const pricedPct = ((meta.pricedShare ?? 1) * 100).toFixed(1);
  const visible = Number.isFinite(visibleCostUSD) ? visibleCostUSD : 0;

  return (
    <section className="pricing-notice" aria-label="官方价格口径">
      <div>
        <div className="eyebrow">官方价格口径</div>
        <strong>当前筛选官方价合计 {U.money(visible)}</strong>
        <span>
          按官网公开的 USD / 1M token 单价换算，人民币按 {U.exchangeRateLabel()} 换算，覆盖 {pricedPct}% token；
          {U.exchangeRateSourceLabel()}。
          未包含订阅额度、折扣、税费、Batch/Flex/Priority、区域加价或未公开价格模型。
        </span>
      </div>
      {unpriced.length > 0 && (
        <div className="pricing-unpriced">
          <span>未定价</span>
          {unpriced.slice(0, 4).map(item => (
            <b key={item.model} title={item.reason}>{item.model} · {U.compactCN(item.totalTokens)}</b>
          ))}
        </div>
      )}
    </section>
  );
}

function CollectionCoveragePanel({ coverage, loading, error, demoMode, onRefresh }) {
  const sources = coverage?.sources || [];
  const totals = coverage?.totals || {};
  const notChecked = !loading && !coverage && !error;
  const rangeText = coverageRangeText(totals.firstTimestamp, totals.lastTimestamp);
  const trustedSources = sources.filter(source => source.coverageRisk === 'trusted-event-level').length;
  const blockedSources = sources.filter(source => source.fatalCoverageError || String(source.coverageRisk || '').startsWith('blocking')).length;

  return (
    <section className={`collection-coverage-panel ${demoMode ? 'demo' : ''}`} aria-label="真实采集可信度">
      <div className="collection-coverage-head">
        <div>
          <div className="eyebrow">真实采集可信度</div>
          <h2>{demoMode ? '当前是 Demo 数据，不代表真实采集成功' : '先确认历史 token 是否真的采到了'}</h2>
          <p>这里回答“从哪天到哪天、多少文件、多少可解析记录、多少真实 session/event、哪里没覆盖”。工具来源覆盖在下面，只说明支持状态。</p>
        </div>
        <div className="collection-coverage-actions">
          <button className="btn" onClick={onRefresh} disabled={loading}>
            {loading ? '检查中' : coverage ? '重新检查' : '运行只读检查'}
          </button>
        </div>
      </div>

      {error && <div className="collection-coverage-error">{error}</div>}

      <div className="collection-coverage-stats">
        <CoverageStat label="可信来源" value={`${trustedSources}/${sources.length || 0}`} detail="event/session/daily 可校验" />
        <CoverageStat label="历史范围" value={rangeText} detail="来自 token event 时间" />
        <CoverageStat label="可解析记录" value={U.compactCN(totals.usableTokenRecords || 0)} detail={`${U.compactCN(totals.candidateFiles || 0)} 个候选文件`} />
        <CoverageStat label="Token Events" value={U.compactCN(totals.tokenEvents || 0)} detail={`${U.compactCN(totals.eventTotalTokens || 0)} token`} />
        <CoverageStat label="阻塞风险" value={blockedSources ? `${blockedSources} 个` : '无'} detail="apply 前会被拦截" />
      </div>

      <div className="collection-coverage-grid">
        {(loading && !coverage) ? (
          <article className="collection-coverage-card pending">
            <strong>正在做只读 dry-run</strong>
            <p>不会写 SQLite，不读取正文；只统计结构化 token 字段。</p>
          </article>
        ) : notChecked ? (
          <article className="collection-coverage-card pending">
            <strong>尚未检查本机历史覆盖</strong>
            <p>点击“运行只读检查”后才会扫描本机结构化 token 元数据；不会写 SQLite，不读取正文。</p>
          </article>
        ) : sources.map(source => (
          <article key={source.id} className={`collection-coverage-card risk-${coverageRiskClass(source.coverageRisk)}`}>
            <div className="collection-coverage-card-top">
              <strong>{source.label || source.id}</strong>
              <span>{coverageRiskLabel(source.coverageRisk)}</span>
            </div>
            <p>{coverageStatusText(source)}</p>
            <div className="collection-coverage-counts">
              <span><b>{U.compactCN(source.candidateFiles || 0)}</b>候选文件</span>
              <span><b>{U.compactCN(source.usableTokenRecords || 0)}</b>可解析记录</span>
              <span><b>{U.compactCN(source.sessionRows || 0)}</b>session</span>
              <span><b>{U.compactCN(source.tokenEvents || 0)}</b>event</span>
            </div>
            <div className="collection-coverage-range">
              {coverageRangeText(source.firstTimestamp, source.lastTimestamp)}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function CoverageStat({ label, value, detail }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function coverageRiskLabel(value) {
  const labels = {
    'trusted-event-level': '可信 event 级',
    'detected-no-token-fields': '检测到但无 token',
    'blocking-no-events': '阻塞：无事件',
    'blocking-reconciliation-mismatch': '阻塞：总量不一致',
    'not-detected': '未检测到',
    'aggregate-only': '仅聚合',
    'collector-error': '采集器错误',
    'demo-data': 'Demo 合成数据',
    empty: '无可用数据'
  };
  return labels[value] || '待确认';
}

function coverageRiskClass(value) {
  if (value === 'trusted-event-level') return 'trusted';
  if (value === 'demo-data') return 'demo';
  if (value === 'detected-no-token-fields' || value === 'aggregate-only') return 'warn';
  if (String(value || '').startsWith('blocking') || value === 'collector-error') return 'bad';
  return 'neutral';
}

function coverageStatusText(source) {
  if (source.coverageRisk === 'detected-no-token-fields') {
    return '检测到本机工具数据，但当前没有可靠 tokenCount 字段；不会估算，也不会写 usage。';
  }
  return source.coverageStatus || '暂无采集可信度说明';
}

function coverageRangeText(first, last) {
  if (!first && !last) return '无历史范围';
  const f = first ? String(first).slice(0, 10) : '?';
  const l = last ? String(last).slice(0, 10) : '?';
  return `${f} ~ ${l}`;
}

function ModelUsageOverview({ rows, selectedModels, onToggleModel, onClearModels }) {
  const selectedCount = selectedModels?.size || 0;
  const visibleRows = rows;
  return (
    <section className="model-overview" aria-label="模型使用概览">
      <div className="model-overview-head">
        <div>
          <div className="eyebrow">模型使用看板</div>
          <h2>按模型筛选 Token 与官方价</h2>
        </div>
        <div className="model-overview-actions">
          {selectedCount > 0 && <button className="btn" onClick={onClearModels}>全部模型</button>}
          <span>{selectedCount > 0 ? `${selectedCount} 个模型已筛选` : `${rows.length} 个模型`}</span>
        </div>
      </div>
      <div className="model-card-grid">
        {visibleRows.length === 0 && <div className="empty compact-empty">当前筛选下无模型数据</div>}
        {visibleRows.map(row => {
          const active = selectedModels?.has(row.model);
          return (
            <button
              key={row.model}
              type="button"
              className={`model-card ${active ? 'active' : ''}`}
              onClick={() => onToggleModel(row.model)}
              title={row.model}>
              <div className="model-card-top">
                <strong className="mono">{row.model}</strong>
                <span>{row.pricingStatus}</span>
              </div>
              <div className="model-card-value">{U.compactCN(row.totalTokens)}</div>
              <div className="model-card-meta">
                <span>{row.sessionCount} sessions</span>
                <span>{row.costUSD > 0 ? U.money4(row.costUSD) : row.pricingStatus}</span>
              </div>
              <div className="model-card-sub">
                <span>{row.dayCount} 天</span>
                <span>{row.sources.join(' / ') || '—'}</span>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function ProjectCoveragePanel({ coverage, workflow, autoPlan, busy, message, lastRunId, onApply, onUndo }) {
  if (!coverage) return null;
  const recognizedPct = (coverage.recognizedShare || 0) * 100;
  const completePct = (coverage.attributionCompletionShare || 0) * 100;
  const pendingPct = (coverage.pendingTokenShare || 0) * 100;
  const reduction = Math.max(0, Math.min(1, autoPlan?.estimatedReductionShare || 0));
  return (
    <section className="project-coverage-panel" aria-label="项目覆盖与归因进度">
      <div className="project-coverage-head">
        <div>
          <div className="eyebrow">项目覆盖与归因进度</div>
          <h2>先把真实项目认出来，再让系统自动补大部分归因</h2>
          <p>这里统计的是你的真实项目和 session 归因，不是工具来源数量。自动归因只用结构化元数据，不读正文、不调用 LLM。</p>
        </div>
        <div className="project-coverage-actions">
          <button className="btn btn-primary" onClick={onApply} disabled={busy || !autoPlan || autoPlan.highConfidenceCount === 0}>
            {busy ? '归因中' : `一键懒人归因 ${autoPlan?.highConfidenceCount || 0} 条`}
          </button>
          <button className="btn" onClick={onUndo} disabled={busy || !lastRunId}>撤销上次自动归因</button>
        </div>
      </div>
      <div className="project-coverage-grid">
        <CoverageMetric label="识别到的项目" value={coverage.projectCount} note={`${coverage.recognizedSessionCount}/${coverage.sessionCount} 个 session · ${recognizedPct.toFixed(0)}%`} tone="project" />
        <CoverageMetric label="证据完整归因" value={`${completePct.toFixed(0)}%`} note={`${coverage.completeSessionCount} 个已补齐目的、阶段、价值`} tone="complete" />
        <CoverageMetric label="待确认成本" value={U.money4(coverage.pendingCostUSD || 0)} note={`${U.compactCN(coverage.pendingTokens || 0)} tokens · ${pendingPct.toFixed(0)}%`} tone="pending" />
        <CoverageMetric label="自动 / 人工" value={`${coverage.autoHighSessionCount}/${coverage.manualSessionCount}`} note={`自动高置信 / 人工确认，另有 ${coverage.autoLowSessionCount} 条待确认`} tone="auto" />
      </div>
      <div className="review-workflow-strip">
        <div>
          <span>本周高成本项目</span>
          <strong>{workflow?.highCostProject?.project || '暂无'}</strong>
        </div>
        <div>
          <span>已完成/发布产出</span>
          <strong>{workflow?.completedOrPublishedCount || 0}</strong>
        </div>
        <div>
          <span>已发布产出链接</span>
          <strong>{workflow?.publishedOutputCount || 0}</strong>
        </div>
        <div>
          <span>待执行建议</span>
          <strong>{workflow?.openAdvisorActionCount || 0}</strong>
        </div>
        <div>
          <span>预计减少未归因</span>
          <strong>{(reduction * 100).toFixed(0)}%</strong>
        </div>
      </div>
      {message && <div className={`auto-attribution-message auto-attribution-message-${message.type}`}>{message.text}</div>}
    </section>
  );
}

function CoverageMetric({ label, value, note, tone }) {
  return (
    <article className={`coverage-metric coverage-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{note}</p>
    </article>
  );
}

function AutoAttributionPanel({ plan, coverage }) {
  if (!plan) return null;
  const draftRows = plan.suggestions
    .filter(item => !item.canApply || item.annotationConfidence < plan.threshold)
    .slice(0, 4);
  const hasDrafts = draftRows.length > 0;
  return (
    <section className="auto-attribution-panel" aria-label="自动归因待确认草稿">
      <div className="auto-attribution-main">
        <div>
          <div className="eyebrow">待确认草稿</div>
          <h2>系统会给中低置信建议，但不会把它们伪装成事实</h2>
          <p>
            高置信已经可以一键写入；低置信只展示建议值、置信度和原因，后续在“待确认队列”里人工抽查高成本例外。
          </p>
        </div>
        <div className="auto-attribution-summary">
          <strong>{plan.lowConfidenceCount}</strong>
          <span>条待确认建议</span>
        </div>
      </div>
      <div className="auto-attribution-stats">
        <div>
          <span>高置信可写</span>
          <strong>{plan.highConfidenceCount}</strong>
        </div>
        <div>
          <span>待确认建议</span>
          <strong>{plan.lowConfidenceCount}</strong>
        </div>
        <div>
          <span>当前待确认成本</span>
          <strong>{U.money4(coverage?.pendingCostUSD || 0)}</strong>
        </div>
        <div>
          <span>规则版本</span>
          <strong>{plan.version}</strong>
        </div>
      </div>
      {hasDrafts && (
        <div className="auto-draft-list">
          {draftRows.map(item => (
            <article key={`${item.device}:${item.source}:${item.sessionId}`} className="auto-draft-row">
              <div>
                <strong>{item.values.projectAlias || item.projectPath || item.sessionId}</strong>
                <span>{item.source} · {U.compactCN(item.totalTokens || 0)} tokens · 置信度 {item.annotationConfidence}%</span>
              </div>
              <p title={item.annotationReason}>{item.annotationReason || '结构化证据不足，仅作为待确认草稿。'}</p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function AttributionOverview({ rows, totalTokens, totalSessions, onQuickAttribute }) {
  const unattributed = rows.find(row => row.id === 'unattributed');
  const unattributedCount = unattributed?.sessionCount || 0;
  const allUnattributed = totalSessions > 0 && unattributedCount === totalSessions;
  return (
    <section className="attribution-overview" aria-label="归因概览">
      <div className="attribution-overview-head">
        <div>
          <div className="eyebrow">归因概览</div>
          <h2>产出状态与官方价成本</h2>
        </div>
        <div className="attribution-overview-side">
          <div className="attribution-overview-total">
            <span>会话 Token</span>
            <strong>{U.compactCN(totalTokens)}</strong>
          </div>
          {unattributedCount > 0 && (
            <button className="btn btn-primary" onClick={onQuickAttribute}>批量归因当前筛选</button>
          )}
        </div>
      </div>
      {allUnattributed && (
        <div className="attribution-callout">
          当前筛选还没有人工任务/状态标注。先按模型、来源或项目缩小范围，再批量归因。
        </div>
      )}
      <div className="attribution-card-grid">
        {rows.map(row => {
          const pct = row.share * 100;
          return (
            <article key={row.id} className={`attribution-card attribution-card-${row.tone}`}>
              <div className="attribution-card-top">
                <span>{row.label}</span>
                <strong>{pct.toFixed(1)}%</strong>
              </div>
              <div className="attribution-card-value">{U.compactCN(row.totalTokens)}</div>
              <div className="attribution-card-meta">
                <span>{row.sessionCount} 个 session</span>
                <span>{U.money4(row.costUSD || 0)}</span>
              </div>
              <div className="attribution-meter">
                <span style={{ width: `${Math.min(100, pct)}%` }} />
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function sessionIdentity(session) {
  return {
    device: session.device,
    source: session.source,
    sessionId: session.sessionId
  };
}

function RoiReview({ riskRows, projectRows, weeklyReview, totalTokens }) {
  const topProjects = projectRows.slice(0, 5);
  return (
    <section className="roi-review" aria-label="ROI 复盘">
      <div className="roi-panel risk-panel">
        <div className="panel-header compact">
          <div>
            <div className="eyebrow">风险分布</div>
            <h3 className="panel-title">需要复盘的官方价成本</h3>
          </div>
          <span className="muted">{U.compactCN(totalTokens)} tokens</span>
        </div>
        <div className="risk-list">
          {riskRows.map(row => {
            const pct = row.share * 100;
            return (
              <div key={row.id} className={`risk-row risk-${row.tone}`}>
                <div>
                  <strong>{row.label}</strong>
                  <span>{row.sessionCount} sessions · {U.money4(row.costUSD || 0)}</span>
                </div>
                <div className="risk-meter">
                  <span style={{ width: `${Math.min(100, pct)}%` }} />
                </div>
                <b>{pct.toFixed(1)}%</b>
              </div>
            );
          })}
        </div>
      </div>

      <div className="roi-panel project-roi-panel">
        <div className="panel-header compact">
          <div>
            <div className="eyebrow">项目 ROI 排行</div>
            <h3 className="panel-title">按项目查看官方价成本</h3>
          </div>
        </div>
        <div className="project-roi-list">
          {topProjects.length === 0 && <div className="empty compact-empty">暂无项目会话</div>}
          {topProjects.map(row => (
            <article key={row.project} className="project-roi-row">
              <div className="project-roi-main">
                <strong className="mono">{row.project}</strong>
                <span>{row.sessionCount} sessions · {U.money4(row.costUSD || 0)}</span>
              </div>
              <div className="project-roi-bars">
                <span className="roi-published" style={{ width: pctWidth(row.publishedTokens, row.totalTokens) }} title="已发布"/>
                <span className="roi-completed" style={{ width: pctWidth(row.completedTokens, row.totalTokens) }} title="已完成"/>
                <span className="roi-discarded" style={{ width: pctWidth(row.discardedTokens, row.totalTokens) }} title="已废弃"/>
                <span className="roi-unattributed" style={{ width: pctWidth(row.unattributedTokens, row.totalTokens) }} title="未归因"/>
              </div>
              <div className="project-roi-meta">
                <span>产出 {(row.productiveShare * 100).toFixed(0)}%</span>
                <span>风险 {(row.riskShare * 100).toFixed(0)}%</span>
                <span>{U.compactCN(row.totalTokens)}</span>
              </div>
            </article>
          ))}
        </div>
      </div>

      <div className="roi-panel weekly-panel">
        <div className="panel-header compact">
          <div>
            <div className="eyebrow">本周复盘</div>
            <h3 className="panel-title">{weeklyReview.startDate} 至 {weeklyReview.endDate}</h3>
          </div>
          <span className="muted">{U.money4(weeklyReview.totals.costUSD || 0)}</span>
        </div>
        <div className="weekly-grid">
          <div>
            <span className="weekly-label">高成本项目</span>
            <strong>{weeklyReview.highCostProjects[0]?.project || '暂无'}</strong>
          </div>
          <div>
            <span className="weekly-label">废弃成本</span>
            <strong>{U.money4(weeklyReview.discarded.costUSD || 0)}</strong>
          </div>
          <div>
            <span className="weekly-label">未归因队列</span>
            <strong>{weeklyReview.unattributedQueue.length}</strong>
          </div>
          <div>
            <span className="weekly-label">已发布产出</span>
            <strong>{weeklyReview.publishedOutputs.length}</strong>
          </div>
        </div>
        <div className="weekly-output-list">
          {weeklyReview.publishedOutputs.slice(0, 3).map(session => (
            <a key={session.sessionId} href={session.outputUrl} target="_blank" rel="noreferrer">
              {session.outputLabel || session.outputUrl}
            </a>
          ))}
          {weeklyReview.publishedOutputs.length === 0 && <span className="muted">暂无已发布产出链接</span>}
        </div>
      </div>
    </section>
  );
}

function pctWidth(value, total) {
  return `${Math.max(0, Math.min(100, total ? (value / total) * 100 : 0))}%`;
}
