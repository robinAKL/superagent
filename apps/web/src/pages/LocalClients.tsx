import { useState } from 'react';
import { LINK_AGENT_LABELS, type LinkAgent } from '@superagent/shared';
import { api } from '../api';
import { useT } from '../i18n';
import type { LinkDevice } from './link-devices';

/**
 * The local clients on one computer (Claude Code, Codex, Cursor CLI, GitHub Copilot CLI, Gemini CLI, Qwen Code): where each stands and the one step that comes next. A click
 * opens the step on that computer (the tray's local clients window); installing, signing in and choosing a folder
 * happen there, by the person at the computer. Several clients can be connected at once.
 */
export type ClientState = 'missing' | 'signed-out' | 'ready';
export interface LocalClient { agent: LinkAgent; state: ClientState; connected: boolean }
/** Who runs tasks with a client on this computer: each bound employee and the folder it works in. */
export type ClientUsers = Partial<Record<LinkAgent, { employee: string; folder: string }[]>>;

const TEXT = {
  en: {
    title: 'Local clients', unknown: 'Link has not reported its clients yet (needs Link 0.1.8 or later; update it from the tray).',
    missing: 'Not installed', signedOut: 'Installed, not signed in', ready: 'Signed in, not connected to a project folder', connected: 'Connected',
    inUse: 'In use', idle: 'Connected, not in use',
    usedBy: 'In use by {employee} · folder {folder}',
    idleHint: 'No employee uses this client yet. Bind an employee to one of its folders below and it starts taking tasks.',
    install: 'Install and sign in', login: 'Sign in', connect: 'Choose a project folder', more: 'Add a folder',
    sent: 'Opened on {device}. Follow the window there: click the button, sign in in the browser, then choose a folder. This page updates by itself.',
    failed: 'The computer could not be reached. Check that Link is running on it, then try again.',
    none: 'No client is connected yet: Super Agent cannot run work on this computer until one is.',
    browserTitle: 'Employee browser',
    browserHint: 'Employees open web pages in their own background browser on this computer, not on your screen. To let them use a website that needs an account (Google, a supplier portal), open it here once and sign in; it stays signed in for later tasks.',
    browserOpen: 'Open the employee browser to sign in',
    browserSent: 'Opening on {device}. Sign in to the websites in that window, then close it.',
  },
  zh: {
    title: '本地客户端', unknown: 'Link 还没有上报客户端情况（需要 Link 0.1.8 或更新版本，请在托盘里检查更新）。',
    missing: '未安装', signedOut: '已安装，还没登录', ready: '已登录，还没连接项目文件夹', connected: '已连接',
    inUse: '使用中', idle: '已连接，未使用',
    usedBy: '正在被 {employee} 使用 · 文件夹 {folder}',
    idleHint: '还没有员工用这个客户端。在下面把员工绑到它的文件夹，它才会接任务。',
    install: '安装并登录', login: '登录', connect: '选择项目文件夹', more: '再连接一个文件夹',
    sent: '已在 {device} 上打开。请在那台电脑弹出的窗口里点按钮、在浏览器里登录，最后选一个文件夹。这里会自动更新。',
    failed: '没能联系到那台电脑。请确认那台电脑上的 Link 在运行，再试一次。',
    none: '还没有连接任何客户端：连接之前，Super Agent 没法在这台电脑上干活。',
    browserTitle: '员工浏览器',
    browserHint: '员工打开网页用的是这台电脑上自己的后台浏览器，不占你的屏幕。员工要用到需要账号的网站（比如谷歌、供应商后台）时，在这里打开一次登录好，之后的任务都保持登录。',
    browserOpen: '打开员工浏览器（登录网站）',
    browserSent: '正在 {device} 上打开。在那个窗口里登录员工要用的网站，登录完关掉窗口即可。',
  },
};

export const CLIENT_LABEL: Record<LocalClient['agent'], string> = LINK_AGENT_LABELS;

/** The step a client needs next. */
export function nextStep(client: LocalClient): 'install' | 'login' | 'connect' | 'more' {
  return client.state === 'missing' ? 'install' : client.state === 'signed-out' ? 'login' : client.connected ? 'more' : 'connect';
}

export function LocalClients({ device, users = {}, onChanged }: { device: LinkDevice; users?: ClientUsers; onChanged: () => void }) {
  const t = useT(TEXT);
  const clients = device.capabilities.clients;
  const [state, setState] = useState<{ agent: string; result: 'sent' | 'failed' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [browser, setBrowser] = useState<'sent' | 'failed' | null>(null);

  async function openBrowser() {
    setBusy(true);
    const r = await api(`/api/v1/workers/${device.id}/browser-sign-in`, { method: 'POST', body: '{}' }).catch(() => null);
    setBusy(false);
    setBrowser(r && r.status === 200 ? 'sent' : 'failed');
  }

  async function open(client: LocalClient) {
    setBusy(true);
    const step = nextStep(client);
    const r = await api(`/api/v1/workers/${device.id}/client-setup`, {
      method: 'POST', body: JSON.stringify({ agent: client.agent, action: step === 'more' ? 'connect' : step }),
    }).catch(() => null);
    setBusy(false);
    setState({ agent: client.agent, result: r && r.status === 200 ? 'sent' : 'failed' });
    onChanged();
  }

  return <section className="local-clients" aria-label={t('title')}>
    <h4>{t('title')}</h4>
    {!clients ? <p className="helper">{t('unknown')}</p> : <>
      {clients.every((client) => !client.connected) ? <p className="warn">{t('none')}</p> : null}
      <ul>{clients.map((client) => {
        const step = nextStep(client);
        const using = client.connected ? users[client.agent] ?? [] : [];
        return <li key={client.agent} className="local-client" data-agent={client.agent} data-state={client.connected ? (using.length ? 'in-use' : 'connected') : client.state}>
          <span className="local-client-name">{CLIENT_LABEL[client.agent]}</span>
          <span className={`tag ${client.connected ? (using.length ? 'is-good' : 'is-accent') : client.state === 'ready' ? 'is-accent' : 'is-warn'}`}>
            {client.connected ? t(using.length ? 'inUse' : 'idle') : client.state === 'missing' ? t('missing') : client.state === 'signed-out' ? t('signedOut') : t('ready')}
          </span>
          <button type="button" className={`btn ${step === 'more' ? 'quiet' : 'primary'}`} disabled={busy || device.status === 'offline' || device.status === 'revoked'} onClick={() => void open(client)}>
            {t(step)}
          </button>
          {using.map((use) => <p key={use.employee + use.folder} className="local-client-use">{t('usedBy', use)}</p>)}
          {client.connected && !using.length ? <p className="helper">{t('idleHint')}</p> : null}
          {state?.agent === client.agent ? <p className={state.result === 'sent' ? 'helper' : 'warn'} role="status">{state.result === 'sent' ? t('sent', { device: device.name }) : t('failed')}</p> : null}
        </li>;
      })}</ul>
    </>}
    {/* The employees' own background browser: where the person signs in to websites the employees use. */}
    <div className="local-browser" data-browser="">
      <span className="local-client-name">{t('browserTitle')}</span>
      <button type="button" className="btn quiet" disabled={busy || device.status === 'offline' || device.status === 'revoked'} onClick={() => void openBrowser()}>
        {t('browserOpen')}
      </button>
      <p className="helper">{t('browserHint')}</p>
      {browser ? <p className={browser === 'sent' ? 'helper' : 'warn'} role="status">{browser === 'sent' ? t('browserSent', { device: device.name }) : t('failed')}</p> : null}
    </div>
  </section>;
}
