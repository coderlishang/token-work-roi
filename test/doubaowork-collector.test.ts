import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectFromRoots } from '../src/collectors/doubaowork.ts';
import { COLLECTOR_REGISTRY, LIVE_COLLECT_SOURCES } from '../src/collector-registry.ts';
import { localDateFromTimestamp } from '../src/collectors/utils.ts';

const REPLY_A = '6b7963ee-a637-4cb3-a638-19228fad9d75';
const REPLY_B = 'a45f1cb9-99c3-48f2-9bd3-3a086d5cbc26';
const CHAT_A = '58433273287666434';
const CHAT_B = '58433360680964866';
const TAG = '38437423386403842_2026101322';

// 仿真实 V8 结构化克隆字节:字段名 ASCII、分隔符为控制字节,字符串值带引号。
function encodeRecord({ chatId, replyKey, model, modelId, tag, usage, escaped = false }: {
  chatId?: string;
  replyKey?: string;
  model?: string;
  modelId?: string;
  tag?: string;
  usage?: Record<string, number>;
  escaped?: boolean;
}) {
  const fields = [];
  if (chatId) fields.push(`chat_id\x12\x00${chatId}`);
  if (replyKey) fields.push(`reply_unique_key\x12\x01${replyKey}`);
  // 裸字符串形态:model_item_key + ":" + 长度前缀字节 + 值 + 引号(如 \fseed-lite-7b)。
  if (model) fields.push(`model_item_key":${String.fromCharCode(model.length)}${model}"`);
  if (modelId) fields.push(`model_id\x12\x00${modelId}`);
  if (tag) fields.push(`section_tag_1h\x12\x02${tag}`);
  if (usage) {
    const usageJson = JSON.stringify(usage);
    fields.push(escaped
      ? `context_window_usage":"${usageJson.replace(/"/g, '\\"')}`
      : `context_window_usage\x12\x03${usageJson}`);
  }
  return fields.join('\x00\x01');
}

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'token-work-doubaowork-'));
  const db = join(root, 'chrome_doubaowork-chat_0.indexeddb.leveldb');
  mkdirSync(db);
  return { root, db };
}

function writeRecords(db, name, records) {
  writeFileSync(join(db, name), Buffer.from(records.join(''), 'latin1'));
}

const USAGE_A = { system_prompt: 8301, messages: 11176, skills: 5908, tools: 27368, total_window_size: 256000 };
const USAGE_B = { system_prompt: 8002, messages: 20004, skills: 8013, tools: 53554, total_window_size: 256000 };

