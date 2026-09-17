#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { seedDemoDatabase } from './demo-seed.ts';
import { auditExperimentalCollectors, detectCollectors, liveCollectSourceNames } from './collector-registry.ts';
import { CCUSAGE_CLI_REPORTS, ccusageInvocation, runCcusageCliImportPlan } from './ccusage-bridge.ts';
import { applyCcusageImport, assertCcusageImportCanApply, ccusageImportWouldChange, parseCcusageJsonText, planCcusageImport, readCcusageImportInput } from './ccusage-import.ts';
import { createSqliteBackup, defaultDbPath, deleteBudgetProfile, listBudgetProfiles, openDb, openReadOnlyDb, upsertBudgetProfile } from './db.ts';
import { formatPrivacyCheckReport, runPrivacyCheck } from './privacy-check.ts';
import { buildTerminalReport, formatTerminalReport } from './terminal-report.ts';
import { buildEmptyStatuslineSnapshot, buildStatuslineSnapshot, formatStatuslineText } from './statusline.ts';
import { buildModelPolicy, formatModelPolicy } from './model-policy.ts';
import { resolveLaunchCwd, resolveViteBin } from './runtime-paths.ts';

type InputRecord = Record<string, unknown>;
type CliArgValue = string | boolean | string[] | undefined;

interface CliArgs {
  [key: string]: CliArgValue;
  _: string[];
  apply?: boolean;
  applySources?: string;
  apiPort?: string;
  audit?: boolean;
  ccusageBin?: string;
  collectors?: string;
  costBudgetUSD?: string;
  costBudgetUsd?: string;
  db?: string;
  device?: string;
  dryRun?: boolean;
  dryRunOnly?: boolean;
  enabled?: boolean;
  file?: string;
  format?: string;
  hardThreshold?: string;
  help?: boolean;
  id?: string;
  includeUntracked?: boolean;
  json?: boolean;
  label?: string;
  maxWidth?: string;
  modelGroup?: string;
  noCollect?: boolean;
  noOpen?: boolean;
  period?: string;
  port?: string;
  report?: string;
  resetAnchor?: string;
  seedOnly?: boolean;
  source?: string;
  sources?: string;
  threshold?: string;
  tokenBudget?: string;
  uiPort?: string;
  warningThreshold?: string;
  windowMinutes?: string;
  windowType?: string;
  writeSources?: string;
  yes?: boolean;
}

interface ImportUsageSummary {
  ok: boolean;
  format: string;
  mode: string;
  detectedShape: string;
  daily: number;
  sessions: number;
  tokenEvents: number;
  warnings: InputRecord[];
  bridge: { report: string; command: string } | null;
  backup?: { path: string } | null;
  applied?: unknown;
}

const parsedCommand = parseCommand(process.argv.slice(2));
const command = parsedCommand.command;
const args = parseArgs(parsedCommand.args);
const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SOURCE_DIR, '..');
const USER_CWD = process.cwd();
const requireFromCli = createRequire(import.meta.url);

