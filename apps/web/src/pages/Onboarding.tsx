import { useState, type FormEvent } from 'react';
import { api, chooseCompany } from '../api';
import { signOut } from '../auth';
import { LangSwitch, useT } from '../i18n';
import type { MeView } from '../company';
import './Onboarding.css';

/**
 * A signed-in person who belongs to no company yet. In order: invitations waiting for them; a join request already
 * sent; the company their organisation already registered (ask to join, or join at once when it allows that); or,
 * when their organisation has none, create it and become its owner. Nothing here asks for a password or a script.
 */
const TEXT = {
  zh: {
    title: '欢迎使用 Super Agent', signedIn: '你已登录为 {who}。', signOut: '换个账号',
    invitesTitle: '有公司邀请你加入', accept: '接受邀请，加入「{name}」', roleNote: '角色：{roles}',
    pendingTitle: '已申请加入「{name}」', pendingLead: '管理员批准后你就能进入。可以提醒公司的管理员到「管理设置 → 成员」里批准。', refresh: '刷新看看',
    joinTitle: '你的组织已经在用 Super Agent', joinLead: '「{name}」已经注册。申请加入后，由管理员批准。', joinAuto: '「{name}」允许同组织的同事直接加入。',
    join: '申请加入', joinNow: '直接加入',
    createTitle: '为你的公司开通 Super Agent', createLead: '你所在的组织还没有开通。创建后你就是这家公司的所有者，可以邀请同事、配置数字员工。',
    name: '公司名称', namePlaceholder: '例如：Acme Trading Ltd', create: '创建公司',
    working: '处理中…', failed: '没有成功：{reason}', retry: '请稍后再试。',
    'role.owner': '所有者', 'role.admin': '管理员', 'role.employee': '员工', 'role.reviewer': '审核人',
  },
  en: {
    title: 'Welcome to Super Agent', signedIn: 'You are signed in as {who}.', signOut: 'Use another account',
    invitesTitle: 'You are invited to a company', accept: 'Accept and join “{name}”', roleNote: 'Role: {roles}',
    pendingTitle: 'You asked to join “{name}”', pendingLead: 'You can come in once an administrator approves. They approve it in Admin settings → Members.', refresh: 'Check again',
    joinTitle: 'Your organisation already uses Super Agent', joinLead: '“{name}” is registered. Ask to join and an administrator approves.', joinAuto: '“{name}” lets colleagues from your organisation join directly.',
    join: 'Ask to join', joinNow: 'Join now',
    createTitle: 'Set up Super Agent for your company', createLead: 'Your organisation is not set up yet. You become the company’s owner: you invite colleagues and set up digital employees.',
    name: 'Company name', namePlaceholder: 'For example: Acme Trading Ltd', create: 'Create company',
    working: 'Working…', failed: 'That did not work: {reason}', retry: 'Please try again shortly.',
    'role.owner': 'Owner', 'role.admin': 'Administrator', 'role.employee': 'Employee', 'role.reviewer': 'Reviewer',
  },
};

type Key = keyof typeof TEXT.en;

export function Onboarding({ me, onChanged }: { me: MeView; onChanged: () => void }) {
  const t = useT<Key>(TEXT);
  const roleText = (roles: string[]) => roles.map((r) => (`role.${r}` in TEXT.en ? t(`role.${r}` as Key) : r)).join(' / ');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');

  async function act(path: string, body?: unknown, company?: string) {
    setBusy(true); setError(null);
    try {
      const r = await api<{ message?: string; company?: { id: string } }>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
      if (r.status >= 300) { setError(t('failed', { reason: r.body.message ?? t('retry') })); return; }
      const joined = company ?? r.body.company?.id;
      if (joined) chooseCompany(joined);
      onChanged();
    } catch { setError(t('failed', { reason: t('retry') })); }
    finally { setBusy(false); }
  }

  function create(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    void act('/api/v1/tenancy/signup', { name: name.trim(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  }

  return <div className="onboarding">
    <header className="topbar">
      <span className="brand">INNOPRO</span><span className="product">Super Agent</span>
      <span className="topbar-end"><LangSwitch label="Language" /></span>
    </header>
    <main className="onboarding-main">
      <h1>{t('title')}</h1>
      <p className="helper">{t('signedIn', { who: me.identity.email ?? me.identity.name })} <button type="button" className="btn quiet" onClick={() => void signOut()}>{t('signOut')}</button></p>

      {me.invites.length ? <section className="panel onboarding-card" aria-labelledby="ob-invites">
        <h2 id="ob-invites" className="h2">{t('invitesTitle')}</h2>
        <ul className="onboarding-list">{me.invites.map((invite) => <li key={invite.id}>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void act(`/api/v1/tenancy/invites/${invite.id}/accept`, {}, invite.tenantId)}>{t('accept', { name: invite.name })}</button>
          <span className="helper">{t('roleNote', { roles: roleText(invite.roles) })}</span>
        </li>)}</ul>
      </section> : null}

      {me.pendingRequest ? <section className="panel onboarding-card" aria-labelledby="ob-pending">
        <h2 id="ob-pending" className="h2">{t('pendingTitle', { name: me.pendingRequest.name })}</h2>
        <p>{t('pendingLead')}</p>
        <button type="button" className="btn" onClick={onChanged}>{t('refresh')}</button>
      </section> : me.directoryCompany ? <section className="panel onboarding-card" aria-labelledby="ob-join">
        <h2 id="ob-join" className="h2">{t('joinTitle')}</h2>
        <p>{me.directoryCompany.autoJoin ? t('joinAuto', { name: me.directoryCompany.name }) : t('joinLead', { name: me.directoryCompany.name })}</p>
        <button type="button" className="btn primary" disabled={busy} onClick={() => void act('/api/v1/tenancy/join', {}, me.directoryCompany!.autoJoin ? me.directoryCompany!.id : undefined)}>
          {busy ? t('working') : me.directoryCompany.autoJoin ? t('joinNow') : t('join')}
        </button>
      </section> : !me.invites.length ? <section className="panel onboarding-card" aria-labelledby="ob-create">
        <h2 id="ob-create" className="h2">{t('createTitle')}</h2>
        <p>{t('createLead')}</p>
        <form className="onboarding-form" onSubmit={create}>
          <label className="field"><span>{t('name')}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('namePlaceholder')} maxLength={120} required autoComplete="organization" />
          </label>
          <button type="submit" className="btn primary" disabled={busy || !name.trim()}>{busy ? t('working') : t('create')}</button>
        </form>
      </section> : null}

      {error ? <p className="warn" role="alert">{error}</p> : null}
    </main>
  </div>;
}
