import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);

/** Detect local Codex / Claude Code CLIs that are on PATH and already logged in. */
export async function detectAgents(run = execFileAsync) {
  if (process.platform === 'win32' && run === execFileAsync) {
    return (await discoverWindowsAgents()).filter(agent => agent.signedIn).map(agent => agent.agent);
  }
  const found = [];
  if (await loggedIn(run, 'codex', ['login', 'status'])) found.push('codex');
  if (await loggedIn(run, 'claude', ['auth', 'status'])) found.push('claude-code');
  return found;
}

async function loggedIn(run, bin, args) {
  try {
    const { stdout = '', stderr = '' } = await run(bin, args, { timeout: 4_000 });
    const text = `${stdout}\n${stderr}`.toLowerCase();
    if (/not logged|unauthenticated|login required|auth required|"loggedin"\s*:\s*false/.test(text)) return false;
    if (/"loggedin"\s*:\s*true/.test(text)) return true;
    return /logged in|authenticated|ok/.test(text) || text.trim().length === 0;
  } catch {
    return false;
  }
}

const AGENTS = [
  { agent: 'codex', bin: 'codex', npm: '@openai/codex/bin/codex.js', status: ['login', 'status'] },
  { agent: 'claude-code', bin: 'claude', npm: '@anthropic-ai/claude-code/cli.js', status: ['auth', 'status'] },
];

export async function discoverWindowsAgents() {
  const dirs = [...new Set([
    ...(process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin')] : []),
    join(homedir(), '.local', 'bin'),
    ...(process.env.APPDATA ? [join(process.env.APPDATA, 'npm')] : []),
    ...(process.env.PATH ?? '').split(delimiter).map(dir => dir.trim().replace(/^"|"$/g, '')),
  ].filter(isAbsolute))];
  return (await Promise.all(AGENTS.map(async ({ agent, bin, npm, status }) => {
    let installed;
    for (const directory of dirs) {
      for (const executable of [join(directory, bin + '.exe'), join(directory, 'node_modules', npm)]) {
        if (!(await stat(executable).catch(() => null))?.isFile()) continue;
        const script = executable.endsWith('.js');
        const signedIn = await loggedIn(execFileAsync, script ? process.execPath : executable, script ? [executable, ...status] : status);
        const candidate = { agent, executable, signedIn };
        if (signedIn) return candidate;
        installed ??= candidate;
      }
    }
    return installed;
  }))).filter(Boolean);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(JSON.stringify(await discoverWindowsAgents()));
}
