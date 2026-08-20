import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { resolveClaudeCli } from './claude-cli.mjs';
import { RETENTION } from './db.mjs';

/**
 * ============================================================================
 *  CLAUDE CODE INTERFACE USED BY THIS APPLICATION  (verified against v2.1.233)
 * ============================================================================
 *
 *  Launch (one independent main-agent process per configured agent):
 *
 *    claude --print
 *           --input-format stream-json      <- we write NDJSON user messages to stdin
 *           --output-format stream-json     <- Claude writes NDJSON events to stdout
 *           --verbose                       <- required for stream-json output
 *           --include-partial-messages      <- token-level deltas for smooth streaming
 *           --permission-prompt-tool stdio  <- routes permission prompts to US
 *           --permission-mode manual
 *           --session-id <uuid> | --resume <uuid>
 *           [--model] [--append-system-prompt] [--agent <name>]
 *
 *  The process stays alive between turns: it is a real, resumable session, not
 *  a one-shot. We never screen-scrape a terminal; every byte we parse is JSON.
 *
 *  Inbound (stdout, one JSON object per line):
 *    {"type":"system","subtype":"init", session_id, tools, model, ...}
 *    {"type":"stream_event","event":{content_block_delta,...}}   partial tokens
 *    {"type":"assistant","message":{content:[{type:"text"|"tool_use",...}]}}
 *    {"type":"user","message":{content:[{type:"tool_result",...}]}}
 *    {"type":"result","subtype":"success"|"error_*", duration_ms, total_cost_usd}
 *    {"type":"control_request","request_id","request":{subtype:"can_use_tool",
 *        tool_name, input, permission_suggestions, tool_use_id}}   <- BLOCKS
 *
 *  Outbound (stdin, one JSON object per line):
 *    {"type":"user","message":{"role":"user","content":[{"type":"text","text":...}]}}
 *    {"type":"control_request","request_id","request":{"subtype":"initialize"}}
 *    {"type":"control_request","request_id","request":{"subtype":"interrupt"}}
 *    {"type":"control_response","response":{"subtype":"success","request_id",
 *        "response":{"behavior":"allow","updatedInput":{...}}}}
 *    ... or {"behavior":"deny","message":"..."} to refuse a tool call.
 *
 *  Claude Code keeps ownership of tools, MCP, permissions and its own session
 *  history. This file is a process/session manager and an event normaliser.
 * ============================================================================
 */

const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;

/** Rate-limit window lengths, used to compute the rolling usage total. */
export const WINDOW_MS = {
  five_hour: 5 * 60 * 60 * 1000,
  seven_day: 7 * 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};
export const DEFAULT_WINDOW_MS = WINDOW_MS.five_hour;

export class AgentRunner extends EventEmitter {
  constructor(agent, store) {
    super();
    this.agent = agent;
    this.store = store;
    this.child = null;
    this.status = 'stopped';
    this.sessionId = null; // our session row id
    this.claudeSessionId = null;
    this.stdoutBuffer = '';
    this.pendingPermissions = new Map();
    this.queue = [];
    this.starting = false;
    this.lastError = null;
    this.currentActivity = null;
    this.rateLimit = null;
  }

  /* ------------------------------------------------------------------ */

  setStatus(status, activity = undefined) {
    if (activity !== undefined) this.currentActivity = activity;
    this.status = status;
    if (this.sessionId) this.store.setSessionStatus(this.sessionId, status);
    this.emit('status', this.snapshot());
  }

  snapshot() {
    return {
      agentId: this.agent.id,
      status: this.status,
      activity: this.currentActivity,
      claudeSessionId: this.claudeSessionId,
      lastError: this.lastError,
      rateLimit: this.rateLimit,
      pendingPermissions: [...this.pendingPermissions.values()].map((p) => p.event),
    };
  }

  record(event) {
    const stored = this.store.appendEvent(this.agent.id, this.sessionId, { ts: Date.now(), ...event });
    this.emit('event', stored);
    return stored;
  }

  /* ------------------------------------------------------------------ */

