import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';

/**
 * Mail and calendar accounts. Two owners, never mixed:
 * - Admin settings: the administrator's own account, which controls Super Agent.
 * - A digital employee's drawer: that employee's own mailbox and calendar, used only by that employee.
 * The server enforces ownership; this page only says it plainly.
 */
type SendRule = 'ask' | 'allow' | 'deny';
export interface Account {
  id: string;
  owner: { kind: 'admin' | 'employee'; id: string };
  provider: 'microsoft';
  address: string;
  displayName: string;
  mailTrigger: boolean;
  calendarTrigger: boolean;
  sendRule: SendRule;
  status: 'connected' | 'reauthorize';
  connectedAt: string;
  mail?: { checkedAt: string | null; received: number; error: string | null };
}

const TEXT = {
  en: {
    adminTitle: 'My mailbox', adminLead: 'Your own Microsoft 365 account. It is how you direct Super Agent by mail: mail you file under “Super Agent” becomes an instruction. Digital employees never use it. Scheduled workflows are in the Calendar.',
    employeeTitle: 'Mailbox', employeeLead: '{name}’s own mailbox. Only {name} uses it: new mail can become its tasks, and it sends mail from here. Its scheduled workflows are in the Calendar.',
    connect: 'Connect Microsoft 365', google: 'Google (coming soon)', reconnect: 'Sign in again', disconnect: 'Disconnect',
    adminWho: 'Sign in with your own work account.', employeeWho: 'Sign in with {name}’s own account (for example ops@yourcompany.com), not yours. A shared mailbox cannot sign in; use a licensed mailbox.',
    empty: 'No mailbox connected yet.', notConfigured: 'Microsoft 365 sign-in is not set up on this platform yet. Ask the platform administrator to add the app registration.',
    connected: 'Connected', reauthorize: 'Sign-in expired',
    mailTriggerAdmin: 'Mail in my “Super Agent” folder goes to Super Agent', mailTriggerEmployee: 'New mail becomes a task for {name}',
    sendRule: 'Sending mail', ask: 'Ask me first', allow: 'Send directly', deny: 'Never send',
    triggersNote: 'Replies follow the sending rule: “Ask me first” puts them in My work for you to send.',
    confirmDisconnect: 'Disconnect {address}? Super Agent stops using this account, and its sign-in is deleted.',
    working: 'Working…', error: 'That did not work. Try again.', cancelled: 'Sign-in was cancelled.',
    doneAdmin: 'Connected {address}. It belongs to you and controls Super Agent.', doneEmployee: 'Connected {address} for {name}. Only {name} uses it.',
    openEmployees: 'Back to digital employees',
    mailChecked: 'Checked {time} · {n} handled', mailWaiting: 'The first check runs within a minute.',
  },
  zh: {
    adminTitle: '我的邮箱', adminLead: '你自己的 Microsoft 365 账号，用邮件指挥 Super Agent：放进「Super Agent」文件夹的邮件会成为给它的指令。数字员工不会使用它。定时流程在「日历」里管理。',
    employeeTitle: '邮箱', employeeLead: '{name} 自己的邮箱，只给 {name} 用：新邮件可以变成它的任务，它也从这里发邮件。它的定时流程在「日历」里。',
    connect: '连接 Microsoft 365', google: 'Google（即将支持）', reconnect: '重新登录', disconnect: '断开',
    adminWho: '用你自己的工作账号登录。', employeeWho: '用 {name} 自己的账号登录（例如 ops@你的公司.com），不要用你自己的。共享邮箱不能登录，请用有许可证的邮箱。',
    empty: '还没有连接邮箱。', notConfigured: '平台还没有配置 Microsoft 365 登录。请联系平台管理员添加应用注册。',
    connected: '已连接', reauthorize: '登录已失效',
    mailTriggerAdmin: '「Super Agent」文件夹里的邮件交给 Super Agent', mailTriggerEmployee: '新邮件自动变成 {name} 的任务',
    sendRule: '发邮件', ask: '先问我', allow: '直接发', deny: '不允许',
    triggersNote: '回复按「发邮件」的设置处理：选「先问我」时，回复会放进「待我处理」，由你确认后发出。',
    confirmDisconnect: '断开 {address}？Super Agent 将不再使用这个账号，它的登录授权会被删除。',
    working: '处理中…', error: '没有成功，请重试。', cancelled: '登录已取消。',
    doneAdmin: '已连接 {address}。它属于你，用来指挥 Super Agent。', doneEmployee: '已为 {name} 连接 {address}。只有 {name} 会使用它。',
    openEmployees: '回到数字员工',
    mailChecked: '{time} 检查过 · 已处理 {n} 封', mailWaiting: '一分钟内开始第一次检查。',
  },
};

