/* =============================================================
   /review — main app (real data via /api/data)
   ============================================================= */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { U } from '../shared/utils.ts';
import { cachedAppData, loadAppData } from '../shared/runtime-data.ts';
import { RU } from './utils.ts';
import { HeroSection, ProjectSection, CalendarSection } from './sections-1.tsx';
import { ToolsSection, EfficiencySection, ClosureProgressSection, EvidenceFlywheelSection, RoiEvidenceSection, SavingsSimulatorSection, RoiAdvisorSection, AdvisorActionSummarySection, ModelStrategySection, InsightsSection, ReviewTrustBanner } from './sections-2.tsx';
import { buildRoiAdvisor } from './roi-advisor.ts';
import { buildMarkdownReviewReport, buildReviewReportFilename } from './markdown-report.ts';
import { buildModelStrategy } from './model-strategy.ts';
import { buildReviewClosureProgress } from './closure-progress.ts';
import { buildRoiEvidence } from './roi-evidence.ts';
import { buildSavingsSimulation } from './savings-simulator.ts';
import { buildReviewTrustState } from './review-trust.ts';
import { buildEvidenceZeroState, buildSavingsEmptyReason } from './review-empty-states.ts';
import { buildAdvisorActionMeasurements } from './action-measurement.ts';
import {
  buildProfessionalEvidencePack,
  buildResumeAndInterviewPack,
  buildTechnicalBlogDraft
} from './export-materials.ts';
import './styles.css';

function dateTimeForPeriod(period) {
  return {
    startDateTime: `${period.start}T00:00`,
    endDateTime: `${period.end}T23:59`
  };
}

function sameDateTimeRange(left, right) {
  return left.startDateTime === right.startDateTime
    && left.endDateTime === right.endDateTime;
}

function displayDateTime(value) {
  return String(value || '').replace('T', ' ');
}

function evidencePeriodFor(id) {
  if (id === 'all') return 'all';
  if (id === 'today' || id === '7d') return 'week';
  return 'month';
}

function formatApiConnectionError(error, action = '请求') {
  const message = error?.message || '';
  if (message === 'Failed to fetch' || error?.name === 'TypeError') {
    return `${action}失败：本地 API 服务没有连上。请关闭旧页面，重新运行 npx token-work，并打开终端输出的最新本地 URL。`;
  }
  return message || `${action}失败`;
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall back for headless browsers, older WebViews, or blocked clipboard permissions.
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } finally {
    document.body.removeChild(textarea);
  }
  if (!copied) throw new Error('copy failed');
  return true;
}

export function ReviewApp() {
  const [data, setData] = useState(() => cachedAppData());
  const [loading, setLoading] = useState(() => !cachedAppData());
  const [error, setError] = useState(null);
  const [, setExchangeRateVersion] = useState(0);

  const loadData = useCallback((force = true) => {
    setError(null);
    return loadAppData({ force })
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, []);

  useEffect(() => {
    loadData(false);
  }, [loadData]);

  useEffect(() => {
    return U.startExchangeRateRefresh(() => {
      setExchangeRateVersion(version => version + 1);
    });
  }, []);

  if (loading) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100vh', flexDirection: 'column', gap: 16
      }}>
        <div style={{
          width: 32, height: 32, borderRadius: '50%',
          border: '3px solid var(--rule)', borderTopColor: 'var(--indigo)',
          animation: 'spin 0.8s linear infinite'
        }}/>
        <div style={{color: 'var(--ink-soft)', fontSize: 14}}>加载数据中…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100vh', flexDirection: 'column', gap: 12
      }}>
        <div style={{fontSize: 32}}>⚠️</div>
        <div style={{color: 'var(--ink)', fontWeight: 600}}>数据加载失败</div>
        <div style={{color: 'var(--ink-soft)', fontSize: 13}}>{error}</div>
        <button onClick={() => window.location.reload()} style={{
          marginTop: 8, padding: '8px 18px', borderRadius: 8,
          border: '1px solid var(--rule)', background: 'var(--paper-2)',
          cursor: 'pointer', fontSize: 13
        }}>重新加载</button>
      </div>
    );
  }

  return <ReviewDashboard rawData={data} onReloadData={loadData}/>;
}

