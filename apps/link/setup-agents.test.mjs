import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { installAgent, setupChoices } from './setup-agents.mjs';

describe('setupChoices', () => {
  it('asks to install a client that is not on the computer', () => {
    const choices = setupChoices([]);
    assert.deepEqual(choices.map(choice => [choice.agent, choice.action, choice.state]), [
      ['claude-code', 'install', 'missing'],
      ['codex', 'install', 'missing'],
      ['cursor', 'install', 'missing'],
      ['copilot', 'install', 'missing'],
      ['gemini', 'install', 'missing'],
      ['qwen', 'install', 'missing'],
    ]);
    assert.ok(choices.every(choice => choice.label && choice.loginHint), 'every client has a name and a sign-in hint');
  });

  it('asks to sign in when the client is installed and skips one that is already signed in', () => {
    const choices = setupChoices([
      { agent: 'codex', executable: 'C:/Codex/codex.exe', signedIn: false },
      { agent: 'claude-code', executable: 'C:/Claude/claude.exe', signedIn: true },
    ]);
    const codex = choices.find(choice => choice.agent === 'codex');
    const claude = choices.find(choice => choice.agent === 'claude-code');
    assert.equal(codex.action, 'login');
    assert.equal(codex.executable, 'C:/Codex/codex.exe');
    assert.deepEqual(codex.loginArgs, ['login']);
    assert.equal(claude.action, 'use');
    assert.equal(claude.state, 'ready');
  });
});

describe('installAgent', () => {
  it('runs the official installer and returns the client it installed', async () => {
    const calls = [];
    const result = await installAgent('codex', {
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:/Users/robin/AppData/Local' },
      run: async (command, args, options) => {
        calls.push({ command, args, nonInteractive: options.env.CODEX_NON_INTERACTIVE });
        return { stdout: '', stderr: '' };
      },
      discover: async () => [{ agent: 'codex', executable: 'C:/Codex/codex.exe', signedIn: false }],
    });
    assert.equal(calls[0].command, 'powershell.exe');
    assert.equal(calls[0].nonInteractive, '1');
    assert.match(calls[0].args[calls[0].args.length - 1], /chatgpt\.com\/codex\/install\.ps1/);
    assert.equal(result.ok, true);
    assert.equal(result.executable, 'C:/Codex/codex.exe');
    assert.equal(result.signedIn, false);
    assert.deepEqual(result.loginArgs, ['login']);
  });

  it('reports an installer failure without throwing', async () => {
    const result = await installAgent('claude-code', {
      platform: 'win32',
      run: async () => {
        const error = new Error('installer failed');
        error.stderr = 'network down';
        throw error;
      },
      discover: async () => [],
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /network down/);
  });
});

describe('installAgent for the npm clients', () => {
  for (const [agent, pkg] of [['gemini', '@google/gemini-cli'], ['copilot', '@github/copilot'], ['qwen', '@qwen-code/qwen-code']]) {
    it(`installs ${agent} with npm, getting Node.js from winget first when npm is missing`, async () => {
      let script;
      const result = await installAgent(agent, {
        platform: 'win32',
        env: {},
        run: async (_command, args) => { script = args[args.length - 1]; return { stdout: '', stderr: '' }; },
        discover: async () => [{ agent, executable: `C:/npm/node_modules/${pkg}/cli.js`, signedIn: false }],
      });
      assert.ok(script.includes(`install -g ${pkg}`));
      assert.ok(script.includes('OpenJS.NodeJS.LTS'));
      assert.ok(!script.includes('\n'), 'one line for -Command');
      assert.equal(result.ok, true);
      assert.equal(result.signedIn, false);
    });
  }

  it('installs Cursor CLI with its official PowerShell installer', async () => {
    let script;
    await installAgent('cursor', {
      platform: 'win32', env: {},
      run: async (_command, args) => { script = args[args.length - 1]; return {}; },
      discover: async () => [],
    });
    assert.match(script, /cursor\.com\/install\?win32=true/);
  });
});
