import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENTS, approvalArgs, commandLine, headlessArgs, npmShimTarget } from './agents.mjs';
import { discoverWindowsAgents } from './detect-agents.mjs';
import { launchAgent } from './agent.mjs';
import { AUTH_ERROR } from './agent-errors.mjs';

describe('agents', () => {
  it('lists the mainstream local clients in the order people see them', () => {
    assert.deepEqual(AGENTS, ['claude-code', 'codex', 'cursor', 'copilot', 'gemini', 'qwen']);
  });

  it('maps the employee authorisation mode to each client approval setting', () => {
    assert.deepEqual(approvalArgs('gemini', 'strict'), ['--approval-mode', 'default']);
    assert.deepEqual(approvalArgs('gemini', 'standard'), ['--approval-mode', 'auto_edit']);
    assert.deepEqual(approvalArgs('qwen', 'standard'), ['--approval-mode', 'auto-edit']);
    assert.deepEqual(approvalArgs('qwen', 'full'), ['--approval-mode', 'yolo']);
    assert.deepEqual(approvalArgs('cursor', 'standard'), []);
    assert.deepEqual(approvalArgs('cursor', 'full'), ['--force']);
    assert.deepEqual(approvalArgs('copilot', 'strict'), []);
    assert.deepEqual(approvalArgs('copilot', 'full'), ['--allow-all-tools']);
    assert.deepEqual(approvalArgs('gemini', 'anything'), ['--approval-mode', 'auto_edit']);
    assert.deepEqual(approvalArgs('codex', 'strict'), ['--sandbox', 'read-only']);
    assert.deepEqual(approvalArgs('codex', 'standard'), ['--sandbox', 'workspace-write']);
    assert.deepEqual(approvalArgs('codex', 'full'), ['--dangerously-bypass-approvals-and-sandbox']);
  });

  it('builds headless command lines and drops a session id that is not safe to pass', () => {
    assert.deepEqual(headlessArgs('cursor', { session: 'chat-1' }), ['--print', '--output-format', 'stream-json', '--trust', '--resume', 'chat-1']);
    assert.deepEqual(headlessArgs('gemini', { session: 'a b' }), ['--output-format', 'stream-json', '--approval-mode', 'auto_edit']);
    assert.deepEqual(headlessArgs('copilot', { prompt: 'hello', mode: 'strict' }), ['-p', 'hello', '-s', '--no-ask-user']);
    assert.equal(headlessArgs('claude-code'), null);
  });

  it('runs .cmd launchers through cmd.exe with checked arguments only', () => {
    const line = commandLine('C:/Cursor/agent.cmd', ['--print', '--resume', 'abc']);
    assert.match(line.command, /cmd\.exe$/i);
    assert.equal(line.verbatim, true);
    assert.equal(line.argv.at(-1), '""C:/Cursor/agent.cmd" --print --resume abc"');
    assert.throws(() => commandLine('C:/Cursor/agent.cmd', ['-p', 'a & del *']));
    assert.deepEqual(commandLine('C:/npm/cli.js', ['x']).argv.slice(1), ['x']);
  });

  it('reads the JavaScript entry point from an npm shim', () => {
    const shim = '@IF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n)\r\n"%_prog%"  "%dp0%\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js" %*\r\n';
    assert.equal(npmShimTarget(shim), 'node_modules\\@google\\gemini-cli\\bundle\\gemini.js');
    assert.equal(npmShimTarget('@echo off\r\n"%~dp0\\versions\\1.0\\cursor-agent.exe" %*'), null);
  });

  it('recognises the new clients sign-in failures', () => {
    for (const text of [
      'Please set an Auth method in your settings.json or specify GEMINI_API_KEY',
      "Authentication required. Please run 'agent login' first",
      'Error: No authentication information found. Run copilot login.',
    ]) assert.match(text, AUTH_ERROR);
  });
});

