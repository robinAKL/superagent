import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { installAgent, setupChoices } from './setup-agents.mjs';

describe('setupChoices', () => {
  it('asks to install a client that is not on the computer', () => {
    const choices = setupChoices([]);
    assert.deepEqual(choices.map(choice => [choice.agent, choice.action, choice.state]), [
      ['codex', 'install', 'missing'],
      ['claude-code', 'install', 'missing'],
    ]);
  });

  it('asks to sign in when the client is installed and skips one that is already signed in', () => {
    const choices = setupChoices([
      { agent: 'codex', executable: 'C:/Codex/codex.exe', signedIn: false },
      { agent: 'claude-code', executable: 'C:/Claude/claude.exe', signedIn: true },
    ]);
    assert.equal(choices[0].action, 'login');
    assert.equal(choices[0].executable, 'C:/Codex/codex.exe');
    assert.deepEqual(choices[0].loginArgs, ['login']);
    assert.equal(choices[1].action, 'use');
    assert.equal(choices[1].state, 'ready');
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
