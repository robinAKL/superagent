import { useState } from 'react';
import { useT } from '../i18n';

/**
 * "Team size" on Digital employees: the owner types how many roles they want and the super agent re-plans the
 * role drafts to exactly that number. The proposal is a preview with its provenance (which roles each new one
 * comes from); nothing changes until it is adopted, and the team is then confirmed as usual.
 */
export interface TeamPlanView {
  id: string; target: number; method: 'model' | 'merge'; createdAt: string; stale: boolean; replaces: number; editedReplaced: number;
  roles: { name: string; duty: string; tools: string[]; sops: string[]; from: string[] }[];
}
interface Named { id?: string; key: string; name: string }

export const PLAN_TEXT = {
  en: {
    title: 'Team size', current: 'Now {n} roles', label: 'Number of digital employees', plan: 'Re-plan for this size', planning: 'Super Agent is planning…',
    hint: 'Super Agent merges or splits responsibilities to fit the number, keeping every tool and workflow covered. You see a preview first.',
    same: 'That is the current size.',
    previewTitle: 'Proposal: {n} roles', byModel: 'Planned by Super Agent', byMerge: 'Merged by shared work (no model used)',
    replaces: 'Replaces all {n} current roles', editedWarn: '{n} of them were edited by you; their edits guided this plan but the roles themselves will be replaced.',
    mergedFrom: 'Merged from: {list}', splitFrom: 'Split from: {list}', keptFrom: 'From: {list}',
    tools: 'Tools', sops: 'Workflows', none: 'None',
    adopt: 'Use this plan', discard: 'Discard', afterAdopt: 'After using it, confirm the organization to update the team.',
    stale: 'The roles changed after this proposal was made. Plan again.',
    fallback: 'Super Agent was not available, so roles that share the most work were merged instead.',
    error_split_needs_model: 'More roles means splitting responsibilities, which needs Super Agent. Configure a model in Admin settings first.',
    error_plan_failed: 'Super Agent did not return a usable plan. Try again.',
    error_team_size_unchanged: 'That is the current size.',
    error_invalid_team_size: 'Enter a whole number from 1 to 20.',
    error_plan_stale: 'The roles changed after this proposal was made. Plan again.',
    error_plan_not_found: 'This proposal no longer exists. Plan again.',
    error_generic: 'The request did not complete. Try again.',
    sep: ', ',
  },
  zh: {
    title: '团队规模', current: '当前 {n} 个岗位', label: '数字员工人数', plan: '按人数重新规划', planning: '超级智能体正在规划…',
    hint: '超级智能体会按人数合并或拆分职责，保证所有工具和流程都有人负责。先给你看预览，确认后才生效。',
    same: '已经是这个人数。',
    previewTitle: '新方案：{n} 个岗位', byModel: '超级智能体规划', byMerge: '按职责重叠自动合并（未使用模型）',
    replaces: '将替换当前全部 {n} 个岗位', editedWarn: '其中 {n} 个是你改过的；你的修改已作为规划依据，但这些岗位本身会被替换。',
    mergedFrom: '合并自：{list}', splitFrom: '拆分自：{list}', keptFrom: '来自：{list}',
    tools: '工具', sops: '流程', none: '暂无',
    adopt: '采用这个方案', discard: '放弃', afterAdopt: '采用后请「确认组织」更新团队。',
    stale: '规划之后岗位有变化，请重新规划。',
    fallback: '超级智能体暂不可用，已改为把职责重叠最多的岗位合并。',
    error_split_needs_model: '增加人数需要超级智能体拆分职责，请先在「管理设置」里配置模型。',
    error_plan_failed: '超级智能体没有给出可用的方案，请重试。',
    error_team_size_unchanged: '已经是这个人数。',
    error_invalid_team_size: '请输入 1 到 20 之间的整数。',
    error_plan_stale: '规划之后岗位有变化，请重新规划。',
    error_plan_not_found: '这个方案已不存在，请重新规划。',
    error_generic: '请求未完成，请重试。',
    sep: '、',
  },
};
type PlanKey = keyof typeof PLAN_TEXT.en;

