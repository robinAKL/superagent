import { useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import { useT } from '../i18n';
import './OntologyGraphView.css';

/**
 * Ontology = the business objects analysis found and the directed relations between them, drawn as a force graph.
 * Shared drafts (from confirmed company sources) and the viewer's private MCP drafts are shown separately, never merged.
 * D3 owns positions, zoom and drag; React owns selection, the detail panel and the keyboard-accessible object list.
 */
export interface OntologyEvidence { locator: string; quote: string; sourceId?: string; version?: string }
export interface OntologyDraft {
  id: string; key: string; kind: string; name: string; description: string;
  evidence: OntologyEvidence[]; relation?: { from: string; to: string; label: string };
}

export interface GraphNode extends d3.SimulationNodeDatum { id: string; key: string; name: string; label: string; width: number; degree: number; draft: OntologyDraft }
export interface GraphLink extends d3.SimulationLinkDatum<GraphNode> { id: string; label: string; source: string | GraphNode; target: string | GraphNode; lane: number; lanes: number; draft: OntologyDraft }

const TEXT = {
  en: {
    shared: 'Company sources', personal: 'My MCP sources', summary: '{objects} business objects · {relations} relationships',
    emptyTitle: 'No business objects yet',
    emptyBody: 'Confirm materials in Company knowledge and run an analysis. The objects it finds, and how they relate, are drawn here with their sources.',
    openAnalysis: 'Open knowledge analysis',
    zoomIn: 'Zoom in', zoomOut: 'Zoom out', fit: 'Fit to view', canvas: 'Ontology graph',
    hint: 'Drag to move · select an object to see its sources',
    objects: 'Objects', object: 'Business object', relation: 'Relationship', relations: 'Relationships ({n})',
    noRelations: 'No relationship found for this object yet.', sources: 'Sources ({n})', noSources: 'No locatable source.',
    personalNote: 'Only you can see drafts from your MCP sources.', back: 'All objects', isolated: 'not linked',
  },
  zh: {
    shared: '企业资料', personal: '我的 MCP 来源', summary: '{objects} 个业务对象 · {relations} 条关系',
    emptyTitle: '还没有业务对象',
    emptyBody: '先在企业知识里确认资料并运行分析。分析找到的业务对象和它们之间的关系会画在这里，并附上原文依据。',
    openAnalysis: '打开知识分析',
    zoomIn: '放大', zoomOut: '缩小', fit: '适配窗口', canvas: '本体关系图',
    hint: '拖动节点调整位置 · 选中对象查看依据',
    objects: '对象', object: '业务对象', relation: '关系', relations: '关系（{n}）',
    noRelations: '这个对象还没有找到关系。', sources: '依据（{n}）', noSources: '没有可定位的依据。',
    personalNote: '个人 MCP 来源的草案只有你能看到。', back: '全部对象', isolated: '未关联',
  },
};

const charWidth = (ch: string) => (/[⺀-￿]/.test(ch) ? 14 : 7.6);
function fitLabel(name: string, max = 168): { label: string; width: number } {
  let width = 0, label = '';
  for (const ch of name) {
    if (width + charWidth(ch) > max) return { label: `${label}…`, width: width + 10 + 28 };
    width += charWidth(ch); label += ch;
  }
  return { label, width: Math.max(width + 28, 64) };
}

/** Pure: objects become nodes, relations whose two ends exist become links; parallel links get separate lanes. */
export function buildOntologyGraph(drafts: OntologyDraft[]): { nodes: GraphNode[]; links: GraphLink[] } {
  const nodes: GraphNode[] = [];
  const byKey = new Map<string, GraphNode>();
  for (const draft of drafts) {
    if (draft.kind !== 'object' || byKey.has(draft.key)) continue;
    const { label, width } = fitLabel(draft.name);
    const node: GraphNode = { id: draft.id, key: draft.key, name: draft.name, label, width, degree: 0, draft };
    byKey.set(draft.key, node); nodes.push(node);
  }
  const links: GraphLink[] = [];
  const pairs = new Map<string, GraphLink[]>();
  for (const draft of drafts) {
    const rel = draft.relation;
    if (draft.kind !== 'relation' || !rel) continue;
    const from = byKey.get(rel.from), to = byKey.get(rel.to);
    if (!from || !to || from === to) continue;
    const link: GraphLink = { id: draft.id, label: rel.label, source: from.id, target: to.id, lane: 0, lanes: 1, draft };
    from.degree++; to.degree++;
    const pair = [from.id, to.id].sort().join('|');
    pairs.set(pair, [...(pairs.get(pair) ?? []), link]);
    links.push(link);
  }
  for (const group of pairs.values()) group.forEach((link, i) => { link.lane = i; link.lanes = group.length; });
  return { nodes, links };
}

const endpoint = (end: string | GraphNode) => (typeof end === 'string' ? undefined : end);
/** Point where the line towards (tx,ty) leaves a node's rounded box, so arrows stop at the border. */
function boxExit(n: GraphNode, tx: number, ty: number) {
  const x = n.x ?? 0, y = n.y ?? 0, dx = tx - x, dy = ty - y, hw = n.width / 2 + 3, hh = 19;
  if (!dx && !dy) return { x, y };
  const s = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  return { x: x + dx * s, y: y + dy * s };
}
function linkGeometry(l: GraphLink) {
  const s = endpoint(l.source), t = endpoint(l.target);
  if (!s || !t) return { d: '', mx: 0, my: 0 };
  const sx = s.x ?? 0, sy = s.y ?? 0, tx = t.x ?? 0, ty = t.y ?? 0;
  const len = Math.hypot(tx - sx, ty - sy) || 1;
  const bend = (l.lane - (l.lanes - 1) / 2) * 46 * (s.id < t.id ? 1 : -1);
  const cx = (sx + tx) / 2 + (-(ty - sy) / len) * bend, cy = (sy + ty) / 2 + ((tx - sx) / len) * bend;
  const a = boxExit(s, cx, cy), b = boxExit(t, cx, cy);
  return { d: `M${a.x},${a.y} Q${cx},${cy} ${b.x},${b.y}`, mx: (a.x + 2 * cx + b.x) / 4, my: (a.y + 2 * cy + b.y) / 4 };
}

type Scope = 'shared' | 'personal';

export function OntologyGraphView({ shared, personal = [], height = 560 }: { shared: OntologyDraft[]; personal?: OntologyDraft[]; height?: number }) {
  const t = useT(TEXT);
  const sharedGraph = useMemo(() => buildOntologyGraph(shared), [shared]);
  const personalGraph = useMemo(() => buildOntologyGraph(personal), [personal]);
  const [scope, setScope] = useState<Scope>(() => (sharedGraph.nodes.length || !personalGraph.nodes.length ? 'shared' : 'personal'));
  const graph = scope === 'shared' ? sharedGraph : personalGraph;
  const [selected, setSelected] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const zoomRef = useRef<{ zoom: d3.ZoomBehavior<SVGSVGElement, unknown>; fit: () => void } | null>(null);
  const selectRef = useRef(setSelected);
  selectRef.current = setSelected;

  useEffect(() => { setSelected(null); }, [scope]);

  // Build the simulation once per graph; selection changes only restyle (next effect).
  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl || !graph.nodes.length) return;
    const nodes = graph.nodes.map(n => ({ ...n }));
    const byId = new Map(nodes.map(n => [n.id, n]));
    const links = graph.links.map(l => ({ ...l, source: byId.get(l.source as string) ?? (l.source as GraphNode), target: byId.get((typeof l.target === 'string' ? l.target : l.target.id)) ?? (l.target as GraphNode) }));
    const rect = svgEl.getBoundingClientRect();
    // Measure the canvas: CSS shrinks it on phones, so the prop height is only the desktop default.
    const w = rect.width || 800, h = rect.height || height;
    const svg = d3.select(svgEl);
    svg.selectAll('*').remove();
    const defs = svg.append('defs');
    for (const [id, cls] of [['onto-arrow', ''], ['onto-arrow-active', 'is-active']] as const) {
      defs.append('marker').attr('id', id).attr('viewBox', '0 0 10 10').attr('refX', 9).attr('refY', 5)
        .attr('markerWidth', 8).attr('markerHeight', 8).attr('orient', 'auto-start-reverse')
        .append('path').attr('d', 'M0,0 L10,5 L0,10 z').attr('class', `onto-arrowhead ${cls}`);
    }
    const root = svg.append('g').attr('class', 'onto-root');
    const linkSel = root.append('g').selectAll<SVGGElement, GraphLink>('g').data(links).join('g').attr('class', 'onto-link')
      .on('click', (event: MouseEvent, l) => { event.stopPropagation(); selectRef.current(l.id); });
    linkSel.append('path').attr('class', 'onto-link-hit');
    linkSel.append('path').attr('class', 'onto-link-line').attr('marker-end', 'url(#onto-arrow)');
    const labelSel = linkSel.append('g').attr('class', 'onto-link-label');
    labelSel.append('rect').attr('rx', 5).attr('height', 20);
    labelSel.append('text').attr('dy', '0.35em').attr('text-anchor', 'middle').text(l => fitLabel(l.label, 120).label);
    labelSel.each(function () {
      const text = (this as SVGGElement).querySelector('text') as SVGTextElement;
      const bw = (text.getComputedTextLength?.() || 60) + 12;
      d3.select(this).select('rect').attr('x', -bw / 2).attr('y', -10).attr('width', bw);
    });

    const nodeSel = root.append('g').selectAll<SVGGElement, GraphNode>('g').data(nodes).join('g').attr('class', 'onto-node')
      .on('click', (event: MouseEvent, n) => { event.stopPropagation(); selectRef.current(n.id); });
    nodeSel.append('rect').attr('x', n => -n.width / 2).attr('y', -18).attr('width', n => n.width).attr('height', 36).attr('rx', 10);
    nodeSel.append('circle').attr('cx', n => -n.width / 2 + 13).attr('r', 4);
    nodeSel.append('text').attr('x', 7).attr('dy', '0.35em').attr('text-anchor', 'middle').text(n => n.label);
    nodeSel.append('title').text(n => n.name);

    const sim = d3.forceSimulation<GraphNode>(nodes)
      .force('link', d3.forceLink<GraphNode, GraphLink>(links).id(n => n.id).distance(l => 150 + ((endpoint(l.source)?.width ?? 0) + (endpoint(l.target)?.width ?? 0)) / 2.4).strength(0.7))
      .force('charge', d3.forceManyBody().strength(-1100).distanceMax(900))
      .force('collide', d3.forceCollide<GraphNode>().radius(n => n.width / 2 + 30).strength(0.9))
      .force('x', d3.forceX(w / 2).strength(0.015)).force('y', d3.forceY(h / 2).strength(0.14));

    const tick = () => {
      linkSel.each(function (l) {
        const g = linkGeometry(l), sel = d3.select(this);
        sel.selectAll('path').attr('d', g.d);
        sel.select('.onto-link-label').attr('transform', `translate(${g.mx},${g.my})`);
      });
      nodeSel.attr('transform', n => `translate(${n.x ?? 0},${n.y ?? 0})`);
    };
    sim.on('tick', tick);

    const zoom = d3.zoom<SVGSVGElement, unknown>().scaleExtent([0.18, 3])
      .filter(event => !event.button && (event.type !== 'wheel' || event.ctrlKey || event.metaKey) &&
        (event.type !== 'touchstart' || event.touches.length > 1))
      .on('zoom', event => root.attr('transform', event.transform.toString()));
    svg.call(zoom).on('dblclick.zoom', null).on('click', () => selectRef.current(null));
    const fit = () => {
      const xs = nodes.flatMap(n => [(n.x ?? 0) - n.width / 2, (n.x ?? 0) + n.width / 2]), ys = nodes.flatMap(n => [(n.y ?? 0) - 20, (n.y ?? 0) + 20]);
      const box = svgEl.getBoundingClientRect(), cw = box.width || w, ch = (box.height || h) - 24;
      const padding = cw < 480 ? 18 : 30;
      const [x0, x1] = [Math.min(...xs) - padding, Math.max(...xs) + padding];
      const [y0, y1] = [Math.min(...ys) - padding, Math.max(...ys) + padding];
      const k = Math.min(1.4, cw / (x1 - x0), ch / (y1 - y0));
      const transform = d3.zoomIdentity.translate(cw / 2 - k * (x0 + x1) / 2, ch / 2 - k * (y0 + y1) / 2).scale(k);
      svg.interrupt().call(zoom.transform, transform);
    };
    zoomRef.current = { zoom, fit };
    const resize = new ResizeObserver(fit);
    resize.observe(svgEl);

    nodeSel.call(d3.drag<SVGGElement, GraphNode>()
      .on('start', (e, n) => { if (!e.active) sim.alphaTarget(0.25).restart(); n.fx = n.x; n.fy = n.y; })
      .on('drag', (e, n) => { n.fx = e.x; n.fy = e.y; })
      .on('end', (e, n) => { if (!e.active) sim.alphaTarget(0); n.fx = null; n.fy = null; }));

    // Settle quickly so the first frame is already readable, then let it relax.
    for (let i = 0; i < 300; i++) sim.tick();
    tick(); fit();
    return () => { resize.disconnect(); sim.stop(); svg.interrupt().on('.zoom', null); zoomRef.current = null; };
  }, [graph, height]);

  // Highlight the selection and its neighbourhood.
  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;
    const svg = d3.select(svgEl);
    const link = graph.links.find(l => l.id === selected);
    const near = new Set<string>();
    if (link) { near.add(typeof link.source === 'string' ? link.source : link.source.id); near.add(typeof link.target === 'string' ? link.target : link.target.id); }
    else if (selected) {
      near.add(selected);
      for (const l of graph.links) {
        const s = typeof l.source === 'string' ? l.source : l.source.id, tg = typeof l.target === 'string' ? l.target : l.target.id;
        if (s === selected || tg === selected) { near.add(s); near.add(tg); }
      }
    }
    const touches = (l: GraphLink) => {
      const s = endpoint(l.source)?.id, tg = endpoint(l.target)?.id;
      return link ? l.id === link.id : !!selected && (s === selected || tg === selected);
    };
    svg.classed('has-selection', !!selected);
    svg.selectAll<SVGGElement, GraphNode>('.onto-node').classed('is-selected', n => n.id === selected).classed('is-near', n => near.has(n.id));
    svg.selectAll<SVGGElement, GraphLink>('.onto-link').classed('is-active', touches)
      .select('.onto-link-line').attr('marker-end', l => (touches(l) ? 'url(#onto-arrow-active)' : 'url(#onto-arrow)'));
  }, [selected, graph]);

  const nodeById = new Map(graph.nodes.map(n => [n.id, n]));
  const nodeOf = (end: string | GraphNode) => nodeById.get(typeof end === 'string' ? end : end.id);
  const selNode = selected ? nodeById.get(selected) : undefined;
  const selLink = selected ? graph.links.find(l => l.id === selected) : undefined;
  const nodeLinks = selNode ? graph.links.filter(l => nodeOf(l.source)?.id === selNode.id || nodeOf(l.target)?.id === selNode.id) : [];
  const zoomBy = (k: number) => { const z = zoomRef.current; if (svgRef.current && z) d3.select(svgRef.current).transition().duration(200).call(z.zoom.scaleBy, k); };

  if (!sharedGraph.nodes.length && !personalGraph.nodes.length) {
    return <section className="onto-empty" aria-label={t('canvas')}>
      <h3>{t('emptyTitle')}</h3>
      <p className="helper">{t('emptyBody')}</p>
      <a className="btn" href="#knowledge?view=analysis">{t('openAnalysis')}</a>
    </section>;
  }

  const sources = (selNode?.draft ?? selLink?.draft)?.evidence ?? [];
  return <section className="onto" aria-label={t('canvas')}>
    <header className="onto-bar">
      {sharedGraph.nodes.length && personalGraph.nodes.length ? <div className="onto-scope" role="tablist" aria-label={t('canvas')}>
        {(['shared', 'personal'] as const).map(s => <button key={s} type="button" role="tab" aria-selected={scope === s} onClick={() => setScope(s)}>
          {t(s)} <span>{(s === 'shared' ? sharedGraph : personalGraph).nodes.length}</span>
        </button>)}
      </div> : <strong className="onto-scope-label">{t(scope)}</strong>}
      <span className="onto-summary">{t('summary', { objects: graph.nodes.length, relations: graph.links.length })}</span>
      <div className="onto-tools">
        <button type="button" className="onto-icon" aria-label={t('zoomOut')} title={t('zoomOut')} onClick={() => zoomBy(1 / 1.3)}>−</button>
        <button type="button" className="onto-icon" aria-label={t('zoomIn')} title={t('zoomIn')} onClick={() => zoomBy(1.3)}>+</button>
        <button type="button" className="onto-icon onto-fit" onClick={() => zoomRef.current?.fit()}>{t('fit')}</button>
      </div>
    </header>
    {scope === 'personal' ? <p className="onto-note">{t('personalNote')}</p> : null}
    <div className="onto-body">
      <div className="onto-canvas">
        <svg ref={svgRef} role="img" aria-label={`${t('canvas')}: ${t('summary', { objects: graph.nodes.length, relations: graph.links.length })}`} style={{ height }} />
        <p className="onto-hint">{t('hint')}</p>
      </div>
      <aside className="onto-panel" aria-live="polite">
        {selNode || selLink ? <>
          <button type="button" className="onto-back" onClick={() => setSelected(null)}>← {t('back')}</button>
          <span className="onto-kind">{t(selNode ? 'object' : 'relation')}</span>
          {selLink ? <h3 className="onto-rel-title">
            <button type="button" onClick={() => setSelected(nodeOf(selLink.source)?.id ?? null)}>{nodeOf(selLink.source)?.name}</button>
            <span>→ {selLink.label} →</span>
            <button type="button" onClick={() => setSelected(nodeOf(selLink.target)?.id ?? null)}>{nodeOf(selLink.target)?.name}</button>
          </h3> : <h3>{selNode!.name}</h3>}
          {(selNode?.draft ?? selLink?.draft)?.description ? <p className="onto-desc">{(selNode?.draft ?? selLink!.draft).description}</p> : null}
          {selNode ? <div className="onto-section">
            <h4>{t('relations', { n: nodeLinks.length })}</h4>
            {nodeLinks.length ? <ul className="onto-rels">{nodeLinks.map(l => {
              const out = nodeOf(l.source)?.id === selNode.id, other = nodeOf(out ? l.target : l.source);
              return <li key={l.id}><button type="button" onClick={() => setSelected(l.id)}>
                <span className="onto-dir">{out ? '→' : '←'}</span><span>{l.label}</span><strong>{other?.name}</strong>
              </button></li>;
            })}</ul> : <p className="helper">{t('noRelations')}</p>}
          </div> : null}
          <div className="onto-section">
            <h4>{t('sources', { n: sources.length })}</h4>
            {sources.length ? <ul className="onto-sources">{sources.map((e, i) => <li key={i}><code>{e.locator}</code><q>{e.quote}</q></li>)}</ul>
              : <p className="helper">{t('noSources')}</p>}
          </div>
        </> : <>
          <h4>{t('objects')}</h4>
          <ul className="onto-list">{[...graph.nodes].sort((a, b) => b.degree - a.degree || a.name.localeCompare(b.name)).map(n => <li key={n.id}>
            <button type="button" onClick={() => setSelected(n.id)}><span>{n.name}</span><small>{n.degree || t('isolated')}</small></button>
          </li>)}</ul>
        </>}
      </aside>
    </div>
  </section>;
}
