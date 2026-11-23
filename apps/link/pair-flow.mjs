/**
 * First-run pairing: open /#connect?code=… in the browser, poll until the owner allows,
 * then store the worker token with DPAPI on Windows.
 */
import { detectAgents } from './detect-agents.mjs';
import { saveToken } from './pair-store.mjs';

export function connectUrl(origin, userCode) {
  const formatted = userCode.includes('-') ? userCode : `${userCode.slice(0, 4)}-${userCode.slice(4)}`;
  return `${origin.replace(/\/$/, '')}/#connect?code=${encodeURIComponent(formatted)}`;
}

export async function startPairing(origin, fetchImpl = fetch, detect = detectAgents) {
  const agents = await detect();
  const res = await fetchImpl(`${origin.replace(/\/$/, '')}/api/v1/worker-link/pair/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostname: process.env.COMPUTERNAME || process.env.HOSTNAME || 'this computer', agents }),
  });
  if (!res.ok) throw new Error(`pair_start_${res.status}`);
  const body = await res.json();
  return { ...body, verifyUrl: connectUrl(origin, body.userCode), agents };
}

/**
 * Polls until the code is allowed, denied or expired. Waits for the code's full lifetime (`expiresAt` from
 * pair/start) so a late "Allow" still connects; a server restart or network error during that time is retried.
 */
export async function pollUntilToken(origin, deviceCode, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), expiresAt, now = Date.now) {
  const deadline = Number.isFinite(expiresAt) ? expiresAt + 5_000 : now() + 10 * 60_000;
  while (now() < deadline) {
    let body = null;
    try {
      const res = await fetchImpl(`${origin.replace(/\/$/, '')}/api/v1/worker-link/pair/poll`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceCode }),
      });
      if (res.ok) body = await res.json();
    } catch {
      body = null; // offline, timed out or a non-JSON page while the server restarts: try again
    }
    if (body?.status === 'allowed' && body.token) {
      await saveToken(body.token);
      return body;
    }
    if (body?.status === 'denied' || body?.status === 'expired') return body;
    await sleep(2_000);
  }
  return { status: 'expired' };
}
