import { useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import { useT } from '../i18n';
import './OntologyGraphView.css';

/**
 * Ontology = concrete entities analysis found (objects, rules, processes, employees, tools, source documents)
 * and the directed relations between them. Edges come from analysed object relations, employee tool/SOP
 * assignments, and evidence locators — never invented. Company files and MCP drafts share one tenant graph.
 */
export interface OntologyEvidence { locator: string; quote: string; sourceId?: string; version?: string; retrievedAt?: string }
export interface OntologyDraft {
  id: string; key: string; kind: string; name: string; description: string;
  evidence: OntologyEvidence[]; relation?: { from: string; to: string; label: string };
  assignment?: { tools: string[]; sops: string[] };
  recordedAt?: string; effectiveFrom?: string; effectiveTo?: string;
}
export type NodeType = 'company' | 'process' | 'rule' | 'source' | 'employee' | 'tool' | 'object';
export interface GraphNode extends d3.SimulationNodeDatum {
  id: string; key: string; name: string; label: string; type: NodeType; typeLabel: string; width: number; degree: number; draft: OntologyDraft;
}
export interface GraphLink extends d3.SimulationLinkDatum<GraphNode> { id: string; label: string; source: string | GraphNode; target: string | GraphNode; lane: number; lanes: number; draft: OntologyDraft }

const TEXT = {
  en: {
    all: 'All sources', shared: 'Company sources', personal: 'My MCP sources', summary: '{objects} entities · {relations} relationships',
    emptyTitle: 'No entities yet',
    emptyBody: 'Confirm materials in Company knowledge and run an analysis. Objects, roles, tools, processes and source documents it finds are drawn here with their sources.',
    openAnalysis: 'Open knowledge analysis',
    zoomIn: 'Zoom in', zoomOut: 'Zoom out', fit: 'Fit to view', canvas: 'Ontology graph',
    hint: 'Drag to move · select an entity to see identity, time and sources',
    objects: 'Entities', object: 'Business object', relation: 'Relationship', relations: 'Relationships ({n})',
    noRelations: 'No relationship found for this entity yet.', sources: 'Sources ({n})', noSources: 'No locatable source.',
    personalNote: 'Only you can see drafts from your MCP sources.', back: 'All entities', isolated: 'not linked',
    type_company: 'Enterprise', type_process: 'Business process', type_rule: 'Rule', type_source: 'Source document',
    type_employee: 'Digital employee', type_tool: 'Tool', type_object: 'Business object',
    sourced: 'sourced from', uses: 'uses tool', assists: 'assists process',
    stableId: 'Stable entity ID', version: 'Source version', businessTime: 'Business date', recordedTime: 'Recorded',
    knownTime: 'Known to the platform by', notStated: 'not stated in the source',
    relTable: 'Related relationships', from: 'From', edge: 'Relationship', to: 'To',
  },
  zh: {
    all: '全部来源', shared: '企业资料', personal: '我的 MCP 来源', summary: '{objects} 个实体 · {relations} 条关系',
    emptyTitle: '还没有实体',
    emptyBody: '先在企业知识里确认资料并运行分析。分析找到的对象、岗位、工具、流程和来源文档会画在这里，并附上原文依据。',
    openAnalysis: '打开知识分析',
    zoomIn: '放大', zoomOut: '缩小', fit: '适配窗口', canvas: '本体关系图',
    hint: '拖动节点调整位置 · 选中实体查看标识、时间与依据',
    objects: '实体', object: '业务对象', relation: '关系', relations: '关系（{n}）',
    noRelations: '这个实体还没有找到关系。', sources: '依据（{n}）', noSources: '没有可定位的依据。',
    personalNote: '个人 MCP 来源的草案只有你能看到。', back: '全部实体', isolated: '未关联',
    type_company: '企业', type_process: '业务流程', type_rule: '规则', type_source: '来源文档',
    type_employee: '数字员工', type_tool: '工具', type_object: '业务对象',
    sourced: '来源于', uses: '使用工具', assists: '协助执行',
    stableId: '稳定实体 ID', version: '来源版本', businessTime: '业务时间', recordedTime: '记录时间',
    knownTime: '知识截至', notStated: '资料未写明',
    relTable: '与它有关的关系', from: '起点', edge: '关系', to: '终点',
  },
};

const NODE_KINDS = new Set(['object', 'employee', 'tool', 'sop', 'source', 'company']);
const DERIVED = { sourced: '__sourced', uses: '__uses', assists: '__assists' } as const;
const RULE = /必须|须|需要|需经|应当|不得|禁止|不超过|超过|以上|以下|上限|下限|阈值|审批|批准|must|shall|required?|requires|not allowed|threshold|approv|limit|exceed/i;

const charWidth = (ch: string) => (/[⺀-￿]/.test(ch) ? 16 : 8.8);
function fitLabel(name: string, max = 196): { label: string; width: number } {
  let width = 0, label = '';
  for (const ch of name) {
    if (width + charWidth(ch) > max) return { label: `${label}…`, width: width + 12 + 50 };
    width += charWidth(ch); label += ch;
  }
  return { label, width: Math.max(width + 50, 96) };
}

export function nodeTypeOf(draft: OntologyDraft): NodeType {
  if (draft.kind === 'employee') return 'employee';
  if (draft.kind === 'tool') return 'tool';
  if (draft.kind === 'sop') return 'process';
  if (draft.kind === 'source') return 'source';
  if (draft.kind === 'company') return 'company';
  if (RULE.test(`${draft.name} ${draft.description}`)) return 'rule';
  return 'object';
}

function sourceKey(e: OntologyEvidence) {
  return `src:${e.sourceId || e.locator}:${e.version || ''}`;
}

/** Adds source-document nodes and employee→tool / employee→process edges from real assignment + evidence. */
export function enrichOntologyDrafts(drafts: OntologyDraft[], companyName?: string): OntologyDraft[] {
  const extra: OntologyDraft[] = [];
  const name = companyName?.trim();
  if (name) {
    extra.push({ id: 'sys:company', key: 'sys:company', kind: 'company', name, description: '', evidence: [] });
  }
  const sources = new Map<string, OntologyDraft>();
  const keys = new Set(drafts.filter(d => NODE_KINDS.has(d.kind) || d.kind === 'object').map(d => d.key));
  for (const draft of drafts) {
    if (!NODE_KINDS.has(draft.kind) && draft.kind !== 'relation') continue;
    for (const e of draft.evidence) {
      const key = sourceKey(e);
      if (!sources.has(key)) {
        sources.set(key, { id: key, key, kind: 'source', name: e.locator, description: '', evidence: [e] });
      }
      extra.push({
        id: `from:${draft.id}:${key}`, key: `from:${draft.key}:${key}`, kind: 'relation', name: DERIVED.sourced,
        description: '', evidence: [e], relation: { from: draft.key, to: key, label: DERIVED.sourced },
      });
    }
    if (draft.kind === 'employee' && draft.assignment) {
      for (const tool of draft.assignment.tools) {
        if (!keys.has(tool)) continue;
        extra.push({
          id: `use:${draft.key}:${tool}`, key: `use:${draft.key}:${tool}`, kind: 'relation', name: DERIVED.uses,
          description: '', evidence: draft.evidence, relation: { from: draft.key, to: tool, label: DERIVED.uses },
        });
      }
      for (const sop of draft.assignment.sops) {
        if (!keys.has(sop)) continue;
        extra.push({
          id: `sop:${draft.key}:${sop}`, key: `sop:${draft.key}:${sop}`, kind: 'relation', name: DERIVED.assists,
          description: '', evidence: draft.evidence, relation: { from: draft.key, to: sop, label: DERIVED.assists },
        });
      }
    }
  }
  return [...drafts, ...sources.values(), ...extra];
}

/** Pure: typed entities become nodes; relations whose two ends exist become links; parallel links get lanes. */
export function buildOntologyGraph(drafts: OntologyDraft[], companyName?: string): { nodes: GraphNode[]; links: GraphLink[] } {
  const enriched = enrichOntologyDrafts(drafts, companyName);
  const nodes: GraphNode[] = [];
  const byKey = new Map<string, GraphNode>();
  const ordered = [...enriched.filter(d => d.kind === 'company'), ...enriched.filter(d => d.kind !== 'company')];
  for (const draft of ordered) {
    if (!NODE_KINDS.has(draft.kind)) continue;
    const existing = byKey.get(draft.key);
    if (existing) {
      existing.draft = {
        ...existing.draft,
        description: existing.draft.description || draft.description,
        evidence: [...existing.draft.evidence, ...draft.evidence],
      };
      continue;
    }
    const { label, width } = fitLabel(draft.name);
    const type = nodeTypeOf(draft);
    const node: GraphNode = { id: draft.id, key: draft.key, name: draft.name, label, type, typeLabel: type, width, degree: 0, draft };
    byKey.set(draft.key, node); nodes.push(node);
  }
  const links: GraphLink[] = [];
  const pairs = new Map<string, GraphLink[]>();
  for (const draft of enriched) {
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
function boxExit(n: GraphNode, tx: number, ty: number) {
  const x = n.x ?? 0, y = n.y ?? 0, dx = tx - x, dy = ty - y, hw = n.width / 2 + 3, hh = 32;
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

type Scope = 'all' | 'shared' | 'personal';
export function OntologyGraphView({ shared, personal = [], height = 560, time, companyName }: {
  shared: OntologyDraft[]; personal?: OntologyDraft[]; height?: number; time?: { at: string; known: string }; companyName?: string;
}) {
  const t = useT(TEXT);
  const unifiedGraph = useMemo(() => buildOntologyGraph([...shared, ...personal], companyName), [shared, personal, companyName]);
  const sharedGraph = useMemo(() => buildOntologyGraph(shared, companyName), [shared, companyName]);
  const personalGraph = useMemo(() => buildOntologyGraph(personal), [personal]);
  const [scope, setScope] = useState<Scope>('all');
  const graph = scope === 'shared' ? sharedGraph : scope === 'personal' ? personalGraph : unifiedGraph;
  const [selected, setSelected] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const zoomRef = useRef<{ zoom: d3.ZoomBehavior<SVGSVGElement, unknown>; fit: () => void } | null>(null);
  const selectRef = useRef(setSelected);
  selectRef.current = setSelected;
  const edgeLabel = (label: string) => (label === DERIVED.sourced ? t('sourced') : label === DERIVED.uses ? t('uses') : label === DERIVED.assists ? t('assists') : label);

  useEffect(() => { setSelected(null); }, [scope]);
  const showFilters = sharedGraph.nodes.length > 0 && personalGraph.nodes.length > 0;

  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl || !graph.nodes.length) return;
    const nodes = graph.nodes.map(n => ({ ...n }));
    const byId = new Map(nodes.map(n => [n.id, n]));
    const links = graph.links.map(l => ({ ...l, source: byId.get(l.source as string) ?? (l.source as GraphNode), target: byId.get((typeof l.target === 'string' ? l.target : l.target.id)) ?? (l.target as GraphNode) }));
    const rect = svgEl.getBoundingClientRect();
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
    labelSel.append('rect').attr('rx', 6).attr('height', 24);
    labelSel.append('text').attr('dy', '0.35em').attr('text-anchor', 'middle').text(l => fitLabel(edgeLabel(l.label), 120).label);
    labelSel.each(function () {
      const text = (this as SVGGElement).querySelector('text') as SVGTextElement;
      const bw = (text.getComputedTextLength?.() || 60) + 12;
      d3.select(this).select('rect').attr('x', -bw / 2).attr('y', -12).attr('width', bw);
    });

    const nodeSel = root.append('g').selectAll<SVGGElement, GraphNode>('g').data(nodes).join('g').attr('class', n => `onto-node onto-type-${n.type}`)
      .attr('tabindex', 0).attr('role', 'button').attr('aria-label', n => `${n.name}, ${t(`type_${n.type}` as 'type_object')}`)
      .on('click', (event: MouseEvent, n) => { event.stopPropagation(); selectRef.current(n.id); })
      .on('keydown', (event: KeyboardEvent, n) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectRef.current(n.id); } });
    nodeSel.append('rect').attr('x', n => -n.width / 2).attr('y', -32).attr('width', n => n.width).attr('height', 64).attr('rx', 8);
    nodeSel.append('text').attr('class', 'onto-node-title').attr('y', -6).attr('text-anchor', 'middle').text(n => n.label);
    nodeSel.append('text').attr('class', 'onto-node-type').attr('y', 16).attr('text-anchor', 'middle').text(n => t(`type_${n.type}` as 'type_object'));
    nodeSel.append('title').text(n => `${n.name} · ${t(`type_${n.type}` as 'type_object')}`);

    const sim = d3.forceSimulation<GraphNode>(nodes)
      .force('link', d3.forceLink<GraphNode, GraphLink>(links).id(n => n.id).distance(l => 160 + ((endpoint(l.source)?.width ?? 0) + (endpoint(l.target)?.width ?? 0)) / 2.4).strength(0.7))
      .force('charge', d3.forceManyBody().strength(-1100).distanceMax(900))
      .force('collide', d3.forceCollide<GraphNode>().radius(n => n.width / 2 + 36).strength(0.9))
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
      const xs = nodes.flatMap(n => [(n.x ?? 0) - n.width / 2, (n.x ?? 0) + n.width / 2]), ys = nodes.flatMap(n => [(n.y ?? 0) - 32, (n.y ?? 0) + 32]);
      const box = svgEl.getBoundingClientRect(), cw = box.width || w, ch = (box.height || h) - 24;
      const padding = cw < 480 ? 18 : 30;
      const [x0, x1] = [Math.min(...xs) - padding, Math.max(...xs) + padding];
      const [y0, y1] = [Math.min(...ys) - padding, Math.max(...ys) + padding];
      const k = Math.min(1.6, cw / Math.max(x1 - x0, 1), ch / Math.max(y1 - y0, 1));
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

    for (let i = 0; i < 300; i++) sim.tick();
    tick(); fit();
    return () => { resize.disconnect(); sim.stop(); svg.interrupt().on('.zoom', null); zoomRef.current = null; };
  }, [graph, height, t]);

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

  if (!unifiedGraph.nodes.length) {
    return <section className="onto-empty" aria-label={t('canvas')}>
      <h3>{t('emptyTitle')}</h3>
      <p className="helper">{t('emptyBody')}</p>
      <a className="btn" href="#knowledge?view=analysis">{t('openAnalysis')}</a>
    </section>;
  }

  const draft = selNode?.draft ?? selLink?.draft;
  const sources = draft?.evidence ?? [];
  const recorded = draft?.recordedAt?.slice(0, 10);
  const business = draft?.effectiveFrom && draft.effectiveTo ? `${draft.effectiveFrom} – ${draft.effectiveTo}` : (draft?.effectiveFrom || draft?.effectiveTo);
  const version = sources.map(e => e.version).find(Boolean);
  return <section className="onto" aria-label={t('canvas')}>
    <header className="onto-bar">
      {showFilters ? <div className="onto-scope" role="tablist" aria-label={t('canvas')}>
        {(['all', 'shared', 'personal'] as const).map(s => <button key={s} type="button" role="tab" aria-selected={scope === s} onClick={() => setScope(s)}>
          {t(s)} <span>{(s === 'all' ? unifiedGraph : s === 'shared' ? sharedGraph : personalGraph).nodes.length}</span>
        </button>)}
      </div> : <strong className="onto-scope-label">{t('all')}</strong>}
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
        <svg ref={svgRef} role="img" aria-label={`${t('canvas')}: ${t('summary', { objects: graph.nodes.length, relations: graph.links.length })}`} />
        <p className="onto-hint">{t('hint')}</p>
      </div>
      <aside className="onto-panel" aria-live="polite">
        {selNode || selLink ? <>
          <button type="button" className="onto-back" onClick={() => setSelected(null)}>← {t('back')}</button>
          <span className="onto-kind">{selNode ? t(`type_${selNode.type}` as 'type_object') : t('relation')}</span>
          {selLink ? <h3 className="onto-rel-title">
            <button type="button" onClick={() => setSelected(nodeOf(selLink.source)?.id ?? null)}>{nodeOf(selLink.source)?.name}</button>
            <span>→ {edgeLabel(selLink.label)} →</span>
            <button type="button" onClick={() => setSelected(nodeOf(selLink.target)?.id ?? null)}>{nodeOf(selLink.target)?.name}</button>
          </h3> : <h3>{selNode!.name}</h3>}
          {draft?.description ? <p className="onto-desc">{draft.description}</p> : null}
          <dl className="onto-meta">
            <dt>{t('stableId')}</dt><dd><code>{draft?.id ?? selected}</code></dd>
            <dt>{t('version')}</dt><dd>{version || t('notStated')}</dd>
            <dt>{t('businessTime')}</dt><dd>{business || t('notStated')}</dd>
            <dt>{t('recordedTime')}</dt><dd>{recorded || t('notStated')}</dd>
            {time ? <><dt>{t('knownTime')}</dt><dd>{time.known}</dd></> : null}
          </dl>
          {selNode ? <div className="onto-section">
            <h4 id="onto-rel-heading">{t('relTable')}</h4>
            {nodeLinks.length ? <table className="onto-rel-table" aria-labelledby="onto-rel-heading">
              <thead><tr><th>{t('from')}</th><th>{t('edge')}</th><th>{t('to')}</th></tr></thead>
              <tbody>{nodeLinks.map(l => {
                const from = nodeOf(l.source), to = nodeOf(l.target);
                return <tr key={l.id}>
                  <td><button type="button" onClick={() => setSelected(from?.id ?? null)}>{from?.name}</button></td>
                  <td><button type="button" onClick={() => setSelected(l.id)}>{edgeLabel(l.label)}</button></td>
                  <td><button type="button" onClick={() => setSelected(to?.id ?? null)}>{to?.name}</button></td>
                </tr>;
              })}</tbody>
            </table> : <p className="helper">{t('noRelations')}</p>}
          </div> : null}
          <div className="onto-section">
            <h4>{t('sources', { n: sources.length })}</h4>
            {sources.length ? <ul className="onto-sources">{sources.map((e, i) => <li key={i}><code>{e.locator}</code><q>{e.quote}</q></li>)}</ul>
              : <p className="helper">{t('noSources')}</p>}
          </div>
        </> : <>
          <h4>{t('objects')}</h4>
          <ul className="onto-list">{[...graph.nodes].sort((a, b) => b.degree - a.degree || a.name.localeCompare(b.name)).map(n => <li key={n.id}>
            <button type="button" onClick={() => setSelected(n.id)}><span>{n.name}</span><small>{t(`type_${n.type}` as 'type_object')}</small></button>
          </li>)}</ul>
        </>}
      </aside>
    </div>
  </section>;
}
