import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectableCollectors,
  collectorLabel,
  detectCollectors,
  enabledCollectorIds,
  stableCollectors
} from '../src/collector-registry.ts';

test('collector registry exposes eight stable sources', () => {
  const stable = stableCollectors().map(item => item.id).sort();
  assert.deepEqual(stable, ['claude', 'codebuddy', 'codex', 'gemini', 'hermes', 'openclaw', 'opencode', 'workbuddy']);
  assert.equal(collectorLabel('codex'), 'Codex');
});

test('collector detection includes experimental source metadata', () => {
  const rows = detectCollectors();
  const cursor = rows.find(item => item.id === 'cursor');
  const copilot = rows.find(item => item.id === 'copilot');
  const deepseekHarness = rows.find(item => item.id === 'deepseek-harness');
  assert.equal(cursor.supportStatus, 'experimental');
  assert.equal(copilot.defaultEnabled, false);
  assert.equal(cursor.readsConversationContent, false);
  assert.equal(cursor.tokenReliability, 'explicit-token-fields-only');
  assert.ok(cursor.dataFields.includes('input_tokens'));
  assert.equal(deepseekHarness.supportStatus, 'experimental');
  assert.equal(deepseekHarness.defaultEnabled, false);
});

test('enabled collectors ignore experimental ids by default', () => {
  const old = process.env.TOKEN_WORK_COLLECTORS;
  process.env.TOKEN_WORK_COLLECTORS = 'claude,cursor,codex';
  try {
    assert.deepEqual(Array.from(enabledCollectorIds()).sort(), ['claude', 'codex']);
    assert.deepEqual(Array.from(enabledCollectorIds({ includeExperimental: true })).sort(), ['claude', 'codex', 'cursor']);
  } finally {
    if (old == null) delete process.env.TOKEN_WORK_COLLECTORS;
    else process.env.TOKEN_WORK_COLLECTORS = old;
  }
});

test('collectable collectors include experimental modules only when requested', () => {
  assert.equal(collectableCollectors().some(item => item.id === 'cursor'), false);
  assert.equal(collectableCollectors({ includeExperimental: true }).some(item => item.id === 'cursor'), true);
});

test('collector matrix includes import-only and detected-only entries without collect modules', () => {
  const rows = detectCollectors();
  const ccusage = rows.find(item => item.id === 'ccusage');
  const amp = rows.find(item => item.id === 'amp');
  const roo = rows.find(item => item.id === 'roo-code');
  assert.equal(ccusage.supportStatus, 'import-only');
  assert.equal(ccusage.module, null);
  assert.equal(ccusage.readsConversationContent, false);
  assert.equal(amp.supportStatus, 'detected-only');
  assert.equal(roo.tokenReliability, 'unknown-no-usage-import');
  assert.equal(collectableCollectors({ includeExperimental: true }).some(item => item.id === 'ccusage'), false);
});
