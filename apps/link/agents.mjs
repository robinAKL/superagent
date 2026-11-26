import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The local clients (agent CLIs) Link can run command-room work with, and how each is installed, signed in to and
 * started headless. The order is the order people see; keep it in step with LINK_AGENTS in packages/shared.
 *
 *   bins        executable names looked for on PATH and in the client's own install folders (.exe, then .cmd)
 *   npm         the JavaScript entry point inside an npm global install, run with Link's own Node.js (otherwise
 *               read from the npm .cmd shim)
 *   dirs(env)   extra install folders on Windows
 *   status      a non-interactive sign-in check; without one, signedIn(env) reads the client's own credential files
 *   loginArgs   the client's own sign-in; loginHint is shown while it is open (an interactive window for some)
 *   install     the official Windows install, run by Link in PowerShell
 */

/** npm global install; Node.js LTS comes first from winget when npm is missing. One line: it is passed to -Command. */
const NPM_INSTALL = (pkg) => [
  '$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue',
  'if (-not $npm) { winget install --id OpenJS.NodeJS.LTS -e --silent --accept-source-agreements --accept-package-agreements; '
    + '$env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User"); '
    + '$npm = Get-Command npm.cmd -ErrorAction Stop }',
  `& $npm.Source install -g ${pkg}`,
  'exit $LASTEXITCODE',
].join('; ');

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function home(env) {
  return env.USERPROFILE || env.HOME || homedir();
}

export const AGENT_SPECS = [
  {
    agent: 'claude-code',
    label: 'Claude Code',
    bins: ['claude'],
    npm: '@anthropic-ai/claude-code/cli.js',
    dirs: (env) => [join(home(env), '.local', 'bin')],
    status: ['auth', 'status'],
    loginArgs: ['auth', 'login'],
    loginHint: '请在弹出的浏览器里登录 Claude 账号。',
    install: { command: 'irm https://claude.ai/install.ps1 | iex', env: {} },
  },
  {
    agent: 'codex',
    label: 'Codex',
    bins: ['codex'],
    npm: '@openai/codex/bin/codex.js',
    dirs: (env) => (env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin')] : []),
    status: ['login', 'status'],
    loginArgs: ['login'],
    loginHint: '请在弹出的浏览器里登录 ChatGPT 账号。',
    install: { command: 'irm https://chatgpt.com/codex/install.ps1 | iex', env: { CODEX_NON_INTERACTIVE: '1' } },
  },
  {
    agent: 'cursor',
    label: 'Cursor CLI',
    // The installer adds "agent" (and the older name "cursor-agent"); "agent" is only trusted in Cursor's own folder.
    bins: ['cursor-agent'],
    ownBins: ['agent', 'cursor-agent'],
    dirs: (env) => [...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'cursor-agent')] : []), join(home(env), '.local', 'bin')],
    status: ['status'],
    loginArgs: ['login'],
    loginHint: '请在弹出的浏览器里登录 Cursor 账号。',
    install: { command: "irm 'https://cursor.com/install?win32=true' | iex", env: {} },
  },
  {
    agent: 'copilot',
    label: 'GitHub Copilot CLI',
    bins: ['copilot'],
    dirs: (env) => (env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links')] : []),
    // No status command: a sign-in is kept in ~/.copilot/config.json (or a token in the environment).
    signedIn: (env) => Boolean(env.COPILOT_GITHUB_TOKEN || env.GH_TOKEN || env.GITHUB_TOKEN)
      || (readJson(join(env.COPILOT_HOME || join(home(env), '.copilot'), 'config.json'))?.logged_in_users?.length ?? 0) > 0,
    loginArgs: ['login'],
    loginHint: '弹出的窗口会显示一个验证码，请在浏览器里登录 GitHub 并输入它（需要 Copilot 订阅）。',
    install: { command: NPM_INSTALL('@github/copilot'), env: {} },
    // Copilot reads its prompt from -p; the Windows command line limit is far above the room's 32,000 characters.
    promptArg: true,
  },
  {
    agent: 'gemini',
    label: 'Gemini CLI',
    bins: ['gemini'],
    // No status command: Google sign-in is cached in ~/.gemini/oauth_creds.json; an API key also counts.
    signedIn: (env) => Boolean(env.GEMINI_API_KEY || (env.GOOGLE_API_KEY && env.GOOGLE_GENAI_USE_VERTEXAI))
      || existsSync(join(home(env), '.gemini', 'oauth_creds.json'))
      || /GEMINI_API_KEY\s*=\s*\S/.test((() => { try { return readFileSync(join(home(env), '.gemini', '.env'), 'utf8'); } catch { return ''; } })()),
    loginArgs: [],
    loginHint: '在弹出的 Gemini 窗口里选择「Sign in with Google」，在浏览器登录；看到登录成功后可以关掉那个窗口。',
    install: { command: NPM_INSTALL('@google/gemini-cli'), env: {} },
  },
  {
    agent: 'qwen',
    label: 'Qwen Code',
    bins: ['qwen'],
    // No status command: Qwen sign-in is cached in ~/.qwen/oauth_creds.json; a configured provider also counts.
    signedIn: (env) => existsSync(join(home(env), '.qwen', 'oauth_creds.json'))
      || Boolean(readJson(join(home(env), '.qwen', 'settings.json'))?.security?.auth?.selectedType),
    loginArgs: [],
    loginHint: '在弹出的 Qwen Code 窗口里输入 /auth，按提示在浏览器登录或填写服务商密钥；完成后可以关掉那个窗口。',
    install: { command: NPM_INSTALL('@qwen-code/qwen-code'), env: {} },
  },
];

