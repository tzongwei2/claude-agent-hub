import { createServer } from 'node:http';
import { parse } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import next from 'next';
import { WebSocketServer } from 'ws';
import { openDb, createStore, RETENTION, DB_PATH } from './db.mjs';
import { AgentManager } from './agent-manager.mjs';
import { claudeVersion, resolveClaudeCli } from './claude-cli.mjs';

/**
 * Single-process local server:
 *   - Next.js renders the UI
 *   - the REST API and the WebSocket hub live here, in the SAME process as the
 *     AgentManager, so there is exactly one manager instance owning the
 *     Claude Code child processes.
 *
 * Security: bound to 127.0.0.1 only. The browser can never name a command to
 * run - it can only pick a configured agent, send chat text, and answer
 * permission prompts. Nothing from process.env is ever serialised to a client.
 */

const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3000);
// `npm start` passes --prod so we need no cross-platform env-var shim.
const dev = process.env.NODE_ENV !== 'production' && !process.argv.includes('--prod');
if (!dev) process.env.NODE_ENV = 'production';

const db = openDb();
const store = createStore(db);
const manager = new AgentManager(store);

// Bring an existing database into retention policy, fold away the WAL and
// reclaim pages freed by pruning, before we start serving.
const swept = store.maintain();

const app = next({ dev, dir: process.cwd() });
const handle = app.getRequestHandler();

await app.prepare();

/* ------------------------------ REST API ------------------------------ */

const routes = [
  ['GET', /^\/api\/health$/, async () => {
    const cli = resolveClaudeCli();
    return {
      ok: true,
      claude: { found: Boolean(cli), source: cli?.source ?? null, version: claudeVersion() },
      platform: process.platform,
    };
  }],

  ['GET', /^\/api\/agents$/, async () => ({
    agents: store.listAgents(),
    statuses: manager.statuses(),
  })],

  ['POST', /^\/api\/agents$/, async (_m, body) => {
    const err = validateAgent(body);
    if (err) throw new HttpError(400, err);
    return { agent: store.createAgent(body) };
  }],

  ['PUT', /^\/api\/agents\/([^/]+)$/, async (m, body) => {
    const err = validateAgent(body);
    if (err) throw new HttpError(400, err);
    const agent = store.updateAgent(m[1], body);
    if (!agent) throw new HttpError(404, 'Agent not found');
    manager.refreshAgent(agent);
    return { agent };
  }],

  ['DELETE', /^\/api\/agents\/([^/]+)$/, async (m) => {
    await manager.stop(m[1]);
    manager.runners.delete(m[1]);
    return { deleted: store.deleteAgent(m[1]) };
  }],

  ['POST', /^\/api\/agents\/([^/]+)\/start$/, async (m) => manager.start(m[1])],
  ['POST', /^\/api\/agents\/([^/]+)\/stop$/, async (m) => manager.stop(m[1])],
  ['POST', /^\/api\/agents\/([^/]+)\/restart$/, async (m) => manager.restart(m[1])],

  ['GET', /^\/api\/agents\/([^/]+)\/sessions$/, async (m) => ({ sessions: store.listSessions(m[1]) })],
  ['GET', /^\/api\/agents\/([^/]+)\/events$/, async (m) => ({ events: store.listEvents(m[1]) })],

  ['POST', /^\/api\/validate-path$/, async (_m, body) => {
    const dir = String(body?.path ?? '');
    const exists = Boolean(dir) && fs.existsSync(dir) && fs.statSync(dir).isDirectory();
    return { exists, resolved: exists ? path.resolve(dir) : null };
  }],
];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function handleApi(req, res, pathname) {
  for (const [method, pattern, fn] of routes) {
    if (req.method !== method) continue;
    const m = pathname.match(pattern);
    if (!m) continue;
    try {
      const body = ['POST', 'PUT'].includes(req.method) ? await readJson(req) : null;
      const result = await fn(m, body);
      send(res, 200, result);
    } catch (err) {
      send(res, err.status ?? 500, { error: err.message });
    }
    return true;
  }
  return false;
}

