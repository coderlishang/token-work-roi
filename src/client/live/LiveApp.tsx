import { useEffect, useMemo, useRef, useState } from 'react';
import { U } from '../shared/utils.ts';
import { cachedLiveSnapshot, loadLiveSnapshot } from '../shared/runtime-data.ts';
import './styles.css';

const REFRESH_MS = 15000;
const PULSE_WINDOW_MINUTES = 1440;

export function LiveApp() {
  const [snapshot, setSnapshot] = useState(() => cachedLiveSnapshot(PULSE_WINDOW_MINUTES));
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(null);
  const [, setExchangeRateVersion] = useState(0);
  const mounted = useRef(true);
  const isDesktopPulse = new URLSearchParams(window.location.search).get('surface') === 'desktop';

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    document.body.classList.add('pulse-live-body');
    document.body.classList.toggle('desktop-pulse-body', isDesktopPulse);
    return () => {
      document.body.classList.remove('pulse-live-body');
      document.body.classList.remove('desktop-pulse-body');
    };
  }, [isDesktopPulse]);

  useEffect(() => {
    let alive = true;
    let loading = false;
    const stopExchangeRateRefresh = U.startExchangeRateRefresh(() => {
      if (alive) {
        setExchangeRateVersion(version => version + 1);
      }
    });
    async function load(force = false) {
      if (loading) return;
      loading = true;
      try {
        const data = await loadLiveSnapshot(PULSE_WINDOW_MINUTES, { force });
        if (alive) {
          setSnapshot(data);
          setError(null);
        }
      } catch (err) {
        if (alive) setError(err.message);
      } finally {
        loading = false;
      }
    }
    load(Boolean(cachedLiveSnapshot(PULSE_WINDOW_MINUTES)));
    const timer = setInterval(() => load(true), REFRESH_MS);
    return () => {
      alive = false;
      stopExchangeRateRefresh();
      clearInterval(timer);
    };
  }, []);

  const totals = snapshot?.totals || {};
  const pulse = snapshot?.pulse || {};
  const agent = pulse.agent || {};
  const collectionRunning = snapshot?.collectionState?.status === 'running';
  const freshness = error ? 'network-error' : snapshot?.dataFreshness || 'loading';
  const canManualRefresh = Boolean(snapshot && !snapshot.demoMode && !collectionRunning && !refreshing);
  const generated = useMemo(() => formatChinaStandardTime(snapshot?.generatedAt), [snapshot?.generatedAt]);
  const statuslineCommand = `npx token-work statusline --format=text --window-minutes=${PULSE_WINDOW_MINUTES}`;
  const modelRows = (snapshot?.byModel || []).slice(0, 5);
  const sourceRows = foldSourceRows(snapshot?.bySource || []);
  const warnings = snapshot?.warnings || [];
  const timeline = pulse.timeline || [];

  async function copyStatuslineCommand() {
    try {
      await navigator.clipboard?.writeText(statuslineCommand);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  async function triggerCollect() {
    if (!canManualRefresh) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      const response = await fetch('/api/collect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'live-refresh' })
      });
      const state = await response.json().catch(() => ({}));
      if (!response.ok && response.status !== 409) {
        throw new Error(state.error || `HTTP ${response.status}`);
      }
      if (mounted.current) {
        setSnapshot(current => current ? {
          ...current,
          collectionState: state,
          dataFreshness: 'collecting',
          staleReason: '正在刷新本机可信来源的结构化 token 日志。'
        } : current);
      }
      await waitForCollection();
      if (mounted.current) setError(null);
    } catch (err) {
      if (mounted.current) setRefreshError(err.message);
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }

  async function waitForCollection() {
    for (;;) {
      await delay(1_200);
      const response = await fetch('/api/collect/status');
      const state = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(state.error || `HTTP ${response.status}`);
      if (!mounted.current) return;
      if (state.status === 'running') {
        setSnapshot(current => current ? { ...current, collectionState: state } : current);
        continue;
      }
      if (state.status !== 'ok') {
        throw new Error(state.stderr || state.message || '采集失败');
      }
      setSnapshot(await loadLiveSnapshot(PULSE_WINDOW_MINUTES, { force: true }));
      return;
    }
  }

  return (
    <main className={`live-shell ${isDesktopPulse ? 'desktop-pulse' : 'browser-live'}`}>
      <nav className="pulse-nav">
        <div className="pulse-brand">
          <img className="pulse-logo" src="/token-work-icon.svg" alt="" aria-hidden="true" />
          <strong>元衡 Token Work Pulse</strong>
          <span className={`pulse-badge status-${freshness}`}>{freshnessLabel(freshness)}</span>
        </div>
        <div className="pulse-actions">
          <span className="pulse-time">{generated}</span>
          <button type="button" onClick={copyStatuslineCommand}>{copied ? '已复制' : '复制 statusline'}</button>
          <button type="button" onClick={triggerCollect} disabled={!canManualRefresh}>
            {refreshing || collectionRunning ? '采集中' : '刷新'}
          </button>
          <a href="/review">打开复盘</a>
        </div>
      </nav>

      {(error || refreshError || freshness === 'error') && (
        <section className="pulse-error">
          {error && <strong>实时数据加载失败：{error}</strong>}
          {refreshError && <strong>刷新失败：{refreshError}</strong>}
          {!error && !refreshError && <strong>最近一次采集失败：{snapshot?.staleReason || '未返回具体原因'}</strong>}
          <span>{error || refreshError
            ? '这通常表示 UI 代理没有连上本地 API。请重新运行 Token Work，或在 /trust 查看服务状态。'
            : '已有历史数据不会因本次采集失败被删除；解决后可点击“刷新”重新采集。'}</span>
        </section>
      )}

      <section className="pulse-kpi-grid" aria-label="近24小时核心指标">
        <KpiCard accent="cyan" label="近24小时 Token" value={formatCompactTokens(totals.totalTokens)} detail={`${formatNumber(totals.totalTokens)} tokens`} trend={timeline.map(row => row.totalTokens)} />
        <KpiCard accent="green" label="近24小时官方价" value={formatMoney(totals.costUSD)} detail="官方价格换算，不是账单" trend={timeline.map(row => row.costUSD)} />
        <KpiCard accent="blue" label="Token 事件数" value={formatNumber(totals.requestCount)} detail="本地 token event 记录" trend={timeline.map(row => row.requests)} />
        <KpiCard accent="purple" label="输入" value={formatCompactTokens(totals.inputTokens)} detail={`${formatNumber(totals.inputTokens)} tokens`} trend={timeline.map(row => row.inputTokens)} />
        <KpiCard accent="blue" label="输出" value={formatCompactTokens(totals.outputTokens)} detail={`${formatNumber(totals.outputTokens)} tokens`} trend={timeline.map(row => row.outputTokens)} />
        <KpiCard accent="green" label="缓存复用" value={`${formatPercent(totals.cacheHitRate)}%`} detail={`${formatCompactTokens(totals.cacheReadTokens)} cache read`} trend={timeline.map(row => row.cacheReadTokens)} />
      </section>

      <section className="pulse-main-grid">
        <Panel className="pulse-chart-panel" title="24 小时 token burn rate" action="近24小时">
          <TrendLegend totals={totals} />
          <TrendChart data={pulse.timeline || []} />
        </Panel>

        <Panel className="pulse-agent-panel" title="Agent 活跃时长">
          <AgentRing activeHours={agent.activeHours || 0} windowHours={pulse.windowHours || 24} percent={agent.utilizationPercent || 0} />
        </Panel>
      </section>

      <section className="pulse-bottom-grid">
        <Panel title="模型消耗 Top 5" className="pulse-model-panel">
          <ModelRows rows={modelRows} totalTokens={totals.totalTokens} />
        </Panel>

        <Panel title="来源分布" className="pulse-source-panel">
          <SourceDonut rows={sourceRows} totalTokens={totals.totalTokens} />
        </Panel>

        <Panel title="当前建议" className="pulse-advice-panel">
          <AdviceList warnings={warnings} snapshot={snapshot} />
        </Panel>
      </section>

      <footer className="pulse-footer">
        <span>数据源：本地 SQLite</span>
        <span>窗口：近 24 小时</span>
        <span>最新 token 事件：{formatChinaStandardTime(snapshot?.latestEventAt)}</span>
        <span>数据仅保存在本地，不读取正文</span>
        <span className="pulse-legal-notice">{U.LEGAL_NOTICE}</span>
      </footer>
    </main>
  );
}

