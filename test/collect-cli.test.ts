import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { ProcessResult } from '../test-support/process.ts';
import { localDateFromTimestamp } from '../src/collectors/utils.ts';
import { calculateCost } from '../src/pricing.ts';

interface CollectSourceSummary {
  id: string;
  candidateFiles: number;
  usableTokenRecords: number;
  sessionRows: number;
  tokenEvents: number;
  eventTotalTokens: number;
  coverageRisk: string;
  reconciliation: {
    dailyVsEventDiffPct: number;
    sessionVsEventDiffPct: number;
  };
}

test('collect refuses to run without explicit dry-run or apply mode', async () => {
  const dir = tempDir();
  const dbPath = join(dir, 'usage.sqlite');
  try {
    const result = await runNode(['src/collect.ts', '--sources=claude', '--db', dbPath, '--json']);
    assert.notEqual(result.code, 0);
    assert.match(`${result.stdout}${result.stderr}`, /--dry-run or --apply/);
    assert.equal(existsSync(dbPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('collect does not treat false boolean arguments as write confirmation', async () => {
  const result = await runNode(['src/collect.ts', '--apply', '--yes=false', '--json']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /requires --yes/);
});

test('collect apply rejects a second writer for the same SQLite database', async () => {
  const fixture = createCollectorFixture();
  const lockPath = `${fixture.dbPath}.collect.lock`;
  const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
    stdio: 'ignore',
    windowsHide: true
  });
  try {
    writeFileSync(lockPath, JSON.stringify({ pid: owner.pid, startedAt: new Date().toISOString() }));
    const result = await runNode([
      'src/collect.ts',
      '--sources=claude',
      '--db',
      fixture.dbPath,
      '--apply',
      '--yes',
      '--json'
    ], fixture.env);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /already running for this SQLite database/);
    assert.equal(existsSync(lockPath), true);
  } finally {
    if (owner.exitCode == null) owner.kill('SIGKILL');
    cleanupFixture(fixture);
  }
});

test('collector dates always use China Standard Time', () => {
  assert.equal(localDateFromTimestamp('2026-06-17T15:59:59.999Z'), '2026-06-17');
  assert.equal(localDateFromTimestamp('2026-06-17T16:00:00.000Z'), '2026-06-18');
});

test('collect dry-run scans fixtures and does not write SQLite', async () => {
  const fixture = createCollectorFixture();
  try {
    const result = await runNode([
      'src/collect.ts',
      '--sources=claude,codex,cursor',
      '--db',
      fixture.dbPath,
      '--dry-run',
      '--json'
    ], fixture.env);
    assert.equal(result.code, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.mode, 'dry-run');
    assert.equal(summary.before, null);
    assert.equal(summary.after, null);
    assert.equal(existsSync(fixture.dbPath), false);

    const byId = new Map<string, CollectSourceSummary>(summary.sources.map((row: CollectSourceSummary) => [row.id, row]));
    assert.equal(byId.get('claude').candidateFiles, 2);
    assert.equal(byId.get('claude').usableTokenRecords, 3);
    assert.equal(byId.get('claude').sessionRows, 3);
    assert.equal(byId.get('claude').tokenEvents, 3);
    assert.equal(byId.get('claude').coverageRisk, 'trusted-event-level');
    assert.equal(byId.get('codex').candidateFiles, 1);
    assert.equal(byId.get('codex').usableTokenRecords, 2);
    assert.equal(byId.get('codex').eventTotalTokens, 150);
    assert.equal(byId.get('codex').coverageRisk, 'trusted-event-level');
    assert.equal(byId.get('cursor').candidateFiles, 1);
    assert.equal(byId.get('cursor').usableTokenRecords, 1);
    assert.ok(summary.totals.sessionRows >= 4);
    assert.ok(summary.totals.tokenEvents >= 4);
    assert.equal(summary.totals.dailyTotalTokens, summary.totals.sessionTotalTokens);
    assert.equal(summary.totals.sessionTotalTokens, summary.totals.eventTotalTokens);
  } finally {
    cleanupFixture(fixture);
  }
});

test('Codex reasoning is a subset of output and historical rows are repaired once', async () => {
  const fixture = createCollectorFixture();
  const command = ['src/collect.ts', '--sources=codex', '--db', fixture.dbPath, '--apply', '--yes', '--json'];
  try {
    let result = await runNode(command, fixture.env);
    assert.equal(result.code, 0, result.stderr);
    const db = new DatabaseSync(fixture.dbPath);
    const nativeCost = Number(db.prepare("SELECT SUM(cost_usd) cost FROM daily_usage WHERE source LIKE 'Codex%'").get().cost);
    for (const row of db.prepare(`
      SELECT device, source, session_id AS sessionId, date(timestamp, '+8 hours') AS usageDate,
        model, reasoning_tokens AS reasoningTokens
      FROM token_events WHERE event_id LIKE 'codex:%' AND reasoning_tokens > 0
    `).all()) {
      const duplicateCost = calculateCost(row.model, { reasoning: row.reasoningTokens });
      db.prepare(`UPDATE daily_usage SET cost_usd = cost_usd + ?
        WHERE device = ? AND source = ? AND usage_date = ? AND model = ?`)
        .run(duplicateCost, row.device, row.source, row.usageDate, row.model);
      db.prepare(`UPDATE session_usage SET cost_usd = cost_usd + ?
        WHERE device = ? AND source = ? AND session_id = ?`)
        .run(duplicateCost, row.device, row.source, row.sessionId);
    }
    db.exec(`
      UPDATE token_events SET output_tokens = output_tokens + reasoning_tokens WHERE event_id LIKE 'codex:%';
      UPDATE daily_usage SET output_tokens = output_tokens + reasoning_output_tokens,
        total_tokens = total_tokens + reasoning_output_tokens WHERE source LIKE 'Codex%';
      UPDATE session_usage SET output_tokens = output_tokens + reasoning_output_tokens,
        total_tokens = total_tokens + reasoning_output_tokens WHERE source LIKE 'Codex%';
    `);
    const omittedEvent = db.prepare("SELECT event_id AS eventId FROM token_events WHERE event_id LIKE 'codex:%' LIMIT 1").get();
    db.prepare('DELETE FROM token_events WHERE event_id = ?').run(omittedEvent.eventId);
    const staleEvent = db.prepare(`SELECT event_id AS eventId, device, source, session_id AS sessionId,
      date(timestamp, '+8 hours') AS usageDate, model FROM token_events
      WHERE event_id LIKE 'codex:%' LIMIT 1`).get();
    db.prepare('UPDATE token_events SET output_tokens = output_tokens + 7 WHERE event_id = ?').run(staleEvent.eventId);
    db.prepare(`UPDATE daily_usage SET output_tokens = output_tokens + 7, total_tokens = total_tokens + 7
      WHERE device = ? AND source = ? AND usage_date = ? AND model = ?`)
      .run(staleEvent.device, staleEvent.source, staleEvent.usageDate, staleEvent.model);
    db.prepare(`UPDATE session_usage SET output_tokens = output_tokens + 7, total_tokens = total_tokens + 7
      WHERE device = ? AND source = ? AND session_id = ?`)
      .run(staleEvent.device, staleEvent.source, staleEvent.sessionId);
    const importedTokens = { input: 100, output: 15, cacheRead: 30, reasoning: 5 };
    const importedCost = calculateCost('gpt-5.5', importedTokens);
    const legacyImportedCost = importedCost + calculateCost('gpt-5.5', { reasoning: 5 });
    db.prepare(`INSERT INTO token_events (event_id, device, source, session_id, timestamp, model,
      input_tokens, output_tokens, cache_read_tokens, reasoning_tokens)
      VALUES ('ccusage:legacy-reasoning', ?, 'Codex Desktop', 'imported-session', '2026-06-17T02:00:00Z',
        'gpt-5.5', 100, 20, 30, 5)`).run(hostname());
    db.prepare(`INSERT INTO daily_usage (device, source, usage_date, model, input_tokens, output_tokens,
      cache_read_tokens, reasoning_output_tokens, total_tokens, cost_usd)
      VALUES (?, 'Codex Desktop', '2026-06-17', 'gpt-5.5', 100, 20, 30, 5, 155, ?)`).run(hostname(), legacyImportedCost);
    db.prepare(`INSERT INTO session_usage (device, source, session_id, last_activity, model, input_tokens,
      output_tokens, cache_read_tokens, reasoning_output_tokens, total_tokens, cost_usd)
      VALUES (?, 'Codex Desktop', 'imported-session', '2026-06-17T02:00:00Z', 'gpt-5.5',
        100, 20, 30, 5, 155, ?)`).run(hostname(), legacyImportedCost);
    db.exec('PRAGMA user_version = 0');
    db.close();
    const expectedCost = nativeCost + importedCost;

    const scheduledEnv = {
      ...fixture.env,
      TOKEN_WORK_COLLECT_REASON: 'scheduled',
      TOKEN_WORK_SCHEDULED_INCREMENTAL: '1'
    };
    result = await runNode(command, scheduledEnv);
    assert.equal(result.code, 0, result.stderr);
    assert.match(JSON.parse(result.stdout).backup?.fileName || '', /scheduled-collect-repair/);
    const repaired = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      const eventTotal = repaired.prepare(`SELECT SUM(input_tokens + output_tokens + cache_read_tokens
        + cache_creation_tokens + reasoning_tokens) total FROM token_events
        WHERE event_id LIKE 'codex:%' OR event_id LIKE 'ccusage:%'`).get().total;
      assert.equal(eventTotal, 300);
      for (const table of ['daily_usage', 'session_usage']) {
        const row = repaired.prepare(`SELECT SUM(total_tokens) total, SUM(cost_usd) cost
          FROM ${table} WHERE source LIKE 'Codex%'`).get();
        assert.equal(row.total, 300);
        assert.ok(Math.abs(Number(row.cost) - expectedCost) < 1e-12);
      }
      assert.equal(repaired.prepare('PRAGMA user_version').get().user_version, 4);
      assert.ok(repaired.prepare('SELECT 1 FROM token_events WHERE event_id = ?').get(omittedEvent.eventId));
    } finally {
      repaired.close();
    }

    result = await runNode(command, scheduledEnv);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).backup, null);
  } finally {
    cleanupFixture(fixture);
  }
});

