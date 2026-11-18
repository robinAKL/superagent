import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectAgents } from './detect-agents.mjs';

describe('detectAgents', () => {
  it('reports logged-in Codex and Claude Code CLIs and ignores missing bins', async () => {
    const run = async (bin) => {
      if (bin === 'codex') return { stdout: 'Logged in as robin', stderr: '' };
      throw new Error('not found');
    };
    assert.deepEqual(await detectAgents(run), ['codex']);
  });

  it('skips a CLI that is installed but not logged in', async () => {
    const run = async () => ({ stdout: 'Not logged in', stderr: '' });
    assert.deepEqual(await detectAgents(run), []);
  });
});