try {
  if (command === 'auto') {
    await autoCommand();
  } else if (command === 'start') {
    await autoCommand({ defaultOpenBrowser: false });
  } else if (command === 'open') {
    await autoCommand({ defaultOpenBrowser: true });
  } else if (command === 'demo') {
    await demoCommand();
  } else if (command === 'live') {
    await autoCommand({ route: '/live', defaultOpenBrowser: false });
  } else if (command === 'statusline') {
    await statuslineCommand();
  } else if (command === 'collect') {
    await collectCommand();
  } else if (command === 'coverage') {
    await coverageCommand();
  } else if (command === 'compare-ccusage') {
    await compareCcusageCommand();
  } else if (command === 'collectors') {
    await collectorsCommand();
  } else if (command === 'import-usage') {
    await importUsageCommand();
  } else if (command === 'budget') {
    await budgetCommand();
  } else if (command === 'report') {
    await reportCommand();
  } else if (command === 'policy') {
    await policyCommand();
  } else if (command === 'doctor') {
    await doctorCommand();
  } else if (command === 'privacy-check') {
    await privacyCheckCommand();
  } else {
    printHelp();
    process.exit(command === 'help' ? 0 : 1);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

async function autoCommand({ route = '/', defaultOpenBrowser = true } = {}) {
  const dbPath = cliDbPath();
  const openBrowser = args.noOpen ? false : defaultOpenBrowser;

  if (args.noCollect) {
    console.log('[token-work] auto collect skipped (--no-collect). Starting local UI.');
    await startCommand({ demo: false, dbPath, route, openBrowser, liveCollect: false });
    return;
  }

  if (args.dryRunOnly) {
    console.log('[token-work] dry-run only; SQLite was not modified. Starting local UI.');
    await startCommand({ demo: false, dbPath, route, openBrowser, liveCollect: false });
    return;
  }

  console.log(`[token-work] Starting local UI. Trusted ${liveCollectSourceNames()} collection will run in the background.`);
  await startCommand({ demo: false, dbPath, route, openBrowser, liveCollect: true });
}

async function demoCommand() {
  const dbPath = resolve(USER_CWD, args.db || 'data/demo.sqlite');
  const result = seedDemoDatabase({
    dbPath,
    demoPath: resolve(PACKAGE_ROOT, 'docs', 'demo-data', 'token-work-demo.json')
  });
  console.log(`[demo] seeded ${result.sessions} sessions and ${result.daily} daily rows into ${result.dbPath}`);
  if (args.seedOnly) return;
  await startCommand({ demo: true, dbPath });
}

async function startCommand({ demo = false, dbPath = null, route = '/', openBrowser = false, liveCollect = false } = {}) {
  const requestedApiPort = Number(args.apiPort || args.port || await freePort(4173));
  const env = {
    ...process.env,
    PORT: String(requestedApiPort),
    API_PORT: String(requestedApiPort),
    DB_PATH: dbPath || resolve(USER_CWD, args.db || process.env.DB_PATH || 'data/usage.sqlite'),
    TOKEN_WORK_DEMO_MODE: demo ? '1' : process.env.TOKEN_WORK_DEMO_MODE || '',
    ...liveCollectEnv({ enabled: liveCollect && !demo })
  };
  const launchCwd = resolveLaunchCwd(PACKAGE_ROOT);
  const useStaticUi = hasStaticUi(launchCwd) && !args.uiPort;
  const requestedUiPort = useStaticUi ? requestedApiPort : Number(args.uiPort || await freePort(5173));
  const vitePort = requestedUiPort === 0 ? await freePort(5173) : requestedUiPort;
  const server = spawn(process.execPath, [resolve(SOURCE_DIR, 'server.ts')], {
    cwd: launchCwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true
  });
  const serverOutput = captureAndForwardChildOutput(server);
  const serverStatus = captureServerStatus(server);
  const client = useStaticUi ? null : spawn(process.execPath, [
    resolveViteBin({ packageRoot: PACKAGE_ROOT, requireLike: requireFromCli }),
    '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'
  ], {
    cwd: launchCwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  if (client) captureAndForwardChildOutput(client);
  const children = [server, client];
  const childrenDone = waitForChildren(children);
  let apiPort = requestedApiPort;
  let uiPort = useStaticUi ? requestedApiPort : vitePort;
  try {
    await Promise.race([
      waitForStartup(),
      childrenDone.then(() => {
        throw new Error('Local UI stopped before startup completed.');
      })
    ]);
    const uiUrl = `http://127.0.0.1:${uiPort}${route}`;
    console.log(`[token-work] UI  ${uiUrl}${demo ? '  (Demo Mode)' : ''}`);
    console.log(`[token-work] API http://127.0.0.1:${apiPort}`);
    if (process.send) process.send({ type: 'ready', apiPort, uiPort });
    if (liveCollect && !demo) {
      console.log(`[token-work] live collect refresh enabled every ${envLiveCollectIntervalSeconds()}s for ${liveCollectSourceNames()}.`);
    }
    if (openBrowser) {
      setTimeout(() => openUrl(uiUrl), 900).unref?.();
    }
  } catch (error) {
    await stopCliChildren(children);
    throw error;
  }
  await childrenDone;

  async function waitForStartup() {
    if (requestedApiPort === 0) {
      apiPort = await waitForServerPort(server, serverStatus, serverOutput);
      if (useStaticUi) uiPort = apiPort;
    }
    await Promise.all([
      waitForHttp(`http://127.0.0.1:${apiPort}/api/data`, { label: 'API' }),
      waitForHttp(`http://127.0.0.1:${uiPort}/`, { label: 'UI' })
    ]);
  }
}

function hasStaticUi(packageRoot) {
  return existsSync(resolve(packageRoot, 'dist-runtime', 'cli.mjs'))
    && existsSync(resolve(packageRoot, 'dist', 'index.html'));
}

function validPort(port) {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

async function stopCliChildren(children) {
  await Promise.all(children.map(child => stopCliChild(child)));
}

function stopCliChild(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise<void>(resolve => {
    const done = () => {
      clearTimeout(killTimer);
      clearTimeout(resolveTimer);
      resolve();
    };
    const killTimer = setTimeout(() => {
      if (child.exitCode == null && child.signalCode == null) killCliChild(child, 'SIGKILL');
    }, 2500);
    const resolveTimer = setTimeout(done, 5000);
    killTimer.unref?.();
    resolveTimer.unref?.();
    child.once('close', done);
    killCliChild(child, 'SIGTERM');
  });
}

function killCliChild(child, signal) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  if (process.platform === 'win32' && child.pid) {
    const result = spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true
    });
    if (result.status === 0) return;
  }
  child.kill(signal);
}

function captureServerStatus(child) {
  const status = { port: null };
  child.on('message', message => {
    if (message?.type === 'listening' && validPort(message.port)) status.port = message.port;
  });
  return status;
}

function captureAndForwardChildOutput(child) {
  const output = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    output.stdout += chunk;
    process.stdout.write(chunk);
  });
  child.stderr.on('data', chunk => {
    output.stderr += chunk;
    process.stderr.write(chunk);
  });
  child.on('error', error => {
    output.stderr += `${output.stderr ? '\n' : ''}${error.stack || error.message}`;
  });
  return output;
}

async function waitForServerPort(child, status, output, { timeoutMs = 45000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode != null) throw new Error(`API exited before reporting a port\nstdout=${output.stdout}\nstderr=${output.stderr}`);
    if (status.port) return status.port;
    const port = parseServerPort(output.stdout);
    if (port) return port;
    await sleep(50);
  }
  throw new Error(`API did not report a listening port\nstdout=${output.stdout}\nstderr=${output.stderr}`);
}

