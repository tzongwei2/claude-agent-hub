import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, createStore, RETENTION } from '../server/db.mjs';
import { AgentRunner, AgentManager, summariseTool } from '../server/agent-manager.mjs';

function tempStore() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-')), 'test.db');
  return createStore(openDb(file));
}

const agentInput = (over = {}) => ({ name: 'Tester', workingDirectory: process.cwd(), ...over });

/* ------------------------------ persistence ----------------------------- */

test('agents round-trip through SQLite', () => {
  const store = tempStore();
  const created = store.createAgent(agentInput({ description: 'hi', systemPrompt: 'be terse' }));
  assert.equal(created.name, 'Tester');
  assert.equal(store.getAgent(created.id).systemPrompt, 'be terse');

  store.updateAgent(created.id, { ...created, name: 'Renamed' });
  assert.equal(store.getAgent(created.id).name, 'Renamed');

  assert.equal(store.listAgents().length, 1);
  assert.ok(store.deleteAgent(created.id));
  assert.equal(store.listAgents().length, 0);
});

test('events persist per agent and survive a "restart"', () => {
  const store = tempStore();
  const a = store.createAgent(agentInput());
  const b = store.createAgent(agentInput({ name: 'Other' }));
  const sid = store.createSession(a.id, 'sess-1');

  store.appendEvent(a.id, sid, { kind: 'user', text: 'hello' });
  store.appendEvent(a.id, sid, { kind: 'assistant', text: 'hi back' });
  store.appendEvent(b.id, null, { kind: 'user', text: 'not mine' });

  const events = store.listEvents(a.id);
  assert.equal(events.length, 2);
  assert.equal(events[0].text, 'hello');
  assert.equal(store.listEvents(b.id).length, 1, 'agents are isolated');
});

test('permission events can be patched in place', () => {
  const store = tempStore();
  const a = store.createAgent(agentInput());
  const stored = store.appendEvent(a.id, null, { kind: 'permission', requestId: 'r1', status: 'pending' });
  store.replaceEvent(stored.id, { ...stored, status: 'allowed' });
  assert.equal(store.listEvents(a.id)[0].status, 'allowed');
});

test('sessions track the Claude session id for resume', () => {
  const store = tempStore();
  const a = store.createAgent(agentInput());
  const sid = store.createSession(a.id, 'row-1');
  store.setSessionClaudeId(sid, 'claude-uuid');
  store.setSessionStatus(sid, 'running');
  const latest = store.latestSession(a.id);
  assert.equal(latest.claude_session_id, 'claude-uuid');
  assert.equal(latest.status, 'running');
});

/* ------------------------------ tool naming ----------------------------- */

test('tool calls become human-readable summaries', () => {
  assert.deepEqual(summariseTool('Bash', { command: 'npm test' }).detail, 'npm test');
  assert.equal(summariseTool('Read', { file_path: '/a/b/src/handler.ts' }).detail, 'src/handler.ts');
  assert.equal(summariseTool('Unknown', {}).title, 'Unknown');
});

/* --------------------------- protocol handling -------------------------- */

/** Drives a runner's parser without spawning a real Claude Code process. */
function fakeRunner() {
  const store = tempStore();
  const agent = store.createAgent(agentInput());
  const runner = new AgentRunner(agent, store);
  const written = [];
  runner.child = {
    killed: false,
    stdin: { writable: true, write: (line) => written.push(JSON.parse(line)), end() {} },
    kill() {},
  };
  return { runner, store, agent, written };
}

test('assistant text and tool calls are normalised into hub events', () => {
  const { runner, store, agent } = fakeRunner();
  runner.onStdout(
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'working on it' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] },
    }) + '\n',
  );
  runner.onStdout(
    JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok\nline2', is_error: false }] },
    }) + '\n',
  );

  const kinds = store.listEvents(agent.id).map((e) => e.kind);
  assert.deepEqual(kinds, ['assistant', 'tool_use', 'tool_result']);
  assert.equal(store.listEvents(agent.id)[1].detail, 'npm test');
});

test('a can_use_tool control request pauses the agent until answered', () => {
  const { runner, store, agent, written } = fakeRunner();
  runner.onStdout(
    JSON.stringify({
      type: 'control_request',
      request_id: 'req-1',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf /' }, tool_use_id: 't9' },
    }) + '\n',
  );

  assert.equal(runner.status, 'waiting_for_permission');
  assert.equal(runner.pendingPermissions.size, 1);
  assert.equal(written.length, 0, 'nothing is auto-approved');

  runner.resolvePermission('req-1', 'deny');

  const reply = written.at(-1);
  assert.equal(reply.type, 'control_response');
  assert.equal(reply.response.request_id, 'req-1');
  assert.equal(reply.response.response.behavior, 'deny');
  assert.equal(runner.pendingPermissions.size, 0);
  assert.equal(store.listEvents(agent.id).at(-1).status, 'denied');
});

test('allowing a permission echoes the original input back to Claude', () => {
  const { runner, written } = fakeRunner();
  runner.onStdout(
    JSON.stringify({
      type: 'control_request',
      request_id: 'req-2',
      request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: 'a.txt', content: 'x' } },
    }) + '\n',
  );
  runner.resolvePermission('req-2', 'allow');
  assert.deepEqual(written.at(-1).response.response, {
    behavior: 'allow',
    updatedInput: { file_path: 'a.txt', content: 'x' },
  });
  runner.pendingPermissions.forEach((p) => clearTimeout(p.timer));
});

test('malformed output never crashes the runner', () => {
  const { runner, store, agent } = fakeRunner();
  runner.onStdout('this is not json\n');
  runner.onStdout(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'still alive' }] } }) + '\n');
  const events = store.listEvents(agent.id);
  assert.equal(events.at(-1).text, 'still alive');
  assert.equal(events.at(0).kind, 'system');
});

