import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LangProvider } from '../src/i18n';
import { buildOntologyGraph, OntologyGraphView, type OntologyDraft } from '../src/components/OntologyGraphView';

const ev = [{ locator: 'order-form.xlsx page 5', quote: 'PVC frame types' }];
const object = (key: string, name: string): OntologyDraft => ({ id: `o-${key}`, key, kind: 'object', name, description: `${name} description`, evidence: ev });
const relation = (id: string, from: string, to: string, label: string): OntologyDraft => ({ id, key: id, kind: 'relation', name: label, description: '', evidence: ev, relation: { from, to, label } });

const drafts: OntologyDraft[] = [
  object('order', '采购订单表单'), object('frame', 'PVC 框型与规格'), object('color', '颜色选项'), object('lonely', '供应商'),
  relation('r1', 'order', 'frame', '包含'), relation('r2', 'order', 'color', '包含'), relation('r3', 'frame', 'order', '限定'),
  relation('r4', 'order', 'missing', '引用'), relation('r5', 'order', 'order', '自身'),
  { id: 'e1', key: 'clerk', kind: 'employee', name: 'Clerk', description: '', evidence: ev },
];

describe('ontology graph model', () => {
  it('turns objects into nodes and keeps only relations whose two ends exist', () => {
    const { nodes, links } = buildOntologyGraph(drafts);
    expect(nodes.map(n => n.key)).toEqual(['order', 'frame', 'color', 'lonely']);
    expect(links.map(l => l.id)).toEqual(['r1', 'r2', 'r3']);
    expect(nodes.find(n => n.key === 'order')!.degree).toBe(3);
    expect(nodes.find(n => n.key === 'lonely')!.degree).toBe(0);
  });

  it('gives parallel relations between the same pair separate lanes, in either direction', () => {
    const { links } = buildOntologyGraph(drafts);
    const pair = links.filter(l => ['r1', 'r3'].includes(l.id));
    expect(pair.map(l => [l.lane, l.lanes])).toEqual([[0, 2], [1, 2]]);
    expect(links.find(l => l.id === 'r2')).toMatchObject({ lane: 0, lanes: 1 });
  });

  it('shortens long names for the node box but keeps the full name', () => {
    const long = object('long', 'ISWELL 采购订单表单（常规）与附件清单以及颜色选项数据');
    const [node] = buildOntologyGraph([long]).nodes;
    expect(node!.name).toBe(long.name);
    expect(node!.label.endsWith('…')).toBe(true);
    expect(node!.width).toBeLessThanOrEqual(210);
  });
});

describe('ontology graph view', () => {
  const render = (lang: 'en' | 'zh', shared: OntologyDraft[], personal: OntologyDraft[] = []) =>
    renderToStaticMarkup(<LangProvider initial={lang}><OntologyGraphView shared={shared} personal={personal} /></LangProvider>);

  it('says honestly when analysis found no business objects', () => {
    const html = render('zh', [], []);
    expect(html).toContain('还没有业务对象');
    expect(html).toContain('href="#knowledge?view=analysis"');
    expect(html).not.toContain('<svg');
  });

  it('keeps company and personal MCP drafts apart, with counts, and lists objects for keyboard users', () => {
    const html = render('zh', drafts, [object('mcp', 'MCP 对象')]);
    expect(html).toContain('role="tablist"');
    expect(html).toMatch(/企业资料 <span>4<\/span>/);
    expect(html).toMatch(/我的 MCP 来源 <span>1<\/span>/);
    expect(html).toContain('4 个业务对象 · 3 条关系');
    expect(html).toContain('<svg');
    expect(html.match(/<li><button type="button">/g)).toHaveLength(4);
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
