import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

/**
 * Resolves how to invoke the installed GitHub Copilot CLI.
 *
 * The most common install on a dev box is the one bundled by the VS Code
 * Copilot Chat extension, under a per-editor globalStorage path that varies
 * by platform and by whether VS Code is local or remote (`.vscode-server`,
 * the case when this app itself is running inside a remote/WSL VS Code
 * session). We also accept a standalone `@github/copilot` npm/PATH install.
 */
const CANDIDATE_ENTRIES = [
  ['vscode-server', path.join(os.homedir(), '.vscode-server/data/User/globalStorage/github.copilot-chat/copilotCli/copilot')],
  ['vscode-server-insiders', path.join(os.homedir(), '.vscode-server-insiders/data/User/globalStorage/github.copilot-chat/copilotCli/copilot')],
  ['vscode-linux', path.join(os.homedir(), '.config/Code/User/globalStorage/github.copilot-chat/copilotCli/copilot')],
  ['vscode-mac', path.join(os.homedir(), 'Library/Application Support/Code/User/globalStorage/github.copilot-chat/copilotCli/copilot')],
  ['vscode-windows', path.join(os.homedir(), 'AppData/Roaming/Code/User/globalStorage/github.copilot-chat/copilotCli/copilot')],
  ['local-bin', path.join(os.homedir(), '.local/bin/copilot')],
];

let cached = null;

export function resolveCopilotCli() {
  if (cached) return cached;

  if (process.env.COPILOT_BIN && existsSync(process.env.COPILOT_BIN)) {
    cached = { command: process.env.COPILOT_BIN, baseArgs: [], source: 'COPILOT_BIN', entry: process.env.COPILOT_BIN };
    return cached;
  }

  for (const [source, entry] of CANDIDATE_ENTRIES) {
    if (existsSync(entry)) {
      cached = { command: entry, baseArgs: [], source, entry };
      return cached;
    }
  }

  // Fall back to whatever `copilot` resolves to on PATH (npm -g or similar).
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const found = execFileSync(which, ['copilot'], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const exe = found.find((f) => !f.endsWith('.cmd') && !f.endsWith('.ps1')) ?? found[0];
    if (exe) {
      cached = { command: exe, baseArgs: [], source: 'PATH', entry: exe };
      return cached;
    }
  } catch {
    /* ignore */
  }

  return null;
}

export function copilotVersion() {
  const cli = resolveCopilotCli();
  if (!cli) return null;
  try {
    return execFileSync(cli.command, [...cli.baseArgs, '--version'], { encoding: 'utf8', timeout: 20000 }).trim();
  } catch {
    return null;
  }
}
