#!/usr/bin/env node
/**
 * Inspect the hub database without needing a sqlite3 CLI.
 *
 *   node scripts/db.mjs                     tables + row counts
 *   node scripts/db.mjs agents              configured agents
 *   node scripts/db.mjs sessions [name]     sessions, newest first
 *   node scripts/db.mjs events <name> [n]   last n UI events for an agent
 *   node scripts/db.mjs schema              full CREATE TABLE statements
 *   node scripts/db.mjs sql "SELECT ..."    any read-only query
 *
 * Safe to run while the hub is running: SQLite is in WAL mode, so readers
 * never block the server and the server never blocks you.
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

const file = process.env.HUB_DB ?? path.join(process.cwd(), 'data', 'hub.db');
if (!fs.existsSync(file)) {
  console.error(`No database at ${file}\nRun the hub once (npm run dev) to create it.`);
  process.exit(1);
}

const db = new Database(file, { readonly: true, fileMustExist: true });
const [cmd = 'overview', ...rest] = process.argv.slice(2);

/** Resolve a partial agent name to one row. */
function findAgent(needle) {
  if (!needle) return null;
  const agents = db.prepare('SELECT * FROM agents').all();
  const hit = agents.find((a) => a.name.toLowerCase().includes(needle.toLowerCase()));
  if (!hit) {
    console.error(`No agent matching "${needle}". Known: ${agents.map((a) => a.name).join(', ')}`);
    process.exit(1);
  }
  return hit;
}

const when = (ts) => (ts ? new Date(ts).toLocaleString() : '-');

switch (cmd) {
  case 'overview': {
    console.log(`db: ${file}\n`);
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
      const { c } = db.prepare(`SELECT COUNT(*) c FROM ${name}`).get();
      console.log(`  ${name.padEnd(12)} ${String(c).padStart(5)} rows`);
    }
    console.log('\ntry: node scripts/db.mjs agents');
    break;
  }

  case 'schema': {
    for (const r of db.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL").all()) console.log(r.sql + ';\n');
    break;
  }

  case 'agents': {
    const rows = db.prepare('SELECT * FROM agents ORDER BY sort_order').all();
    for (const a of rows) {
      console.log(`\n${a.name}   [${a.id}]`);
      console.log(`  description : ${a.description || '-'}`);
      console.log(`  directory   : ${a.working_directory}`);
      console.log(`  model       : ${a.model || '(Claude Code default)'}`);
      console.log(`  permissions : ${a.permission_mode}`);
      console.log(`  agent flag  : ${a.agent_key || '-'}`);
      console.log(`  prompt      : ${(a.system_prompt || '-').slice(0, 90)}`);
      console.log(`  created     : ${when(a.created_at)}`);
    }
    console.log();
    break;
  }

  case 'sessions': {
    const agent = findAgent(rest[0]);
    const rows = agent
      ? db.prepare('SELECT * FROM sessions WHERE agent_id=? ORDER BY started_at DESC').all(agent.id)
      : db.prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT 30').all();
    const names = Object.fromEntries(db.prepare('SELECT id,name FROM agents').all().map((a) => [a.id, a.name]));
    for (const s of rows) {
      console.log(
        `${(names[s.agent_id] ?? '?').padEnd(18)} ${String(s.status).padEnd(10)} ` +
          `${(s.claude_session_id ?? 'none').slice(0, 8)}  started ${when(s.started_at)}`,
      );
    }
    if (!rows.length) console.log('(no sessions yet)');
    break;
  }

  case 'events': {
    const agent = findAgent(rest[0]);
    if (!agent) {
      console.error('Usage: node scripts/db.mjs events <agent name> [count]');
      process.exit(1);
    }
    const limit = Number(rest[1] ?? 25);
    const rows = db
      .prepare('SELECT * FROM events WHERE agent_id=? ORDER BY id DESC LIMIT ?')
      .all(agent.id, limit)
      .reverse();
    for (const r of rows) {
      const e = JSON.parse(r.payload);
      const body = e.text ?? [e.title, e.detail].filter(Boolean).join(' ') ?? '';
      console.log(
        `${when(r.created_at).padEnd(22)} ${e.kind.padEnd(12)} ${String(body).replace(/\s+/g, ' ').slice(0, 90)}`,
      );
    }
    if (!rows.length) console.log('(no events yet)');
    break;
  }

  case 'sql': {
    const query = rest.join(' ');
    if (!/^\s*select\b/i.test(query)) {
      console.error('Only SELECT is allowed here (the database is opened read-only).');
      process.exit(1);
    }
    console.table(db.prepare(query).all());
    break;
  }

  default:
    console.error(`Unknown command "${cmd}". See the header of this file for usage.`);
    process.exit(1);
}

db.close();