test('parses usage snapshots into input-only token events', async () => {
  const { root, db } = fixtureRoot();
  writeRecords(db, '000010.log', [
    encodeRecord({ chatId: CHAT_A, replyKey: REPLY_A, model: 'seed-lite-7b', modelId: '38', tag: TAG, usage: USAGE_A }),
    encodeRecord({ chatId: CHAT_B, replyKey: REPLY_B, model: '9', modelId: '9', tag: TAG, usage: USAGE_B })
  ]);
  try {
    const result = await collectFromRoots([db]);
    assert.equal(result.audit.candidateFiles, 1);
    assert.equal(result.audit.usableTokenRecords, 2);
    assert.equal(result.tokenEvents.length, 2);

    const first = result.tokenEvents[0];
    assert.equal(first.eventId, `doubaowork:reply:${createHash('sha256').update(REPLY_A).digest('hex').slice(0, 32)}`);
    assert.equal(first.source, 'doubaowork');
    assert.equal(first.sessionId, CHAT_A);
    // section_tag 是北京时间:22:00 固定对应 14:00Z,不受运行进程时区影响。
    assert.equal(first.timestamp, '2026-10-13T14:00:00.000Z');
    // 仓库 modelAliases 把本地 key seed-lite-7b 归一为真实模型名。
    assert.equal(first.model, 'doubao-seed-2.1-lite');
    assert.equal(first.inputTokens, 8301 + 11176 + 5908 + 27368);
    assert.equal(first.outputTokens, 0);
    assert.equal(first.cacheReadTokens, 0);
    assert.equal(first.cacheCreationTokens, 0);
    assert.equal(first.reasoningTokens, 0);
    assert.equal(first.privacyLevel, 'safe');

    assert.equal(result.tokenEvents[1].inputTokens, 8002 + 20004 + 8013 + 53554);
    assert.equal(result.tokenEvents[1].sessionId, CHAT_B);

    // graphJson 按日期+模型聚合;两条事件别名归一为同一模型,同日聚为一行,按官方单价计费。
    const date = localDateFromTimestamp(first.timestamp);
    assert.equal(result.graphJson.contributions.length, 1);
    assert.equal(result.graphJson.contributions[0].date, date);
    assert.equal(result.graphJson.contributions[0].clients.length, 1);
    assert.equal(result.graphJson.contributions[0].clients[0].tokens.input, 52753 + 89573);
    assert.ok(result.graphJson.contributions[0].clients.every(client => client.cost > 0));

    // 会话按 chat::model 拆行,与 collect.ts 增量重建的 sessionKey 口径一致。
    assert.equal(result.modelsJson.entries.length, 2);
    assert.equal(result.modelsJson.entries[0].sessionId, CHAT_A);
    assert.equal(result.modelsJson.entries[0].workspaceLabel, 'DoubaoWork');
    assert.ok(result.modelsJson.entries[0].cost > 0);

    assert.deepEqual(result.reconciliation, { managedEventIdPrefix: 'doubaowork:' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dedupes rewritten record copies with the latest usage snapshot', async () => {
  const { root, db } = fixtureRoot();
  writeRecords(db, '000010.log', [
    encodeRecord({ chatId: CHAT_A, replyKey: REPLY_A, model: 'seed-lite-7b', tag: TAG, usage: { system_prompt: 100, messages: 200, skills: 30, tools: 70 } }),
    // 记录重写副本:同一回复的转义形态 usage 与更大用量,后者应胜出。
    encodeRecord({ chatId: CHAT_A, replyKey: REPLY_A, model: 'seed-lite-7b', tag: TAG, usage: { system_prompt: 1000, messages: 2000, skills: 300, tools: 700 }, escaped: true })
  ]);
  try {
    const result = await collectFromRoots([db]);
    assert.equal(result.tokenEvents.length, 1);
    assert.equal(result.tokenEvents[0].inputTokens, 4000);
    assert.equal(result.audit.usableTokenRecords, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('keeps the larger snapshot when a stale smaller copy is written later', async () => {
  const { root, db } = fixtureRoot();
  writeRecords(db, '000010.log', [
    encodeRecord({ chatId: CHAT_A, replyKey: REPLY_A, model: 'seed-lite-7b', tag: TAG, usage: { system_prompt: 1000, messages: 2000, skills: 300, tools: 700 } }),
    encodeRecord({ chatId: CHAT_A, replyKey: REPLY_A, model: 'seed-lite-7b', tag: TAG, usage: { system_prompt: 100, messages: 200, skills: 30, tools: 70 }, escaped: true })
  ]);
  try {
    const result = await collectFromRoots([db]);
    assert.equal(result.tokenEvents.length, 1);
    assert.equal(result.tokenEvents[0].inputTokens, 4000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('aggregates one chat that switches models into a single session row', async () => {
  const { root, db } = fixtureRoot();
  writeRecords(db, '000010.log', [
    encodeRecord({ chatId: CHAT_A, replyKey: REPLY_A, model: 'seed-lite-7b', tag: '1_2026101309', usage: { system_prompt: 100, messages: 200, skills: 0, tools: 0 } }),
    encodeRecord({ chatId: CHAT_A, replyKey: REPLY_B, model: 'seed-lite-pro-7b', tag: '1_2026101310', usage: { system_prompt: 300, messages: 400, skills: 0, tools: 0 } })
  ]);
  try {
    const result = await collectFromRoots([db]);
    // session_usage 主键只有 session_id,同一会话换模型必须聚成一行,否则后写模型覆盖前一模型用量。
    assert.equal(result.modelsJson.entries.length, 1);
    assert.equal(result.modelsJson.entries[0].sessionId, CHAT_A);
    assert.equal(result.modelsJson.entries[0].input, 1000);
    assert.equal(result.modelsJson.entries[0].model, result.tokenEvents[1].model);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('inherits the model from an earlier copy when the latest one drops it', async () => {
  const { root, db } = fixtureRoot();
  writeRecords(db, '000010.log', [
    encodeRecord({ chatId: CHAT_A, replyKey: REPLY_A, model: '9', tag: TAG, usage: { system_prompt: 100, messages: 200, skills: 0, tools: 0 } }),
    // 垫过 ±33KB 窗口,让最新副本丢失 model_item_key 且够不到上一副本的模型字段。
    '\x00'.repeat(40000),
    encodeRecord({ chatId: CHAT_A, replyKey: REPLY_A, tag: TAG, usage: { system_prompt: 1000, messages: 2000, skills: 0, tools: 0 } })
  ]);
  try {
    const result = await collectFromRoots([db]);
    assert.equal(result.tokenEvents.length, 1);
    assert.equal(result.tokenEvents[0].model, 'doubao-seed-2.1-lite');
    assert.equal(result.tokenEvents[0].inputTokens, 3000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('counts unusable hits without failing the collect', async () => {
  const { root, db } = fixtureRoot();
  writeRecords(db, '000010.log', [
    // 有用量但找不到 reply_unique_key(之前没有任何记录)。
    encodeRecord({ chatId: CHAT_A, usage: { system_prompt: 10, messages: 20, skills: 0, tools: 0 } }),
    // 四项全零。
    encodeRecord({ chatId: CHAT_A, replyKey: REPLY_B, usage: { system_prompt: 0, messages: 0, skills: 0, tools: 0 } }),
    // usage JSON 损坏(带收尾花括号,避免切片吞进下一条记录;放最后同理)。
    encodeRecord({ chatId: CHAT_A, replyKey: REPLY_A }) + 'context_window_usage\x12\x03{not-json}'
  ]);
  try {
    const result = await collectFromRoots([db]);
    assert.equal(result.tokenEvents.length, 0);
    assert.equal(result.audit.parseErrors, 1);
    assert.equal(result.audit.skippedNoTokenRecords, 2);
    assert.equal(result.audit.usableTokenRecords, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scans ldb and log files and ignores non-leveldb entries', async () => {
  const { root, db } = fixtureRoot();
  writeRecords(db, '000005.ldb', [encodeRecord({ chatId: CHAT_A, replyKey: REPLY_A, model: 'seed-lite-7b', tag: TAG, usage: USAGE_A })]);
  writeRecords(db, '000011.log', [encodeRecord({ chatId: CHAT_B, replyKey: REPLY_B, model: '9', tag: TAG, usage: USAGE_B })]);
  writeFileSync(join(db, 'CURRENT'), 'MANIFEST-000001\n');
  writeFileSync(join(db, 'MANIFEST-000001'), 'not-a-usage-file');
  try {
    const result = await collectFromRoots([db]);
    assert.equal(result.audit.candidateFiles, 2);
    assert.equal(result.tokenEvents.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('attributes key-less records to the source model, and falls back to file mtime without a section tag', async () => {
  const { root, db } = fixtureRoot();
  const stamp = new Date('2026-10-13T06:30:00.000Z');
  const file = join(db, '000010.log');
  // 只有请求级 model_id 时按来源模型归属,不落 unknown。
  writeRecords(db, '000010.log', [
    encodeRecord({ chatId: CHAT_A, replyKey: REPLY_A, modelId: '38', usage: { system_prompt: 10, messages: 20, skills: 0, tools: 0 } }),
    '\x00'.repeat(10000),
    encodeRecord({ chatId: CHAT_B, replyKey: REPLY_B, usage: { system_prompt: 1, messages: 2, skills: 0, tools: 0 } })
  ]);
  utimesSync(file, stamp, stamp);
  try {
    const result = await collectFromRoots([db]);
    assert.equal(result.tokenEvents[0].model, 'doubao-seed-2.1-lite');
    assert.equal(result.tokenEvents[1].model, 'doubao-seed-2.1-lite');
    assert.equal(result.tokenEvents[0].timestamp, stamp.toISOString());
    assert.equal(result.tokenEvents[1].timestamp, stamp.toISOString());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('finds the model key far from the anchor within the widened window', async () => {
  const { root, db } = fixtureRoot();
  // model_item_key 距锚点 10KB,旧 ±8KB 窗口取不到,会退化成拼造模型名。
  const record = [
    `chat_id\x12\x00${CHAT_A}`,
    `reply_unique_key\x12\x01${REPLY_A}`,
    '\x00'.repeat(10000),
    `model_item_key":\x0cseed-lite-7b"`,
    `section_tag_1h\x12\x02${TAG}`,
    `context_window_usage\x12\x03${JSON.stringify(USAGE_A)}`
  ].join('\x00\x01');
  writeRecords(db, '000010.log', [record]);
  try {
    const result = await collectFromRoots([db]);
    assert.equal(result.tokenEvents.length, 1);
    assert.equal(result.tokenEvents[0].model, 'doubao-seed-2.1-lite');
    assert.equal(result.tokenEvents[0].sessionId, CHAT_A);
    assert.equal(result.tokenEvents[0].inputTokens, 8301 + 11176 + 5908 + 27368);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recognizes the camelCase modelItemKey field form', async () => {
  const { root, db } = fixtureRoot();
  // 真实数据同时存在 model_item_key 与 modelItemKey 两种字段名形态。
  const raw = [
    encodeRecord({ chatId: CHAT_A, replyKey: REPLY_A, tag: TAG, usage: { system_prompt: 10, messages: 20, skills: 0, tools: 0 } }),
    'modelItemKey"\x0cseed-lite-7b'
  ].join('\x00\x01');
  writeRecords(db, '000010.log', [raw]);
  try {
    const result = await collectFromRoots([db]);
    assert.equal(result.tokenEvents.length, 1);
    assert.equal(result.tokenEvents[0].model, 'doubao-seed-2.1-lite');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('doubaowork is registered as an experimental live source', () => {
  const entry = COLLECTOR_REGISTRY.find(item => item.id === 'doubaowork');
  assert.ok(entry, 'doubaowork missing from COLLECTOR_REGISTRY');
  assert.equal(entry.supportStatus, 'experimental');
  assert.ok(entry.module);
  assert.ok(LIVE_COLLECT_SOURCES.split(',').includes('doubaowork'));
});

// —— leveldb 容器格式:真实库里 .ldb 数据块是 snappy 压缩的,.log 记录按 32KiB 分帧 ——

const TABLE_MAGIC = 0xdb4775248b80fb57n;

// 只含 literal 元素的合法 snappy 流(解压器需按 60 字节上界分块)。
function snappyLiteral(src) {
  const pre = [];
  let v = src.length;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v) byte |= 0x80;
    pre.push(byte);
  } while (v);
  const parts = [Buffer.from(pre)];
  for (let p = 0; p < src.length;) {
    const n = Math.min(60, src.length - p);
    parts.push(Buffer.from([(n - 1) << 2]), src.subarray(p, p + n));
    p += n;
  }
  return Buffer.concat(parts);
}

function varintBytes(v) {
  const out = [];
  do {
    let byte = v & 0x7f;
    v = Math.floor(v / 128);
    if (v) byte |= 0x80;
    out.push(byte);
  } while (v);
  return Buffer.from(out);
}

// 最小 .ldb:数据块(+压缩字节)+ 指向它的索引块(+压缩字节)+ 48 字节 footer。
function buildLdb(payload, compressed = false) {
  const stored = compressed ? snappyLiteral(payload) : payload;
  const dataPart = Buffer.concat([stored, Buffer.from([compressed ? 1 : 0])]);
  const handle = Buffer.concat([varintBytes(0), varintBytes(stored.length)]);
  const indexEntries = Buffer.concat([Buffer.from([0, 1, handle.length]), Buffer.from('k'), handle]);
  const indexBody = Buffer.concat([indexEntries, Buffer.from([0, 0, 0, 0]), Buffer.from([1, 0, 0, 0])]);
  const footer = Buffer.concat([
    varintBytes(0), varintBytes(0), // metaindex handle 占位,解析只跳过
    varintBytes(dataPart.length), varintBytes(indexBody.length)
  ]);
  const footerPadded = Buffer.alloc(48);
  footer.copy(footerPadded, 0);
  footerPadded.writeBigUInt64LE(TABLE_MAGIC, 40);
  return Buffer.concat([dataPart, indexBody, Buffer.from([0]), footerPadded]);
}

test('decodes snappy-compressed ldb table blocks', async () => {
  const { root, db } = fixtureRoot();
  const record = encodeRecord({ chatId: CHAT_A, replyKey: REPLY_A, model: 'seed-lite-7b', tag: TAG, usage: USAGE_A });
  writeFileSync(join(db, '000030.ldb'), buildLdb(Buffer.from(record, 'latin1'), true));
  try {
    const result = await collectFromRoots([db]);
    assert.equal(result.audit.candidateFiles, 1);
    assert.equal(result.tokenEvents.length, 1);
    assert.equal(result.tokenEvents[0].inputTokens, 8301 + 11176 + 5908 + 27368);
    assert.equal(result.audit.parseErrors, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reassembles log records split across 32KiB block framing', async () => {
  const { root, db } = fixtureRoot();
  // usage 之后垫 33KB,让记录横跨两个 32KiB 块(first 帧填满块尾,last 帧在下一块开头)。
  const record = Buffer.from(
    encodeRecord({ chatId: CHAT_A, replyKey: REPLY_A, model: 'seed-lite-7b', tag: TAG, usage: USAGE_A }) + '\x00'.repeat(33000),
    'latin1'
  );
  const firstLen = 32768 - 7 - 14 - 7;
  const block0 = Buffer.alloc(32768);
  block0.writeUInt16LE(14, 4);
  block0[6] = 1; // full
  block0.write('padding-record', 7, 'latin1');
  const p2 = 7 + 14;
  block0.writeUInt16LE(firstLen, p2 + 4);
  block0[p2 + 6] = 2; // first
  record.subarray(0, firstLen).copy(block0, p2 + 7);
  const rest = record.length - firstLen;
  const block1 = Buffer.alloc(7 + rest);
  block1.writeUInt16LE(rest, 4);
  block1[6] = 4; // last
  record.subarray(firstLen).copy(block1, 7);
  writeFileSync(join(db, '000040.log'), Buffer.concat([block0, block1]));
  try {
    const result = await collectFromRoots([db]);
    assert.equal(result.tokenEvents.length, 1);
    assert.equal(result.tokenEvents[0].inputTokens, 8301 + 11176 + 5908 + 27368);
    assert.equal(result.audit.parseErrors, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
