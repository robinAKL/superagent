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
assert.ok(
  [installDir, dataDir, tokenPath()].every((target) => !existsSync(target)),
  'Use a Windows account with no existing SuperAgent Link installation.',
);

const mockToken = 'saw_installer_smoke_test';
let heartbeatCount = 0;
let revoke = false;
const server = createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/api/v1/worker-link/heartbeat') {
    res.writeHead(404).end();
  } else if (revoke || req.headers.authorization !== 'Bearer ' + mockToken) {
    res.writeHead(401).end();
  } else {
    heartbeatCount++;
    res.writeHead(heartbeatCount === 1 ? 503 : 204).end();
  }
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

async function waitFor(label, predicate, timeout = 40_000) {
  const stopAt = Date.now() + timeout;
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
  await waitFor('a heartbeat after Task Scheduler restarts the tray', async () => {
    const pids = [...(await readLog()).matchAll(/Started tray process pid=(\d+)/g)].map((match) => Number(match[1]));
    return pids.some((pid) => pid !== trayPid) && heartbeatCount > beforeTrayExit;
  }, 100_000);
  console.log('Tray recovery verified: its worker exited and Task Scheduler restarted the tray.');

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
await assert.rejects(
  run('schtasks.exe', ['/Query', '/TN', 'SuperAgentLink']),
  (error) => Number.isInteger(error.code) && error.code !== 0,
);
await rm(sentinel);
await rmdir(installDir);
console.log('Uninstall verified: runtime, task, app data and token removed, unrelated file preserved.');
