import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LangProvider } from '../src/i18n';
import { buildOntologyGraph, OntologyGraphView, nodeTypeOf, type OntologyDraft } from '../src/components/OntologyGraphView';

const ev = [{ locator: 'order-form.xlsx page 5', quote: 'PVC frame types', sourceId: 'src1', version: 'v1', retrievedAt: '2026-11-08T00:00:00Z' }];
const object = (key: string, name: string): OntologyDraft => ({ id: `o-${key}`, key, kind: 'object', name, description: `${name} description`, evidence: ev });
const relation = (id: string, from: string, to: string, label: string): OntologyDraft => ({ id, key: id, kind: 'relation', name: label, description: '', evidence: ev, relation: { from, to, label } });

const drafts: OntologyDraft[] = [
  object('order', '采购订单表单'), object('frame', 'PVC 框型与规格'), object('color', '颜色选项'), object('lonely', '供应商'),
  relation('r1', 'order', 'frame', '包含'), relation('r2', 'order', 'color', '包含'), relation('r3', 'frame', 'order', '限定'),
  relation('r4', 'order', 'missing', '引用'), relation('r5', 'order', 'order', '自身'),
  { id: 'e1', key: 'clerk', kind: 'employee', name: 'Clerk', description: '', evidence: ev, assignment: { tools: ['kb'], sops: [] } },
  { id: 't1', key: 'kb', kind: 'tool', name: 'Policy QA', description: 'look up policy', evidence: ev },
];

describe('ontology graph model', () => {
  it('turns objects, employees, tools and source documents into typed nodes', () => {
    const { nodes, links } = buildOntologyGraph(drafts);
    expect(nodes.map(n => n.key).sort()).toEqual(['clerk', 'color', 'frame', 'kb', 'lonely', 'order', 'src:src1:v1']);
    expect(nodes.find(n => n.key === 'clerk')!.type).toBe('employee');
    expect(nodes.find(n => n.key === 'kb')!.type).toBe('tool');
    expect(nodes.find(n => n.key === 'src:src1:v1')!.type).toBe('source');
    expect(links.filter(l => ['r1', 'r2', 'r3'].includes(l.id)).map(l => l.id)).toEqual(['r1', 'r2', 'r3']);
    expect(links.some(l => l.id === 'use:clerk:kb')).toBe(true);
    expect(nodes.find(n => n.key === 'order')!.degree).toBeGreaterThanOrEqual(3);
  });

  it('gives parallel relations between the same pair separate lanes, in either direction', () => {
    const { links } = buildOntologyGraph(drafts);
    const pair = links.filter(l => ['r1', 'r3'].includes(l.id));
    expect(pair.map(l => [l.lane, l.lanes])).toEqual([[0, 2], [1, 2]]);
    expect(links.find(l => l.id === 'r2')).toMatchObject({ lane: 0, lanes: 1 });
  });

  it('shortens long names for the node box but keeps the full name', () => {
    const long = object('long', 'ISWELL 采购订单表单（常规）与附件清单以及颜色选项数据');
    const [node] = buildOntologyGraph([long]).nodes.filter(n => n.key === 'long');
    expect(node!.name).toBe(long.name);
    expect(node!.label.endsWith('…')).toBe(true);
    expect(node!.width).toBeLessThanOrEqual(260);
  });

  it('labels a rule-like object as a rule node', () => {
    expect(nodeTypeOf({ id: 'p', key: 'p', kind: 'object', name: '审批阈值', description: '超过 5 万必须审批', evidence: [] })).toBe('rule');
  });

  it('places a real company node from the knowledge space name, not an invented type', () => {
    const { nodes } = buildOntologyGraph(drafts, 'ISWELL');
    const company = nodes.find(n => n.type === 'company');
    expect(company?.name).toBe('ISWELL');
    expect(nodeTypeOf({ id: 'c', key: 'company', kind: 'company', name: 'ISWELL', description: '', evidence: [] })).toBe('company');
  });

  it('keeps assertion recordedAt and effective dates on the node instead of evidence retrievedAt', () => {
    const d = { ...object('order', '订单'), recordedAt: '2026-11-01T12:00:00Z', effectiveFrom: '2026-08-01', effectiveTo: '2026-10-31' };
    const node = buildOntologyGraph([d]).nodes.find(n => n.key === 'order')!;
    expect(node.draft.recordedAt).toBe('2026-11-01T12:00:00Z');
    expect(node.draft.effectiveFrom).toBe('2026-08-01');
    expect(node.draft.effectiveTo).toBe('2026-10-31');
  });
});

describe('ontology graph view', () => {
  const render = (lang: 'en' | 'zh', shared: OntologyDraft[], personal: OntologyDraft[] = []) =>
    renderToStaticMarkup(<LangProvider initial={lang}><OntologyGraphView shared={shared} personal={personal} time={{ at: '2026-11-08', known: '2026-11-08' }} /></LangProvider>);

  it('says honestly when analysis found no entities', () => {
    const html = render('zh', [], []);
    expect(html).toContain('还没有实体');
    expect(html).toContain('href="#knowledge?view=analysis"');
    expect(html).not.toContain('<svg');
  });

  it('keeps company and personal MCP drafts apart, with type labels and a keyboard relation table after select', () => {
    const html = render('zh', drafts, [object('mcp', 'MCP 对象')]);
    expect(html).toContain('role="tablist"');
    expect(html).toMatch(/企业资料 <span>7<\/span>/);
    expect(html).toMatch(/我的 MCP 来源 <span>2<\/span>/);
    expect(html).toContain('7 个实体 ·');
    expect(html).toContain('<svg');
    expect(html).toContain('数字员工');
    expect(html).toContain('来源文档');
    expect(html.match(/<li><button type="button">/g)?.length).toBeGreaterThanOrEqual(7);
  });

  it('shows identity, version and times in the entity list chrome', () => {
    const html = render('zh', [object('order', '订单')]);
    expect(html).toContain('业务对象');
    expect(html).toContain('订单');
  });

  it('shows the personal graph when only personal drafts exist, with the privacy note', () => {
    const html = render('en', [], drafts);
    expect(html).not.toContain('role="tablist"');
    expect(html).toContain('My MCP sources');
    expect(html).toContain('Only you can see drafts from your MCP sources.');
  });

  it('has no Chinese interface text in English', () => {
    const html = render('en', drafts.map(d => ({ ...d, name: 'Name', description: 'd', relation: d.relation && { ...d.relation, label: 'has' } })));
    expect(html).not.toMatch(/[一-鿿]/);
  });
});