function delay(milliseconds) {
  return new Promise(resolve => window.setTimeout(resolve, milliseconds));
}

function KpiCard({ accent, label, value, detail, trend = [] }) {
  return (
    <article className={`pulse-kpi accent-${accent}`}>
      <span className="kpi-icon" aria-hidden="true"/>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
      <MiniSparkline values={trend} />
    </article>
  );
}

function Panel({ title, action = null, className = '', children }) {
  return (
    <section className={`pulse-panel ${className}`}>
      <header>
        <h2>{title}</h2>
        {action && <span>{action}</span>}
      </header>
      {children}
    </section>
  );
}

function TrendLegend({ totals }) {
  return (
    <div className="trend-legend">
      <div><i className="dot-cyan"/>总消耗 tokens <strong>{formatCompactTokens(totals.totalTokens)}</strong></div>
      <div><i className="dot-green"/>官方价成本 <strong>{formatMoney(totals.costUSD)}</strong></div>
    </div>
  );
}

function TrendChart({ data }) {
  const chart = buildTrendChart(data);
  if (!chart.points.length) return <EmptyState text="近 24 小时暂无 event 级 token 数据。" />;
  return (
    <svg className="trend-chart" viewBox={`0 0 ${chart.width} ${chart.height}`} preserveAspectRatio="none" role="img" aria-label="24小时 token 和官方价趋势">
      <defs>
        <linearGradient id="tokenArea" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.36"/>
          <stop offset="100%" stopColor="currentColor" stopOpacity="0"/>
        </linearGradient>
      </defs>
      {chart.yTicks.map(tick => <line key={`h-${tick.y}`} x1={chart.left} x2={chart.plotRight} y1={tick.y} y2={tick.y} className="chart-grid"/>)}
      {chart.yTicks.map(tick => (
        <g key={`tick-${tick.y}`}>
          <text x={chart.left - 8} y={tick.y + 4} className="chart-axis" textAnchor="end">{tick.tokens}</text>
          <text x={chart.plotRight + 12} y={tick.y + 4} className="chart-axis chart-axis-right" textAnchor="start">{tick.cost}</text>
        </g>
      ))}
      {chart.labels.map(label => (
        <line key={`v-${label.index}`} x1={label.x} x2={label.x} y1={chart.top} y2={chart.plotBottom} className="chart-x-marker"/>
      ))}
      {chart.labels.map(label => (
        <text
          key={label.index}
          x={label.x}
          y={chart.height - 16}
          className="chart-label"
          textAnchor="middle"
        >
          {label.text}
        </text>
      ))}
      <path d={chart.tokenAreaPath} className="chart-token-area"/>
      <polyline points={chart.tokenPolyline} className="chart-token-line"/>
      <polyline points={chart.costPolyline} className="chart-cost-line"/>
      {chart.labels.map(label => (
        <circle key={`token-dot-${label.index}`} cx={label.x} cy={label.tokenY} r="3.4" className="chart-point chart-point-token"/>
      ))}
      {chart.labels.map(label => (
        <circle key={`cost-dot-${label.index}`} cx={label.x} cy={label.costY} r="2.8" className="chart-point chart-point-cost"/>
      ))}
    </svg>
  );
}

