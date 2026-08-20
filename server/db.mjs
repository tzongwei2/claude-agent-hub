import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Retention policy. The events table is a display cache, not a source of truth
 * (Claude Code keeps the authoritative transcript in its own .jsonl), so old
 * rows can be discarded freely: you lose scrollback, never capability.
 *
 * Steady state is roughly `eventsPerAgent * 1KB` per agent - about 2 MB each
 * at the defaults, no matter how long the hub runs.
 *
 * Set HUB_MAX_EVENTS=0 to disable pruning and grow forever.
 */
export const RETENTION = {
  eventsPerAgent: Number(process.env.HUB_MAX_EVENTS ?? 2000),
  sessionsPerAgent: Number(process.env.HUB_MAX_SESSIONS ?? 20),
  /** tool_result bodies are the dominant term; the UI only shows a summary. */
  toolResultBytes: Number(process.env.HUB_MAX_TOOL_RESULT ?? 2048),
  /** Prune every N inserts rather than on each one; bounds overshoot to N rows. */
  pruneEvery: 250,
};

/**
 * Thin, modular persistence layer. Everything the rest of the app touches goes
 * through the exported functions, so swapping SQLite out later means rewriting
 * only this file.
 */
/** Database location. HUB_DB overrides it (used by scripts and tests). */
export const DB_PATH = process.env.HUB_DB ?? path.join(process.cwd(), 'data', 'hub.db');

