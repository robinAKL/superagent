import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LangProvider } from '../src/i18n';
import { PLAN_TEXT, TeamPlanPreview, TeamSizePlanner, planErrorKey, type TeamPlanView } from '../src/pages/TeamSizePlanner';

const roles = [{ id: 'a', name: '订单审核员' }, { id: 'b', name: '信用分析员' }, { id: 'c', name: '坏账专员' }];
const tools = [{ key: 'kb', name: '知识库问答' }, { key: 'crm', name: '订单登记' }];
const sops = [{ key: 'review', name: '订单审核流程' }];
const plan: TeamPlanView = {
  id: 'p1', target: 2, method: 'model', createdAt: '', stale: false, replaces: 3, editedReplaced: 1,
  roles: [
    { name: '订单与信用专员', duty: '核对订单与信用', tools: ['kb', 'crm'], sops: ['review'], from: ['a', 'b'] },
    { name: '坏账专员', duty: '月度复盘', tools: [], sops: [], from: ['c'] },
  ],
};
const render = (lang: 'en' | 'zh', node: JSX.Element) => renderToStaticMarkup(<LangProvider initial={lang}>{node}</LangProvider>);

describe('team size planner', () => {
  it('starts at the current size and disables planning until the number changes', () => {
    const html = render('zh', <TeamSizePlanner current={3} busy={false} planning={false} onPlan={() => undefined} />);
    expect(html).toContain('当前 3 个岗位');
    expect(html).toMatch(/type="number"[^>]*value="3"/);
    expect(html).toMatch(/<button class="btn primary" disabled="">按人数重新规划<\/button>/);
    expect(html).toContain('已经是这个人数。');
  });

  it('previews each proposed role with where it comes from, its tools and workflows, and what it replaces', () => {
    const html = render('zh', <TeamPlanPreview plan={plan} roles={roles} tools={tools} sops={sops} busy={false} fallback={false} onAdopt={() => undefined} onDiscard={() => undefined} />);
    expect(html).toContain('新方案：2 个岗位');
    expect(html).toContain('超级智能体规划');
    expect(html).toContain('合并自：订单审核员、信用分析员');
    expect(html).toContain('来自：坏账专员');
    expect(html).toContain('知识库问答');
    expect(html).toContain('将替换当前全部 3 个岗位');
    expect(html).toContain('其中 1 个是你改过的');
    expect(html).toContain('采用这个方案');
  });

  it('marks a split role and blocks adopting a stale plan; English has no Chinese interface text', () => {
    const split: TeamPlanView = { ...plan, stale: true, method: 'merge', roles: [
      { name: 'A1', duty: 'd', tools: [], sops: [], from: ['a'] }, { name: 'A2', duty: 'd', tools: [], sops: [], from: ['a'] },
    ] };
    const en = render('en', <TeamPlanPreview plan={split} roles={roles.map(r => ({ ...r, name: 'Role' }))} tools={[]} sops={[]} busy={false} fallback onAdopt={() => undefined} onDiscard={() => undefined} />);
    expect(en).toContain('Split from: Role');
    expect(en).toContain('Merged by shared work (no model used)');
    expect(en).toMatch(/<button class="btn primary" type="button" disabled="">Use this plan<\/button>/);
    expect(en).not.toMatch(/[一-鿿]/);
  });

  it('maps server error codes to readable messages and translates every key', () => {
    expect(planErrorKey('split_needs_model')).toBe('error_split_needs_model');
    expect(planErrorKey('something_else')).toBeNull();
    for (const key of Object.keys(PLAN_TEXT.en)) expect(PLAN_TEXT.zh, key).toHaveProperty(key);
  });
});
