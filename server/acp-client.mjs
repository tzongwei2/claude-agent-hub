import { EventEmitter } from 'node:events';

/**
 * A minimal client for the Agent Client Protocol (ACP): JSON-RPC 2.0 over
 * stdio, newline-delimited. Verified live against `copilot --acp` (v1.0.83):
 *
 *   -> {"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}
 *   <- {"jsonrpc":"2.0","id":1,"result":{...}}
 *   <- {"jsonrpc":"2.0","method":"session/update","params":{...}}          notification
 *   <- {"jsonrpc":"2.0","id":0,"method":"session/request_permission",...} server->client request; BLOCKS the agent
 *   -> {"jsonrpc":"2.0","id":0,"result":{"outcome":{"outcome":"selected","optionId":"allow_once"}}}
 *
 * This class only knows JSON-RPC framing and correlation. It has no opinion
 * about ACP method names - that lives in whoever calls it.
 */
export class AcpClient extends EventEmitter {
  constructor(child) {
    super();
    this.child = child;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject}

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.onData(chunk));
  }

  onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.emit('parse-error', line);
        continue;
      }
      this.onMessage(msg);
    }
  }

  onMessage(msg) {
    // A response to one of our own requests.
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && !msg.method) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || 'ACP request failed'));
        else p.resolve(msg.result);
      }
      return;
    }
    // A server-initiated request (has id + method): the agent expects a reply.
    if (msg.id !== undefined && msg.method) {
      this.emit('request', msg);
      return;
    }
    // A notification (no id): fire and forget.
    if (msg.method) {
      this.emit('notification', msg);
    }
  }

  /** Send a request to the agent and wait for its response. */
  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.writeRaw({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Send a one-way notification (no reply expected). */
  notify(method, params) {
    this.writeRaw({ jsonrpc: '2.0', method, params });
  }

  /** Reply to a server-initiated request (e.g. session/request_permission). */
  respond(id, result) {
    this.writeRaw({ jsonrpc: '2.0', id, result });
  }

  respondError(id, message, code = -32000) {
    this.writeRaw({ jsonrpc: '2.0', id, error: { code, message } });
  }

  writeRaw(obj) {
    if (!this.child || this.child.killed || !this.child.stdin.writable) return false;
    try {
      this.child.stdin.write(JSON.stringify(obj) + '\n');
      return true;
    } catch {
      return false;
    }
  }

  /** Reject every in-flight request; call this when the child process dies. */
  rejectAllPending(message) {
    for (const [id, p] of this.pending) {
      p.reject(new Error(message));
      this.pending.delete(id);
    }
  }
}