export const AGENTS = AGENT_SPECS.map((spec) => spec.agent);

export function agentSpec(agent) {
  return AGENT_SPECS.find((spec) => spec.agent === agent) ?? null;
}

/**
 * The tool approval each new client gets from the employee's authorisation mode on this computer. These clients
 * have no hook for Link to ask the command room, so the mode is applied as the client's own approval setting.
 */
export function approvalArgs(agent, mode = 'standard') {
  const level = ['strict', 'standard', 'full'].includes(mode) ? mode : 'standard';
  switch (agent) {
    case 'cursor': return level === 'full' ? ['--force'] : [];
    case 'copilot': return level === 'full' ? ['--allow-all-tools'] : level === 'standard' ? ['--allow-tool=write'] : [];
    case 'gemini': return ['--approval-mode', { strict: 'default', standard: 'auto_edit', full: 'yolo' }[level]];
    case 'qwen': return ['--approval-mode', { strict: 'default', standard: 'auto-edit', full: 'yolo' }[level]];
    default: return [];
  }
}

const SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

/** The headless command line for one task. The prompt goes on stdin unless the client only reads it from -p. */
export function headlessArgs(agent, { session = null, mode = 'standard', prompt = '' } = {}) {
  const resume = session && SESSION_ID.test(session) ? session : null;
  switch (agent) {
    case 'cursor':
      return ['--print', '--output-format', 'stream-json', '--trust', ...approvalArgs(agent, mode), ...(resume ? ['--resume', resume] : [])];
    case 'copilot':
      return ['-p', prompt, '-s', '--no-ask-user', ...approvalArgs(agent, mode)];
    case 'gemini':
    case 'qwen':
      return ['--output-format', 'stream-json', ...approvalArgs(agent, mode), ...(resume ? ['--resume', resume] : [])];
    default:
      return null;
  }
}

/**
 * How to start a client executable without a shell: JavaScript entry points run with Link's Node.js; a .cmd launcher
 * (Cursor's installer) goes through cmd.exe with fixed, checked arguments only, never the prompt.
 */
export function commandLine(executable, args) {
  if (/\.(c|m)?js$/i.test(executable)) return { command: process.execPath, argv: [executable, ...args], verbatim: false };
  if (/\.(cmd|bat)$/i.test(executable)) {
    if (args.some((arg) => /["%^&|<>\r\n!]/.test(arg))) throw new Error('This client cannot take these arguments through its .cmd launcher.');
    const quote = (part) => (/\s/.test(part) || part === '' ? `"${part}"` : part);
    const cmd = join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'cmd.exe');
    return { command: cmd, argv: ['/d', '/s', '/c', `"${[`"${executable}"`, ...args.map(quote)].join(' ')}"`], verbatim: true };
  }
  return { command: executable, argv: args, verbatim: false };
}

/** The JavaScript file an npm global .cmd shim starts ("%dp0%\node_modules\…\cli.js"), or null for another launcher. */
export function npmShimTarget(cmdText) {
  const match = /%~?dp0%?\\(node_modules\\[^"\s]+?\.(?:c|m)?js)\b/i.exec(String(cmdText ?? ''));
  return match ? match[1] : null;
}
