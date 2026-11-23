import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LangProvider } from '../src/i18n';
import { AssertionFacts, DimensionChips, KnowledgeTimeline, RuleCard, dimensionsOf, objectNames, recordedOf, timeFromParams, visibleAt, visibleDraft } from '../src/pages/KnowledgeLenses';
import { EmployeeWall } from '../src/pages/EmployeeWall';

const render = (lang: 'en' | 'zh', node: JSX.Element) => renderToStaticMarkup(<LangProvider initial={lang}>{node}</LangProvider>);
const runs = [{ id: 'r1', status: 'completed', createdAt: '2026-11-10T09:00:00.000Z' }];
const order = { id: 'o', key: 'order', kind: 'object', name: '订单', description: '客户提交的订单', evidence: [{ locator: 'guide.md#L2', quote: '收到订单' }] };
const approval = { id: 'a', key: 'approval', kind: 'object', name: '主管审批', description: '主管复核', evidence: [{ locator: 'guide.md#L3', quote: '主管审批' }] };
const rule = {
  id: 'r', key: 'order-approval', kind: 'relation', name: '超额订单需要审批', description: '订单金额超过 5 万元，必须提交主管审批。',
  relation: { from: 'order', to: 'approval', label: '超 5 万需' }, evidence: [{ locator: 'guide.md#L4', quote: '必须提交主管审批' }],
};
const role = { id: 'e', key: 'reviewer', kind: 'employee', name: '订单审核员', description: '必须核对信用额度', evidence: [] };

