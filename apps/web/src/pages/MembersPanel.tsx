import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useT } from '../i18n';

/**
 * Admin settings → Members: who belongs to this company and what they may do. Colleagues from the company's own
 * Microsoft 365 organisation ask to join and wait here for approval (or join directly when allowed); anyone else,
 * such as an outside accountant, is invited by email address. The server enforces every rule shown here.
 */
type Role = 'owner' | 'admin' | 'employee' | 'reviewer';
interface Member { userId: string; email: string | null; displayName: string; roles: Role[] }
interface Invite { id: string; email: string; roles: Role[]; createdAt: string }
interface JoinRequest { id: string; email: string | null; displayName: string; createdAt: string }
interface Company { id: string; name: string; settings: { autoJoin?: boolean } }

const ROLES: Role[] = ['owner', 'admin', 'employee', 'reviewer'];

const TEXT = {
  en: {
    title: 'Members', lead: 'Who works in {company} and what they may do. Roles decide what each person sees and can approve.',
    autoJoin: 'Colleagues from our Microsoft 365 organisation may join without approval',
    requests: 'Asking to join', approve: 'Approve as', deny: 'Decline', noRequests: 'Nobody is waiting.',
    members: 'People', you: '(you)', remove: 'Remove', confirmRemove: 'Remove {name} from {company}? They can no longer sign in to it.',
    invite: 'Invite by email', email: 'Email address', inviteAs: 'Role', send: 'Invite', invited: 'Invited {email}. They accept it when they sign in with that address.',
    invites: 'Invitations waiting', revoke: 'Withdraw',
    'role.owner': 'Owner', 'role.admin': 'Administrator', 'role.employee': 'Employee', 'role.reviewer': 'Reviewer',
    roleHelp: 'Owner: everything, including billing and removing the company. Administrator: members, digital employees, knowledge and settings. Employee: the command room and their own digital employees. Reviewer: reviews and approvals.',
    failed: 'That did not work: {reason}', retry: 'please try again.', working: 'Working…',
  },
  zh: {
    title: '成员', lead: '谁在「{company}」里工作、能做什么。角色决定每个人能看到什么、能批准什么。',
    autoJoin: '本公司 Microsoft 365 组织里的同事可以直接加入，不需要批准',
    requests: '申请加入', approve: '批准为', deny: '拒绝', noRequests: '没有人在等待。',
    members: '成员', you: '（你）', remove: '移除', confirmRemove: '把 {name} 从「{company}」移除？移除后他将无法再进入。',
    invite: '用邮箱邀请', email: '邮箱地址', inviteAs: '角色', send: '发出邀请', invited: '已邀请 {email}。对方用这个邮箱登录后就能接受。',
    invites: '待接受的邀请', revoke: '撤回',
    'role.owner': '所有者', 'role.admin': '管理员', 'role.employee': '员工', 'role.reviewer': '审核人',
    roleHelp: '所有者：全部权限，包括计费和删除公司。管理员：管理成员、数字员工、知识和设置。员工：使用指挥室和自己的数字员工。审核人：负责审核和审批。',
    failed: '没有成功：{reason}', retry: '请稍后再试。', working: '处理中…',
  },
};
type Key = keyof typeof TEXT.en;

