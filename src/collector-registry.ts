import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { configuredPath, configuredPaths } from './collector-config.ts';
import { auditStructuredUsage } from './collectors/structured-usage.ts';

const STABLE_FIELDS = [
  'date',
  'source',
  'session_id',
  'project',
  'model',
  'input_tokens',
  'output_tokens',
  'cache_tokens',
  'reasoning_tokens'
];

const EXPERIMENTAL_FIELDS = [
  'timestamp',
  'source',
  'session_id',
  'project_label',
  'model',
  'input_tokens',
  'output_tokens',
  'cache_tokens',
  'tool_category',
  'file_extension'
];

const IMPORT_FIELDS = [
  'date',
  'session',
  'model',
  'input_tokens',
  'output_tokens',
  'cache_tokens',
  'cost_usd'
];

export const COLLECTOR_REGISTRY = [
  stableCollector('claude', 'Claude Code', './collectors/claude-code.ts', {
    privacyLevel: 'metadata-only',
    roots: () => configuredPaths('claude', 'roots', ['~/.config/claude', '~/.claude'])
  }),
  stableCollector('codex', 'Codex', './collectors/codex.ts', {
    privacyLevel: 'metadata-only',
    roots: () => configuredPaths('codex', 'homes', ['~/.codex'])
  }),
  stableCollector('gemini', 'Gemini CLI', './collectors/gemini.ts', {
    privacyLevel: 'metadata-only',
    roots: () => [join(homedir(), '.gemini', 'tmp')]
  }),
  stableCollector('opencode', 'OpenCode', './collectors/opencode.ts', {
    privacyLevel: 'metadata-only',
    roots: () => [configuredPath('opencode', 'dataDir', '~/.local/share/opencode')]
  }),
  stableCollector('openclaw', 'OpenClaw', './collectors/openclaw.ts', {
    privacyLevel: 'metadata-only',
    roots: () => configuredPaths('openclaw', 'agentRoots', [
      '~/.openclaw/agents',
      '~/.clawdbot/agents',
      '~/.moltbot/agents',
      '~/.moldbot/agents'
    ])
  }),
  stableCollector('hermes', 'Hermes Agent', './collectors/hermes.ts', {
    privacyLevel: 'metadata-only',
    roots: () => [configuredPath('hermes', 'dbPath', '~/.hermes/state.db')]
  }),
  experimentalCollector('cursor', 'Cursor', {
    module: './collectors/cursor.ts',
    privacyLevel: 'metadata-only',
    roots: () => cursorRoots(),
    note: 'Experimental: only explicit local usage records with token fields are imported; chat content is ignored.'
  }),
  experimentalCollector('copilot', 'GitHub Copilot CLI', {
    module: './collectors/copilot.ts',
    privacyLevel: 'metadata-only',
    roots: () => copilotRoots(),
    note: 'Experimental: local token rows are imported only when token fields are present.'
  }),
  experimentalCollector('qwen', 'Qwen Code', {
    module: './collectors/qwen.ts',
    privacyLevel: 'metadata-only',
    roots: () => configuredPaths('qwen', 'roots', ['~/.qwen', '~/.qwen-code']),
    note: 'Experimental: supports fixture-backed structured usage logs without message-body ingestion.'
  }),
  experimentalCollector('kimi', 'Kimi / Moonshot Coding CLI', {
    module: './collectors/kimi.ts',
    privacyLevel: 'metadata-only',
    roots: () => configuredPaths('kimi', 'roots', ['~/.kimi', '~/.moonshot']),
    note: 'Experimental: supports fixture-backed structured usage logs without message-body ingestion.'
  }),
  experimentalCollector('goose', 'Goose', {
    module: './collectors/goose.ts',
    privacyLevel: 'metadata-only',
    roots: () => configuredPaths('goose', 'roots', ['~/.config/goose', '~/.goose']),
    note: 'Experimental: supports explicit token metadata only; message bodies are not imported.'
  }),
  experimentalCollector('deepseek-harness', 'DeepSeek Harness', {
    module: './collectors/deepseek-harness.ts',
    privacyLevel: 'metadata-only',
    roots: () => configuredPaths('deepseekHarness', 'roots', ['~/.dsh']),
    note: 'Experimental: reads only the harness-provided cumulative tokenUsage totals per session; message and tool content are ignored.'
  }),
  stableCollector('workbuddy', 'WorkBuddy', './collectors/workbuddy.ts', {
    privacyLevel: 'metadata-only',
    roots: () => [
      configuredPath('workbuddy', 'tracesDir', '~/.workbuddy/traces'),
      configuredPath('workbuddy', 'projectsDir', join(configuredPath('workbuddy', 'root', '~/.workbuddy'), 'projects'))
    ]
  }),
  stableCollector('codebuddy', 'CodeBuddy', './collectors/codebuddy.ts', {
    privacyLevel: 'metadata-only',
    roots: () => configuredPaths('codebuddy', 'logsRoots', [
      '~/Library/Application Support/CodeBuddy CN/logs',
      '~/Library/Application Support/CodeBuddy/logs',
      '${APPDATA}/CodeBuddy CN/logs',
      '${APPDATA}/CodeBuddy/logs',
      '~/.config/CodeBuddy CN/logs',
      '~/.config/CodeBuddy/logs'
    ])
  }),
  importOnlyCollector('ccusage', 'ccusage Import Bridge', {
    roots: () => configuredPaths('ccusage', 'roots', []),
    note: 'Import-only: use token-work import-usage --format=ccusage-json for saved JSON or --format=ccusage-cli for an explicit ccusage CLI bridge.'
  }),
  detectedOnlyCollector('amp', 'Amp', ['~/.config/amp', '~/.amp']),
  detectedOnlyCollector('droid', 'Droid', ['~/.droid', '~/.config/droid']),
  detectedOnlyCollector('codebuff', 'Codebuff', ['~/.codebuff', '~/.config/codebuff']),
  detectedOnlyCollector('pi-agent', 'pi-agent', ['~/.pi-agent', '~/.config/pi-agent']),
  detectedOnlyCollector('roo-code', 'Roo Code', ['~/.roo-code', '~/.config/roo-code']),
  detectedOnlyCollector('zed-agent', 'Zed Agent', ['~/.config/zed', '~/Library/Application Support/Zed']),
  detectedOnlyCollector('antigravity', 'Antigravity', ['~/.antigravity', '~/.config/antigravity']),
  detectedOnlyCollector('cline', 'Cline', ['~/.cline', '~/.config/cline']),
  detectedOnlyCollector('kiro', 'Kiro', ['~/.kiro', '~/.config/kiro']),
  detectedOnlyCollector('grok-build', 'Grok Build', ['~/.grok', '~/.config/grok']),
  detectedOnlyCollector('kilo', 'Kilo', ['~/.kilo', '~/.config/kilo'])
];

