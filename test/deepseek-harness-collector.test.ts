import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectFromRoots } from '../src/collectors/deepseek-harness.ts';

const TOTALS_V1 = { uncachedInputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 0 };
const TOTALS_V2 = { uncachedInputTokens: 1800, outputTokens: 900, cacheReadTokens: 3200, cacheWriteTokens: 100 };

function snapshotJson({ createdAt, cwd, model, totals, seq }: {
  createdAt: number;
  cwd?: string | null;
  model: string | null;
  totals: Record<string, number>;
  seq: number;
}) {
  return JSON.stringify({
    record: {
      identity: { formatVersion: 3, createdAt, cwd: cwd ?? '/Users/dev/project-a', isSeeded: false, inheritedEventCount: 0 },
      rows: {
        tokenUsage: { ver: 2, seq, val: { totals, last: null } },
        modelSelection: { ver: 2, seq, val: { lastUsed: model ? { provider: 'deepseek-official', model } : null, pending: null } }
      }
    }
  });
}

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'token-work-dsh-'));
  const sessionsDir = join(root, 'storages', 'session_projcache', 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  return { root, sessionsDir };
}

test('first collect imports the full cumulative totals and skips empty sessions', async () => {
  const { root, sessionsDir } = fixtureRoot();
  writeFileSync(join(sessionsDir, 'session-a.json'), snapshotJson({
    createdAt: 1789537593951, model: 'deepseek-flash', totals: TOTALS_V1, seq: 100
  }));
  writeFileSync(join(sessionsDir, 'session-empty.json'), snapshotJson({
    createdAt: 1789537594000, model: null, totals: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, seq: 2
  }));

  try {
    const result = await collectFromRoots([root]);
    assert.equal(result.audit.candidateFiles, 2);
    assert.equal(result.audit.usableTokenRecords, 1);
    assert.equal(result.audit.skippedNoTokenRecords, 1);
    assert.equal(result.tokenEvents.length, 1);
    const event = result.tokenEvents[0];
    assert.equal(event.source, 'deepseek-harness');
    assert.equal(event.sessionId, 'session-a');
    assert.equal(event.timestamp, '2026-09-16T05:46:33.951Z');
    assert.equal(event.model, 'deepseek-flash');
    assert.equal(event.inputTokens, 1000);
    assert.equal(event.outputTokens, 500);
    assert.equal(event.cacheReadTokens, 2000);
    assert.equal(event.reasoningTokens, 0);
    assert.equal(event.privacyLevel, 'safe');
    // Workspace label comes from the session cwd, not a full path.
    assert.equal(result.modelsJson.entries[0].workspaceLabel, 'project-a');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('re-collects only emit the delta accrued since the stored rows', async () => {
  const { root, sessionsDir } = fixtureRoot();
  const filePath = join(sessionsDir, 'session-a.json');
  writeFileSync(filePath, snapshotJson({ createdAt: 1789537593951, model: 'deepseek-flash', totals: TOTALS_V1, seq: 100 }));

  try {
    const first = await collectFromRoots([root]);
    assert.equal(first.tokenEvents.length, 1);
    assert.equal(first.tokenEvents[0].inputTokens, 1000);

    // Simulate the stored rows the DB would hold after applying the first collect.
    const stored = first.tokenEvents.map(event => ({ model: event.model, tokens: {
      input: event.inputTokens, output: event.outputTokens,
      cacheRead: event.cacheReadTokens, cacheWrite: event.cacheCreationTokens,
      reasoning: event.reasoningTokens
    } }));
    const getStoredSessionEvents = sessionId => sessionId === 'session-a' ? stored : [];

    // No new usage: nothing is emitted, so repeated collects stay idempotent.
    const unchanged = await collectFromRoots([root], null, { getStoredSessionEvents });
    assert.equal(unchanged.tokenEvents.length, 0);
    assert.equal(unchanged.audit.skippedNoTokenRecords, 1);

    // Harness accrues more usage under a different model: only the delta is emitted.
    writeFileSync(filePath, snapshotJson({ createdAt: 1789537593951, model: 'deepseek-v4-pro', totals: TOTALS_V2, seq: 200 }));
    const second = await collectFromRoots([root], null, { getStoredSessionEvents });
    assert.equal(second.tokenEvents.length, 1);
    const delta = second.tokenEvents[0];
    assert.equal(delta.model, 'deepseek-v4-pro');
    assert.equal(delta.inputTokens, 800);
    assert.equal(delta.outputTokens, 400);
    assert.equal(delta.cacheReadTokens, 1200);
    assert.equal(delta.cacheCreationTokens, 100);
    assert.notEqual(delta.eventId, first.tokenEvents[0].eventId);

    // Combined with the first import the per-model split stays additive:
    // deepseek-flash keeps 1000/500/2000 and deepseek-v4-pro owns only the delta.
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('malformed session files count as parse errors without failing the collect', async () => {
  const { root, sessionsDir } = fixtureRoot();
  writeFileSync(join(sessionsDir, 'session-bad.json'), '{not json');
  try {
    const result = await collectFromRoots([root]);
    assert.equal(result.tokenEvents.length, 0);
    assert.equal(result.audit.parseErrors, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DeepSeek Harness collector honors incremental changedAfterMs via file mtime', async () => {
  const { root, sessionsDir } = fixtureRoot();
  const filePath = join(sessionsDir, 'session-a.json');
  writeFileSync(filePath, snapshotJson({ createdAt: 1789537593951, model: 'deepseek-flash', totals: TOTALS_V1, seq: 100 }));

  try {
    const old = new Date(Date.now() - 60_000);
    utimesSync(filePath, old, old);
    const stale = await collectFromRoots([root], null, { changedAfterMs: Date.now() - 30_000 });
    assert.equal(stale.tokenEvents.length, 0);
    assert.equal(stale.audit.candidateFiles, 0);
    const fresh = await collectFromRoots([root], null, { changedAfterMs: Date.now() - 120_000 });
    assert.equal(fresh.tokenEvents.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
