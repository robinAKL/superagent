import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { saveToken, tokenPath } from '../../link/pair-store.mjs';

const run = promisify(execFile);
const [installer, version] = process.argv.slice(2);
assert.equal(process.platform, 'win32');
assert.ok(installer && version, 'Pass the installer path and version.');

const installDir = path.join(process.env.LOCALAPPDATA, 'Programs', 'SuperAgentLink');
const dataDir = path.join(process.env.LOCALAPPDATA, 'SuperAgentLink');
const uninstaller = path.join(installDir, 'Uninstall.exe');
const sentinel = path.join(installDir, 'unrelated-file.txt');
const log = path.join(dataDir, 'logs', 'link.log');
const shortcut = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'SuperAgent Link.lnk');
assert.ok(
  [installDir, dataDir, tokenPath()].every((target) => !existsSync(target)),
  'Use a Windows account with no existing SuperAgent Link installation.',
);

const mockToken = 'saw_installer_smoke_test';
const assignmentId = 'windows-ci-assignment';
const assignment = {
  seq: 1,
  kind: 'wake',
  payload: { roomTaskId: assignmentId, projectId: 'windows-ci', prompt: 'Check the installed client' },
};
let heartbeatCount = 0;
let projects;
let revoke = false;
const progress = [];
const reports = [];
const server = createServer(async (req, res) => {
  if (req.method !== 'POST') return res.writeHead(404).end();
  if (revoke || req.headers.authorization !== 'Bearer ' + mockToken) return res.writeHead(401).end();
  try {
    const route = req.url?.replace(/^\/api\/v1\/worker-link/, '');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    res.setHeader('content-type', 'application/json');
    switch (route) {
      case '/heartbeat':
        heartbeatCount++;
        if (body.capabilities?.projects) projects = body.capabilities.projects;
        return res.writeHead(heartbeatCount === 1 ? 503 : 200).end('{}');
      case '/poll':
        if (body.since > 0) await delay(200);
        return res.end(JSON.stringify({ events: body.since === 0 ? [assignment] : [] }));
      case '/room-tasks/' + assignmentId + '/progress':
        progress.push(body.body);
        return res.end('{}');
      case '/room-tasks/' + assignmentId + '/report':
        reports.push(body.body);
        return res.end('{}');
      default:
        return res.writeHead(404).end('{}');
    }
  } catch {
    res.writeHead(400).end('{}');
  }
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

async function waitFor(label, predicate) {
  const stopAt = Date.now() + 40_000;
  while (Date.now() < stopAt) {
    if (await predicate()) return;
    await delay(250);
  }
  throw new Error('Timed out waiting for ' + label);
}

function processExited(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error.code === 'ESRCH') return true;
    throw error;
  }
}