export function listCollectors() {
  return COLLECTOR_REGISTRY.map(({ roots, ...entry }) => ({
    ...entry,
    configuredRoots: roots().filter(Boolean)
  }));
}

export function stableCollectors() {
  return COLLECTOR_REGISTRY.filter(item => item.supportStatus === 'stable');
}

export function collectableCollectors({ includeExperimental = false } = {}) {
  return COLLECTOR_REGISTRY.filter(item =>
    item.module && (item.supportStatus === 'stable' || (includeExperimental && item.supportStatus === 'experimental'))
  );
}

export function collectorById(id) {
  return COLLECTOR_REGISTRY.find(item => item.id === id);
}

export function collectorLabel(id) {
  return collectorById(id)?.label || id || 'unknown';
}

// Sources the local UI collects in the background (start banner, live refresh
// message, coverage dry-run defaults all derive from this single list).
export const LIVE_COLLECT_SOURCES = 'claude,codex,workbuddy,codebuddy,deepseek-harness';

export function liveCollectSourceNames() {
  const labels = LIVE_COLLECT_SOURCES.split(',').map(collectorLabel);
  if (labels.length <= 1) return labels.join(', ');
  return `${labels.slice(0, -1).join(', ')}, and ${labels.at(-1)}`;
}

export function detectCollectors() {
  return COLLECTOR_REGISTRY.map(item => {
    const roots = item.roots().filter(Boolean);
    const existingRoots = roots.filter(path => existsSync(path));
    return {
      id: item.id,
      label: item.label,
      supportStatus: item.supportStatus,
      privacyLevel: item.privacyLevel,
      defaultEnabled: item.defaultEnabled,
      detected: existingRoots.length > 0,
      configuredRoots: roots,
      existingRoots,
      module: item.module || null,
      fixtures: item.fixtures || null,
      dataFields: item.dataFields || [],
      readsConversationContent: Boolean(item.readsConversationContent),
      tokenReliability: item.tokenReliability || 'unknown',
      fixtureBacked: Boolean(item.fixtures),
      auditRecommended: item.supportStatus === 'experimental',
      lastAudit: null,
      note: item.note || null
    };
  });
}

export async function auditExperimentalCollectors() {
  const auditedAt = new Date().toISOString();
  const collectors = [];

  for (const item of COLLECTOR_REGISTRY.filter(row => row.supportStatus === 'experimental')) {
    const roots = item.roots().filter(Boolean);
    const existingRoots = roots.filter(path => existsSync(path));
    const summary = existingRoots.length
      ? await auditCollector(item, existingRoots)
      : emptyAuditSummary();
    collectors.push({
      id: item.id,
      label: item.label,
      supportStatus: item.supportStatus,
      auditRecommended: true,
      detected: existingRoots.length > 0,
      privacyLevel: item.privacyLevel,
      tokenReliability: item.tokenReliability || 'unknown',
      readsConversationContent: Boolean(item.readsConversationContent),
      auditedAt,
      summary
    });
  }

  return {
    auditedAt,
    collectors,
    totals: collectors.reduce((acc, item) => addAuditSummary(acc, item.summary), emptyAuditSummary())
  };
}

