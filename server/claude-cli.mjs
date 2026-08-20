import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

/**
 * Resolves how to invoke the installed Claude Code CLI.
 *
 * On Windows, npm installs a `.cmd` shim which Node >=20 refuses to spawn
 * directly (EINVAL). We prefer the package's Node entrypoint so we can spawn
 * `process.execPath <entry>` with no shell involved (no shell => no command
 * injection surface, which matters because agent working directories are
 * user-supplied).
 */
const CANDIDATE_ENTRIES = [
  ['npm-global-roaming', path.join(os.homedir(), 'AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/cli-wrapper.cjs')],
  ['npm-global-unix', '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli-wrapper.cjs'],
  ['npm-prefix-local', path.join(os.homedir(), '.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli-wrapper.cjs')],
  ['local-install', path.join(os.homedir(), '.claude/local/node_modules/@anthropic-ai/claude-code/cli-wrapper.cjs')],
];

let cached = null;

export function resolveClaudeCli() {
  if (cached) return cached;

  for (const [source, entry] of CANDIDATE_ENTRIES) {
    if (existsSync(entry)) {
      cached = { command: process.execPath, baseArgs: [entry], source, entry };
      return cached;
    }
  }

  // Fall back to whatever `claude` resolves to on PATH (native binary installs).
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const found = execFileSync(which, ['claude'], { encoding: 'utf8' })
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

export function claudeVersion() {
  const cli = resolveClaudeCli();
  if (!cli) return null;
  try {
    return execFileSync(cli.command, [...cli.baseArgs, '--version'], { encoding: 'utf8', timeout: 20000 }).trim();
  } catch {
    return null;
  }
}
