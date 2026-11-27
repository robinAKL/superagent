import { spawn, spawnSync } from 'node:child_process';
import { realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { runCodexTurn } from './codex-app-server.mjs';
import { agentSpec, approvalArgs, commandLine, headlessArgs } from './agents.mjs';
import { browserProfile, findBrowser } from './browser-mcp.mjs';

import { AUTH_ERROR, failureReason } from './agent-errors.mjs';
const RESULT_LIMIT = 60_000;

export function projectDirectory(projects, projectId) {
  const project = projects.get(projectId);
  if (!project || !isAbsolute(project.directory)) throw new Error('Project directory is not allowlisted.');
  const directory = realpathSync(project.directory);
  if (!statSync(directory).isDirectory()) throw new Error('Configured project path is not a directory.');
  return { ...project, directory };
}

function spawnAgent(project, args) {
  const { command, argv, verbatim } = commandLine(project.executable, args);
  const env = { ...process.env };
  delete env.SUPERAGENT_WORKER_TOKEN;
  return spawn(command, argv, {
    cwd: project.directory, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsVerbatimArguments: verbatim,
    detached: process.platform !== 'win32', windowsHide: true,
  });
}

function terminateAgent(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const taskkill = join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'taskkill.exe');
    const terminated = spawnSync(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    if (terminated.status !== 0) child.kill();
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

export function launchCodexWithApprovals(project, prompt, session, notify, approve) {
  const child = spawnAgent(project, ['app-server']);
  const controller = new AbortController();
  child.stderr.resume();
  child.stdin.on('error', () => {}); // App Server can exit with writes queued.
  const closed = new Promise((resolve) => {
    child.once('error', () => resolve({ failure: 'Codex App Server could not be started.' }));
    child.once('close', () => resolve({ failure: 'Codex App Server disconnected.' }));
  });
  const turn = runCodexTurn({
    input: child.stdin, output: child.stdout, cwd: project.directory, prompt, session, notify, approve, signal: controller.signal,
  });
  const completed = Promise.race([turn, closed]).finally(() => {
    controller.abort();
    terminateAgent(child);
  });
  return { completed, cancel: () => controller.abort() };
}

const PERMISSION_TOOL = join(dirname(fileURLToPath(import.meta.url)), 'permission-mcp.mjs');

/**
 * Claude Code's permission hook: a one-off MCP config with Link's permission tool, pointed at this task's loopback
 * approver. The config file holds no token, only the local address and the task's secret, and is removed afterwards.
 */
const BROWSER_TOOL = join(dirname(fileURLToPath(import.meta.url)), 'browser-mcp.mjs');

/**
 * The background browser (browser-mcp.mjs) as an MCP server for one project, or null on a computer without Chrome or
 * Edge. Everything it needs is passed explicitly: a client may start MCP servers with a trimmed environment.
 */
export function browserServer(project, env = process.env, find = findBrowser, { visible = false } = {}) {
  if (env.SUPERAGENT_BROWSER_DISABLED === '1') return null;
  const executable = find(env);
  if (!executable) return null;
  return {
    command: process.execPath,
    args: [BROWSER_TOOL],
    env: {
      SUPERAGENT_BROWSER: executable,
      SUPERAGENT_BROWSER_PROFILE: browserProfile(env),
      SUPERAGENT_BROWSER_OUT: project.directory,
      SUPERAGENT_BROWSER_VISIBLE: visible ? '1' : '0',
    },
  };
}

/** Said before the task, so the client reaches for the background browser rather than the screen. */
export const BROWSER_HINT = '（SuperAgent Link：要打开网页、查资料或填写网页表单时，请使用 superagent_browser 员工浏览器工具（browser_open、browser_read、browser_click、browser_type、browser_screenshot）。它不需要操作屏幕，电脑锁屏或远程桌面最小化时也能用。不要去操作屏幕上的其他窗口，也不要控制用户自己打开的浏览器。'
  + '如果网站要求登录，不要尝试输入账号密码，直接回报：“没有做成：<网站> 需要登录。请在这台电脑的 Link 托盘里点「员工浏览器（登录网站）」，或在网页「已连接的电脑」里点「打开员工浏览器」，登录一次后告诉我重试。”）';

/** Codex takes MCP servers as -c overrides; JSON strings are valid TOML basic strings. */
export function codexBrowserArgs(server) {
  if (!server) return [];
  const env = Object.entries(server.env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join(', ');
  return [
    '-c', `mcp_servers.superagent_browser.command=${JSON.stringify(server.command)}`,
    '-c', `mcp_servers.superagent_browser.args=[${server.args.map((arg) => JSON.stringify(arg)).join(', ')}]`,
    '-c', `mcp_servers.superagent_browser.env={ ${env} }`,
  ];
}

/** Claude Code's MCP servers for one run: the background browser, and the permission tool when the room approves. */
function mcpArgs(approver, browser) {
  const servers = {};
  if (approver) {
    servers.superagent_link = {
      command: process.execPath, args: [PERMISSION_TOOL],
      env: { SUPERAGENT_APPROVER_URL: approver.url, SUPERAGENT_APPROVER_SECRET: approver.secret },
    };
  }
  if (browser) servers.superagent_browser = browser;
  if (!Object.keys(servers).length) return { args: [], cleanup: () => {} };
  const file = join(tmpdir(), `superagent-link-mcp-${randomUUID()}.json`);
  writeFileSync(file, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
  return {
    args: ['--mcp-config', file, ...(approver ? ['--permission-prompt-tool', 'mcp__superagent_link__approve'] : [])],
    cleanup: () => { try { rmSync(file, { force: true }); } catch { /* temp file */ } },
  };
}

/**
 * One headless run of the project's client. Claude Code asks the room through `approver`; Codex and the other clients
 * (agents.mjs) get the employee's authorisation `mode` as their own sandbox or approval setting.
 */
export function launchAgent(project, prompt, session, notify, approver = null, { mode = 'standard', visible = false, browser = browserServer(project, process.env, findBrowser, { visible }) } = {}) {
  const codex = project.agent === 'codex';
  const claude = project.agent === 'claude-code';
  // Claude Code and Codex get the background browser; the hint makes them use it instead of the screen.
  const withBrowser = Boolean(browser) && (codex || claude);
  if (withBrowser) prompt = `${BROWSER_HINT}\n\n${prompt}`;
  const permissions = claude ? mcpArgs(approver, withBrowser ? browser : null) : { args: [], cleanup: () => {} };
  const spec = agentSpec(project.agent);
  // An employee's folder is often plain business files, not a git repository: Codex refuses to run there unless told
  // not to check ("Not inside a trusted directory and --skip-git-repo-check was not specified").
  const args = codex
    ? ['exec', '--json', '--skip-git-repo-check', ...approvalArgs('codex', mode), ...codexBrowserArgs(withBrowser ? browser : null),
      ...(session ? ['resume', session] : []), '-']
    : claude
      ? ['--print', '--output-format', 'stream-json', '--verbose', ...permissions.args, ...(session ? ['--resume', session] : [])]
      : headlessArgs(project.agent, { session, mode, prompt });
  if (!args) throw new Error('Unknown local agent.');
  const promptOnStdin = !spec?.promptArg;
  const child = spawnAgent(project, args);
  let result = '';
  let streamed = '';
  let plain = '';
  let errorText = '';
  let cancelled = false;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let item;
    try { item = JSON.parse(line); } catch { item = null; }
    if (!item || typeof item !== 'object') {
      // A client without JSON output (GitHub Copilot CLI with -s) prints only its answer.
      if (!promptOnStdin) plain = (plain + line + '\n').slice(-RESULT_LIMIT);
      return;
    }
    if (item.type === 'thread.started' || item.type === 'init'
      || (item.type === 'system' && (item.subtype === 'init' || item.subtype === 'session_start'))) {
      const id = item.thread_id ?? item.session_id;
      if (typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) notify({ session: id });
      // The tools this agent has here, MCP tools included ("mcp__vera-crm__approve_order"): reported to the room.
      if (Array.isArray(item.tools)) notify({ tools: item.tools.filter((tool) => typeof tool === 'string') });
    }
    if (item.type === 'item.completed' && item.item?.type === 'agent_message' && typeof item.item.text === 'string') {
      result = item.item.text.slice(0, RESULT_LIMIT);
      notify({ progress: 'Agent returned a response.' });
    }
    // Gemini CLI streams the answer as assistant messages (whole or in deltas) and ends with a result without text.
    if (item.type === 'message' && item.role === 'assistant' && typeof item.content === 'string') {
      streamed = (item.delta ? streamed + item.content : item.content).slice(-RESULT_LIMIT);
      notify({ progress: 'Agent is processing the task.' });
    }
    if (item.type === 'tool_use' || item.type === 'tool_call') notify({ progress: 'Agent is processing the task.' });
    if (item.type === 'result') {
      const failed = item.is_error || item.status === 'error' || (item.error && typeof item.result !== 'string');
      if (failed) errorText = String(item.error?.message ?? item.error ?? item.result ?? item.subtype ?? '').slice(0, 8_000);
      else if (typeof item.result === 'string' && item.result) result = item.result.slice(0, RESULT_LIMIT);
      else if (typeof item.response === 'string' && item.response) result = item.response.slice(0, RESULT_LIMIT);
      else if (streamed) result = streamed;
    }
    if (item.type === 'error' || item.type === 'turn.failed') {
      errorText = String(item.message ?? item.error?.message ?? '').slice(0, 8_000);
    }
    if (item.type === 'item.started' || item.type === 'assistant') notify({ progress: 'Agent is processing the task.' });
  });
  child.stderr.on('data', (chunk) => { errorText = (errorText + String(chunk)).slice(-8_000); });
  child.stdin.on('error', () => {}); // Early CLI exit can close the pipe before the prompt is written.
  child.stdin.end(promptOnStdin ? prompt : '');
  const completed = new Promise((resolve) => {
    child.once('close', permissions.cleanup);
    child.once('error', () => resolve({ failure: 'Agent CLI could not be started.' }));
    child.once('close', (code) => {
      if (!result && code === 0) result = (streamed || plain.trim()).slice(0, RESULT_LIMIT);
      if (cancelled) resolve({ cancelled: true });
      else if (code === 0 && result) resolve({ result });
      else if (AUTH_ERROR.test(errorText)) resolve({ authentication: project.agent + ' requires sign-in.' });
      else {
        const reason = failureReason(errorText);
        resolve({ failure: 'Agent CLI did not return a completed result.' + (reason ? ' ' + reason : '') });
      }
    });
  });
  function cancel() {
    if (cancelled || !child.pid || child.exitCode !== null) return;
    cancelled = true;
    terminateAgent(child);
  }
  return { cancel, completed };
}