function MiniSparkline({ values }) {
  const points = sparklinePoints(values);
  if (!points) return <span className="kpi-sparkline empty" aria-hidden="true"/>;
  return (
    <svg className="kpi-sparkline" viewBox="0 0 92 32" aria-hidden="true">
      <polyline points={points} />
    </svg>
  );
}

function AgentRing({ activeHours, windowHours, percent }) {
  const safePercent = Math.max(0, Math.min(100, Number(percent || 0)));
  const radius = 88;
  const circumference = 2 * Math.PI * radius;
  const progress = (safePercent / 100) * circumference;
  return (
    <div className="agent-ring-wrap">
      <div className="agent-ring">
        <svg viewBox="0 0 220 220" aria-hidden="true">
          <circle className="agent-ring-track" cx="110" cy="110" r={radius}/>
          <circle
            className="agent-ring-progress"
            cx="110"
            cy="110"
            r={radius}
            strokeDasharray={`${progress.toFixed(2)} ${(circumference - progress).toFixed(2)}`}
          />
        </svg>
        <div className="agent-ring-center">
          <strong>{activeHours.toFixed(activeHours >= 10 ? 0 : 1)}h</strong>
          <span>/ {Math.round(windowHours || 24)}h</span>
        </div>
      </div>
      <b>{Math.round(safePercent)}%</b>
      <span>按 token event 时间桶计算</span>
    </div>
  );
}

