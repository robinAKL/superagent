import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LangProvider } from '../src/i18n';
import { buildOntologyGraph, OntologyGraphView, nodeTypeOf, wrapLabel, type OntologyDraft } from '../src/components/OntologyGraphView';
import { groupEvidence, readableQuote, sourceLabel } from '../src/components/evidence';

const ev = [{ locator: 'order-form.xlsx page 5', quote: 'PVC frame types', sourceId: 'src1', version: 'v1', retrievedAt: '2026-11-08T00:00:00Z' }];
const object = (key: string, name: string, extra: Partial<OntologyDraft> = {}): OntologyDraft => ({ id: `o-${key}`, key, kind: 'object', name, description: `${name} description`, evidence: ev, ...extra });
const relation = (id: string, from: string, to: string, label: string): OntologyDraft => ({ id, key: id, kind: 'relation', name: label, description: '', evidence: ev, relation: { from, to, label } });

const drafts: OntologyDraft[] = [
  object('order', '采购订单表单'), object('frame', 'PVC 框型与规格'), object('color', '颜色选项'), object('lonely', '供应商'),
  relation('r1', 'order', 'frame', '包含'), relation('r2', 'order', 'color', '包含'), relation('r3', 'frame', 'order', '限定'),
  relation('r4', 'order', 'missing', '引用'), relation('r5', 'order', 'order', '自身'),
  { id: 'e1', key: 'clerk', kind: 'employee', name: 'Clerk', description: '', evidence: ev, assignment: { tools: ['kb'], sops: [] } },
  { id: 't1', key: 'kb', kind: 'tool', name: 'Policy QA', description: 'look up policy', evidence: ev },
];

describe('ontology graph model', () => {
  it('turns entity drafts into typed nodes and keeps sources out of the graph by default', () => {
    const { nodes, links } = buildOntologyGraph(drafts);
    expect(nodes.map(n => n.key).sort()).toEqual(['clerk', 'color', 'frame', 'kb', 'lonely', 'order']);
    expect(nodes.find(n => n.key === 'clerk')!.type).toBe('employee');
    expect(nodes.find(n => n.key === 'kb')!.type).toBe('tool');
    expect(links.filter(l => ['r1', 'r2', 'r3'].includes(l.id)).map(l => l.id)).toEqual(['r1', 'r2', 'r3']);
    expect(links.some(l => l.id === 'use:clerk:kb' && l.derived)).toBe(true);
    expect(links.some(l => l.label === '__sourced')).toBe(false);
    expect(nodes.find(n => n.key === 'order')!.degree).toBe(3);
  });

  it('adds one source node per document, not per line anchor, when the source layer is on', () => {
    const a = object('a', 'A', { evidence: [{ locator: 'GUIDE.md#L3', quote: 'x', sourceId: 'guide' }] });
    const b = object('b', 'B', { evidence: [{ locator: 'GUIDE.md#L40', quote: 'y', sourceId: 'guide' }, { locator: 'GUIDE.md#L41', quote: 'z', sourceId: 'guide' }] });
    const { nodes, links } = buildOntologyGraph([a, b], { withSources: true });
    const sources = nodes.filter(n => n.type === 'source');
    expect(sources).toHaveLength(1);
    expect(sources[0]!.name).toBe('GUIDE.md');
    expect(links.filter(l => l.label === '__sourced')).toHaveLength(2);
  });

  it('gives parallel relations between the same pair separate lanes, in either direction', () => {
    const { links } = buildOntologyGraph(drafts);
    const pair = links.filter(l => ['r1', 'r3'].includes(l.id));
    expect(pair.map(l => [l.lane, l.lanes])).toEqual([[0, 2], [1, 2]]);
    expect(links.find(l => l.id === 'r2')).toMatchObject({ lane: 0, lanes: 1 });
  });

  it('wraps long names into at most two lines but keeps the full name', () => {
    const long = object('long', 'ISWELL 采购订单表单（常规）与附件清单以及颜色选项数据和更多更多的说明文字');
    const [node] = buildOntologyGraph([long]).nodes;
    expect(node!.name).toBe(long.name);
    expect(node!.lines).toHaveLength(2);
    expect(node!.lines[1]!.endsWith('…')).toBe(true);
    expect(wrapLabel('Short')).toEqual(['Short']);
  });

  it('types rules from the analysis flag, falling back to the name only', () => {
    expect(nodeTypeOf({ kind: 'object', name: 'Deposit', ruleLike: true })).toBe('rule');
    expect(nodeTypeOf({ kind: 'object', name: '审批阈值' })).toBe('rule');
    expect(nodeTypeOf({ kind: 'object', name: 'Wholesale order' })).toBe('object');
    expect(nodeTypeOf({ kind: 'sop', name: 'Order flow' })).toBe('process');
  });

  it('merges the same entity from company and MCP sources, with attributes and shifted citations', () => {
    const company = [object('order', '采购订单', { attributes: [{ name: '币种', value: 'NZD', citation: 1 }] }), relation('rx', 'order', 'mcp-item', '引用')];
    const mcp = [object('order', '订单 MCP', { privateMcp: true, attributes: [{ name: '定金', value: '60%', citation: 1 }, { name: '币种', value: 'AUD' }] }), object('mcp-item', 'MCP 明细', { privateMcp: true })];
    const { nodes, links } = buildOntologyGraph([...company, ...mcp]);
    const order = nodes.filter(n => n.key === 'order');
    expect(order).toHaveLength(1);
    expect(order[0]!.draft.evidence).toHaveLength(2);
    expect(order[0]!.draft.attributes).toEqual([{ name: '币种', value: 'NZD', citation: 1 }, { name: '定金', value: '60%', citation: 2 }]);
    expect(order[0]!.draft.privateMcp).toBe(false);
    expect(nodes.find(n => n.key === 'mcp-item')!.draft.privateMcp).toBe(true);
    expect(links.some(l => l.id === 'rx')).toBe(true);
  });

  it('keeps assertion recordedAt and effective dates on the node', () => {
    const d = object('order', '订单', { recordedAt: '2026-11-01T12:00:00Z', effectiveFrom: '2026-08-01', effectiveTo: '2026-10-31' });
    const node = buildOntologyGraph([d]).nodes[0]!;
    expect(node.draft.recordedAt).toBe('2026-11-01T12:00:00Z');
    expect(node.draft.effectiveFrom).toBe('2026-08-01');
  });
});