function parseServerPort(stdout) {
  const match = String(stdout || '').match(/http:\/\/[^:]+:(\d+) \(listening on /);
  const port = match ? Number(match[1]) : null;
  return validPort(port) ? port : null;
}

function liveCollectEnv({ enabled = false } = {}) {
  if (!enabled) return { SCHEDULED_COLLECT_ENABLED: '0' };
  const intervalSeconds = envLiveCollectIntervalSeconds();
  return {
    SCHEDULED_COLLECT_ENABLED: '1',
    SCHEDULED_COLLECT_RUN_ON_START: process.env.SCHEDULED_COLLECT_RUN_ON_START || '0',
    SCHEDULED_COLLECT_INTERVAL_SECONDS: String(intervalSeconds),
    TOKEN_WORK_LIVE_COLLECT_INTERVAL_SECONDS: String(intervalSeconds)
  };
}

function envLiveCollectIntervalSeconds() {
  const requested = Number(process.env.TOKEN_WORK_LIVE_COLLECT_INTERVAL_SECONDS || process.env.SCHEDULED_COLLECT_INTERVAL_SECONDS || 300);
  return Math.max(30, Number.isFinite(requested) && requested > 0 ? Math.round(requested) : 300);
}

async function collectCommand() {
  const sources = args.sources || args.collectors || 'claude,codex,workbuddy,codebuddy';
  if (args.apply && args.dryRun) {
    throw new Error('Choose either --apply or --dry-run, not both.');
  }
  if (!args.apply && !args.dryRun) {
    throw new Error('collect requires --dry-run or --apply. Use --dry-run first to audit candidate files without writing SQLite.');
  }
  if (args.apply) {
    const confirmed = args.yes || process.env.TOKEN_WORK_COLLECT_CONFIRMED === '1'
      || await confirmCollect(sources);
    if (!confirmed) {
      throw new Error('Collection cancelled. No local AI logs were scanned.');
    }
  }
  const collectArgs = [
    'src/collect.ts',
    args.apply ? '--apply' : '--dry-run',
    '--sources',
    sources
  ];
  if (args.db) collectArgs.push('--db', args.db);
  if (args.json) collectArgs.push('--json');
  if (args.apply && (args.yes || process.env.TOKEN_WORK_COLLECT_CONFIRMED === '1')) {
    collectArgs.push('--yes');
  }
  const child = spawn(process.execPath, collectArgs, {
    cwd: PACKAGE_ROOT,
    env: {
      ...process.env,
      TOKEN_WORK_COLLECTORS: sources,
      ...(args.apply ? { TOKEN_WORK_COLLECT_CONFIRMED: '1' } : {})
    },
    stdio: 'inherit',
    windowsHide: true
  });
  const code = await childExitCode(child);
  process.exitCode = code;
}

async function coverageCommand() {
  const sources = args.sources || args.collectors || 'claude,codex,workbuddy,codebuddy,cursor';
  const summary = await runCollectDryRun({ sources, dbPath: args.db });
  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  printCoverageSummary(summary);
  if (Number(inputRecord(summary.totals).fatalCoverageErrors || 0) > 0) process.exitCode = 2;
}

async function compareCcusageCommand() {
  const report = String(args.report || 'session').toLowerCase();
  const threshold = Number(args.threshold || 0.01);
  const invocation = ccusageInvocation({ report, ccusageBin: args.ccusageBin });
  await ensureCcusageBridgeConfirmed({ report, commandLabel: invocation.commandLabel });

  const [tokenStudio, bridgeResult] = await Promise.all([
    runCollectDryRun({ sources: args.sources || args.collectors || 'claude,codex', dbPath: args.db }),
    runCcusageCliImportPlan({
      report,
      ccusageBin: args.ccusageBin,
      device: args.device || hostname()
    })
  ]);
  const ccusagePlan = bridgeResult.plan;
  const comparison = buildCcusageComparison({ tokenStudio, ccusagePlan, report, threshold, command: invocation.commandLabel });
  if (args.json) {
    console.log(JSON.stringify(comparison, null, 2));
  } else {
    printCcusageComparison(comparison);
  }
  if (!comparison.ok) process.exitCode = 2;
}

async function doctorCommand() {
  const collectors = detectCollectors();
  console.log('Token Work Doctor');
  console.log(`node=${process.version}`);
  console.log(`cwd=${process.cwd()}`);
  console.log(`db=${args.db || process.env.DB_PATH || 'data/usage.sqlite'}`);
  console.log('');
  console.log('Collectors');
  for (const item of collectors) {
    console.log(`- ${item.id}: ${item.supportStatus}, detected=${item.detected ? 'yes' : 'no'}, privacy=${item.privacyLevel}`);
    if (item.existingRoots.length) console.log(`  roots=${item.existingRoots.join('; ')}`);
    if (item.note) console.log(`  note=${item.note}`);
  }
}

async function collectorsCommand() {
  if (args.audit) {
    const audit = await auditExperimentalCollectors();
    if (args.json) {
      console.log(JSON.stringify(audit, null, 2));
      return;
    }
    console.log('Token Work Collector Audit');
    console.log(`auditedAt=${audit.auditedAt}`);
    console.log(`totals: files=${audit.totals.candidateFiles}, usable=${audit.totals.usableTokenRecords}, noToken=${audit.totals.skippedNoTokenRecords}, unsafe=${audit.totals.skippedConversationLikeRecords}, oversized=${audit.totals.skippedOversizedFiles}, parseErrors=${audit.totals.parseErrors}`);
    for (const item of audit.collectors) {
      const s = item.summary;
      console.log(`- ${item.id}: detected=${item.detected ? 'yes' : 'no'}, files=${s.candidateFiles}, usable=${s.usableTokenRecords}, noToken=${s.skippedNoTokenRecords}, unsafe=${s.skippedConversationLikeRecords}, oversized=${s.skippedOversizedFiles}, parseErrors=${s.parseErrors}`);
    }
    return;
  }

  const collectors = detectCollectors();
  if (args.json) {
    console.log(JSON.stringify({ collectors }, null, 2));
    return;
  }

  console.log('Token Work Collectors');
  for (const item of collectors) {
    console.log(`- ${item.id}: ${item.label}`);
    console.log(`  status=${item.supportStatus}, default=${item.defaultEnabled ? 'yes' : 'no'}, detected=${item.detected ? 'yes' : 'no'}`);
    console.log(`  privacy=${item.privacyLevel}, readsConversationContent=${item.readsConversationContent ? 'yes' : 'no'}, tokenReliability=${item.tokenReliability}`);
    console.log(`  fields=${item.dataFields.join(',') || 'none'}`);
    if (item.note) console.log(`  note=${item.note}`);
  }
}

async function importUsageCommand() {
  if (args.help) {
    printImportUsageHelp();
    return;
  }
  const format = args.format || 'ccusage-json';
  if (args.apply && args.dryRun) {
    throw new Error('Choose either --apply or --dry-run, not both.');
  }
  const { plan, bridge } = await buildImportUsagePlan(format);
  await confirmImportApplyIfNeeded(plan);
  const summary: ImportUsageSummary = {
    ok: true,
    format,
    mode: args.apply ? 'apply' : 'dry-run',
    detectedShape: plan.detectedShape,
    daily: plan.daily.length,
    sessions: plan.sessions.length,
    tokenEvents: plan.tokenEvents.length,
    warnings: plan.warnings,
    bridge: bridge || null
  };

  if (args.apply) {
    const dbPath = cliDbPath();
    const db = openDb(dbPath);
    try {
      assertCcusageImportCanApply(db, plan);
      summary.backup = ccusageImportWouldChange(db, plan)
        ? createSqliteBackup(db, dbPath, { reason: format === 'ccusage-cli' ? 'ccusage-cli-import' : 'ccusage-json-import' })
        : null;
      summary.applied = applyCcusageImport(db, plan);
    } finally {
      db.close();
    }
  }

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  const source = bridge ? `ccusage CLI ${bridge.report}` : 'ccusage JSON';
  console.log(`${source} ${summary.mode}: shape=${summary.detectedShape}, daily=${summary.daily}, sessions=${summary.sessions}, token_events=${summary.tokenEvents}`);
  if (summary.backup) console.log(`backup=${summary.backup.path}`);
  for (const warning of summary.warnings.slice(0, 5)) {
    console.log(`warning: ${warning.model || 'unknown'} — ${warning.reason}`);
  }
}

async function buildImportUsagePlan(format) {
  if (format === 'ccusage-json') {
    if (!args.file) {
      throw new Error('import-usage requires --file <path|-> for --format=ccusage-json.');
    }
    const payload = parseCcusageJsonText(readCcusageImportInput(args.file));
    return {
      plan: planCcusageImport(payload, {
        device: args.device || hostname()
      }),
      bridge: null
    };
  }

  if (format === 'ccusage-cli') {
    const report = String(args.report || 'session').toLowerCase();
    const invocation = ccusageInvocation({ report, ccusageBin: args.ccusageBin });
    await ensureCcusageBridgeConfirmed({ report, commandLabel: invocation.commandLabel });
    const { plan } = await runCcusageCliImportPlan({
      report,
      ccusageBin: args.ccusageBin,
      device: args.device || hostname()
    });
    return {
      plan,
      bridge: {
        report,
        command: invocation.commandLabel
      }
    };
  }

  throw new Error('import-usage supports --format=ccusage-json or --format=ccusage-cli.');
}

async function ensureCcusageBridgeConfirmed({ report, commandLabel }) {
  if (args.yes || process.env.TOKEN_WORK_CCUSAGE_BRIDGE_CONFIRMED === '1') return;
  if (!process.stdin.isTTY) {
    throw new Error('ccusage CLI bridge requires --yes in non-interactive shells because it runs an external local scanner.');
  }
  const confirmed = await confirmCcusageBridge({ report, commandLabel });
  if (!confirmed) {
    throw new Error('ccusage CLI bridge cancelled. No external scanner was run.');
  }
}

async function confirmImportApplyIfNeeded(plan) {
  if (!args.apply || args.yes || process.env.TOKEN_WORK_IMPORT_CONFIRMED === '1') return;
  if (!process.stdin.isTTY) {
    throw new Error('import-usage --apply requires --yes in non-interactive shells. SQLite was not modified.');
  }
  const rl = createInterface({ input, output });
  try {
    console.log('This will write validated structured usage to local SQLite after creating a backup.');
    console.log(`Device: ${plan.device}; daily=${plan.daily.length}, sessions=${plan.sessions.length}, token_events=${plan.tokenEvents.length}`);
    const answer = await rl.question('Type APPLY to continue: ');
    if (answer.trim() !== 'APPLY') {
      throw new Error('Import cancelled. SQLite was not modified.');
    }
  } finally {
    rl.close();
  }
}

async function budgetCommand() {
  if (args.help) {
    printBudgetHelp();
    return;
  }
  const action = args._[0] || 'list';
  const db = openCliDb();
  try {
    if (action === 'list') {
      const profiles = listBudgetProfiles(db);
      if (args.json) {
        console.log(JSON.stringify({ profiles }, null, 2));
        return;
      }
      console.log('Token Work Budget Profiles');
      if (!profiles.length) {
        console.log('- none');
        return;
      }
      for (const profile of profiles) {
        console.log(`- #${profile.id} ${profile.label}: source=${profile.source || '*'}, modelGroup=${profile.modelGroup || '*'}, window=${profile.windowType || 'rolling'}:${profile.windowMinutes}m, reset=${profile.resetAnchor || '-'}, warn=${Math.round(Number(profile.warningThreshold || 0.75) * 100)}%, hard=${Math.round(Number(profile.hardThreshold || 1) * 100)}%, tokenBudget=${profile.tokenBudget || '-'}, costBudgetUSD=${profile.costBudgetUSD || '-'}, enabled=${profile.enabled ? 'yes' : 'no'}`);
      }
      return;
    }
    if (action === 'set') {
      const profile = upsertBudgetProfile(db, {
        id: args.id,
        source: args.source || '',
        modelGroup: args.modelGroup || '',
        label: args.label,
        windowType: args.windowType || 'rolling',
        windowMinutes: args.windowMinutes,
        resetAnchor: args.resetAnchor || null,
        warningThreshold: args.warningThreshold ?? 0.75,
        hardThreshold: args.hardThreshold ?? 1,
        tokenBudget: args.tokenBudget || 0,
        costBudgetUSD: args.costBudgetUsd ?? args.costBudgetUSD ?? 0,
        enabled: args.enabled ?? true
      });
      console.log(args.json ? JSON.stringify({ ok: true, profile }, null, 2) : `saved budget #${profile.id}: ${profile.label}`);
      return;
    }
    if (action === 'delete') {
      const deleted = deleteBudgetProfile(db, { id: args.id });
      console.log(args.json ? JSON.stringify({ ok: true, deleted }, null, 2) : `deleted=${deleted}`);
      return;
    }
    throw new Error('Unknown budget command. Use budget list, budget set, or budget delete.');
  } finally {
    db.close();
  }
}

async function reportCommand() {
  const format = args.format || 'table';
  if (!['table', 'markdown', 'json'].includes(format)) {
    throw new Error('report --format must be table, markdown, or json.');
  }
  const db = openCliDb();
  try {
    const report = buildTerminalReport(db, { period: args.period || 'week' });
    console.log(formatTerminalReport(report, format));
  } finally {
    db.close();
  }
}

async function statuslineCommand() {
  if (args.help) {
    printStatuslineHelp();
    return;
  }
  const format = args.format || 'text';
  if (!['text', 'json'].includes(format)) {
    throw new Error('statusline --format must be text or json.');
  }
  const windowMinutes = Number(args.windowMinutes || 15);
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) {
    throw new Error('statusline --window-minutes must be a positive number.');
  }
  const snapshotOptions = {
    windowMinutes,
    source: args.source || 'all'
  };
  let db;
  let snapshot;
  try {
    db = openCliReadOnlyDb();
    snapshot = buildStatuslineSnapshot(db, snapshotOptions);
  } catch (error) {
    if (!/SQLite database not found/i.test(error.message)) throw error;
    snapshot = buildEmptyStatuslineSnapshot({
      ...snapshotOptions,
      warning: 'Local SQLite database not found.'
    });
  } finally {
    db?.close();
  }
  if (format === 'json') {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }
  console.log(formatStatuslineText(snapshot, {
    maxWidth: Number(args.maxWidth || 100)
  }));
}

