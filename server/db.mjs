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

    -- One row per completed turn. Kept separate from events so the rolling
    -- usage window survives event pruning, and stays tiny (~60 bytes/turn).
    CREATE TABLE IF NOT EXISTS usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      session_id TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS usage_time ON usage(created_at);
  `);

  // Lightweight migration: add columns that older databases predate.
  const cols = db.prepare('PRAGMA table_info(agents)').all().map((c) => c.name);
  if (!cols.includes('pending_clear')) {
    db.exec('ALTER TABLE agents ADD COLUMN pending_clear INTEGER DEFAULT 0');
  }

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
      // The window is hours; a week of history is plenty for trend context.
      removed += store.pruneUsage(Date.now() - 7 * 24 * 60 * 60 * 1000);
      db.pragma('wal_checkpoint(TRUNCATE)');
      const free = db.pragma('freelist_count', { simple: true });
      if (free > 1000) db.exec('VACUUM');
      return { removed, reclaimedPages: free > 1000 ? free : 0 };
    },

    /** Patch a stored event in place (used for streaming text + tool results). */
    replaceEvent(id, event) {
      db.prepare('UPDATE events SET payload = ? WHERE id = ?').run(JSON.stringify(event), id);
    },

    /**
     * History the UI should paint: everything after the most recent context
     * clear. Older rows are left in place - the ring buffer ages them out - so
     * clearing the chat destroys nothing, it just moves the starting line.
     */
    listEvents(agentId, limit = 400) {
      const marker = db
        .prepare("SELECT id FROM events WHERE agent_id = ? AND kind = 'cleared' ORDER BY id DESC LIMIT 1")
        .get(agentId);
      const floor = marker?.id ?? 0;
      const rows = db
        .prepare('SELECT * FROM events WHERE agent_id = ? AND id > ? ORDER BY id DESC LIMIT ?')
        .all(agentId, floor, limit);
      return rows.reverse().map((r) => ({ ...JSON.parse(r.payload), id: r.id, ts: r.created_at }));
    },

    /* ---- usage (the trip meter) ---- */

    recordUsage(agentId, sessionId, usage = {}, costUsd = 0) {
      const row = {
        agentId,
        sessionId,
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        cacheCreate: usage.cache_creation_input_tokens ?? 0,
        cost: costUsd ?? 0,
        ts: now(),
      };
      db.prepare(
        `INSERT INTO usage (agent_id,session_id,input_tokens,output_tokens,
           cache_read_tokens,cache_creation_tokens,cost_usd,created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(row.agentId, row.sessionId, row.input, row.output, row.cacheRead, row.cacheCreate, row.cost, row.ts);
      return row;
    },

    /**
     * Totals for the current rate-limit window, plus a per-agent breakdown so
     * you can see which agent is burning it. All computed locally from data
     * Claude Code already reports - no API call, no tokens.
     */
    usageSince(sinceTs) {
      const totals = db
        .prepare(
          `SELECT COALESCE(SUM(input_tokens),0) input,
                  COALESCE(SUM(output_tokens),0) output,
                  COALESCE(SUM(cache_read_tokens),0) cacheRead,
                  COALESCE(SUM(cache_creation_tokens),0) cacheCreate,
                  COALESCE(SUM(cost_usd),0) cost,
                  COUNT(*) turns
             FROM usage WHERE created_at >= ?`,
        )
        .get(sinceTs);

      const byAgent = db
        .prepare(
          `SELECT u.agent_id agentId, a.name,
                  COALESCE(SUM(u.input_tokens + u.output_tokens + u.cache_creation_tokens),0) tokens,
                  COALESCE(SUM(u.cost_usd),0) cost,
                  COUNT(*) turns
             FROM usage u JOIN agents a ON a.id = u.agent_id
            WHERE u.created_at >= ?
            GROUP BY u.agent_id ORDER BY tokens DESC`,
        )
        .all(sinceTs);

      // Billable-ish total: cache reads are excluded because they are the cheap
      // part and would swamp the number without reflecting real consumption.
      const tokens = totals.input + totals.output + totals.cacheCreate;
      return { since: sinceTs, tokens, ...totals, byAgent };
    },

    pruneUsage(olderThanTs) {
      return db.prepare('DELETE FROM usage WHERE created_at < ?').run(olderThanTs).changes;
    },

    /**
     * A clear requested while an agent is stopped must outlive the runner
     * object AND a hub restart - otherwise the UI hides the history while
     * Claude quietly resumes with full memory. So it lives in SQLite.
     */
    setPendingClear(agentId, pending) {
      db.prepare('UPDATE agents SET pending_clear = ? WHERE id = ?').run(pending ? 1 : 0, agentId);
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
    pendingClear: Boolean(r.pending_clear),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