describe('knowledge lenses', () => {
  it('classifies drafts into several of the ten dimensions', () => {
    expect(dimensionsOf(rule)).toEqual(['fact', 'rule', 'condition']);
    expect(dimensionsOf(order)).toEqual(['fact', 'term']);
    // A role is a role, even when its duty says "must".
    expect(dimensionsOf(role)).toEqual(['role']);
    expect(dimensionsOf({ kind: 'sop', name: '订单审核流程', description: '收到订单后核对' })).toEqual(['condition', 'process']);
    expect(dimensionsOf({ kind: 'object', name: '超额需审批', description: '金额超过 5 万必须主管审批', ruleLike: true })).toEqual(['fact', 'rule', 'term']);
  });

  it('reads both dates from the URL and falls back to today', () => {
    const time = timeFromParams(new URLSearchParams('view=graph&at=2026-11-08&known=2026-11-02'));
    expect(time).toEqual({ at: '2026-11-08', known: '2026-11-02' });
    const today = new Date().toISOString().slice(0, 10);
    expect(timeFromParams(new URLSearchParams('at=nonsense'))).toEqual({ at: today, known: today });
  });

  it('hides what the platform learned after either chosen date', () => {
    const recorded = recordedOf(rule, runs);
    expect(recorded).toBe('2026-11-10T09:00:00.000Z');
    expect(visibleAt(recorded, { at: '2026-11-10', known: '2026-11-10' })).toBe(true);
    expect(visibleAt(recorded, { at: '2026-11-17', known: '2026-11-09' })).toBe(false);
    expect(visibleAt(recorded, { at: '2026-11-09', known: '2026-11-17' })).toBe(false);
    expect(recordedOf({ ...rule, evidence: [{ locator: 'x', quote: 'y', retrievedAt: '2026-11-12T00:00:00Z' }] }, runs)).toBe('2026-11-12T00:00:00Z');
    const dated = { ...rule, recordedAt: '2026-11-03T00:00:00Z', effectiveFrom: '2026-08-01', effectiveTo: '2026-10-31' };
    expect(visibleDraft(dated, runs, { at: '2026-09-01', known: '2026-11-03' })).toBe(true);
    expect(visibleDraft(dated, runs, { at: '2026-11-02', known: '2026-11-03' })).toBe(false);
    expect(visibleDraft(dated, runs, { at: '2026-09-01', known: '2026-11-02' })).toBe(false);
  });

  it('shows the key rule with object names, its source and honest effect date', () => {
    const html = render('zh', <RuleCard drafts={[order, approval, rule]} runs={runs} names={objectNames([order, approval])} />);
    expect(html).toContain('关键规则');
    expect(html).toContain('订单 → 超 5 万需 → 主管审批');
    expect(html).toContain('来源：guide.md#L4');
    expect(html).toContain('业务有效：资料未写明，按 2026-11-10 计');
    const stated = render('zh', <RuleCard drafts={[{ ...rule, effectiveFrom: '2026-08-01' }]} runs={runs} names={objectNames([order, approval])} />);
    expect(stated).toContain('业务有效：2026-08-01');
    expect(stated).not.toContain('资料未写明');
    const untilOnly = render('zh', <RuleCard drafts={[{ ...rule, effectiveTo: '2026-10-31' }]} runs={runs} names={objectNames([order, approval])} />);
    expect(untilOnly).toContain('业务有效：2026-10-31');
    expect(untilOnly).not.toContain('资料未写明');
    expect(html).toContain('待核对');
    expect(render('en', <RuleCard drafts={[order]} runs={runs} names={new Map()} />)).toContain('No rule found yet');
  });

  it('counts every dimension chip and lists the facts of an assertion', () => {
    const chips = render('zh', <DimensionChips drafts={[order, approval, rule, role]} value="rule" onChange={() => undefined} />);
    expect(chips).toMatch(/全部维度 <span>4<\/span>/);
    expect(chips).toMatch(/aria-pressed="true">业务规则与政策 <span>1<\/span>/);
    expect(chips).toMatch(/例外与经验 <span>0<\/span>/);
    const facts = render('en', <AssertionFacts draft={rule} runs={runs} names={objectNames([order, approval])} />);
    expect(facts).toContain('Rules &amp; policies');
    const untilFacts = render('en', <AssertionFacts draft={{ ...rule, effectiveTo: '2026-10-31', recordedAt: '2026-11-10T09:00:00.000Z' }} runs={runs} names={objectNames([order, approval])} />);
    expect(untilFacts).toContain('Effective 2026-10-31');
    expect(untilFacts).not.toContain('not stated');
    expect(facts).toContain('订单 → 超 5 万需 → 主管审批');
    expect(facts).toContain('Extracted candidate, pending review');
  });

  it('merges material, analysis and organization events newest first', () => {
    const html = render('zh', <KnowledgeTimeline time={{ at: '2026-11-17', known: '2026-11-17' }} runs={runs} drafts={[rule]} organizationConfirmedAt="2026-11-11T08:00:00.000Z"
      items={[{ id: 'i', title: '订单审核指南', version: 'v1', confirmed: true, confirmedAt: '2026-11-09T08:00:00.000Z' }]} />);
    const order = ['确认组织', '知识分析', '确认资料'].map(text => html.indexOf(text));
    expect(order.every(index => index > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    const dated = render('zh', <KnowledgeTimeline time={{ at: '2026-11-17', known: '2026-11-17' }} runs={runs}
      drafts={[{ ...rule, effectiveFrom: '2026-08-01', effectiveTo: '2026-10-31' }]} items={[]} />);
    expect(dated).toContain('2026-08-01 – 2026-10-31');
    const past = render('zh', <KnowledgeTimeline time={{ at: '2026-11-09', known: '2026-11-09' }} runs={runs} drafts={[]} items={[]} />);
    expect(past).toContain('在所选日期之后记录');
    const recorded = render('zh', <KnowledgeTimeline time={{ at: '2026-11-17', known: '2026-11-17' }} runs={runs}
      drafts={[{ ...rule, recordedAt: '2026-11-03T12:00:00.000Z' }]} items={[]} />);
    expect(recorded).toContain('2026-11-03 12:00');
    expect(recorded.indexOf('2026-11-03 12:00')).toBeGreaterThan(recorded.indexOf('2026-11-10 09:00'));
  });
});

describe('employee wall', () => {
  it('shows one card per employee with status, owner and a manage link to its role', () => {
    const html = render('zh', <EmployeeWall hasDraft employees={[
      { id: 'emp-org-rec1', name: '订单审核员', duty: '核对订单', status: 'unconnected', owner: 'dev-owner', source: 'recommended' },
      { id: 'emp-2', name: '客服', duty: '回复客户', status: 'online', source: 'manual' },
    ]} />);
    expect(html.match(/class="emp-card"/g)).toHaveLength(2);
    expect(html).toContain('新增岗位');
    expect(html).toContain('href="#employees?view=draft"');
    expect(html).toContain('href="#employees?manage=emp-org-rec1"');
    expect(html).toContain('未连接');
    expect(html).toContain('在线');
    // The owner moved to the manage drawer (UX plan: the team table is employee, status, computer, tools).
    expect(html).not.toContain('dev-owner');
    expect(render('en', <EmployeeWall hasDraft={false} employees={[]} />)).toContain('href="#knowledge?view=analysis"');
  });
});
