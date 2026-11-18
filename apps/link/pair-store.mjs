import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function tokenDir(env = process.env, platform = process.platform) {
  if (platform === 'win32') return path.join(env.APPDATA || path.join(homedir(), 'AppData', 'Roaming'), 'SuperAgent');
  return path.join(env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'superagent');
}

export function tokenPath(env = process.env, platform = process.platform) {
  return path.join(tokenDir(env, platform), 'link.token');
}

export async function protect(plain, platform = process.platform, run = execFileAsync) {
  if (platform !== 'win32') return Buffer.from(plain, 'utf8');
  const script = `
Add-Type -AssemblyName System.Security
$bytes = [System.Text.Encoding]::UTF8.GetBytes($env:SA_PLAIN)
$prot = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($prot)
`;
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-Command', script], { env: { ...process.env, SA_PLAIN: plain } });
  return Buffer.from(stdout.trim(), 'utf8');
}

export async function unprotect(buf, platform = process.platform, run = execFileAsync) {
  const text = buf.toString('utf8');
  if (platform !== 'win32') return text;
  const script = `
Add-Type -AssemblyName System.Security
$prot = [Convert]::FromBase64String($env:SA_PROT)
$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($prot, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[System.Text.Encoding]::UTF8.GetString($bytes)
`;
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-Command', script], { env: { ...process.env, SA_PROT: text } });
  return stdout.replace(/\r?\n$/, '');
}

export async function saveToken(token, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const dir = tokenDir(env, platform);
  await mkdir(dir, { recursive: true });
  const body = await protect(token, platform, opts.run);
  await writeFile(tokenPath(env, platform), body, { mode: 0o600 });
}

export async function loadToken(opts = {}) {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  try {
    const buf = await readFile(tokenPath(env, platform));
    return unprotect(buf, platform, opts.run);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function clearToken(opts = {}) {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  await rm(tokenPath(env, platform), { force: true });
}
