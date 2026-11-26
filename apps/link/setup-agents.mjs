import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { discoverWindowsAgents } from './detect-agents.mjs';
import { AGENT_SPECS } from './agents.mjs';

const execFileAsync = promisify(execFile);

/** Official Windows installers. Link runs these itself so the user never has to find a download page. */
export const SETUP_AGENTS = AGENT_SPECS.map((spec) => ({
  agent: spec.agent,
  label: spec.label,
  loginArgs: spec.loginArgs,
  loginHint: spec.loginHint,
  installCommand: spec.install.command,
  installEnv: spec.install.env,
  trustLoginExit: !spec.status && spec.loginArgs.length > 0,
}));

export function setupChoices(discovered) {
  const byAgent = new Map(discovered.map(item => [item.agent, item]));
  return SETUP_AGENTS.map(spec => {
    const found = byAgent.get(spec.agent);
    const state = !found ? 'missing' : found.signedIn ? 'ready' : 'signed-out';
    return {
      agent: spec.agent,
      label: spec.label,
      state,
      action: state === 'ready' ? 'use' : state === 'signed-out' ? 'login' : 'install',
      executable: found?.executable ?? null,
      loginArgs: spec.loginArgs,
      loginHint: spec.loginHint,
      // No sign-in check of its own: the tray takes a login command that ended well as signed in.
      trustLoginExit: spec.trustLoginExit,
    };
  });
}

export async function installAgent(agent, {
  run = execFileAsync,
  discover = discoverWindowsAgents,
  platform = process.platform,
  env = process.env,
} = {}) {
  const spec = SETUP_AGENTS.find(item => item.agent === agent);
  if (!spec) return { ok: false, agent, error: '未知的客户端。' };
  if (platform !== 'win32') return { ok: false, agent, error: '自动安装目前只在 Windows 上提供。' };
  try {
    await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', spec.installCommand,
    ], {
      timeout: 300_000,
      windowsHide: true,
      env: { ...env, ...spec.installEnv },
    });
  } catch (error) {
    const detail = [error.stderr, error.stdout, error.message].filter(Boolean).join(' ');
    return { ok: false, agent, error: clip(detail || '安装失败。') };
  }
  const found = (await discover()).find(item => item.agent === agent);
  if (!found?.executable) return { ok: false, agent, error: '安装已结束，但没有找到命令行客户端。' };
  return {
    ok: true,
    agent,
    executable: found.executable,
    signedIn: Boolean(found.signedIn),
    loginArgs: spec.loginArgs,
    loginHint: spec.loginHint,
  };
}

function clip(text) {
  const oneLine = String(text).replace(/\s+/g, ' ').trim();
  return oneLine.length > 280 ? `${oneLine.slice(0, 280)}…` : oneLine;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, agent] = process.argv.slice(2);
  const result = command === 'install'
    ? await installAgent(agent)
    : setupChoices(process.platform === 'win32' ? await discoverWindowsAgents() : []);
  process.stdout.write(JSON.stringify(result));
  if (result && result.ok === false) process.exitCode = 1;
}
