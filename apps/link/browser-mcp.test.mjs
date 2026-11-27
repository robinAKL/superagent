import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackgroundBrowser, SIGN_IN_PAGE, TOOLS, findBrowser, handle, openForSignIn, runningBrowser, screenshotPath, webUrl } from './browser-mcp.mjs';

describe('background browser: rules', () => {
  it('opens only web pages', () => {
    assert.equal(webUrl('https://www.google.com'), 'https://www.google.com/');
    assert.equal(webUrl(' http://127.0.0.1:8080/a '), 'http://127.0.0.1:8080/a');
    for (const bad of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'chrome://settings', 'data:text/html,x', 'not a url', '']) {
      assert.equal(webUrl(bad), null, bad);
    }
  });

  it('keeps screenshots inside the project folder', () => {
    const folder = join(tmpdir(), 'project');
    assert.equal(screenshotPath(folder, '../../evil.png'), join(folder, 'evil.png'));
    assert.equal(screenshotPath(folder, 'result'), join(folder, 'result.png'));
    assert.ok(screenshotPath(folder, '').startsWith(join(folder, 'screenshot-')));
  });

  it('prefers Chrome, falls back to Edge, and finds nothing on a bare machine', () => {
    const env = { ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86', LOCALAPPDATA: 'C:\\LA' };
    const edge = join('C:\\PF86', 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    const chrome = join('C:\\PF', 'Google', 'Chrome', 'Application', 'chrome.exe');
    assert.equal(findBrowser(env, (path) => path === edge || path === chrome), chrome);
    assert.equal(findBrowser(env, (path) => path === edge), edge);
    assert.equal(findBrowser(env, () => false), null);
  });

  it('lists its tools over MCP and reports a failed call as a tool error, not a crash', async () => {
    const listed = await handle({ id: 1, method: 'tools/list' }, null, tmpdir());
    assert.deepEqual(listed.result.tools.map((tool) => tool.name), TOOLS.map((tool) => tool.name));
    const refused = await handle({ id: 2, method: 'tools/call', params: { name: 'browser_open', arguments: { url: 'file:///etc/passwd' } } },
      new BackgroundBrowser({ executable: null, profile: tmpdir() }), tmpdir());
    assert.equal(refused.result.isError, true);
    assert.match(refused.result.content[0].text, /http or https/);
  });
});

describe('employee browser window', () => {
  it('shows a window when asked, and runs headless otherwise; both are driven the same way', async () => {
    const started = [];
    const launch = (file, args) => { started.push(args); throw new Error('stop here'); };
    const profile = join(tmpdir(), 'superagent-visible-profile');
    for (const visible of [true, false]) {
      await assert.rejects(new BackgroundBrowser({ executable: 'chrome.exe', profile, visible, launch }).read(), /stop here/);
    }
    assert.equal(started[0].includes('--headless=new'), false);
    assert.equal(started[1].includes('--headless=new'), true);
    for (const args of started) assert.ok(args.includes('--remote-debugging-port=0'));
  });
});

describe('employee browser for signing in', () => {
  it('opens the employees\' window (the one later tasks use), and waits while a headless task holds the profile', async () => {
    const launched = [];
    const launch = (file, args) => { launched.push([file, args]); return { unref() {} }; };
    const profile = await mkdtemp(join(tmpdir(), 'superagent-signin-'));
    const none = async () => { throw new Error('nothing running'); };
    assert.equal(await openForSignIn({ executable: 'chrome.exe', profile, launch, inUse: () => false, request: none }), 'opened');
    assert.deepEqual(launched[0], ['chrome.exe', [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
      '--no-first-run', '--no-default-browser-check', '--new-window', SIGN_IN_PAGE]]);
    assert.ok(!launched[0][1].includes('--headless=new'), 'a person signs in to a normal window');
    assert.equal(await openForSignIn({ executable: 'chrome.exe', profile, launch, inUse: () => false, request: none, url: 'javascript:alert(1)' }), 'opened');
    assert.equal(launched[1][1].at(-1), SIGN_IN_PAGE);
    assert.equal(await openForSignIn({ executable: 'chrome.exe', profile, launch, inUse: () => true, request: none }), 'busy');
    assert.equal(await openForSignIn({ executable: null, profile, launch }), 'missing');
    assert.equal(launched.length, 2);

    // The window is already open: the sign-in page opens as a tab in it, nothing new is started.
    writeFileSync(join(profile, 'DevToolsActivePort'), '9333\n/devtools/browser/x');
    const asked = [];
    const running = (headless) => async (url, init) => {
      asked.push([url, init?.method ?? 'GET']);
      return { json: async () => ({ 'User-Agent': headless ? 'Mozilla/5.0 HeadlessChrome/140' : 'Mozilla/5.0 Chrome/140' }) };
    };
    assert.equal(await openForSignIn({ executable: 'chrome.exe', profile, launch, request: running(false) }), 'opened');
    assert.deepEqual(asked.at(-1), [`http://127.0.0.1:9333/json/new?${SIGN_IN_PAGE}`, 'PUT']);
    assert.equal(await openForSignIn({ executable: 'chrome.exe', profile, launch, request: running(true) }), 'busy');
    assert.equal(launched.length, 2);
    await rm(profile, { recursive: true, force: true });
  });
});

describe('the employees\' window stays', () => {
  it('knows a running employees\' browser from a stale port file', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'superagent-running-'));
    assert.equal(await runningBrowser(profile), null);
    writeFileSync(join(profile, 'DevToolsActivePort'), '9444\n/devtools/browser/y');
    assert.equal(await runningBrowser(profile, async () => { throw new Error('refused'); }), null);
    assert.deepEqual(await runningBrowser(profile, async () => ({ json: async () => ({ 'User-Agent': 'Chrome/140' }) })), { port: 9444, headless: false });
    await rm(profile, { recursive: true, force: true });
  });
});

const executable = findBrowser();

describe('background browser: a real headless browser', { skip: executable ? false : 'no Chrome or Edge on this machine' }, () => {
  it('opens a page, types and submits a form, clicks a link and saves a screenshot without any screen', { timeout: 60_000 }, async (t) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      res.setHeader('content-type', 'text/html; charset=utf-8');
      if (url.pathname === '/search') return res.end(`<title>结果</title><p>你搜索了：${url.searchParams.get('q')}</p><a href="/done">下一页</a>`);
      if (url.pathname === '/done') return res.end('<title>完成</title><h1>到了下一页</h1>');
      res.end('<title>询价单</title><h1>欢迎</h1><form action="/search"><input name="q" placeholder="搜索"><button>搜索</button></form>');
    });
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${server.address().port}`;
    const folder = await mkdtemp(join(tmpdir(), 'superagent-browser-'));
    const browser = new BackgroundBrowser({ executable, profile: join(folder, 'profile') });
    t.after(async () => { browser.close(); server.close(); await rm(folder, { recursive: true, force: true }).catch(() => {}); });

    const opened = await browser.open(base + '/');
    assert.equal(opened.title, '询价单');
    assert.match(opened.text, /欢迎/);
    assert.deepEqual(opened.fields.map((field) => field.name), ['q']);

    const searched = await browser.type({ selector: 'input[name=q]', value: '百叶窗', submit: true });
    assert.equal(searched.title, '结果');
    assert.match(searched.text, /你搜索了：百叶窗/);

    const next = await browser.click({ text: '下一页' });
    assert.equal(next.url, base + '/done');
    assert.match(next.text, /到了下一页/);

    const saved = await browser.screenshot(folder, 'page.png');
    assert.equal(saved, join(folder, 'page.png'));
    assert.ok(existsSync(saved));
  });
});