async function privacyCheckCommand() {
  const result = runPrivacyCheck({ includeUntracked: Boolean(args.includeUntracked) });
  console.log(formatPrivacyCheckReport(result));
  if (!result.ok) process.exitCode = 2;
}

async function policyCommand() {
  const format = args.format || 'markdown';
  if (!['markdown', 'claude-md', 'agents-md'].includes(format)) {
    throw new Error('policy --format must be markdown, claude-md, or agents-md.');
  }
  let db;
  let sessions = [];
  try {
    db = openCliReadOnlyDb();
    sessions = loadPolicySessions(db);
  } catch (error) {
    if (!/SQLite database not found/i.test(error.message)) throw error;
  } finally {
    db?.close();
  }
  const policy = buildModelPolicy({ sessions });
  console.log(formatModelPolicy(policy, format));
}

async function confirmCollect(sources) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input, output });
  try {
    console.log('This will scan local AI coding logs for structured token usage and write SQLite.');
    console.log(`Sources: ${sources}`);
    console.log('It will not read or display conversation content, but it may access local metadata directories.');
    const answer = await rl.question('Type COLLECT to continue: ');
    return answer.trim() === 'COLLECT';
  } finally {
    rl.close();
  }
}

async function confirmCcusageBridge({ report, commandLabel }) {
  const rl = createInterface({ input, output });
  try {
    console.log('This will run ccusage as an external local scanner and pass structured JSON to Token Work.');
    console.log(`Report: ${report}`);
    console.log(`Command: ${commandLabel}`);
    console.log('Token Work rejects conversation-like fields and recomputes cost with its official-price table.');
    const answer = await rl.question('Type CCUSAGE to continue: ');
    return answer.trim() === 'CCUSAGE';
  } finally {
    rl.close();
  }
}

