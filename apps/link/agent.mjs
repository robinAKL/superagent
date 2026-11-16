import { spawn, spawnSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';

const AUTH_ERROR = /not logged in|please (log|sign) in|authentication required|unauthorized|invalid api key|login required|token (has )?expired/i;
const RESULT_LIMIT = 60_000;

export function projectDirectory(projects, projectId) {
  const project = projects.get(projectId);
  if (!project || !isAbsolute(project.directory)) throw new Error('Project directory is not allowlisted.');
  const directory = realpathSync(project.directory);
  if (!statSync(directory).isDirectory()) throw new Error('Configured project path is not a directory.');
  return { ...project, directory };
}

export function launchAgent(project, prompt, session, notify) {
  const codex = project.agent === 'codex';
  const args = codex
    ? ['exec', '--json', '--sandbox', 'read-only', ...(session ? ['resume', session] : []), '-']
    : ['--print', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'plan', ...(session ? ['--resume', session] : [])];
  const command = project.executable.endsWith('.js') || project.executable.endsWith('.mjs') ? process.execPath : project.executable;
  const argv = command === process.execPath ? [project.executable, ...args] : args;
  const env = { ...process.env };
  delete env.SUPERAGENT_WORKER_TOKEN;
  const child = spawn(command, argv, {
    cwd: project.directory, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32', windowsHide: true,
  });
  let result = '';
  let errorText = '';
  let cancelled = false;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let item;
    try { item = JSON.parse(line); } catch { return; }
    if (item.type === 'thread.started' || (item.type === 'system' && item.subtype === 'init')) {
      const id = item.thread_id ?? item.session_id;
      if (typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) notify({ session: id });
    }
    if (item.type === 'item.completed' && item.item?.type === 'agent_message' && typeof item.item.text === 'string') {
      result = item.item.text.slice(0, RESULT_LIMIT);
      notify({ progress: 'Agent returned a response.' });
    }
    if (item.type === 'result') {
      if (item.is_error) errorText = String(item.result ?? item.subtype ?? '').slice(0, 8_000);
      else if (typeof item.result === 'string') result = item.result.slice(0, RESULT_LIMIT);
    }
    if (item.type === 'error' || item.type === 'turn.failed') {
      errorText = String(item.message ?? item.error?.message ?? '').slice(0, 8_000);
    }
    if (item.type === 'item.started' || item.type === 'assistant') notify({ progress: 'Agent is processing the task.' });
  });
  child.stderr.on('data', (chunk) => { errorText = (errorText + String(chunk)).slice(-8_000); });
  child.stdin.on('error', () => {}); // Early CLI exit can close the pipe before the prompt is written.
  child.stdin.end(prompt);
  const completed = new Promise((resolve) => {
    child.once('error', () => resolve({ failure: 'Agent CLI could not be started.' }));
    child.once('close', (code) => {
      if (cancelled) resolve({ cancelled: true });
      else if (code === 0 && result) resolve({ result });
      else if (AUTH_ERROR.test(errorText)) resolve({ authentication: project.agent + ' requires sign-in.' });
      else resolve({ failure: 'Agent CLI did not return a completed result.' });
    });
  });
  function cancel() {
    if (cancelled || !child.pid || child.exitCode !== null) return;
    cancelled = true;
    if (process.platform === 'win32') {
      const taskkill = join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'taskkill.exe');
      const terminated = spawnSync(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      if (terminated.status !== 0) child.kill();
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  }
  return { cancel, completed };
}
