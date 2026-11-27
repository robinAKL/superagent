/**
 * SuperAgent Link entry: pair if needed and run room assignments for locally configured projects.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadToken, clearToken } from './pair-store.mjs';
import { connectUrl, pollUntilToken, startPairing } from './pair-flow.mjs';
import { WorkerLink } from './link.mjs';

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
  const result = await pollUntilToken(origin, started.deviceCode, opts.fetchImpl, opts.sleep, started.expiresAt, opts.now);
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
        body: JSON.stringify({ capabilities: { projects: [] } }),
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

async function main() {
  const dataDir = process.env.SUPERAGENT_LINK_DATA_DIR;
  const defaultConfig = dataDir && join(dataDir, 'link-runtime.json');
  const configFile = process.argv[2] ?? (defaultConfig && existsSync(defaultConfig) ? defaultConfig : undefined);
  const config = configFile ? JSON.parse(readFileSync(configFile, 'utf8')) : undefined;
  const origin = process.env.SUPERAGENT_ORIGIN || config?.endpoint;
  if (!origin) {
    throw new Error('Set SUPERAGENT_ORIGIN or configure an HTTPS endpoint in the project file.');
  }
  const endpoint = new URL(origin);
  if ((endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(endpoint.hostname)))
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('Configure a trusted HTTPS endpoint.');
  }
  const configuredToken = process.env.SUPERAGENT_WORKER_TOKEN;
  const token = configuredToken || await ensurePaired(endpoint.origin);
  const onStatus = (status) => console.log(`LINK_STATE:${status}`);
  let revoked = false;
  if (!config) {
    revoked = (await stayAlive(endpoint.origin, token, undefined, undefined, () => {}, onStatus)).rePair;
  } else {
    const shutdown = new AbortController();
    process.once('SIGINT', () => shutdown.abort());
    process.once('SIGTERM', () => shutdown.abort());
    try {
      const stateDirectory = dataDir ?? dirname(resolve(configFile));
      await new WorkerLink({
        ...config, endpoint: endpoint.origin, stateFile: config.stateFile ?? join(stateDirectory, 'worker-state.json'),
      }, token, {
        onStatus,
        onTask: (active) => console.log(active ? 'LINK_TASK:start' : 'LINK_TASK:end'),
        // The desktop tray reacts by opening that CLI's sign-in for the person at the computer.
        onAuth: (agent) => console.log(`LINK_AUTH:${agent}`),
        // The tray opens Claude Code's MCP sign-in for this server, for the person at the computer to finish.
        onMcpLogin: (server) => console.log(`LINK_MCP_LOGIN:${server}`),
        // The tray opens its local clients window at that step (install, sign in, connect a folder).
        onClientSetup: (agent, action) => console.log(`LINK_CLIENT_SETUP:${agent}:${action}`),
        onBrowserSignIn: (result) => console.log(`LINK_BROWSER_SIGN_IN:${result}`),
      }).start(shutdown.signal);
    } catch (error) {
      if (error.status !== 401) throw error;
      revoked = true;
    }
  }
  if (revoked) {
    if (!configuredToken) await clearToken();
    console.error('This computer was revoked. Run Link again to pair.');
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
