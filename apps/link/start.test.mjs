import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ensurePaired, openBrowser, pollUntilRevoked } from './start.mjs';

describe('Link start', () => {
  it('opens the connect page on first run and stores the token', async () => {
    const opened = [];
    const token = await ensurePaired('http://sa.test', {
      loadToken: async () => null,
      detect: async () => ['codex'],
      openBrowser: (url) => opened.push(url),
      sleep: async () => undefined,
      fetchImpl: async (url, init) => {
        if (String(url).endsWith('/pair/start')) {
          return { ok: true, json: async () => ({ deviceCode: 'dev', userCode: 'ABCD-EFGH' }) };
        }
        if (String(url).endsWith('/pair/poll')) {
          return { ok: true, json: async () => ({ status: 'allowed', token: 'saw_from_pair' }) };
        }
        throw new Error(String(url) + JSON.stringify(init));
      },
    });
    assert.equal(token, 'saw_from_pair');
    assert.equal(opened[0], 'http://sa.test/#connect?code=ABCD-EFGH');
  });

  it('clears the token when the server revokes the worker', async () => {
    let cleared = 0;
    const result = await pollUntilRevoked(
      'http://sa.test',
      'saw_old',
      async () => ({ status: 401 }),
      async () => undefined,
      async () => { cleared += 1; },
    );
    assert.equal(result.rePair, true);
    assert.equal(cleared, 1);
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
