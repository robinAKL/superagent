/**
 * SuperAgent Link entry: pair in the browser if needed, then stay reachable.
 * Presence uses /heartbeat so this process cannot claim work it will not run.
 * Real /poll dispatch belongs to the Link runtime (T-29).
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

export async function stayAlive(origin, token, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), forget = clearToken, onStatus = () => {}) {
  let lastStatus;
  for (;;) {
    let res;
    try {
      res = await fetchImpl(originUrl(origin, '/api/v1/worker-link/heartbeat'), {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // Treat a disconnected network like a failed heartbeat and retry.
    }
    const status = res?.status === 401 ? 'revoked' : res?.ok ? 'connected' : 'reconnecting';
    if (status !== lastStatus) {
      onStatus(status);
      lastStatus = status;
    }
    if (status === 'revoked') {
      await forget();
      return { status: 'revoked', rePair: true };
    }
    await sleep(status === 'connected' ? 15_000 : 2_000);
  }
}

const origin = process.env.SUPERAGENT_ORIGIN;
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('start.mjs')) {
  if (!origin) {
    console.error('Set SUPERAGENT_ORIGIN, e.g. https://staging.example');
    process.exit(1);
  }
  const token = await ensurePaired(origin);
  const result = await stayAlive(origin, token, undefined, undefined, undefined, (status) => console.log(`LINK_STATE:${status}`));
  if (result.rePair) {
    console.error('This computer was revoked. Run Link again to pair.');
    process.exit(2);
  }
}
