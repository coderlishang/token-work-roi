/* =============================================================
   Tables — sortable, searchable, drill-down rows
   ============================================================= */

import { useEffect, useMemo, useRef, useState } from 'react';
import { U } from '../shared/utils.ts';
import {
  buildReviewAttributionChecklist,
  buildReviewAttributionProgress,
  buildReviewUnattributedSessions,
  buildUnattributedSessions
} from './attribution.ts';
import {
  applyAnnotationTemplate,
  QUICK_ANNOTATION_TEMPLATES,
  readAnnotationPresets,
  rememberAnnotationPreset,
  writeAnnotationPresets
} from './annotation-presets.ts';
import { buildSessionKey, buildTableRowKey, createUniqueRowKeyFactory } from './table-keys.ts';
import type { UsageRow } from '../shared/types.ts';

// Generic data table
function DataTable({ rows, columns, initialSort, search, onRowClick, selectedKey = null, getKey, height, emptyText }) {
  const [sortBy, setSortBy] = useState(initialSort || { field: null, dir: 'desc' });

  const filtered = useMemo(() => {
    if (!search) return rows;
    const q = search.toLowerCase();
    return rows.filter(r =>
      columns.some(c => {
        const v = typeof c.value === 'function' ? c.value(r) : r[c.field];
        return String(v ?? '').toLowerCase().includes(q);
      })
    );
  }, [rows, columns, search]);

  const sorted = useMemo(() => {
    if (!sortBy.field) return filtered;
    const arr = [...filtered];
    const col = columns.find(c => c.field === sortBy.field);
    if (!col) return arr;
    arr.sort((a, b) => {
      const va = typeof col.value === 'function' ? col.value(a) : a[col.field];
      const vb = typeof col.value === 'function' ? col.value(b) : b[col.field];
      if (typeof va === 'number' && typeof vb === 'number') return sortBy.dir === 'asc' ? va - vb : vb - va;
      const sa = String(va ?? '').toLowerCase();
      const sb = String(vb ?? '').toLowerCase();
      return sortBy.dir === 'asc' ? sa.localeCompare(sb) : sb.localeCompare(sa);
    });
    return arr;
  }, [filtered, sortBy, columns]);

  const toggleSort = (field) => {
    setSortBy(prev =>
      prev.field === field
        ? { field, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { field, dir: 'desc' }
    );
  };

  const rowKey = createUniqueRowKeyFactory(getKey);

  return (
    <div className="table-wrap" style={{maxHeight: height, overflow: 'auto'}}>
      <table className="dt">
        <thead>
          <tr>
            {columns.map(c => (
              <th key={c.field || c.title}
                onClick={() => c.sortable !== false && toggleSort(c.field)}
                className={sortBy.field === c.field ? 'sorted' : ''}
                style={{
                  width: c.width,
                  textAlign: c.hozAlign === 'right' ? 'right' : 'left',
                  cursor: c.sortable === false ? 'default' : 'pointer'
                }}>
                {c.title}
                {c.sortable !== false && (
                  <span className="sort-ind">
                    {sortBy.field === c.field ? (sortBy.dir === 'asc' ? '▲' : '▼') : '▾'}
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 && (
            <tr><td colSpan={columns.length} style={{textAlign:'center', padding:'30px', color:'var(--muted)'}}>{emptyText || '暂无数据'}</td></tr>
          )}
          {sorted.map((r, i) => {
            const k = rowKey(r, i);
            return (
              <tr key={k}
                className={selectedKey === k ? 'selected' : ''}
                onClick={() => onRowClick?.(r)}>
                {columns.map(c => (
                  <td key={c.field || c.title}
                    style={{textAlign: c.hozAlign === 'right' ? 'right' : 'left'}}>
                    {c.render ? c.render(r) : (typeof c.value === 'function' ? c.value(r) : r[c.field])}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────
// Combined tabbed table panel
// ───────────────────────────────────────────────────────────────
function TablePanel({
  daily,
  sessions,
  unattributedSessions,
  runs,
  totalTokens,
  sessionTotalTokens,
  taskTypes,
  outputStatuses,
  workPurposes,
  workStages,
  valueLevels,
  outputTypes,
  projectAliasRules,
  projectAliasMatchTypes,
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
  onDrill
}) {
  const [tab, setTab] = useState('sources');
  const [search, setSearch] = useState('');
  const [editingSession, setEditingSession] = useState(null);
  const [annotationBusy, setAnnotationBusy] = useState(false);
  const [annotationError, setAnnotationError] = useState(null);
  const [selectedSessions, setSelectedSessions] = useState(() => new Set());
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchError, setBatchError] = useState(null);
  const [editingRule, setEditingRule] = useState(null);
  const [ruleBusy, setRuleBusy] = useState(false);
  const [ruleError, setRuleError] = useState(null);
  const [panelMessage, setPanelMessage] = useState(null);
  const [annotationPresets, setAnnotationPresets] = useState(() => readAnnotationPresets());
  const importRef = useRef(null);
  const formatRunTime = r => U.formatTs(r.collectedAt);
  const queueRows = useMemo(
    () => unattributedSessions || buildUnattributedSessions(sessions),
    [sessions, unattributedSessions]
  );
  const reviewQueueRows = useMemo(
    () => buildReviewUnattributedSessions(sessions),
    [sessions]
  );
  const reviewProgress = useMemo(
    () => buildReviewAttributionProgress(sessions),
    [sessions]
  );
  const attributionTotalTokens = sessionTotalTokens ?? sessions.reduce((sum, s) => sum + (s.totalTokens || 0), 0);
  const selectedSessionRows = useMemo(
    () => sessions.filter(session => selectedSessions.has(sessionKey(session))),
    [sessions, selectedSessions]
  );

  // Aggregate by source
  const bySource = useMemo(() => {
    const m = new Map();
    for (const r of daily) {
      const k = `${r.source}::${r.device}`;
      if (!m.has(k)) m.set(k, { source: r.source, device: r.device, totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUSD: 0, models: new Set() });
      const x = m.get(k);
      x.totalTokens += r.totalTokens;
      x.inputTokens += r.inputTokens;
      x.outputTokens += r.outputTokens;
      x.cacheReadTokens += r.cacheReadTokens;
      x.costUSD += r.costUSD;
      x.models.add(r.modelLabel || r.model);
    }
    return Array.from(m.values()).map(x => ({...x, modelCount: x.models.size}));
  }, [daily]);

  const byModel = useMemo(() => {
    const m = new Map();
    for (const r of daily) {
      const k = `${r.source}::${r.modelLabel || r.model}`;
      if (!m.has(k)) m.set(k, { source: r.source, model: r.modelLabel || r.model, totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUSD: 0, days: new Set() });
      const x = m.get(k);
      x.totalTokens += r.totalTokens;
      x.inputTokens += r.inputTokens;
      x.outputTokens += r.outputTokens;
      x.cacheReadTokens += r.cacheReadTokens;
      x.costUSD += r.costUSD;
      x.days.add(r.usageDate);
    }
    return Array.from(m.values()).map(x => ({...x, dayCount: x.days.size}));
  }, [daily]);

  const attributionRows = useMemo(() => {
    const m = new Map();
    for (const s of sessions) {
      const project = sessionProjectLabel(s);
      const taskType = s.taskType || '未分类';
      const outputStatus = s.outputStatus || '未标注';
      const workPurpose = s.workPurpose || '未说明';
      const workStage = s.workStage || '未说明';
      const valueLevel = s.valueLevel || '未评估';
      const k = `${project}::${taskType}::${outputStatus}::${workPurpose}::${workStage}::${valueLevel}`;
      if (!m.has(k)) {
        m.set(k, {
          project,
          taskType,
          outputStatus,
          workPurpose,
          workStage,
          valueLevel,
          sessionCount: 0,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUSD: 0,
          sources: new Set(),
          devices: new Set()
        });
      }
      const x = m.get(k);
      x.sessionCount += 1;
      x.totalTokens += s.totalTokens || 0;
      x.inputTokens += s.inputTokens || 0;
      x.outputTokens += s.outputTokens || 0;
      x.costUSD += s.costUSD || 0;
      if (s.source) x.sources.add(s.source);
      if (s.device) x.devices.add(s.device);
    }
    return Array.from(m.values()).map(x => ({
      ...x,
      sourceCount: x.sources.size,
      deviceCount: x.devices.size
    }));
  }, [sessions]);

  const TABS = [
    { id: 'sources', label: '来源 / 设备', count: bySource.length },
    { id: 'models',  label: '模型',        count: byModel.length },
    { id: 'sessions', label: '项目 / 会话', count: sessions.length },
    { id: 'unattributed', label: '待确认队列', count: queueRows.length },
    { id: 'attribution', label: '任务归因', count: attributionRows.length },
    { id: 'aliasRules', label: '别名规则', count: projectAliasRules.length },
    { id: 'runs',    label: '采集记录',    count: runs.length }
  ];

  const isSessionTab = tab === 'sessions' || tab === 'unattributed';
  const visibleSessionRows = tab === 'unattributed' ? queueRows : sessions;
  const allVisibleSelected = visibleSessionRows.length > 0
    && visibleSessionRows.every(row => selectedSessions.has(sessionKey(row)));

  const setVisibleSelection = (checked) => {
    setSelectedSessions(prev => {
      const next = new Set(prev);
      for (const row of visibleSessionRows) {
        const key = sessionKey(row);
        if (checked) next.add(key); else next.delete(key);
      }
      return next;
    });
  };

  const toggleSessionSelection = (session) => {
    const key = sessionKey(session);
    setSelectedSessions(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  const openAnnotation = (session) => {
    setAnnotationError(null);
    setEditingSession(session);
  };
  const openTopReviewGap = () => {
    const next = reviewQueueRows[0];
    if (next) {
      setTab('unattributed');
      setSearch('');
      openAnnotation(next);
    }
  };
  const copyReviewChecklist = async () => {
    try {
      await copyText(buildReviewAttributionChecklist(sessions, { limit: 10 }));
      setPanelMessage({ type: 'ok', text: '已复制最高成本归因工作清单' });
    } catch {
      setPanelMessage({ type: 'error', text: '复制失败，请检查浏览器剪贴板权限' });
    }
  };
  const nextReviewSession = (session) => {
    const key = sessionKey(session);
    return reviewQueueRows.find(row => sessionKey(row) !== key) || null;
  };

  // Columns per tab
  const sourceColumns = [
    { field: 'source', title: '来源', render: r => (
      <span className="tag"><span className="tag-dot" style={{background: U.getSourceColor(r.source)}}/>{r.source}</span>
    )},
    { field: 'device', title: '设备', render: r => <span className="muted" style={{fontSize:11.5}}>{r.device}</span> },
    { field: 'modelCount', title: '模型', hozAlign: 'right', render: r => r.modelCount, width: 70 },
    { field: 'totalTokens', title: 'Total', hozAlign: 'right', render: r => (
      <span className="num-strong">{U.fmt.format(r.totalTokens)}</span>
    ), width: 130 },
    { field: 'share', title: '占比', hozAlign: 'left',
      value: r => r.totalTokens / (totalTokens || 1),
      render: r => {
        const p = (r.totalTokens / (totalTokens || 1)) * 100;
        return (
          <span>
            <span className="share-bar"><span style={{width: `${Math.min(100, p)}%`, background: U.getSourceColor(r.source)}}/></span>
            <span className="share-pct">{p.toFixed(1)}%</span>
          </span>
        );
      }, width: 180
    },
    { field: 'inputTokens', title: 'Input', hozAlign: 'right', render: r => U.compact(r.inputTokens), width: 80 },
    { field: 'outputTokens', title: 'Output', hozAlign: 'right', render: r => U.compact(r.outputTokens), width: 80 },
    { field: 'cacheReadTokens', title: 'Cache', hozAlign: 'right', render: r => U.compact(r.cacheReadTokens), width: 80 },
    { field: 'costUSD', title: '官方价', hozAlign: 'right', render: r => (
      r.costUSD > 0 ? <span style={{color:'var(--c-amber)'}}>{U.money(r.costUSD)}</span> : <span className="muted">—</span>
    ), width: 90 }
  ];

  const modelColumns = [
    { field: 'source', title: '来源', render: r => (
      <span className="tag"><span className="tag-dot" style={{background: U.getSourceColor(r.source)}}/>{r.source}</span>
    )},
    { field: 'model', title: '模型', render: r => <span className="mono">{r.model}</span> },
    { field: 'dayCount', title: '活跃天', hozAlign: 'right', render: r => r.dayCount, width: 80 },
    { field: 'inputTokens', title: 'Input', hozAlign: 'right', render: r => U.compact(r.inputTokens), width: 90 },
    { field: 'outputTokens', title: 'Output', hozAlign: 'right', render: r => U.compact(r.outputTokens), width: 90 },
    { field: 'cacheReadTokens', title: 'Cache Read', hozAlign: 'right', render: r => U.compact(r.cacheReadTokens), width: 110 },
    { field: 'totalTokens', title: 'Total', hozAlign: 'right', render: r => (
      <span className="num-strong">{U.fmt.format(r.totalTokens)}</span>
    ), width: 130 },
    { field: 'costUSD', title: '官方价', hozAlign: 'right', render: r => (
      r.costUSD > 0 ? <span style={{color:'var(--c-amber)'}}>{U.money4(r.costUSD)}</span> : <span className="muted">—</span>
    ), width: 100 }
  ];

  const selectionColumn = {
    field: 'selected',
    title: (
      <input
        type="checkbox"
        aria-label="选择当前列表"
        checked={allVisibleSelected}
        onChange={event => setVisibleSelection(event.target.checked)}
        onClick={event => event.stopPropagation()} />
    ),
    sortable: false,
    export: false,
    width: 42,
    render: r => (
      <input
        type="checkbox"
        aria-label="选择会话"
        checked={selectedSessions.has(sessionKey(r))}
        onChange={() => toggleSessionSelection(r)}
        onClick={event => event.stopPropagation()} />
    )
  };

  const sessionColumns = [
    { field: 'source', title: '来源', render: r => (
      <span className="tag"><span className="tag-dot" style={{background: U.getSourceColor(r.source)}}/>{r.source}</span>
    ), width: 130 },
    { field: 'model', title: '模型', render: r => (
      r.model ? <span className="mono">{r.model}</span> : <span className="muted">—</span>
    ), width: 150 },
    { field: 'projectLabel', title: '项目', value: sessionProjectLabel, render: r => {
      const raw = safeProjectPathLabel(r.projectPath) || safeProjectPathLabel(r.sessionId) || '—';
      return (
        <span className="session-project" title={sessionProjectLabel(r)}>
          <span className="mono">{sessionProjectLabel(r)}</span>
          {r.projectAlias && <span className="session-project-raw">路径末级：{raw}</span>}
          {r.ruleProjectAlias && !r.manualProjectAlias && <span className="session-project-rule">规则建议</span>}
        </span>
      );
    }},
    { field: 'taskType', title: '任务', render: r => <span className="tag tag-soft">{r.taskType || '未分类'}</span>, width: 110 },
    { field: 'outputStatus', title: '状态', render: r => (
      <span className={`status-badge annotation-status-${statusClass(r.outputStatus)}`}>{r.outputStatus || '未标注'}</span>
    ), width: 100 },
    { field: 'workPurpose', title: '目的', render: r => <span className="tag tag-soft">{r.workPurpose || '未说明'}</span>, width: 110 },
    { field: 'workStage', title: '阶段', render: r => <span className="tag tag-soft">{r.workStage || '未说明'}</span>, width: 90 },
    { field: 'valueLevel', title: '价值', render: r => <span className={`status-badge value-level-${valueClass(r.valueLevel)}`}>{r.valueLevel || '未评估'}</span>, width: 90 },
    { field: 'attributionQuality', title: '归因', value: r => attributionLabel(r), render: r => <AttributionSourceBadge session={r}/>, width: 110 },
    { field: 'annotationSource', title: '归因来源', value: r => attributionSourceText(r), render: r => <span className="muted">{attributionSourceText(r) || '—'}</span>, width: 90 },
    { field: 'annotationConfidence', title: '置信度', value: r => r.annotationConfidence ?? r.autoSuggestion?.annotationConfidence ?? '', render: r => {
      const value = r.annotationConfidence ?? r.autoSuggestion?.annotationConfidence;
      return value == null ? <span className="muted">—</span> : <span className="num-strong">{value}%</span>;
    }, width: 80 },
    { field: 'annotationReason', title: '归因原因', value: r => r.annotationReason || r.autoSuggestion?.annotationReason || '', render: r => (
      r.annotationReason || r.autoSuggestion?.annotationReason
        ? <span title={r.annotationReason || r.autoSuggestion?.annotationReason} className="annotation-note">{r.annotationReason || r.autoSuggestion?.annotationReason}</span>
        : <span className="muted">—</span>
    ), width: 180 },
    { field: 'note', title: '备注', render: r => (
      r.note
        ? <span title={r.note} className="annotation-note">{r.note}</span>
        : <span className="muted">—</span>
    ), width: 150 },
    { field: 'outputLink', title: '产出', value: r => r.outputUrl ? `${r.outputLabel || ''} ${r.outputUrl}` : '', render: r => (
      r.outputUrl
        ? <a className="output-link" href={r.outputUrl} target="_blank" rel="noreferrer" onClick={event => event.stopPropagation()}>
            {r.outputLabel || r.outputType || '产出链接'}
          </a>
        : <span className="muted">—</span>
    ), width: 130 },
    { field: 'outputType', title: '类型', render: r => r.outputUrl ? <span className="tag tag-soft">{r.outputType || '未分类'}</span> : <span className="muted">—</span>, width: 90 },
    { field: 'lastActivity', title: '最后活动', render: r => (
      <span className="muted" style={{fontSize:11.5}}>{r.lastActivity}</span>
    ), width: 130 },
    { field: 'inputTokens', title: 'Input', hozAlign: 'right', render: r => U.compact(r.inputTokens), width: 90 },
    { field: 'outputTokens', title: 'Output', hozAlign: 'right', render: r => U.compact(r.outputTokens), width: 90 },
    { field: 'totalTokens', title: 'Total', hozAlign: 'right', render: r => (
      <span className="num-strong">{U.fmt.format(r.totalTokens)}</span>
    ), width: 130 },
    { field: 'costUSD', title: '官方价', hozAlign: 'right', render: r => (
      r.costUSD > 0 ? <span style={{color:'var(--c-amber)'}}>{U.money4(r.costUSD)}</span> : <span className="muted">—</span>
    ), width: 100 },
    { field: 'annotationAction', title: '操作', sortable: false, export: false, render: r => (
      <button className={`btn btn-mini ${hasSessionDetails(r) ? 'btn-annotated' : ''}`}
        onClick={(event) => {
          event.stopPropagation();
          openAnnotation(r);
        }}>
        {hasSessionDetails(r) ? '编辑' : '标注'}
      </button>
    ), width: 80 }
  ];

  const attributionColumns = [
    { field: 'project', title: '项目', render: r => <span className="mono">{r.project}</span> },
    { field: 'taskType', title: '任务', render: r => <span className="tag tag-soft">{r.taskType}</span>, width: 120 },
    { field: 'outputStatus', title: '状态', render: r => (
      <span className={`status-badge annotation-status-${statusClass(r.outputStatus)}`}>{r.outputStatus}</span>
    ), width: 110 },
    { field: 'workPurpose', title: '目的', render: r => <span className="tag tag-soft">{r.workPurpose}</span>, width: 110 },
    { field: 'workStage', title: '阶段', render: r => <span className="tag tag-soft">{r.workStage}</span>, width: 90 },
    { field: 'valueLevel', title: '价值', render: r => <span className={`status-badge value-level-${valueClass(r.valueLevel)}`}>{r.valueLevel}</span>, width: 90 },
    { field: 'sessionCount', title: '会话', hozAlign: 'right', render: r => r.sessionCount, width: 80 },
    { field: 'sourceCount', title: '来源', hozAlign: 'right', render: r => r.sourceCount, width: 80 },
    { field: 'deviceCount', title: '设备', hozAlign: 'right', render: r => r.deviceCount, width: 80 },
    { field: 'inputTokens', title: 'Input', hozAlign: 'right', render: r => U.compact(r.inputTokens), width: 90 },
    { field: 'outputTokens', title: 'Output', hozAlign: 'right', render: r => U.compact(r.outputTokens), width: 90 },
    { field: 'totalTokens', title: 'Total', hozAlign: 'right', render: r => (
      <span className="num-strong">{U.fmt.format(r.totalTokens)}</span>
    ), width: 130 },
    { field: 'share', title: '占比', value: r => r.totalTokens / (attributionTotalTokens || 1), render: r => {
      const p = (r.totalTokens / (attributionTotalTokens || 1)) * 100;
      return <span className="share-pct">{p.toFixed(1)}%</span>;
    }, width: 80 },
    { field: 'costUSD', title: '官方价', hozAlign: 'right', render: r => (
      r.costUSD > 0 ? <span style={{color:'var(--c-amber)'}}>{U.money4(r.costUSD)}</span> : <span className="muted">—</span>
    ), width: 100 }
  ];

  const aliasRuleColumns = [
    { field: 'pattern', title: '路径规则', render: r => (
      <span className="session-project">
        <span className="mono">{r.pattern}</span>
        <span className="session-project-raw">{humanMatchType(r.matchType)}</span>
      </span>
    )},
    { field: 'projectAlias', title: '项目别名', render: r => <span className="tag tag-soft">{r.projectAlias}</span>, width: 180 },
    { field: 'enabled', title: '状态', render: r => (
      <span className={`status-badge ${r.enabled ? 'status-ok' : 'status-empty'}`}>{r.enabled ? '启用' : '停用'}</span>
    ), width: 100 },
    { field: 'updatedAt', title: '更新时间', render: r => (
      <span className="muted" style={{fontSize:11.5}}>{U.formatTs(r.updatedAt)}</span>
    ), width: 150 },
    { field: 'ruleAction', title: '操作', sortable: false, export: false, render: r => (
      <button className="btn btn-mini" onClick={(event) => {
        event.stopPropagation();
        setPanelMessage(null);
        setEditingRule(r);
      }}>编辑</button>
    ), width: 80 }
  ];

  const runColumns = [
    { field: 'collectedAt', title: '时间', render: r => (
      <span className="mono" style={{fontSize: 11.5, color: 'var(--text-2)', whiteSpace: 'nowrap'}}>{formatRunTime(r)}</span>
    ), value: formatRunTime, width: 160 },
    { field: 'source', title: '来源', render: r => (
      <span className="tag"><span className="tag-dot" style={{background: U.getSourceColor(r.source)}}/>{r.source}</span>
    ), width: 140 },
    { field: 'device', title: '设备', render: r => <span className="muted">{r.device}</span>, width: 200 },
    { field: 'status', title: '状态', render: r => (
      <span className={`status-badge status-${r.status}`}>{r.status}</span>
    ), width: 90 },
    { field: 'message', title: '说明', render: r => (
      <span title={r.message} style={{
        color: 'var(--text-2)', fontSize: 12,
        display: 'block', overflow: 'hidden',
        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        maxWidth: 380
      }}>{r.message}</span>
    )}
  ];

  let columns, rows, initialSort, emptyText;
  if (tab === 'sources')  { columns = sourceColumns;  rows = bySource;  initialSort = { field: 'totalTokens', dir: 'desc' }; emptyText = '当前筛选下无来源'; }
  if (tab === 'models')   { columns = modelColumns;   rows = byModel;   initialSort = { field: 'totalTokens', dir: 'desc' }; emptyText = '当前筛选下无模型'; }
  if (tab === 'sessions') { columns = [selectionColumn, ...sessionColumns]; rows = sessions;  initialSort = { field: 'totalTokens', dir: 'desc' }; emptyText = '暂无会话数据'; }
  if (tab === 'unattributed') { columns = [selectionColumn, ...sessionColumns]; rows = queueRows; initialSort = { field: 'totalTokens', dir: 'desc' }; emptyText = '暂无待确认会话'; }
  if (tab === 'attribution') { columns = attributionColumns; rows = attributionRows; initialSort = { field: 'totalTokens', dir: 'desc' }; emptyText = '暂无可归因的会话'; }
  if (tab === 'aliasRules') { columns = aliasRuleColumns; rows = projectAliasRules; initialSort = { field: 'updatedAt', dir: 'desc' }; emptyText = '暂无项目别名规则'; }
  if (tab === 'runs')     { columns = runColumns;     rows = runs;      initialSort = { field: 'collectedAt', dir: 'desc' }; emptyText = '暂无采集记录'; }

  const exportCSV = () => {
    U.downloadCSV(`tokens-${tab}-${U.daysAgo(0)}.csv`, rows, columns.filter(c => c.export !== false));
  };

  const openBatch = () => {
    setBatchError(null);
    setBatchOpen(true);
  };
  const rememberPresets = (values) => {
    const next = rememberAnnotationPreset(annotationPresets, values);
    setAnnotationPresets(next);
    writeAnnotationPresets(next);
  };

  const saveBatch = async (values) => {
    setBatchBusy(true);
    setBatchError(null);
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
        sessions: selectedSessionRows.map(sessionIdentity),
        values: payloadValues
      });
      rememberPresets(payloadValues);
      setSelectedSessions(new Set());
      setBatchOpen(false);
      setPanelMessage({ type: 'ok', text: `已批量标注 ${selectedSessionRows.length} 个会话` });
    } catch (error) {
      setBatchError(error.message || '批量标注失败');
    } finally {
      setBatchBusy(false);
    }
  };

  const saveRule = async (values) => {
    setRuleBusy(true);
    setRuleError(null);
    try {
      await onSaveProjectAliasRule(values);
      setEditingRule(null);
      setPanelMessage({ type: 'ok', text: '项目别名规则已保存' });
    } catch (error) {
      setRuleError(error.message || '保存规则失败');
    } finally {
      setRuleBusy(false);
    }
  };

  const deleteRule = async (rule) => {
    setRuleBusy(true);
    setRuleError(null);
    try {
      await onDeleteProjectAliasRule({ id: rule.id });
      setEditingRule(null);
      setPanelMessage({ type: 'ok', text: '项目别名规则已删除' });
    } catch (error) {
      setRuleError(error.message || '删除规则失败');
    } finally {
      setRuleBusy(false);
    }
  };

  const createBackup = async () => {
    try {
      const backup = await onCreateBackup();
      setPanelMessage({ type: 'ok', text: `已创建备份：${backup.fileName}` });
    } catch (error) {
      setPanelMessage({ type: 'error', text: error.message || '创建备份失败' });
    }
  };

  const exportAnnotations = async () => {
    try {
      await onExportAnnotations();
      setPanelMessage({ type: 'ok', text: '标注 JSON 已导出' });
    } catch (error) {
      setPanelMessage({ type: 'error', text: error.message || '导出失败' });
    }
  };

  const importAnnotations = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const result = await onImportAnnotations(file);
      const backupName = result.backup?.fileName || result.backup?.path?.split(/[\\/]/).pop();
      setPanelMessage({
        type: 'ok',
        text: `已导入：标注 ${result.sessionAnnotations || 0}，产出 ${result.sessionOutputs || 0}，规则 ${result.projectAliasRules || 0}${backupName ? `；备份 ${backupName}` : ''}`
      });
    } catch (error) {
      setPanelMessage({ type: 'error', text: error.message || '导入失败' });
    }
  };

  const saveAnnotation = async (values, options: { continueNext?: boolean } = {}) => {
    setAnnotationBusy(true);
    setAnnotationError(null);
    try {
      await onSaveAnnotation({
        device: editingSession.device,
        source: editingSession.source,
        sessionId: editingSession.sessionId,
        projectAlias: values.projectAlias,
        taskType: values.taskType,
        outputStatus: values.outputStatus,
        workPurpose: values.workPurpose,
        workStage: values.workStage,
        valueLevel: values.valueLevel,
        note: values.note
      });
      if (values.outputUrl) {
        await onSaveOutput({
          device: editingSession.device,
          source: editingSession.source,
          sessionId: editingSession.sessionId,
          outputUrl: values.outputUrl,
          outputLabel: values.outputLabel,
          outputType: values.outputType
        });
      } else if (editingSession.outputUrl) {
        await onDeleteOutput({
          device: editingSession.device,
          source: editingSession.source,
          sessionId: editingSession.sessionId
        });
      }
      rememberPresets(values);
      if (options.continueNext) {
        const next = nextReviewSession(editingSession);
        if (next) {
          setEditingSession(next);
          setPanelMessage({ type: 'ok', text: '已保存，已打开下一条需要补齐的会话' });
        } else {
          setEditingSession(null);
          setPanelMessage({ type: 'ok', text: '已保存，当前筛选没有下一条需要补齐的会话' });
        }
      } else {
        setEditingSession(null);
      }
    } catch (error) {
      setAnnotationError(error.message || '保存失败');
    } finally {
      setAnnotationBusy(false);
    }
  };

  const clearAnnotation = async () => {
    setAnnotationBusy(true);
    setAnnotationError(null);
    try {
      await onDeleteAnnotation({
        device: editingSession.device,
        source: editingSession.source,
        sessionId: editingSession.sessionId
      });
      setEditingSession(null);
    } catch (error) {
      setAnnotationError(error.message || '清除失败');
    } finally {
      setAnnotationBusy(false);
    }
  };

  return (
    <div className="panel">
      <div className="panel-header" style={{marginBottom: 14}}>
        <div className="panel-tabs">
          {TABS.map(t => (
            <button key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => { setTab(t.id); setSearch(''); }}>
              {t.label} <span style={{opacity:0.55, marginLeft:4}}>{t.count}</span>
            </button>
          ))}
        </div>
        <div className="panel-actions">
          <input ref={importRef} type="file" accept="application/json" style={{ display: 'none' }} onChange={importAnnotations}/>
          <button className="btn" onClick={createBackup}>备份</button>
          <button className="btn" onClick={exportAnnotations}>导出 JSON</button>
          <button className="btn" onClick={() => importRef.current?.click()}>导入</button>
          {tab === 'aliasRules' && (
            <button className="btn btn-primary" onClick={() => {
              setRuleError(null);
              setEditingRule({ matchType: 'prefix', enabled: true });
            }}>新增规则</button>
          )}
          <input className="search-input" placeholder="搜索..." value={search} onChange={e => setSearch(e.target.value)}/>
          <button className="btn" onClick={exportCSV}>
            <svg className="icon" viewBox="0 0 16 16" fill="none">
              <path d="M8 2v8M5 7l3 3 3-3M3 13h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            CSV
          </button>
        </div>
      </div>
      {panelMessage && (
        <div className={`panel-message panel-message-${panelMessage.type}`}>
          {panelMessage.text}
        </div>
      )}
      {isSessionTab && (
        <ReviewAttributionProgress
          progress={reviewProgress}
          nextSession={reviewQueueRows[0]}
          onOpenNext={openTopReviewGap}
          onCopyChecklist={copyReviewChecklist} />
      )}
      {isSessionTab && (
        <div className="batch-bar">
          <div>
            <strong>{selectedSessionRows.length}</strong>
            <span> 个会话已选</span>
            {selectedSessionRows.length > 0 && <span className="muted"> · 当前筛选可批量设置任务类型、产出状态和备注</span>}
          </div>
          <div className="batch-actions">
            <button className="btn" onClick={() => setVisibleSelection(true)} disabled={visibleSessionRows.length === 0}>选择当前列表</button>
            <button className="btn" onClick={() => setSelectedSessions(new Set())} disabled={selectedSessions.size === 0}>清空</button>
            <button className="btn btn-primary" onClick={openBatch} disabled={selectedSessionRows.length === 0}>批量标注</button>
          </div>
        </div>
      )}
      <DataTable
        key={tab}
        rows={rows}
        columns={columns}
        initialSort={initialSort}
        search={search}
        height={420}
        emptyText={emptyText}
        getKey={(r, i) => tableRowKey(r, i, tab)}
        onRowClick={tab === 'attribution' || tab === 'aliasRules' ? undefined : r => onDrill?.({ kind: tab === 'unattributed' ? 'session' : tab.slice(0,-1), row: r })}
      />
      {batchOpen && (
        <BatchAnnotationModal
          count={selectedSessionRows.length}
          taskTypes={taskTypes}
          outputStatuses={outputStatuses}
          workPurposes={workPurposes}
          workStages={workStages}
          valueLevels={valueLevels}
          annotationPresets={annotationPresets}
          busy={batchBusy}
          error={batchError}
          onSave={saveBatch}
          onClose={() => {
            if (!batchBusy) {
              setBatchOpen(false);
              setBatchError(null);
            }
          }} />
      )}
      {editingRule && (
        <AliasRuleModal
          rule={editingRule}
          matchTypes={projectAliasMatchTypes}
          busy={ruleBusy}
          error={ruleError}
          onSave={saveRule}
          onDelete={editingRule.id ? () => deleteRule(editingRule) : null}
          onClose={() => {
            if (!ruleBusy) {
              setEditingRule(null);
              setRuleError(null);
            }
          }} />
      )}
      {editingSession && (
        <AnnotationModal
          session={editingSession}
          taskTypes={taskTypes}
          outputStatuses={outputStatuses}
          workPurposes={workPurposes}
          workStages={workStages}
          valueLevels={valueLevels}
          outputTypes={outputTypes}
          annotationPresets={annotationPresets}
          busy={annotationBusy}
          error={annotationError}
          onSave={saveAnnotation}
          onSaveAndNext={(form) => saveAnnotation(form, { continueNext: true })}
          onDelete={clearAnnotation}
          hasNext={Boolean(nextReviewSession(editingSession))}
          onClose={() => {
            if (!annotationBusy) {
              setEditingSession(null);
              setAnnotationError(null);
            }
          }}
        />
      )}
    </div>
  );
}

function ReviewAttributionProgress({ progress, nextSession, onOpenNext, onCopyChecklist }) {
  const sessionPct = (progress.completionShare * 100).toFixed(0);
  const tokenPct = (progress.tokenCompletionShare * 100).toFixed(0);
  return (
    <div className="review-progress">
      <div className="review-progress-main">
        <div>
          <strong>复盘归因进度 {sessionPct}%</strong>
          <span>{progress.attributedSessionCount} / {progress.sessionCount} 个 session 已补齐任务、状态、目的、阶段和价值</span>
        </div>
        <div className="review-progress-meter" aria-label="复盘归因进度">
          <span style={{width: `${Math.max(0, Math.min(100, progress.completionShare * 100))}%`}}/>
        </div>
      </div>
      <div className="review-progress-side">
        <span>已归因 token {tokenPct}%</span>
        <span>{U.compact(progress.unattributedTokens)} tokens 待补齐</span>
        <button className="btn btn-mini" onClick={onOpenNext} disabled={!nextSession}>
          打开最高成本待确认
        </button>
        <button className="btn btn-mini" onClick={onCopyChecklist} disabled={!nextSession}>
          复制归因清单
        </button>
      </div>
    </div>
  );
}

function AttributionSourceBadge({ session }) {
  const source = session.annotationSource || '';
  const quality = session.attributionQuality || 'missing';
  const confidence = Number(session.annotationConfidence || 0);
  if (quality === 'missing') {
    return session.autoSuggestion
      ? <span className="attribution-source-badge auto-low">建议 {session.autoSuggestion.annotationConfidence}%</span>
      : <span className="attribution-source-badge missing">待确认</span>;
  }
  if (source === 'auto') {
    return <span className={`attribution-source-badge ${confidence >= 80 ? 'auto-high' : 'auto-low'}`}>自动 {confidence}%</span>;
  }
  if (source === 'imported') return <span className="attribution-source-badge imported">导入确认</span>;
  return <span className="attribution-source-badge manual">人工确认</span>;
}

function AutoSuggestionBox({ suggestion, annotationSource, confidence, reason, onApply }) {
  const existingAuto = annotationSource === 'auto';
  if (!suggestion && !existingAuto) return null;
  const rows = suggestion ? [
    ['项目别名', suggestion.values.projectAlias],
    ['任务类型', suggestion.values.taskType],
    ['产出状态', suggestion.values.outputStatus],
    ['主要目的', suggestion.values.workPurpose],
    ['工作阶段', suggestion.values.workStage],
    ['产出价值', suggestion.values.valueLevel]
  ].filter(([, value]) => value) : [];

  return (
    <div className="auto-suggestion-box">
      <div className="auto-suggestion-head">
        <div>
          <strong>{suggestion ? `自动建议 ${suggestion.annotationConfidence}%` : `自动归因 ${confidence || 0}%`}</strong>
          <span>{suggestion ? suggestion.annotationReason : reason}</span>
        </div>
        {suggestion && (
          <button className="btn btn-mini" type="button" onClick={() => onApply(suggestion.values)}>
            套用建议
          </button>
        )}
      </div>
      {rows.length > 0 && (
        <div className="auto-suggestion-grid">
          {rows.map(([label, value]) => (
            <div key={label}>
              <span>{label}</span>
              <b>{value}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AnnotationModal({ session, taskTypes, outputStatuses, workPurposes, workStages, valueLevels, outputTypes, annotationPresets, busy, error, onSave, onSaveAndNext, onDelete, hasNext, onClose }) {
  const [form, setForm] = useState(() => annotationFormFromSession(session));

  useEffect(() => {
    setForm(annotationFormFromSession(session));
  }, [session]);

  const update = (key, value) => setForm(prev => ({ ...prev, [key]: value }));
  const applyLastTemplate = () => setForm(prev => applyAnnotationTemplate(prev, annotationPresets.lastTemplate));
  const applyQuickTemplate = (template) => setForm(prev => applyAnnotationTemplate(prev, template.values, { includeProjectAlias: false }));
  const title = sessionProjectLabel(session);
  const projectListId = `recent-projects-${sessionKey(session).replace(/[^\w-]+/g, '-')}`;

  return (
    <>
      <div className="modal-backdrop open" onClick={onClose}/>
      <div className="annotation-modal" role="dialog" aria-modal="true" aria-label="标注项目会话">
        <div className="annotation-modal-header">
          <div>
            <div className="eyebrow">项目会话标注</div>
            <h3>{title}</h3>
          </div>
          <button className="drawer-close" onClick={onClose} disabled={busy}>
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path d="M3 3l7 7M10 3l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        <div className="annotation-modal-body">
          <label className="form-field">
            <span>项目别名</span>
            <input value={form.projectAlias} maxLength={120} list={projectListId}
              placeholder="例如 AI 选题雷达、简历优化页"
              onChange={e => update('projectAlias', e.target.value)} />
            <datalist id={projectListId}>
              {annotationPresets.recentProjects.map(project => <option key={project} value={project}/>)}
            </datalist>
          </label>
          <div className="preset-row">
            <button className="btn btn-mini" onClick={applyLastTemplate} disabled={!annotationPresets.lastTemplate || busy}>
              套用上次标注
            </button>
            <span>只套用项目、任务、状态、目的、阶段和价值；不套用备注或产出链接。</span>
          </div>
          <QuickTemplatePicker
            templates={QUICK_ANNOTATION_TEMPLATES}
            disabled={busy}
            onApply={applyQuickTemplate}
          />
          <AutoSuggestionBox
            suggestion={session.autoSuggestion}
            annotationSource={session.annotationSource}
            confidence={session.annotationConfidence}
            reason={session.annotationReason}
            onApply={(values) => setForm(prev => ({ ...prev, ...values }))}
          />
          <div className="form-grid">
            <label className="form-field">
              <span>任务类型</span>
              <select value={form.taskType} onChange={e => update('taskType', e.target.value)}>
                {taskTypes.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label className="form-field">
              <span>产出状态</span>
              <select value={form.outputStatus} onChange={e => update('outputStatus', e.target.value)}>
                {outputStatuses.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
          </div>
          <div className="form-grid form-grid-3">
            <label className="form-field">
              <span>本次主要目的</span>
              <select value={form.workPurpose} onChange={e => update('workPurpose', e.target.value)}>
                {workPurposes.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <label className="form-field">
              <span>工作阶段</span>
              <select value={form.workStage} onChange={e => update('workStage', e.target.value)}>
                {workStages.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="form-field">
              <span>产出价值</span>
              <select value={form.valueLevel} onChange={e => update('valueLevel', e.target.value)}>
                {valueLevels.map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
          </div>
          <label className="form-field">
            <span>备注</span>
            <textarea value={form.note} maxLength={500}
              placeholder="只写复盘摘要，不放对话正文或敏感信息"
              onChange={e => update('note', e.target.value)} />
          </label>
          <div className="form-grid">
            <label className="form-field">
              <span>产出链接</span>
              <input value={form.outputUrl} maxLength={500}
                placeholder="PR / commit / 文章 / 部署地址"
                onChange={e => update('outputUrl', e.target.value)} />
            </label>
            <label className="form-field">
              <span>链接标签</span>
              <input value={form.outputLabel} maxLength={120}
                placeholder="例如 PR #42、发布页、复盘文章"
                onChange={e => update('outputLabel', e.target.value)} />
            </label>
          </div>
          <label className="form-field">
            <span>产出类型</span>
            <select value={form.outputType} onChange={e => update('outputType', e.target.value)}>
              {outputTypes.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <div className="annotation-meta">
            <span>{session.source}</span>
            <span>{U.compact(session.totalTokens)} tokens</span>
            <span>{session.lastActivity || '无活动日期'}</span>
            <span>{attributionLabel(session)}</span>
            {session.ruleProjectAlias && !session.manualProjectAlias && <span>规则建议：{session.ruleProjectAlias}</span>}
          </div>
          {error && <div className="form-error">{error}</div>}
        </div>

        <div className="annotation-modal-actions">
          <button className="btn" onClick={onDelete} disabled={busy || !hasAnnotation(session)}>清除标注</button>
          <span className="form-spacer"/>
          <button className="btn" onClick={onClose} disabled={busy}>取消</button>
          <button className="btn" onClick={() => onSaveAndNext?.(form)} disabled={busy || !hasNext}>
            {busy ? '保存中' : '保存并下一条'}
          </button>
          <button className="btn btn-primary" onClick={() => onSave(form)} disabled={busy}>
            {busy ? '保存中' : '保存'}
          </button>
        </div>
      </div>
    </>
  );
}

export function BatchAnnotationModal({ count, taskTypes, outputStatuses, workPurposes, workStages, valueLevels, annotationPresets, busy, error, onSave, onClose }) {
  const [form, setForm] = useState({
    projectAlias: '',
    taskType: '',
    outputStatus: '',
    workPurpose: '',
    workStage: '',
    valueLevel: '',
    note: ''
  });
  const update = (key, value) => setForm(prev => ({ ...prev, [key]: value }));
  const applyLastTemplate = () => setForm(prev => applyAnnotationTemplate(prev, annotationPresets.lastTemplate));
  const applyQuickTemplate = (template) => setForm(prev => applyAnnotationTemplate(prev, template.values, { includeProjectAlias: false }));

  return (
    <>
      <div className="modal-backdrop open" onClick={onClose}/>
      <div className="annotation-modal" role="dialog" aria-modal="true" aria-label="批量标注会话">
        <div className="annotation-modal-header">
          <div>
            <div className="eyebrow">批量标注</div>
            <h3>{count} 个会话</h3>
          </div>
          <button className="drawer-close" onClick={onClose} disabled={busy}>
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path d="M3 3l7 7M10 3l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
        <div className="annotation-modal-body">
          <label className="form-field">
            <span>项目别名</span>
            <input value={form.projectAlias} maxLength={120} list="batch-recent-projects"
              placeholder="留空则不修改项目别名"
              onChange={e => update('projectAlias', e.target.value)} />
            <datalist id="batch-recent-projects">
              {annotationPresets.recentProjects.map(project => <option key={project} value={project}/>)}
            </datalist>
          </label>
          <div className="preset-row">
            <button className="btn btn-mini" onClick={applyLastTemplate} disabled={!annotationPresets.lastTemplate || busy}>
              套用上次标注
            </button>
            <span>批量套用前请先确认当前选中的 session 真实属于同一类工作。</span>
          </div>
          <QuickTemplatePicker
            templates={QUICK_ANNOTATION_TEMPLATES}
            disabled={busy}
            onApply={applyQuickTemplate}
          />
          <div className="form-grid">
            <label className="form-field">
              <span>任务类型</span>
              <select value={form.taskType} onChange={e => update('taskType', e.target.value)}>
                <option value="">不修改</option>
                {taskTypes.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label className="form-field">
              <span>产出状态</span>
              <select value={form.outputStatus} onChange={e => update('outputStatus', e.target.value)}>
                <option value="">不修改</option>
                {outputStatuses.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
          </div>
          <div className="form-grid form-grid-3">
            <label className="form-field">
              <span>主要目的</span>
              <select value={form.workPurpose} onChange={e => update('workPurpose', e.target.value)}>
                <option value="">不修改</option>
                {workPurposes.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <label className="form-field">
              <span>工作阶段</span>
              <select value={form.workStage} onChange={e => update('workStage', e.target.value)}>
                <option value="">不修改</option>
                {workStages.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="form-field">
              <span>产出价值</span>
              <select value={form.valueLevel} onChange={e => update('valueLevel', e.target.value)}>
                <option value="">不修改</option>
                {valueLevels.map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
          </div>
          <label className="form-field">
            <span>备注</span>
            <textarea value={form.note} maxLength={500}
              placeholder="留空则不修改备注"
              onChange={e => update('note', e.target.value)} />
          </label>
          {error && <div className="form-error">{error}</div>}
        </div>
        <div className="annotation-modal-actions">
          <button className="btn" onClick={onClose} disabled={busy}>取消</button>
          <span className="form-spacer"/>
          <button className="btn btn-primary" onClick={() => onSave(form)} disabled={busy}>
            {busy ? '保存中' : '保存'}
          </button>
        </div>
      </div>
    </>
  );
}

function QuickTemplatePicker({ templates, disabled, onApply }) {
  return (
    <div className="quick-template-picker" aria-label="快捷标注模板">
      <div className="quick-template-head">
        <span>快捷模板</span>
        <p>只填结构化归因字段；保存前请按真实工作内容核对。</p>
      </div>
      <div className="quick-template-grid">
        {templates.map(template => (
          <button
            key={template.id}
            type="button"
            className="quick-template-button"
            disabled={disabled}
            onClick={() => onApply(template)}>
            <strong>{template.label}</strong>
            <span>{template.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function AliasRuleModal({ rule, matchTypes, busy, error, onSave, onDelete, onClose }) {
  const [form, setForm] = useState(() => ({
    id: rule.id,
    pattern: rule.pattern || '',
    matchType: rule.matchType || 'prefix',
    projectAlias: rule.projectAlias || '',
    enabled: rule.enabled !== false
  }));
  const update = (key, value) => setForm(prev => ({ ...prev, [key]: value }));

  useEffect(() => {
    setForm({
      id: rule.id,
      pattern: rule.pattern || '',
      matchType: rule.matchType || 'prefix',
      projectAlias: rule.projectAlias || '',
      enabled: rule.enabled !== false
    });
  }, [rule]);

  return (
    <>
      <div className="modal-backdrop open" onClick={onClose}/>
      <div className="annotation-modal" role="dialog" aria-modal="true" aria-label="项目别名规则">
        <div className="annotation-modal-header">
          <div>
            <div className="eyebrow">项目别名规则</div>
            <h3>{rule.id ? '编辑规则' : '新增规则'}</h3>
          </div>
          <button className="drawer-close" onClick={onClose} disabled={busy}>
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path d="M3 3l7 7M10 3l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
        <div className="annotation-modal-body">
          <label className="form-field">
            <span>路径规则</span>
            <input value={form.pattern} maxLength={300}
                placeholder="例如 D:/Projects/token-work-roi"
              onChange={e => update('pattern', e.target.value)} />
          </label>
          <div className="form-grid">
            <label className="form-field">
              <span>匹配方式</span>
              <select value={form.matchType} onChange={e => update('matchType', e.target.value)}>
                {matchTypes.map(type => <option key={type} value={type}>{humanMatchType(type)}</option>)}
              </select>
            </label>
            <label className="form-field">
              <span>项目别名</span>
              <input value={form.projectAlias} maxLength={120}
                placeholder="例如 Token Work"
                onChange={e => update('projectAlias', e.target.value)} />
            </label>
          </div>
          <label className={`toggle ${form.enabled ? 'on' : ''}`} style={{width: 'fit-content'}}>
            <span className="toggle-slot"/>
            <input type="checkbox" checked={form.enabled}
              onChange={e => update('enabled', e.target.checked)}
              style={{display:'none'}} />
            启用规则
          </label>
          <div className="annotation-meta">
            <span>人工项目别名优先于规则建议</span>
            <span>规则只根据项目路径匹配，不读取对话正文</span>
          </div>
          {error && <div className="form-error">{error}</div>}
        </div>
        <div className="annotation-modal-actions">
          {onDelete && <button className="btn" onClick={onDelete} disabled={busy}>删除规则</button>}
          <span className="form-spacer"/>
          <button className="btn" onClick={onClose} disabled={busy}>取消</button>
          <button className="btn btn-primary" onClick={() => onSave(form)} disabled={busy}>
            {busy ? '保存中' : '保存'}
          </button>
        </div>
      </div>
    </>
  );
}

function annotationFormFromSession(session) {
  return {
    projectAlias: session.manualProjectAlias || '',
    taskType: session.taskType || '未分类',
    outputStatus: session.outputStatus || '未标注',
    workPurpose: session.workPurpose || '未说明',
    workStage: session.workStage || '未说明',
    valueLevel: session.valueLevel || '未评估',
    note: session.note || '',
    outputUrl: session.outputUrl || '',
    outputLabel: session.outputLabel || '',
    outputType: session.outputType || '未分类'
  };
}

function hasAnnotation(session) {
  return Boolean(
    session.manualProjectAlias ||
    session.note ||
    (session.taskType && session.taskType !== '未分类') ||
    (session.outputStatus && session.outputStatus !== '未标注') ||
    (session.workPurpose && session.workPurpose !== '未说明') ||
    (session.workStage && session.workStage !== '未说明') ||
    (session.valueLevel && session.valueLevel !== '未评估')
  );
}

function hasSessionDetails(session) {
  return hasAnnotation(session) || Boolean(session.outputUrl);
}

function attributionSourceText(session) {
  if (session.annotationSource === 'auto') {
    return Number(session.annotationConfidence || 0) >= 80 ? '自动高置信' : '自动待确认';
  }
  if (session.annotationSource === 'manual') return '人工确认';
  if (session.annotationSource === 'imported') return '导入确认';
  if (session.autoSuggestion) return '自动待确认';
  return '';
}

function attributionLabel(session) {
  if (session.annotationSource === 'auto') return `自动 ${Number(session.annotationConfidence || 0)}%`;
  if (session.annotationSource === 'manual') return '人工确认';
  if (session.annotationSource === 'imported') return '导入确认';
  if (session.autoSuggestion) return `建议 ${session.autoSuggestion.annotationConfidence}%`;
  return '待确认';
}

function sessionProjectLabel(session) {
  if (session.projectAlias) return session.projectAlias;
  const projectPath = safeProjectPathLabel(session.projectPath);
  if (projectPath) return projectPath;
  const sessionPath = safeProjectPathLabel(session.sessionId);
  if (sessionPath) return sessionPath;
  return '未归档项目';
}

function safeProjectPathLabel(value) {
  const text = String(value || '').trim();
  if (!text || text === 'Unknown Project') return '';
  const localPath = text.startsWith('local:')
    ? text.slice(0, text.lastIndexOf(':')).replace(/^local:[^:]+:/, '')
    : text;
  const cleaned = localPath.replace(/[\\/]+$/, '');
  return cleaned.split(/[\\/]/).filter(Boolean).at(-1) || '';
}

function tableRowKey(row, index, tab) {
  return buildTableRowKey(row, index, tab);
}

function sessionKey(session = {}) {
  return buildSessionKey(session);
}

function sessionIdentity(session) {
  return {
    device: session.device,
    source: session.source,
    sessionId: session.sessionId
  };
}

function humanMatchType(type) {
  if (type === 'prefix') return '路径前缀';
  if (type === 'contains') return '包含文本';
  if (type === 'regex') return '正则';
  return type || '路径前缀';
}

function statusClass(value) {
  return String(value || '未标注').replace(/[^\u4e00-\u9fa5\w-]+/g, '-');
}

function valueClass(value) {
  return String(value || '未评估').replace(/[^\u4e00-\u9fa5\w-]+/g, '-');
}

// ───────────────────────────────────────────────────────────────
// Drawer — drill-down panel
// ───────────────────────────────────────────────────────────────
function DrillDrawer({ drill, daily, onClose }) {
  const open = !!drill;

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const detail = useMemo(() => {
    if (!drill) return null;
    const { kind, row } = drill;
    let title = '', sub = '', filterFn = (_row: UsageRow) => true;
    if (kind === 'source') { title = row.source; sub = row.device; filterFn = r => r.source === row.source && r.device === row.device; }
    if (kind === 'model')  {
      title = row.model;
      // 模型已跨来源归并,sub 展示全部来源,下钻按统一名匹配所有来源,与条行口径一致
      sub = (row.sourceList || []).map(([s]) => s).join('、') || row.source || '';
      filterFn = r => (r.modelLabel || r.model) === row.model;
    }
    if (kind === 'session'){ title = row.projectPath || row.sessionId; sub = `${row.source} · ${row.device}`;
      filterFn = r => r.source === row.source; /* session doesn't tie to daily directly — show source's daily */ }
    if (kind === 'run')    { title = `采集: ${row.source}`; sub = U.formatTs(row.collectedAt); filterFn = () => false; }

    const matching = daily.filter(filterFn);
    const totals = U.aggregateTotals(matching);
    const byDate = U.groupByDate(matching);
    const dates = Array.from(byDate.keys()).sort();
    const values = dates.map(d => {
      let sum = 0;
      const sources = byDate.get(d);
      for (const k of Object.keys(sources)) sum += sources[k];
      return sum;
    });

    return { kind, row, title, sub, totals, dates, values, count: matching.length };
  }, [drill, daily]);

  return (
    <>
      <div className={`drawer-backdrop ${open ? 'open' : ''}`} onClick={onClose}/>
      <div className={`drawer ${open ? 'open' : ''}`} role="dialog">
        {detail && (
          <>
            <div className="drawer-header" style={{position: 'relative'}}>
              <button className="drawer-close" onClick={onClose}>
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                  <path d="M3 3l7 7M10 3l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              </button>
              <div style={{fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4}}>
                {detail.kind === 'source' && '来源详情'}
                {detail.kind === 'model' && '模型详情'}
                {detail.kind === 'session' && '项目详情'}
                {detail.kind === 'run' && '采集详情'}
              </div>
              <h3>{detail.title}</h3>
              <div className="sub">{detail.sub}</div>
            </div>
            <div className="drawer-body">
              {detail.kind !== 'run' ? (
                <>
                  <div className="drawer-kpi-row">
                    <div className="drawer-kpi">
                      <div className="l">Total</div>
                      <div className="v">{U.compactCN(detail.totals.totalTokens)}</div>
                    </div>
                    <div className="drawer-kpi">
                      <div className="l">官方价</div>
                      <div className="v" style={{color: detail.totals.costUSD > 0 ? 'var(--c-amber)' : 'var(--muted)'}}>
                        {detail.totals.costUSD > 0 ? U.money(detail.totals.costUSD) : '—'}
                      </div>
                    </div>
                    <div className="drawer-kpi">
                      <div className="l">活跃天数</div>
                      <div className="v">{detail.dates.length}</div>
                    </div>
                  </div>

                  <div className="detail-section">
                    <h4>趋势</h4>
                    <DrillSpark dates={detail.dates} values={detail.values}/>
                  </div>

                  <div className="detail-section">
                    <h4>分布</h4>
                    <div className="detail-row"><span className="k">Input</span><span className="v">{U.fmt.format(detail.totals.inputTokens)}</span></div>
                    <div className="detail-row"><span className="k">Output</span><span className="v">{U.fmt.format(detail.totals.outputTokens)}</span></div>
                    <div className="detail-row"><span className="k">Cache Read</span><span className="v">{U.fmt.format(detail.totals.cacheReadTokens)}</span></div>
                    <div className="detail-row"><span className="k">Cache Creation</span><span className="v">{U.fmt.format(detail.totals.cacheCreationTokens)}</span></div>
                    <div className="detail-row"><span className="k">Reasoning</span><span className="v">{U.fmt.format(detail.totals.reasoningTokens)}</span></div>
                    <div className="detail-row"><span className="k">缓存命中率</span><span className="v" style={{color:'var(--c-indigo)', fontWeight: 600}}>{detail.totals.cacheHitRate.toFixed(1)}%</span></div>
                  </div>

                  {detail.kind === 'session' && (
                    <div className="detail-section">
                      <h4>元数据</h4>
                      <div className="detail-row"><span className="k">项目别名</span><span className="v">{detail.row.projectAlias || '—'}</span></div>
                      <div className="detail-row"><span className="k">模型</span><span className="v mono">{detail.row.model || '—'}</span></div>
                      <div className="detail-row"><span className="k">任务类型</span><span className="v">{detail.row.taskType || '未分类'}</span></div>
                      <div className="detail-row"><span className="k">产出状态</span><span className="v">{detail.row.outputStatus || '未标注'}</span></div>
                      <div className="detail-row"><span className="k">主要目的</span><span className="v">{detail.row.workPurpose || '未说明'}</span></div>
                      <div className="detail-row"><span className="k">工作阶段</span><span className="v">{detail.row.workStage || '未说明'}</span></div>
                      <div className="detail-row"><span className="k">产出价值</span><span className="v">{detail.row.valueLevel || '未评估'}</span></div>
                      <div className="detail-row"><span className="k">产出类型</span><span className="v">{detail.row.outputUrl ? (detail.row.outputType || '未分类') : '—'}</span></div>
                      <div className="detail-row"><span className="k">备注</span><span className="v" style={{maxWidth: '60%', textAlign: 'right'}}>{detail.row.note || '—'}</span></div>
                      <div className="detail-row"><span className="k">Session ID</span><span className="v mono" style={{fontSize: 11, maxWidth: '60%', textAlign: 'right'}}>{detail.row.sessionId}</span></div>
                      <div className="detail-row"><span className="k">最后活动</span><span className="v">{detail.row.lastActivity}</span></div>
                    </div>
                  )}

                  {detail.kind === 'model' && (
                    <div className="detail-section">
                      <h4>记录</h4>
                      <div className="detail-row"><span className="k">活跃天数</span><span className="v">{detail.row.dayCount}</span></div>
                    </div>
                  )}
                </>
              ) : (
                <div className="detail-section">
                  <h4>状态</h4>
                  <div style={{padding: '12px 14px', background: 'var(--surface-2)', borderRadius: 8, fontSize: 12.5}}>
                    <span className={`status-badge status-${detail.row.status}`}>{detail.row.status}</span>
                    <p style={{margin: '10px 0 0', lineHeight: 1.6}}>{detail.row.message}</p>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}

// Small sparkline for drawer
function DrillSpark({ dates, values }) {
  if (!dates.length) return <div className="empty">无数据</div>;
  const w = 480, h = 120;
  const max = Math.max(...values, 1);
  const pad = 16;
  const pts = values.map((v, i) => {
    const x = pad + (i / Math.max(1, values.length - 1)) * (w - pad * 2);
    const y = h - pad - (v / max) * (h - pad * 2);
    return [x, y];
  });
  const d = pts.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(' ');
  const dArea = d + ` L${w-pad},${h-pad} L${pad},${h-pad} Z`;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{width: '100%', height: 120, display: 'block'}}>
      <defs>
        <linearGradient id="drillGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="oklch(0.55 0.16 265)" stopOpacity="0.25"/>
          <stop offset="100%" stopColor="oklch(0.55 0.16 265)" stopOpacity="0"/>
        </linearGradient>
      </defs>
      <path d={dArea} fill="url(#drillGrad)"/>
      <path d={d} fill="none" stroke="oklch(0.55 0.16 265)" strokeWidth="2" strokeLinejoin="round"/>
      {pts.map((p, i) => (
        <circle key={i} cx={p[0]} cy={p[1]} r="2" fill="oklch(0.55 0.16 265)" opacity={i === pts.length - 1 ? 1 : 0}/>
      ))}
      <text x={pad} y={h - 2} fontSize="9" fill="oklch(0.62 0.005 80)" style={{fontFamily: 'var(--font-mono)'}}>{dates[0]}</text>
      <text x={w - pad} y={h - 2} textAnchor="end" fontSize="9" fill="oklch(0.62 0.005 80)" style={{fontFamily: 'var(--font-mono)'}}>{dates[dates.length - 1]}</text>
    </svg>
  );
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to textarea copy for restrictive browser contexts.
    }
  }
  const el = document.createElement('textarea');
  el.value = text;
  el.setAttribute('readonly', '');
  el.style.position = 'fixed';
  el.style.left = '-9999px';
  document.body.appendChild(el);
  el.select();
  document.execCommand('copy');
  document.body.removeChild(el);
}

export { TablePanel, DrillDrawer };