  async start({ resume = true } = {}) {
    if (this.child || this.starting) return { ok: true, alreadyRunning: true };
    this.starting = true;
    this.lastError = null;

    try {
      const dir = this.agent.workingDirectory;
      if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        throw new Error(`Working directory does not exist: ${dir || '(empty)'}`);
      }

      const cli = resolveClaudeCli();
      if (!cli) {
        throw new Error(
          'Claude Code CLI not found. Install it with `npm install -g @anthropic-ai/claude-code` and make sure `claude` is on PATH.',
        );
      }

      const previous = resume ? this.store.latestSession(this.agent.id) : null;
      const resumeId = previous?.claude_session_id || null;
      const sessionUuid = resumeId ?? randomUUID();

      const args = [
        ...cli.baseArgs,
        '--print',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--permission-prompt-tool', 'stdio',
        '--permission-mode', this.agent.permissionMode || 'manual',
      ];
      if (resumeId) args.push('--resume', resumeId);
      else args.push('--session-id', sessionUuid);
      if (this.agent.model) args.push('--model', this.agent.model);
      if (this.agent.agentKey) args.push('--agent', this.agent.agentKey);
      if (this.agent.systemPrompt) args.push('--append-system-prompt', this.agent.systemPrompt);

      this.sessionId = this.store.createSession(this.agent.id, randomUUID());
      this.claudeSessionId = sessionUuid;
      this.store.setSessionClaudeId(this.sessionId, sessionUuid);
      this.setStatus('starting', 'Launching Claude Code...');

      const child = spawn(cli.command, args, {
        cwd: dir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'agent-hub' },
        windowsHide: true,
      });
      this.child = child;

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => this.onStdout(chunk));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        const text = String(chunk).trim();
        if (text) this.record({ kind: 'system', level: 'warn', text: text.slice(0, 2000) });
      });
      child.on('error', (err) => this.fail(err.message));
      child.on('exit', (code, signal) => this.onExit(code, signal));

      // Control-protocol handshake; also opens the can_use_tool channel.
      this.write({ type: 'control_request', request_id: `init-${randomUUID()}`, request: { subtype: 'initialize' } });

      this.record({
        kind: 'system',
        level: 'info',
        text: resumeId ? `Resumed Claude Code session ${resumeId.slice(0, 8)}` : 'Started a new Claude Code session',
      });

      this.starting = false;
      this.setStatus('idle', null);
      this.flushQueue();
      return { ok: true };
    } catch (err) {
      this.starting = false;
      this.fail(err.message);
      return { ok: false, error: err.message };
    }
  }

  fail(message) {
    this.lastError = message;
    this.record({ kind: 'error', text: message });
    this.setStatus('error', null);
  }

  write(obj) {
    if (!this.child || this.child.killed || !this.child.stdin.writable) return false;
    try {
      this.child.stdin.write(JSON.stringify(obj) + '\n');
      return true;
    } catch (err) {
      this.fail(`Failed to talk to Claude Code: ${err.message}`);
      return false;
    }
  }

  /* ------------------------------------------------------------------ */

  async send(text) {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) return;

    this.record({ kind: 'user', text: trimmed });

    if (!this.child) {
      this.queue.push(trimmed);
      const res = await this.start();
      if (!res.ok) {
        this.queue = this.queue.filter((q) => q !== trimmed);
        this.record({ kind: 'error', text: `Message not delivered: ${res.error}` });
      }
      return;
    }
    this.deliver(trimmed);
  }

  deliver(text) {
    const ok = this.write({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    });
    if (ok) this.setStatus('running', 'Thinking...');
    else this.record({ kind: 'error', text: 'Message not delivered - Claude Code is not accepting input.' });
  }

  flushQueue() {
    const pending = this.queue.splice(0);
    for (const text of pending) this.deliver(text);
  }

  interrupt() {
    if (!this.child) return;
    this.write({ type: 'control_request', request_id: `int-${randomUUID()}`, request: { subtype: 'interrupt' } });
    this.record({ kind: 'system', level: 'info', text: 'Interrupt sent.' });
  }

  async stop() {
    for (const id of [...this.pendingPermissions.keys()]) {
      this.resolvePermission(id, 'deny', 'Agent stopped by the user.');
    }
    if (this.child) {
      const child = this.child;
      this.child = null;
      try {
        child.stdin.end();
      } catch {
        /* already closed */
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, 1500);
    }
    this.setStatus('stopped', null);
  }

  onExit(code, signal) {
    const wasStopped = this.child === null && this.status === 'stopped';
    this.child = null;
    for (const id of [...this.pendingPermissions.keys()]) {
      this.resolvePermission(id, 'deny', 'Claude Code exited.');
    }
    if (wasStopped) return;
    if (code === 0 || code === null) {
      this.record({ kind: 'system', level: 'info', text: 'Claude Code session ended.' });
      this.setStatus('stopped', null);
    } else {
      this.fail(`Claude Code exited unexpectedly (code ${code}${signal ? `, signal ${signal}` : ''}).`);
    }
  }

  /* ---------------------------- parsing ----------------------------- */

  onStdout(chunk) {
    this.stdoutBuffer += chunk;
    let idx;
    while ((idx = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, idx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.record({ kind: 'system', level: 'warn', text: `Unparsable output: ${line.slice(0, 200)}` });
        continue;
      }
      try {
        this.handleMessage(msg);
      } catch (err) {
        this.record({ kind: 'error', text: `Failed to handle Claude event: ${err.message}` });
      }
    }
  }

  handleMessage(msg) {
    switch (msg.type) {
      case 'system':
        return this.handleSystem(msg);
      case 'stream_event':
        return this.handleStreamEvent(msg);
      case 'assistant':
        return this.handleAssistant(msg);
      case 'user':
        return this.handleToolResults(msg);
      case 'result':
        return this.handleResult(msg);
      case 'control_request':
        return this.handleControlRequest(msg);
      case 'rate_limit_event':
        return this.handleRateLimit(msg);
      default:
        return undefined;
    }
  }

  handleSystem(msg) {
    if (msg.subtype === 'init') {
      this.claudeSessionId = msg.session_id;
      if (this.sessionId) this.store.setSessionClaudeId(this.sessionId, msg.session_id);
      this.emit('status', this.snapshot());
      return;
    }
    if (msg.subtype === 'permission_denied') {
      this.record({ kind: 'system', level: 'warn', text: msg.message ?? 'Permission denied.' });
    }
  }

  /**
   * The warning light. Claude reports its rate-limit state on every turn; we
   * only surface a change, so a healthy session stays quiet. Nothing here
   * costs anything - the event arrives whether or not we read it.
   */
  handleRateLimit(msg) {
    const info = msg.rate_limit_info;
    if (!info) return;
    const previous = this.rateLimit?.status;
    this.rateLimit = info;

    if (info.status && info.status !== previous) {
      this.emit('ratelimit', { agentId: this.agent.id, info });
      if (previous && info.status !== 'allowed') {
        this.record({
          kind: 'system',
          level: 'warn',
          text: `Rate limit status changed to "${info.status}" (${info.rateLimitType ?? 'window'}).`,
        });
      }
    } else {
      this.emit('ratelimit', { agentId: this.agent.id, info });
    }
  }

  handleStreamEvent(msg) {
    const ev = msg.event;
    if (!ev) return;
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      this.emit('delta', { agentId: this.agent.id, text: ev.delta.text });
      if (this.status === 'running' && this.currentActivity !== 'Responding...') {
        this.setStatus('running', 'Responding...');
      }
    }
    if (ev.type === 'content_block_start' && ev.content_block?.type === 'thinking') {
      this.setStatus('running', 'Thinking...');
    }
  }

  handleAssistant(msg) {
    const content = msg.message?.content ?? [];
    const isSubagent = Boolean(msg.parent_tool_use_id);
    for (const block of content) {
      if (block.type === 'text') {
        if (block.text?.trim()) {
          this.emit('delta-end', { agentId: this.agent.id });
          this.record({ kind: 'assistant', text: block.text, subagent: isSubagent });
        }
      } else if (block.type === 'tool_use') {
        this.emit('delta-end', { agentId: this.agent.id });
        const summary = summariseTool(block.name, block.input);
        this.record({
          kind: 'tool_use',
          toolUseId: block.id,
          name: block.name,
          title: summary.title,
          detail: summary.detail,
          input: safeInput(block.input),
        });
        if (this.status !== 'waiting_for_permission') this.setStatus('running', summary.activity);
      }
    }
  }

  handleToolResults(msg) {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      const text = flattenContent(block.content);
      this.record({
        kind: 'tool_result',
        toolUseId: block.tool_use_id,
        isError: Boolean(block.is_error),
        summary: resultSummary(text, block.is_error),
        text: truncate(text, RETENTION.toolResultBytes),
      });
    }
  }

  handleResult(msg) {
    this.emit('delta-end', { agentId: this.agent.id });

    const usage = msg.usage ?? {};
    const tokens =
      (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);

    this.record({
      kind: 'result',
      isError: Boolean(msg.is_error),
      subtype: msg.subtype,
      durationMs: msg.duration_ms ?? msg.duration_api_ms ?? null,
      costUsd: msg.total_cost_usd ?? null,
      turns: msg.num_turns ?? null,
      tokens,
    });

    // The trip meter: one small row per completed turn.
    this.store.recordUsage(this.agent.id, this.sessionId, usage, msg.total_cost_usd ?? 0);
    this.emit('usage', { agentId: this.agent.id });

    // The hard stop. A refused turn says so here; make it unmissable rather
    // than letting it read as a generic failure.
    const reason = `${msg.subtype ?? ''} ${msg.api_error_status ?? ''} ${msg.result ?? ''}`;
    if (msg.is_error && /rate.?limit|usage limit|quota|429/i.test(reason)) {
      const resets = this.rateLimit?.resetsAt
        ? ` Resets at ${new Date(this.rateLimit.resetsAt * 1000).toLocaleTimeString()}.`
        : '';
      this.record({
        kind: 'error',
        text: `Rate limit reached - Claude Code refused this turn.${resets}`,
        rateLimited: true,
      });
      this.emit('notify', { agentId: this.agent.id, reason: 'rate_limit' });
    }
    this.setStatus(this.pendingPermissions.size ? 'waiting_for_permission' : 'idle', null);
    this.emit('notify', { agentId: this.agent.id, reason: msg.is_error ? 'error' : 'done' });
  }

  /* -------------------------- permissions --------------------------- */

  handleControlRequest(msg) {
    const req = msg.request ?? {};
    if (req.subtype !== 'can_use_tool') {
      this.write({
        type: 'control_response',
        response: { subtype: 'error', request_id: msg.request_id, error: `Unsupported control request: ${req.subtype}` },
      });
      return;
    }

    const summary = summariseTool(req.tool_name, req.input);
    const event = this.record({
      kind: 'permission',
      requestId: msg.request_id,
      toolUseId: req.tool_use_id,
      toolName: req.tool_name,
      displayName: req.display_name ?? req.tool_name,
      title: summary.title,
      detail: summary.detail,
      input: safeInput(req.input),
      status: 'pending',
    });

    const timer = setTimeout(() => {
      this.resolvePermission(msg.request_id, 'deny', 'No response within 5 minutes - denied automatically.', 'expired');
    }, PERMISSION_TIMEOUT_MS);

    this.pendingPermissions.set(msg.request_id, { event, input: req.input, timer });
    this.setStatus('waiting_for_permission', `Needs permission: ${summary.title}`);
    this.emit('notify', { agentId: this.agent.id, reason: 'permission' });
  }

  resolvePermission(requestId, behavior, message, finalStatus) {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pendingPermissions.delete(requestId);

    const response =
      behavior === 'allow'
        ? { behavior: 'allow', updatedInput: pending.input }
        : { behavior: 'deny', message: message || 'The user denied this action.' };

    this.write({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response },
    });

    const updated = {
      ...pending.event,
      status: finalStatus ?? (behavior === 'allow' ? 'allowed' : 'denied'),
      resolvedAt: Date.now(),
    };
    this.store.replaceEvent(pending.event.id, updated);
    this.emit('event', updated);

    if (!this.pendingPermissions.size && this.status === 'waiting_for_permission') {
      this.setStatus('running', 'Working...');
    }
    return true;
  }
}

