import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveToken, loadToken, tokenPath, protect } from './pair-store.mjs';

describe('pair-store', () => {
  it('writes the token into a private user directory', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sa-link-'));
    const env = { ...process.env, XDG_CONFIG_HOME: dir, APPDATA: dir };
    await saveToken('saw_testtoken', { platform: 'linux', env });
    const stored = await readFile(tokenPath(env, 'linux'), 'utf8');
    assert.equal(stored, 'saw_testtoken');
    assert.equal(await loadToken({ platform: 'linux', env }), 'saw_testtoken');
    await rm(dir, { recursive: true, force: true });
  });

  it('uses DPAPI on Windows via ProtectedData', async () => {
    const run = async (_bin, args) => {
      assert.match(args.join(' '), /ProtectedData/);
      return { stdout: 'ZW5j\n' };
    };
    const out = await protect('saw_plain', 'win32', run);
    assert.equal(out.toString('utf8'), 'ZW5j');
  });
});