function ReviewDashboard({ rawData, onReloadData }) {
  const TODAY = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return today;
  }, []);
  const defaultPeriod = useMemo(() => RU.getPeriod('today', TODAY, rawData.daily), [TODAY, rawData.daily]);

  const [periodId, setPeriodId] = useState('today');
  const [customRange, setCustomRange] = useState(() => dateTimeForPeriod(defaultPeriod));
  const [customDraft, setCustomDraft] = useState(() => dateTimeForPeriod(defaultPeriod));
  const [customOpen, setCustomOpen] = useState(false);
  const [activePageIndex, setActivePageIndex] = useState(0);
  const [advisorActions, setAdvisorActions] = useState(rawData.advisorActions || []);
  const [lazyAttributionState, setLazyAttributionState] = useState({ busy: false, message: '', error: '' });
  const [evidenceAutopilotState, setEvidenceAutopilotState] = useState({
    busy: false,
    applyingId: '',
    message: '',
    error: '',
    plan: null,
    dismissedIds: []
  });
  const [activeContentModal, setActiveContentModal] = useState(null);
  const [copyToast, setCopyToast] = useState({ message: '', kind: 'success' });
  const copyToastTimerRef = useRef(null);
  const customPickerRef = useRef(null);
  const pageRefs = useRef([]);
  const period = useMemo(() => periodId === 'custom'
    ? RU.getCustomPeriod(customRange, TODAY)
    : RU.getPeriod(periodId, TODAY, rawData.daily)
  , [TODAY, customRange, periodId, rawData.daily]);
  const prevPeriod = useMemo(() => period.prev
    ? { start: period.prev.start, end: period.prev.end }
    : null, [period]);

  const daily = useMemo(() => RU.filterByPeriod(rawData.daily, period), [rawData, period]);
  const sessions = useMemo(() => RU.filterSessionsByPeriod(rawData.sessions, period), [rawData, period]);
  const prevDaily = useMemo(() =>
    prevPeriod ? RU.filterByPeriod(rawData.daily, prevPeriod) : []
  , [rawData, prevPeriod]);

  useEffect(() => {
    if (periodId === 'custom') return;
    const nextRange = dateTimeForPeriod(RU.getPeriod(periodId, TODAY, rawData.daily));
    setCustomRange(current => sameDateTimeRange(current, nextRange) ? current : nextRange);
    setCustomDraft(current => sameDateTimeRange(current, nextRange) ? current : nextRange);
  }, [TODAY, periodId, rawData.daily]);

  useEffect(() => {
    if (!customOpen) return undefined;
    const onDown = (event) => {
      if (!customPickerRef.current?.contains(event.target)) {
        setCustomOpen(false);
        setCustomDraft(customRange);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [customOpen, customRange]);

  const setPeriodPreset = useCallback((id) => {
    setPeriodId(id);
    setCustomOpen(false);
  }, []);

  const setCustomDraftDateTime = useCallback((key, value) => {
    if (!value) return;
    setCustomDraft(current => {
      const next = { ...current, [key]: value };
      if (next.startDateTime && next.endDateTime && next.startDateTime > next.endDateTime) {
        if (key === 'startDateTime') next.endDateTime = next.startDateTime;
        else next.startDateTime = next.endDateTime;
      }
      return next;
    });
    setCustomRange(current => {
      const next = { ...current, [key]: value };
      if (next.startDateTime && next.endDateTime && next.startDateTime > next.endDateTime) {
        if (key === 'startDateTime') next.endDateTime = next.startDateTime;
        else next.startDateTime = next.endDateTime;
      }
      return next;
    });
    setPeriodId('custom');
  }, []);

  // Aggregate totals
  const totals = useMemo(() => {
    const total = RU.sumField(daily, 'totalTokens');
    const input = RU.sumField(daily, 'inputTokens');
    const output = RU.sumField(daily, 'outputTokens');
    const cacheRead = RU.sumField(daily, 'cacheReadTokens');
    const cacheCreation = RU.sumField(daily, 'cacheCreationTokens');
    const reasoning = RU.sumField(daily, 'reasoningOutputTokens');
    const cost = RU.sumField(daily, 'costUSD');
    return {
      total, input, output, cacheRead, cacheCreation, reasoning, cost,
      cacheHitRate: U.cacheHitRate(input, cacheRead, cacheCreation)
    };
  }, [daily]);

  const prevTotals = useMemo(() => prevDaily.length ? ({
    total: RU.sumField(prevDaily, 'totalTokens'),
    cost:  RU.sumField(prevDaily, 'costUSD')
  }) : null, [prevDaily]);

  // Hero stat strip
  const heroStats = useMemo(() => {
    const days = RU.dailyTotals(daily, period);
    const active = days.filter(d => d.total > 0);
    const peak = active.length ? [...active].sort((a, b) => b.total - a.total)[0] : null;
    const tools = RU.aggregateBy(daily, 'source').sort((a, b) => b.totalTokens - a.totalTokens);
    const projects = RU.aggregateBy(daily, 'projectPath').filter(p => p.key);
    const topTool = tools[0];
    return {
      activeDays: active.length,
      projectCount: projects.length,
      sourceCount: tools.length,
      peakDay: peak,
      topTool: topTool ? {
        key: topTool.key,
        short: topTool.key.replace(/ CLI| Code/, ''),
        totalTokens: topTool.totalTokens,
        share: (topTool.totalTokens / (totals.total || 1)) * 100
      } : null,
      avgDailyCost: active.length ? totals.cost / active.length : 0
    };
  }, [daily, period, totals]);

  // Insights
  const insights = useMemo(() =>
    RU.buildInsights(daily, period, prevDaily)
  , [daily, period, prevDaily]);
  const roiAdvice = useMemo(() =>
    buildRoiAdvisor({ sessions, daily })
  , [sessions, daily]);
  const modelStrategy = useMemo(() =>
    buildModelStrategy({ sessions })
  , [sessions]);
  const closureProgress = useMemo(() =>
    buildReviewClosureProgress({ sessions, roiAdvice })
  , [sessions, roiAdvice]);
  const roiEvidence = useMemo(() =>
    buildRoiEvidence({ sessions, workItems: rawData.workItems || [] })
  , [sessions, rawData.workItems]);
  const savingsSimulation = useMemo(() =>
    buildSavingsSimulation({ sessions, daily, pricingMeta: rawData.meta?.officialPricing || null })
  , [sessions, daily, rawData.meta]);
  const trustState = useMemo(() =>
    buildReviewTrustState(rawData.meta || {})
  , [rawData.meta]);
  const evidenceZeroState = useMemo(() =>
    buildEvidenceZeroState(roiEvidence, rawData.meta?.projectCoverage || {})
  , [roiEvidence, rawData.meta]);
  const savingsEmptyReason = useMemo(() =>
    buildSavingsEmptyReason({ simulation: savingsSimulation, sessions })
  , [savingsSimulation, sessions]);
  const evidenceFlywheel = rawData.meta?.evidenceFlywheel || null;
  const coverageBridge = rawData.meta?.coverageBridge || null;
  const localTrust = rawData.meta?.localTrust || null;

  useEffect(() => () => {
    if (copyToastTimerRef.current) clearTimeout(copyToastTimerRef.current);
  }, []);

  const showCopyToast = useCallback((message, kind = 'success') => {
    if (copyToastTimerRef.current) clearTimeout(copyToastTimerRef.current);
    setCopyToast({ message, kind });
    copyToastTimerRef.current = setTimeout(() => {
      setCopyToast({ message: '', kind: 'success' });
    }, 1800);
  }, []);

  useEffect(() => {
    setAdvisorActions(rawData.advisorActions || []);
  }, [rawData.advisorActions]);

  const actionsByRule = useMemo(() => {
    const map = new Map();
    for (const action of advisorActions) {
      if (action.periodStart === period.start && action.periodEnd === period.end && action.sourceRule) {
        map.set(action.sourceRule, action);
      }
    }
    return map;
  }, [advisorActions, period]);
  const periodAdvisorActions = useMemo(() =>
    advisorActions.filter(action => action.periodStart === period.start && action.periodEnd === period.end)
  , [advisorActions, period]);
  const actionMeasurements = useMemo(() =>
    buildAdvisorActionMeasurements({ actions: periodAdvisorActions, sessions, period })
  , [periodAdvisorActions, sessions, period]);

  const markdownReport = useMemo(() =>
    buildMarkdownReviewReport({
      period,
      daily,
      sessions,
      workItems: rawData.workItems || [],
      roiAdvice,
      savingsSimulation,
      advisorActions,
      actionMeasurements,
      coverageBridge,
      evidenceFlywheel,
      localTrust
    })
  , [period, daily, sessions, rawData.workItems, roiAdvice, insights, savingsSimulation, advisorActions, actionMeasurements, coverageBridge, evidenceFlywheel, localTrust]);

  const blogMaterial = useMemo(() => buildTechnicalBlogDraft({
    sessions,
    totals,
    localTrust,
    coverageBridge,
    evidenceFlywheel,
    savingsSimulation,
    modelStrategy
  }), [period, sessions, totals, localTrust, coverageBridge, evidenceFlywheel, savingsSimulation, modelStrategy]);

  const resumeMaterial = useMemo(() => buildResumeAndInterviewPack({
    sessions,
    totals,
    localTrust,
    coverageBridge,
    evidenceFlywheel
  }), [sessions, totals, localTrust, coverageBridge, evidenceFlywheel]);

  const evidenceMaterial = useMemo(() => buildProfessionalEvidencePack({
    period,
    sessions,
    totals,
    localTrust,
    coverageBridge,
    roiEvidence,
    evidenceFlywheel,
    evidenceAutopilotState
  }), [period, sessions, totals, localTrust, coverageBridge, roiEvidence, evidenceFlywheel, evidenceAutopilotState]);

  const persistAdvisorAction = useCallback(async (payload) => {
    const response = await fetch('/api/advisor-actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        periodStart: period.start,
        periodEnd: period.end,
        ...payload
      })
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `HTTP ${response.status}`);
    }
    const data = await response.json();
    setAdvisorActions(current => {
      const next = current.filter(item => item.id !== data.action.id);
      next.unshift(data.action);
      return next;
    });
    return data.action;
  }, [period]);

  const addAdvisorAction = useCallback((payload) =>
    persistAdvisorAction({ ...payload, status: 'open' })
  , [persistAdvisorAction]);

  const setAdvisorActionStatus = useCallback((action, status) =>
    persistAdvisorAction({ ...action, status })
  , [persistAdvisorAction]);

  const applyLazyAttribution = useCallback(async () => {
    setLazyAttributionState({ busy: true, message: '', error: '' });
    try {
      const response = await fetch('/api/auto-attribution/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || `HTTP ${response.status}`);
      }
      const result = await response.json();
      setLazyAttributionState({
        busy: false,
        message: `已应用 ${result.applied ?? 0} 条高置信自动归因；自动推断不等同人工确认。`,
        error: ''
      });
      await onReloadData?.();
    } catch (error) {
      setLazyAttributionState({
        busy: false,
        message: '',
        error: formatApiConnectionError(error, '自动归因')
      });
    }
  }, [onReloadData]);

  const loadEvidenceAutopilotPlan = useCallback(async () => {
    const response = await fetch(`/api/evidence-suggestions?period=${encodeURIComponent(evidencePeriodFor(periodId))}`);
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `HTTP ${response.status}`);
    }
    const payload = await response.json();
    return payload.plan || null;
  }, [periodId]);

  const runEvidenceAutopilot = useCallback(async () => {
    setEvidenceAutopilotState(current => ({
      ...current,
      busy: true,
      applyingId: '',
      message: '',
      error: ''
    }));
    try {
      const plan = await loadEvidenceAutopilotPlan();
      const suggestionIds = plan?.summary?.canApplyIds || [];
      if (!suggestionIds.length) {
        setEvidenceAutopilotState(current => ({
          ...current,
          busy: false,
          plan,
          message: '已生成待确认队列；当前没有可直接写入的高置信证据。',
          error: ''
        }));
        return;
      }
      const response = await fetch('/api/evidence-suggestions/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period: evidencePeriodFor(periodId), suggestionIds })
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || `HTTP ${response.status}`);
      }
      const result = await response.json();
      let refreshedPlan = result.plan || plan;
      try {
        refreshedPlan = await loadEvidenceAutopilotPlan();
      } catch {
        // Keep the apply result visible if the follow-up read fails.
      }
      setEvidenceAutopilotState(current => ({
        ...current,
        busy: false,
        plan: refreshedPlan,
        message: `已应用 ${result.appliedAnnotations || 0} 条归因证据、${result.appliedOutputs || 0} 条产出链接；自动证据不等同人工确认。`,
        error: ''
      }));
      await onReloadData?.();
    } catch (error) {
      setEvidenceAutopilotState(current => ({
        ...current,
        busy: false,
        message: '',
        error: formatApiConnectionError(error, '生成复盘证据')
      }));
    }
  }, [loadEvidenceAutopilotPlan, onReloadData, periodId]);

  const applyEvidenceSuggestion = useCallback(async (suggestionId) => {
    if (!suggestionId) return;
    setEvidenceAutopilotState(current => ({ ...current, applyingId: suggestionId, error: '', message: '' }));
    try {
      const response = await fetch('/api/evidence-suggestions/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period: evidencePeriodFor(periodId), suggestionIds: [suggestionId] })
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || `HTTP ${response.status}`);
      }
      const result = await response.json();
      let refreshedPlan = result.plan;
      try {
        refreshedPlan = await loadEvidenceAutopilotPlan();
      } catch {
        // Keep the apply result visible if the follow-up read fails.
      }
      setEvidenceAutopilotState(current => ({
        ...current,
        applyingId: '',
        plan: refreshedPlan || current.plan,
        message: `已应用 ${result.appliedAnnotations || 0} 条归因证据、${result.appliedOutputs || 0} 条产出链接。`,
        error: ''
      }));
      await onReloadData?.();
    } catch (error) {
      setEvidenceAutopilotState(current => ({
        ...current,
        applyingId: '',
        error: formatApiConnectionError(error, '应用复盘证据')
      }));
    }
  }, [onReloadData, periodId]);

  const dismissEvidenceSuggestion = useCallback((suggestionId) => {
    if (!suggestionId) return;
    setEvidenceAutopilotState(current => ({
      ...current,
      dismissedIds: Array.from(new Set([...(current.dismissedIds || []), suggestionId]))
    }));
  }, []);

  const modalSpec = useMemo(() => {
    if (activeContentModal === 'evidence') {
      return {
        eyebrow: 'Evidence Autopilot',
        title: '专业复盘证据包',
        description: '可直接粘贴到周报、README、博客或面试准备文档。内容只使用结构化数据，并明确写出可信边界。',
        body: evidenceMaterial,
        copyLabel: '复制复盘证据包',
        secondaryLabel: evidenceAutopilotState.busy ? '生成中…' : '生成/刷新证据',
        secondaryDisabled: evidenceAutopilotState.busy,
        onSecondary: runEvidenceAutopilot
      };
    }
    if (activeContentModal === 'blog') {
      return {
        eyebrow: 'Blog Material',
        title: '技术博客草稿',
        description: '按问题、方案、实现、验证、隐私、局限和经验总结组织，可直接作为博客初稿再人工润色。',
        body: blogMaterial,
        copyLabel: '复制技术博客草稿'
      };
    }
    if (activeContentModal === 'resume') {
      return {
        eyebrow: 'Resume Material',
        title: '简历 / 面试项目描述',
        description: '包含中文简历、英文简历和 STAR 面试版本；只写可证实能力，不编造 ROI 提升百分比。',
        body: resumeMaterial,
        copyLabel: '复制简历项目描述'
      };
    }
    return null;
  }, [activeContentModal, blogMaterial, evidenceAutopilotState.busy, evidenceMaterial, resumeMaterial, runEvidenceAutopilot]);

  const copyModalContent = useCallback(async () => {
    if (!modalSpec?.body) return;
    try {
      await copyText(modalSpec.body);
      showCopyToast('复制成功，可直接粘贴使用');
    } catch {
      showCopyToast('复制失败，请手动复制', 'error');
    }
  }, [modalSpec, showCopyToast]);

  // Period nav
  const ORDER = ['today', '7d', '14d', '30d', '90d', 'all'];
  const idx = ORDER.indexOf(periodId);
  const prevId = idx > 0 ? ORDER[idx - 1] : null;
  const nextId = idx >= 0 && idx < ORDER.length - 1 ? ORDER[idx + 1] : null;

  const exportCSV = () => {
    U.downloadCSV(`token-review-${period.start}-${period.end}.csv`, daily, [
      { title: 'date', field: 'usageDate' },
      { title: 'source', field: 'source' },
      { title: 'device', field: 'device' },
      { title: 'model', field: 'model' },
      { title: 'project', field: 'projectPath' },
      { title: 'input', field: 'inputTokens' },
      { title: 'output', field: 'outputTokens' },
      { title: 'cache_read', field: 'cacheReadTokens' },
      { title: 'cache_creation', field: 'cacheCreationTokens' },
      { title: 'reasoning', field: 'reasoningOutputTokens' },
      { title: 'total', field: 'totalTokens' },
      { title: 'official_price_usd', field: 'costUSD' },
      { title: 'official_price_cny_est', value: row => Number(row.costUSD || 0) * U.getExchangeRate().rate }
    ]);
  };

  const exportMarkdown = () => {
    U.downloadText(
      buildReviewReportFilename(period),
      markdownReport,
      'text/markdown;charset=utf-8'
    );
  };

  const reviewPages = useMemo(() => [
    {
      id: 'overview',
      label: '00 · 总览',
      className: 'page',
      content: (
        <>
          <HeroSection period={period} totals={totals} prevTotals={prevTotals} stats={heroStats}/>
          <ReviewTrustBanner state={trustState}/>
        </>
      )
    },
    {
      id: 'closure',
      label: '01 · 闭环',
      className: 'page',
      content: <ClosureProgressSection
        progress={closureProgress}
        trustState={trustState}
        projectCoverage={rawData.meta?.projectCoverage}
        lazyState={lazyAttributionState}
        onLazyAttribution={applyLazyAttribution}
      />
    },
    {
      id: 'flywheel',
      label: '02 · 证据飞轮',
      className: 'page slide-scroll',
      content: <EvidenceFlywheelSection
        flywheel={evidenceFlywheel}
        autopilotState={evidenceAutopilotState}
        onRunAutopilot={runEvidenceAutopilot}
        onApplyEvidenceSuggestion={applyEvidenceSuggestion}
        onDismissEvidenceSuggestion={dismissEvidenceSuggestion}
      />
    },
    {
      id: 'evidence',
      label: '03 · ROI 证据',
      className: 'page slide-scroll',
      content: <RoiEvidenceSection
        evidence={roiEvidence}
        zeroState={evidenceZeroState}
        lazyState={lazyAttributionState}
        onLazyAttribution={applyLazyAttribution}
        autopilotState={evidenceAutopilotState}
        onRunAutopilot={runEvidenceAutopilot}
        onApplyEvidenceSuggestion={applyEvidenceSuggestion}
        onDismissEvidenceSuggestion={dismissEvidenceSuggestion}
      />
    },
    {
      id: 'projects',
      label: '04 · 项目',
      className: 'page slide-scroll',
      content: <ProjectSection daily={daily} totalTokens={totals.total}/>
    },
    {
      id: 'calendar',
      label: '05 · 时间线',
      className: 'page-wide slide-scroll',
      innerClassName: 'review-page-narrow',
      content: <CalendarSection daily={daily} period={period}/>
    },
    {
      id: 'tools',
      label: '06 · 工具',
      className: 'page-wide slide-scroll',
      innerClassName: 'review-page-narrow',
      content: <ToolsSection daily={daily} totalTokens={totals.total}/>
    },
    {
      id: 'efficiency',
      label: '07 · 效率',
      className: 'page',
      content: <EfficiencySection daily={daily} period={period}/>
    },
    {
      id: 'savings',
      label: '08 · 节省模拟',
      className: 'page slide-scroll',
      content: <SavingsSimulatorSection
        simulation={savingsSimulation}
        emptyReason={savingsEmptyReason}
        lazyState={lazyAttributionState}
        actionsByRule={actionsByRule}
        onAddAction={addAdvisorAction}
        onSetActionStatus={setAdvisorActionStatus}
        onLazyAttribution={applyLazyAttribution}
        autopilotState={evidenceAutopilotState}
        onRunAutopilot={runEvidenceAutopilot}
        onApplyEvidenceSuggestion={applyEvidenceSuggestion}
        onDismissEvidenceSuggestion={dismissEvidenceSuggestion}
      />
    },
    {
      id: 'advisor',
      label: '09 · ROI 建议',
      className: 'page',
      content: <RoiAdvisorSection
        suggestions={roiAdvice}
        actionsByRule={actionsByRule}
        onAddAction={addAdvisorAction}
        onSetActionStatus={setAdvisorActionStatus}
      />
    },
    {
      id: 'actions',
      label: '10 · 行动清单',
      className: 'page slide-scroll',
      content: <AdvisorActionSummarySection
        actions={periodAdvisorActions}
        measurements={actionMeasurements}
        period={period}
        onSetActionStatus={setAdvisorActionStatus}
      />
    },
    {
      id: 'strategy',
      label: '11 · 模型策略',
      className: 'page slide-scroll',
      content: <ModelStrategySection
        strategy={modelStrategy}
        lazyState={lazyAttributionState}
        onLazyAttribution={applyLazyAttribution}
        autopilotState={evidenceAutopilotState}
        onRunAutopilot={runEvidenceAutopilot}
        onApplyEvidenceSuggestion={applyEvidenceSuggestion}
        onDismissEvidenceSuggestion={dismissEvidenceSuggestion}
      />
    },
    {
      id: 'insights',
      label: '12 · 复盘',
      className: 'page',
      content: <InsightsSection insights={insights}/>
    }
  ], [period, totals, prevTotals, heroStats, trustState, evidenceFlywheel, roiEvidence, evidenceZeroState, lazyAttributionState, applyLazyAttribution, evidenceAutopilotState, runEvidenceAutopilot, applyEvidenceSuggestion, dismissEvidenceSuggestion, closureProgress, rawData.meta, daily, roiAdvice, savingsSimulation, savingsEmptyReason, modelStrategy, insights, actionsByRule, periodAdvisorActions, actionMeasurements, addAdvisorAction, setAdvisorActionStatus]);

  const outlineItems = useMemo(() => reviewPages.map((page, index) => ({
    id: page.id,
    label: page.label,
    pageIndex: index
  })), [reviewPages]);

  const activePageForRender = outlineItems[activePageIndex]?.pageIndex ?? 0;

  const goToOutlineItem = useCallback((index) => {
    const item = outlineItems[index];
    if (!item) return;
    const reducedMotion = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    setActivePageIndex(index);
    const target = pageRefs.current[item.pageIndex];
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const navOffset = 74;
    const available = Math.max(320, window.innerHeight - navOffset);
    const centerOffset = target.classList.contains('slide-scroll')
      ? 0
      : Math.max(0, (available - rect.height) / 2);
    const top = window.scrollY + rect.top - navOffset - centerOffset;
    window.scrollTo({
      top: Math.max(0, top),
      behavior: reducedMotion ? 'auto' : 'smooth'
    });
  }, [outlineItems]);

  useEffect(() => {
    pageRefs.current = pageRefs.current.slice(0, reviewPages.length);
  }, [outlineItems.length, reviewPages.length]);

  useEffect(() => {
    let frame = 0;
    const syncActivePage = () => {
      frame = 0;
      const nodes = pageRefs.current;
      if (!nodes.length) return;
      const readingLine = window.innerHeight * 0.5;
      let nextIndex = 0;
      let matched = false;

      nodes.forEach((node, index) => {
        if (!node) return;
        const rect = node.getBoundingClientRect();
        if (!matched && rect.top <= readingLine && rect.bottom >= readingLine) {
          nextIndex = index;
          matched = true;
        }
      });

      if (!matched) {
        let closestDistance = Infinity;
        nodes.forEach((node, index) => {
          if (!node) return;
          const rect = node.getBoundingClientRect();
          const distance = rect.bottom < readingLine
            ? readingLine - rect.bottom
            : Math.abs(rect.top - readingLine);
          if (distance < closestDistance) {
            closestDistance = distance;
            nextIndex = index;
          }
        });
      }

      setActivePageIndex(current => current === nextIndex ? current : nextIndex);
    };

    const requestSync = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(syncActivePage);
    };

    syncActivePage();
    window.addEventListener('scroll', requestSync, { passive: true });
    window.addEventListener('resize', requestSync);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', requestSync);
      window.removeEventListener('resize', requestSync);
    };
  }, [reviewPages.length]);

  return (
    <>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <nav className="review-nav">
        <div className="review-nav-inner">
          <div className="brand-line">
            <img className="brand-dot" src="/token-work-icon.svg" alt="" aria-hidden="true" />
            <span className="brand-name">元衡</span>
            <div className="page-switch">
              <a href="/" className="page-chip">看板</a>
              <span className="page-chip active">复盘</span>
              <a href="/live" className="page-chip">实时</a>
            </div>
          </div>
          <div className="review-period-group">
            <div className="period-switch">
              {ORDER.map(id => (
                <button key={id}
                  className={`period-chip ${periodId === id ? 'active' : ''}`}
                  onClick={() => setPeriodPreset(id)}>
                  {RU.PERIOD_LABELS[id]}
                </button>
              ))}
            </div>
            <div className="review-date-range-picker" ref={customPickerRef}>
              <span className="review-date-range-hint">支持自定义日期与时间</span>
              <button
                type="button"
                className={`review-date-range-control ${periodId === 'custom' ? 'active' : ''}`}
                aria-expanded={customOpen}
                aria-haspopup="dialog"
                onClick={() => setCustomOpen(open => !open)}>
                <span>{displayDateTime(customRange.startDateTime)}</span>
                <span>至</span>
                <span>{displayDateTime(customRange.endDateTime)}</span>
              </button>
              {customOpen && (
                <div className="review-date-range-popover" role="dialog" aria-label="选择自定义日期与时间">
                  <div className="review-date-range-popover-title">支持自定义日期与时间</div>
                  <label className="review-date-range-field">
                    <span>开始时间</span>
                    <input
                      type="datetime-local"
                      value={customDraft.startDateTime}
                      max={customDraft.endDateTime || undefined}
                      onChange={event => setCustomDraftDateTime('startDateTime', event.target.value)} />
                  </label>
                  <label className="review-date-range-field">
                    <span>结束时间</span>
                    <input
                      type="datetime-local"
                      value={customDraft.endDateTime}
                      min={customDraft.startDateTime || undefined}
                      onChange={event => setCustomDraftDateTime('endDateTime', event.target.value)} />
                  </label>
                </div>
              )}
            </div>
          </div>
          <div className="nav-actions">
            <button className="nav-btn primary" onClick={() => setActiveContentModal('evidence')} title="打开复盘证据包" aria-label="打开复盘证据包">
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                <path d="M6.5 1.5l1.1 3.2 3.4 1-3.4 1-1.1 3.3-1.1-3.3-3.4-1 3.4-1 1.1-3.2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
              </svg>
              证据包
            </button>
            <button className="nav-btn primary" onClick={exportMarkdown} title="导出 Markdown 复盘报告" aria-label="导出 Markdown 复盘报告">
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                <path d="M6.5 1.5v6M4 5l2.5 2.5L9 5M2.5 10.5h8" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Markdown
            </button>
            <button className="nav-btn" onClick={() => setActiveContentModal('blog')} title="打开技术博客草稿" aria-label="打开技术博客草稿">
              技术草稿
            </button>
            <button className="nav-btn" onClick={() => setActiveContentModal('resume')} title="打开简历素材" aria-label="打开简历素材">
              项目描述
            </button>
            <button className="nav-btn" onClick={() => window.print()} title="打印当前复盘页面" aria-label="打印当前复盘页面">
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                <rect x="2.5" y="4.5" width="8" height="6" rx="1" stroke="currentColor" strokeWidth="1.3"/>
                <path d="M4 4.5V2h5v2.5M4 8.5h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
              </svg>
              打印
            </button>
          </div>
        </div>
      </nav>

      <ReviewPageControls
        pages={outlineItems}
        activeIndex={activePageIndex}
        onJump={goToOutlineItem}
      />

      {reviewPages.map((page, index) => {
        const content = page.innerClassName
          ? <div className={page.innerClassName}>{page.content}</div>
          : page.content;
        return (
          <div
            key={page.id}
            ref={(node) => {
              pageRefs.current[index] = node;
            }}
            data-review-page-index={index}
            className={`${page.className} review-page ${activePageForRender === index ? 'active' : ''}`}
          >
            {content}
          </div>
        );
      })}

      <footer className="review-footer">
        <div className="review-footer-inner">
          <div className="period-jump">
            <button disabled={!prevId} onClick={() => prevId && setPeriodId(prevId)}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M8 2l-4 4 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              {prevId ? RU.PERIOD_LABELS[prevId] : '更早'}
            </button>
            <div className="period-current">{period.pretty}</div>
            <button disabled={!nextId} onClick={() => nextId && setPeriodId(nextId)}>
              {nextId ? RU.PERIOD_LABELS[nextId] : '更晚'}
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>
          <button className="export-btn" onClick={exportCSV}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M7 1v8M4 6l3 3 3-3M2 12h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            导出当前明细 CSV
          </button>
          <button className="export-btn" onClick={exportMarkdown}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M7 1v8M4 6l3 3 3-3M2 12h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            导出 Markdown 复盘报告
          </button>
          <div className="review-legal-notice">{U.LEGAL_NOTICE}</div>
        </div>
      </footer>

      <ReviewContentModal
        spec={modalSpec}
        toast={copyToast}
        onClose={() => setActiveContentModal(null)}
        onCopy={copyModalContent}
      />
    </>
  );
}

