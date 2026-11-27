import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { currentSession, desktopNotice, desktopState } from './desktop.mjs';

const QWINSTA = ` SESSIONNAME       USERNAME                 ID  STATE   TYPE        DEVICE
 services                                    0  Disc
 console                                     1  Conn
                   robin.e                   2  Disc
>rdp-tcp#0         pc-hp-01                  3  Active
 rdp-tcp                                 65536  Listen
`;

/** A fake `qwinsta` / `tasklist` pair: `locked` says whether LogonUI.exe runs in session 3. */
const windows = (qwinsta, locked) => async (file, args) => {
  if (/qwinsta/i.test(file)) return qwinsta;
  assert.deepEqual(args, ['/FI', 'IMAGENAME eq LogonUI.exe', '/FI', 'SESSION eq 3', '/NH']);
  return locked ? 'LogonUI.exe                  1234 RDP-Tcp#0                  3     21,000 K' : 'INFO: No tasks are running which match the specified criteria.';
};

describe('desktop', () => {
  it('finds the session Link runs in', () => {
    assert.deepEqual(currentSession(QWINSTA), { id: 3, state: 'Active' });
    assert.equal(currentSession('no marker here'), null);
  });

  it('tells an usable screen from a locked or disconnected one', async () => {
    assert.equal(await desktopState('win32', windows(QWINSTA, false)), 'available');
    assert.equal(await desktopState('win32', windows(QWINSTA, true)), 'locked');
    assert.equal(await desktopState('win32', windows(QWINSTA.replace('3  Active', '3  Disc'), false)), 'disconnected');
  });

  it('does not stand in the way when it cannot tell', async () => {
    assert.equal(await desktopState('linux', windows(QWINSTA, true)), 'unknown');
    assert.equal(await desktopState('win32', async () => { throw new Error('qwinsta missing'); }), 'unknown');
    assert.equal(desktopNotice('unknown'), null);
    assert.equal(desktopNotice('available'), null);
  });

  it('says why in plain words, and tells the client to report it rather than try', () => {
    const notice = desktopNotice('locked');
    assert.match(notice.progress, /屏幕现在不可用（已锁屏）/);
    assert.match(notice.hint, /不要尝试/);
    assert.match(notice.hint, /没有做成：这台电脑的屏幕不可用（已锁屏）/);
    assert.match(desktopNotice('disconnected').progress, /远程桌面已断开/);
  });
});
