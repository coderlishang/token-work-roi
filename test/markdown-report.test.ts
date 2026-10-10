import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMarkdownReviewReport,
  buildModelRows,
  buildReviewReportFilename
} from '../src/client/review/markdown-report.ts';

const period = {
  pretty: '2026 年 6 月',
  start: '2026-06-01',
  end: '2026-06-12'
};

test('buildMarkdownReviewReport renders the fixed weekly review structure', () => {
  const report = buildMarkdownReviewReport({
    period,
    daily: [],
    sessions: [],
    roiAdvice: [],
    generatedAt: new Date(2026, 5, 12, 9, 30)
  });

  assert.match(report, /^# Token Work Weekly Review/);
  assert.match(report, /## 1\. 本期总览/);
  assert.match(report, /## 2\. Local Trust/);
  assert.match(report, /## 3\. Coverage Bridge/);
  assert.match(report, /## 4\. Evidence Flywheel/);
  assert.match(report, /## 11\. 本周行动状态/);
  assert.match(report, /## 13\. 口径说明/);
  assert.match(report, /## 9\. 节省模拟/);
  assert.match(report, /官方公开 token 单价换算，不是供应商账单/);
  assert.match(report, /不读取、不导出对话正文/);
});

test('buildMarkdownReviewReport includes coverage bridge and evidence flywheel summaries', () => {
  const report = buildMarkdownReviewReport({
    period,
    daily: [],
    sessions: [],
    coverageBridge: {
      summary: {
        nativeTrusted: 2,
        importable: 1,
        detectedOnly: 3,
        unsupported: 4
      },
      rows: [{
        label: 'Claude Code',
        statusLabel: '原生可信采集',
        detected: true,
        sessions: 2,
        totalTokens: 1000,
        recommendedAction: '已有原生结构化 token 数据'
      }]
    },
    localTrust: {
      conclusion: {
        decision: '当前真实 SQLite 有 event 级 token，并且 daily/session/event 总量可校验。',
        action: '进入 Evidence Flywheel。'
      },
      dataMode: { label: 'Real DB - event verified' },
      runtime: {
        coverageGate: { status: 'passed' }
      },
      counts: { dailyRows: 1, sessionRows: 1, tokenEventRows: 1 },
      reconciliation: {
        statusLabel: '总量一致',
        note: 'daily/session/event token 合计在可接受误差内。'
      },
      evidence: {
        coverageSourcesWithUsage: 1,
        successfulCoverageSources: 1,
        trustedSessionCount: 3,
        trustedTokenTotal: 120000,
        recognizedProjectCount: 1,
        directWriteCount: 1,
        draftCount: 2,
        blockedCount: 0,
        manualConfirmedCount: 0
      },
      sources: [{
        label: 'Codex CLI',
        conclusion: '可用于 ROI 复盘',
        reason: '已写入结构化 token。',
        sessions: 1,
        tokenEvents: 1,
        totalTokens: 1000
      }]
    },
    evidenceFlywheel: {
      score: 50,
      completedSteps: 3,
      totalSteps: 6,
      nextAction: '先确认最高成本草稿',
      totals: {
        autoEvidenceCount: 1,
        manualEvidenceCount: 0,
        outputEvidenceCount: 0,
        strategyEvidenceCount: 1
      },
      steps: [{
        label: '已有真实 token',
        complete: true,
        current: 1,
        target: 1,
        action: '已具备'
      }]
    }
  });

  assert.match(report, /原生可信采集 \| 2/);
  assert.match(report, /## 2\. Local Trust/);
  assert.match(report, /可信度结论 \| 当前真实 SQLite 有 event 级 token/);
  assert.match(report, /Codex CLI \| 可用于 ROI 复盘/);
  assert.match(report, /Claude Code \| 原生可信采集/);
  assert.match(report, /飞轮进度 \| 50%/);
  assert.match(report, /### Coverage-to-Evidence/);
  assert.match(report, /可信来源 session \| 3/);
  assert.match(report, /可信来源 token \| 12 万/);
  assert.match(report, /待确认草稿 \| 2/);
  assert.match(report, /下一步：先确认最高成本草稿/);
});

test('buildMarkdownReviewReport includes advisor action workflow status', () => {
  const report = buildMarkdownReviewReport({
    period,
    daily: [],
    sessions: [],
    advisorActions: [{
      periodStart: '2026-06-01',
      periodEnd: '2026-06-12',
      status: 'done',
      category: '节省模拟',
      title: '测试验证改用轻量模型',
      action: '下周测试验证默认先用轻量模型',
      sourceRule: 'savings:test'
    }]
  });

  assert.match(report, /已完成 \| 节省模拟 \| 测试验证改用轻量模型 \| 下周测试验证默认先用轻量模型/);
  assert.match(report, /不证明真实因果节省/);
});

test('buildMarkdownReviewReport includes advisor action trend measurements without causality claims', () => {
  const report = buildMarkdownReviewReport({
    period,
    advisorActions: [{
      periodStart: '2026-06-01',
      periodEnd: '2026-06-12',
      status: 'done',
      category: '节省模拟',
      title: '探索默认轻量模型',
      action: '测试验证先用轻量模型'
    }],
    actionMeasurements: [{
      title: '探索默认轻量模型',
      scopeLabel: '探索 / 验证 / 上下文整理',
      beforeTokens: 1000,
      afterTokens: 300,
      deltaTokens: -700,
      beforeCostUSD: 10,
      afterCostUSD: 1,
      caveat: '同类任务/模型趋势对比，不证明真实因果节省。'
    }]
  });

  assert.match(report, /### 行动前后趋势/);
  assert.match(report, /探索 \/ 验证 \/ 上下文整理/);
  assert.match(report, /-700/);
  assert.match(report, /不证明真实因果节省/);
});

test('buildMarkdownReviewReport includes unattributed work and advisor actions', () => {
  const report = buildMarkdownReviewReport({
    period,
    daily: [{
      usageDate: '2026-06-10',
      source: 'Codex CLI',
      model: 'gpt-5.5',
      totalTokens: 1000,
      inputTokens: 800,
      outputTokens: 100,
      cacheReadTokens: 50,
      costUSD: 1
    }],
    sessions: [{
      sessionId: 's1',
      projectPath: 'D:\\AIResume',
      taskType: '未分类',
      outputStatus: '未标注',
      totalTokens: 1000,
      costUSD: 1
    }],
    roiAdvice: [{
      title: '先补齐高成本会话',
      category: '补标注',
      impact: '高',
      recommendation: '补用途和价值',
      reason: '缺少归因字段',
      evidence: '1 个 session 未归因',
      action: '先标注最高成本 session'
    }],
    generatedAt: new Date(2026, 5, 12, 9, 30)
  });

  assert.match(report, /未归因 session \| 1/);
  assert.match(report, /建议分类：补标注/);
  assert.match(report, /先标注最高成本 session/);
  assert.match(report, /补齐 D:\\AIResume 的 session 标注/);
});

test('buildMarkdownReviewReport lists highest-cost review attribution gaps first', () => {
  const report = buildMarkdownReviewReport({
    period,
    daily: [],
    sessions: [
      {
        sessionId: 'low-cost-gap',
        projectAlias: 'Low Cost',
        taskType: '未分类',
        outputStatus: '未标注',
        totalTokens: 100,
        costUSD: 0.02,
        lastActivity: '2026-06-09'
      },
      {
        sessionId: 'high-cost-gap',
        projectAlias: 'Token Work',
        taskType: '功能开发',
        outputStatus: '已完成',
        workPurpose: '未说明',
        workStage: '未说明',
        valueLevel: '未评估',
        totalTokens: 5000,
        costUSD: 2.5,
        lastActivity: '2026-06-12'
      }
    ]
  });

  const highIndex = report.indexOf('high-cost-gap');
  const lowIndex = report.indexOf('low-cost-gap');
  assert.match(report, /### 高成本待补齐归因/);
  assert.ok(highIndex > -1);
  assert.ok(lowIndex > -1);
  assert.ok(highIndex < lowIndex);
  assert.match(report, /工作目的、工作阶段、产出价值/);
  assert.match(report, /Token Work \| high-cost-gap \| 工作目的、工作阶段、产出价值 \| missing \| 5,000 \| \$2\.50 \/ ¥18\.00 \| 2026-06-12/);
});

test('buildMarkdownReviewReport includes published output links without fetching content', () => {
  const report = buildMarkdownReviewReport({
    period,
    daily: [],
    sessions: [{
      sessionId: 'published',
      projectAlias: 'Token Work',
      taskType: '功能开发',
      outputStatus: '已发布',
      outputType: 'PR',
      outputLabel: 'v3.1 PR',
      outputUrl: 'https://example.com/pr/1',
      totalTokens: 100,
      costUSD: 0.1
    }]
  });

  assert.match(report, /已发布 \| PR \| v3\.1 PR \| Token Work \| \[v3\.1 PR\]\(https:\/\/example.com\/pr\/1\)/);
});

test('buildMarkdownReviewReport keeps unpriced model wording and escapes spreadsheet formula prefixes', () => {
  const report = buildMarkdownReviewReport({
    period,
    daily: [{
      usageDate: '2026-06-10',
      source: 'Codex CLI',
      model: '=IMPORTXML("https://example.com")',
      totalTokens: 100,
      inputTokens: 80,
      outputTokens: 20,
      cacheReadTokens: 0,
      costUSD: 0
    }],
    sessions: [{
      sessionId: 's1',
      projectAlias: '+cmd|danger',
      taskType: '功能开发',
      outputStatus: '已完成',
      totalTokens: 100,
      costUSD: 0
    }]
  });

  assert.match(report, /未定价\/无官方价/);
  assert.match(report, /'\=IMPORTXML/);
  assert.match(report, /'\+cmd\\\|danger/);
});

test('buildModelRows aggregates by model and source', () => {
  const rows = buildModelRows([
    { source: 'Codex CLI', model: 'gpt-5.5', totalTokens: 100, costUSD: 1 },
    { source: 'Codex CLI', model: 'gpt-5.5', totalTokens: 50, costUSD: 0.5 },
    { source: 'Claude Code', model: 'claude-sonnet', totalTokens: 25, costUSD: 0.1 }
  ]);

  assert.equal(rows[0].model, 'gpt-5.5');
  assert.equal(rows[0].totalTokens, 150);
  assert.equal(rows[0].share, 150 / 175);
});

test('buildReviewReportFilename uses the active period end date', () => {
  assert.equal(buildReviewReportFilename(period), 'token-work-review-2026-06-12.md');
});

test('buildModelRows merges same-model spellings via modelLabel', () => {
  const rows = buildModelRows([
    { source: 'WorkBuddy', model: 'deepseek-flash', modelLabel: 'deepseek-v4.1-flash', totalTokens: 100, costUSD: 0.1 },
    { source: 'WorkBuddy', model: 'deepseek-v4.1-flash', modelLabel: 'deepseek-v4.1-flash', totalTokens: 400, costUSD: 0.2 }
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, 'deepseek-v4.1-flash');
  assert.equal(rows[0].totalTokens, 500);
});
