import {
  buildProjectRoiRows,
  buildReviewUnattributedSessions,
  buildRiskDistribution,
  buildUnattributedSessions,
  sessionProjectLabel
} from '../dashboard/attribution.ts';
import { U } from '../shared/utils.ts';
import type { PeriodRange, UsageRow } from '../shared/types.ts';
import { buildRoiEvidence } from './roi-evidence.ts';

const PRODUCTIVE_STATUSES = new Set(['已完成', '已发布']);
const EMPTY_PERIOD: PeriodRange = {};

export function buildMarkdownReviewReport({
  period = EMPTY_PERIOD,
  daily = [],
  sessions = [],
  workItems = [],
  roiAdvice = [],
  savingsSimulation = null,
  advisorActions = [],
  actionMeasurements = [],
  coverageBridge = null,
  evidenceFlywheel = null,
  localTrust = null,
  generatedAt = new Date()
} = {}) {
  const totals = aggregateDaily(daily);
  const projectRows = buildProjectRoiRows(sessions).slice(0, 8);
  const modelRows = buildModelRows(daily).slice(0, 8);
  const outputRows = buildOutputRows(sessions).slice(0, 12);
  const riskRows = buildRiskDistribution(sessions);
  const attributionGapRows = buildAttributionGapRows(sessions).slice(0, 10);
  const attributionBreakdown = buildAttributionBreakdown(sessions);
  const roiEvidence = buildRoiEvidence({ sessions, workItems });
  const actionItems = buildActionItems({ roiAdvice, sessions, outputRows });
  const actionStatusRows = buildAdvisorActionRows(advisorActions, period);

  return [
    '# Token Work Weekly Review',
    '',
    `- 生成时间：${safeText(formatDateTime(generatedAt))}`,
    `- 复盘周期：${safeText(period?.pretty || `${period?.start || ''} - ${period?.end || ''}` || '当前筛选周期')}`,
    `- 数据口径：本地结构化用量、人工标注、自动归因和产出链接；不包含对话正文。`,
    '',
    '## 1. 本期总览',
    '',
    table(
      ['指标', '数值'],
      [
        ['Session 数', formatInt(sessions.length)],
        ['总 tokens', compactCN(totals.totalTokens)],
        ['输入 tokens', compactCN(totals.inputTokens)],
        ['输出 tokens', compactCN(totals.outputTokens)],
        ['Cache read tokens', compactCN(totals.cacheReadTokens)],
        ['官方价换算', money(totals.costUSD)],
        ['人民币估算口径', `${U.exchangeRateLabel()}，仅供复盘参考`],
        ['未归因 session', formatInt(buildUnattributedSessions(sessions).length)],
        ['人工确认归因', formatInt(attributionBreakdown.manual)],
        ['自动高置信归因', formatInt(attributionBreakdown.autoHigh)],
        ['自动低置信 / 待确认', formatInt(attributionBreakdown.autoLow + attributionBreakdown.missing)],
        ['ROI 证据完整度', `${roiEvidence.evidenceScore}/100`],
        ['Work items', formatInt(roiEvidence.workItemCount)]
      ]
    ),
    '',
    '## 2. Local Trust',
    '',
    localTrustSection(localTrust),
    '',
    '## 3. Coverage Bridge',
    '',
    coverageBridge ? [
      'Coverage Bridge 只说明来源覆盖方式，不把 detected-only 包装成真实 token 覆盖。',
      '',
      table(
        ['状态', '数量'],
        [
          ['原生可信采集', formatInt(coverageBridge.summary?.nativeTrusted || 0)],
          ['ccusage 可导入', formatInt(coverageBridge.summary?.importable || 0)],
          ['实验采集', formatInt(coverageBridge.summary?.experimental || 0)],
          ['仅检测到', formatInt(coverageBridge.summary?.detectedOnly || 0)],
          ['不支持 / 无 token 字段', formatInt(coverageBridge.summary?.unsupported || 0)]
        ]
      ),
      '',
      coverageBridge.rows?.length ? table(
        ['来源', '覆盖方式', '已检测', 'Sessions', 'Token', '推荐动作'],
        coverageBridge.rows.slice(0, 10).map(row => [
          row.label,
          row.statusLabel,
          row.detected ? '是' : '否',
          formatInt(row.sessions || 0),
          compactCN(row.totalTokens || 0),
          row.recommendedAction
        ])
      ) : '暂无来源覆盖数据。'
    ].join('\n') : '当前 API 没有返回 Coverage Bridge 数据。',
    '',
    '## 4. Evidence Flywheel',
    '',
    evidenceFlywheel ? [
      table(
        ['指标', '数值'],
        [
          ['飞轮进度', `${evidenceFlywheel.score || 0}%`],
          ['完成步骤', `${evidenceFlywheel.completedSteps || 0}/${evidenceFlywheel.totalSteps || 0}`],
          ['自动证据 session', formatInt(evidenceFlywheel.totals?.autoEvidenceCount || 0)],
          ['人工确认 session', formatInt(evidenceFlywheel.totals?.manualEvidenceCount || 0)],
          ['产出证据 session', formatInt(evidenceFlywheel.totals?.outputEvidenceCount || 0)],
          ['模型策略样本 session', formatInt(evidenceFlywheel.totals?.strategyEvidenceCount || 0)]
        ]
      ),
      '',
      '### Coverage-to-Evidence',
      '',
      coverageToEvidenceTable({ localTrust, evidenceFlywheel, coverageBridge }),
      '',
      `下一步：${safeText(evidenceFlywheel.nextAction || '抽查最高成本自动证据。')}`,
      '',
      evidenceFlywheel.steps?.length ? table(
        ['步骤', '状态', '进度', '建议动作'],
        evidenceFlywheel.steps.map(step => [
          step.label,
          step.complete ? '已具备' : '待补齐',
          `${step.current}/${step.target}`,
          step.action
        ])
      ) : ''
    ].join('\n') : '当前 API 没有返回 Evidence Flywheel 数据。',
    '',
    '## 5. 成本最高项目',
    '',
    projectRows.length ? table(
      ['项目', 'Sessions', 'Tokens', '官方价', '完成/发布占比', '风险占比'],
      projectRows.map(row => [
        row.project,
        row.sessionCount,
        compactCN(row.totalTokens),
        money(row.costUSD),
        pct(row.productiveShare),
        pct(row.riskShare)
      ])
    ) : '本期没有项目数据。',
    '',
    '## 6. 模型使用分布',
    '',
    modelRows.length ? table(
      ['模型', '来源', 'Tokens', '官方价', '占比'],
      modelRows.map(row => [
        row.model,
        row.source,
        compactCN(row.totalTokens),
        row.costUSD > 0 ? money(row.costUSD) : '未定价/无官方价',
        pct(row.share)
      ])
    ) : '本期没有模型数据。',
    '',
    '## 7. 已完成 / 已发布产出',
    '',
    outputRows.length ? table(
      ['状态', '类型', '标签', '项目', '链接'],
      outputRows.map(row => [
        row.outputStatus,
        row.outputType || '未分类',
        row.outputLabel || row.outputUrl || row.sessionId,
        sessionProjectLabel(row),
        markdownLink(row.outputLabel || row.outputUrl || '产出链接', row.outputUrl)
      ])
    ) : '本期没有已完成/已发布的产出链接。建议先给高价值 session 补 PR、commit、文章、部署、文档或截图链接。',
    '',
    '## 8. 风险成本',
    '',
    riskRows.length ? table(
      ['风险类型', 'Sessions', 'Tokens', '官方价', '占比'],
      riskRows.map(row => [
        row.label,
        row.sessionCount,
        compactCN(row.totalTokens),
        money(row.costUSD),
        pct(row.share)
      ])
    ) : '本期没有明显风险成本。',
    '',
    '### 高成本待补齐归因',
    '',
    attributionGapRows.length ? table(
      ['优先级', '项目', 'Session', '缺失字段', '归因来源', 'Tokens', '官方价', '最后活动'],
      attributionGapRows.map((row, index) => [
        index + 1,
        row.project,
        row.sessionId,
        row.missingFields.join('、'),
        row.attributionLabel,
        compactCN(row.totalTokens),
        row.costUSD > 0 ? money(row.costUSD) : '未定价/无官方价',
        row.lastActivity || ''
      ])
    ) : '本期没有待补齐的高成本归因 session。',
    '',
    '## 9. 节省模拟',
    '',
    savingsSimulation?.suggestions?.length ? [
      '官方价换算节省模拟只用于比较模型策略，不是供应商账单。',
      '',
      table(
        ['建议', '当前层级', '建议层级', 'Sessions', 'Tokens', '当前官方价', '模拟后官方价', '可节省', '原因'],
        savingsSimulation.suggestions.slice(0, 5).map(row => [
          row.title,
          tierLabel(row.currentTier),
          tierLabel(row.suggestedTier),
          row.sessionCount,
          compactCN(row.totalTokens),
          money(row.currentCostUSD),
          money(row.simulatedCostUSD),
          money(row.savingsUSD),
          row.why
        ])
      )
    ].join('\n') : '本期没有触发可计算的官方价节省建议。高价值已完成/已发布任务不会被建议降级模型。',
    '',
    savingsSimulation?.unpriced?.sessionCount ? `未纳入成本决策：${formatInt(savingsSimulation.unpriced.sessionCount)} 个 session、${compactCN(savingsSimulation.unpriced.totalTokens)} tokens 没有公开官方美元价，模型包括 ${safeText(savingsSimulation.unpriced.models.join('、') || 'unknown')}。` : '',
    '',
    '## 10. ROI Advisor 建议',
    '',
    roiAdvice.length ? roiAdvice.map((item, index) => [
      `### ${index + 1}. ${safeText(item.title)}`,
      '',
      `- 建议分类：${safeText(item.category || '未分类')}`,
      `- 影响级别：${safeText(item.impact || '未标注')}`,
      `- 建议：${safeText(item.recommendation)}`,
      `- 原因：${safeText(item.reason)}`,
      `- 证据：${safeText(item.evidence)}`,
      `- 建议动作：${safeText(item.action)}`
    ].join('\n')).join('\n\n') : '本期没有触发 ROI Advisor 建议。',
    '',
    '## 11. 本周行动状态',
    '',
    actionStatusRows.length ? table(
      ['状态', '分类', '建议', '行动'],
      actionStatusRows.map(row => [
        statusLabel(row.status),
        row.category,
        row.title,
        row.action
      ])
    ) : '本期还没有加入行动清单的 Advisor / 节省模拟建议。',
    '',
    '说明：完成行动只表示复盘流程状态；报告只展示行动前后同类 token / 官方价趋势，不证明真实因果节省。',
    '',
    actionMeasurements.length ? [
      '### 行动前后趋势',
      '',
      table(
        ['行动', '范围', 'Before tokens', 'After tokens', 'Delta tokens', 'Before $', 'After $', '说明'],
        actionMeasurements.slice(0, 8).map(row => [
          row.title,
          row.scopeLabel,
          compactCN(row.beforeTokens),
          compactCN(row.afterTokens),
          signedCompactCN(row.deltaTokens),
          money(row.beforeCostUSD),
          money(row.afterCostUSD),
          row.caveat || '趋势对比不证明真实因果节省。'
        ])
      ),
      ''
    ].join('\n') : '',
    '',
    '## 12. 下周行动清单',
    '',
    actionItems.length ? actionItems.map(item => `- ${safeText(item)}`).join('\n') : '- 保持当前模型和上下文使用策略，继续补充真实产出链接。',
    '',
    '## 13. 口径说明',
    '',
    '- 金额为官方公开 token 单价换算，不是供应商账单或财务对账结果。',
    '- 节省模拟使用当前 token 结构和已配置官方价模型做策略比较，不承诺真实账单节省。',
    '- ChatGPT 套餐额度、企业折扣、税费、区域价、Batch/Flex/Priority 和特殊长上下文计费不会自动套用。',
    '- 未公开官方美元价的模型保持“未定价”，不会按 $0 或 ¥0 参与成本决策。',
    '- 自动归因是基于结构化元数据的规则推断，不等同人工确认；高成本自动项建议抽查。',
    '- 报告只使用本地结构化用量、人工标注、自动归因和产出链接，不读取、不导出对话正文。',
    '- 产出链接只记录 URL、标签和类型；Token Work 不抓取链接内容。',
    '',
    '---',
    '',
    U.LEGAL_NOTICE
  ].join('\n');
}

