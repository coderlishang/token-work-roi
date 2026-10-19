/**
 * DoubaoWork data collector.
 *
 * DoubaoWork (豆包工作) writes one `context_window_usage` snapshot per chat
 * request into its chat IndexedDB (a LevelDB directory):
 * {system_prompt, messages, skills, tools, total_window_size}; the four
 * components sum up to that request's input tokens. Only the input side
 * exists locally, so output tokens stay zero; the local item key is mapped
 * to the real model name (doubao-seed-2.1-lite) via modelAliases.
 *
 * Records are V8 structured-clone binaries: field names are ASCII but the
 * key/value separators are binary bytes, so the scan matches bare field
 * names instead of parsing JSON documents. The leveldb container itself is
 * decoded properly (.ldb table blocks are snappy-compressed, .log records
 * are 32 KiB framed) so values are scanned contiguously; unreadable
 * containers fall back to the legacy whole-file scan. The app prunes old
 * message records quickly; events are keyed by reply_unique_key so
 * re-imports stay idempotent and history accumulates in token_events.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { configuredPaths } from '../collector-config.ts';
import { calculateCost } from '../pricing.ts';
import { localDateFromTimestamp, normalizeModelForGrouping } from './utils.ts';

export const CLIENT_KEY = 'doubaowork';
export const SOURCE_LABEL = 'DoubaoWork';
// 取不到 model_item_key 时按此模型归属(用户确认该来源一直只用它),换模型时同步修改。
export const DOUBAOWORK_MODEL = 'doubao-seed-2.1-lite';

const USAGE_FIELD = 'context_window_usage';
const CONTEXT_FIELDS = ['system_prompt', 'messages', 'skills', 'tools'];
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const REPLY_LOOKBACK_BYTES = 12_000;
// model_item_key 实测在锚点前后 4-30KB 处(配置块内),窗口按最远观测值留余量。
const FIELD_WINDOW_BYTES = 33_000;

// 消息记录滚动清理后源里只剩最近快照:只声明事件 id 前缀、不开 reconcileIncrementally,
// 让 collect.ts 从 token_events 重建聚合,且永不删除已从源里消失的历史事件。
function reconciliation() {
  return { managedEventIdPrefix: `${CLIENT_KEY}:` };
}

export function roots() {
  return configuredPaths('doubaowork', 'roots', [
    '~/Library/Application Support/DoubaoWork/Default/IndexedDB/chrome_doubaowork-chat_0.indexeddb.leveldb',
    '${APPDATA}/DoubaoWork/Default/IndexedDB/chrome_doubaowork-chat_0.indexeddb.leveldb'
  ]);
}

export async function collect(pricingData = null) {
  const result = await readLevelDbUsage(roots());
  return { ...buildOutput(result.events, pricingData, result.audit), reconciliation: reconciliation() };
}

export async function collectWithAudit(pricingData = null) {
  const result = await readLevelDbUsage(roots());
  return { ...buildOutput(result.events, pricingData, result.audit), reconciliation: reconciliation(), audit: result.audit };
}

export async function audit() {
  return (await readLevelDbUsage(roots())).audit;
}

export async function collectFromRoots(rootPaths, pricingData = null) {
  const result = await readLevelDbUsage(rootPaths);
  return { ...buildOutput(result.events, pricingData, result.audit), reconciliation: reconciliation(), audit: result.audit };
}

async function readLevelDbUsage(rootPaths) {
  const files = await listLevelDbFiles(rootPaths);
  const audit = emptyAuditSummary(files.length);
  const eventsByReply = new Map();
  for (const file of files) {
    for (const hit of await parseLevelDbFile(file, audit)) {
      // 同一回复会被反复重写(原始与转义副本并存),后出现的快照覆盖先出现的;
      // 但最新副本可能丢掉模型元数据,此时沿用先前副本取到的完整值。
      const previous = eventsByReply.get(hit.replyKey);
      if (previous && isFallbackModel(hit.event.model) && !isFallbackModel(previous.model)) {
        hit.event.model = previous.model;
      }
      eventsByReply.set(hit.replyKey, hit.event);
    }
  }
  const events = [...eventsByReply.values()];
  // 副本复用后仍取不到模型的记录按来源模型归属,不落 unknown。
  for (const event of events) {
    if (isFallbackModel(event.model)) event.model = DOUBAOWORK_MODEL;
  }
  audit.usableTokenRecords = events.length;
  return { events, audit };
}

async function listLevelDbFiles(rootPaths) {
  const files = [];
  for (const root of rootPaths.filter(Boolean)) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const match = entry.isFile() ? entry.name.match(/^(\d+)\.(ldb|log)$/) : null;
      if (match) files.push({ filePath: join(root, entry.name), seq: Number(match[1]) });
    }
  }
  // 文件号单调递增;同一回复的各副本用量一致,顺序只决定同键覆盖方向。
  return files.sort((a, b) => a.seq - b.seq);
}

async function parseLevelDbFile(file, audit) {
  let info;
  try {
    info = await stat(file.filePath);
  } catch {
    audit.parseErrors += 1;
    return [];
  }
  if (info.size > MAX_FILE_BYTES) {
    audit.skippedOversizedFiles += 1;
    return [];
  }
  let text;
  try {
    text = decodeLevelDbFile(await readFile(file.filePath), file.filePath.endsWith('.ldb'));
  } catch {
    audit.parseErrors += 1;
    return [];
  }
  const hits = [];
  let index = text.indexOf(USAGE_FIELD);
  while (index !== -1) {
    const hit = parseUsageHit(text, index, info.mtimeMs, audit);
    if (hit) hits.push(hit);
    index = text.indexOf(USAGE_FIELD, index + USAGE_FIELD.length);
  }
  return hits;
}

function parseUsageHit(text, index, mtimeMs, audit) {
  const usageText = text.slice(index, index + 200).match(/\{[^{}]*\}/)?.[0];
  if (!usageText) {
    audit.skippedNoTokenRecords += 1;
    return null;
  }
  let usage;
  try {
    // 记录副本里 usage 可能以转义字符串形态出现,先统一引号再解析。
    usage = JSON.parse(usageText.replace(/\\"/g, '"'));
  } catch {
    audit.parseErrors += 1;
    return null;
  }
  const input = CONTEXT_FIELDS.reduce((sum, field) => sum + positiveInt(usage?.[field]), 0);
  if (!input) {
    audit.skippedNoTokenRecords += 1;
    return null;
  }

  const backStart = Math.max(0, index - REPLY_LOOKBACK_BYTES);
  const back = text.slice(backStart, index);
  // 记录重写会残留多份旧键,取离 usage 最近的 reply_unique_key 作为锚点。
  let replyKey = null;
  let replyIndex = -1;
  for (const match of back.matchAll(/reply_unique_key[^0-9a-f]{0,4}([0-9a-f-]{36,40})/g)) {
    replyKey = match[1];
    replyIndex = match.index;
  }
  if (!replyKey) {
    audit.skippedNoTokenRecords += 1;
    return null;
  }

  const anchor = backStart + replyIndex;
  const winStart = Math.max(0, anchor - FIELD_WINDOW_BYTES);
  const win = text.slice(winStart, anchor + FIELD_WINDOW_BYTES);
  const anchorInWin = anchor - winStart;
  // 相邻记录会落入窗口,各字段取离锚点最近的匹配。
  const chatId = nearestMatch(win, anchorInWin, /chat_id[^0-9]{0,4}(\d{10,25})/g)?.[1] || null;
  // 裸形态分隔是 `":` + 长度前缀控制字节(如 \fseed-lite-7b / \x019),转义形态是 `\":\"`。
  // 字段名有 snake_case(model_item_key)与 camelCase(modelItemKey)两种形态。
  const modelKey = nearestMatch(win, anchorInWin, /model_?[Ii]tem_?[Kk]ey[\s\\":\x00-\x1f]+([^\s\\",}]+)/g)?.[1] || null;
  // model_id 是请求级枚举(实测恒为 38),不是模型标识,不能拿它拼模型名。
  const model = normalizeModelForGrouping(modelKey || '');

  return {
    replyKey,
    event: {
      eventId: `${CLIENT_KEY}:reply:${createHash('sha256').update(replyKey).digest('hex').slice(0, 32)}`,
      sessionId: chatId || `unknown-${replyKey.slice(0, 8)}`,
      timestamp: timestampFromWindow(win, anchorInWin) || new Date(mtimeMs).toISOString(),
      model,
      tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
    }
  };
}

// section_tag_1h 值形如 <chat序号>_YYYYMMDDHH[mm](本地时间),取离锚点最近的合法值。
function timestampFromWindow(win, anchorInWin) {
  const tags = [...win.matchAll(/_(\d{10,14})/g)]
    .map(match => ({ digits: match[1], distance: Math.abs(match.index - anchorInWin) }))
    .sort((a, b) => a.distance - b.distance);
  for (const { digits } of tags) {
    const year = Number(digits.slice(0, 4));
    const month = Number(digits.slice(4, 6));
    const day = Number(digits.slice(6, 8));
    const hour = Number(digits.slice(8, 10));
    const minute = digits.length >= 12 ? Number(digits.slice(10, 12)) : 0;
    if (year < 2020 || year > 2035) continue;
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    if (hour > 23 || minute > 59) continue;
    return new Date(year, month - 1, day, hour, minute).toISOString();
  }
  return null;
}

function buildOutput(events, pricingData, audit) {
  const dailyMap = new Map();
  const sessionMap = new Map();
  for (const event of events) {
    const date = localDateFromTimestamp(event.timestamp);
    const cost = calculateCost(event.model, event.tokens, pricingData, null, date);

    const dailyKey = `${date}::${event.model}`;
    const daily = dailyMap.get(dailyKey) || { date, model: event.model, ...zero(), cost: 0 };
    addInto(daily, event.tokens);
    daily.cost += cost;
    dailyMap.set(dailyKey, daily);

    const sessionKey = `${event.sessionId}::${event.model}`;
    const session = sessionMap.get(sessionKey) || {
      client: CLIENT_KEY,
      workspaceKey: SOURCE_LABEL,
      workspaceLabel: SOURCE_LABEL,
      sessionId: event.sessionId,
      model: event.model,
      ...zero(),
      cost: 0,
      lastActivity: event.timestamp
    };
    addInto(session, event.tokens);
    session.cost += cost;
    if (event.timestamp > session.lastActivity) {
      session.lastActivity = event.timestamp;
      session.model = event.model;
    }
    sessionMap.set(sessionKey, session);
  }

  const byDate = new Map();
  for (const row of [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date))) {
    if (!byDate.has(row.date)) byDate.set(row.date, []);
    byDate.get(row.date).push({
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
    });
  }

  return {
    graphJson: { contributions: [...byDate.entries()].map(([date, clients]) => ({ date, clients })) },
    modelsJson: { entries: [...sessionMap.values()] },
    tokenEvents: events.map(event => ({
      eventId: event.eventId,
      source: CLIENT_KEY,
      sessionId: event.sessionId,
      timestamp: event.timestamp,
      model: event.model,
      inputTokens: event.tokens.input,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      privacyLevel: 'safe'
    })),
    audit
  };
}

function isFallbackModel(model) {
  return !model || model === 'unknown';
}

function nearestMatch(win, anchorInWin, regex) {
  let best = null;
  let bestDistance = Infinity;
  for (const match of win.matchAll(regex)) {
    const distance = Math.abs(match.index - anchorInWin);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = match;
    }
  }
  return best;
}

function zero() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

function addInto(row, tokens) {
  row.input += tokens.input;
  row.output += tokens.output;
  row.cacheRead += tokens.cacheRead;
  row.cacheWrite += tokens.cacheWrite;
  row.reasoning += tokens.reasoning;
}

function positiveInt(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function emptyAuditSummary(candidateFiles = 0) {
  return {
    candidateFiles,
    usableTokenRecords: 0,
    skippedNoTokenRecords: 0,
    skippedConversationLikeRecords: 0,
    skippedOversizedFiles: 0,
    parseErrors: 0
  };
}

// .ldb 是 snappy 压缩的表文件、.log 是 32KiB 分帧的写批次,裸扫压缩字节只会命中
// 字面段碎片;按容器格式解出连续值字节再扫,解不出格式时退回整文件裸扫(旧版行为)。
function decodeLevelDbFile(raw, isTable) {
  try {
    return (isTable ? readTableBlocks(raw) : readWriteLogBlocks(raw)).toString('latin1');
  } catch {
    return raw.toString('latin1');
  }
}

function readVarint(src, offset) {
  let value = 0;
  let shift = 0;
  let p = offset;
  for (;;) {
    const byte = src[p++];
    value += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return [value, p];
    shift += 7;
  }
}

function readTableBlock(buf, offset, size) {
  if (offset < 0 || size < 0 || offset + size + 1 > buf.length) throw new Error('bad block handle');
  const raw = buf.subarray(offset, offset + size);
  return buf[offset + size] === 1 ? snappyDecompress(raw) : raw;
}

function readTableBlocks(buf) {
  if (buf.length < 48) throw new Error('short table');
  const footer = buf.subarray(buf.length - 48);
  if (footer.readBigUInt64LE(40) !== 0xdb4775248b80fb57n) throw new Error('bad table magic');
  let p;
  [, p] = readVarint(footer, 0); // 跳过 metaindex handle(offset + size 两个 varint)
  [, p] = readVarint(footer, p);
  const [indexOffset, p1] = readVarint(footer, p);
  const [indexSize] = readVarint(footer, p1);
  const index = readTableBlock(buf, indexOffset, indexSize);
  // 索引块:[表项][restart 数组 * n][n];表项 value 即数据块 handle,只需取 value。
  const restarts = index.readUInt32LE(index.length - 4);
  const entriesEnd = index.length - (restarts + 1) * 4;
  if (entriesEnd < 0) throw new Error('bad index block');
  const blocks = [];
  let q = 0;
  while (q < entriesEnd) {
    let shared, nonShared, valueSize;
    [shared, q] = readVarint(index, q);
    [nonShared, q] = readVarint(index, q);
    [valueSize, q] = readVarint(index, q);
    q += nonShared;
    const [blockOffset, hp] = readVarint(index, q);
    const [blockSize] = readVarint(index, hp);
    q += valueSize;
    blocks.push(readTableBlock(buf, blockOffset, blockSize));
  }
  return Buffer.concat(blocks);
}

const LOG_BLOCK_BYTES = 32768;

function readWriteLogBlocks(buf) {
  const parts = [];
  let pending = null;
  for (let start = 0; start < buf.length; start += LOG_BLOCK_BYTES) {
    const blockEnd = Math.min(start + LOG_BLOCK_BYTES, buf.length);
    let p = start;
    while (p + 7 <= blockEnd) {
      const length = buf.readUInt16LE(p + 4);
      const type = buf[p + 6];
      // type 0 是块尾零填充;其余帧声明长度越块或类型非法都视为非分帧格式。
      if (type === 0) break;
      if (type > 4 || p + 7 + length > blockEnd) throw new Error('bad log record frame');
      const payload = buf.subarray(p + 7, p + 7 + length);
      if (type === 1) {
        parts.push(payload);
        pending = null;
      } else if (type === 2) {
        pending = [payload];
      } else if (type === 3 && pending) {
        pending.push(payload);
      } else if (type === 4 && pending) {
        pending.push(payload);
        parts.push(...pending);
        pending = null;
      } else {
        throw new Error('bad log record sequence');
      }
      p += 7 + length;
    }
  }
  if (pending) throw new Error('unterminated log record');
  return Buffer.concat(parts);
}

function snappyDecompress(src) {
  let p = 0;
  let length = 0;
  let shift = 0;
  for (;;) {
    const byte = src[p++];
    length += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) break;
    shift += 7;
  }
  if (!Number.isSafeInteger(length) || length > 256 * 1024 * 1024) throw new Error('bad snappy length');
  const out = Buffer.allocUnsafe(length);
  let o = 0;
  while (p < src.length) {
    const tag = src[p++];
    if ((tag & 3) === 0) {
      let size = (tag >> 2) + 1;
      if (size > 60) {
        const extra = size - 60;
        size = 0;
        for (let i = 0; i < extra; i++) size += src[p++] * 2 ** (8 * i);
        size += 1;
      }
      if (p + size > src.length || o + size > length) throw new Error('bad snappy literal');
      src.copy(out, o, p, p + size);
      p += size;
      o += size;
    } else {
      let size;
      let back;
      if ((tag & 3) === 1) {
        size = ((tag >> 2) & 7) + 4;
        back = ((tag >> 5) << 8) + src[p++];
      } else if ((tag & 3) === 2) {
        size = (tag >> 2) + 1;
        back = src[p] + src[p + 1] * 256;
        p += 2;
      } else {
        size = (tag >> 2) + 1;
        back = src[p] + src[p + 1] * 256 + src[p + 2] * 65536 + src[p + 3] * 16777216;
        p += 4;
      }
      if (back < 1 || back > o || o + size > length) throw new Error('bad snappy copy');
      for (let i = 0; i < size; i++) {
        out[o] = out[o - back];
        o++;
      }
    }
  }
  if (o !== length) throw new Error('snappy length mismatch');
  return out;
}
