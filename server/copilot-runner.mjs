import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { resolveCopilotCli } from './copilot-cli.mjs';
import { AcpClient } from './acp-client.mjs';
import { RETENTION } from './db.mjs';
import { PERMISSION_TIMEOUT_MS, truncate, firstLine, safeInput, resultSummary } from './agent-manager.mjs';

/**
 * ============================================================================
 *  COPILOT CLI INTERFACE USED BY THIS APPLICATION (verified against v1.0.83,
 *  live against a real session: a shell tool call, a permission prompt, and
 *  token-level streaming all round-tripped correctly)
 * ============================================================================
 *
 *  Launch (one independent process per configured agent, `copilot --acp`):
 *    the CLI becomes an Agent Client Protocol server - JSON-RPC 2.0 over
 *    stdio, newline-delimited. Same "process stays alive between turns" model
 *    as the Claude Code runner; a single process can host several sessions,
 *    which we use for the Clear button (see performClear below).
 *
 *  Handshake:
 *    -> {"method":"initialize","params":{protocolVersion:1,clientCapabilities}}
 *    -> {"method":"session/new","params":{cwd,mcpServers}}   or session/load to resume
 *
 *  Inbound notifications (agent -> us, no reply expected):
 *    session/update  { sessionUpdate: "agent_message_chunk" | "tool_call" |
 *                       "tool_call_update" | "usage_update" | ... }
 *
 *  Inbound requests (agent -> us, BLOCKS the agent until we reply):
 *    session/request_permission { toolCall, options }
 *      -> we reply { outcome: { outcome: "selected", optionId } }
 *
 *  Outbound requests (us -> agent):
 *    session/prompt { sessionId, prompt } -> resolves with { stopReason, usage }
 *      when the turn ends - this is Copilot's equivalent of Claude's "result".
 *    session/cancel is a NOTIFICATION (not a request) that interrupts the
 *      in-flight session/prompt, which then resolves as usual.
 *
 *  Copilot keeps ownership of tools, MCP and its own session history. This
 *  file only translates ACP into the same HubEvent shape the Claude runner
 *  produces, so the rest of the app (DB schema, UI, WebSocket protocol) does
 *  not need to know which engine an agent uses.
 * ============================================================================
 */

