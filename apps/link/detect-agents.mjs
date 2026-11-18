import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Detect local Codex / Claude Code CLIs that are on PATH and already logged in. */
export async function detectAgents(run = execFileAsync) {
  const found = [];
  if (await loggedIn(run, 'codex', ['login', 'status'])) found.push('codex');
  if (await loggedIn(run, 'claude', ['auth', 'status'])) found.push('claude-code');
  return found;
}

async function loggedIn(run, bin, args) {
  try {
    const { stdout = '', stderr = '' } = await run(bin, args, { timeout: 4_000 });
    const text = `${stdout}\n${stderr}`.toLowerCase();
    if (/not logged|unauthenticated|login required|auth required/.test(text)) return false;
    return /logged in|authenticated|ok/.test(text) || text.trim().length === 0;
  } catch {
    return false;
  }
}