async function auditCollector(item, roots) {
  if (item.module) {
    try {
      const mod = await import(item.module);
      if (typeof mod.audit === 'function') {
        return normalizeAuditSummary(await mod.audit());
      }
    } catch {
      const summary = emptyAuditSummary();
      summary.parseErrors = 1;
      return summary;
    }
  }
  return auditStructuredUsage({ roots });
}

function normalizeAuditSummary(value = {}) {
  const summary = emptyAuditSummary();
  for (const key of Object.keys(summary)) {
    const number = Number(value[key] || 0);
    summary[key] = Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
  }
  return summary;
}

export function enabledCollectorIds({ includeExperimental = false, values = null } = {}) {
  const envValue = process.env.TOKEN_WORK_COLLECTORS;
  const configRoot = globalCollectorConfig();
  const rawValues = values != null
    ? String(values).split(',')
    : envValue ? envValue.split(',')
      : Array.isArray(configRoot.enabledCollectors) ? configRoot.enabledCollectors
      : stableCollectors().filter(item => item.defaultEnabled).map(item => item.id);

  const ids = rawValues.map(item => String(item).trim().toLowerCase()).filter(Boolean);
  const allowed = new Set(COLLECTOR_REGISTRY
    .filter(item => includeExperimental || item.supportStatus === 'stable')
    .map(item => item.id));
  return new Set(ids.filter(id => allowed.has(id)));
}

function stableCollector(id, label, module, options) {
  return {
    id,
    label,
    module,
    privacyLevel: options.privacyLevel,
    defaultEnabled: true,
    supportStatus: 'stable',
    fixtures: `test/fixtures/collectors/${id}`,
    dataFields: STABLE_FIELDS,
    readsConversationContent: false,
    tokenReliability: 'native-token-fields',
    roots: options.roots,
    note: null
  };
}

function experimentalCollector(id, label, options) {
  return {
    id,
    label,
    module: options.module || null,
    privacyLevel: options.privacyLevel,
    defaultEnabled: false,
    supportStatus: options.module ? 'experimental' : 'detected-only',
    fixtures: `test/fixtures/collectors/${id}`,
    dataFields: EXPERIMENTAL_FIELDS,
    readsConversationContent: false,
    tokenReliability: 'explicit-token-fields-only',
    roots: options.roots,
    note: options.note
  };
}

function importOnlyCollector(id, label, options) {
  return {
    id,
    label,
    module: null,
    privacyLevel: 'metadata-only',
    defaultEnabled: false,
    supportStatus: 'import-only',
    fixtures: null,
    dataFields: IMPORT_FIELDS,
    readsConversationContent: false,
    tokenReliability: 'external-json-token-fields',
    roots: options.roots,
    note: options.note
  };
}

function detectedOnlyCollector(id, label, roots) {
  return {
    id,
    label,
    module: null,
    privacyLevel: 'detected-only',
    defaultEnabled: false,
    supportStatus: 'detected-only',
    fixtures: null,
    dataFields: [],
    readsConversationContent: false,
    tokenReliability: 'unknown-no-usage-import',
    roots: () => configuredPaths(id, 'roots', roots),
    note: 'Detected-only: Token Work can show local presence, but it will not write token usage until a reliable token field is audited.'
  };
}

function globalCollectorConfig() {
  try {
    const path = join(process.cwd(), 'config', 'collectors.json');
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

function cursorRoots() {
  const appData = process.env.APPDATA;
  const localAppData = process.env.LOCALAPPDATA;
  return configuredPaths('cursor', 'roots', [
    appData ? join(appData, 'Cursor') : null,
    localAppData ? join(localAppData, 'Programs', 'Cursor') : null,
    '~/.config/Cursor',
    '~/Library/Application Support/Cursor'
  ]);
}

function copilotRoots() {
  return configuredPaths('copilot', 'roots', [
    '~/.config/github-copilot',
    '~/.copilot',
    '~/Library/Application Support/github-copilot',
    process.env.APPDATA ? join(process.env.APPDATA, 'GitHub Copilot') : null
  ]);
}

function emptyAuditSummary() {
  return {
    candidateFiles: 0,
    usableTokenRecords: 0,
    skippedNoTokenRecords: 0,
    skippedConversationLikeRecords: 0,
    skippedOversizedFiles: 0,
    parseErrors: 0
  };
}

function addAuditSummary(target, source) {
  target.candidateFiles += source.candidateFiles || 0;
  target.usableTokenRecords += source.usableTokenRecords || 0;
  target.skippedNoTokenRecords += source.skippedNoTokenRecords || 0;
  target.skippedConversationLikeRecords += source.skippedConversationLikeRecords || 0;
  target.skippedOversizedFiles += source.skippedOversizedFiles || 0;
  target.parseErrors += source.parseErrors || 0;
  return target;
}