function ReviewContentModal({ spec, toast, onClose, onCopy }) {
  if (!spec) return null;
  return (
    <div className="review-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="review-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="review-modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="review-modal-head">
          <div>
            <span>{spec.eyebrow}</span>
            <h2 id="review-modal-title">{spec.title}</h2>
            <p>{spec.description}</p>
          </div>
          <button type="button" className="review-modal-close" onClick={onClose} aria-label="关闭弹窗">
            ×
          </button>
        </div>
        <pre className="review-modal-body">{spec.body}</pre>
        <div className="review-modal-actions">
          {spec.onSecondary && (
            <button
              type="button"
              className="review-modal-secondary"
              disabled={spec.secondaryDisabled}
              onClick={spec.onSecondary}
            >
              {spec.secondaryLabel}
            </button>
          )}
          <button type="button" className="review-modal-copy" onClick={onCopy}>
            {spec.copyLabel || '复制内容'}
          </button>
          <button type="button" className="review-modal-cancel" onClick={onClose}>
            关闭
          </button>
          {toast?.message && (
            <span className={`review-copy-toast ${toast.kind === 'error' ? 'error' : 'success'}`} role="status">
              {toast.message}
            </span>
          )}
        </div>
      </section>
    </div>
  );
}

function ReviewPageControls({ pages, activeIndex, onJump }) {
  const [outlineVisible, setOutlineVisible] = useState(true);
  const [outlinePeek, setOutlinePeek] = useState(false);
  const itemRefs = useRef([]);

  useEffect(() => {
    if (!outlineVisible) return;
    itemRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeIndex, outlineVisible]);

  const showCollapsed = !outlineVisible && outlinePeek;

  return (
    <>
      {!outlineVisible && (
        <div
          className="review-outline-hotzone"
          aria-hidden="true"
          onMouseEnter={() => setOutlinePeek(true)}
        />
      )}
      {(outlineVisible || showCollapsed) && (
        <div
          className={`review-page-controls ${outlineVisible ? '' : 'collapsed'}`}
          aria-label="复盘页面导航"
          onMouseEnter={() => setOutlinePeek(true)}
          onMouseLeave={() => setOutlinePeek(false)}
        >
          <div className="review-outline-head">
            <strong>大纲</strong>
            {outlineVisible && <span>{activeIndex + 1}/{pages.length}</span>}
            <button
              type="button"
              className="review-outline-toggle"
              aria-label={outlineVisible ? '隐藏大纲' : '显示大纲'}
              aria-pressed={outlineVisible}
              title={outlineVisible ? '隐藏大纲' : '显示大纲'}
              onClick={() => {
                setOutlineVisible(current => !current);
                setOutlinePeek(false);
              }}
            >
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                <path d="M2.25 9s2.3-4.25 6.75-4.25S15.75 9 15.75 9 13.45 13.25 9 13.25 2.25 9 2.25 9Z" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round"/>
                <circle cx="9" cy="9" r="2.1" stroke="currentColor" strokeWidth="1.55"/>
                {outlineVisible && <path d="M3.5 14.5l11-11" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round"/>}
              </svg>
              <span className="review-outline-tooltip" role="tooltip">
                {outlineVisible ? '隐藏大纲' : '显示大纲'}
              </span>
            </button>
          </div>
          {outlineVisible && (
            <div className="review-outline-list">
              {pages.map((page, index) => (
                <button
                  key={page.id}
                  ref={(node) => { itemRefs.current[index] = node; }}
                  type="button"
                  className={`review-outline-item ${index === activeIndex ? 'active' : ''}`}
                  aria-label={`跳到${page.label}`}
                  aria-current={index === activeIndex ? 'location' : undefined}
                  onClick={() => onJump(index)}
                >
                  <span>{page.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