export function TeamPlanPreview({ plan, roles, tools, sops, busy, onAdopt, onDiscard, fallback }: {
  plan: TeamPlanView; roles: { id: string; name: string }[]; tools: Named[]; sops: Named[]; busy: boolean;
  onAdopt: () => void; onDiscard: () => void; fallback: boolean;
}) {
  const t = useT(PLAN_TEXT);
  const roleName = (id: string) => roles.find(r => r.id === id)?.name ?? '—';
  const name = (list: Named[], key: string) => list.find(x => x.key === key)?.name ?? key;
  const fromCount = new Map<string, number>();
  for (const r of plan.roles) for (const f of r.from) fromCount.set(f, (fromCount.get(f) ?? 0) + 1);
  const origin = (from: string[]) => {
    const list = from.map(roleName).join(t('sep'));
    if (from.length > 1) return t('mergedFrom', { list });
    return (fromCount.get(from[0]!) ?? 0) > 1 ? t('splitFrom', { list }) : t('keptFrom', { list });
  };
  return <section className="team-plan" aria-labelledby="team-plan-title">
    <header className="team-plan-head">
      <h3 id="team-plan-title">{t('previewTitle', { n: plan.roles.length })}</h3>
      <span className={`org-badge ${plan.method === 'model' ? 'is-gold' : ''}`}>{t(plan.method === 'model' ? 'byModel' : 'byMerge')}</span>
    </header>
    {fallback ? <p className="helper">{t('fallback')}</p> : null}
    {plan.stale ? <p className="org-alert is-warning" role="status">{t('stale')}</p> : null}
    <ol className="team-plan-roles">
      {plan.roles.map((role, i) => <li key={i}>
        <div className="team-plan-role-head"><strong>{role.name}</strong><small>{origin(role.from)}</small></div>
        <p>{role.duty}</p>
        <dl className="org-links">
          <dt>{t('tools')}</dt><dd>{role.tools.length ? role.tools.map(k => <span key={k} className="org-chip">{name(tools, k)}</span>) : <span className="helper">{t('none')}</span>}</dd>
          <dt>{t('sops')}</dt><dd>{role.sops.length ? role.sops.map(k => <span key={k} className="org-chip">{name(sops, k)}</span>) : <span className="helper">{t('none')}</span>}</dd>
        </dl>
      </li>)}
    </ol>
    <footer className="team-plan-foot">
      <p className="helper">{t('replaces', { n: plan.replaces })}{plan.editedReplaced ? ` ${t('editedWarn', { n: plan.editedReplaced })}` : ''} {t('afterAdopt')}</p>
      <div className="org-row">
        <button className="btn" type="button" disabled={busy} onClick={onDiscard}>{t('discard')}</button>
        <button className="btn primary" type="button" disabled={busy || plan.stale} onClick={onAdopt}>{t('adopt')}</button>
      </div>
    </footer>
  </section>;
}

export function TeamSizePlanner({ current, busy, planning, onPlan }: { current: number; busy: boolean; planning: boolean; onPlan: (count: number) => void }) {
  const t = useT(PLAN_TEXT);
  const [value, setValue] = useState(String(current));
  const count = Number(value);
  const valid = Number.isInteger(count) && count >= 1 && count <= 20;
  function submit() { if (valid && count !== current) onPlan(count); }
  return <div className="team-size" aria-labelledby="team-size-title">
    <div className="team-size-text">
      <h2 id="team-size-title">{t('title')}</h2>
      <p className="helper">{t('current', { n: current })} · {t('hint')}</p>
    </div>
    <div className="team-size-controls">
      <label className="team-size-field">
        <span>{t('label')}</span>
        <span className="team-size-stepper">
          <button type="button" aria-label="−" disabled={busy || count <= 1} onClick={() => setValue(String(Math.max(1, (valid ? count : current) - 1)))}>−</button>
          <input type="number" inputMode="numeric" min={1} max={20} step={1} value={value} onChange={e => setValue(e.target.value)} />
          <button type="button" aria-label="+" disabled={busy || count >= 20} onClick={() => setValue(String(Math.min(20, (valid ? count : current) + 1)))}>+</button>
        </span>
      </label>
      <button className="btn primary" type="button" disabled={busy || !valid || count === current} onClick={submit}>{planning ? t('planning') : t('plan')}</button>
    </div>
    {valid && count === current ? <small className="helper">{t('same')}</small> : null}
  </div>;
}

export function planErrorKey(code: string): PlanKey | null {
  const key = `error_${code}` as PlanKey;
  return key in PLAN_TEXT.en ? key : null;
}