export class CopilotAgentRunner extends EventEmitter {
  constructor(agent, store) {
    super();
    this.agent = agent;
    this.store = store;
    this.child = null;
    this.acp = null;
    this.status = 'stopped';
    this.sessionId = null; // our session row id
    this.copilotSessionId = null;
    this.pendingPermissions = new Map();
    this.queue = [];
    this.starting = false;
    this.lastError = null;
    this.currentActivity = null;
    this.assistantBuffer = '';
    this.toolTitles = new Map();
    this.resolvedToolCalls = new Set();
    this.clearWhenIdle = false;
    this.turnStartedAt = null;
    this.replaying = false;
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
      claudeSessionId: this.copilotSessionId,
      lastError: this.lastError,
      rateLimit: null, // Copilot's ACP surface has no rate-limit-window signal
      pendingPermissions: [...this.pendingPermissions.values()].map((p) => p.event),
    };
  }

  record(event) {
    const stored = this.store.appendEvent(this.agent.id, this.sessionId, { ts: Date.now(), ...event });
    this.emit('event', stored);
    return stored;
  }

  fail(message) {
    this.lastError = message;
    this.record({ kind: 'error', text: message });
    this.setStatus('error', null);
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

      const cli = resolveCopilotCli();
      if (!cli) {
        throw new Error(
          'GitHub Copilot CLI not found. It ships with the VS Code Copilot Chat extension, or install it ' +
            'standalone (`npm install -g @github/copilot`) and make sure `copilot` is on PATH, or set COPILOT_BIN.',
        );
      }

      const wantsClear = Boolean(this.agent.pendingClear);
      const previous = resume && !wantsClear ? this.store.latestSession(this.agent.id) : null;
      const resumeId = previous?.claude_session_id || null;

      const args = [...cli.baseArgs, '--acp', ...permissionArgs(this.agent.permissionMode)];
      if (this.agent.model) args.push('--model', this.agent.model);
      if (this.agent.agentKey) args.push('--agent', this.agent.agentKey);

      this.setStatus('starting', 'Launching Copilot CLI...');

      const child = spawn(cli.command, args, {
        cwd: dir,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.child = child;
      this.acp = new AcpClient(child);
      this.acp.on('notification', (msg) => this.onNotification(msg));
      this.acp.on('request', (msg) => this.onServerRequest(msg));
      this.acp.on('parse-error', (line) =>
        this.record({ kind: 'system', level: 'warn', text: `Unparsable output: ${line.slice(0, 200)}` }),
      );

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        const text = String(chunk).trim();
        if (text) this.record({ kind: 'system', level: 'warn', text: text.slice(0, 2000) });
      });
      child.on('error', (err) => this.fail(err.message));
      child.on('exit', (code, signal) => this.onExit(code, signal));

      await this.acp.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      });

      let session = null;
      if (resumeId) {
        // session/load replays the entire prior conversation as ordinary
        // session/update notifications before it resolves (confirmed live:
        // user_message_chunk, tool_call, tool_call_update, agent_message_chunk
        // for every past turn). We already have that history in our own DB
        // from when it happened the first time, so it must be suppressed here
        // - otherwise it re-records as duplicate events and, worse, leaves
        // stale text in assistantBuffer that the next real reply gets
        // concatenated onto.
        this.replaying = true;
        try {
          const loaded = await this.acp.request('session/load', { sessionId: resumeId, cwd: dir, mcpServers: [] });
          session = { sessionId: resumeId, ...loaded };
        } catch {
          session = null; // stale/expired session id on Copilot's side; start fresh below
        } finally {
          this.replaying = false;
        }
        // Belt-and-braces: drop anything that leaked into per-turn state
        // during the replay window before any real turn begins.
        this.assistantBuffer = '';
        this.toolTitles.clear();
        this.resolvedToolCalls.clear();
      }
      if (!session) {
        session = await this.acp.request('session/new', { cwd: dir, mcpServers: [] });
      }

      this.sessionId = this.store.createSession(this.agent.id, randomUUID());
      this.copilotSessionId = session.sessionId;
      this.store.setSessionClaudeId(this.sessionId, session.sessionId);

      this.record({
        kind: 'system',
        level: 'info',
        text:
          resumeId && session.sessionId === resumeId
            ? `Resumed Copilot session ${resumeId.slice(0, 8)}`
            : 'Started a new Copilot session',
      });

      if (wantsClear) {
        this.store.setPendingClear(this.agent.id, false);
        this.agent = { ...this.agent, pendingClear: false };
        this.record({ kind: 'cleared', text: 'Context cleared' });
      }

      if (!resumeId && this.agent.systemPrompt?.trim()) {
        // Copilot's CLI has no --append-system-prompt equivalent, so the closest
        // analog is a priming turn sent before any real user message.
        try {
          await this.acp.request('session/prompt', {
            sessionId: this.copilotSessionId,
            prompt: [
              {
                type: 'text',
                text: `These are standing instructions for this whole session - follow them for every future message, and just say "Ready." now:\n\n${this.agent.systemPrompt.trim()}`,
              },
            ],
          });
          this.flushAssistantBuffer();
        } catch {
          /* best-effort; a failed priming turn should not block the session */
        }
      }

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
    if (!this.acp || !this.copilotSessionId) {
      this.record({ kind: 'error', text: 'Message not delivered - Copilot CLI session is not ready.' });
      return;
    }
    this.setStatus('running', 'Thinking...');
    this.turnStartedAt = Date.now();
    this.acp
      .request('session/prompt', { sessionId: this.copilotSessionId, prompt: [{ type: 'text', text }] })
      .then((result) => this.handleTurnResult(result))
      .catch((err) => this.handleTurnError(err));
  }

  flushQueue() {
    const pending = this.queue.splice(0);
    for (const text of pending) this.deliver(text);
  }

  /**
   * Copilot has no `/clear` slash equivalent over ACP, but one process can
   * host several sessions - so "clearing" means starting a fresh session on
   * the same still-running process rather than sending a magic command.
   * Same three cases as the Claude runner, for the same reason: getting them
   * wrong would desync the UI from what the model actually remembers.
   */
  clearContext() {
    if (this.child) {
      const busy = ['running', 'starting', 'waiting_for_permission'].includes(this.status);
      if (busy) {
        this.clearWhenIdle = true;
        this.interrupt();
        return { ok: true, deferred: true };
      }
      this.performClear();
      return { ok: true, live: true };
    }

    this.store.setPendingClear(this.agent.id, true);
    this.agent = { ...this.agent, pendingClear: true };
    this.record({ kind: 'cleared', text: 'Context cleared' });
    return { ok: true, live: false };
  }

  async performClear() {
    try {
      const session = await this.acp.request('session/new', { cwd: this.agent.workingDirectory, mcpServers: [] });
      if (this.sessionId) this.store.setSessionStatus(this.sessionId, 'stopped');
      this.sessionId = this.store.createSession(this.agent.id, randomUUID());
      this.copilotSessionId = session.sessionId;
      this.store.setSessionClaudeId(this.sessionId, session.sessionId);
      this.store.setPendingClear(this.agent.id, false);
      this.agent = { ...this.agent, pendingClear: false };
      this.record({ kind: 'cleared', text: 'Context cleared' });
    } catch (err) {
      this.record({ kind: 'error', text: `Could not clear the context: ${err.message}` });
    }
  }

  interrupt() {
    if (!this.child || !this.copilotSessionId) return;
    this.acp.notify('session/cancel', { sessionId: this.copilotSessionId });
    this.record({ kind: 'system', level: 'info', text: 'Interrupt sent.' });
  }

  async stop() {
    for (const id of [...this.pendingPermissions.keys()]) {
      this.resolvePermission(id, 'deny', 'Agent stopped by the user.');
    }
    this.clearWhenIdle = false;
    if (this.child) {
      const child = this.child;
      this.child = null;
      this.acp?.rejectAllPending('Copilot CLI stopped.');
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
    this.clearWhenIdle = false;
    this.acp?.rejectAllPending('Copilot CLI exited.');
    for (const id of [...this.pendingPermissions.keys()]) {
      this.resolvePermission(id, 'deny', 'Copilot CLI exited.');
    }
    if (wasStopped) return;
    if (code === 0 || code === null) {
      this.record({ kind: 'system', level: 'info', text: 'Copilot session ended.' });
      this.setStatus('stopped', null);
    } else {
      this.fail(`Copilot CLI exited unexpectedly (code ${code}${signal ? `, signal ${signal}` : ''}).`);
    }
  }

  /* ---------------------------- parsing ----------------------------- */

  onNotification(msg) {
    if (this.replaying) return; // session/load history replay - see start()
    if (msg.method !== 'session/update') return;
    const update = msg.params?.update;
    if (!update) return;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        return this.handleMessageChunk(update);
      case 'tool_call':
        return this.handleToolCall(update);
      case 'tool_call_update':
        return this.handleToolCallUpdate(update);
      default:
        return; // plan / mode / usage / available-commands updates: nothing to show
    }
  }

  handleMessageChunk(update) {
    const text = update.content?.text ?? '';
    if (!text) return;
    this.assistantBuffer += text;
    this.emit('delta', { agentId: this.agent.id, text });
    if (this.status === 'running' && this.currentActivity !== 'Responding...') {
      this.setStatus('running', 'Responding...');
    }
  }

  flushAssistantBuffer() {
    if (!this.assistantBuffer) return;
    this.emit('delta-end', { agentId: this.agent.id });
    this.record({ kind: 'assistant', text: this.assistantBuffer });
    this.assistantBuffer = '';
  }

  handleToolCall(update) {
    this.flushAssistantBuffer();
    const summary = summariseCopilotTool(update);
    this.toolTitles.set(update.toolCallId, summary);
    this.record({
      kind: 'tool_use',
      toolUseId: update.toolCallId,
      name: update.kind ?? summary.title,
      title: summary.title,
      detail: summary.detail,
      input: safeInput(update.rawInput),
    });
    if (this.status !== 'waiting_for_permission') this.setStatus('running', summary.activity);
  }

  handleToolCallUpdate(update) {
    if (!['completed', 'failed'].includes(update.status)) return;
    const toolCallId = update.toolCallId;
    if (this.resolvedToolCalls.has(toolCallId)) return;
    this.resolvedToolCalls.add(toolCallId);
    const text = flattenAcpContent(update.content);
    this.record({
      kind: 'tool_result',
      toolUseId: toolCallId,
      isError: update.status === 'failed',
      summary: resultSummary(text, update.status === 'failed'),
      text: truncate(text, RETENTION.toolResultBytes),
    });
  }

  handleTurnResult(result) {
    this.flushAssistantBuffer();
    const usage = result?.usage ?? {};
    const mapped = {
      input_tokens: usage.inputTokens ?? 0,
      output_tokens: usage.outputTokens ?? 0,
      cache_read_input_tokens: usage.cachedReadTokens ?? 0,
      cache_creation_input_tokens: usage.cachedWriteTokens ?? 0,
    };
    const tokens = mapped.input_tokens + mapped.output_tokens + mapped.cache_creation_input_tokens;
    const isError = result?.stopReason === 'refusal';

    this.record({
      kind: 'result',
      isError,
      subtype: result?.stopReason ?? null,
      durationMs: this.turnStartedAt ? Date.now() - this.turnStartedAt : null,
      costUsd: null, // Copilot's ACP surface reports tokens, not USD cost
      turns: null,
      tokens,
    });

    this.store.recordUsage(this.agent.id, this.sessionId, mapped, 0);
    this.emit('usage', { agentId: this.agent.id });

    this.setStatus(this.pendingPermissions.size ? 'waiting_for_permission' : 'idle', null);
    this.emit('notify', { agentId: this.agent.id, reason: isError ? 'error' : 'done' });

    if (this.clearWhenIdle) {
      this.clearWhenIdle = false;
      this.performClear();
    }
  }

  handleTurnError(err) {
    this.flushAssistantBuffer();
    this.record({ kind: 'error', text: `Copilot turn failed: ${err.message}` });
    this.setStatus(this.pendingPermissions.size ? 'waiting_for_permission' : 'idle', null);
    this.emit('notify', { agentId: this.agent.id, reason: 'error' });
    if (this.clearWhenIdle) {
      this.clearWhenIdle = false;
      this.performClear();
    }
  }

  /* -------------------------- permissions --------------------------- */

  onServerRequest(msg) {
    if (msg.method !== 'session/request_permission') {
      this.acp.respondError(msg.id, `Unsupported request: ${msg.method}`);
      return;
    }
    const { toolCall, options } = msg.params ?? {};
    this.flushAssistantBuffer();
    const summary = this.toolTitles.get(toolCall?.toolCallId) ?? summariseCopilotTool(toolCall ?? {});
    const requestId = String(msg.id);

    const event = this.record({
      kind: 'permission',
      requestId,
      toolUseId: toolCall?.toolCallId,
      toolName: toolCall?.kind ?? toolCall?.title,
      displayName: toolCall?.title ?? toolCall?.kind,
      title: summary.title,
      detail: summary.detail,
      input: safeInput(toolCall?.rawInput),
      status: 'pending',
    });

    const timer = setTimeout(() => {
      this.resolvePermission(requestId, 'deny', 'No response within 5 minutes - denied automatically.', 'expired');
    }, PERMISSION_TIMEOUT_MS);

    this.pendingPermissions.set(requestId, { event, rpcId: msg.id, options: options ?? [], timer });
    this.setStatus('waiting_for_permission', `Needs permission: ${summary.title}`);
    this.emit('notify', { agentId: this.agent.id, reason: 'permission' });
  }

  resolvePermission(requestId, behavior, message, finalStatus) {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pendingPermissions.delete(requestId);

    const optionId = pickOption(pending.options, behavior);
    this.acp.respond(pending.rpcId, optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } });

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

