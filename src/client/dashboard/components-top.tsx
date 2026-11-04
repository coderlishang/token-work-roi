/* =============================================================
   Filter bar, KPI cards, sparklines — top of dashboard
   ============================================================= */

import { useState, useEffect, useRef } from 'react';
import { U } from '../shared/utils.ts';

// ───────────────────────────────────────────────────────────────
// Topbar
// ───────────────────────────────────────────────────────────────
function Topbar({ lastSync, onRefresh, refreshing, onCollect, collecting, collectStatus, demoMode = false, onOpenImportBudget, activePage = 'dashboard' }) {
  return (
    <div className="topbar">
      <div className="topbar-left">
        <div className="brand">
          <img className="brand-mark" src="/token-work-icon.svg" alt="" aria-hidden="true" />
          <div>
            <h1>元衡</h1>
            <p className="brand-sub">Token Work ROI</p>
          </div>
        </div>
        <div className="page-switch">
          {activePage === 'dashboard'
            ? <span className="page-chip active">看板</span>
            : <a href="/" className="page-chip">看板</a>}
          <a href="/review" className="page-chip">复盘</a>
          {activePage === 'trust'
            ? <span className="page-chip active">可信度</span>
            : <a href="/trust" className="page-chip">可信度</a>}
          <a href="/live" className="page-chip">实时</a>
        </div>
        {demoMode && <span className="demo-mode-badge">Demo Mode</span>}
      </div>
      <div className="topbar-right">
        {collectStatus && (
          <div className={`collect-pill collect-${collectStatus.type}`} title={collectStatus.message}>
            <span className="collect-dot"></span>
            <span>{collectStatus.type === 'running' ? '采集中' : collectStatus.type === 'ok' ? '采集完成' : '采集失败'}</span>
          </div>
        )}
        <div className="sync-pill">
          <span className="sync-dot"></span>
          <span>最后同步 <strong style={{color:'var(--text)', fontWeight:600}}>{lastSync}</strong></span>
        </div>
        <button className="btn" onClick={onOpenImportBudget} title="导入与预算">
          <svg className="icon" viewBox="0 0 16 16" fill="none">
            <path d="M3 4.5h10M3 8h10M3 11.5h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
            <path d="M11.5 10v3M10 11.5h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
          </svg>
          导入/预算
        </button>
        <button className={`btn btn-primary ${collecting ? 'loading' : ''}`} onClick={onCollect} disabled={collecting || refreshing}>
          <svg className={`icon ${collecting ? 'spin' : ''}`} viewBox="0 0 16 16" fill="none" style={{opacity:1}}>
            <path d="M4 6.5h8M4 9.5h8" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round"/>
            <path d="M3.5 4.5c0-.83 2.01-1.5 4.5-1.5s4.5.67 4.5 1.5v7c0 .83-2.01 1.5-4.5 1.5s-4.5-.67-4.5-1.5v-7Z" stroke="currentColor" strokeWidth="1.35"/>
            <circle cx="8" cy="8" r="1.25" fill="currentColor"/>
          </svg>
          {collecting ? '采集中' : '采集'}
        </button>
        <button className={`btn btn-primary ${refreshing ? 'loading' : ''}`} onClick={onRefresh}>
          <svg className={`icon ${refreshing ? 'spin' : ''}`} viewBox="0 0 16 16" fill="none" style={{opacity:1}}>
            <path d="M3 3v3h3M13 13v-3h-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M13 7A5 5 0 0 0 4 5M3 9a5 5 0 0 0 9 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          {refreshing ? '同步中' : '刷新'}
        </button>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────
// Filter bar
// ───────────────────────────────────────────────────────────────
function FilterBar({ f, setF, allSources, allDevices, allModels, availableRange, onExport }) {
  const currentStartDateTime = f.startDateTime || `${f.startDate}T00:00`;
  const currentEndDateTime = f.endDateTime || `${f.endDate}T23:59`;
  const [customDraft, setCustomDraft] = useState(() => ({
    startDateTime: currentStartDateTime,
    endDateTime: currentEndDateTime
  }));
  const [customOpen, setCustomOpen] = useState(false);
  const customRef = useRef(null);

  useEffect(() => {
    setCustomDraft({
      startDateTime: currentStartDateTime,
      endDateTime: currentEndDateTime
    });
  }, [currentStartDateTime, currentEndDateTime]);

  useEffect(() => {
    if (!customOpen) return undefined;
    const onDown = (event) => {
      if (!customRef.current?.contains(event.target)) {
        setCustomOpen(false);
        setCustomDraft({
          startDateTime: currentStartDateTime,
          endDateTime: currentEndDateTime
        });
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [customOpen, currentStartDateTime, currentEndDateTime]);

  const RANGES = [
    { id: 'today', label: '当天', days: 1 },
    { id: '7d',  label: '7 天',  days: 7  },
    { id: '14d', label: '14 天', days: 14 },
    { id: '30d', label: '30 天', days: 30 },
    { id: '90d', label: '90 天', days: 90 },
    { id: 'all', label: '全部' }
  ];

  const setRange = (r) => {
    if (r.id === 'all') {
      setF({
        ...f,
        rangeId: r.id,
        startDate: availableRange.startDate,
        endDate: availableRange.endDate,
        startDateTime: `${availableRange.startDate}T00:00`,
        endDateTime: `${availableRange.endDate}T23:59`
      });
      return;
    }
    const startDate = U.daysAgo(r.days - 1);
    const endDate = U.daysAgo(0);
    setF({
      ...f,
      rangeId: r.id,
      startDate,
      endDate,
      startDateTime: `${startDate}T00:00`,
      endDateTime: `${endDate}T23:59`
    });
  };

  const setCustomDraftDateTime = (key, value) => {
    if (!value) return;
    setCustomDraft(prev => {
      const next = { ...prev, [key]: value };
      if (next.startDateTime && next.endDateTime && next.startDateTime > next.endDateTime) {
        if (key === 'startDateTime') next.endDateTime = next.startDateTime;
        else next.startDateTime = next.endDateTime;
      }
      return next;
    });
    setF(current => {
      const next = { ...current, rangeId: 'custom', [key]: value };
      if (next.startDateTime && next.endDateTime && next.startDateTime > next.endDateTime) {
        if (key === 'startDateTime') next.endDateTime = next.startDateTime;
        else next.startDateTime = next.endDateTime;
      }
      return {
        ...next,
        startDate: next.startDateTime.slice(0, 10),
        endDate: next.endDateTime.slice(0, 10)
      };
    });
  };

  const toggleSet = (key, value) => {
    const next = new Set(f[key]);
    if (next.has(value)) next.delete(value); else next.add(value);
    setF({ ...f, [key]: next });
  };

  const clearAll = () => {
    setF({ ...f, sources: new Set(), devices: new Set(), models: new Set() });
  };

  const filtersActive = f.sources.size + f.devices.size + f.models.size;

  return (
    <div className="filterbar">
      <div className="filter-row filter-row-primary">
        <div className="filter-group">
          <span className="filter-label">时间</span>
          <div className="chip-row">
            {RANGES.map(r => (
              <button key={r.id}
                className={`chip ${f.rangeId === r.id ? 'active' : ''}`}
                onClick={() => setRange(r)}>{r.label}</button>
            ))}
          </div>
          <div className="date-range-picker" ref={customRef}>
            <span className="date-range-hint">支持自定义日期与时间</span>
            <button
              type="button"
              className={`date-range-control ${f.rangeId === 'custom' ? 'active' : ''}`}
              aria-expanded={customOpen}
              aria-haspopup="dialog"
              onClick={() => setCustomOpen(open => !open)}>
              <span>{currentStartDateTime.replace('T', ' ')}</span>
              <span>至</span>
              <span>{currentEndDateTime.replace('T', ' ')}</span>
            </button>
            {customOpen && (
              <div className="date-range-popover" role="dialog" aria-label="选择自定义日期与时间">
                <div className="date-range-popover-title">支持自定义日期与时间</div>
                <label className="date-range-field">
                  <span>开始时间</span>
                  <input
                    type="datetime-local"
                    value={customDraft.startDateTime}
                    max={customDraft.endDateTime || undefined}
                    onChange={e => setCustomDraftDateTime('startDateTime', e.target.value)} />
                </label>
                <label className="date-range-field">
                  <span>结束时间</span>
                  <input
                    type="datetime-local"
                    value={customDraft.endDateTime}
                    min={customDraft.startDateTime || undefined}
                    onChange={e => setCustomDraftDateTime('endDateTime', e.target.value)} />
                </label>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="filter-row">
        <div className="filter-group filter-group-sources">
          <span className="filter-label">来源</span>
          {allSources.map(s => (
            <button key={s}
              className={`pill ${f.sources.has(s) ? 'active' : ''}`}
              style={f.sources.has(s) ? {color: U.PALETTE[s] || ''} : {}}
              onClick={() => toggleSet('sources', s)}>
              <span className="pill-dot" style={{background: U.PALETTE[s] || ''}}/>
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className="filter-row filter-row-secondary">
        <div className="filter-group">
          <span className="filter-label">设备</span>
          <MultiSelect
            options={allDevices}
            selected={f.devices}
            onChange={v => setF({...f, devices: v})}
            placeholder="全部设备"/>
          <span className="filter-label" style={{marginLeft: 4}}>模型</span>
          <MultiSelect
            options={allModels}
            selected={f.models}
            onChange={v => setF({...f, models: v})}
            placeholder="全部模型"/>
        </div>

        <div className="filter-spacer"/>

        {filtersActive > 0 && (
          <button className="btn" onClick={clearAll}>
            <svg className="icon" viewBox="0 0 16 16" fill="none">
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
            </svg>
            清除筛选 · {filtersActive}
          </button>
        )}
        <button className={`toggle ${f.compare ? 'on' : ''}`} onClick={() => setF({...f, compare: !f.compare})}>
          <span className="toggle-slot"/>
          对比上一周期
        </button>
        <button className="btn" onClick={onExport}>
          <svg className="icon" viewBox="0 0 16 16" fill="none">
            <path d="M8 2v8M5 7l3 3 3-3M3 13h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          导出
        </button>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────
// MultiSelect — dropdown with checkboxes
// ───────────────────────────────────────────────────────────────
function MultiSelect({ options, selected, onChange, placeholder }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const onDocClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const label = selected.size === 0
    ? placeholder
    : selected.size === 1
      ? Array.from(selected)[0]
      : `${selected.size} 项已选`;

  const toggle = (v) => {
    const next = new Set(selected);
    if (next.has(v)) next.delete(v); else next.add(v);
    onChange(next);
  };

  return (
    <div ref={ref} style={{position:'relative', display:'inline-block'}}>
      <button className={`pill ${selected.size ? 'active' : ''}`} onClick={() => setOpen(o => !o)}
        style={{paddingLeft: 10, fontWeight: selected.size ? 600 : 400}}>
        {label}
        <svg width="9" height="9" viewBox="0 0 9 9" fill="none" style={{marginLeft:2, opacity:0.5}}>
          <path d="M1 3l3.5 3L8 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
      {open && (
        <div style={{
          position:'absolute', top:'calc(100% + 6px)', left:0, zIndex:30,
          minWidth: 220, background: 'var(--surface)',
          border: '1px solid var(--border)', borderRadius: 8,
          boxShadow: '0 10px 30px -10px rgb(0 0 0 / 0.15)',
          padding: 4, maxHeight: 280, overflowY: 'auto'
        }}>
          {selected.size > 0 && (
            <button className="chip" style={{width:'100%', justifyContent:'flex-start', color: 'var(--c-indigo)', fontSize: 11.5}}
              onClick={() => onChange(new Set())}>清除选择</button>
          )}
          {options.map(o => (
            <button key={o} className="chip"
              onClick={() => toggle(o)}
              style={{width:'100%', justifyContent:'flex-start', gap:8, fontWeight:400}}>
              <span style={{
                width: 14, height: 14, borderRadius: 3,
                border: '1.5px solid ' + (selected.has(o) ? 'var(--c-indigo)' : 'var(--border)'),
                background: selected.has(o) ? 'var(--c-indigo)' : 'transparent',
                display: 'grid', placeItems: 'center', flexShrink: 0
              }}>
                {selected.has(o) && (
                  <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
                    <path d="M1.5 4.5L4 7l3.5-5" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                )}
              </span>
              <span style={{overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', fontSize: 12}}>{o}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────
// Sparkline SVG
// ───────────────────────────────────────────────────────────────
function Spark({ values, color, height = 30, fill = true }) {
  if (!values || values.length === 0) return null;
  const w = 100, h = height;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1 || 1)) * w;
    const y = h - ((v - min) / range) * (h - 2) - 1;
    return [x, y];
  });
  const d = pts.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(' ');
  const dArea = d + ` L${w},${h} L0,${h} Z`;

  return (
    <svg className="kpi-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      {fill && <path d={dArea} fill={color} opacity="0.12"/>}
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"/>
    </svg>
  );
}

// ───────────────────────────────────────────────────────────────
// Delta pill
// ───────────────────────────────────────────────────────────────
function Delta({ value, suffix = '%', invert = false }) {
  if (value == null || !isFinite(value)) {
    return <span className="delta flat">—</span>;
  }
  const positive = value > 0.05;
  const negative = value < -0.05;
  const flat = !positive && !negative;
  const cls = flat ? 'flat' : (positive ? (invert ? 'down' : 'up') : (invert ? 'up' : 'down'));
  const arrow = flat ? '·' : (positive ? '↑' : '↓');
  return (
    <span className={`delta ${cls}`}>
      {arrow} {Math.abs(value).toFixed(1)}{suffix}
    </span>
  );
}

// ───────────────────────────────────────────────────────────────
// KPI card
// ───────────────────────────────────────────────────────────────
function KPI({ label, value, sub, delta, dotColor = null, sparkValues, sparkColor }) {
  return (
    <div className="kpi">
      <div className="kpi-label">
        <span style={{display:'inline-flex', alignItems:'center', gap:6}}>
          {dotColor && <span className="dot" style={{color: dotColor}}/>}
          {label}
        </span>
      </div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-sub">
        {delta != null && <Delta value={delta}/>}
        <span>{sub}</span>
      </div>
      {sparkValues && <Spark values={sparkValues} color={sparkColor || 'var(--c-indigo)'}/>}
    </div>
  );
}

export { Topbar, FilterBar, KPI, Delta };