export function buildReviewReportFilename(period, today = new Date()) {
  const suffix = period?.end || formatDate(today);
  return `token-work-review-${suffix}.md`;
}

export function buildModelRows(daily = []) {
  const rows = new Map();
  const totalTokens = daily.reduce((sum, row) => sum + (row.totalTokens || 0), 0);
  for (const row of daily) {
    // 同一模型多种写法归并到 modelLabel,报告里同模型不拆行
    const model = row.modelLabel || row.model || '<unknown>';
    const source = row.source || 'unknown';
    const key = `${model}::${source}`;
    if (!rows.has(key)) {
      rows.set(key, { model, source, totalTokens: 0, costUSD: 0 });
    }
    const acc = rows.get(key);
    acc.totalTokens += row.totalTokens || 0;
    acc.costUSD += row.costUSD || 0;
  }
  return Array.from(rows.values())
    .map(row => ({
      ...row,
      share: totalTokens ? row.totalTokens / totalTokens : 0
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

function buildOutputRows(sessions: UsageRow[] = []) {
  return sessions
    .filter(session => PRODUCTIVE_STATUSES.has(session.outputStatus) && session.outputUrl)
    .sort((a, b) => (b.totalTokens || 0) - (a.totalTokens || 0));
}

function buildAttributionGapRows(sessions: UsageRow[] = []) {
  return buildReviewUnattributedSessions(sessions).map(session => ({
    project: sessionProjectLabel(session),
    sessionId: session.sessionId || '',
    missingFields: missingAttributionFields(session),
    attributionLabel: attributionLabel(session),
    totalTokens: session.totalTokens || 0,
    costUSD: session.costUSD || 0,
    lastActivity: session.lastActivity || session.lastSeenAt || session.updatedAt || ''
  }));
}

function buildAttributionBreakdown(sessions: UsageRow[] = []) {
  return sessions.reduce<{ manual: number; autoHigh: number; autoLow: number; missing: number }>((acc, session) => {
    if (session.annotationSource === 'auto') {
      if (Number(session.annotationConfidence || 0) >= 80) acc.autoHigh += 1;
      else acc.autoLow += 1;
    } else if (session.annotationSource === 'manual' || session.annotationSource === 'imported') {
      acc.manual += 1;
    } else {
      acc.missing += 1;
    }
    return acc;
  }, { manual: 0, autoHigh: 0, autoLow: 0, missing: 0 });
}

function attributionLabel(session: UsageRow = {}) {
  if (session.annotationSource === 'auto') return `auto ${Number(session.annotationConfidence || 0)}%`;
  if (session.annotationSource === 'manual') return 'manual';
  if (session.annotationSource === 'imported') return 'imported';
  return 'missing';
}

function missingAttributionFields(session: UsageRow = {}) {
  const fields = [];
  if ((session.taskType || '未分类') === '未分类') fields.push('任务类型');
  if ((session.outputStatus || '未标注') === '未标注') fields.push('产出状态');
  if ((session.workPurpose || '未说明') === '未说明') fields.push('工作目的');
  if ((session.workStage || '未说明') === '未说明') fields.push('工作阶段');
  if ((session.valueLevel || '未评估') === '未评估') fields.push('产出价值');
  return fields;
}

function buildActionItems({ roiAdvice = [], sessions = [], outputRows = [] }) {
  const items = roiAdvice.slice(0, 3).map(item => item.action).filter(Boolean);
  const unattributed = buildUnattributedSessions(sessions).slice(0, 3);
  for (const session of unattributed) {
    items.push(`补齐 ${sessionProjectLabel(session)} 的 session 标注：任务、目的、阶段、价值和产出状态。`);
  }
  if (!outputRows.length) {
    items.push('给已完成或已发布的高价值 session 补充 PR、commit、文章、部署、文档或截图链接。');
  }
  return Array.from(new Set(items)).slice(0, 8);
}

function buildAdvisorActionRows(actions: UsageRow[] = [], period: PeriodRange = {}) {
  return actions
    .filter(action => !period?.start || (
      action.periodStart === period.start && action.periodEnd === period.end
    ))
    .sort((a, b) => statusRank(a.status) - statusRank(b.status) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, 12);
}

function localTrustSection(localTrust) {
  if (!localTrust) {
    return '当前 API 没有返回 Local Trust 数据。建议重启最新版 Token Work 后再导出报告。';
  }
  const conclusion = localTrust.conclusion || {};
  const reconciliation = localTrust.reconciliation || {};
  const runtime = localTrust.runtime || {};
  const counts = localTrust.counts || {};
  const lines = [
    'Local Trust 说明当前数据能否用于 ROI 复盘。它只使用结构化 token/session 元数据，不返回 prompt、response、transcript、diff 或完整本机路径。',
    '',
    table(
      ['项目', '结论'],
      [
        ['可信度结论', conclusion.decision || '待确认'],
        ['建议动作', conclusion.action || '先运行 coverage 或导入结构化用量。'],
        ['数据模式', localTrust.dataMode?.label || 'Unknown'],
        ['Coverage gate', runtime.coverageGate?.status || 'not-run'],
        ['Daily rows', formatInt(counts.dailyRows || 0)],
        ['Session rows', formatInt(counts.sessionRows || 0)],
        ['Token events', formatInt(counts.tokenEventRows || 0)],
        ['总量校验', `${reconciliation.statusLabel || '未校验'} · ${reconciliation.note || ''}`]
      ]
    )
  ];
  const sources = Array.isArray(localTrust.sources) ? localTrust.sources : [];
  if (sources.length) {
    lines.push(
      '',
      table(
        ['来源', '结论', '原因', 'Sessions', 'Events', 'Tokens'],
        sources.slice(0, 10).map(row => [
          row.label,
          row.conclusion,
          row.reason,
          formatInt(row.sessions || 0),
          formatInt(row.tokenEvents || 0),
          compactCN(row.totalTokens || 0)
        ])
      )
    );
  }
  return lines.join('\n');
}

function coverageToEvidenceTable({ localTrust, evidenceFlywheel, coverageBridge }) {
  const evidence = localTrust?.evidence || {};
  const quality = evidenceFlywheel?.quality || {};
  return table(
    ['环节', '数值', '说明'],
    [
      [
        '已接入用量来源',
        formatInt(evidence.coverageSourcesWithUsage ?? coverageBridge?.summary?.sourcesWithUsage ?? 0),
        '有 session/event/daily 用量的来源数量。'
      ],
      [
        '成功覆盖来源',
        formatInt(evidence.successfulCoverageSources ?? coverageBridge?.summary?.successfulCoverage ?? 0),
        '原生可信或 ccusage 导入且已有结构化 token。'
      ],
      [
        '可信来源 session',
        formatInt(evidence.trustedSessionCount ?? 0),
        '来自已通过 coverage / 导入验收的来源，可进入证据队列。'
      ],
      [
        '可信来源 token',
        compactCN(evidence.trustedTokenTotal ?? 0),
        '默认按官方价和 token 降序，优先处理最高价值 10 条证据缺口。'
      ],
      [
        '已识别项目',
        formatInt(evidence.recognizedProjectCount ?? evidenceFlywheel?.totals?.recognizedProjectCount ?? 0),
        '能够从别名、规则或路径尾部识别项目的范围。'
      ],
      [
        '可直接写入证据',
        formatInt(evidence.directWriteCount ?? quality.directWriteCount ?? 0),
        '高置信自动证据；写入时不覆盖人工确认。'
      ],
      [
        '待确认草稿',
        formatInt(evidence.draftCount ?? quality.draftCount ?? 0),
        '中低置信建议，只作为待确认，不包装成人工事实。'
      ],
      [
        '不可写入',
        formatInt(evidence.blockedCount ?? quality.blockedCount ?? 0),
        '缺远程 URL、时间窗口或可靠 token 字段。'
      ],
      [
        '人工确认',
        formatInt(evidence.manualConfirmedCount ?? quality.manualConfirmedCount ?? 0),
        '最高可信复盘证据。'
      ]
    ]
  );
}

function statusRank(status) {
  if (status === 'open') return 0;
  if (status === 'done') return 1;
  return 2;
}

function statusLabel(status) {
  if (status === 'done') return '已完成';
  if (status === 'dismissed') return '已忽略';
  return '行动中';
}

function aggregateDaily(daily: UsageRow[] = []) {
  return daily.reduce((acc, row) => {
    acc.totalTokens += row.totalTokens || 0;
    acc.inputTokens += row.inputTokens || 0;
    acc.outputTokens += row.outputTokens || 0;
    acc.cacheReadTokens += row.cacheReadTokens || 0;
    acc.cacheCreationTokens += row.cacheCreationTokens || 0;
    acc.reasoningOutputTokens += row.reasoningOutputTokens || 0;
    acc.costUSD += row.costUSD || 0;
    return acc;
  }, {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningOutputTokens: 0,
    costUSD: 0
  });
}

function table(headers, rows) {
  return [
    `| ${headers.map(safeCell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${row.map(safeCell).join(' | ')} |`)
  ].join('\n');
}

function safeCell(value) {
  const text = safeText(value);
  const formulaSafe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return formulaSafe.replace(/\|/g, '\\|');
}

function safeText(value) {
  return String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function markdownLink(label, url) {
  const text = safeText(label || url || '链接');
  const href = safeText(url);
  if (!/^https?:\/\//i.test(href)) return text || '—';
  return `[${text.replace(/[[\]]/g, '')}](${href.replace(/[()]/g, encodeURIComponent)})`;
}

function compactCN(value) {
  const v = Number(value || 0);
  const abs = Math.abs(v);
  if (abs >= 1e8) return `${(v / 1e8).toFixed(2).replace(/\.?0+$/, '')} 亿`;
  if (abs >= 1e4) return `${(v / 1e4).toFixed(1).replace(/\.0$/, '')} 万`;
  return formatInt(v);
}

function signedCompactCN(value) {
  const v = Number(value || 0);
  if (v === 0) return '0';
  return `${v > 0 ? '+' : ''}${compactCN(v)}`;
}

function formatInt(value) {
  return new Intl.NumberFormat('zh-CN').format(Math.round(Number(value || 0)));
}

function money(value) {
  return U.money(Number(value || 0));
}

function pct(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

function tierLabel(tier) {
  if (tier === 'heavy') return '重模型';
  if (tier === 'mid') return '中模型';
  if (tier === 'light') return '轻量模型';
  if (tier === 'unpriced') return '未定价';
  return '未分层';
}

function formatDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')
  ].join('-');
}

function formatDateTime(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${formatDate(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