function permissionArgs(mode) {
  switch (mode) {
    case 'acceptEdits':
      return ['--allow-tool', 'write'];
    case 'plan':
      return ['--mode', 'plan'];
    case 'auto':
      return ['--allow-all-tools'];
    default:
      return []; // manual: every tool call goes through session/request_permission
  }
}

function summariseCopilotTool(update) {
  const title = update.title || update.kind || 'Tool';
  const input = update.rawInput ?? {};
  const detail = firstLine(input.command ?? input.description ?? input.path ?? input.query ?? '');
  return { title, detail, activity: `${title}...` };
}

function flattenAcpContent(content) {
  if (!Array.isArray(content)) return '';
  return content.map((c) => c?.content?.text ?? c?.text ?? '').join('\n');
}

/** Our UI only offers Allow/Deny; map that onto whatever options Copilot sent. */
function pickOption(options, behavior) {
  if (!Array.isArray(options) || !options.length) return null;
  const prefix = behavior === 'allow' ? 'allow' : 'reject';
  const once = options.find((o) => o.kind === `${prefix}_once`);
  if (once) return once.optionId;
  const any = options.find((o) => o.kind?.startsWith(prefix));
  if (any) return any.optionId;
  return behavior === 'allow' ? options[0]?.optionId : options[options.length - 1]?.optionId;
}
