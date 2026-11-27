#!/usr/bin/env node
/**
 * The background browser Link gives every employee's client (Claude Code, Codex) as the MCP server
 * `superagent_browser`.
 *
 * Driving the person's own screen fails whenever that screen is not there: the computer is locked, the remote
 * desktop is minimised or disconnected ("Access is denied"). This browser never touches the screen. It is the
 * computer's own Chrome or Edge, started headless with a profile that belongs to Link, and driven over the
 * DevTools protocol on loopback. Logins made in it stay in that profile for the next task.
 *
 * No dependencies: Node's own fetch and WebSocket speak to the browser; MCP is newline-delimited JSON-RPC on stdio.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const TEXT_LIMIT = 20_000;
const LOAD_TIMEOUT_MS = 30_000;
const START_TIMEOUT_MS = 45_000;

/** Chrome first (what people use), then Edge (on every Windows 10/11), then common Linux and macOS installs. */
export function findBrowser(env = process.env, exists = existsSync) {
  const programFiles = env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const candidates = [
    env.SUPERAGENT_BROWSER,
    join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  return candidates.find((path) => path && exists(path)) ?? null;
}

/** Only web pages: no file:, javascript:, chrome: or data: URLs. */
export function webUrl(value) {
  try {
    const url = new URL(String(value ?? '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** A screenshot name that stays inside the output folder. */
export function screenshotPath(folder, name) {
  const base = basename(String(name || `screenshot-${Date.now()}.png`)).replace(/[^\w.\-\u4e00-\u9fff]/gu, '_');
  return resolve(folder, base.toLowerCase().endsWith('.png') ? base : `${base}.png`);
}

/** The page as text a model can read: title, address, visible text and the first links. */
const READ_PAGE = `(() => {
  const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n');
  const links = [...document.querySelectorAll('a[href]')].slice(0, 60)
    .map((a) => ({ text: (a.innerText || a.getAttribute('aria-label') || '').trim().slice(0, 80), href: a.href }))
    .filter((link) => link.text);
  const fields = [...document.querySelectorAll('input, textarea, select')].slice(0, 40).map((el) => ({
    tag: el.tagName.toLowerCase(), type: el.type || '', name: el.name || '', id: el.id || '',
    placeholder: el.placeholder || '', label: (el.labels && el.labels[0] ? el.labels[0].innerText : '').trim().slice(0, 60),
  }));
  return JSON.stringify({ title: document.title, url: location.href, text: text.slice(0, ${TEXT_LIMIT}), links, fields });
})()`;

const FIND = `(target) => {
  if (target.selector) return document.querySelector(target.selector);
  const want = String(target.text || '').trim().toLowerCase();
  const items = [...document.querySelectorAll('a, button, input[type=submit], input[type=button], [role=button], label, summary')];
  return items.find((el) => (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().toLowerCase() === want)
    || items.find((el) => (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().toLowerCase().includes(want));
}`;

const CLICK = `((target) => {
  const el = (${FIND})(target);
  if (!el) return 'not_found';
  el.scrollIntoView({ block: 'center' });
  el.click();
  return 'clicked';
})`;

const TYPE = `((target) => {
  const el = (${FIND})(target);
  if (!el) return 'not_found';
  el.focus();
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, target.value); else el.value = target.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  if (target.submit) {
    if (el.form && el.form.requestSubmit) el.form.requestSubmit();
    else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }
  return 'typed';
})`;

export const TOOLS = [
  {
    name: 'browser_open',
    description: 'Open a web page in the employees\' browser on this computer and return its title, address, text, links and form fields. Use this for every web page task: it needs no screen control, so it works even when the screen is locked or the remote desktop is minimised. Never try to control the desktop or the person\'s own browser window.',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'An http or https address.' } }, required: ['url'] },
  },
  {
    name: 'browser_read',
    description: 'Read the page currently open in the background browser: title, address, text, links and form fields.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_click',
    description: 'Click a link or button in the background browser, found by a CSS selector or by its visible text. Returns the page after the click.',
    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' } } },
  },
  {
    name: 'browser_type',
    description: 'Type into a form field in the background browser, found by a CSS selector (for example input[name=q]). Set submit to send the form. Returns the page afterwards.',
    inputSchema: { type: 'object', properties: { selector: { type: 'string' }, value: { type: 'string' }, submit: { type: 'boolean' } }, required: ['selector', 'value'] },
  },
  {
    name: 'browser_screenshot',
    description: 'Save a PNG screenshot of the page in the background browser into the project folder and return its path.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'File name, for example result.png.' } } },
  },
];

/** One headless browser for this MCP session, started on first use. */
export class BackgroundBrowser {
  #executable;
  #profile;
  #visible;
  #launch;
  #child = null;
  #socket = null;
  #next = 1;
  #pending = new Map();
  #waiters = [];

  /** `visible`: a window the person at the computer can watch; otherwise headless. Driven the same way either way. */
  constructor({ executable = findBrowser(), profile, visible = false, launch = spawn } = {}) {
    this.#executable = executable;
    this.#profile = profile;
    this.#visible = visible;
    this.#launch = launch;
  }

  async #start() {
    if (this.#socket) return;
    if (!this.#executable) throw new Error('No Chrome or Edge was found on this computer for the background browser.');
    mkdirSync(this.#profile, { recursive: true });
    // The person may have the employees' browser open to sign in: both cannot use one profile at once.
    if (profileInUse(this.#profile)) {
      throw new Error('The employees\' browser is open for signing in on this computer. Close that window, then try again.');
    }
    const portFile = join(this.#profile, 'DevToolsActivePort');
    rmSync(portFile, { force: true });
    this.#child = this.#launch(this.#executable, [
      ...(this.#visible ? [] : ['--headless=new']), `--user-data-dir=${this.#profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1366,900', 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    // What the browser says on the way up, kept to explain a start that fails.
    let said = '';
    this.#child.stderr?.on('data', (chunk) => { said = (said + String(chunk)).slice(-2_000); });
    this.#child.once('exit', () => { this.#child = null; this.#socket = null; });
    const why = () => (said.trim() ? ` ${said.trim().split('\n').slice(-3).join(' ')}` : '');
    let port = 0;
    // A first start on a slow or busy computer can take a while; the port file may also exist before it is written.
    for (const deadline = Date.now() + START_TIMEOUT_MS; !port && Date.now() < deadline;) {
      if (!this.#child) throw new Error('The background browser stopped while starting.' + why());
      try { port = Number(readFileSync(portFile, 'utf8').split('\n')[0]) || 0; } catch { port = 0; }
      if (!port) await delay(100);
    }
    if (!port) throw new Error('The background browser did not start in time.' + why());
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((target) => target.type === 'page');
    if (!page) throw new Error('The background browser has no page to use.');
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((ok, fail) => { socket.onopen = ok; socket.onerror = () => fail(new Error('Could not connect to the background browser.')); });
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && this.#pending.has(message.id)) {
        const { ok, fail } = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (message.error) fail(new Error(message.error.message)); else ok(message.result);
      } else if (message.method) {
        this.#waiters = this.#waiters.filter((waiter) => !(waiter.method === message.method && (waiter.ok(message.params), true)));
      }
    };
    this.#socket = socket;
    await this.#send('Page.enable');
  }

  #send(method, params = {}) {
    const id = this.#next++;
    return new Promise((ok, fail) => {
      this.#pending.set(id, { ok, fail });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  #event(method, timeoutMs) {
    return new Promise((ok) => {
      const waiter = { method, ok };
      this.#waiters.push(waiter);
      setTimeout(() => { this.#waiters = this.#waiters.filter((item) => item !== waiter); ok(null); }, timeoutMs).unref?.();
    });
  }

  async #evaluate(expression) {
    const { result, exceptionDetails } = await this.#send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'The page script failed.');
    return result.value;
  }

  /** Waits for a navigation the last action may have started, then for the page to settle. */
  async #settle() {
    await this.#event('Page.loadEventFired', 1_500);
    for (let waited = 0; waited < LOAD_TIMEOUT_MS; waited += 200) {
      if (await this.#evaluate('document.readyState').catch(() => null) === 'complete') return;
      await delay(200);
    }
  }

  async read() {
    await this.#start();
    return JSON.parse(await this.#evaluate(READ_PAGE));
  }

  async open(url) {
    const address = webUrl(url);
    if (!address) throw new Error('Give an http or https address.');
    await this.#start();
    const loaded = this.#event('Page.loadEventFired', LOAD_TIMEOUT_MS);
    const { errorText } = await this.#send('Page.navigate', { url: address });
    if (errorText) throw new Error(`The page could not be opened: ${errorText}`);
    await loaded;
    await this.#settle();
    return this.read();
  }

  async #act(script, target) {
    await this.#start();
    const outcome = await this.#evaluate(`${script}(${JSON.stringify(target)})`);
    if (outcome === 'not_found') throw new Error('Nothing on the page matched. Read the page and use a selector or visible text that is there.');
    await this.#settle();
    return this.read();
  }

  click({ selector, text } = {}) {
    if (!selector && !text) throw new Error('Give a selector or the visible text to click.');
    return this.#act(CLICK, { selector, text });
  }

  type({ selector, value, submit = false } = {}) {
    if (!selector) throw new Error('Give the selector of the field to type into.');
    return this.#act(TYPE, { selector, value: String(value ?? ''), submit: Boolean(submit) });
  }

  async screenshot(folder, name) {
    await this.#start();
    const { data } = await this.#send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const path = screenshotPath(folder, name);
    writeFileSync(path, Buffer.from(data, 'base64'));
    return path;
  }

  close() {
    try { this.#socket?.close(); } catch { /* closing */ }
    this.#child?.kill();
    this.#child = null;
    this.#socket = null;
  }
}

/** Where the employees' browser keeps its logins on this computer (Link and the tray use the same folder). */
export function browserProfile(env = process.env) {
  return env.SUPERAGENT_BROWSER_PROFILE || join(env.LOCALAPPDATA || tmpdir(), 'SuperAgentLink', 'browser-profile');
}

/** Chrome holds this file open while it runs with the profile: a running task's background browser, for one. */
export function profileInUse(profile) {
  const lock = join(profile, 'lockfile');
  if (!existsSync(lock)) return false;
  try { rmSync(lock); return false; } catch { return true; }
}

/** The first page shown when the person opens the employees' browser to sign in. */
export const SIGN_IN_PAGE = 'https://accounts.google.com/';

/**
 * Opens the employees' browser as an ordinary, visible window, so the person signs in to the websites the employees
 * need. Nothing is automated in it; the logins it keeps are what the background browser uses afterwards.
 * Returns 'opened', 'busy' (a task is using the browser now) or 'missing' (no Chrome or Edge here).
 */
export function openForSignIn({ executable = findBrowser(), profile = browserProfile(), url = SIGN_IN_PAGE, launch = spawn, inUse = profileInUse } = {}) {
  if (!executable) return 'missing';
  mkdirSync(profile, { recursive: true });
  if (inUse(profile)) return 'busy';
  const child = launch(executable, [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--new-window', webUrl(url) ?? SIGN_IN_PAGE], {
    detached: true, stdio: 'ignore',
  });
  child.unref?.();
  return 'opened';
}

/** Answers one MCP request; `browser` does the work. */
export async function handle(message, browser, output) {
  const { id, method, params } = message;
  if (method === 'initialize') {
    return { id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'superagent-browser', version: '1.0.0' } } };
  }
  if (method === 'ping') return { id, result: {} };
  if (method === 'tools/list') return { id, result: { tools: TOOLS } };
  if (method === 'tools/call') {
    const args = params?.arguments ?? {};
    try {
      let value;
      if (params?.name === 'browser_open') value = await browser.open(args.url);
      else if (params?.name === 'browser_read') value = await browser.read();
      else if (params?.name === 'browser_click') value = await browser.click(args);
      else if (params?.name === 'browser_type') value = await browser.type(args);
      else if (params?.name === 'browser_screenshot') value = { saved: await browser.screenshot(output, args.name) };
      else return { id, error: { code: -32602, message: 'Unknown tool' } };
      return { id, result: { content: [{ type: 'text', text: JSON.stringify(value) }] } };
    } catch (error) {
      return { id, result: { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] } };
    }
  }
  if (id !== undefined) return { id, error: { code: -32601, message: 'Method not found' } };
  return null;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--sign-in') {
  // The tray's "Employee browser" item: open it visibly, say how it went, and leave.
  const result = openForSignIn({ url: process.argv[3] || SIGN_IN_PAGE });
  console.log('LINK_BROWSER_SIGN_IN:' + result);
  process.exitCode = result === 'opened' ? 0 : result === 'busy' ? 3 : 4;
} else if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const profile = browserProfile();
  const output = process.env.SUPERAGENT_BROWSER_OUT || process.cwd();
  const browser = new BackgroundBrowser({ profile, visible: process.env.SUPERAGENT_BROWSER_VISIBLE === '1' });
  const reader = createInterface({ input: process.stdin });
  reader.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (!message || typeof message !== 'object') return;
    void handle(message, browser, output).then((reply) => {
      if (reply) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...reply }) + '\n');
    });
  });
  reader.on('close', () => browser.close());
  process.on('exit', () => browser.close());
}
