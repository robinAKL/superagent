import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    assert.match(cs, /setup-agents\.mjs/);
    // One window for every local client: install and sign in, sign in, or connect a project folder; also opened
    // from the web page (LINK_CLIENT_SETUP) and once after the computer first connects.
    assert.match(cs, /Local clients \/ 本地客户端/);
    assert.match(cs, /"安装并登录"/);
    assert.match(cs, /"选择项目文件夹"/);
    assert.match(cs, /LINK_CLIENT_SETUP:/);
    assert.match(cs, /MaybeGuideClients\(\)/);
    assert.doesNotMatch(cs, /请先在这台电脑登录 Codex 或 Claude Code，再重试。/);
  });

  it('cleans up Scheduled Task, Run key, install dir, and link.token on uninstall in SuperAgentLink.nsi', () => {
    const nsi = readFileSync(path.join(linkDesktopDir, 'installer', 'SuperAgentLink.nsi'), 'utf8');
    const taskScript = readFileSync(path.join(linkDesktopDir, 'installer', 'Register-LogonTask.ps1'), 'utf8');
    assert.match(nsi, /Register-LogonTask\.ps1/);
    assert.match(taskScript, /Register-ScheduledTask -TaskName SuperAgentLink/);
    assert.match(nsi, /schtasks \/Delete \/TN "SuperAgentLink" \/F/);
    assert.match(nsi.split('Section "Uninstall"')[1], /DeleteRegValue HKCU "\$\{RUN_KEY\}" "SuperAgentLink"/);
    assert.match(nsi, /RMDir "\$INSTDIR"/);
    assert.doesNotMatch(nsi, /RMDir \/r "\$INSTDIR"/);
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
      const versionPath = path.join(dir, 'AssemblyVersion.cs');
      writeFileSync(versionPath, '[assembly: System.Reflection.AssemblyVersion("9.3.7.0")]\n');
      execFileSync(csc, [
        '/nologo',
        '/target:winexe',
        `/out:${exePath}`,
        '/r:System.Windows.Forms.dll',
        '/r:System.Drawing.dll',
        '/r:System.Web.Extensions.dll',
        '/r:System.Security.dll',
        path.join(linkDesktopDir, 'tray', 'LinkTray.cs'),
        versionPath,
      ], { encoding: 'utf8' });

      const out = execFileSync(exePath, ['--self-check'], { encoding: 'utf8' });
      const parsed = JSON.parse(out.trim());
      assert.equal(parsed.ok, true);
      assert.equal(parsed.version, '9.3.7');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('offers an update instead of installing it unasked: a notification and a menu item, the installer only after a click', () => {
    const cs = readFileSync(path.join(linkDesktopDir, 'tray', 'LinkTray.cs'), 'utf8');
    const check = cs.slice(cs.indexOf('private void CheckForUpdatesSafe('), cs.indexOf('private UpdateOffer FetchUpdateOffer('));
    const begin = cs.slice(cs.indexOf('private void BeginUpdate('), cs.indexOf('private static string ParseSha256('));
    assert.ok(check.length > 0 && begin.length > 0, 'update check and click handler exist');
    assert.doesNotMatch(check, /Process\.Start/, 'the periodic check never starts the installer');
    assert.match(check, /_balloonClick = BeginUpdate/);
    assert.match(check, /升级到 v/);
    assert.match(cs, /BalloonTipClicked/);
    assert.match(cs, /Check for updates \/ 检查更新/);
    assert.match(begin, /ParseSha256\(/, 'the download is checked against SHA256SUMS before it runs');
    assert.match(begin, /Arguments = "\/S \/D="/, 'silent install; the installer restarts Link');
    assert.match(begin, /_updateAfterTask = true/, 'a running task is not cut off');
    const nsi = readFileSync(path.join(linkDesktopDir, 'installer', 'SuperAgentLink.nsi'), 'utf8');
    assert.match(nsi, /IfSilent 0 \+2\s+Call LaunchLink/, 'a silent upgrade starts Link again');
  });

  it('offers the three authorisation modes in the tray and switches them through the worker channel', () => {
    const cs = readFileSync(path.join(linkDesktopDir, 'tray', 'LinkTray.cs'), 'utf8');
    assert.match(cs, /Authorisation \/ 授权模式/);
    assert.match(cs, /new\[\] \{ "strict", "standard", "full" \}/);
    assert.match(cs, /"\/permissions\/mode"/, 'one click sets the mode for every employee on this computer');
    assert.match(cs, /ProtectedData\.Unprotect\(/, 'the token Link saved is read with DPAPI, never stored again');
    const build = readFileSync(path.join(linkDesktopDir, 'scripts', 'build-windows.ps1'), 'utf8');
    assert.match(build, /System\.Security\.dll/);
  });
});