function send(res, status, payload) {
  const json = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) });
  res.end(json);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1_000_000) reject(new HttpError(413, 'Request body too large'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function validateAgent(body) {
  if (!body || typeof body !== 'object') return 'Missing body';
  if (!String(body.name ?? '').trim()) return 'Name is required';
  const dir = String(body.workingDirectory ?? '').trim();
  if (!dir) return 'Working directory is required';
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return `Working directory does not exist: ${dir}`;
  const modes = ['manual', 'acceptEdits', 'plan', 'auto'];
  if (body.permissionMode && !modes.includes(body.permissionMode)) return 'Invalid permission mode';
  return null;
}

/* ------------------------------ WebSocket ----------------------------- */

const server = createServer(async (req, res) => {
  const parsed = parse(req.url, true);
  if (parsed.pathname?.startsWith('/api/')) {
    const handled = await handleApi(req, res, parsed.pathname);
    if (handled) return;
    return send(res, 404, { error: 'Not found' });
  }
  return handle(req, res, parsed);
});

const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  push(ws, { t: 'hello', agents: store.listAgents(), statuses: manager.statuses() });

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return push(ws, { t: 'error', message: 'Malformed message' });
    }
    try {
      await handleClientMessage(ws, msg);
    } catch (err) {
      push(ws, { t: 'error', message: err.message });
    }
  });

  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

// Drop half-open sockets (laptop sleep, browser crash) so we do not leak them.
const heartbeat = setInterval(() => {
  for (const ws of clients) {
    if (!ws.isAlive) {
      ws.terminate();
      clients.delete(ws);
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      /* socket already gone */
    }
  }
}, 30000);

async function handleClientMessage(ws, msg) {
  switch (msg.t) {
    case 'history': {
      push(ws, { t: 'history', agentId: msg.agentId, events: store.listEvents(msg.agentId) });
      return;
    }
    case 'send': {
      const agent = store.getAgent(msg.agentId);
      if (!agent) throw new Error('Unknown agent');
      await manager.send(msg.agentId, String(msg.text ?? ''));
      return;
    }
    case 'permission': {
      const ok = manager.respondToPermission(msg.agentId, msg.requestId, msg.behavior === 'allow' ? 'allow' : 'deny');
      if (!ok) push(ws, { t: 'error', message: 'That permission request is no longer pending.' });
      return;
    }
    case 'start':
      broadcastResult(await manager.start(msg.agentId), ws);
      return;
    case 'stop':
      await manager.stop(msg.agentId);
      return;
    case 'restart':
      broadcastResult(await manager.restart(msg.agentId), ws);
      return;
    case 'interrupt':
      manager.interrupt(msg.agentId);
      return;
    case 'agents':
      push(ws, { t: 'agents', agents: store.listAgents(), statuses: manager.statuses() });
      return;
    case 'clear':
      store.clearEvents(msg.agentId);
      broadcast({ t: 'history', agentId: msg.agentId, events: [] });
      return;
    default:
      throw new Error(`Unknown message: ${msg.t}`);
  }
}

function broadcastResult(result, ws) {
  if (result && result.ok === false) push(ws, { t: 'error', message: result.error });
}

function push(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data);
}

manager.on('event', ({ agentId, event }) => broadcast({ t: 'event', agentId, event }));
manager.on('status', (status) => broadcast({ t: 'status', status }));
manager.on('delta', ({ agentId, text }) => broadcast({ t: 'delta', agentId, text }));
manager.on('delta-end', ({ agentId }) => broadcast({ t: 'delta-end', agentId }));
manager.on('notify', ({ agentId, reason }) => broadcast({ t: 'notify', agentId, reason }));

/* ------------------------------- boot -------------------------------- */

server.listen(PORT, HOST, () => {
  const cli = resolveClaudeCli();
  console.log(`\n  Claude Agent Hub  ->  http://localhost:${PORT}`);
  console.log(`  Claude Code CLI   ->  ${cli ? `${cli.source} (${claudeVersion() ?? 'unknown version'})` : 'NOT FOUND'}`);
  console.log(`  Database          ->  ${DB_PATH}`);
  console.log(
    `  Retention         ->  ${RETENTION.eventsPerAgent || 'unlimited'} events/agent` +
      (swept.removed ? `, swept ${swept.removed} old rows` : '') +
      '\n',
  );
});

async function shutdown() {
  clearInterval(heartbeat);
  await manager.shutdown();
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