export function openDb(file = DB_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      emoji TEXT DEFAULT '🤖',
      accent TEXT DEFAULT 'violet',
      system_prompt TEXT DEFAULT '',
      agent_key TEXT DEFAULT '',
      working_directory TEXT NOT NULL,
      model TEXT DEFAULT '',
      permission_mode TEXT DEFAULT 'manual',
      sort_order INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      claude_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS sessions_agent ON sessions(agent_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      session_id TEXT,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_agent ON events(agent_id, id);
  `);

  return db;
}

export function createStore(db) {
  const now = () => Date.now();
  /** Per-agent insert counters driving the amortised prune. */
  const writeCounts = new Map();

  const store = {
    db,

    listAgents() {
      return db.prepare('SELECT * FROM agents ORDER BY sort_order, created_at').all().map(rowToAgent);
    },

    getAgent(id) {
      const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
      return row ? rowToAgent(row) : null;
    },

    createAgent(input) {
      const id = randomUUID();
      const ts = now();
      db.prepare(`INSERT INTO agents
        (id,name,description,emoji,accent,system_prompt,agent_key,working_directory,model,permission_mode,sort_order,created_at,updated_at)
        VALUES (@id,@name,@description,@emoji,@accent,@system_prompt,@agent_key,@working_directory,@model,@permission_mode,@sort_order,@created_at,@updated_at)`)
        .run({
          id,
          name: input.name,
          description: input.description ?? '',
          emoji: input.emoji ?? '🤖',
          accent: input.accent ?? 'violet',
          system_prompt: input.systemPrompt ?? '',
          agent_key: input.agentKey ?? '',
          working_directory: input.workingDirectory,
          model: input.model ?? '',
          permission_mode: input.permissionMode ?? 'manual',
          sort_order: db.prepare('SELECT COUNT(*) c FROM agents').get().c,
          created_at: ts,
          updated_at: ts,
        });
      return store.getAgent(id);
    },

    updateAgent(id, patch) {
      const current = store.getAgent(id);
      if (!current) return null;
      const merged = { ...current, ...patch };
      db.prepare(`UPDATE agents SET
        name=@name, description=@description, emoji=@emoji, accent=@accent,
        system_prompt=@system_prompt, agent_key=@agent_key, working_directory=@working_directory,
        model=@model, permission_mode=@permission_mode, updated_at=@updated_at WHERE id=@id`)
        .run({
          id,
          name: merged.name,
          description: merged.description ?? '',
          emoji: merged.emoji ?? '🤖',
          accent: merged.accent ?? 'violet',
          system_prompt: merged.systemPrompt ?? '',
          agent_key: merged.agentKey ?? '',
          working_directory: merged.workingDirectory,
          model: merged.model ?? '',
          permission_mode: merged.permissionMode ?? 'manual',
          updated_at: now(),
        });
      return store.getAgent(id);
    },

    deleteAgent(id) {
      return db.prepare('DELETE FROM agents WHERE id = ?').run(id).changes > 0;
    },

    /* ---- sessions ---- */

    createSession(agentId, sessionId) {
      db.prepare('INSERT INTO sessions (id,agent_id,claude_session_id,status,started_at) VALUES (?,?,?,?,?)')
        .run(sessionId, agentId, null, 'starting', now());
      return sessionId;
    },

    setSessionClaudeId(sessionId, claudeSessionId) {
      db.prepare('UPDATE sessions SET claude_session_id = ? WHERE id = ?').run(claudeSessionId, sessionId);
    },

    setSessionStatus(sessionId, status) {
      const ended = ['stopped', 'error'].includes(status) ? now() : null;
      db.prepare('UPDATE sessions SET status = ?, ended_at = COALESCE(?, ended_at) WHERE id = ?')
        .run(status, ended, sessionId);
    },

    latestSession(agentId) {
      return db.prepare('SELECT * FROM sessions WHERE agent_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1').get(agentId) ?? null;
    },

    listSessions(agentId) {
      return db.prepare('SELECT * FROM sessions WHERE agent_id = ? ORDER BY started_at DESC, rowid DESC').all(agentId);
    },

    /* ---- events ---- */

    appendEvent(agentId, sessionId, event) {
      const ts = event.ts ?? now();
      const info = db.prepare('INSERT INTO events (agent_id,session_id,kind,payload,created_at) VALUES (?,?,?,?,?)')
        .run(agentId, sessionId, event.kind, JSON.stringify(event), ts);

      // Amortised ring-buffer trim: cheap, and rides the (agent_id, id) index.
      const n = (writeCounts.get(agentId) ?? 0) + 1;
      if (n >= RETENTION.pruneEvery) {
        writeCounts.set(agentId, 0);
        store.pruneEvents(agentId);
      } else {
        writeCounts.set(agentId, n);
      }

      return { ...event, id: info.lastInsertRowid, ts };
    },

    /** Keep only the newest RETENTION.eventsPerAgent rows for this agent. */
    pruneEvents(agentId) {
      if (!RETENTION.eventsPerAgent) return 0;
      return db
        .prepare(
          `DELETE FROM events WHERE agent_id = ? AND id <= COALESCE(
             (SELECT id FROM events WHERE agent_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?), -1)`,
        )
        .run(agentId, agentId, RETENTION.eventsPerAgent).changes;
    },

    /** Keep only the newest session rows; the live one is newest, so it survives. */
    pruneSessions(agentId) {
      if (!RETENTION.sessionsPerAgent) return 0;
      return db
        .prepare(
          `DELETE FROM sessions WHERE agent_id = ? AND id NOT IN (
             SELECT id FROM sessions WHERE agent_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?)`,
        )
        .run(agentId, agentId, RETENTION.sessionsPerAgent).changes;
    },

    /**
     * Startup housekeeping: bring an existing database into policy, fold the
     * WAL back into the main file, and reclaim pages freed by pruning.
     * VACUUM only runs when there is enough free space to be worth it.
     */
    maintain() {
      let removed = 0;
      for (const { id } of db.prepare('SELECT id FROM agents').all()) {
        removed += store.pruneEvents(id) + store.pruneSessions(id);
      }
      db.pragma('wal_checkpoint(TRUNCATE)');
      const free = db.pragma('freelist_count', { simple: true });
      if (free > 1000) db.exec('VACUUM');
      return { removed, reclaimedPages: free > 1000 ? free : 0 };
    },

    /** Patch a stored event in place (used for streaming text + tool results). */
    replaceEvent(id, event) {
      db.prepare('UPDATE events SET payload = ? WHERE id = ?').run(JSON.stringify(event), id);
    },

    listEvents(agentId, limit = 400) {
      const rows = db.prepare('SELECT * FROM events WHERE agent_id = ? ORDER BY id DESC LIMIT ?').all(agentId, limit);
      return rows.reverse().map((r) => ({ ...JSON.parse(r.payload), id: r.id, ts: r.created_at }));
    },

    clearEvents(agentId) {
      db.prepare('DELETE FROM events WHERE agent_id = ?').run(agentId);
    },
  };

  return store;
}

function rowToAgent(r) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    emoji: r.emoji,
    accent: r.accent,
    systemPrompt: r.system_prompt,
    agentKey: r.agent_key,
    workingDirectory: r.working_directory,
    model: r.model,
    permissionMode: r.permission_mode,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