describe('evidence helpers', () => {
  it('groups passages by document and keeps citation indexes', () => {
    const groups = groupEvidence([{ locator: 'a.md#L1', quote: '1' }, { locator: 'b.md', quote: '2' }, { locator: 'a.md#L9', quote: '3' }]);
    expect(groups.map(g => [g.label, g.items.map(i => i.index)])).toEqual([['a.md', [0, 2]], ['b.md', [1]]]);
    expect(sourceLabel('VERA CRM / get_crm_guide')).toBe('VERA CRM / get_crm_guide');
  });

  it('turns a JSON tool fragment into readable text', () => {
    const text = readableQuote('{"title":"CRM operating guide","summary":"Workflow order: customer order → review","mcp_tools":["get_order","approve_order"]');
    expect(text).not.toMatch(/[{}"[\]]/);
    expect(text).toContain('title: CRM operating guide');
    expect(text).toContain('mcp tools: get_order · approve_order');
    expect(readableQuote('Plain   prose.')).toBe('Plain prose.');
  });
});

describe('ontology graph view', () => {
  const render = (lang: 'en' | 'zh', list: OntologyDraft[], companyName?: string) =>
    renderToStaticMarkup(<LangProvider initial={lang}><OntologyGraphView drafts={list} companyName={companyName} time={{ at: '2026-11-08', known: '2026-11-08' }} /></LangProvider>);

  it('says honestly when analysis found no entities', () => {
    const html = render('zh', []);
    expect(html).toContain('还没有实体');
    expect(html).toContain('href="#knowledge?view=analysis"');
    expect(html).not.toContain('<svg');
  });

  it('draws one graph for company and MCP drafts — no source split', () => {
    const html = render('zh', [...drafts, object('mcp', 'MCP 对象', { privateMcp: true })], 'ISWELL');
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain('我的 MCP 来源');
    expect(html).toContain('ISWELL 的本体');
    expect(html).toContain('7 个实体 ·');
    expect(html).toContain('<svg');
    expect(html).toContain('数字员工');
    expect(html).toContain('仅自己');
    expect(html).toContain('来源图层');
  });

  it('offers type filters as a legend with counts', () => {
    const html = render('en', drafts);
    expect(html).toMatch(/aria-pressed="true"[^>]*><i aria-hidden="true"><\/i>Business object<span>4<\/span>/);
    expect(html).toContain('Tool');
  });

  it('has no Chinese interface text in English', () => {
    const html = render('en', drafts.map(d => ({ ...d, name: 'Name', description: 'd', relation: d.relation && { ...d.relation, label: 'has' } })));
    expect(html).not.toMatch(/[一-鿿]/);
  });
});
