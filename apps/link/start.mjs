/**
 * SuperAgent Link entry: pair in the browser if needed, then stay reachable.
 * Presence uses /heartbeat so this process cannot claim work it will not run.
 * A one-shot poll+succeed is exported for the dispatch round-trip test; the
 * real agent runtime (T-29) should own /poll.
 */
import { spawn } from 'node:child_process';
import { loadToken, clearToken } from './pair-store.mjs';
import { connectUrl, pollUntilToken, startPairing } from './pair-flow.mjs';

function originUrl(origin, path) {
  return `${origin.replace(/\/$/, '')}${path}`;
}

export function openBrowser(url, platform = process.platform, spawnImpl = spawn) {
  if (platform === 'win32') spawnImpl('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  else if (platform === 'darwin') spawnImpl('open', [url], { detached: true, stdio: 'ignore' }).unref();
  else spawnImpl('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

export async function ensurePaired(origin, opts = {}) {
  const existing = await (opts.loadToken ?? loadToken)();
  if (existing) return existing;
  const started = await startPairing(origin, opts.fetchImpl, opts.detect);
  const url = started.verifyUrl ?? connectUrl(origin, started.userCode);
  (opts.openBrowser ?? openBrowser)(url);
  const result = await pollUntilToken(origin, started.deviceCode, opts.fetchImpl, opts.sleep);
  if (result.status !== 'allowed' || !result.token) throw new Error(`pair_${result.status}`);
  return result.token;
}

export async function stayAlive(origin, token, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), forget = clearToken) {
  for (;;) {
    const res = await fetchImpl(originUrl(origin, '/api/v1/worker-link/heartbeat'), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    if (res.status === 401) {
      await forget();
      return { status: 'revoked', rePair: true };
    }
    await sleep(res.ok ? 15_000 : 2_000);
  }
}

/** Claim at most one task and report it done. Does not loop. */
export async function completeOneTask(origin, token, fetchImpl = fetch) {
  const polled = await fetchImpl(originUrl(origin, '/api/v1/worker-link/poll'), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ waitMs: 0, since: 0 }),
  });
  if (polled.status === 401) return { status: 'revoked' };
  const body = await polled.json();
  if (!body.task) return { status: 'idle' };
  const done = await fetchImpl(originUrl(origin, `/api/v1/worker-link/tasks/${body.task.id}/succeed`), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ attempt: body.task.attempt }),
  });
  return { status: done.ok ? 'reported' : 'failed', taskId: body.task.id, attempt: body.task.attempt };
}

const origin = process.env.SUPERAGENT_ORIGIN;
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('start.mjs')) {
  if (!origin) {
    console.error('Set SUPERAGENT_ORIGIN, e.g. https://staging.example');
    process.exit(1);
  }
  const token = await ensurePaired(origin);
  const result = await stayAlive(origin, token);
  if (result.rePair) {
    console.error('This computer was revoked. Run Link again to pair.');
    process.exit(2);
  }
}
