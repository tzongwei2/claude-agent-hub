/**
 * Concurrency check against a RUNNING hub: two agents, two real Claude Code
 * processes, one WebSocket. Proves their turns interleave rather than queueing.
 *
 *   node tests/concurrent.mjs
 */
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.HUB ?? 'http://localhost:3000';

const api = async (p, init) => {
  const res = await fetch(BASE + p, { ...init, headers: { 'content-type': 'application/json' } });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  return json;
};

const made = [];
for (const name of ['Concurrent A', 'Concurrent B']) {
  const dir = path.join(process.cwd(), 'data', name.replace(/\s+/g, '-').toLowerCase());
  fs.mkdirSync(dir, { recursive: true });
  const { agent } = await api('/api/agents', {
    method: 'POST',
    body: JSON.stringify({ name, workingDirectory: dir, permissionMode: 'manual' }),
  });
  made.push(agent);
}
console.log('agents:', made.map((a) => a.name).join(', '));

const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws`);
const state = Object.fromEntries(made.map((a) => [a.id, { first: null, done: null, text: '' }]));
const t0 = Date.now();

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('timed out')), 180000);

  ws.on('open', () => {
    // Fire both at the same instant.
    for (const a of made) {
      ws.send(JSON.stringify({ t: 'send', agentId: a.id, text: `Reply with only the word ${a.name.split(' ')[1]}.` }));
    }
  });

  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    const s = state[msg.agentId];
    if (!s) return;
    if (msg.t === 'delta' && s.first === null) s.first = Date.now() - t0;
    if (msg.t === 'event' && msg.event.kind === 'assistant') s.text = msg.event.text.trim();
    if (msg.t === 'event' && msg.event.kind === 'result') {
      s.done = Date.now() - t0;
      if (Object.values(state).every((x) => x.done !== null)) {
        clearTimeout(timer);
        resolve();
      }
    }
  });
  ws.on('error', reject);
});
ws.close();

console.log('\nPer-agent timings (ms from send):');
for (const a of made) {
  const s = state[a.id];
  console.log(`  ${a.name.padEnd(14)} first token ${String(s.first).padStart(6)}  finished ${String(s.done).padStart(6)}  reply "${s.text.slice(0, 30)}"`);
}

const [a, b] = made.map((m) => state[m.id]);
const overlapped = Math.min(a.done, b.done) > Math.max(a.first ?? 0, b.first ?? 0);
const totalIfSerial = a.done + b.done;
const wall = Math.max(a.done, b.done);

console.log(`\n wall clock ${wall}ms vs ${totalIfSerial}ms if they had run one-after-another`);
console.log(overlapped ? ' PASS  the two sessions overlapped in time' : ' FAIL  the sessions did not overlap');

for (const agent of made) await api(`/api/agents/${agent.id}`, { method: 'DELETE' });
process.exit(overlapped ? 0 : 1);