export function MembersPanel() {
  const t = useT<Key>(TEXT);
  const role = (r: Role) => t(`role.${r}` as Key);
  const [company, setCompany] = useState<Company | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [approveAs, setApproveAs] = useState<Record<string, Role>>({});
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('employee');
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [myEmail, setMyEmail] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [c, m, r, i, who] = await Promise.all([
      api<{ company: Company }>('/api/v1/tenancy/company'),
      api<{ members: Member[] }>('/api/v1/tenancy/members'),
      api<{ requests: JoinRequest[] }>('/api/v1/tenancy/join-requests'),
      api<{ invites: Invite[] }>('/api/v1/tenancy/invites'),
      api<{ identity?: { email: string | null } }>('/api/v1/tenancy/me'),
    ]);
    setMyEmail(who.body.identity?.email ?? null);
    if (c.status === 200) setCompany(c.body.company);
    if (m.status === 200) setMembers(m.body.members);
    if (r.status === 200) setRequests(r.body.requests);
    if (i.status === 200) setInvites(i.body.invites);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function call(path: string, method: string, body?: unknown, done?: string) {
    setBusy(true); setNotice(null);
    try {
      const r = await api<{ message?: string }>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (r.status >= 300) { setNotice({ text: t('failed', { reason: r.body.message ?? t('retry') }), error: true }); return false; }
      if (done) setNotice({ text: done });
      await load();
      return true;
    } catch { setNotice({ text: t('failed', { reason: t('retry') }), error: true }); return false; }
    finally { setBusy(false); }
  }

  async function sendInvite(event: FormEvent) {
    event.preventDefault();
    const address = email.trim();
    if (!address) return;
    if (await call('/api/v1/tenancy/invites', 'POST', { email: address, roles: [inviteRole] }, t('invited', { email: address }))) setEmail('');
  }

  const name = company?.name ?? '';
  return <section id="settings-members" className="panel setup-card members-panel" aria-labelledby="members-title">
    <h2 id="members-title" className="h2">{t('title')}</h2>
    <p className="helper">{t('lead', { company: name })}</p>

    <label className="account-check">
      <input type="checkbox" checked={company?.settings.autoJoin === true} disabled={!company || busy}
        onChange={(e) => void call('/api/v1/tenancy/company', 'PUT', { autoJoin: e.target.checked })} />
      <span>{t('autoJoin')}</span>
    </label>

    <h3 className="members-h3">{t('requests')}</h3>
    {requests.length ? <ul className="members-list">{requests.map((request) => <li key={request.id}>
      <span className="members-who"><strong>{request.displayName}</strong><span className="helper">{request.email}</span></span>
      <span className="members-actions">
        <label className="sr-only" htmlFor={`approve-${request.id}`}>{t('approve')}</label>
        <select id={`approve-${request.id}`} value={approveAs[request.id] ?? 'employee'} onChange={(e) => setApproveAs({ ...approveAs, [request.id]: e.target.value as Role })}>
          {ROLES.map((r) => <option key={r} value={r}>{role(r)}</option>)}
        </select>
        <button type="button" className="btn primary" disabled={busy} onClick={() => void call(`/api/v1/tenancy/join-requests/${request.id}/approve`, 'POST', { roles: [approveAs[request.id] ?? 'employee'] })}>{t('approve')} {role(approveAs[request.id] ?? 'employee')}</button>
        <button type="button" className="btn quiet" disabled={busy} onClick={() => void call(`/api/v1/tenancy/join-requests/${request.id}/deny`, 'POST', {})}>{t('deny')}</button>
      </span>
    </li>)}</ul> : <p className="helper">{t('noRequests')}</p>}

    <h3 className="members-h3">{t('members')}</h3>
    <ul className="members-list">{members.map((member) => <li key={member.userId}>
      <span className="members-who"><strong>{member.displayName}{myEmail && member.email === myEmail ? ` ${t('you')}` : ''}</strong><span className="helper">{member.email}</span></span>
      <span className="members-actions">
        <label className="sr-only" htmlFor={`role-${member.userId}`}>{t('inviteAs')}</label>
        <select id={`role-${member.userId}`} value={member.roles[0] ?? 'employee'} disabled={busy}
          onChange={(e) => void call(`/api/v1/tenancy/members/${encodeURIComponent(member.userId)}`, 'PUT', { roles: [e.target.value] })}>
          {ROLES.map((r) => <option key={r} value={r}>{role(r)}</option>)}
        </select>
        <button type="button" className="btn quiet" disabled={busy} onClick={() => {
          if (window.confirm(t('confirmRemove', { name: member.displayName, company: name }))) void call(`/api/v1/tenancy/members/${encodeURIComponent(member.userId)}`, 'DELETE');
        }}>{t('remove')}</button>
      </span>
    </li>)}</ul>
    <p className="helper">{t('roleHelp')}</p>

    <h3 className="members-h3">{t('invite')}</h3>
    <form className="members-invite" onSubmit={sendInvite}>
      <label className="field"><span>{t('email')}</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" required /></label>
      <label className="field"><span>{t('inviteAs')}</span>
        <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Role)}>{ROLES.map((r) => <option key={r} value={r}>{role(r)}</option>)}</select>
      </label>
      <button type="submit" className="btn primary" disabled={busy || !email.trim()}>{busy ? t('working') : t('send')}</button>
    </form>
    {invites.length ? <>
      <h3 className="members-h3">{t('invites')}</h3>
      <ul className="members-list">{invites.map((invite) => <li key={invite.id}>
        <span className="members-who"><strong>{invite.email}</strong><span className="helper">{invite.roles.map(role).join(' / ')}</span></span>
        <span className="members-actions"><button type="button" className="btn quiet" disabled={busy} onClick={() => void call(`/api/v1/tenancy/invites/${invite.id}`, 'DELETE')}>{t('revoke')}</button></span>
      </li>)}</ul>
    </> : null}
    {notice ? <p className={notice.error ? 'warn' : 'helper'} role={notice.error ? 'alert' : 'status'}>{notice.text}</p> : null}
  </section>;
}
