import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { PLAN_TEXT, planErrorKey, TeamPlanPreview, TeamSizePlanner, type TeamPlanView } from './TeamSizePlanner';

const ROOT = '/api/v1/knowledge';

interface Role { id: string; name: string; duty?: string; tools: string[]; sops: string[] }
interface Named { id?: string; key: string; name: string }
interface Organization {
  employees: Role[];
  tools: Named[];
  sops: Named[];
  confirmation: { confirmedAt: string; revision: number; employees: number; tools: number } | null;
  changedSinceConfirmation: boolean;
  missing: number;
  blocked: 'analysis_running' | 'analysis_stale' | 'no_employees' | null;
  canConfirm: boolean;
  teamPlan?: TeamPlanView | null;
}

const TEXT = {
  en: {
    title: 'Digital roles and workload',
    hint: 'Choose how many digital employees Super Agent should plan, then confirm. Generated roles are not connected until you bind an agent.',
    adjust: 'Adjust before publish',
    checklist: 'Confirm before enabling',
    checkContext: 'Company context (name and goal) is already saved.',
    checkRoles: 'Role count matches the work we need.',
    checkBind: 'Unconnected roles will not appear online; I will bind or defer them after publish.',
    publish: 'Confirm and publish configuration, generate digital employees',
    publishing: 'Publishing…',
    published: 'Organization confirmed. {e} new employees, {t} tool placeholders.',
    blocked: 'Cannot publish until the organization draft is ready.',
    goEmployees: 'Open digital employees',
    noAccess: 'Only an owner or administrator can publish the organization.',
    error_generic: 'The request did not complete. Try again.',
  },
  zh: {
    title: '数字岗位与工作量',
    hint: '先按人数让超级智能体规划岗位，再确认发布。生成的岗位未绑定 agent，不会显示为在线。',
    adjust: '发布前可调整',
    checklist: '启用前请确认这三项',
    checkContext: '已保存企业上下文（名称和目标）。',
    checkRoles: '岗位人数与当前工作量匹配。',
    checkBind: '未连接的岗位不会显示在线；发布后我会人工绑定或明确暂不启用。',
    publish: '确认并发布配置，生成数字员工',
    publishing: '正在发布…',
    published: '组织已确认。新建 {e} 名员工、{t} 个工具占位。',
    blocked: '组织草案还不能发布。',
    goEmployees: '打开数字员工页',
    noAccess: '只有企业负责人或管理员可以发布组织。',
    error_generic: '请求未完成，请重试。',
  },
};

export function orgPublishReady(org: Organization | null, loaded: boolean): boolean {
  return loaded && !!org && org.canConfirm && !org.blocked;
}

class RequestError extends Error { constructor(public code: string) { super(code); } }

async function call<R>(path: string, init?: RequestInit): Promise<R> {
  const { status, body } = await api<R & { error?: string }>(`${ROOT}${path}`, init);
  if (status >= 400) throw new RequestError((body as { error?: string }).error ?? 'generic');
  return body;
}

export function OrganizationPublish({ embedded, confirmRef, onGate }: {
  embedded?: boolean;
  confirmRef?: { current: (() => Promise<boolean>) | null };
  onGate?: (gate: { loaded: boolean; ready: boolean; busy: boolean }) => void;
}) {
  const t = useT(TEXT);
  const planT = useT(PLAN_TEXT);
  const [org, setOrg] = useState<Organization | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [fallback, setFallback] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setOrg(await call<Organization>('/organization')); }
    catch { setOrg(null); }
    finally { setLoaded(true); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const ready = orgPublishReady(org, loaded);
  useEffect(() => { onGate?.({ loaded, ready, busy }); }, [loaded, ready, busy, onGate]);

  async function planTeam(count: number) {
    setBusy(true); setPlanning(true); setError(null);
    try {
      const result = await call<{ fallbackReason: string | null }>('/organization/plan', { method: 'POST', body: JSON.stringify({ count }) });
      setFallback(!!result.fallbackReason);
      await load();
    } catch (caught) {
      const key = planErrorKey(caught instanceof RequestError ? caught.code : 'generic');
      setError(key ? planT(key) : t('error_generic'));
    } finally { setBusy(false); setPlanning(false); }
  }

  async function confirm() {
    if (!orgPublishReady(org, loaded) || busy) return false;
    setBusy(true); setError(null);
    try {
      const result = await call<{ createdEmployees: number; createdTools: number }>('/organization/confirm', { method: 'POST', body: '{}' });
      setNotice(t('published', { e: result.createdEmployees, t: result.createdTools }));
      await load();
      return true;
    } catch { setError(t('error_generic')); return false; }
    finally { setBusy(false); }
  }
  if (confirmRef) confirmRef.current = () => confirm();
  const body = <>
    <p className="helper">{t('hint')}</p>
    {error ? <p className="warn" role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {org?.canConfirm === false ? <p className="helper">{t('noAccess')}</p> : null}
    {org && org.blocked ? <p className="helper">{t('blocked')} <a href="#employees">{t('goEmployees')}</a></p> : null}
    {ready ? <>
      <TeamSizePlanner key={org.employees.length} current={org.employees.length} busy={busy} planning={planning} onPlan={count => void planTeam(count)} />
      {org.teamPlan ? <TeamPlanPreview plan={org.teamPlan} roles={org.employees} tools={org.tools} sops={org.sops} busy={busy} fallback={fallback}
        onAdopt={() => void call('/organization/plan/adopt', { method: 'POST', body: JSON.stringify({ planId: org.teamPlan!.id }) }).then(load)}
        onDiscard={() => void call('/organization/plan/discard', { method: 'POST', body: '{}' }).then(() => { setFallback(false); return load(); })} /> : null}
    </> : <a href="#employees">{t('goEmployees')}</a>}
  </>;

  if (embedded) {
    return <details className="ux-role-options" open>
      <summary>{t('title')}<span>{t('adjust')}</span></summary>
      {body}
    </details>;
  }

  return <section className="panel stack org-publish" aria-labelledby="org-publish-title">
    <h2 className="h2" id="org-publish-title">{t('title')}</h2>
    {body}
    <button className="btn primary" type="button" disabled={!ready || busy} onClick={() => void confirm()}>
      {busy ? t('publishing') : t('publish')}
    </button>
  </section>;
}
