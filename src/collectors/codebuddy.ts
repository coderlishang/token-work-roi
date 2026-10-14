/**
 * CodeBuddy collector.
 *
 * CodeBuddy writes completion usage to the Tencent Cloud Coding Copilot
 * extension log. This collector reads only the `notifyStepEnd` usage object.
 * It never reads the request, response, workspace, or session database.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { basename, join } from 'node:path';
import { configuredPaths } from '../collector-config.ts';
import { calculateCost } from '../pricing.ts';
import { localDateFromTimestamp, normalizeModelForGrouping } from './utils.ts';

export const CLIENT_KEY = 'codebuddy';
export const SOURCE_LABEL = 'CodeBuddy';
const MAX_LOG_FILE_BYTES = 32 * 1024 * 1024;
const INCREMENTAL_MTIME_SLOP_MS = 2_000;
const EXTENSION_DIR = 'Tencent-Cloud.coding-copilot';

interface CodeBuddyCollectOptions {
  changedAfterMs?: number;
}

interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

interface CodeBuddyEvent {
  eventId: string;
  sessionId: string;
  timestamp: string;
  date: string;
  model: string;
  tokens: TokenUsage;
}

function logRoots() {
  const appData = process.env.APPDATA || '${APPDATA}';
  return configuredPaths('codebuddy', 'logsRoots', [
    '~/Library/Application Support/CodeBuddy CN/logs',
    '~/Library/Application Support/CodeBuddy/logs',
    `${appData}/CodeBuddy CN/logs`,
    `${appData}/CodeBuddy/logs`,
    '~/.config/CodeBuddy CN/logs',
    '~/.config/CodeBuddy/logs'
  ]);
}

function existingLogRoots() {
  return [...new Set(logRoots())].filter(existsSync);
}

function nonNegativeInteger(value: unknown) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function zero(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

function addInto(target: TokenUsage, tokens: TokenUsage) {
  target.input += tokens.input;
  target.output += tokens.output;
  target.cacheRead += tokens.cacheRead;
  target.cacheWrite += tokens.cacheWrite;
  target.reasoning += tokens.reasoning;
}

function totalTokens(tokens: TokenUsage) {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite + tokens.reasoning;
}

function actualModel(value: string | undefined) {
  const model = String(value || '').trim();
  return model && !/^(auto|default|inherit|unknown)$/i.test(model)
    ? normalizeModelForGrouping(model)
    : null;
}

function shortHash(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function emptyAuditSummary(candidateFiles = 0) {
  return {
    candidateFiles,
    usableTokenRecords: 0,
    skippedNoTokenRecords: 0,
    skippedUnresolvedModel: 0,
    skippedConversationLikeRecords: 0,
    skippedOversizedFiles: 0,
    parseErrors: 0
  };
}

function parseUsage(value: unknown): TokenUsage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const usage = value as Record<string, unknown>;
  const inputTokens = nonNegativeInteger(usage.inputTokens);
  const outputTokens = nonNegativeInteger(usage.outputTokens);
  const total = nonNegativeInteger(usage.totalTokens);
  const cacheRead = nonNegativeInteger(usage.cacheTokens) ?? 0;
  const cacheWrite = nonNegativeInteger(usage.cachedWriteTokens) ?? 0;
  const reasoning = nonNegativeInteger(usage.thinkingTokens) ?? 0;

  if (inputTokens == null || outputTokens == null || total == null) return null;
  if (total !== inputTokens + outputTokens) return null;
  if (cacheRead + cacheWrite > inputTokens || reasoning > outputTokens) return null;

  return {
    input: inputTokens - cacheRead - cacheWrite,
    output: outputTokens - reasoning,
    cacheRead,
    cacheWrite,
    reasoning
  };
}

function parseLogLine(line: string, fallbackFileKey: string, model: string | null, audit: ReturnType<typeof emptyAuditSummary>): CodeBuddyEvent | null {
  if (!line.includes('notifyStepEnd') || !line.includes('usage:')) return null;

  const timestamp = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})/);
  const session = line.match(/\[BaseAgent:[^\]]+\] \[([^\]]+)\]/);
  const request = line.match(/\brequestId:\s*([^,\s]+)/);
  const step = line.match(/\bstep:\s*(\d+)/);
  const usageMatch = line.match(/\busage:\s*(\{.*?\})\s*,\s*isMaxTokenLimit:/);
  if (!timestamp || !usageMatch) {
    audit.parseErrors += 1;
    return null;
  }

  let usage;
  try {
    usage = parseUsage(JSON.parse(usageMatch[1]));
  } catch {
    audit.parseErrors += 1;
    return null;
  }
  if (!usage || totalTokens(usage) === 0) {
    audit.skippedNoTokenRecords += 1;
    return null;
  }

  // CodeBuddy writes the host's local wall-clock time without an offset.
  // Let Date interpret it in the same local timezone instead of shifting it
  // to UTC before the China-date aggregation runs.
  const date = new Date(timestamp[1].replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) {
    audit.parseErrors += 1;
    return null;
  }
  const sessionKey = session?.[1] || fallbackFileKey;
  const eventKey = request?.[1] || `${fallbackFileKey}:${timestamp[1]}:${step?.[1] || ''}:${usageMatch[1]}`;
  return {
    eventId: `${CLIENT_KEY}:${shortHash(eventKey)}`,
    sessionId: `${CLIENT_KEY}:${shortHash(sessionKey)}`,
    timestamp: date.toISOString(),
    date: localDateFromTimestamp(date.toISOString()),
    model: model || 'unknown',
    tokens: usage
  };
}

async function safeReaddir(dir: string, options?: { withFileTypes?: boolean }): Promise<Dirent[]> {
  try {
    return await readdir(dir, options as { withFileTypes: true }) as Dirent[];
  } catch {
    return [];
  }
}

async function listLogFiles(root: string) {
  const files: Array<{ filePath: string; size: number; mtimeMs: number }> = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    if (!dir) continue;
    for (const entry of await safeReaddir(dir, { withFileTypes: true })) {
      const filePath = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(filePath);
      } else if (entry.isFile() && entry.name.endsWith('.log') && basename(dir) === EXTENSION_DIR) {
        try {
          const info = await stat(filePath);
          files.push({ filePath, size: info.size, mtimeMs: info.mtimeMs });
        } catch {
          // The application can rotate logs while they are being scanned.
        }
      }
    }
  }
  return files;
}

function shouldRead(file: { mtimeMs: number }, changedAfterMs?: number) {
  return !Number.isFinite(changedAfterMs) || file.mtimeMs >= Number(changedAfterMs) - INCREMENTAL_MTIME_SLOP_MS;
}

async function parseLogFile(file: { filePath: string; size: number }, audit: ReturnType<typeof emptyAuditSummary>): Promise<CodeBuddyEvent[]> {
  if (file.size > MAX_LOG_FILE_BYTES) {
    audit.skippedOversizedFiles += 1;
    return [];
  }
  let text;
  try {
    text = await readFile(file.filePath, 'utf8');
  } catch {
    audit.parseErrors += 1;
    return [];
  }
  const fallbackFileKey = shortHash(file.filePath);
  // CodeBuddy does not include a session id on model initialization lines.
  // A model may therefore prove only the next completion from that agent.
  const pendingModels = new Map<string, string | null>();
  return text.split(/\r?\n/).flatMap(line => {
    const initialized = line.match(/\[BaseAgent:([^\]]+)\].*?ModelProvider initialized, modelId:\s*([^,\s]+)/i);
    if (initialized) pendingModels.set(initialized[1], actualModel(initialized[2]));
    const agent = line.match(/\[BaseAgent:([^\]]+)\]/)?.[1];
    const isCompletion = line.includes('notifyStepEnd');
    const model = agent && isCompletion ? pendingModels.get(agent) || null : null;
    if (agent && isCompletion) pendingModels.delete(agent);
    const event = parseLogLine(line, fallbackFileKey, model, audit);
    return event ? [event] : [];
  });
}

function buildOutput(events: CodeBuddyEvent[], pricingData, audit: ReturnType<typeof emptyAuditSummary>) {
  const uniqueEvents = new Map(events.map(event => [event.eventId, event]));
  audit.usableTokenRecords = uniqueEvents.size;
  const daily = new Map();
  const sessions = new Map();

  for (const event of uniqueEvents.values()) {
    const dayKey = `${event.date}:${event.model}`;
    const day = daily.get(dayKey) || { date: event.date, model: event.model, ...zero(), cost: 0 };
    addInto(day, event.tokens);
    day.cost += calculateCost(event.model, event.tokens, pricingData, null, event.date);
    daily.set(dayKey, day);

    const sessionKey = event.sessionId;
    const session = sessions.get(sessionKey) || {
      sessionId: event.sessionId,
      model: event.model,
      lastActivity: event.timestamp,
      ...zero(),
      cost: 0
    };
    addInto(session, event.tokens);
    session.cost += calculateCost(event.model, event.tokens, pricingData, null, event.date);
    if (event.timestamp >= session.lastActivity) {
      session.lastActivity = event.timestamp;
      session.model = event.model;
    }
    sessions.set(sessionKey, session);
  }

  const contributions = [...daily.values()].map(row => ({
    date: row.date,
    clients: [{
      client: CLIENT_KEY,
      modelId: row.model,
      tokens: {
        input: row.input,
        output: row.output,
        cacheRead: row.cacheRead,
        cacheWrite: row.cacheWrite,
        reasoning: row.reasoning
      },
      cost: row.cost
    }]
  }));
  const entries = [...sessions.values()].map(row => ({
    client: CLIENT_KEY,
    workspaceKey: row.sessionId,
    workspaceLabel: 'CodeBuddy',
    sessionId: row.sessionId,
    lastActivity: row.lastActivity,
    model: row.model,
    input: row.input,
    output: row.output,
    cacheRead: row.cacheRead,
    cacheWrite: row.cacheWrite,
    reasoning: row.reasoning,
    cost: row.cost
  }));
  const tokenEvents = [...uniqueEvents.values()].map(event => ({
    eventId: event.eventId,
    source: CLIENT_KEY,
    sessionId: event.sessionId,
    timestamp: event.timestamp,
    model: normalizeModelForGrouping(event.model),
    inputTokens: event.tokens.input,
    outputTokens: event.tokens.output,
    cacheReadTokens: event.tokens.cacheRead,
    cacheCreationTokens: event.tokens.cacheWrite,
    reasoningTokens: event.tokens.reasoning,
    privacyLevel: 'safe'
  }));
  return { graphJson: { contributions }, modelsJson: { entries }, tokenEvents, audit };
}

export async function audit() {
  const files = (await Promise.all(existingLogRoots().map(listLogFiles))).flat();
  const summary = emptyAuditSummary(files.length);
  const events = (await Promise.all(files.map(file => parseLogFile(file, summary)))).flat();
  summary.usableTokenRecords = new Map(events.map(event => [event.eventId, event])).size;
  return summary;
}

export async function collect(pricingData = null, { changedAfterMs }: CodeBuddyCollectOptions = {}) {
  const files = (await Promise.all(existingLogRoots().map(listLogFiles))).flat();
  const auditSummary = emptyAuditSummary(files.length);
  const events = (await Promise.all(files.filter(file => shouldRead(file, changedAfterMs))
    .map(file => parseLogFile(file, auditSummary)))).flat();
  const result = buildOutput(events, pricingData, auditSummary);
  return {
    ...result,
    reconciliation: {
      managedEventIdPrefix: `${CLIENT_KEY}:`
    }
  };
}

export async function collectWithAudit(pricingData = null, options: CodeBuddyCollectOptions = {}) {
  return collect(pricingData, options);
}

export function roots() {
  return logRoots();
}