test('NDJSON split across chunk boundaries is reassembled', () => {
  const { runner, store, agent } = fakeRunner();
  const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'chunked' }] } }) + '\n';
  runner.onStdout(line.slice(0, 20));
  runner.onStdout(line.slice(20));
  assert.equal(store.listEvents(agent.id).at(-1).text, 'chunked');
});

test('messages are never silently lost when the process is dead', async () => {
  const store = tempStore();
  const agent = store.createAgent(agentInput({ workingDirectory: path.join(os.tmpdir(), 'definitely-not-here-42') }));
  const runner = new AgentRunner(agent, store);
  await runner.send('do a thing');
  const events = store.listEvents(agent.id);
  assert.equal(events[0].kind, 'user', 'the user message is recorded first');
  assert.ok(events.some((e) => e.kind === 'error' && /does not exist/i.test(e.text)));
  assert.equal(runner.status, 'error');
});

/* ------------------------------- manager -------------------------------- */

test('the manager keeps one independent runner per agent', () => {
  const store = tempStore();
  const manager = new AgentManager(store);
  const a = store.createAgent(agentInput({ name: 'A' }));
  const b = store.createAgent(agentInput({ name: 'B' }));

  const ra = manager.runner(a.id);
  const rb = manager.runner(b.id);
  assert.notEqual(ra, rb);
  assert.equal(manager.runner(a.id), ra, 'runners are reused, not duplicated');
  assert.equal(manager.runner('nope'), null);

  ra.setStatus('running');
  assert.equal(manager.status(a.id).status, 'running');
  assert.equal(manager.status(b.id).status, 'stopped', 'agents do not share state');
});

test('duplicate start calls do not spawn a second process', async () => {
  const store = tempStore();
  const agent = store.createAgent(agentInput());
  const runner = new AgentRunner(agent, store);
  runner.child = { killed: false, stdin: { writable: true, write() {}, end() {} }, kill() {} };
  const res = await runner.start();
  assert.equal(res.alreadyRunning, true);
});

/* ------------------------------ retention ------------------------------- */

test('the ring buffer bounds events per agent', () => {
  const store = tempStore();
  const a = store.createAgent(agentInput());
  const b = store.createAgent(agentInput({ name: 'Other' }));

  const cap = RETENTION.eventsPerAgent;
  for (let i = 0; i < cap + RETENTION.pruneEvery + 50; i++) {
    store.appendEvent(a.id, null, { kind: 'user', text: `msg ${i}` });
  }
  store.appendEvent(b.id, null, { kind: 'user', text: 'untouched' });

  const total = store.db.prepare('SELECT COUNT(*) c FROM events WHERE agent_id=?').get(a.id).c;
  assert.ok(total <= cap + RETENTION.pruneEvery, `expected <= ${cap + RETENTION.pruneEvery}, got ${total}`);

  // Explicit prune trims exactly to the cap.
  store.pruneEvents(a.id);
  assert.equal(store.db.prepare('SELECT COUNT(*) c FROM events WHERE agent_id=?').get(a.id).c, cap);

  assert.equal(store.db.prepare('SELECT COUNT(*) c FROM events WHERE agent_id=?').get(b.id).c, 1, 'other agents untouched');
});

test('pruning keeps the NEWEST events, not the oldest', () => {
  const store = tempStore();
  const a = store.createAgent(agentInput());
  for (let i = 0; i < RETENTION.eventsPerAgent + 10; i++) {
    store.appendEvent(a.id, null, { kind: 'user', text: `msg ${i}` });
  }
  store.pruneEvents(a.id);
  const events = store.listEvents(a.id, RETENTION.eventsPerAgent);
  assert.equal(events.at(-1).text, `msg ${RETENTION.eventsPerAgent + 9}`, 'newest survives');
  assert.equal(events.at(0).text, 'msg 10', 'oldest were dropped');
});

test('sessions are capped but the resumable one survives', () => {
  const store = tempStore();
  const a = store.createAgent(agentInput());
  let last;
  for (let i = 0; i < RETENTION.sessionsPerAgent + 15; i++) {
    last = store.createSession(a.id, `s-${i}`);
    store.setSessionClaudeId(last, `claude-${i}`);
  }
  store.pruneSessions(a.id);
  assert.equal(store.listSessions(a.id).length, RETENTION.sessionsPerAgent);
  assert.equal(store.latestSession(a.id).claude_session_id, `claude-${RETENTION.sessionsPerAgent + 14}`);
});

test('oversized tool output is truncated before it is stored', () => {
  const { runner, store, agent } = fakeRunner();
  const huge = 'x'.repeat(50_000);
  runner.onStdout(
    JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: huge, is_error: false }] },
    }) + '\n',
  );
  const stored = store.listEvents(agent.id).at(-1);
  assert.ok(stored.text.length < RETENTION.toolResultBytes + 100, `stored ${stored.text.length} bytes`);
  assert.match(stored.text, /truncated/);
});

test('maintain() brings an existing database into policy', () => {
  const store = tempStore();
  const a = store.createAgent(agentInput());
  const insert = store.db.prepare('INSERT INTO events (agent_id,session_id,kind,payload,created_at) VALUES (?,?,?,?,?)');
  for (let i = 0; i < RETENTION.eventsPerAgent + 500; i++) {
    insert.run(a.id, null, 'user', JSON.stringify({ kind: 'user', text: `old ${i}` }), Date.now());
  }
  const result = store.maintain();
  assert.equal(result.removed, 500);
  assert.equal(store.db.prepare('SELECT COUNT(*) c FROM events').get().c, RETENTION.eventsPerAgent);
});
