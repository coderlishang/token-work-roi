import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('collector config accepts UTF-8 BOM files instead of falling back to defaults', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-work-config-'));
  const configPath = join(dir, 'collectors.json');
  writeFileSync(configPath, `\uFEFF${JSON.stringify({
    collectors: { cursor: { roots: ['D:/fixture/cursor'] } },
    enabledCollectors: ['cursor']
  })}`, 'utf8');

  const old = process.env.TOKEN_WORK_CONFIG;
  process.env.TOKEN_WORK_CONFIG = configPath;
  try {
    const moduleUrl = `../src/collector-config.ts?case=${Date.now()}`;
    const { configuredPaths } = await import(moduleUrl);
    assert.deepEqual(configuredPaths('cursor', 'roots'), ['D:/fixture/cursor']);
  } finally {
    if (old == null) delete process.env.TOKEN_WORK_CONFIG;
    else process.env.TOKEN_WORK_CONFIG = old;
  }
});

test('model aliases remap proxy slugs at the shared grouping-name boundary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-work-alias-'));
  const configPath = join(dir, 'collectors.json');
  writeFileSync(configPath, JSON.stringify({
    modelAliases: {
      'gpt-5.6-terra': { to: 'glm-5.3-flash', from: '2026-09-18' },
      'GPT-5.6-Sol': 'doubao-seed-2.0-code',
      'self-mapped': 'self-mapped'
    }
  }), 'utf8');

  const old = process.env.TOKEN_WORK_CONFIG;
  process.env.TOKEN_WORK_CONFIG = configPath;
  try {
    // 必须 reset 共享 collector-config 实例缓存，utils.ts 才能读到该 fixture
    const sharedConfig = await import('../src/collector-config.ts');
    sharedConfig.resetConfigCache();
    const { normalizeModelForGrouping } = await import(`../src/collectors/utils.ts?case=${Date.now()}`);

    assert.equal(normalizeModelForGrouping('gpt-5.6-terra', '2026-09-18'), 'glm-5.3-flash');
    assert.equal(normalizeModelForGrouping('GPT-5.6-TERRA', '2026-09-18'), 'glm-5.3-flash');
    assert.equal(normalizeModelForGrouping('gpt-5.6-terra (high)', '2026-09-18'), 'glm-5.3-flash');
    assert.equal(normalizeModelForGrouping('gpt-5.6-terra(high)', '2026-09-18'), 'glm-5.3-flash');
    assert.equal(normalizeModelForGrouping('gpt-5.6-terra-20260901', '2026-09-18'), 'glm-5.3-flash');
    assert.equal(normalizeModelForGrouping('gpt-5.6-sol'), 'doubao-seed-2.0-code');
    assert.equal(normalizeModelForGrouping('self-mapped'), 'self-mapped');
    assert.equal(normalizeModelForGrouping('claude-sonnet-4-5'), 'claude-sonnet-4-5');

    writeFileSync(configPath, JSON.stringify({
      modelAliases: { 'gpt-5.6-terra': 'glm-5.2' }
    }), 'utf8');
    sharedConfig.resetConfigCache();
    assert.equal(normalizeModelForGrouping('gpt-5.6-terra'), 'glm-5.2');
    assert.equal(normalizeModelForGrouping('gpt-5.6-sol'), 'gpt-5.6-sol');
  } finally {
    if (old == null) delete process.env.TOKEN_WORK_CONFIG;
    else process.env.TOKEN_WORK_CONFIG = old;
  }
});

test('cutoff-scoped model aliases only remap usage from the cutoff onward', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-work-alias-from-'));
  const configPath = join(dir, 'collectors.json');
  writeFileSync(configPath, JSON.stringify({
    modelAliases: {
      'gpt-5.6-terra': { to: 'glm-5.3-flash', from: '2026-09-18' }
    }
  }), 'utf8');

  const old = process.env.TOKEN_WORK_CONFIG;
  process.env.TOKEN_WORK_CONFIG = configPath;
  try {
    const sharedConfig = await import('../src/collector-config.ts');
    sharedConfig.resetConfigCache();
    const { normalizeModelForGrouping } = await import(`../src/collectors/utils.ts?case=${Date.now()}`);

    // 无日期上下文与 cutoff 前的日期保持惰性
    assert.equal(normalizeModelForGrouping('gpt-5.6-terra'), 'gpt-5.6-terra');
    assert.equal(normalizeModelForGrouping('gpt-5.6-terra', '2026-09-17'), 'gpt-5.6-terra');
    assert.equal(normalizeModelForGrouping('gpt-5.6-terra (high)', '2026-09-17'), 'gpt-5.6-terra (high)');
    // 字典序比较：非 YYYY-MM-DD 日期（含 'unknown' 回退值）必须保持惰性
    assert.equal(normalizeModelForGrouping('gpt-5.6-terra', 'unknown'), 'gpt-5.6-terra');
    assert.equal(normalizeModelForGrouping('gpt-5.6-terra', '09/18'), 'gpt-5.6-terra');
    assert.equal(normalizeModelForGrouping('gpt-5.6-terra', ''), 'gpt-5.6-terra');
    assert.equal(normalizeModelForGrouping('gpt-5.6-terra', '2026-09-18'), 'glm-5.3-flash');
    assert.equal(normalizeModelForGrouping('gpt-5.6-terra (high)', '2026-09-18'), 'glm-5.3-flash');
    assert.equal(normalizeModelForGrouping('gpt-5.6-terra', '2026-09-19'), 'glm-5.3-flash');
  } finally {
    if (old == null) delete process.env.TOKEN_WORK_CONFIG;
    else process.env.TOKEN_WORK_CONFIG = old;
  }
});

test('scoped model aliases with a malformed cutoff are skipped instead of misattributing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-work-alias-bad-'));
  const configPath = join(dir, 'collectors.json');
  writeFileSync(configPath, JSON.stringify({
    modelAliases: {
      'gpt-5.6-terra': { to: 'glm-5.3-flash', from: '2026/09/18' },
      'gpt-5.6-sol': { to: 'doubao-seed-2.0-code' }
    }
  }), 'utf8');

  const old = process.env.TOKEN_WORK_CONFIG;
  process.env.TOKEN_WORK_CONFIG = configPath;
  try {
    const sharedConfig = await import('../src/collector-config.ts');
    sharedConfig.resetConfigCache();
    const { normalizeModelForGrouping } = await import(`../src/collectors/utils.ts?case=${Date.now()}`);

    // 非法/缺失 cutoff 的条目一律跳过，避免垃圾比较
    assert.equal(normalizeModelForGrouping('gpt-5.6-terra', '2026-09-19'), 'gpt-5.6-terra');
    assert.equal(normalizeModelForGrouping('gpt-5.6-sol', '2026-09-19'), 'gpt-5.6-sol');
  } finally {
    if (old == null) delete process.env.TOKEN_WORK_CONFIG;
    else process.env.TOKEN_WORK_CONFIG = old;
  }
});
