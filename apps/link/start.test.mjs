import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { completeOneTask, ensurePaired, openBrowser, stayAlive } from './start.mjs';

describe('Link start', () => {
  it('opens the connect page on first run and stores the token', async () => {
    const opened = [];
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

  it('reports one claimed task then stops', async () => {
    const urls = [];
    const result = await completeOneTask('http://sa.test', 'saw_tok', async (url, init) => {
      urls.push(String(url));
      if (String(url).endsWith('/poll')) {
        return { status: 200, ok: true, json: async () => ({ task: { id: 'task-1', attempt: 2 } }) };
      }
      if (String(url).includes('/tasks/task-1/succeed')) {
        assert.equal(JSON.parse(init.body).attempt, 2);
        return { status: 200, ok: true, json: async () => ({ ok: true }) };
      }
      throw new Error(String(url));
    });
    assert.equal(result.status, 'reported');
    assert.equal(result.taskId, 'task-1');
    assert.equal(urls.filter((u) => u.endsWith('/poll')).length, 1);
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
