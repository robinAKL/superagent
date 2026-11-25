import { useEffect, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { useLinkDevices, type LinkDevice } from './link-devices';

/**
 * An MCP server on an employee's computer that needs signing in again. One click asks that computer to open the
 * sign-in; the person finishes it there (their account and password stay theirs). The steps are spelled out, no
 * command line, and the note turns to "已连上" by itself when the computer reports the server back.
 */
const TEXT = {
  en: {
    needs: '{server} on {device} needs signing in again. Tasks that use it cannot run until then.',
    open: 'Open the sign-in on that computer', opening: 'Opening…', again: 'Open it again',
    stepsTitle: 'On {device}:',
    step1: 'A Claude Code window opens with a list of connections.',
    step2: 'Use the ↑ ↓ keys to select {server}, then press Enter.',
    step3: 'Choose “Authenticate” and press Enter. Your browser opens.',
    step4: 'Sign in in the browser and allow access. You can close the window afterwards.',
    fallback: 'If the window shows no list, type /mcp in it and press Enter.',
    waiting: 'Waiting for {server} to come back… this updates by itself.',
    back: '{server} on {device} is connected again.',
    failed: 'The computer could not be reached. Check that Link is running on it, then try again.',
  },
  zh: {
    needs: '{device} 上的 {server} 需要重新登录。登录前，用到它的任务都做不了。',
    open: '在电脑上打开登录', opening: '正在打开…', again: '再打开一次',
    stepsTitle: '在 {device} 上：',
    step1: '会弹出一个 Claude Code 窗口，里面列出各个连接。',
    step2: '用键盘的 ↑ ↓ 键选中 {server}，按回车。',
    step3: '选「Authenticate」再按回车，浏览器会自动打开。',
    step4: '在浏览器里登录并点同意。完成后可以关掉那个窗口。',
    fallback: '如果窗口里没有出现列表，在窗口里输入 /mcp 再按回车。',
    waiting: '等待 {server} 重新连上……这里会自动更新。',
    back: '{device} 上的 {server} 已重新连上。',
    failed: '没能联系到那台电脑。请确认那台电脑上的 Link 在运行，再试一次。',
  },
};

export interface McpNeed { deviceId: string; device: string; server: string }

/** MCP servers needing sign-in on the computers bound to these employees (all bound computers when none given). */
export function mcpNeeds(devices: readonly LinkDevice[], employees?: ReadonlySet<string>): McpNeed[] {
  return devices.flatMap((device) => {
    const bound = (device.capabilities.roomAssignments ?? []).some((binding) => !employees || employees.has(binding.employeeId));
    if (!bound) return [];
    return (device.capabilities.mcpServers ?? []).filter((server) => server.status === 'needs_auth')
      .map((server) => ({ deviceId: device.id, device: device.name, server: server.name }));
  });
}

export function McpSignIn({ employees }: { employees?: ReadonlySet<string> }) {
  const t = useT(TEXT);
  const { devices, load } = useLinkDevices();
  const [opened, setOpened] = useState<Record<string, 'opening' | 'open' | 'failed'>>({});
  const [back, setBack] = useState<McpNeed[]>([]);
  const needs = mcpNeeds(devices ?? [], employees);
  const key = (need: McpNeed) => `${need.deviceId}:${need.server}`;

  // A sign-in opened here that the computer now reports as connected: say so, once.
  useEffect(() => {
    const done = Object.keys(opened).filter((k) => opened[k] === 'open' && !needs.some((need) => key(need) === k));
    if (!done.length || !devices) return;
    setBack((list) => [...list, ...done.map((k) => {
      const [deviceId, server] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
      return { deviceId, server: server ?? '', device: devices.find((device) => device.id === deviceId)?.name ?? '' };
    })]);
    setOpened((all) => Object.fromEntries(Object.entries(all).filter(([k]) => !done.includes(k))));
  }, [needs.length, devices]); // eslint-disable-line react-hooks/exhaustive-deps

  async function open(need: McpNeed) {
    setOpened((all) => ({ ...all, [key(need)]: 'opening' }));
    const r = await api(`/api/v1/workers/${need.deviceId}/mcp-login`, { method: 'POST', body: JSON.stringify({ server: need.server }) }).catch(() => null);
    setOpened((all) => ({ ...all, [key(need)]: r && r.status === 200 ? 'open' : 'failed' }));
    void load();
  }

  if (!needs.length && !back.length) return null;
  return <div className="mcp-signin" role="region" aria-label="MCP">
    {back.map((item) => <p key={'back' + key(item)} className="mcp-signin-back" role="status">✓ {t('back', { server: item.server, device: item.device })}</p>)}
    {needs.map((need) => {
      const state = opened[key(need)];
      return <div key={key(need)} className="mcp-signin-item" data-state={state ?? 'idle'}>
        <div className="mcp-signin-head">
          <span>{t('needs', { server: need.server, device: need.device })}</span>
          <button type="button" className={`btn ${state ? '' : 'primary'}`} disabled={state === 'opening'} onClick={() => void open(need)}>
            {state === 'opening' ? t('opening') : state ? t('again') : t('open')}
          </button>
        </div>
        {state === 'failed' ? <p className="warn">{t('failed')}</p> : null}
        {state === 'open' ? <div className="mcp-signin-steps">
          <strong>{t('stepsTitle', { device: need.device })}</strong>
          <ol>
            <li>{t('step1')}</li>
            <li>{t('step2', { server: need.server })}</li>
            <li>{t('step3')}</li>
            <li>{t('step4')}</li>
          </ol>
          <p className="helper">{t('fallback')}</p>
          <p className="helper" role="status">{t('waiting', { server: need.server })}</p>
        </div> : null}
      </div>;
    })}
  </div>;
}
