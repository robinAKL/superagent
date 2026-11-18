/**
 * SuperAgent Link entry: pair in the browser if needed, then long-poll.
 * On 401 (revoked) the stored token is deleted so the next start re-pairs.
 */
import { spawn } from 'node:child_process';
import { loadToken, clearToken } from './pair-store.mjs';
import { connectUrl, pollUntilToken, startPairing } from './pair-flow.mjs';

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

export async function pollUntilRevoked(origin, token, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), forget = clearToken) {
  for (;;) {
    const res = await fetchImpl(`${origin.replace(/\/$/, '')}/api/v1/worker-link/poll`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ waitMs: 25_000, since: 0 }),
    });
    if (res.status === 401) {
      await forget();
      return { status: 'revoked', rePair: true };
    }
    if (!res.ok) await sleep(2_000);
  }
}

const origin = process.env.SUPERAGENT_ORIGIN;
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('start.mjs')) {
  if (!origin) {
    console.error('Set SUPERAGENT_ORIGIN, e.g. https://staging.example');
    process.exit(1);
  }
  const token = await ensurePaired(origin);
  const result = await pollUntilRevoked(origin, token);
  if (result.rePair) {
    console.error('This computer was revoked. Run Link again to pair.');
    process.exit(2);
  }
}