async function readLog() {
  try {
    return await readFile(log, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

async function trayRequestsSystemAwake() {
  const { stdout } = await run('powercfg.exe', ['/requests']);
  const systemRequests = stdout.match(/^SYSTEM:\s*\r?\n([\s\S]*?)(?=^[A-Z_]+:|\s*$)/m)?.[1];
  return /SuperAgentLink\.exe/i.test(systemRequests ?? '');
}

try {
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, 'config.json'), JSON.stringify({
    serverUrl: 'http://127.0.0.1:' + server.address().port,
  }));
  await saveToken(mockToken);
  await run(path.resolve(installer), ['/S'], { timeout: 90_000 });

  const bundledNode = path.join(installDir, 'runtime', 'node.exe');
  assert.match((await run(bundledNode, ['--version'])).stdout, /^v22\./);
  const tray = path.join(installDir, 'SuperAgentLink.exe');
  const selfCheck = JSON.parse((await run(tray, ['--self-check'])).stdout);
  assert.deepEqual(selfCheck, { ok: true, version });
  assert.ok(existsSync(shortcut));
  const task = await run('schtasks.exe', ['/Query', '/TN', 'SuperAgentLink', '/XML']);
  assert.match(task.stdout, /<LogonTrigger>/);
  assert.match(task.stdout, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(task.stdout, /<RestartOnFailure>[\s\S]*<Count>3<\/Count>/);
  console.log('Silent install verified: bundled Node, build version, logon activation, crash restart policy.');

  await waitFor('a successful heartbeat after an HTTP 503', async () => heartbeatCount >= 2
    && /LINK_STATE:reconnecting[\s\S]*LINK_STATE:connected/.test(await readLog()));
  const firstChild = Number((await readLog()).match(/Started link process pid=(\d+)/)?.[1]);
  assert.ok(firstChild > 0);
  process.kill(firstChild);
  await waitFor('a heartbeat after the Link worker exits', () => heartbeatCount >= 3);
  console.log('Heartbeat verified: 503 recovery and worker restart.');

  const runningLog = await readLog();
  const trayPid = Number(runningLog.match(/Started tray process pid=(\d+)/)?.[1]);
  const workerPid = Number([...runningLog.matchAll(/Started link process pid=(\d+)/g)].at(-1)?.[1]);
  assert.ok(trayPid > 0 && workerPid > 0 && workerPid !== firstChild);
  const beforeTrayExit = heartbeatCount;
  process.kill(trayPid);
  await waitFor('the tray job to close its worker', () => processExited(workerPid));
  await waitFor('a heartbeat after the supervisor restarts the tray', async () => {
    const pids = [...(await readLog()).matchAll(/Started tray process pid=(\d+)/g)].map((match) => Number(match[1]));
    return pids.some((pid) => pid !== trayPid) && heartbeatCount > beforeTrayExit;
  });
  console.log('Tray recovery verified: its worker exited and the supervisor restarted the tray.');

  const beforeUpgrade = heartbeatCount;
  await run(path.resolve(installer), ['/S'], { timeout: 90_000 });
  await waitFor('a heartbeat after silent upgrade', () => heartbeatCount > beforeUpgrade);
  assert.ok(existsSync(tokenPath()));
  console.log('Silent upgrade verified: the installed client restarted with its existing pairing.');

  const projectDir = path.join(dataDir, 'CI project');
  const fixture = path.join(projectDir, 'agent.mjs');
  const finishTask = path.join(projectDir, 'finish-task');
  await mkdir(projectDir);
  await writeFile(fixture, [
    "import { existsSync } from 'node:fs';",
    "import { setTimeout as delay } from 'node:timers/promises';",
    "let prompt = '';",
    'for await (const chunk of process.stdin) prompt += chunk;',
    "console.log(JSON.stringify({ type: 'thread.started', thread_id: 'windows-ci-session' }));",
    "while (!existsSync('finish-task')) await delay(100);",
    "console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Executed: ' + prompt } }));",
  ].join('\n'));
  await writeFile(path.join(dataDir, 'link-runtime.json'), JSON.stringify({
    projects: { 'windows-ci': { directory: projectDir, executable: fixture, agent: 'codex' } },
  }));
  const latestWorker = Number([...((await readLog()).matchAll(/Started link process pid=(\d+)/g))].at(-1)?.[1]);
  assert.ok(latestWorker > 0);
  process.kill(latestWorker);

  await waitFor('the installed worker to advertise the configured project', () => projects?.length === 1);
  assert.deepEqual(projects, [{ id: 'windows-ci', name: 'CI project', agent: 'codex' }]);
  await waitFor('the installed worker to start its assigned CLI', async () =>
    progress.includes('Agent started.') && (await readLog()).includes('LINK_TASK:start'));
  await waitFor('Windows to show the tray sleep request during the task', trayRequestsSystemAwake);
  await writeFile(finishTask, '');
  await waitFor('the installed worker to return the CLI result', () => reports.length > 0);
  assert.deepEqual(reports, ['Executed: Check the installed client']);
  await waitFor('the tray to release its sleep request after task completion', async () =>
    (await readLog()).includes('LINK_TASK:end') && !(await trayRequestsSystemAwake()));
  console.log('Installed dispatch verified: long poll, local CLI fixture, result report and Windows sleep request lifecycle.');

  revoke = true;
  await waitFor('token revocation', async () => !existsSync(tokenPath())
    && /Link process exited with code 2/.test(await readLog()));
  console.log('Revocation verified: authentication token removed.');

  await saveToken(mockToken);
  await writeFile(sentinel, 'keep existing user files');
} catch (error) {
  console.error(await readLog());
  throw error;
} finally {
  server.close();
  if (existsSync(uninstaller)) {
    await run(uninstaller, ['/S'], { timeout: 90_000 });
    await waitFor('uninstall', () => !existsSync(path.join(installDir, 'SuperAgentLink.exe'))
      && !existsSync(dataDir) && !existsSync(tokenPath()));
  }
}

assert.equal(await readFile(sentinel, 'utf8'), 'keep existing user files');
assert.ok(!existsSync(path.join(installDir, 'runtime')));
assert.ok(!existsSync(shortcut));
await assert.rejects(
  run('schtasks.exe', ['/Query', '/TN', 'SuperAgentLink']),
  (error) => Number.isInteger(error.code) && error.code !== 0,
);
await rm(sentinel);
await rmdir(installDir);
console.log('Uninstall verified: runtime, task, app data and token removed, unrelated file preserved.');