describe('discoverWindowsAgents', () => {
  it('finds npm-installed clients through their shims and reads sign-in from their credential files', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'link-agents-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const npm = join(root, 'AppData', 'Roaming', 'npm');
    const home = join(root, 'home');
    await mkdir(join(npm, 'node_modules', '@google', 'gemini-cli', 'bundle'), { recursive: true });
    await writeFile(join(npm, 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js'), '');
    await writeFile(join(npm, 'gemini.cmd'), '"%_prog%"  "%dp0%\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js" %*\r\n');
    await mkdir(join(npm, 'node_modules', '@qwen-code', 'qwen-code'), { recursive: true });
    await writeFile(join(npm, 'node_modules', '@qwen-code', 'qwen-code', 'cli.js'), '');
    await writeFile(join(npm, 'qwen.cmd'), '"%_prog%"  "%dp0%\\node_modules\\@qwen-code\\qwen-code\\cli.js" %*\r\n');
    await mkdir(join(home, '.gemini'), { recursive: true });
    await writeFile(join(home, '.gemini', 'oauth_creds.json'), '{}');
    const env = { APPDATA: join(root, 'AppData', 'Roaming'), USERPROFILE: home, PATH: '' };
    const found = await discoverWindowsAgents(env);
    const gemini = found.find((item) => item.agent === 'gemini');
    const qwen = found.find((item) => item.agent === 'qwen');
    assert.equal(gemini.executable, join(npm, 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js'));
    assert.equal(gemini.signedIn, true);
    assert.equal(qwen.signedIn, false);
    assert.equal(found.some((item) => item.agent === 'copilot'), false);
  });
});

/** A stand-in client: prints fixed output lines and echoes what it was given, then exits with `code`. */
async function fakeClient(t, body) {
  const dir = await mkdtemp(join(tmpdir(), 'link-fake-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'fake.mjs');
  await writeFile(file, `let input = ''; process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => { const args = process.argv.slice(2); ${body} });`);
  return { directory: dir, executable: file };
}

describe('launchAgent with the new clients', () => {
  it('Cursor CLI: prompt on stdin, session from system/init, answer from result', async (t) => {
    const client = await fakeClient(t, `
      if (input !== 'Do it') process.exit(3);
      console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cur-1' }));
      console.log(JSON.stringify({ type: 'tool_call', subtype: 'started' }));
      console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done: ' + args.join(' ') }));`);
    const events = [];
    const run = launchAgent({ ...client, agent: 'cursor' }, 'Do it', null, (event) => events.push(event), null, { mode: 'full' });
    const outcome = await run.completed;
    assert.equal(outcome.result, 'Done: --print --output-format stream-json --trust --force');
    assert.ok(events.some((event) => event.session === 'cur-1'));
  });

  it('Gemini CLI: assistant deltas make the answer when the result carries none', async (t) => {
    const client = await fakeClient(t, `
      console.log(JSON.stringify({ type: 'init', session_id: 'gem-1', model: 'gemini' }));
      console.log(JSON.stringify({ type: 'message', role: 'user', content: input }));
      console.log(JSON.stringify({ type: 'message', role: 'assistant', content: 'Hello ', delta: true }));
      console.log(JSON.stringify({ type: 'message', role: 'assistant', content: args.join(' '), delta: true }));
      console.log(JSON.stringify({ type: 'result', status: 'success', stats: {} }));`);
    const events = [];
    const outcome = await launchAgent({ ...client, agent: 'gemini' }, 'Hi', 'gem-0', (event) => events.push(event), null, { mode: 'strict' }).completed;
    assert.equal(outcome.result, 'Hello --output-format stream-json --approval-mode default --resume gem-0');
    assert.ok(events.some((event) => event.session === 'gem-1'));
  });

  it('Qwen Code: session from system/session_start', async (t) => {
    const client = await fakeClient(t, `
      console.log(JSON.stringify({ type: 'system', subtype: 'session_start', session_id: 'qw-1' }));
      console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } }));
      console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Qwen ' + input }));`);
    const events = [];
    const outcome = await launchAgent({ ...client, agent: 'qwen' }, 'task', null, (event) => events.push(event), null, {}).completed;
    assert.equal(outcome.result, 'Qwen task');
    assert.ok(events.some((event) => event.session === 'qw-1'));
  });

  it('GitHub Copilot CLI: prompt in -p, plain text answer', async (t) => {
    const client = await fakeClient(t, `
      if (input !== '') process.exit(4);
      console.log('Answer to: ' + args[1]);
      console.log(args.slice(2).join(' '));`);
    const outcome = await launchAgent({ ...client, agent: 'copilot' }, 'Fix it', null, () => {}, null, { mode: 'standard' }).completed;
    assert.equal(outcome.result, 'Answer to: Fix it\n-s --no-ask-user --allow-tool=write');
  });

  it('reports a signed-out client as needing sign-in', async (t) => {
    const client = await fakeClient(t, `
      process.stderr.write('Please set an Auth method in your settings.json\\n');
      process.exit(41);`);
    const outcome = await launchAgent({ ...client, agent: 'gemini' }, 'Hi', null, () => {}, null, {}).completed;
    assert.deepEqual(outcome, { authentication: 'gemini requires sign-in.' });
  });
});