function ModelRows({ rows, totalTokens }) {
  if (!rows.length) return <EmptyState text="暂无模型消耗。" />;
  return (
    <div className="model-list">
      {rows.map((row, index) => {
        const share = totalTokens ? Math.max(2, (row.totalTokens / totalTokens) * 100) : 0;
        return (
          <div className="model-row" key={row.key}>
            <span className="model-rank">{index + 1}</span>
            <div>
              <strong>{row.key}</strong>
              <i><span style={{ width: `${Math.min(100, share)}%` }}/></i>
            </div>
            <div className="model-metrics">
              <b>{formatCompactTokens(row.totalTokens)}</b>
              <small>{formatMoney(row.costUSD)}</small>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// The donut palette has five fixed hues; beyond the top four, fold the rest
// into a single "其他" slice so colors never cycle and the chart keeps
// representing 100% of the window's usage.
function foldSourceRows(rows) {
  if (rows.length <= 5) return rows;
  const kept = rows.slice(0, 4).map(row => ({ ...row }));
  const other = rows.slice(4).reduce((acc, row) => {
    acc.totalTokens += Number(row.totalTokens || 0);
    return acc;
  }, { key: '其他', totalTokens: 0 });
  return [...kept, other];
}

function SourceDonut({ rows, totalTokens }) {
  if (!rows.length) return <EmptyState text="暂无来源分布。" />;
  return (
    <div className="source-donut-layout">
      <div className="source-donut" style={{ background: sourceDonutGradient(rows, totalTokens) }}/>
      <div className="source-list">
        {rows.map((row, index) => (
          <div key={row.key}>
            <div className="source-meta">
              <span className="source-label">
                <i style={{ background: sourceColor(index) }}/>
                <span>{row.key}</span>
              </span>
              <strong>{totalTokens ? `${((row.totalTokens / totalTokens) * 100).toFixed(1)}%` : '0.0%'}</strong>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AdviceList({ warnings, snapshot }) {
  if (!warnings.length) {
    const hasBudget = (snapshot?.budgetWindows || []).some(row => Number(row.tokenBudget || row.costBudgetUSD) > 0);
    return <EmptyState text={hasBudget
      ? '当前没有触发已配置预算或效率异常。'
      : '未设置自定义预算，当前只展示实际消耗，不会把固定阈值当成超限。'} />;
  }
  const visibleWarnings = warnings.slice(0, 3);
  return (
    <div className="advice-list">
      {visibleWarnings.map(warning => (
        <article key={warning.type} className={`advice-card level-${warning.level || 'medium'}`}>
          <strong>{warning.message}</strong>
          <span>{warning.evidence}</span>
          <b>{warning.action}</b>
        </article>
      ))}
    </div>
  );
}

function EmptyState({ text }) {
  return <div className="pulse-empty">{text}</div>;
}

function buildTrendChart(data) {
  const rows = (data || []).filter(Boolean);
  if (!rows.length || !rows.some(row => Number(row.totalTokens || 0) > 0 || Number(row.costUSD || 0) > 0 || Number(row.requests || 0) > 0)) {
    return { points: [] };
  }
  const width = 1200;
  const height = 260;
  const left = 72;
  const right = 132;
  const top = 30;
  const bottom = 38;
  const innerWidth = width - left - right;
  const innerHeight = height - top - bottom;
  const maxTokens = Math.max(1, ...rows.map(row => Number(row.totalTokens || 0)));
  const maxCost = Math.max(1, ...rows.map(row => Number(row.costUSD || 0)));
  const coordFor = (index, value, max) => {
    const x = left + (rows.length === 1 ? innerWidth : (index / (rows.length - 1)) * innerWidth);
    const y = top + innerHeight - (Number(value || 0) / max) * innerHeight;
    return { x, y };
  };
  const tokenCoords = rows.map((row, index) => coordFor(index, row.totalTokens, maxTokens));
  const costCoords = rows.map((row, index) => coordFor(index, row.costUSD, maxCost));
  const tokenPoints = tokenCoords.map(pointText);
  const costPoints = costCoords.map(pointText);
  const firstX = tokenPoints[0].split(',')[0];
  const lastX = tokenPoints[tokenPoints.length - 1].split(',')[0];
  const tokenAreaPath = `M ${firstX} ${top + innerHeight} L ${tokenPoints.join(' L ')} L ${lastX} ${top + innerHeight} Z`;
  const labelIndexes = trendPointLabelIndexes(rows);
  const xForIndex = index => left + (rows.length === 1 ? innerWidth : (index / (rows.length - 1)) * innerWidth);
  const labels = labelIndexes.map(index => ({
    index,
    x: xForIndex(index),
    tokenY: tokenCoords[index].y,
    costY: costCoords[index].y,
    text: formatChartTimeLabel(rows[index])
  }));
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(ratio => ({
    y: top + innerHeight - ratio * innerHeight,
    tokens: formatCompactTokens(maxTokens * ratio),
    cost: formatAxisMoney(maxCost * ratio)
  }));
  return {
    width,
    height,
    top,
    left,
    plotRight: width - right,
    plotBottom: top + innerHeight,
    points: tokenPoints,
    tokenPolyline: tokenPoints.join(' '),
    costPolyline: costPoints.join(' '),
    tokenAreaPath,
    labels,
    yTicks
  };
}

function pointText(point) {
  return `${point.x.toFixed(1)},${point.y.toFixed(1)}`;
}

function trendPointLabelIndexes(rows) {
  const lastIndex = rows.length - 1;
  if (lastIndex <= 0) return [0];
  const values = rows.map(row => ({
    tokens: Number(row.totalTokens || 0),
    cost: Number(row.costUSD || 0),
    requests: Number(row.requests || 0)
  }));
  const isActive = index => {
    const row = values[index];
    return Boolean(row && (row.tokens > 0 || row.cost > 0 || row.requests > 0));
  };
  const scoreAt = index => {
    const current = values[index];
    const prev = values[Math.max(0, index - 1)] || current;
    const next = values[Math.min(lastIndex, index + 1)] || current;
    const tokenSwing = Math.abs(current.tokens - prev.tokens) + Math.abs(next.tokens - current.tokens);
    const costSwing = Math.abs(current.cost - prev.cost) + Math.abs(next.cost - current.cost);
    let score = tokenSwing + costSwing * 100000;
    if (current.tokens > prev.tokens && current.tokens >= next.tokens) score *= 1.5;
    if (current.tokens < prev.tokens && current.tokens <= next.tokens) score *= 1.25;
    if ((prev.tokens === 0 && current.tokens > 0) || (current.tokens > 0 && next.tokens === 0)) score *= 1.2;
    return score;
  };
  const candidates = [];

  for (let index = 0; index <= lastIndex; index += 1) {
    const nearActivity = isActive(index) || isActive(index - 1) || isActive(index + 1);
    if (nearActivity) {
      const score = scoreAt(index);
      if (score > 0) candidates.push({ index, score });
    }
  }

  const picked = [0, lastIndex];
  const maxLabels = Math.min(12, rows.length);
  const minGap = Math.max(1, Math.floor(lastIndex / maxLabels));
  for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
    if (picked.length >= maxLabels) break;
    if (picked.includes(candidate.index)) continue;
    if (picked.some(index => Math.abs(index - candidate.index) < minGap)) continue;
    picked.push(candidate.index);
  }

  if (picked.length < maxLabels) {
    for (let step = 1; step < maxLabels - 1 && picked.length < maxLabels; step += 1) {
      const ratio = step / (maxLabels - 1);
      const index = Math.round(lastIndex * ratio);
      if (!picked.includes(index)) picked.push(index);
    }
  }

  if (picked.length < maxLabels) {
    for (let index = 1; index < lastIndex && picked.length < maxLabels; index += 1) {
      if (!picked.includes(index)) picked.push(index);
    }
  }

  return [...new Set(picked)].sort((a, b) => a - b).slice(0, maxLabels);
}

function sparklinePoints(values = []) {
  const rows = values.map(value => Number(value || 0));
  if (!rows.some(value => value > 0)) return '';
  const max = Math.max(...rows, 1);
  return rows.map((value, index) => {
    const x = rows.length === 1 ? 46 : (index / (rows.length - 1)) * 92;
    const y = 30 - (value / max) * 28;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

function sourceDonutGradient(rows, totalTokens) {
  let cursor = 0;
  const stops = rows.map((row, index) => {
    const share = totalTokens ? (row.totalTokens / totalTokens) * 100 : 0;
    const start = cursor;
    cursor += share;
    return `${sourceColor(index)} ${start.toFixed(2)}% ${cursor.toFixed(2)}%`;
  });
  if (cursor < 100) stops.push(`rgba(145,168,186,.18) ${cursor.toFixed(2)}% 100%`);
  return `conic-gradient(${stops.join(', ')})`;
}

function sourceColor(index) {
  return ['#36d1c4', '#ff8b72', '#a78bfa', '#e6be56', '#78a6ff'][index % 5];
}

function freshnessLabel(value) {
  if (value === 'fresh') return '在线';
  if (value === 'collecting') return '采集中';
  if (value === 'stale') return '可能过期';
  if (value === 'network-error') return '连接异常';
  if (value === 'error') return '采集失败';
  if (value === 'empty') return '空数据';
  return '加载中';
}

function formatNumber(value) {
  return Math.round(Number(value || 0)).toLocaleString('en-US');
}

function formatMoney(value) {
  return U.money(value);
}

function formatAxisMoney(value) {
  return U.compactMoney(value);
}

function formatChartTimeLabel(row) {
  const value = row?.start || row?.timestamp || row?.label;
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return row?.label || '';
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value || '00';
  return `${get('hour')}:${get('minute')}`;
}

function formatPercent(value) {
  return Number(value || 0).toFixed(1);
}

function formatCompactTokens(value) {
  const number = Number(value || 0);
  if (number >= 100_000_000) return `${(number / 100_000_000).toFixed(number >= 1_000_000_000 ? 2 : 1)}亿`;
  if (number >= 10_000) return `${(number / 10_000).toFixed(number >= 1_000_000 ? 1 : 0)}万`;
  return formatNumber(number);
}

function formatChinaStandardTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')} UTC+8`;
}
