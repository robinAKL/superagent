/**
 * Whether this computer's screen can be used right now, from the Windows session Link runs in.
 *
 * A client that drives windows (clicks, switches to Chrome, reads the screen) fails with "Access is denied" when the
 * session is locked or its remote desktop is disconnected. Link checks before a task so the employee is told up front
 * and the room hears why, instead of the client trying and failing. (A minimised remote desktop cannot be seen from
 * here; web work goes through the background browser, which needs no screen at all.)
 */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** `qwinsta` lines → the session this process is in ("> " marks it): its id and state. */
export function currentSession(text) {
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    if (!line.startsWith('>')) continue;
    const match = /\s(\d+)\s+([A-Za-z]+)/u.exec(line);
    if (match) return { id: Number(match[1]), state: match[2] };
  }
  return null;
}

/**
 * 'available', 'locked', 'disconnected', or 'unknown' (not Windows, or the check could not run: the task goes ahead
 * as before). `exec(file, args)` resolves to stdout; injected in tests.
 */
export async function desktopState(platform = process.platform, exec = async (file, args) => (await run(file, args, { windowsHide: true, timeout: 5_000 })).stdout) {
  if (platform !== 'win32') return 'unknown';
  const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  try {
    const session = currentSession(await exec(join(system32, 'qwinsta.exe'), []));
    if (!session) return 'unknown';
    if (/^disc/i.test(session.state)) return 'disconnected';
    const lock = await exec(join(system32, 'tasklist.exe'), ['/FI', 'IMAGENAME eq LogonUI.exe', '/FI', `SESSION eq ${session.id}`, '/NH']);
    return /LogonUI\.exe/i.test(lock) ? 'locked' : 'available';
  } catch {
    return 'unknown';
  }
}

const WHY = { locked: '已锁屏', disconnected: '远程桌面已断开' };

/** What the room hears, and what the client is told before the task, when the screen cannot be used. */
export function desktopNotice(state) {
  const why = WHY[state];
  if (!why) return null;
  return {
    progress: `这台电脑的屏幕现在不可用（${why}），需要操作屏幕上窗口的事这次做不了；网页会用后台浏览器处理。`,
    hint: `（SuperAgent Link：这台电脑的屏幕现在不可用（${why}），不能操作屏幕上的窗口或程序界面，不要尝试。网页请用后台浏览器。`
      + `如果这件事必须用到屏幕，请直接回报：“没有做成：这台电脑的屏幕不可用（${why}）”。）`,
  };
}
