import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useT, type Dict } from '../i18n';

const TEXT = {
  en: {
    title: 'Connect this computer',
    lead: 'Allow Super Agent Link on this PC to stay connected and pick up work for digital employees.',
    missing: 'Open this page from Link, or paste the pairing code.',
    loading: 'Looking up this pairing code…',
    hostname: 'Computer',
    allow: 'Allow',
    deny: 'Deny',
    allowed: 'This computer is connected. Link will store the token on this device; you can close the tab.',
    next: 'In the Link tray menu, choose Set up local agent. If the command line is missing, Link installs it and opens sign-in, then you bind the project to a digital employee.',
    manageLink: 'Manage Link devices',
    denied: 'Pairing declined. Link will ask to pair again.',
    expired: 'This code expired. Start Link again to get a new one.',
    taken: 'This code was already used.',
    notFound: 'No pairing request matches this code.',
    error: 'Could not complete pairing. Try again.',
    signedOut: 'Your sign-in has expired. Reload this page and sign in again.',
    forbidden: 'This account cannot connect computers to this workspace.',
    retrying: 'The server is busy or restarting. Trying again…',
    memberNext: 'Next, an administrator binds a project on this computer to a digital employee. After that, mention that employee in the Command room to hand it work.',
    code: 'Pairing code',
  },
  zh: {
    title: '连接此电脑',
    lead: '允许本机 Super Agent Link 保持连接，并为数字员工领取任务。',
    missing: '请从 Link 打开此页，或输入配对码。',
    loading: '正在查找配对码…',
    hostname: '电脑',
    allow: '允许',
    deny: '拒绝',
    allowed: '此电脑已连接。Link 会把令牌存在本机，可以关闭此页。',
    next: '在 Link 托盘菜单选择「配置本地 Agent」。如果还没有命令行，Link 会安装并打开登录，然后把项目绑定到数字员工。',
    manageLink: '管理 Link 设备',
    denied: '已拒绝配对。Link 会再次请求配对。',
    expired: '配对码已过期。请重新打开 Link 获取新码。',
    taken: '这个配对码已经用过了。',
    notFound: '找不到这个配对码。',
    error: '配对失败，请重试。',
    signedOut: '登录已过期，请刷新页面重新登录。',
    forbidden: '这个账号不能把电脑连接到此工作区。',
    retrying: '服务器正忙或正在重启，正在重试…',
    memberNext: '接下来由管理员把这台电脑上的项目绑定到数字员工，之后在指挥室 @ 这名员工即可交办任务。',
    code: '配对码',
  },
} satisfies Dict<string>;

interface PairView {
  userCode: string;
  hostname: string;
  status: 'pending' | 'allowed' | 'denied' | 'expired';
  expiresAt: number;
  workerId: string | null;
}

function pairCodeFromHash(): string {
  const query = typeof window === 'undefined' ? '' : window.location.hash.split('?')[1] ?? '';
  return new URLSearchParams(query).get('code') ?? '';
}

/** Lookups retried while the server answers 5xx or the network drops, e.g. during a deployment. */
const LOOKUP_RETRIES = 5;
const RETRY_MS = 3_000;

function failure(status: number): 'signedOut' | 'forbidden' | 'error' {
  return status === 401 ? 'signedOut' : status === 403 ? 'forbidden' : 'error';
}

/** Any signed-in member can connect their own computer. canManage shows the admin's device settings link. */
export function ConnectComputerPage({ canManage = true }: { canManage?: boolean }) {
  const t = useT(TEXT);
  const initial = useMemo(pairCodeFromHash, []);
  const [code, setCode] = useState(initial);
  const [pair, setPair] = useState<PairView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const raw = code.trim();
    if (!raw) { setPair(null); setNotice(t('missing')); return; }
    let stop = false;
    let timer: number | undefined;
    setNotice(t('loading'));
    const lookup = (attempt: number) => {
      const retry = () => {
        if (stop) return;
        if (attempt >= LOOKUP_RETRIES) { setPair(null); setNotice(t('error')); return; }
        setNotice(t('retrying'));
        timer = window.setTimeout(() => lookup(attempt + 1), RETRY_MS);
      };
      void api<PairView>('/api/v1/workers/pair/' + encodeURIComponent(raw)).then((res) => {
        if (stop) return;
        if (res.status === 404) { setPair(null); setNotice(t('notFound')); return; }
        if (res.status >= 500) { retry(); return; }
        if (res.status !== 200) { setPair(null); setNotice(t(failure(res.status))); return; }
        setPair(res.body);
        setNotice(null);
      }).catch(retry);
    };
    lookup(0);
    return () => { stop = true; window.clearTimeout(timer); };
  }, [code, t]);

  async function decide(action: 'allow' | 'deny') {
    if (!pair || busy) return;
    setBusy(true);
    try {
      const res = await api<{ pair?: PairView; status?: string }>(`/api/v1/workers/pair/${encodeURIComponent(pair.userCode)}/${action}`, { method: 'POST', body: '{}' });
      if (res.status === 410) setNotice(t('expired'));
      else if (res.status === 409) setNotice(t('taken'));
      else if (res.status === 404) setNotice(t('notFound'));
      else if (res.status !== 200) setNotice(t(failure(res.status)));
      else {
        const next = (res.body.pair ?? res.body) as PairView;
        setPair({ ...pair, ...next, status: action === 'allow' ? 'allowed' : 'denied' });
        setNotice(action === 'allow' ? t('allowed') : t('denied'));
      }
    } catch { setNotice(t('error')); }
    finally { setBusy(false); }
  }

  return (
    <>
      <div className="page-head">
        <h1>{t('title')}</h1>
        <p>{t('lead')}</p>
      </div>
      <section className="panel setup-card" aria-labelledby="connect-pc">
        <h2 id="connect-pc" className="h2">{t('code')}</h2>
        <label className="field">
          <span>{t('code')}</span>
          <input value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="characters" spellCheck={false} />
        </label>
        {pair ? <p className="helper">{t('hostname')}: {pair.hostname}</p> : null}
        {pair?.status === 'pending' ? (
          <div className="setup-actions">
            <button className="btn primary" type="button" disabled={busy} onClick={() => void decide('allow')}>{t('allow')}</button>
            <button className="btn" type="button" disabled={busy} onClick={() => void decide('deny')}>{t('deny')}</button>
          </div>
        ) : null}
        {notice ? <p className="helper" role="status">{notice}</p> : null}
        {pair?.status === 'allowed' ? <>
          <p className="helper">{t('next')}</p>
          {canManage
            ? <a className="btn primary" href="#settings?link=1">{t('manageLink')}</a>
            : <p className="helper">{t('memberNext')}</p>}
        </> : null}
      </section>
    </>
  );
}
