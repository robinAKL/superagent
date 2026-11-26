import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LangProvider } from '../i18n';
import type { MeView } from '../company';
import { Onboarding } from './Onboarding';

const base: MeView = { identity: { name: 'Ana', email: 'ana@acme.co.nz' }, memberships: [], directoryCompany: null, pendingRequest: null, invites: [], current: null };
const render = (me: MeView) => renderToStaticMarkup(<LangProvider initial="zh"><Onboarding me={me} onChanged={() => undefined} /></LangProvider>);

describe('a person who belongs to no company yet', () => {
  it('creates their company when their organisation has none', () => {
    const html = render(base);
    expect(html).toContain('为你的公司开通 Super Agent');
    expect(html).toContain('创建公司');
    expect(html).toContain('ana@acme.co.nz');
  });

  it('asks to join the company their organisation already registered, and cannot create a second one', () => {
    const html = render({ ...base, directoryCompany: { id: 'c1', name: 'Acme Trading', autoJoin: false } });
    expect(html).toContain('「Acme Trading」已经注册');
    expect(html).toContain('申请加入');
    expect(html).not.toContain('创建公司');
    expect(render({ ...base, directoryCompany: { id: 'c1', name: 'Acme Trading', autoJoin: true } })).toContain('直接加入');
  });

  it('waits for approval once asked', () => {
    const html = render({ ...base, directoryCompany: { id: 'c1', name: 'Acme Trading', autoJoin: false }, pendingRequest: { tenantId: 'c1', name: 'Acme Trading', createdAt: '2026-11-26T00:00:00Z' } });
    expect(html).toContain('已申请加入「Acme Trading」');
    expect(html).not.toContain('申请加入</button>');
  });

  it('accepts an invitation, with the role it gives', () => {
    const html = render({ ...base, invites: [{ id: 'i1', tenantId: 'c2', name: 'Bolt Builders', roles: ['reviewer'] }] });
    expect(html).toContain('接受邀请，加入「Bolt Builders」');
    expect(html).toContain('审核人');
    expect(html).not.toContain('创建公司');
  });
});
