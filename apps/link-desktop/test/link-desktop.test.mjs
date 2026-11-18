import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const linkDesktopDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(linkDesktopDir, '..', '..');

describe('link-desktop Windows installer & tray', () => {
  it('contains all required installer, tray, build, and workflow files', () => {
    const required = [
      path.join(linkDesktopDir, 'tray', 'LinkTray.cs'),
      path.join(linkDesktopDir, 'installer', 'SuperAgentLink.nsi'),
      path.join(linkDesktopDir, 'scripts', 'build-windows.ps1'),
      path.join(repoRoot, '.github', 'workflows', 'link-release.yml'),
    ];
    for (const file of required) {
      assert.equal(existsSync(file), true, `Missing required file: ${file}`);
    }
  });

  it('aligns LinkTray.cs with apps/link token path, SUPERAGENT_ORIGIN, sleep inhibition, and 4 tray states', () => {
    const cs = readFileSync(path.join(linkDesktopDir, 'tray', 'LinkTray.cs'), 'utf8');
    assert.match(cs, /SUPERAGENT_ORIGIN/);
    assert.match(cs, /"SuperAgent",\s*"link\.token"/);
    assert.match(cs, /SetThreadExecutionState/);
    assert.match(cs, /PowerModeChanged/);
    assert.match(cs, /LinkStatus\.Connected/);
    assert.match(cs, /LinkStatus\.Reconnecting/);
    assert.match(cs, /LinkStatus\.Unpaired/);
    assert.match(cs, /LinkStatus\.Revoked/);
    assert.match(cs, /SHA256SUMS/);
  });

  it('cleans up Scheduled Task, Run key, install dir, and link.token on uninstall in SuperAgentLink.nsi', () => {
    const nsi = readFileSync(path.join(linkDesktopDir, 'installer', 'SuperAgentLink.nsi'), 'utf8');
    assert.match(nsi, /Register-ScheduledTask -TaskName ''SuperAgentLink''/);
    assert.match(nsi, /schtasks \/Delete \/TN "SuperAgentLink" \/F/);
    assert.match(nsi, /DeleteRegValue HKCU "\$\{RUN_KEY\}" "SuperAgentLink"/);
    assert.match(nsi, /RMDir \/r "\$INSTDIR"/);
    assert.match(nsi, /RMDir \/r "\$LOCALAPPDATA\\SuperAgentLink"/);
    assert.match(nsi, /Delete "\$APPDATA\\SuperAgent\\link\.token"/);
  });

  it('compiles LinkTray.cs with .NET 4 csc.exe and passes --self-check on Windows', (t) => {
    const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
    if (process.platform !== 'win32' || !existsSync(csc)) {
      t.skip('Windows .NET 4 csc.exe not available on this host');
      return;
    }
    const dir = mkdtempSync(path.join(tmpdir(), 'sa-link-tray-'));
    try {
      const exePath = path.join(dir, 'SuperAgentLink.exe');
      execFileSync(csc, [
        '/nologo',
        '/target:winexe',
        `/out:${exePath}`,
        '/r:System.Windows.Forms.dll',
        '/r:System.Drawing.dll',
        path.join(linkDesktopDir, 'tray', 'LinkTray.cs'),
      ], { encoding: 'utf8' });

      const out = execFileSync(exePath, ['--self-check'], { encoding: 'utf8' });
      const parsed = JSON.parse(out.trim());
      assert.equal(parsed.ok, true);
      assert.equal(parsed.version, '0.1.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