/* -------------------------------------------------------------------- */

export class AgentManager extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.runners = new Map();
    /** Latest rate-limit info seen from any agent; it is account-wide. */
    this.rateLimit = null;
  }

  /** Rolling usage for the current rate-limit window. Computed locally. */
  usageWindow() {
    const type = this.rateLimit?.rateLimitType;
    const windowMs = WINDOW_MS[type] ?? DEFAULT_WINDOW_MS;
    const snapshot = this.store.usageSince(Date.now() - windowMs);
    return {
      ...snapshot,
      windowMs,
      windowType: type ?? 'five_hour',
      resetsAt: this.rateLimit?.resetsAt ? this.rateLimit.resetsAt * 1000 : null,
      rateLimit: this.rateLimit,
    };
  }

  runner(agentId) {
    const existing = this.runners.get(agentId);
    if (existing) return existing;
    const agent = this.store.getAgent(agentId);
    if (!agent) return null;
    const runner = new AgentRunner(agent, this.store);
    runner.on('event', (e) => this.emit('event', { agentId, event: e }));
    runner.on('status', (s) => this.emit('status', s));
    runner.on('delta', (d) => this.emit('delta', d));
    runner.on('delta-end', (d) => this.emit('delta-end', d));
    runner.on('notify', (n) => this.emit('notify', n));
    runner.on('ratelimit', (r) => {
      this.rateLimit = r.info;
      this.emit('ratelimit', r);
    });
    runner.on('usage', (u) => this.emit('usage', u));
    this.runners.set(agentId, runner);
    return runner;
  }

  refreshAgent(agent) {
    const runner = this.runners.get(agent.id);
    if (runner) runner.agent = agent;
  }

  status(agentId) {
    const runner = this.runners.get(agentId);
    return runner ? runner.snapshot() : { agentId, status: 'stopped', activity: null, pendingPermissions: [] };
  }

  statuses() {
    return this.store.listAgents().map((a) => this.status(a.id));
  }

  async start(agentId) {
    const runner = this.runner(agentId);
    if (!runner) return { ok: false, error: 'Unknown agent' };
    return runner.start();
  }

  async stop(agentId) {
    const runner = this.runners.get(agentId);
    if (!runner) return { ok: true };
    await runner.stop();
    return { ok: true };
  }

  async restart(agentId) {
    await this.stop(agentId);
    this.runners.delete(agentId);
    return this.start(agentId);
  }

  async send(agentId, text) {
    const runner = this.runner(agentId);
    if (!runner) return { ok: false, error: 'Unknown agent' };
    await runner.send(text);
    return { ok: true };
  }

  respondToPermission(agentId, requestId, behavior) {
    const runner = this.runners.get(agentId);
    if (!runner) return false;
    return runner.resolvePermission(requestId, behavior);
  }

  interrupt(agentId) {
    this.runners.get(agentId)?.interrupt();
  }

  async shutdown() {
    await Promise.all([...this.runners.keys()].map((id) => this.stop(id)));
  }
}