const RETURN_KEY = 'superagent.account-return';

/** Starts a Microsoft sign-in for this owner and leaves for Microsoft. */
async function startSignIn(employee?: { id: string; name: string }): Promise<boolean> {
  const r = await api<{ authorizationUrl?: string }>('/api/v1/accounts/connect', { method: 'POST', body: JSON.stringify(employee ? { employeeId: employee.id } : {}) });
  if (r.status !== 200 || !r.body.authorizationUrl) return false;
  try { sessionStorage.setItem(RETURN_KEY, JSON.stringify(employee ?? null)); } catch { /* the notice just names no employee */ }
  window.location.assign(r.body.authorizationUrl);
  return true;
}

export function AccountConnections({ employee }: { employee?: { id: string; name: string } }) {
  const t = useT(TEXT);
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [configured, setConfigured] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean; employees?: boolean } | null>(null);
  const name = employee?.name ?? '';
  const listUrl = employee ? `/api/v1/accounts/employees/${encodeURIComponent(employee.id)}` : '/api/v1/accounts/mine';

  const load = useCallback(async () => {
    const [config, list] = await Promise.all([
      api<{ microsoft?: boolean }>('/api/v1/accounts/config'),
      api<{ accounts?: Account[] }>(listUrl),
    ]);
    setConfigured(config.status === 200 && config.body.microsoft === true);
    setAccounts(list.status === 200 && Array.isArray(list.body.accounts) ? list.body.accounts : []);
  }, [listUrl]);

  // Coming back from Microsoft (admin settings only): finish the sign-in this browser started.
  useEffect(() => {
    if (employee) return;
    const query = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
    const state = query.get('acct_state'), code = query.get('acct_code'), failed = query.get('acct_error');
    if (!state && !failed) return;
    history.replaceState(null, '', '#settings?section=accounts');
    requestAnimationFrame(() => document.getElementById('settings-accounts')?.scrollIntoView({ block: 'start' }));
    const started = ((): { id: string; name: string } | null => {
      try { const value = JSON.parse(sessionStorage.getItem(RETURN_KEY) ?? 'null') as { id: string; name: string } | null; sessionStorage.removeItem(RETURN_KEY); return value; } catch { return null; }
    })();
    if (failed || !code) { setMessage({ text: t('cancelled'), error: true }); return; }
    setBusy('finish');
    void api<{ account?: Account; message?: string }>('/api/v1/accounts/finish', { method: 'POST', body: JSON.stringify({ state, code }) })
      .then((r) => {
        if (r.status !== 200 || !r.body.account) { setMessage({ text: r.body.message ?? t('error'), error: true }); return; }
        const account = r.body.account;
        setMessage(account.owner.kind === 'employee'
          ? { text: t('doneEmployee', { address: account.address, name: started?.name ?? '' }), employees: true }
          : { text: t('doneAdmin', { address: account.address }) });
        void load();
      })
      .catch(() => setMessage({ text: t('error'), error: true }))
      .finally(() => setBusy(null));
    // Runs once, on the page Microsoft returned to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { void load().catch(() => setAccounts([])); }, [load]);

  async function connect() {
    setBusy('connect'); setMessage(null);
    const ok = await startSignIn(employee).catch(() => false);
    if (!ok) { setBusy(null); setMessage({ text: t('error'), error: true }); }
  }

  async function change(account: Account, patch: Partial<Pick<Account, 'mailTrigger' | 'calendarTrigger' | 'sendRule'>>) {
    setBusy(account.id); setMessage(null);
    const r = await api<{ account?: Account }>(`/api/v1/accounts/${account.id}`, { method: 'PATCH', body: JSON.stringify(patch) }).catch(() => null);
    setBusy(null);
    if (!r || r.status !== 200 || !r.body.account) { setMessage({ text: t('error'), error: true }); return; }
    const saved = r.body.account;
    setAccounts((list) => list?.map((item) => item.id === saved.id ? saved : item) ?? null);
  }

  async function disconnect(account: Account) {
    if (!window.confirm(t('confirmDisconnect', { address: account.address }))) return;
    setBusy(account.id); setMessage(null);
    const r = await api(`/api/v1/accounts/${account.id}`, { method: 'DELETE' }).catch(() => null);
    setBusy(null);
    if (!r || r.status !== 200) { setMessage({ text: t('error'), error: true }); return; }
    setAccounts((list) => list?.filter((item) => item.id !== account.id) ?? null);
  }

  const forAdmin = !employee;
  return <div className="accounts" data-accounts={forAdmin ? 'admin' : 'employee'}>
    <p className="helper">{forAdmin ? t('adminLead') : t('employeeLead', { name })}</p>
    {message ? <p className={message.error ? 'warn' : 'accounts-done'} role={message.error ? 'alert' : 'status'}>
      {message.text}{message.employees ? <> <a href="#employees">{t('openEmployees')}</a></> : null}</p> : null}
    {accounts === null ? <p className="helper">…</p> : accounts.length === 0 ? <p className="helper">{t('empty')}</p> :
      <ul className="account-list">{accounts.map((account) => (
        <li key={account.id} className="account-card" data-status={account.status}>
          <div className="account-head">
            <span className="account-provider" aria-hidden="true">M365</span>
            <span className="account-who"><strong>{account.address}</strong>{account.displayName && account.displayName !== account.address ? <small>{account.displayName}</small> : null}</span>
            <span className={`tag ${account.status === 'connected' ? 'is-good' : 'is-warn'}`}>{t(account.status)}</span>
          </div>
          <label className="account-check"><input type="checkbox" checked={account.mailTrigger} disabled={busy !== null}
            onChange={(event) => void change(account, { mailTrigger: event.target.checked })} />
            <span>{forAdmin ? t('mailTriggerAdmin') : t('mailTriggerEmployee', { name })}</span></label>
          {account.mailTrigger ? (account.mail?.error
            ? <p className="warn account-mail">{account.mail.error}</p>
            : <p className="helper account-mail">{account.mail?.checkedAt
              ? t('mailChecked', { time: new Date(account.mail.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), n: account.mail.received })
              : t('mailWaiting')}</p>) : null}
          <div className="account-send">
            <span>{t('sendRule')}</span>
            <span className="chip-row" role="group" aria-label={t('sendRule')}>
              {(['ask', 'allow', 'deny'] as const).map((rule) => (
                <button key={rule} type="button" className="chip chip-small" aria-pressed={account.sendRule === rule} disabled={busy !== null}
                  onClick={() => void change(account, { sendRule: rule })}>{t(rule)}</button>
              ))}
            </span>
          </div>
          <div className="account-actions">
            {account.status === 'reauthorize' ? <button type="button" className="btn primary" disabled={busy !== null || !configured} onClick={() => void connect()}>{t('reconnect')}</button> : null}
            <button type="button" className="btn quiet" disabled={busy !== null} onClick={() => void disconnect(account)}>{t('disconnect')}</button>
          </div>
        </li>
      ))}</ul>}
    {accounts && accounts.length > 0 ? <p className="helper">{t('triggersNote')}</p> : null}
    {configured ? <p className="helper">{forAdmin ? t('adminWho') : t('employeeWho', { name })}</p> : <p className="warn">{t('notConfigured')}</p>}
    <div className="account-connect">
      <button type="button" className="btn primary" disabled={busy !== null || !configured} onClick={() => void connect()}>{busy === 'connect' ? t('working') : t('connect')}</button>
      <button type="button" className="btn quiet" disabled>{t('google')}</button>
    </div>
  </div>;
}

/** The admin settings card: the administrator's own account. */
export function MyAccountsPanel() {
  const t = useT(TEXT);
  return <section className="panel setup-card" aria-labelledby="setup-accounts">
    <header className="setup-card-head"><h2 id="setup-accounts" className="h2">{t('adminTitle')}</h2></header>
    <AccountConnections />
  </section>;
}

/** The digital employee drawer heading for its own accounts. */
export function employeeAccountsTitle(lang: 'en' | 'zh') { return TEXT[lang].employeeTitle; }
