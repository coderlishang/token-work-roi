import test from 'node:test';
import type { ProcessResult } from '../test-support/process.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditStructuredUsage, collectStructuredUsage, normalizeUsageRecord } from '../src/collectors/structured-usage.ts';

const EXPERIMENTAL = ['cursor', 'copilot', 'qwen', 'kimi', 'goose'];

test('experimental collector fixtures contain no transcript or full path fields', () => {
  for (const id of EXPERIMENTAL) {
    const text = readFileSync(join('test', 'fixtures', 'collectors', id, 'usage.jsonl'), 'utf8');
    assert.equal(/prompt|response|content|diff|transcript|messages/i.test(text), false, `${id} fixture contains conversation-like fields`);
    assert.equal(/[A-Z]:[\\/]|\/Users\/|\/home\//.test(text), false, `${id} fixture contains full local paths`);
  }
});

test('experimental structured collector imports explicit token rows only', async () => {
  for (const id of EXPERIMENTAL) {
    const result = await collectStructuredUsage({
      clientKey: id,
      roots: [join(process.cwd(), 'test', 'fixtures', 'collectors', id)]
    });
    assert.equal(result.modelsJson.entries.length, 1, `${id} should skip missing-token fixture rows`);
    assert.equal(result.tokenEvents.length, 1, `${id} should emit one token event`);
    assert.equal(result.tokenEvents[0].source, id);
    assert.ok(result.tokenEvents[0].inputTokens + result.tokenEvents[0].outputTokens > 0);
  }
});

test('structured usage normalizer rejects conversation-shaped rows', () => {
  assert.deepEqual(normalizeUsageRecord({
    sessionId: 'unsafe',
    model: 'gpt-5.3-codex',
    prompt: 'do not ingest this',
    inputTokens: 100,
    outputTokens: 20
  }), []);
});

test('structured usage audit counts usable, no-token and conversation-like records', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-work-audit-'));
  try {
    writeFileSync(join(dir, 'usage.jsonl'), [
      JSON.stringify({ eventId: 'ok', sessionId: 's1', model: 'gpt-5.3-codex', inputTokens: 100, outputTokens: 20 }),
      JSON.stringify({ eventId: 'no-token', sessionId: 's2', model: 'gpt-5.3-codex' }),
      JSON.stringify({ eventId: 'unsafe', sessionId: 's3', model: 'gpt-5.3-codex', prompt: 'do not read', inputTokens: 100 })
    ].join('\n'), 'utf8');

    const audit = await auditStructuredUsage({ roots: [dir] });
    assert.equal(audit.candidateFiles, 1);
    assert.equal(audit.usableTokenRecords, 1);
    assert.equal(audit.skippedNoTokenRecords, 1);
    assert.equal(audit.skippedConversationLikeRecords, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('collectors audit CLI emits safe summary without full paths', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-work-cli-audit-'));
  const configPath = join(dir, 'collectors.json');
  const root = join(process.cwd(), 'test', 'fixtures', 'collectors');
  writeFileSync(configPath, JSON.stringify({
    collectors: {
      ...Object.fromEntries(EXPERIMENTAL.map(id => [id, { roots: [join(root, id)] }])),
      deepseekHarness: { roots: [join(dir, 'no-deepseek-harness-data')] },
      workbuddy: { tracesDir: '/nonexistent/workbuddy/traces' }
    }
  }), 'utf8');

  try {
    const result = await runCli(['collectors', '--audit', '--json'], {
      TOKEN_WORK_CONFIG: configPath
    });
    assert.equal(result.code, 0, result.stderr);
    const json = JSON.parse(result.stdout);
    assert.equal(json.collectors.length, EXPERIMENTAL.length + 1);
    assert.equal(json.totals.usableTokenRecords, EXPERIMENTAL.length);
    assert.equal(json.totals.skippedNoTokenRecords, EXPERIMENTAL.length);
    assert.equal(json.totals.skippedConversationLikeRecords, 0);
    assert.equal(result.stdout.includes(root), false);
    assert.equal(/[A-Z]:[\\/].*fixtures/.test(result.stdout), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runCli(argv, env = {}) {
  return new Promise<ProcessResult>(resolve => {
    const child = spawn(process.execPath, ['src/cli.ts', ...argv], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.on('error', error => resolve({ code: 1, stdout, stderr: `${stderr}${error.message}` }));
  });
}
