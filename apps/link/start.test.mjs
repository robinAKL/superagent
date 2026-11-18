import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensurePaired, openBrowser, stayAlive } from './start.mjs';

describe('Link start', () => {
  it('opens the connect page on first run and stores the token', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sa-link-start-'));
    const prevApp = process.env.APPDATA;
    const prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.APPDATA = dir;
    process.env.XDG_CONFIG_HOME = dir;
    const opened = [];
    try {
      const token = await ensurePaired('http://sa.test', {
        loadToken: async () => null,
        detect: async () => ['codex'],
        openBrowser: (url) => opened.push(url),
        sleep: async () => undefined,
        fetchImpl: async (url) => {
          if (String(url).endsWith('/pair/start')) {
            return { ok: true, json: async () => ({ deviceCode: 'dev', userCode: 'ABCD-EFGH' }) };
          }
          if (String(url).endsWith('/pair/poll')) {
            return { ok: true, json: async () => ({ status: 'allowed', token: 'saw_from_pair' }) };
          }
          throw new Error(String(url));
        },
      });
      assert.equal(token, 'saw_from_pair');
      assert.equal(opened[0], 'http://sa.test/#connect?code=ABCD-EFGH');
    } finally {
      if (prevApp === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = prevApp;
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('uses heartbeat (not poll) to notice revoke', async () => {
    const urls = [];
    let cleared = 0;
    const result = await stayAlive(
      'http://sa.test',
      'saw_old',
      async (url) => {
        urls.push(String(url));
        return { status: 401, ok: false };
      },
      async () => undefined,
      async () => { cleared += 1; },
    );
    assert.equal(result.rePair, true);
    assert.equal(cleared, 1);
    assert.match(urls[0], /\/api\/v1\/worker-link\/heartbeat$/);
    assert.equal(urls.some((u) => u.includes('/worker-link/poll')), false);
  });

  it('uses start on Windows to open the browser', () => {
    const calls = [];
    openBrowser('http://sa.test/#connect?code=AB', 'win32', (cmd, args) => {
      calls.push([cmd, args]);
      return { unref() {} };
    });
    assert.equal(calls[0][0], 'cmd');
    assert.deepEqual(calls[0][1], ['/c', 'start', '', 'http://sa.test/#connect?code=AB']);
  });
});