async function freePort(start) {
  for (let port = Number(start); port < Number(start) + 80; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error(`No free port found near ${start}`);
}

function openCliDb() {
  return openDb(cliDbPath());
}

function openCliReadOnlyDb() {
  return openReadOnlyDb(cliDbPath());
}

function cliDbPath() {
  return resolve(USER_CWD, args.db || process.env.DB_PATH || defaultDbPath);
}

function canListen(port) {
  return new Promise<boolean>(resolvePort => {
    const server = createServer();
    server.once('error', () => resolvePort(false));
    server.once('listening', () => server.close(() => resolvePort(true)));
    server.listen(port, '127.0.0.1');
  });
}

function waitForChildren(children) {
  const activeChildren = children.filter(Boolean);
  return new Promise<number>(resolveRun => {
    let done = false;
    const stop = async (code = 0) => {
      if (done) return;
      done = true;
      await stopCliChildren(activeChildren);
      resolveRun(code);
    };
    for (const child of activeChildren) {
      child.on('exit', code => { void stop(code ?? 0); });
      child.on('error', error => {
        console.error(error.message);
        void stop(1);
      });
    }
    process.once('SIGINT', () => { void stop(0); });
    process.once('SIGTERM', () => { void stop(0); });
    if (process.platform !== 'win32') {
      process.once('SIGHUP', () => { void stop(0); });
    }
  });
}

async function waitForHttp(url, { label = 'service', timeoutMs = 45000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (response.status < 500) return true;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      clearTimeout(timer);
      lastError = error.message;
    }
    await sleep(intervalMs);
  }
  throw new Error(`${label} did not become ready at ${url}${lastError ? ` (${lastError})` : ''}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function childExitCode(child) {
  return new Promise<number>(resolveRun => {
    let settled = false;
    const finish = code => {
      if (settled) return;
      settled = true;
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      stopCliChild(child).finally(() => resolveRun(code));
    };
    const stop = () => finish(130);
    child.once('exit', code => finish(code ?? 0));
    child.once('error', () => finish(1));
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

function runCollectDryRun({ sources, dbPath }: { sources?: string; dbPath?: string } = {}): Promise<InputRecord> {
  const collectArgs = [
    resolve(SOURCE_DIR, 'collect.ts'),
    '--dry-run',
    '--sources',
    sources || 'claude,codex,workbuddy,codebuddy,cursor',
    '--json'
  ];
  if (dbPath) collectArgs.push('--db', dbPath);
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, collectArgs, {
      cwd: PACKAGE_ROOT,
      env: {
        ...process.env,
        TOKEN_WORK_COLLECTORS: sources || 'claude,codex,workbuddy,codebuddy,cursor'
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => rejectRun(error));
    child.on('close', code => {
      if (code !== 0) {
        rejectRun(new Error((stderr || stdout || `coverage dry-run failed with exit code ${code}`).trim()));
        return;
      }
      try {
        resolveRun(inputRecord(JSON.parse(stdout)));
      } catch (error) {
        rejectRun(new Error(`coverage dry-run returned invalid JSON: ${error.message}`));
      }
    });
  });
}

function printCoverageSummary(summary) {
  console.log(`Token Work Coverage Gate (${summary.mode})`);
  console.log(`sources=${summary.enabledCollectors?.join(',') || 'none'}`);
  console.log(`range=${summary.totals?.firstTimestamp || '-'}..${summary.totals?.lastTimestamp || '-'}`);
  console.log(`totals: files=${summary.totals?.candidateFiles || 0}, usable=${summary.totals?.usableTokenRecords || 0}, sessions=${summary.totals?.sessionRows || 0}, events=${summary.totals?.tokenEvents || 0}, tokens=${summary.totals?.eventTotalTokens || 0}`);
  for (const source of summary.sources || []) {
    console.log(`- ${source.id}: ${source.coverageRisk} | files=${source.candidateFiles}, usable=${source.usableTokenRecords}, sessions=${source.sessionRows}, events=${source.tokenEvents}, tokens=${source.eventTotalTokens}`);
    if (source.firstTimestamp || source.lastTimestamp) console.log(`  range=${source.firstTimestamp || '-'}..${source.lastTimestamp || '-'}`);
    if (source.coverageStatus) console.log(`  ${source.coverageStatus}`);
  }
}

function buildCcusageComparison({ tokenStudio, ccusagePlan, report, threshold, command }) {
  const tokenStudioTokens = Number(tokenStudio.totals?.eventTotalTokens || tokenStudio.totals?.sessionTotalTokens || tokenStudio.totals?.dailyTotalTokens || 0);
  const ccusageTokens = sumUsageRows(ccusagePlan.tokenEvents || ccusagePlan.sessions || ccusagePlan.daily || []);
  const diffPct = diffPctNumber(tokenStudioTokens, ccusageTokens);
  const sources = [...new Set((tokenStudio.sources || []).map(source => source.id))];
  return {
    ok: diffPct <= threshold,
    report,
    threshold,
    command,
    tokenStudio: {
      sources,
      dailyRows: tokenStudio.totals?.dailyRows || 0,
      sessionRows: tokenStudio.totals?.sessionRows || 0,
      tokenEvents: tokenStudio.totals?.tokenEvents || 0,
      totalTokens: tokenStudioTokens,
      coverageRisks: (tokenStudio.sources || []).map(source => ({
        id: source.id,
        risk: source.coverageRisk,
        status: source.coverageStatus
      }))
    },
    ccusage: {
      detectedShape: ccusagePlan.detectedShape,
      dailyRows: ccusagePlan.daily.length,
      sessionRows: ccusagePlan.sessions.length,
      tokenEvents: ccusagePlan.tokenEvents.length,
      totalTokens: ccusageTokens,
      warnings: ccusagePlan.warnings
    },
    diff: {
      tokenDelta: tokenStudioTokens - ccusageTokens,
      diffPct
    },
    note: 'Only token structure is compared. Token Work ignores ccusage cost fields and recomputes official-price cost separately.'
  };
}

function printCcusageComparison(comparison) {
  console.log(`Token Work vs ccusage (${comparison.report})`);
  console.log(`ok=${comparison.ok ? 'yes' : 'no'} threshold=${Math.round(comparison.threshold * 10000) / 100}%`);
  console.log(`token-work tokens=${comparison.tokenStudio.totalTokens} events=${comparison.tokenStudio.tokenEvents} sessions=${comparison.tokenStudio.sessionRows}`);
  console.log(`ccusage tokens=${comparison.ccusage.totalTokens} events=${comparison.ccusage.tokenEvents} sessions=${comparison.ccusage.sessionRows}`);
  console.log(`diff=${comparison.diff.tokenDelta} (${Math.round(comparison.diff.diffPct * 10000) / 100}%)`);
  if (!comparison.ok) {
    console.log('coverage gate failed: token totals differ beyond threshold');
  }
}

function sumUsageRows(rows) {
  return rows.reduce((sum, row) => sum
    + positiveNumber(row.totalTokens ?? row.total_tokens)
    + (row.totalTokens || row.total_tokens ? 0 : positiveNumber(row.inputTokens ?? row.input_tokens))
    + (row.totalTokens || row.total_tokens ? 0 : positiveNumber(row.outputTokens ?? row.output_tokens))
    + (row.totalTokens || row.total_tokens ? 0 : positiveNumber(row.cacheReadTokens ?? row.cache_read_tokens))
    + (row.totalTokens || row.total_tokens ? 0 : positiveNumber(row.cacheCreationTokens ?? row.cache_creation_tokens))
    + (row.totalTokens || row.total_tokens ? 0 : positiveNumber(row.reasoningTokens ?? row.reasoning_tokens ?? row.reasoningOutputTokens ?? row.reasoning_output_tokens)), 0);
}

function positiveNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function diffPctNumber(left, right) {
  const max = Math.max(Number(left || 0), Number(right || 0), 1);
  return Math.abs(Number(left || 0) - Number(right || 0)) / max;
}

function openUrl(url) {
  let launcher;
  let launcherArgs;
  if (process.platform === 'win32') {
    launcher = 'cmd';
    launcherArgs = ['/c', 'start', '""', url];
  } else if (process.platform === 'darwin') {
    launcher = 'open';
    launcherArgs = [url];
  } else {
    launcher = 'xdg-open';
    launcherArgs = [url];
  }
  const child = spawn(launcher, launcherArgs, {
    stdio: 'ignore',
    detached: true,
    windowsHide: true
  });
  child.unref();
}

function parseCommand(argv) {
  const commands = new Set([
    'auto',
    'start',
    'open',
    'demo',
    'live',
    'statusline',
    'collect',
    'coverage',
    'compare-ccusage',
    'collectors',
    'import-usage',
    'budget',
    'report',
    'policy',
    'doctor',
    'privacy-check'
  ]);
  const first = argv[0];
  if (!first) return { command: 'auto', args: [] };
  if (first === 'help' || first === '--help' || first === '-h') return { command: 'help', args: argv.slice(1) };
  if (!first.startsWith('-') && commands.has(first)) return { command: first, args: argv.slice(1) };
  if (!first.startsWith('-')) return { command: first, args: argv.slice(1) };
  return { command: 'auto', args: argv };
}

function parseArgs(argv) {
  const booleanKeys = new Set([
    'apply',
    'audit',
    'dryRun',
    'dryRunOnly',
    'enabled',
    'help',
    'includeUntracked',
    'json',
    'noCollect',
    'noOpen',
    'seedOnly',
    'yes'
  ]);
  const valueKeys = new Set([
    'apiPort', 'applySources', 'ccusageBin', 'collectors', 'costBudgetUSD',
    'costBudgetUsd', 'db', 'device', 'file', 'format', 'hardThreshold', 'id',
    'label', 'maxWidth', 'modelGroup', 'period', 'port', 'report', 'resetAnchor',
    'source', 'sources', 'threshold', 'tokenBudget', 'uiPort', 'warningThreshold',
    'windowMinutes', 'windowType', 'writeSources'
  ]);
  const knownKeys = new Set([...booleanKeys, ...valueKeys]);
  const parsed: CliArgs = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--') && arg.includes('=')) {
      const [key, value] = arg.slice(2).split(/=(.*)/s);
      const camelKey = toCamel(key);
      if (!knownKeys.has(camelKey)) throw new Error(`Unknown option: --${key}`);
      parsed[camelKey] = parseArgValue(camelKey, value, booleanKeys);
    } else if (arg.startsWith('--')) {
      const key = toCamel(arg.slice(2));
      if (!knownKeys.has(key)) throw new Error(`Unknown option: ${arg}`);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        if (valueKeys.has(key)) throw new Error(`${arg} requires a value`);
        parsed[key] = true;
      } else {
        parsed[key] = parseArgValue(key, next, booleanKeys);
        i += 1;
      }
    } else {
      parsed._.push(arg);
    }
  }
  return parsed;
}

function parseArgValue(key, value, booleanKeys) {
  if (!booleanKeys.has(key)) return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`--${key.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`)} must be true or false`);
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function inputRecord(value: unknown): InputRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as InputRecord
    : {};
}

function printHelp() {
  console.log([
    'Token Work ROI',
    '',
    'Commands:',
    '  token-work [--db data/usage.sqlite] [--no-collect|--dry-run-only]',
    `    Default real entry: UI starts first; trusted ${liveCollectSourceNames()} collection runs in the background every 300s.`,
    '  token-work demo [--seed-only] [--db data/demo.sqlite]',
    '  token-work start [--db data/usage.sqlite] [--api-port 4173|0] [--ui-port 5173|0] [--no-collect|--dry-run-only]',
    '  token-work open [--db data/usage.sqlite] [--api-port 4173|0] [--ui-port 5173|0] [--no-collect|--dry-run-only]',
    '    Use port 0 to let the OS assign a free local port.',
    '  token-work live [--db data/usage.sqlite] [--no-collect|--dry-run-only]',
    '  token-work statusline [--db data/usage.sqlite] [--window-minutes 15] [--format text|json]',
    '  token-work collectors [--json]',
    '  token-work collectors --audit [--json]',
    '  token-work coverage --sources claude,codex,workbuddy,codebuddy,cursor [--json]',
    '  token-work compare-ccusage --report=session --json --yes',
    '  token-work import-usage --format=ccusage-json --file <path|-> [--device <name>] [--dry-run|--apply] [--yes]',
    '  token-work import-usage --format=ccusage-cli --report=<daily|weekly|monthly|session|blocks> [--dry-run|--apply] [--yes]',
    '  token-work budget list|set|delete',
    '  token-work report --period=week --format=table|markdown|json',
    '  token-work policy --format=markdown|claude-md|agents-md',
    '  token-work collect --dry-run --sources claude,codex,workbuddy,codebuddy,cursor',
    '  token-work collect --apply --yes --sources claude,codex,workbuddy,codebuddy',
    '  token-work doctor',
    '  token-work privacy-check [--include-untracked]'
  ].join('\n'));
}

function printBudgetHelp() {
  console.log([
    'Token Work Budget Profiles',
    '',
    'Budgets are local custom guardrails. They are not provider subscription quotas.',
    '',
    'Examples:',
    '  token-work budget list',
    '  token-work budget set --source "Codex" --label "Codex 15m" --window-minutes 15 --token-budget 50000',
    '  token-work budget set --model-group heavy --label "Heavy model daily cap" --window-minutes 1440 --token-budget 200000 --hard-threshold 1',
    '  token-work budget set --source "Claude Code" --label "Claude 5h" --window-type fixed --window-minutes 300 --reset-anchor 2026-06-17T09:00:00Z --warning-threshold 0.75 --token-budget 500000',
    '  token-work budget delete --id 1',
    '',
    'Options:',
    '  --window-type rolling|fixed',
    '  --model-group all|heavy|mid|light|priced|unpriced',
    '  --reset-anchor <ISO datetime>    fixed windows only',
    '  --warning-threshold <0-1>        default 0.75',
    '  --hard-threshold <0.5-2>         exceeded threshold, default 1'
  ].join('\n'));
}

function printStatuslineHelp() {
  console.log([
    'Token Work Statusline Guardrails',
    '',
    'Read-only SQLite statusline for terminal prompts, tmux, scripts, or Claude Code statusline.',
    '',
    'Examples:',
    '  token-work statusline --format=text --window-minutes=15 --max-width=100',
    '  token-work statusline --format=json --window-minutes=15',
    '',
    'Claude Code statusline command:',
    '  npx token-work statusline --format=text --window-minutes=15 --max-width=100',
    '',
    'tmux:',
    '  set -g status-right "#(npx token-work statusline --format=text --max-width=80)"',
    '',
    'PowerShell prompt:',
    '  function prompt { "$(npx token-work statusline --format=text --max-width=80) PS $($PWD)> " }',
    '',
    'Privacy:',
    '  statusline only reads local SQLite. It does not scan logs, run ccusage, or start a background process.'
  ].join('\n'));
}

function printImportUsageHelp() {
  console.log([
    'Token Work ccusage Import',
    '',
    'Default mode is dry-run. It validates shape and counts rows without writing SQLite.',
    '',
    'Examples:',
    '  token-work import-usage --format=ccusage-json --file ccusage.json --dry-run',
    '  token-work import-usage --format=ccusage-json --file ccusage.json --device other-computer --apply --yes',
    '  ccusage daily --json | token-work import-usage --format=ccusage-json --file - --dry-run',
    '  token-work import-usage --format=ccusage-cli --report=session --dry-run --yes',
    '  token-work import-usage --format=ccusage-cli --report=blocks --apply --yes',
    '  token-work import-usage --format=ccusage-cli --report=daily --ccusage-bin ccusage --dry-run',
    '',
    'Supported shapes:',
    '  daily, project daily, weekly, session, blocks, monthly',
    '',
    'ccusage CLI bridge reports:',
    `  ${CCUSAGE_CLI_REPORTS.join(', ')}`,
    '',
    'Privacy:',
    '  prompt, response, messages, transcript, diff, content, and text fields are rejected.',
    '  ccusage-cli runs an external local scanner only after interactive confirmation or --yes.',
    '  Imported cost fields are ignored; Token Work recomputes official-price conversion.',
    '  Use a stable, unique --device name when importing usage from another computer.'
  ].join('\n'));
}

function loadPolicySessions(db) {
  return db.prepare(`
    SELECT
      COALESCE(a.work_purpose, '未说明') AS workPurpose,
      COALESCE(a.work_stage, '未说明') AS workStage,
      COALESCE(a.value_level, '未评估') AS valueLevel,
      COALESCE(a.output_status, '未标注') AS outputStatus,
      s.total_tokens AS totalTokens,
      s.cost_usd AS costUSD
    FROM session_usage s
    LEFT JOIN session_annotations a
      ON a.device = s.device
      AND a.source = s.source
      AND a.session_id = s.session_id
    ORDER BY s.total_tokens DESC
  `).all();
}