test('collect handles a large event history without truncating totals', async () => {
  const fixture = createCollectorFixture();
  // A smaller V8 stack reproduces the large-history failure with less test data.
  const count = 20_000;
  try {
    writeFileSync(join(fixture.dir, 'claude', 'projects', 'token-work', 'large.jsonl'),
      Array.from({ length: count }, (_, index) => JSON.stringify({
        type: 'assistant', timestamp: '2026-06-17T02:00:00Z',
        message: { id: `large-${index}`, model: 'claude-sonnet-4-5', usage: { input_tokens: 1, output_tokens: 1 } }
      })).join('\n'));
    const result = await runNode([
      '--stack-size=128', 'src/collect.ts', '--sources=claude', '--db', fixture.dbPath, '--dry-run', '--json'
    ], fixture.env);
    assert.equal(result.code, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.totals.tokenEvents, count + 3);
    assert.equal(summary.totals.eventTotalTokens, count * 2 + 293);
    assert.equal(summary.totals.dailyTotalTokens, summary.totals.eventTotalTokens);
    assert.equal(existsSync(fixture.dbPath), false);
  } finally {
    cleanupFixture(fixture);
  }
});

test('collect replaces transient WorkBuddy event identities without adding tokens twice', async () => {
  const fixture = createWorkBuddyIdentityFixture();
  try {
    const first = await runNode([
      'src/collect.ts', '--sources=workbuddy', '--db', fixture.dbPath, '--apply', '--yes', '--json'
    ], fixture.env);
    assert.equal(first.code, 0, first.stderr);

    const db = new DatabaseSync(fixture.dbPath);
    try {
      const event = db.prepare(`
        SELECT timestamp, input_tokens AS inputTokens, output_tokens AS outputTokens,
          cache_read_tokens AS cacheReadTokens, cache_creation_tokens AS cacheCreationTokens,
          reasoning_tokens AS reasoningTokens
        FROM token_events
        WHERE source = 'WorkBuddy'
      `).get();
      db.prepare(`
        INSERT INTO token_events (
          event_id, device, source, session_id, timestamp, model,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
          reasoning_tokens, privacy_level, updated_at
        ) VALUES (?, ?, 'WorkBuddy', 'transient-session', ?, 'auto', ?, ?, ?, ?, ?, 'safe', datetime('now'))
      `).run(
        'workbuddy:legacy-fixture', fixture.device, event.timestamp,
        event.inputTokens, event.outputTokens, event.cacheReadTokens,
        event.cacheCreationTokens, event.reasoningTokens
      );
    } finally {
      db.close();
    }

    const second = await runNode([
      'src/collect.ts', '--sources=workbuddy', '--db', fixture.dbPath, '--apply', '--yes', '--json'
    ], fixture.env);
    assert.equal(second.code, 0, second.stderr);

    const verified = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      assert.deepEqual(verified.prepare(`
        SELECT session_id AS sessionId, model,
          input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens + reasoning_tokens AS totalTokens
        FROM token_events WHERE source = 'WorkBuddy'
      `).all().map(row => ({ ...row })), [{
        sessionId: 'workbuddy:trace_fixture_identity', model: 'glm-5.2', totalTokens: 120
      }]);
      assert.deepEqual(verified.prepare(`
        SELECT total_tokens AS totalTokens FROM daily_usage WHERE source = 'WorkBuddy'
      `).all().map(row => ({ ...row })), [{ totalTokens: 120 }]);
    } finally {
      verified.close();
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test('WorkBuddy model correction rebuilds event, session, and daily usage', async () => {
  const fixture = createWorkBuddyIdentityFixture();
  try {
    const first = await runNode([
      'src/collect.ts', '--sources=workbuddy', '--db', fixture.dbPath, '--apply', '--yes', '--json'
    ], fixture.env);
    assert.equal(first.code, 0, first.stderr);

    const trace = JSON.parse(readFileSync(fixture.tracePath, 'utf8'));
    trace.trace.modelInfo.models = ['kimi-k3-1'];
    writeFileSync(fixture.tracePath, JSON.stringify(trace), 'utf8');

    const refreshed = await runNode([
      'src/collect.ts', '--sources=workbuddy', '--db', fixture.dbPath, '--apply', '--yes', '--json'
    ], { ...fixture.env, TOKEN_WORK_COLLECT_REASON: 'scheduled', TOKEN_WORK_SCHEDULED_INCREMENTAL: '1' });
    assert.equal(refreshed.code, 0, refreshed.stderr);

    const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      assert.deepEqual(db.prepare(`
        SELECT model, input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens + reasoning_tokens AS totalTokens
        FROM token_events WHERE source = 'WorkBuddy'
      `).all().map(row => ({ ...row })), [{ model: 'kimi-k3', totalTokens: 120 }]);
      assert.deepEqual(db.prepare(`
        SELECT model, total_tokens AS totalTokens FROM session_usage
        WHERE source = 'WorkBuddy'
      `).all().map(row => ({ ...row })), [{ model: 'kimi-k3', totalTokens: 120 }]);
      assert.deepEqual(db.prepare(`
        SELECT model, total_tokens AS totalTokens FROM daily_usage
        WHERE source = 'WorkBuddy'
      `).all().map(row => ({ ...row })), [{ model: 'kimi-k3', totalTokens: 120 }]);
    } finally {
      db.close();
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test('Claude GLM aliases keep event identities and daily totals after refresh', async () => {
  const fixture = createCollectorFixture();
  try {
    const file = join(fixture.claudeRoot, 'projects', 'token-work', 'glm.jsonl');
    writeFileSync(file, ['glm-5-3-flash', 'glm-5.3-flash'].map((model, i) => JSON.stringify({
      type: 'assistant', timestamp: '2026-09-05T12:00:00Z',
      message: { id: `response-${i}`, model, usage: { input_tokens: 100, output_tokens: 20 } }
    })).join('\n'));
    let identities;
    for (let i = 0; i < 2; i++) {
      const result = await runNode(['src/collect.ts', '--sources=claude', '--db', fixture.dbPath, '--apply', '--yes', '--json'], fixture.env);
      assert.equal(result.code, 0, result.stderr);
      const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
      try {
        const events = db.prepare("SELECT event_id,session_id,model FROM token_events WHERE model LIKE 'glm%' ORDER BY event_id").all();
        assert.equal(events.length, 2);
        assert.ok(events.every(row => row.model === 'glm-5.3-flash'));
        if (identities) assert.deepEqual(events, identities);
        identities = events;
        assert.equal(db.prepare("SELECT SUM(total_tokens) n FROM daily_usage WHERE model='glm-5.3-flash'").get().n, 240);
      } finally { db.close(); }
    }
  } finally { cleanupFixture(fixture); }
});

test('WorkBuddy refresh imports active usage once when its trace arrives later', async () => {
  const fixture = createWorkBuddyIdentityFixture();
  const command = ['src/collect.ts', '--sources=workbuddy', '--db', fixture.dbPath, '--apply', '--yes', '--json'];
  try {
    const trace = JSON.parse(readFileSync(fixture.tracePath, 'utf8'));
    const response = { id: 'completed-response', model: 'glm-5.2', usage: { prompt_tokens: 100, completion_tokens: 20 } };
    trace.spans[0].toolOutput = JSON.stringify(response);
    writeFileSync(fixture.tracePath, JSON.stringify(trace));
    let result = await runNode(command, fixture.env);
    assert.equal(result.code, 0, result.stderr);
    const db = new DatabaseSync(fixture.dbPath);
    const oldEventId = 'workbuddy:' + createHash('sha256').update(JSON.stringify({
      traceId: trace.trace.traceId, spanId: trace.spans[0].spanId, respIndex: 0
    })).digest('hex').slice(0, 32);
    db.prepare("UPDATE token_events SET event_id = ? WHERE source = 'WorkBuddy'").run(oldEventId);
    db.close();

    const projectDir = join(fixture.dir, 'workbuddy', 'projects', 'workspace');
    mkdirSync(projectDir, { recursive: true });
    const projectPath = join(projectDir, 'session.jsonl');
    const pending = { id: 'active-response', model: 'glm-5-3-flash', usage: { prompt_tokens: 200, completion_tokens: 30 } };
    const switched = { id: 'switched-response', model: 'hy4-preview', usage: { prompt_tokens: 40, completion_tokens: 10 } };
    const rows = [response, pending, pending, switched].map(value => ({
      id: value.id, type: 'function_call', sessionId: 'active-session',
      timestamp: Date.parse('2026-06-17T02:02:00Z'),
      providerData: { messageId: value.id, model: value.model, requestModelId: 'auto', rawUsage: value.usage }
    }));
    writeFileSync(projectPath, rows.map(row => JSON.stringify(row)).join('\n'));
    const scheduledEnv = { ...fixture.env, TOKEN_WORK_COLLECT_REASON: 'scheduled', TOKEN_WORK_SCHEDULED_INCREMENTAL: '1' };
    const verify = () => {
      const check = new DatabaseSync(fixture.dbPath, { readOnly: true });
      try {
        assert.equal(check.prepare("SELECT COUNT(*) n FROM token_events WHERE source = 'WorkBuddy'").get().n, 3);
        for (const table of ['daily_usage', 'session_usage']) {
          assert.equal(check.prepare(`SELECT SUM(total_tokens) n FROM ${table} WHERE source = 'WorkBuddy'`).get().n, 400);
        }
        const dailyCost = Number(check.prepare("SELECT SUM(cost_usd) cost FROM daily_usage WHERE source = 'WorkBuddy'").get().cost);
        const sessionCost = Number(check.prepare("SELECT SUM(cost_usd) cost FROM session_usage WHERE source = 'WorkBuddy'").get().cost);
        assert.ok(Math.abs(dailyCost - sessionCost) < 1e-10);
        assert.equal(check.prepare("SELECT COUNT(*) n FROM token_events WHERE model = 'glm-5.3-flash'").get().n, 1);
      } finally { check.close(); }
    };
    result = await runNode(command, scheduledEnv);
    assert.equal(result.code, 0, result.stderr);
    verify();
    const oldTime = new Date(Date.now() - 60_000);
    utimesSync(projectPath, oldTime, oldTime);
    utimesSync(fixture.tracePath, oldTime, oldTime);
    trace.trace.traceId = 'trace_late';
    trace.spans[0].spanId = 'late-span';
    trace.spans[0].toolOutput = JSON.stringify({
      ...pending, model: 'auto', usage: { prompt_tokens: 200, completion_tokens: 5 }
    });
    writeFileSync(fixture.siblingTracePath, JSON.stringify(trace));
    result = await runNode(command, scheduledEnv);
    assert.equal(result.code, 0, result.stderr);
    verify();
    result = await runNode(command, fixture.env);
    assert.equal(result.code, 0, result.stderr);
    verify();
    rmSync(join(fixture.dir, 'workbuddy', 'traces'), { recursive: true });
    writeFileSync(projectPath, rows.map(row => JSON.stringify({
      ...row,
      providerData: { ...row.providerData, rawUsage: { prompt_tokens: 1, completion_tokens: 1 } }
    })).join('\n'));
    result = await runNode(command, scheduledEnv);
    assert.equal(result.code, 0, result.stderr);
    verify();
    rmSync(join(fixture.dir, 'workbuddy'), { recursive: true });
    result = await runNode(command, fixture.env);
    assert.equal(result.code, 0, result.stderr);
    verify();
  } finally { cleanupFixture(fixture); }
});

test('scheduled WorkBuddy collection updates only changed traces without losing a similarly named trace', async () => {
  const fixture = createWorkBuddyIdentityFixture();
  try {
    const original = JSON.parse(readFileSync(fixture.tracePath, 'utf8'));
    const sibling = structuredClone(original);
    sibling.trace.traceId = 'trace_fixture_identity_extra';
    sibling.spans[0].spanId = 'span_fixture_identity_extra';
    writeFileSync(fixture.siblingTracePath, JSON.stringify(sibling), 'utf8');

    const first = await runNode([
      'src/collect.ts', '--sources=workbuddy', '--db', fixture.dbPath, '--apply', '--yes', '--json'
    ], fixture.env);
    assert.equal(first.code, 0, first.stderr);

    const oldTime = new Date(Date.now() - 60_000);
    utimesSync(fixture.tracePath, oldTime, oldTime);
    utimesSync(fixture.siblingTracePath, oldTime, oldTime);
    const scheduledEnv = {
      ...fixture.env,
      TOKEN_WORK_COLLECT_REASON: 'scheduled',
      TOKEN_WORK_SCHEDULED_INCREMENTAL: '1'
    };
    const unchanged = await runNode([
      'src/collect.ts', '--sources=workbuddy', '--db', fixture.dbPath, '--apply', '--yes', '--json'
    ], scheduledEnv);
    assert.equal(unchanged.code, 0, unchanged.stderr);
    assert.equal(JSON.parse(unchanged.stdout).sources[0].tokenEvents, 0);

    original.spans.push({
      ...original.spans[0],
      spanId: 'span_fixture_identity_second',
      startedAt: '2026-06-17T02:00:45.000Z'
    });
    writeFileSync(fixture.tracePath, JSON.stringify(original), 'utf8');

    const updated = await runNode([
      'src/collect.ts', '--sources=workbuddy', '--db', fixture.dbPath, '--apply', '--yes', '--json'
    ], scheduledEnv);
    assert.equal(updated.code, 0, updated.stderr);

    const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      assert.deepEqual(db.prepare(`
        SELECT session_id AS sessionId, COUNT(*) AS events, SUM(input_tokens + output_tokens + cache_read_tokens) AS totalTokens
        FROM token_events
        WHERE source = 'WorkBuddy'
        GROUP BY session_id
        ORDER BY session_id
      `).all().map(row => ({ ...row })), [
        { sessionId: 'workbuddy:trace_fixture_identity', events: 2, totalTokens: 240 },
        { sessionId: 'workbuddy:trace_fixture_identity_extra', events: 1, totalTokens: 120 }
      ]);
      assert.equal(db.prepare(`
        SELECT total_tokens AS totalTokens FROM daily_usage WHERE source = 'WorkBuddy'
      `).get().totalTokens, 360);
    } finally {
      db.close();
    }

    original.spans = [original.spans[1]];
    writeFileSync(fixture.tracePath, JSON.stringify(original), 'utf8');
    const removed = await runNode([
      'src/collect.ts', '--sources=workbuddy', '--db', fixture.dbPath, '--apply', '--yes', '--json'
    ], scheduledEnv);
    assert.equal(removed.code, 0, removed.stderr);
    assert.match(JSON.parse(removed.stdout).backup?.fileName || '', /scheduled-collect-repair/);

    const repaired = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      assert.equal(repaired.prepare(`
        SELECT COUNT(*) AS count FROM token_events
        WHERE source = 'WorkBuddy' AND session_id = 'workbuddy:trace_fixture_identity'
      `).get().count, 1);
      assert.equal(repaired.prepare(`
        SELECT total_tokens AS totalTokens FROM daily_usage WHERE source = 'WorkBuddy'
      `).get().totalTokens, 240);
    } finally {
      repaired.close();
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test('manual WorkBuddy refresh rereads an unchanged trace without widening scheduled scans', async () => {
  const fixture = createWorkBuddyIdentityFixture();
  try {
    const first = await runNode([
      'src/collect.ts', '--sources=workbuddy', '--db', fixture.dbPath, '--apply', '--yes', '--json'
    ], fixture.env);
    assert.equal(first.code, 0, first.stderr);

    const oldTime = new Date(Date.now() - 60_000);
    utimesSync(fixture.tracePath, oldTime, oldTime);
    const refreshed = await runNode([
      'src/collect.ts', '--sources=workbuddy', '--db', fixture.dbPath, '--apply', '--yes', '--json'
    ], {
      ...fixture.env,
      TOKEN_WORK_COLLECT_REASON: 'live-refresh',
      TOKEN_WORK_SCHEDULED_INCREMENTAL: '1',
      TOKEN_WORK_FULL_REFRESH_SOURCES: 'workbuddy'
    });
    assert.equal(refreshed.code, 0, refreshed.stderr);
    assert.equal(JSON.parse(refreshed.stdout).sources[0].tokenEvents, 1);
  } finally {
    cleanupFixture(fixture);
  }
});

test('collect does not recount token history copied into a forked Codex session', async () => {
  const fixture = createForkedCodexFixture();
  try {
    const result = await runNode([
      'src/collect.ts',
      '--sources=codex',
      '--db',
      fixture.dbPath,
      '--dry-run',
      '--json'
    ], fixture.env);
    assert.equal(result.code, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    const codex = summary.sources.find((source: CollectSourceSummary) => source.id === 'codex');
    assert.equal(codex.tokenEvents, 3);
    assert.equal(codex.totalTokens, 170);
  } finally {
    cleanupFixture(fixture);
  }
});

test('collect clears a stale aggregate for a fully replayed Codex fork', async () => {
  const fixture = createForkedCodexFixture();
  const sessionPath = join(fixture.codexHome, 'sessions', '2026', '06', '17', 'replayed-child.jsonl');
  try {
    writeFileSync(sessionPath, [
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'replayed-child', parent_thread_id: 'parent', forked_from_id: 'parent',
          timestamp: '2026-06-17T02:05:00.000Z', originator: 'codex-tui'
        }
      }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.4-mini' } }),
      JSON.stringify({
        type: 'event_msg', timestamp: '2026-06-17T02:05:00.000Z',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100 } } }
      }),
      JSON.stringify({
        type: 'event_msg', timestamp: '2026-06-17T02:05:00.001Z',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 150 } } }
      })
    ].join('\n'), 'utf8');

    let result = await runNode([
      'src/collect.ts', '--sources=codex', '--db', fixture.dbPath, '--apply', '--yes', '--json'
    ], fixture.env);
    assert.equal(result.code, 0, result.stderr);

    const db = new DatabaseSync(fixture.dbPath);
    try {
      db.prepare(`
        INSERT INTO session_usage (device, source, session_id, model, total_tokens)
        VALUES (?, 'Codex CLI', 'local:codex:replayed-child:gpt-5.4-mini', 'gpt-5.4-mini', 150)
      `).run(hostname());
    } finally {
      db.close();
    }

    result = await runNode([
      'src/collect.ts', '--sources=codex', '--db', fixture.dbPath, '--apply', '--yes', '--json'
    ], fixture.env);
    assert.equal(result.code, 0, result.stderr);

    const repaired = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      assert.equal(repaired.prepare(`
        SELECT total_tokens AS totalTokens FROM session_usage
        WHERE source = 'Codex CLI' AND session_id = 'local:codex:replayed-child:gpt-5.4-mini'
      `).get().totalTokens, 0);
    } finally {
      repaired.close();
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test('collect keeps a fork aggregate when its token log cannot be fully parsed', async () => {
  const fixture = createForkedCodexFixture();
  const sessionPath = join(fixture.codexHome, 'sessions', '2026', '06', 'damaged-child.jsonl');
  try {
    writeFileSync(sessionPath, [
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'damaged-child', parent_thread_id: 'parent', forked_from_id: 'parent',
          timestamp: '2026-06-17T02:05:00.000Z', originator: 'codex-tui'
        }
      }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.4-mini' } }),
      JSON.stringify({
        type: 'event_msg', timestamp: '2026-06-17T02:05:00.000Z',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100 } } }
      }),
      '{"type":"event_msg","payload":{"type":"token_count"'
    ].join('\n'), 'utf8');

    let result = await runNode([
      'src/collect.ts', '--sources=codex', '--db', fixture.dbPath, '--apply', '--yes', '--json'
    ], fixture.env);
    assert.equal(result.code, 0, result.stderr);

    const db = new DatabaseSync(fixture.dbPath);
    try {
      db.prepare(`
        INSERT INTO session_usage (device, source, session_id, model, total_tokens)
        VALUES (?, 'Codex CLI', 'local:codex:damaged-child:gpt-5.4-mini', 'gpt-5.4-mini', 100)
      `).run(hostname());
    } finally {
      db.close();
    }

    result = await runNode([
      'src/collect.ts', '--sources=codex', '--db', fixture.dbPath, '--apply', '--yes', '--json'
    ], fixture.env);
    assert.equal(result.code, 0, result.stderr);

    const preserved = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      assert.equal(preserved.prepare(`
        SELECT total_tokens AS totalTokens FROM session_usage
        WHERE source = 'Codex CLI' AND session_id = 'local:codex:damaged-child:gpt-5.4-mini'
      `).get().totalTokens, 100);
    } finally {
      preserved.close();
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test('collect reclassifies legacy Codex records when session metadata identifies the desktop client', async () => {
  const fixture = createCollectorFixture();
  const sessionPath = join(fixture.codexHome, 'sessions', '2026', '06', '17', 'codex-session.jsonl');
  try {
    const first = await runNode([
      'src/collect.ts', '--sources=codex', '--db', fixture.dbPath, '--apply', '--yes', '--json'
    ], fixture.env);
    assert.equal(first.code, 0, first.stderr);

    const lines = readFileSync(sessionPath, 'utf8').trim().split('\n');
    const metadata = JSON.parse(lines[0]);
    metadata.payload.originator = 'Codex Desktop';
    lines[0] = JSON.stringify(metadata);
    writeFileSync(sessionPath, `${lines.join('\n')}\n`, 'utf8');

    const second = await runNode([
      'src/collect.ts', '--sources=codex', '--db', fixture.dbPath, '--apply', '--yes', '--json'
    ], fixture.env);
    assert.equal(second.code, 0, second.stderr);

    const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      assert.deepEqual(db.prepare(`
        SELECT source, COUNT(*) AS count
        FROM token_events
        WHERE session_id LIKE 'local:codex:%'
        GROUP BY source
      `).all().map(row => ({ ...row })), [{ source: 'Codex Desktop', count: 2 }]);
      assert.deepEqual(db.prepare(`
        SELECT source, COALESCE(SUM(total_tokens), 0) AS totalTokens
        FROM daily_usage
        WHERE source LIKE 'Codex%'
        GROUP BY source
      `).all().map(row => ({ ...row })), [{ source: 'Codex Desktop', totalTokens: 150 }]);
    } finally {
      db.close();
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test('collect reads the Codex Desktop model from thread settings before token counters', async () => {
  const fixture = createCollectorFixture();
  const sessionPath = join(fixture.codexHome, 'sessions', '2026', '06', '17', 'codex-session.jsonl');
  try {
    writeFileSync(sessionPath, [
      JSON.stringify({ type: 'session_meta', payload: { id: 'desktop-settings', originator: 'Codex Desktop' } }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-5.6-terra' } }
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-06-17T02:00:00.000Z',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 80, output_tokens: 20 },
            last_token_usage: { input_tokens: 80, output_tokens: 20 }
          }
        }
      })
    ].join('\n'), 'utf8');

    const result = await runNode([
      'src/collect.ts', '--sources=codex', '--db', fixture.dbPath, '--apply', '--yes', '--json'
    ], fixture.env);
    assert.equal(result.code, 0, result.stderr);

    const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      assert.deepEqual(db.prepare(`
        SELECT source, model,
          input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens + reasoning_tokens AS totalTokens
        FROM token_events
      `).all().map(row => ({ ...row })), [{
        source: 'Codex Desktop', model: 'gpt-5.6-terra', totalTokens: 100
      }]);
    } finally {
      db.close();
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test('collect removes an unlinked zero-token Codex session with no model', async () => {
  const fixture = createCollectorFixture();
  const emptySessionPath = join(fixture.codexHome, 'sessions', '2026', '06', '17', 'desktop-empty.jsonl');
  try {
    writeFileSync(emptySessionPath, JSON.stringify({
      type: 'session_meta',
      payload: { id: 'desktop-empty', originator: 'Codex Desktop' }
    }) + '\n', 'utf8');

    const first = await runNode([
      'src/collect.ts', '--sources=codex', '--db', fixture.dbPath, '--apply', '--yes', '--json'
    ], fixture.env);
    assert.equal(first.code, 0, first.stderr);

    const db = new DatabaseSync(fixture.dbPath);
    try {
      db.prepare(`
        INSERT INTO session_usage (device, source, session_id, model, total_tokens)
        VALUES (?, ?, ?, 'unknown', 0)
      `).run(hostname(), 'Codex (unidentified client)', 'local:codex:desktop-empty:unknown');
    } finally {
      db.close();
    }

    const second = await runNode([
      'src/collect.ts', '--sources=codex', '--db', fixture.dbPath, '--apply', '--yes', '--json'
    ], fixture.env);
    assert.equal(second.code, 0, second.stderr);

    const repaired = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      assert.equal(repaired.prepare(`
        SELECT COUNT(*) AS count
        FROM session_usage
        WHERE device = ? AND session_id = 'local:codex:desktop-empty:unknown'
      `).get(hostname()).count, 0);
    } finally {
      repaired.close();
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test('collect preserves local Codex daily records without matching events or sessions', async () => {
  const fixture = createCollectorFixture();
  try {
    const first = await runNode(['src/collect.ts', '--sources=codex', '--db', fixture.dbPath, '--apply', '--yes', '--json'], fixture.env);
    assert.equal(first.code, 0, first.stderr);
    const db = new DatabaseSync(fixture.dbPath);
    try {
      db.prepare(`INSERT INTO daily_usage (device, source, usage_date, model, total_tokens) VALUES (?, ?, '2026-01-01', 'gpt-5.5', 777)`).run(
        hostname(), 'Codex (unidentified client)'
      );
    } finally { db.close(); }
    const second = await runNode(['src/collect.ts', '--sources=codex', '--db', fixture.dbPath, '--apply', '--yes', '--json'], fixture.env);
    assert.equal(second.code, 0, second.stderr);
    const repaired = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      assert.equal(repaired.prepare(`SELECT COUNT(*) AS count FROM daily_usage WHERE source = 'Codex (unidentified client)'`).get().count, 1);
    } finally { repaired.close(); }
  } finally { cleanupFixture(fixture); }
});

test('collect reconciles current Codex events while preserving historical usage', async () => {
  const fixture = createForkedCodexFixture();
  try {
    const first = await runNode([
      'src/collect.ts',
      '--sources=codex',
      '--db',
      fixture.dbPath,
      '--apply',
      '--yes',
      '--json'
    ], fixture.env);
    assert.equal(first.code, 0, first.stderr);

    const db = new DatabaseSync(fixture.dbPath);
    try {
      db.prepare(`
        INSERT INTO token_events (
          event_id, device, source, session_id, timestamp, model, input_tokens
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        'legacy-fork-event',
        hostname(),
        'Codex CLI',
        'local:codex:child_1:gpt-5.4-mini',
        '2026-06-17T02:05:00.000Z',
        'gpt-5.4-mini',
        999
      );
      db.prepare(`
        INSERT INTO token_events (
          event_id, device, source, session_id, timestamp, model, input_tokens
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        'similarly-named-event',
        hostname(),
        'Codex CLI',
        'local:codex:childX1:gpt-5.4-mini',
        '2026-06-17T02:05:00.000Z',
        'gpt-5.4-mini',
        777
      );
      db.prepare(`
        INSERT INTO token_events (
          event_id, device, source, session_id, timestamp, model, input_tokens
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        'codex:stale-event',
        hostname(),
        'Codex CLI',
        'local:codex:parent:gpt-5.4-mini',
        '2026-06-17T02:05:00.000Z',
        'gpt-5.4-mini',
        999
      );
      db.prepare(`
        INSERT INTO token_events (
          event_id, device, source, session_id, timestamp, model, input_tokens
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        'codex:unscanned-event',
        hostname(),
        'Codex CLI',
        'local:codex:unscanned-session:gpt-5.4-mini',
        '2026-06-17T02:05:00.000Z',
        'gpt-5.4-mini',
        777
      );
      db.prepare(`
        INSERT INTO session_usage (device, source, session_id, model, total_tokens)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        hostname(),
        'Codex CLI',
        'local:codex:unscanned-session:gpt-5.4-mini',
        'gpt-5.4-mini',
        0
      );
      db.prepare(`
        INSERT INTO daily_usage (device, source, usage_date, model, total_tokens)
        VALUES (?, ?, ?, ?, ?)
      `).run(hostname(), 'Codex CLI', '2026-06-17', 'legacy-model', 999);
    } finally {
      db.close();
    }

    const second = await runNode([
      'src/collect.ts',
      '--sources=codex',
      '--db',
      fixture.dbPath,
      '--apply',
      '--yes',
      '--json'
    ], fixture.env);
    assert.equal(second.code, 0, second.stderr);

    const repaired = new DatabaseSync(fixture.dbPath);
    try {
      assert.equal(repaired.prepare(`
        SELECT COUNT(*) AS count FROM token_events WHERE event_id = 'legacy-fork-event'
      `).get().count, 0);
      assert.equal(repaired.prepare(`
        SELECT COUNT(*) AS count FROM token_events WHERE event_id = 'similarly-named-event'
      `).get().count, 1);
      assert.equal(repaired.prepare(`
        SELECT COUNT(*) AS count FROM token_events WHERE event_id = 'codex:stale-event'
      `).get().count, 0);
      assert.equal(repaired.prepare(`
        SELECT COUNT(*) AS count FROM token_events WHERE event_id = 'codex:unscanned-event'
      `).get().count, 1);
      assert.equal(repaired.prepare(`
        SELECT total_tokens AS totalTokens FROM session_usage
        WHERE source = 'Codex (unidentified client)' AND session_id = 'local:codex:unscanned-session:gpt-5.4-mini'
      `).get().totalTokens, 777);
      assert.equal(repaired.prepare(`
        SELECT COUNT(*) AS count FROM daily_usage
        WHERE source = 'Codex CLI' AND usage_date = '2026-06-17' AND model = 'legacy-model'
      `).get().count, 0);
      assert.equal(repaired.prepare(`
        SELECT total_tokens AS totalTokens FROM daily_usage
        WHERE source = 'Codex CLI' AND usage_date = '2026-06-17' AND model = 'gpt-5.4-mini'
      `).get().totalTokens, 170);
    } finally {
      repaired.close();
    }

  } finally {
    cleanupFixture(fixture);
  }
});

test('scheduled Codex collection preserves unchanged session events', async () => {
  const fixture = createCollectorFixture();
  try {
    const unchangedPath = join(fixture.codexHome, 'sessions', '2026', '06', '17', 'unchanged-session.jsonl');
    writeFileSync(unchangedPath, [
      JSON.stringify({ type: 'session_meta', payload: { id: 'unchanged-session', originator: 'codex-tui' } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.4-mini' } }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-06-17T02:30:00.000Z',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 50 }, last_token_usage: { input_tokens: 50 } }
        }
      })
    ].join('\n'), 'utf8');
    const initial = await runNode([
      'src/collect.ts',
      '--sources=codex',
      '--db',
      fixture.dbPath,
      '--apply',
      '--yes',
      '--json'
    ], {
      ...fixture.env,
      TOKEN_WORK_COLLECT_REASON: 'scheduled',
      TOKEN_WORK_SCHEDULED_INCREMENTAL: '1'
    });
    assert.equal(initial.code, 0, initial.stderr);
    assert.equal(JSON.parse(initial.stdout).sources[0].candidateFiles, 2);
    const before = new DatabaseSync(fixture.dbPath, { readOnly: true });
    let eventCount;
    let unchangedDailyTotal;
    try {
      eventCount = before.prepare(`SELECT COUNT(*) AS count FROM token_events WHERE source = 'Codex CLI'`).get().count;
      unchangedDailyTotal = before.prepare(`
        SELECT total_tokens AS totalTokens
        FROM daily_usage
        WHERE source = 'Codex CLI' AND usage_date = '2026-06-17' AND model = 'gpt-5.4-mini'
      `).get().totalTokens;
    } finally {
      before.close();
    }

    const codexPath = join(fixture.codexHome, 'sessions', '2026', '06', '17', 'codex-session.jsonl');
    const refreshedAt = new Date(Date.now() + 1_000).toISOString();
    writeFileSync(codexPath, [
      readFileSync(codexPath, 'utf8').trim(),
      JSON.stringify({
        type: 'event_msg',
        timestamp: refreshedAt,
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 100 },
            last_token_usage: { input_tokens: 20 }
          }
        }
      })
    ].join('\n'), 'utf8');
    const refreshed = await runNode([
      'src/collect.ts',
      '--sources=codex',
      '--db',
      fixture.dbPath,
      '--apply',
      '--yes',
      '--json'
    ], {
      ...fixture.env,
      TOKEN_WORK_COLLECT_REASON: 'scheduled',
      TOKEN_WORK_SCHEDULED_INCREMENTAL: '1'
    });
    assert.equal(refreshed.code, 0, refreshed.stderr);
    const changed = JSON.parse(refreshed.stdout);
    assert.equal(changed.sources[0].candidateFiles, 1);
    assert.equal(changed.sources[0].tokenEvents, 3);
    const after = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      assert.equal(after.prepare(`SELECT COUNT(*) AS count FROM token_events WHERE source = 'Codex CLI'`).get().count, eventCount + 1);
      assert.equal(after.prepare(`
        SELECT COUNT(*) AS count FROM token_events
        WHERE source = 'Codex CLI' AND session_id LIKE 'local:codex:unchanged-session:%'
      `).get().count, 1);
      assert.equal(after.prepare(`
        SELECT total_tokens AS totalTokens
        FROM daily_usage
        WHERE source = 'Codex CLI' AND usage_date = '2026-06-17' AND model = 'gpt-5.4-mini'
      `).get().totalTokens, unchangedDailyTotal);
    } finally {
      after.close();
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test('scheduled Codex collection does not rescan an unchanged fork parent', async () => {
  const fixture = createCollectorFixture();
  try {
    const sessionsDir = join(fixture.codexHome, 'sessions', '2026', '06', '17');
    const parentId = 'parent-session';
    const childId = 'child-session';
    writeFileSync(join(sessionsDir, `${parentId}.jsonl`), [
      JSON.stringify({ type: 'session_meta', payload: { id: parentId, originator: 'codex-tui' } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.4-mini' } }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-06-17T03:00:00.000Z',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 20 }, last_token_usage: { input_tokens: 20 } } }
      })
    ].join('\n'), 'utf8');
    const childPath = join(sessionsDir, `${childId}.jsonl`);
    writeFileSync(childPath, [
      JSON.stringify({ type: 'session_meta', payload: { id: childId, parent_thread_id: parentId, timestamp: '2026-06-17T03:00:00.000Z', originator: 'codex-tui' } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.4-mini' } }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-06-17T03:05:00.000Z',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 30 }, last_token_usage: { input_tokens: 10 } } }
      })
    ].join('\n'), 'utf8');

    const initial = await runNode([
      'src/collect.ts', '--sources=codex', '--db', fixture.dbPath, '--apply', '--yes', '--json'
    ], { ...fixture.env, TOKEN_WORK_COLLECT_REASON: 'scheduled', TOKEN_WORK_SCHEDULED_INCREMENTAL: '1' });
    assert.equal(initial.code, 0, initial.stderr);

    const refreshedAt = new Date(Date.now() + 1_000).toISOString();
    writeFileSync(childPath, [
      readFileSync(childPath, 'utf8').trim(),
      JSON.stringify({
        type: 'event_msg',
        timestamp: refreshedAt,
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 40 }, last_token_usage: { input_tokens: 10 } } }
      })
    ].join('\n'), 'utf8');

    const refreshed = await runNode([
      'src/collect.ts', '--sources=codex', '--db', fixture.dbPath, '--apply', '--yes', '--json'
    ], { ...fixture.env, TOKEN_WORK_COLLECT_REASON: 'scheduled', TOKEN_WORK_SCHEDULED_INCREMENTAL: '1' });
    assert.equal(refreshed.code, 0, refreshed.stderr);
    assert.equal(JSON.parse(refreshed.stdout).sources[0].candidateFiles, 1);
  } finally {
    cleanupFixture(fixture);
  }
});

test('scheduled Codex collection reclassifies a session without duplicating its usage', async () => {
  const fixture = createCollectorFixture();
  const sessionPath = join(fixture.codexHome, 'sessions', '2026', '06', '17', 'codex-session.jsonl');
  const scheduledEnv = {
    ...fixture.env,
    TOKEN_WORK_COLLECT_REASON: 'scheduled',
    TOKEN_WORK_SCHEDULED_INCREMENTAL: '1'
  };
  try {
    const initial = await runNode([
      'src/collect.ts', '--sources=codex', '--db', fixture.dbPath, '--apply', '--yes', '--json'
    ], scheduledEnv);
    assert.equal(initial.code, 0, initial.stderr);

    const lines = readFileSync(sessionPath, 'utf8').trim().split('\n');
    const metadata = JSON.parse(lines[0]);
    metadata.payload.originator = 'Codex Desktop';
    lines[0] = JSON.stringify(metadata);
    writeFileSync(sessionPath, `${lines.join('\n')}\n`, 'utf8');
    utimesSync(sessionPath, new Date(), new Date(Date.now() + 1_000));

    const refreshed = await runNode([
      'src/collect.ts', '--sources=codex', '--db', fixture.dbPath, '--apply', '--yes', '--json'
    ], scheduledEnv);
    assert.equal(refreshed.code, 0, refreshed.stderr);

    const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      assert.deepEqual(db.prepare(`
        SELECT source, COALESCE(SUM(total_tokens), 0) AS totalTokens
        FROM daily_usage
        WHERE source LIKE 'Codex%'
        GROUP BY source
      `).all().map(row => ({ ...row })), [{ source: 'Codex Desktop', totalTokens: 150 }]);
      assert.equal(db.prepare(`
        SELECT COUNT(*) AS count FROM token_events WHERE source = 'Codex CLI'
      `).get().count, 0);
    } finally {
      db.close();
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test('scheduled Codex collection preserves history after local session logs are deleted', async () => {
  const fixture = createCollectorFixture();
  try {
    const initial = await runNode([
      'src/collect.ts', '--sources=codex', '--db', fixture.dbPath, '--apply', '--yes', '--json'
    ], fixture.env);
    assert.equal(initial.code, 0, initial.stderr);

    const db = new DatabaseSync(fixture.dbPath);
    try {
      for (const table of ['token_events', 'session_usage', 'daily_usage']) {
        db.prepare(`UPDATE ${table} SET source = ? WHERE source = ?`).run('Codex (unidentified client)', 'Codex CLI');
      }
    } finally {
      db.close();
    }
    rmSync(fixture.codexHome, { recursive: true, force: true });

    const refreshed = await runNode([
      'src/collect.ts', '--sources=codex', '--db', fixture.dbPath, '--apply', '--yes', '--json'
    ], {
      ...fixture.env,
      TOKEN_WORK_COLLECT_REASON: 'scheduled',
      TOKEN_WORK_SCHEDULED_INCREMENTAL: '1'
    });
    assert.equal(refreshed.code, 0, refreshed.stderr);
    const refreshSummary = JSON.parse(refreshed.stdout);
    assert.equal(refreshSummary.sources[0].candidateFiles, 0);
    assert.equal(refreshSummary.backup, null);

    const repaired = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      assert.ok(Number(repaired.prepare(`SELECT COUNT(*) AS count FROM token_events WHERE source = 'Codex (unidentified client)'`).get().count) > 0);
      assert.equal(repaired.prepare(`
        SELECT total_tokens AS totalTokens FROM daily_usage
        WHERE source = 'Codex (unidentified client)' AND model = 'gpt-5.4-mini'
      `).get().totalTokens, 50);
    } finally {
      repaired.close();
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test('incremental Codex refresh reads only the changed tail of a large session', async () => {
  const fixture = createCollectorFixture();
  try {
    const sessionPath = join(fixture.codexHome, 'sessions', '2026', '06', '17', 'tail-session.jsonl');
    const padding = JSON.stringify({ type: 'note', payload: { text: 'x'.repeat(512) } });
    writeFileSync(sessionPath, [
      JSON.stringify({ type: 'session_meta', payload: { id: 'tail-session', originator: 'codex-tui' } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.4-mini' } }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-06-17T04:00:00.000Z',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10 }, last_token_usage: { input_tokens: 10 } } }
      }),
      ...Array.from({ length: 8_500 }, () => padding)
    ].join('\n'), 'utf8');

    const initial = await runNode([
      'src/collect.ts', '--sources=codex', '--db', fixture.dbPath, '--apply', '--yes', '--json'
    ], { ...fixture.env, TOKEN_WORK_COLLECT_REASON: 'manual', TOKEN_WORK_SCHEDULED_INCREMENTAL: '1' });
    assert.equal(initial.code, 0, initial.stderr);

    const refreshedAt = new Date(Date.now() + 1_000).toISOString();
    writeFileSync(sessionPath, [
      readFileSync(sessionPath, 'utf8').trim(),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.4-mini' } }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: refreshedAt,
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 30 }, last_token_usage: { input_tokens: 20 } } }
      })
    ].join('\n'), 'utf8');

    const refreshed = await runNode([
      'src/collect.ts', '--sources=codex', '--db', fixture.dbPath, '--apply', '--yes', '--json'
    ], { ...fixture.env, TOKEN_WORK_COLLECT_REASON: 'manual', TOKEN_WORK_SCHEDULED_INCREMENTAL: '1' });
    assert.equal(refreshed.code, 0, refreshed.stderr);
    assert.equal(JSON.parse(refreshed.stdout).sources[0].tokenEvents, 1);

    const db = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      assert.equal(db.prepare(`
        SELECT total_tokens AS totalTokens
        FROM session_usage
        WHERE source = 'Codex CLI' AND session_id = 'local:codex:tail-session:gpt-5.4-mini'
      `).get().totalTokens, 30);
    } finally {
      db.close();
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test('collect keeps distinct Codex and Claude events without relying on file position', async () => {
  const fixture = createCollectorFixture();
  try {
    writeFileSync(join(fixture.claudeRoot, 'projects', 'token-work', 'anonymous.jsonl'), [
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-06-17T02:00:00.000Z',
        localRecordId: 'first',
        message: {
          model: 'claude-sonnet-4-5',
          usage: { input_tokens: 11, output_tokens: 2 }
        }
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-06-17T02:00:00.000Z',
        localRecordId: 'second',
        message: {
          model: 'claude-sonnet-4-5',
          usage: { input_tokens: 11, output_tokens: 2 }
        }
      })
    ].join('\n'), 'utf8');
    writeFileSync(join(fixture.codexHome, 'sessions', '2026', '06', '17', 'same-timestamp.jsonl'), [
      JSON.stringify({ type: 'session_meta', payload: { id: 'same-timestamp', originator: 'codex-tui' } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.4-mini' } }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-06-17T04:00:00.000Z',
        payload: {
          type: 'token_count', request_id: 'first',
          info: { total_token_usage: { input_tokens: 10 } }
        }
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-06-17T04:00:00.000Z',
        payload: {
          type: 'token_count', request_id: 'second',
          info: { total_token_usage: { input_tokens: 20 } }
        }
      })
    ].join('\n'), 'utf8');

    const result = await runNode([
      'src/collect.ts',
      '--sources=claude,codex',
      '--db',
      fixture.dbPath,
      '--apply',
      '--yes',
      '--json'
    ], fixture.env);
    assert.equal(result.code, 0, result.stderr);

    const db = new DatabaseSync(fixture.dbPath);
    try {
      const totals = db.prepare(`
        SELECT
          COUNT(*) AS eventCount,
          COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens + reasoning_tokens), 0) AS eventTokens
        FROM token_events
        WHERE source = 'Claude Code' AND session_id LIKE 'local:claude:anonymous:%'
      `).get();
      assert.equal(totals.eventCount, 2);
      assert.equal(totals.eventTokens, 26);
      const codex = db.prepare(`
        SELECT COUNT(*) AS eventCount, SUM(input_tokens) AS inputTokens
        FROM token_events
        WHERE source = 'Codex CLI' AND session_id LIKE 'local:codex:same-timestamp:%'
      `).get();
      assert.equal(codex.eventCount, 2);
      assert.equal(codex.inputTokens, 20);
    } finally {
      db.close();
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test('collect retains the request that follows a Codex counter reset', async () => {
  const fixture = createResettingCodexFixture();
  try {
    const result = await runNode([
      'src/collect.ts',
      '--sources=codex',
      '--db',
      fixture.dbPath,
      '--dry-run',
      '--json'
    ], fixture.env);
    assert.equal(result.code, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    const codex = summary.sources.find((source: CollectSourceSummary) => source.id === 'codex');
    assert.equal(codex.tokenEvents, 3);
    assert.equal(codex.totalTokens, 170);
  } finally {
    cleanupFixture(fixture);
  }
});

test('collect keeps post-fork usage when the parent Codex transcript is unavailable', async () => {
  const fixture = createUnresolvedForkedCodexFixture();
  try {
    const result = await runNode([
      'src/collect.ts',
      '--sources=codex',
      '--db',
      fixture.dbPath,
      '--dry-run',
      '--json'
    ], fixture.env);
    assert.equal(result.code, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    const codex = summary.sources.find((source: CollectSourceSummary) => source.id === 'codex');
    assert.equal(codex.tokenEvents, 1);
    assert.equal(codex.totalTokens, 100);
  } finally {
    cleanupFixture(fixture);
  }
});

test('collect prefers an OpenClaw live transcript over its archived copy', async () => {
  const fixture = createOpenClawArchiveFixture();
  try {
    const result = await runNode([
      'src/collect.ts',
      '--sources=openclaw',
      '--db',
      fixture.dbPath,
      '--dry-run',
      '--json'
    ], fixture.env);
    assert.equal(result.code, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    const openclaw = summary.sources.find((source: CollectSourceSummary) => source.id === 'openclaw');
    assert.equal(openclaw.dailyTotalTokens, 10);
    assert.equal(openclaw.sessionTotalTokens, 10);
  } finally {
    cleanupFixture(fixture);
  }
});

test('collect retains distinct OpenClaw history from an archived transcript', async () => {
  const fixture = createOpenClawArchiveFixture({ includeArchivedHistory: true });
  try {
    const result = await runNode([
      'src/collect.ts',
      '--sources=openclaw',
      '--db',
      fixture.dbPath,
      '--dry-run',
      '--json'
    ], fixture.env);
    assert.equal(result.code, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    const openclaw = summary.sources.find((source: CollectSourceSummary) => source.id === 'openclaw');
    assert.equal(openclaw.dailyTotalTokens, 17);
    assert.equal(openclaw.sessionTotalTokens, 17);
  } finally {
    cleanupFixture(fixture);
  }
});

test('coverage command returns historical coverage risk and reconciliation', async () => {
  const fixture = createCollectorFixture();
  try {
    const result = await runNode([
      'src/cli.ts',
      'coverage',
      '--sources=claude,codex,cursor',
      '--json'
    ], fixture.env);
    assert.equal(result.code, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    const byId = new Map<string, CollectSourceSummary>(summary.sources.map((row: CollectSourceSummary) => [row.id, row]));
    assert.equal(byId.get('claude').coverageRisk, 'trusted-event-level');
    assert.equal(byId.get('codex').coverageRisk, 'trusted-event-level');
    assert.ok(byId.get('claude').reconciliation.dailyVsEventDiffPct <= 0.01);
    assert.ok(byId.get('codex').reconciliation.sessionVsEventDiffPct <= 0.01);
    assert.equal(summary.totals.fatalCoverageErrors, 0);
  } finally {
    cleanupFixture(fixture);
  }
});

test('collect removes only unassociated zero-token Claude placeholders', async () => {
  const fixture = createCollectorFixture();
  try {
    const initial = await runNode([
      'src/collect.ts', '--sources=claude', '--db', fixture.dbPath, '--apply', '--yes', '--json'
    ], fixture.env);
    assert.equal(initial.code, 0, initial.stderr);

    const device = hostname();
    const db = new DatabaseSync(fixture.dbPath);
    try {
      const insertSession = db.prepare(`
        INSERT INTO session_usage(device, source, session_id, model, input_tokens, total_tokens)
        VALUES (?, 'Claude Code', ?, '<synthetic>', ?, ?)
      `);
      insertSession.run(device, 'remove:<synthetic>', 0, 0);
      insertSession.run(device, 'keep-annotation:<synthetic>', 0, 0);
      insertSession.run(device, 'keep-usage:<synthetic>', 1, 1);
      insertSession.run(device, 'remove-event:<synthetic>', 0, 0);
      db.prepare(`
        INSERT INTO session_annotations(device, source, session_id)
        VALUES (?, 'Claude Code', 'keep-annotation:<synthetic>')
      `).run(device);
      db.prepare(`
        INSERT INTO token_events(event_id, device, source, session_id, timestamp, model)
        VALUES ('placeholder-event', ?, 'Claude Code', 'remove-event:<synthetic>', '2026-08-09T00:00:00Z', '<synthetic>')
      `).run(device);
      db.prepare(`
        INSERT INTO daily_usage(device, source, usage_date, model)
        VALUES (?, 'Claude Code', '2026-08-09', '<synthetic>')
      `).run(device);
    } finally {
      db.close();
    }

    const cleaned = await runNode([
      'src/collect.ts', '--sources=claude', '--db', fixture.dbPath, '--apply', '--yes', '--json'
    ], { ...fixture.env, TOKEN_WORK_COLLECT_REASON: 'scheduled' });
    assert.equal(cleaned.code, 0, cleaned.stderr);
    const summary = JSON.parse(cleaned.stdout);
    assert.match(summary.backup?.fileName || '', /scheduled-collect-repair/);

    const after = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      assert.deepEqual(after.prepare(`
        SELECT session_id AS sessionId, total_tokens AS totalTokens
        FROM session_usage
        WHERE source = 'Claude Code' AND instr(session_id, '<synthetic>') > 0
        ORDER BY session_id
      `).all().map(row => ({ ...row })), [
        { sessionId: 'keep-annotation:<synthetic>', totalTokens: 0 },
        { sessionId: 'keep-usage:<synthetic>', totalTokens: 1 }
      ]);
      assert.equal(after.prepare(`SELECT COUNT(*) AS count FROM session_annotations WHERE session_id = 'keep-annotation:<synthetic>'`).get().count, 1);
      assert.equal(after.prepare(`SELECT COUNT(*) AS count FROM token_events WHERE model = '<synthetic>'`).get().count, 0);
      assert.equal(after.prepare(`SELECT COUNT(*) AS count FROM daily_usage WHERE model = '<synthetic>'`).get().count, 0);
    } finally {
      after.close();
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test('collect apply writes temp SQLite with backup and before/after counts', async () => {
  const fixture = createCollectorFixture();
  try {
    const result = await runNode([
      'src/collect.ts',
      '--sources=claude,codex,cursor',
      '--db',
      fixture.dbPath,
      '--apply',
      '--yes',
      '--json'
    ], fixture.env);
    assert.equal(result.code, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.mode, 'apply');
    assert.equal(summary.before.sessionRows, 0);
    assert.ok(summary.after.sessionRows >= 3);
    assert.ok(summary.after.tokenEvents >= 1);
    assert.ok(summary.after.collectionRuns >= 3);
    assert.ok(summary.backup?.path);
    assert.equal(existsSync(summary.backup.path), true);

    const db = new DatabaseSync(fixture.dbPath);
    let legacyEventId;
    let eventCount;
    let runCount;
    try {
      assert.ok(Number(db.prepare('SELECT COUNT(*) AS count FROM session_usage').get().count) >= 3);
      assert.ok(Number(db.prepare('SELECT COUNT(*) AS count FROM token_events').get().count) >= 1);
      assert.ok(Number(db.prepare('SELECT COUNT(*) AS count FROM collection_runs').get().count) >= 3);
      const codexSessions = db.prepare(`
        SELECT session_id AS sessionId, model, total_tokens AS totalTokens
        FROM session_usage
        WHERE source = 'Codex CLI'
        ORDER BY model
      `).all();
      assert.deepEqual(codexSessions.map(row => [row.model, row.totalTokens]), [
        ['gpt-5.3-codex', 100],
        ['gpt-5.4-mini', 50]
      ]);
      const claudeSessions = db.prepare(`
        SELECT model, total_tokens AS totalTokens
        FROM session_usage
        WHERE source = 'Claude Code'
        ORDER BY model, total_tokens DESC
      `).all();
      assert.deepEqual(claudeSessions.map(row => [row.model, row.totalTokens]), [
        ['claude-opus-4-6', 72],
        ['claude-sonnet-4-5', 140],
        ['claude-sonnet-4-5', 81]
      ]);

      eventCount = db.prepare('SELECT COUNT(*) AS count FROM token_events').get().count;
      runCount = db.prepare('SELECT COUNT(*) AS count FROM collection_runs').get().count;
      const migratedEvent = db.prepare(`
        SELECT event_id AS eventId
        FROM token_events
        WHERE source = 'Codex CLI' AND model = 'gpt-5.4-mini'
      `).get();
      legacyEventId = codexEventId({
        sessionId: 'local:codex:codex-session:gpt-5.3-codex',
        timestamp: '2026-06-17T02:05:00.000Z',
        model: 'gpt-5.4-mini',
        tokens: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 2 },
        index: 1
      });
      assert.notEqual(migratedEvent.eventId, legacyEventId);
      db.prepare('UPDATE token_events SET event_id = ? WHERE event_id = ?').run(legacyEventId, migratedEvent.eventId);
    } finally {
      db.close();
    }

    const second = await runNode([
      'src/collect.ts',
      '--sources=claude,codex,cursor',
      '--db',
      fixture.dbPath,
      '--apply',
      '--yes',
      '--json'
    ], { ...fixture.env, SCHEDULED_COLLECT_ENABLED: '1' });
    assert.equal(second.code, 0, second.stderr);
    const afterMigration = new DatabaseSync(fixture.dbPath);
    try {
      assert.equal(afterMigration.prepare('SELECT COUNT(*) AS count FROM token_events').get().count, eventCount);
      assert.equal(afterMigration.prepare('SELECT COUNT(*) AS count FROM collection_runs').get().count, runCount);
      assert.equal(afterMigration.prepare('SELECT COUNT(*) AS count FROM token_events WHERE event_id = ?').get(legacyEventId).count, 0);
      assert.equal(afterMigration.prepare(`
        SELECT COUNT(*) AS count FROM token_events
        WHERE source = 'Codex CLI' AND model = 'gpt-5.4-mini'
      `).get().count, 1);
      afterMigration.prepare(`
        UPDATE session_usage
        SET last_activity = '2026-07-19T12:00:00.000Z', cost_usd = 999
        WHERE source = 'Cursor'
      `).run();
      afterMigration.prepare('UPDATE daily_usage SET cost_usd = 999').run();
    } finally {
      afterMigration.close();
    }

    const backupDir = join(fixture.dir, 'backups');
    const existingBackups = readdirSync(backupDir).filter(name => name.endsWith('.sqlite'));
    assert.equal(existingBackups.length, 1);
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    utimesSync(join(backupDir, existingBackups[0]), oldTime, oldTime);

    const unchanged = await runNode([
      'src/collect.ts',
      '--sources=claude,codex,cursor',
      '--db',
      fixture.dbPath,
      '--apply',
      '--yes',
      '--json'
    ], { ...fixture.env, SCHEDULED_COLLECT_ENABLED: '1' });
    assert.equal(unchanged.code, 0, unchanged.stderr);
    const refreshed = JSON.parse(unchanged.stdout);
    assert.ok(refreshed.backup?.path, unchanged.stderr);
    assert.equal(existsSync(refreshed.backup.path), true);
    assert.equal(
      readdirSync(backupDir).filter(name => name.endsWith('-scheduled-collect.sqlite')).length,
      1
    );
  } finally {
    cleanupFixture(fixture);
  }
});

test('token-work collect wrapper defaults to dry-run-only writes when requested', async () => {
  const fixture = createCollectorFixture();
  try {
    const result = await runNode([
      'src/cli.ts',
      'collect',
      '--sources=claude',
      '--db',
      fixture.dbPath,
      '--dry-run',
      '--json'
    ], fixture.env);
    assert.equal(result.code, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.mode, 'dry-run');
    assert.equal(existsSync(fixture.dbPath), false);
  } finally {
    cleanupFixture(fixture);
  }
});

function createCollectorFixture() {
  const dir = tempDir();
  const claudeRoot = join(dir, 'claude');
  const codexHome = join(dir, 'codex');
  const cursorRoot = join(dir, 'cursor');
  const cursorStorage = join(cursorRoot, 'User', 'globalStorage');
  mkdirSync(join(claudeRoot, 'projects', 'token-work'), { recursive: true });
  mkdirSync(join(codexHome, 'sessions', '2026', '06', '17'), { recursive: true });
  mkdirSync(cursorStorage, { recursive: true });

  writeFileSync(join(claudeRoot, 'projects', 'token-work', 'claude-session.jsonl'), [
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-06-17T01:00:00.000Z',
      requestId: 'req-1',
      message: {
        id: 'msg-1',
        model: 'claude-sonnet-4-5',
        usage: {
          input_tokens: 100,
          output_tokens: 25,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5
        }
      }
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-06-17T01:05:00.000Z',
      requestId: 'req-1-opus',
      message: {
        id: 'msg-1-opus',
        model: 'claude-opus-4-6',
        usage: {
          input_tokens: 50,
          output_tokens: 20,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 0
        }
      }
    })
  ].join('\n'), 'utf8');

  writeFileSync(join(claudeRoot, 'projects', 'token-work', 'claude-session-2.jsonl'), [
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-06-17T01:30:00.000Z',
      requestId: 'req-2',
      message: {
        id: 'msg-2',
        model: 'claude-sonnet-4-5',
        usage: {
          input_tokens: 60,
          output_tokens: 15,
          cache_read_input_tokens: 4,
          cache_creation_input_tokens: 2
        }
      }
    })
  ].join('\n'), 'utf8');

  writeFileSync(join(codexHome, 'sessions', '2026', '06', '17', 'codex-session.jsonl'), [
    JSON.stringify({ type: 'session_meta', payload: { id: 'codex-session', cwd: join(dir, 'repo'), originator: 'codex-tui' } }),
    JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.3-codex' } }),
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-06-17T02:00:00.000Z',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 80, output_tokens: 20, cached_input_tokens: 5, reasoning_output_tokens: 3 },
          total_token_usage: { input_tokens: 80, output_tokens: 20, cached_input_tokens: 5, reasoning_output_tokens: 3 }
        }
      }
    }),
    JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.4-mini' } }),
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-06-17T02:05:00.000Z',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 40, output_tokens: 10, cached_input_tokens: 0, reasoning_output_tokens: 2 },
          total_token_usage: { input_tokens: 120, output_tokens: 30, cached_input_tokens: 5, reasoning_output_tokens: 5 }
        }
      }
    })
  ].join('\n'), 'utf8');

  const cursorDb = new DatabaseSync(join(cursorStorage, 'state.vscdb'));
  try {
    cursorDb.exec('CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    cursorDb.prepare('INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)').run(
      'bubbleId:composer-1:bubble-1',
      JSON.stringify({
        conversationId: 'cursor-conversation-1',
        createdAt: '2026-06-17T03:00:00.000Z',
        modelInfo: { modelName: 'claude-sonnet-4-5' },
        tokenCount: {
          inputTokens: 120,
          outputTokens: 35
        }
      })
    );
  } finally {
    cursorDb.close();
  }

  const configPath = join(dir, 'collectors.json');
  writeFileSync(configPath, JSON.stringify({
    collectors: {
      claude: { roots: [claudeRoot], includeDesktopLocalAgent: false },
      codex: { homes: [codexHome], sessionSubdirs: ['sessions'] },
      cursor: { roots: [cursorRoot] }
    }
  }), 'utf8');

  return {
    dir,
    claudeRoot,
    codexHome,
    dbPath: join(dir, 'usage.sqlite'),
    env: {
      TOKEN_WORK_CONFIG: configPath,
      NODE_OPTIONS: '--no-warnings'
    }
  };
}

function createWorkBuddyIdentityFixture() {
  const dir = tempDir();
  const tracesDir = join(dir, 'workbuddy', 'traces', '12345');
  const sessionsDir = join(dir, 'workbuddy', 'sessions');
  mkdirSync(tracesDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  const tracePath = join(tracesDir, 'trace_fixture_identity.json');
  const siblingTracePath = join(tracesDir, 'trace_fixture_identity_extra.json');
  writeFileSync(tracePath, JSON.stringify({
    trace: {
      traceId: 'trace_fixture_identity',
      workerPid: 12345,
      startedAt: '2026-06-17T02:00:00.000Z',
      endedAt: '2026-06-17T02:01:00.000Z',
      modelInfo: { models: ['glm-5.2'] }
    },
    spans: [{
      spanId: 'span_fixture_identity',
      type: 'generation',
      startedAt: '2026-06-17T02:00:30.000Z',
      toolOutput: JSON.stringify({
        model: 'auto',
        usage: { prompt_tokens: 100, completion_tokens: 20 }
      })
    }]
  }), 'utf8');
  writeFileSync(join(sessionsDir, '12345.json'), JSON.stringify({
    sessionId: 'transient-session', cwd: join(dir, 'workspace')
  }), 'utf8');
  const configPath = join(dir, 'collectors.json');
  writeFileSync(configPath, JSON.stringify({
    collectors: {
      workbuddy: {
        root: join(dir, 'workbuddy'),
        tracesDir: join(dir, 'workbuddy', 'traces'),
        sessionsDir
      }
    }
  }), 'utf8');
  return {
    dir,
    dbPath: join(dir, 'usage.sqlite'),
    device: hostname(),
    tracePath,
    siblingTracePath,
    env: { TOKEN_WORK_CONFIG: configPath, NODE_OPTIONS: '--no-warnings' }
  };
}

function createForkedCodexFixture() {
  const dir = tempDir();
  const codexHome = join(dir, 'codex');
  const sessionDir = join(codexHome, 'sessions', '2026', '06', '17');
  mkdirSync(sessionDir, { recursive: true });
  const tokenCount = (timestamp, inputTokens) => JSON.stringify({
    type: 'event_msg',
    timestamp,
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: inputTokens },
        last_token_usage: { input_tokens: inputTokens }
      }
    }
  });
  writeFileSync(join(sessionDir, 'parent.jsonl'), [
    JSON.stringify({ type: 'session_meta', payload: { id: 'parent', timestamp: '2026-06-17T02:00:00.000Z', originator: 'codex-tui' } }),
    JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.4-mini' } }),
    tokenCount('2026-06-17T02:00:00.000Z', 100),
    tokenCount('2026-06-17T02:04:00.000Z', 150)
  ].join('\n'), 'utf8');
  writeFileSync(join(sessionDir, 'child.jsonl'), [
    JSON.stringify({
      type: 'session_meta',
      payload: {
        id: 'child_1',
        parent_thread_id: 'parent',
        forked_from_id: 'parent',
        timestamp: '2026-06-17T02:05:00.000Z',
        originator: 'codex-tui'
      }
    }),
    JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.4-mini' } }),
    tokenCount('2026-06-17T02:05:00.000Z', 100),
    tokenCount('2026-06-17T02:05:00.001Z', 150),
    tokenCount('2026-06-17T02:06:00.000Z', 170)
  ].join('\n'), 'utf8');
  const configPath = join(dir, 'collectors.json');
  writeFileSync(configPath, JSON.stringify({
    collectors: { codex: { homes: [codexHome], sessionSubdirs: ['sessions'] } }
  }), 'utf8');
  return {
    dir,
    codexHome,
    dbPath: join(dir, 'usage.sqlite'),
    env: { TOKEN_WORK_CONFIG: configPath }
  };
}

function createResettingCodexFixture() {
  const dir = tempDir();
  const codexHome = join(dir, 'codex');
  const sessionDir = join(codexHome, 'sessions');
  mkdirSync(sessionDir, { recursive: true });
  const tokenCount = (timestamp, totalTokens, lastTokens) => JSON.stringify({
    type: 'event_msg',
    timestamp,
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: totalTokens },
        last_token_usage: { input_tokens: lastTokens }
      }
    }
  });
  writeFileSync(join(sessionDir, 'reset.jsonl'), [
    JSON.stringify({ type: 'session_meta', payload: { id: 'reset', originator: 'codex-tui' } }),
    JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.4-mini' } }),
    tokenCount('2026-06-17T02:00:00.000Z', 100, 100),
    tokenCount('2026-06-17T02:01:00.000Z', 150, 50),
    tokenCount('2026-06-17T02:02:00.000Z', 20, 20)
  ].join('\n'), 'utf8');
  const configPath = join(dir, 'collectors.json');
  writeFileSync(configPath, JSON.stringify({
    collectors: { codex: { homes: [codexHome], sessionSubdirs: ['sessions'] } }
  }), 'utf8');
  return {
    dir,
    dbPath: join(dir, 'usage.sqlite'),
    env: { TOKEN_WORK_CONFIG: configPath }
  };
}

function createUnresolvedForkedCodexFixture() {
  const dir = tempDir();
  const codexHome = join(dir, 'codex');
  const sessionDir = join(codexHome, 'sessions');
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, 'child.jsonl'), [
    JSON.stringify({
      type: 'session_meta',
      payload: {
        id: 'child',
        parent_thread_id: 'missing-parent',
        forked_from_id: 'missing-parent',
        timestamp: '2026-06-17T02:00:00.000Z',
        originator: 'codex-tui'
      }
    }),
    JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.4-mini' } }),
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-06-17T02:00:01.000Z',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 100 },
          last_token_usage: { input_tokens: 100 }
        }
      }
    })
  ].join('\n'), 'utf8');
  const configPath = join(dir, 'collectors.json');
  writeFileSync(configPath, JSON.stringify({
    collectors: { codex: { homes: [codexHome], sessionSubdirs: ['sessions'] } }
  }), 'utf8');
  return {
    dir,
    dbPath: join(dir, 'usage.sqlite'),
    env: { TOKEN_WORK_CONFIG: configPath }
  };
}

function createOpenClawArchiveFixture({ includeArchivedHistory = false } = {}) {
  const dir = tempDir();
  const agentRoot = join(dir, 'openclaw');
  const sessionDir = join(agentRoot, 'main', 'sessions');
  mkdirSync(sessionDir, { recursive: true });
  const transcript = [
    JSON.stringify({ type: 'model_change', modelId: 'gpt-5.4-mini', provider: 'openai' }),
    JSON.stringify({
      type: 'message',
      message: {
        role: 'assistant',
        usage: { input: 10 }
      }
    })
  ].join('\n');
  const archivedTranscript = includeArchivedHistory
    ? [
        JSON.stringify({ type: 'model_change', modelId: 'gpt-5.4-mini', provider: 'openai' }),
        JSON.stringify({
          type: 'message',
          message: {
            role: 'assistant',
            usage: { input: 7 }
          }
        }),
        transcript
      ].join('\n')
    : transcript;
  writeFileSync(join(sessionDir, 'session-1.jsonl'), transcript, 'utf8');
  writeFileSync(join(sessionDir, 'session-1.jsonl.deleted.2026-06-17'), archivedTranscript, 'utf8');
  const configPath = join(dir, 'collectors.json');
  writeFileSync(configPath, JSON.stringify({
    collectors: { openclaw: { agentRoots: [agentRoot] } }
  }), 'utf8');
  return {
    dir,
    dbPath: join(dir, 'usage.sqlite'),
    env: { TOKEN_WORK_CONFIG: configPath }
  };
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'token-work-collect-'));
}

function cleanupFixture(fixture) {
  rmSync(fixture.dir, { recursive: true, force: true });
}

function codexEventId(payload) {
  return `codex:${createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32)}`;
}

function runNode(argv, env = {}) {
  return new Promise<ProcessResult>(resolve => {
    const child = spawn(process.execPath, argv, {
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
