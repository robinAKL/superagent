import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AGENT_SPECS, commandLine, npmShimTarget } from './agents.mjs';

const execFileAsync = promisify(execFile);

/** Detect the local agent CLIs (see agents.mjs) that are on PATH and already signed in. */
export async function detectAgents(run = execFileAsync, env = process.env) {
  if (process.platform === 'win32' && run === execFileAsync) {
    return (await discoverWindowsAgents(env)).filter(agent => agent.signedIn).map(agent => agent.agent);
  }
  const found = [];
  for (const spec of AGENT_SPECS) {
    const bin = spec.bins[0];
    if (spec.status ? await loggedIn(run, bin, spec.status) : await installed(run, bin) && spec.signedIn(env)) found.push(spec.agent);
  }
  return found;
}

async function installed(run, bin) {
  try { await run(bin, ['--version'], { timeout: 4_000 }); return true; } catch { return false; }
}

async function loggedIn(run, bin, args) {
  try {
    const { stdout = '', stderr = '' } = await run(bin, args, { timeout: 4_000, windowsHide: true });
    const text = `${stdout}\n${stderr}`.toLowerCase();
    if (/not logged|not signed|unauthenticated|login required|auth required|"loggedin"\s*:\s*false/.test(text)) return false;
    if (/"loggedin"\s*:\s*true/.test(text)) return true;
    return /logged in|signed in|authenticated|ok/.test(text) || text.trim().length === 0;
  } catch {
    return false;
  }
}

async function isFile(path) {
  return Boolean((await stat(path).catch(() => null))?.isFile());
}

/** The executables worth trying for one client in one folder, best first. */
async function candidates(spec, directory, own) {
  const out = [];
  for (const bin of own ? [...new Set([...spec.bins, ...(spec.ownBins ?? [])])] : spec.bins) {
    if (await isFile(join(directory, bin + '.exe'))) out.push(join(directory, bin + '.exe'));
    if (spec.npm && await isFile(join(directory, 'node_modules', spec.npm))) out.push(join(directory, 'node_modules', spec.npm));
    const cmd = join(directory, bin + '.cmd');
    if (await isFile(cmd)) {
      // An npm shim: run the JavaScript it points at with Link's Node.js. Another launcher is run as it is.
      const target = npmShimTarget(await readFile(cmd, 'utf8').catch(() => ''));
      if (target && await isFile(join(dirname(cmd), target))) out.push(join(dirname(cmd), target));
      else if (!target) out.push(cmd);
    }
  }
  return out;
}

/** Every client in AGENT_SPECS that is on this Windows computer, signed in or not. */
export async function discoverWindowsAgents(env = process.env, specs = AGENT_SPECS) {
  const common = [
    join(env.USERPROFILE || homedir(), '.local', 'bin'),
    ...(env.APPDATA ? [join(env.APPDATA, 'npm')] : []),
    ...(env.PATH ?? env.Path ?? '').split(delimiter).map(dir => dir.trim().replace(/^"|"$/g, '')),
  ].filter(isAbsolute);
  return (await Promise.all(specs.map(async (spec) => {
    const own = (spec.dirs?.(env) ?? []).filter(isAbsolute);
    const dirs = [...new Set([...own, ...common])];
    let found;
    for (const directory of dirs) {
      for (const executable of await candidates(spec, directory, own.includes(directory))) {
        const signedIn = spec.status ? await loggedInWith(executable, spec.status) : Boolean(spec.signedIn(env));
        const candidate = { agent: spec.agent, executable, signedIn };
        if (signedIn) return candidate;
        found ??= candidate;
      }
    }
    return found;
  }))).filter(Boolean);
}

function loggedInWith(executable, args) {
  let line;
  try { line = commandLine(executable, args); } catch { return false; }
  const run = (command, argv, options) => execFileAsync(command, argv, { ...options, windowsVerbatimArguments: line.verbatim });
  return loggedIn(run, line.command, line.argv);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(JSON.stringify(await discoverWindowsAgents()));
}
