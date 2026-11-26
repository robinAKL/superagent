import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { translate } from '../src/i18n';
import { RoleCard, TEXT } from '../src/pages/EmployeesPage';

const org = {
  employees: [] as never[],
  tools: [
    { id: 't1', key: 'kb', name: 'Knowledge Q&A', description: '', evidence: [], toolId: 'knowledge.search', match: 'existing' as const, matchName: 'Knowledge Base Q&A' },
    { id: 't2', key: 'crm', name: 'Order entry', description: '', evidence: [], toolId: null, match: 'placeholder' as const, matchName: null },
  ],
  sops: [{ id: 's1', key: 'review', name: 'Order review', description: '', evidence: [] }],
  confirmation: null, changedSinceConfirmation: false, missing: 0, blocked: null, canConfirm: true,
};
const role = {
  id: 'r1', key: 'reviewer', name: 'Order reviewer', duty: 'Checks credit and amount', prompt: 'You are the order reviewer.', promptEdited: false,
  origin: 'inferred' as 'inferred' | 'manual', evidence: [{ sourceId: 'x', version: 'v1', locator: 'guide.md#L3', quote: 'Check credit limit' }],
  privateSource: false, tools: ['kb', 'crm'], sops: ['review'], employeeId: null as string | null,
};
const render = (lang: 'en' | 'zh', patch: Partial<typeof role> = {}) => {
  const t = (key: keyof typeof TEXT.en, vars?: Record<string, string | number>) => translate(TEXT, lang, key, vars);
  const r = { ...role, ...patch };
  return renderToStaticMarkup(<RoleCard role={r} org={{ ...org, employees: [r, { ...r, id: 'r2', name: 'Other' }] }} busy={false} t={t}
    onSave={async () => true} onMerge={() => undefined} onRemove={() => undefined} />);
};

describe('Digital employees: role card', () => {
  it('shows duty, tools marked reusable or missing, workflows and sources', () => {
    const html = render('en');
    expect(html).toContain('Checks credit and amount');
    expect(html).toMatch(/org-chip is-ready" title="Knowledge Q&amp;A">Knowledge Q&amp;A/);
    expect(html).toMatch(/org-chip is-missing" title="Order entry">Order entry/);
    expect(html).toContain('Order review');
    expect(html).toContain('Sources (1)');
    expect(html).toContain('guide.md#L3');
    expect(html).toContain('>Merge into…<');
  });

  it('a long tool list shows six compact chips and a "+N more" toggle instead of a column of pills', () => {
    const many = Array.from({ length: 9 }, (_, i) => `tool${i}`);
    const tools = many.map((key, i) => ({ id: `t${i}`, key, name: `record_order_step_${i} (CRM action)`, description: '', evidence: [], toolId: null, match: 'placeholder' as const, matchName: null }));
    const t = (key: keyof typeof TEXT.en, vars?: Record<string, string | number>) => translate(TEXT, 'en', key, vars);
    const r = { ...role, tools: many };
    const html = renderToStaticMarkup(<RoleCard role={r} org={{ ...org, tools, employees: [r] }} busy={false} t={t}
      onSave={async () => true} onMerge={() => undefined} onRemove={() => undefined} />);
    expect(html.match(/class="org-chip is-missing"/g)).toHaveLength(6);
    expect(html).toContain('title="record_order_step_0 (CRM action)"');
    expect(html).toMatch(/<button type="button" class="org-chip-more" aria-expanded="false">\+3 more<\/button>/);
    expect(html).not.toContain('record_order_step_8');
  });

  it('English UI contains no Chinese chrome; Chinese UI is fully translated', () => {
    expect(render('en')).not.toMatch(/[一-鿿]/);
    const zh = render('zh', { origin: 'manual', employeeId: 'emp-org-r1' });
    expect(zh).toContain('人工创建 · 无知识依据');
    expect(zh).toContain('已发布');
    expect(zh).toContain('合并到…');
    for (const key of Object.keys(TEXT.en)) expect(TEXT.zh, key).toHaveProperty(key);
  });
});
