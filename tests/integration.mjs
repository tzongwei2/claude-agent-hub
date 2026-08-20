/**
 * End-to-end smoke test against a RUNNING hub (node server/index.mjs).
 * Drives a real Claude Code session over the hub WebSocket:
 *   send a prompt -> stream text -> tool call -> permission prompt -> allow.
 *
 *   node tests/integration.mjs
 */
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.HUB ?? 'http://localhost:3000';
const workdir = path.join(process.cwd(), 'data', 'e2e-workspace');
fs.mkdirSync(workdir, { recursive: true });

const seen = { delta: 0, assistant: 0, tool: 0, permission: 0, allowed: false, result: false, error: null };

const api = async (p, init) => {
  const res = await fetch(BASE + p, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  return json;
};

const health = await api('/api/health');
console.log('health:', JSON.stringify(health.claude));
if (!health.claude.found) throw new Error('Claude Code CLI not found - cannot run the integration test.');

const { agent } = await api('/api/agents', {
  method: 'POST',
  body: JSON.stringify({
    name: 'E2E Probe',
    description: 'temporary integration-test agent',
    accent: 'emerald',
    workingDirectory: workdir,
    permissionMode: 'manual',
  }),
});
console.log('created agent:', agent.id);

const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws`);
const done = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('timed out after 180s')), 180000);

  ws.on('open', () => {
    ws.send(
      JSON.stringify({
        t: 'send',
        agentId: agent.id,
        text: 'Use the Write tool to create a file called e2e.txt containing exactly the word: banana. Then reply with the single word DONE.',
      }),
    );
  });

  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.agentId && msg.agentId !== agent.id) return;

    switch (msg.t) {
      case 'delta':
        seen.delta += msg.text.length;
        break;
      case 'status':
        console.log('  status:', msg.status.status, msg.status.activity ?? '');
        break;
      case 'event': {
        const e = msg.event;
        if (e.kind === 'assistant') {
          seen.assistant++;
          console.log('  assistant:', e.text.slice(0, 70).replace(/\n/g, ' '));
        }
        if (e.kind === 'tool_use') {
          seen.tool++;
          console.log('  tool_use:', e.title, '-', e.detail);
        }
        if (e.kind === 'tool_result') console.log('  tool_result:', e.summary);
        if (e.kind === 'error') seen.error = e.text;
        if (e.kind === 'permission' && e.status === 'pending') {
          seen.permission++;
          console.log('  PERMISSION:', e.toolName, '-', e.detail, '-> allowing');
          ws.send(JSON.stringify({ t: 'permission', agentId: agent.id, requestId: e.requestId, behavior: 'allow' }));
        }
        if (e.kind === 'permission' && e.status === 'allowed') seen.allowed = true;
        if (e.kind === 'result') {
          seen.result = true;
          clearTimeout(timer);
          resolve();
        }
        break;
      }
      case 'error':
        console.log('  hub error:', msg.message);
        break;
    }
  });

  ws.on('error', reject);
});

try {
  await done;
} finally {
  ws.close();
}

const file = path.join(workdir, 'e2e.txt');
const wrote = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null;

const checks = [
  ['streamed token deltas', seen.delta > 0],
  ['assistant messages', seen.assistant > 0],
  ['tool call surfaced', seen.tool > 0],
  ['permission requested', seen.permission > 0],
  ['permission allowed', seen.allowed],
  ['file actually written', wrote === 'banana'],
  ['turn completed', seen.result],
  ['no errors', seen.error === null],
];

console.log('\nResults');
for (const [label, ok] of checks) console.log(` ${ok ? 'PASS' : 'FAIL'}  ${label}`);

// leave the workspace, clean up the throwaway agent
await api(`/api/agents/${agent.id}`, { method: 'DELETE' });
fs.rmSync(file, { force: true });

const failed = checks.filter(([, ok]) => !ok);
if (failed.length) {
  console.error(`\n${failed.length} check(s) failed`);
  process.exit(1);
}
console.log('\nAll checks passed.');
process.exit(0);
