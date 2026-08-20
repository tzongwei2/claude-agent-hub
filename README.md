# Claude Agent Hub

A local, Teams-style web UI for several **independent Claude Code main-agent sessions**.
Each configured agent is its own `claude` process with its own working directory,
its own session, and its own conversation. No subagents, no orchestration.

```
npm install
npm run dev          # http://localhost:3000
```

Requires **Node >= 20.11** and the Claude Code CLI already installed and
authenticated (`claude auth status`). The hub inherits that auth - it never sees
or stores credentials of its own.

| Script | Does |
| --- | --- |
| `npm run dev` | Dev server, on-the-fly compilation |
| `npm run build` && `npm start` | Production build and serve |
| `npm test` | 18 unit tests, no Claude Code needed |
| `npm run test:e2e` | Live end-to-end run (hub must be running) |
| `npm run db` | Inspect the database |

### Moving to another machine

Clone, `npm install`, `npm run dev`. `better-sqlite3` is a native module and is
rebuilt per platform on install, so never copy `node_modules` across machines.

The database is **not** committed (`data/` is ignored), so a fresh clone starts
with no agents - create them in the UI. Agent working directories are absolute
paths, so they are machine-specific by nature and would not transfer anyway.

## The Claude Code interface this uses

Verified against the installed CLI, **Claude Code 2.1.233**. Nothing here is
screen-scraped; every byte exchanged is JSON.

Each agent is launched as:

```
claude --print
       --input-format stream-json        # we write NDJSON to stdin
       --output-format stream-json       # Claude writes NDJSON to stdout
       --verbose                         # required for stream-json output
       --include-partial-messages        # token-level deltas -> smooth streaming
       --permission-prompt-tool stdio    # routes permission prompts to US
       --permission-mode manual
       --session-id <uuid>  |  --resume <uuid>
       [--model ...] [--agent ...] [--append-system-prompt ...]
```

The process **stays alive between turns** — it is a real resumable session, not a
one-shot `-p` invocation.

| Need | Mechanism |
| --- | --- |
| Start a session | `--session-id <uuid>`, cwd = the agent's working directory |
| Send a prompt | stdin: `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}` |
| Streaming response | stdout: `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta",…}}}` |
| Structured events | stdout: `system/init`, `assistant`, `user`, `result` |
| Tool calls | `assistant` messages containing `tool_use` blocks; results arrive as `user` messages with `tool_result` blocks |
| **Permission requests** | stdout: `{"type":"control_request","request":{"subtype":"can_use_tool",…}}` — **Claude blocks** until we reply on stdin with `{"type":"control_response","response":{"subtype":"success","request_id":…,"response":{"behavior":"allow"\|"deny"}}}` |
| Interactive questions | Claude asks in normal assistant text; you answer in the composer |
| Interrupt | stdin: `control_request` with `{"subtype":"interrupt"}` |
| Resume | `--resume <claude session id>`, stored in the `sessions` table |

`--permission-prompt-tool stdio` is the load-bearing flag. Without it Claude Code
resolves permissions internally and auto-denies in non-interactive mode; with it,
the decision is handed to this app and the agent genuinely pauses.

Claude Code keeps full ownership of its tools, MCP servers, permission rules,
filesystem access and session history. This app is a process manager, an event
normaliser and a UI.

## Architecture

```
browser ──HTTP+WS(127.0.0.1)──> server/index.mjs ──> AgentManager
                                     │                   ├── AWS Engineer   → claude process
                                     │                   ├── Frontend Eng.  → claude process
                                     └── SQLite          └── Reviewer       → claude process
```

Everything lives in one Node process, so there is exactly one `AgentManager`
owning the child processes. Next.js only renders the UI; the API and WebSocket
are served by the same HTTP server (`server/index.mjs`) so no state has to cross
a module boundary.

| File | Role |
| --- | --- |
| `server/claude-cli.mjs` | Locates the CLI; spawns via `node <entrypoint>` so no shell is involved |
| `server/agent-manager.mjs` | Process lifecycle, the stream-json protocol, permissions, event normalising |
| `server/db.mjs` | SQLite (`agents`, `sessions`, `events`) — the only file that knows about SQL |
| `server/index.mjs` | REST + WebSocket + Next.js |
| `lib/useHub.ts` | One WebSocket for the whole hub, auto-reconnecting |
| `components/` | Rail, agent list, chat, tool cards, permission cards, agent editor |

### Event model

Raw Claude output is normalised into a small set of UI events before it is
stored or broadcast: `user`, `assistant`, `tool_use`, `tool_result`,
`permission`, `system`, `error`, `result`. The browser never sees raw protocol
frames, and tool output is summarised (`24 tests passed`, `13 lines`) with the
full text tucked behind a collapsible.

## Housekeeping

The `events` table is a display cache, not a source of truth - Claude Code keeps
the authoritative transcript in its own `.jsonl`. So old rows are discarded
freely: you lose scrollback, never capability and never agent memory.

Retention is a ring buffer, trimmed on insert (amortised every 250 writes) and
swept once at startup:

| Knob | Default | Env override |
| --- | --- | --- |
| Events kept per agent | 2000 (~2 MB) | `HUB_MAX_EVENTS` (`0` = unlimited) |
| Session rows per agent | 20 | `HUB_MAX_SESSIONS` |
| Stored `tool_result` size | 2 KB | `HUB_MAX_TOOL_RESULT` |

Startup also runs `wal_checkpoint(TRUNCATE)` and, when more than 1000 pages are
free, `VACUUM` - so pruning actually shrinks the file rather than just marking
pages reusable. The boot banner reports the policy and anything swept.

Steady state is a few MB total, indefinitely, regardless of how long the hub runs.

## API

```
GET    /api/health                    CLI presence + version
GET    /api/agents                    agents + live statuses
POST   /api/agents                    create
PUT    /api/agents/:id                update
DELETE /api/agents/:id                delete (stops the process first)
POST   /api/agents/:id/start|stop|restart
GET    /api/agents/:id/sessions
GET    /api/agents/:id/events
POST   /api/validate-path             working-directory validation
```

WebSocket `/ws` — client sends `send` · `permission` · `start` · `stop` ·
`restart` · `interrupt` · `history` · `clear`; server pushes `hello` · `event` ·
`delta` · `delta-end` · `status` · `notify` · `error`.

## Status model

`idle · starting · running · waiting_for_permission · error · stopped`, pushed to
every connected browser the moment it changes.

## Security

- Binds to `127.0.0.1` only.
- The browser cannot name a command. It can pick a configured agent, send chat
  text, and answer permission prompts — nothing else.
- Child processes are spawned without a shell, so a working-directory string can
  never become a command.
- No environment variables or credentials are ever serialised to the client;
  Claude Code handles its own auth.
- Permissions are never auto-approved. Unanswered prompts are **denied** after
  five minutes, not allowed.

## Tests

```
npm test                      # 18 unit tests, no Claude Code required
node tests/integration.mjs    # real Claude Code session, needs the hub running
node tests/concurrent.mjs     # two real sessions at once, needs the hub running
```

`integration.mjs` drives a live session end to end: prompt → streamed tokens →
tool call → permission prompt → allow → file actually written on disk.

## Notes

- Runs on plain Node — Windows, WSL or Linux. Nothing in the code is
  platform-specific: the CLI is located via `os.homedir()` candidates with a
  `PATH` fallback, and child processes are spawned without a shell.
- Out of scope by design: agent-to-agent orchestration, DAG editors, auth,
  remote access.