/* ---------------------------- helpers -------------------------------- */

/** Stored tool output is a preview: the UI shows a summary, and Claude Code
 *  keeps the full text in its own transcript. */
function truncate(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}
... (truncated, ${s.length - max} more chars)` : s;
}

function firstLine(s, max = 160) {
  const line = String(s ?? '').split('\n')[0].trim();
  return line.length > max ? line.slice(0, max) + '...' : line;
}

function shortPath(p) {
  if (!p) return '';
  const parts = String(p).replace(/\\/g, '/').split('/');
  return parts.slice(-2).join('/');
}

/** Turns a raw tool call into something worth showing a human. */
export function summariseTool(name, input = {}) {
  switch (name) {
    case 'Bash':
      return { title: 'Bash', detail: firstLine(input.command), activity: `Running ${firstLine(input.command, 40)}` };
    case 'Read':
      return { title: 'Read', detail: shortPath(input.file_path), activity: `Reading ${shortPath(input.file_path)}` };
    case 'Write':
      return { title: 'Write', detail: shortPath(input.file_path), activity: `Writing ${shortPath(input.file_path)}` };
    case 'Edit':
      return { title: 'Edit', detail: shortPath(input.file_path), activity: `Editing ${shortPath(input.file_path)}` };
    case 'Glob':
      return { title: 'Glob', detail: input.pattern ?? '', activity: `Searching ${input.pattern ?? ''}` };
    case 'Grep':
      return { title: 'Grep', detail: input.pattern ?? '', activity: `Searching for ${firstLine(input.pattern, 40)}` };
    case 'WebFetch':
      return { title: 'Web fetch', detail: input.url ?? '', activity: 'Fetching a page' };
    case 'WebSearch':
      return { title: 'Web search', detail: input.query ?? '', activity: 'Searching the web' };
    case 'TodoWrite':
      return { title: 'Plan', detail: `${input.todos?.length ?? 0} steps`, activity: 'Updating its plan' };
    case 'Task':
      return { title: 'Subagent', detail: firstLine(input.description ?? ''), activity: 'Delegating to a subagent' };
    default:
      return {
        title: name,
        detail: firstLine(input.description ?? input.command ?? input.file_path ?? ''),
        activity: `Using ${name}`,
      };
  }
}

function safeInput(input) {
  try {
    const json = JSON.stringify(input ?? {}, null, 2);
    return json.length > 4000 ? json.slice(0, 4000) + '\n...' : json;
  } catch {
    return '{}';
  }
}

function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === 'string' ? c : (c?.text ?? ''))).join('\n');
  }
  return content ? String(content) : '';
}

function resultSummary(text, isError) {
  const clean = String(text ?? '').trim();
  if (!clean) return isError ? 'Failed' : 'Done';
  const lines = clean.split('\n').filter(Boolean);
  if (isError) return firstLine(clean, 120);
  if (lines.length === 1) return firstLine(clean, 120);
  return `${lines.length} lines`;
}
