import { useEffect, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';
import { useT } from '../i18n';
import { groupEvidence, readableQuote, sourceGroupKey, sourceLabel } from './evidence';
import './OntologyGraphView.css';

/**
 * One tenant ontology: every analysed draft — from company files or the user's own MCP sources — is knowledge
 * in the same graph. Entities carry a type, source-backed attributes and directed relations. Where a fact came
 * from is a citation on the entity, not a node of its own (unless the reader turns the source layer on).
 */
export interface OntologyEvidence { locator: string; quote: string; sourceId?: string; version?: string; retrievedAt?: string }
export interface OntologyAttribute { name: string; value: string; citation?: number }
export interface OntologyDraft {
  id: string; key: string; kind: string; name: string; description: string;
  evidence: OntologyEvidence[]; relation?: { from: string; to: string; label: string };
  assignment?: { tools: string[]; sops: string[] };
  attributes?: OntologyAttribute[]; ruleLike?: boolean; humanLocked?: boolean;
  /** Drafts from the viewer's own MCP connections: shown in the same graph, marked as visible only to them. */
  privateMcp?: boolean;
  recordedAt?: string; effectiveFrom?: string; effectiveTo?: string;
}
export type NodeType = 'tool' | 'employee' | 'process' | 'object' | 'rule' | 'source';
export const LANES: NodeType[] = ['tool', 'employee', 'process', 'object', 'rule', 'source'];
export interface GraphNode extends d3.SimulationNodeDatum {
  id: string; key: string; name: string; type: NodeType; degree: number; draft: OntologyDraft; lines: string[];
}
export interface GraphLink extends d3.SimulationLinkDatum<GraphNode> {
  id: string; label: string; source: string | GraphNode; target: string | GraphNode; lane: number; lanes: number; draft: OntologyDraft; derived: boolean;
}

const TEXT = {
  en: {
    title: 'Ontology', titleOf: '{company} ontology', summary: '{objects} entities · {relations} relationships',
    emptyTitle: 'No entities yet',
    emptyBody: 'Confirm materials in Company knowledge and run an analysis. Objects, rules, roles, tools and processes it finds are drawn here with their attributes and sources.',
    openAnalysis: 'Open knowledge analysis',
    zoomIn: 'Zoom in', zoomOut: 'Zoom out', fit: 'Fit', canvas: 'Ontology graph', search: 'Find an entity',
    showSources: 'Source layer', typeFilter: 'Entity types',
    hint: 'Hover to trace · click for details · Ctrl + scroll to zoom',
    entities: 'Entities', relation: 'Relationship',
    attributes: 'Attributes', noAttributes: 'No attribute extracted yet. Re-run the analysis to extract properties such as amounts, limits and owners.',
    relations: 'Relationships', noRelations: 'Not linked to another entity yet.',
    sources: 'Sources', noSources: 'No locatable source.', citations: '{n} passages',
    back: 'All entities', more: 'Show more', less: 'Show less',
    type_process: 'Process', type_rule: 'Rule', type_source: 'Source', type_employee: 'Digital employee', type_tool: 'Tool', type_object: 'Business object',
    sourced: 'sourced from', uses: 'uses', assists: 'takes part in',
    pending: 'Pending review', confirmed: 'Confirmed', private: 'Only you', privateNote: 'From your own MCP connection — only you can see it until it is shared.',
    time: 'Time', effective: 'In effect {range}', effectiveUnknown: 'Effective date not stated', recorded: 'recorded {date}', known: 'Known by {date}',
    technical: 'Technical details', stableId: 'Stable ID', version: 'Source version', notStated: 'not stated',
    cite: 'Source {n}',
  },
  zh: {
    title: '本体', titleOf: '{company} 的本体', summary: '{objects} 个实体 · {relations} 条关系',
    emptyTitle: '还没有实体',
    emptyBody: '先在企业知识里确认资料并运行分析。分析找到的对象、规则、岗位、工具和流程会画在这里，并附上属性与原文依据。',
    openAnalysis: '打开知识分析',
    zoomIn: '放大', zoomOut: '缩小', fit: '适配', canvas: '本体关系图', search: '查找实体',
    showSources: '来源图层', typeFilter: '实体类型',
    hint: '悬停追踪关系 · 点击查看详情 · Ctrl + 滚轮缩放',
    entities: '实体', relation: '关系',
    attributes: '属性', noAttributes: '还没有抽取到属性。重新运行分析即可抽取金额、比例、上限、负责人等属性。',
    relations: '关系', noRelations: '还没有和其他实体建立关系。',
    sources: '依据', noSources: '没有可定位的依据。', citations: '{n} 处',
    back: '全部实体', more: '展开', less: '收起',
    type_process: '流程', type_rule: '规则', type_source: '来源', type_employee: '数字员工', type_tool: '工具', type_object: '业务对象',
    sourced: '来源于', uses: '使用', assists: '参与',
    pending: '待审核', confirmed: '已确认', private: '仅自己', privateNote: '来自你个人的 MCP 连接，共享前只有你能看到。',
    time: '时间', effective: '生效 {range}', effectiveUnknown: '资料未写明生效时间', recorded: '记录于 {date}', known: '知识截至 {date}',
    technical: '技术信息', stableId: '稳定 ID', version: '来源版本', notStated: '未写明',
    cite: '依据 {n}',
  },
};
type TextKey = keyof typeof TEXT.en;

const ENTITY_KINDS = new Set(['object', 'employee', 'tool', 'sop']);
const DERIVED = { sourced: '__sourced', uses: '__uses', assists: '__assists' } as const;
/** Fallback for drafts analysed before the model returned a rule flag: only the name decides. */
const RULE_NAME = /规则|政策|制度|要求|阈值|上限|下限|审批|必须|不得|禁止|policy|rule|requirement|threshold|limit|approval|must/i;

export function nodeTypeOf(draft: Pick<OntologyDraft, 'kind' | 'name' | 'ruleLike'>): NodeType {
  if (draft.kind === 'employee') return 'employee';
  if (draft.kind === 'tool') return 'tool';
  if (draft.kind === 'sop') return 'process';
  if (draft.kind === 'source') return 'source';
  if (draft.ruleLike || RULE_NAME.test(draft.name)) return 'rule';
  return 'object';
}

const charWidth = (ch: string) => (/[⺀-￿]/.test(ch) ? 13 : 7);
/** Breaks a name into at most two lines under the node; the full name stays in the tooltip and panel. */
export function wrapLabel(name: string, max = 148): string[] {
  const lines: string[] = [];
  let line = '', width = 0;
  for (const ch of name) {
    const w = charWidth(ch);
    if (width + w > max) {
      if (lines.length === 1) return [lines[0]!, `${line.trimEnd()}…`];
      // Break at the last space, slash, dash, underscore or bracket so identifiers like mark_orders_in_transit stay readable.
      if (/[/—_-]/.test(ch) && lines.length === 0) { lines.push(`${line}${ch}`); line = ''; width = 0; continue; }
      const cut = /[\s(]/.test(ch) ? -1 : line.search(/[\s/—_(-][^\s/—_(-]*$/);
      if (cut > 4) {
        const sep = line[cut]!;
        const end = /\s/.test(sep) || sep === '(' ? cut : cut + 1;
        lines.push(line.slice(0, end).trimEnd()); line = line.slice(/\s/.test(sep) ? cut + 1 : end);
        width = [...line].reduce((s, c) => s + charWidth(c), 0);
      }
      else { lines.push(line.trimEnd()); line = ''; width = 0; }
      if (/\s/.test(ch) && !line) continue;
    }
    line += ch; width += w;
  }
  if (line.trim()) lines.push(line.trim());
  return lines.slice(0, 2);
}

/** Pure: entity drafts become typed nodes (merged by key); relations, role assignments and — optionally — sources become links. */
export function buildOntologyGraph(drafts: OntologyDraft[], options: { withSources?: boolean } = {}): { nodes: GraphNode[]; links: GraphLink[] } {
  const nodes: GraphNode[] = [];
  const byKey = new Map<string, GraphNode>();
  for (const draft of drafts) {
    if (!ENTITY_KINDS.has(draft.kind)) continue;
    const existing = byKey.get(draft.key);
    if (existing) {
      const prev = existing.draft;
      const offset = prev.evidence.length;
      const names = new Set((prev.attributes ?? []).map(a => a.name.toLowerCase()));
      existing.draft = {
        ...prev,
        description: prev.description || draft.description,
        evidence: [...prev.evidence, ...draft.evidence],
        attributes: [...(prev.attributes ?? []), ...(draft.attributes ?? []).filter(a => !names.has(a.name.toLowerCase()))
          .map(a => ({ ...a, citation: a.citation ? a.citation + offset : undefined }))],
        privateMcp: !!prev.privateMcp && !!draft.privateMcp,
        ruleLike: prev.ruleLike || draft.ruleLike,
        humanLocked: prev.humanLocked || draft.humanLocked,
      };
      existing.type = nodeTypeOf(existing.draft);
      continue;
    }
    const node: GraphNode = { id: draft.id, key: draft.key, name: draft.name, type: nodeTypeOf(draft), degree: 0, draft, lines: wrapLabel(draft.name) };
    byKey.set(draft.key, node); nodes.push(node);
  }

  const links: GraphLink[] = [];
  const seen = new Set<string>();
  const link = (id: string, from: GraphNode | undefined, to: GraphNode | undefined, label: string, draft: OntologyDraft, derived: boolean) => {
    if (!from || !to || from === to) return;
    const dedupe = `${from.id}|${label}|${to.id}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    from.degree++; to.degree++;
    links.push({ id, label, source: from.id, target: to.id, lane: 0, lanes: 1, draft, derived });
  };
  for (const draft of drafts) {
    if (draft.kind === 'relation' && draft.relation) link(draft.id, byKey.get(draft.relation.from), byKey.get(draft.relation.to), draft.relation.label, draft, false);
    if (draft.kind === 'employee' && draft.assignment) {
      const from = byKey.get(draft.key);
      for (const tool of draft.assignment.tools) link(`use:${draft.key}:${tool}`, from, byKey.get(tool), DERIVED.uses, draft, true);
      for (const sop of draft.assignment.sops) link(`sop:${draft.key}:${sop}`, from, byKey.get(sop), DERIVED.assists, draft, true);
    }
  }

  if (options.withSources) {
    const sources = new Map<string, GraphNode>();
    for (const node of [...nodes]) {
      for (const e of node.draft.evidence) {
        const key = `src:${sourceGroupKey(e)}`;
        let source = sources.get(key);
        if (!source) {
          const name = sourceLabel(e.locator);
          const draft: OntologyDraft = { id: key, key, kind: 'source', name, description: '', evidence: [] };
          source = { id: key, key, name, type: 'source', degree: 0, draft, lines: wrapLabel(name) };
          sources.set(key, source); nodes.push(source);
        }
        source.draft.evidence.push(e);
        link(`from:${node.id}:${key}`, node, source, DERIVED.sourced, { ...node.draft, evidence: [e] }, true);
      }
    }
  }

  const pairs = new Map<string, GraphLink[]>();
  for (const l of links) {
    const pair = [l.source, l.target].sort().join('|');
    pairs.set(pair, [...(pairs.get(pair) ?? []), l]);
  }
  for (const group of pairs.values()) group.forEach((l, i) => { l.lane = i; l.lanes = group.length; });
  return { nodes, links };
}

const radius = (n: GraphNode) => Math.min(9 + Math.sqrt(n.degree) * 3.2, 22);
const idOf = (end: string | GraphNode) => (typeof end === 'string' ? end : end.id);

/** Lanes run left→right; links between lanes are horizontal S-curves, links inside one lane bow outward. */
function linkPath(l: GraphLink) {
  const s = l.source as GraphNode, t = l.target as GraphNode;
  const sx = s.x ?? 0, sy = s.y ?? 0, tx = t.x ?? 0, ty = t.y ?? 0;
  const spread = (l.lane - (l.lanes - 1) / 2) * 18;
  let c1: [number, number], c2: [number, number];
  if (Math.abs(tx - sx) > 60) {
    const mx = (sx + tx) / 2;
    c1 = [mx, sy + spread]; c2 = [mx, ty + spread];
  } else {
    const bow = 46 + Math.abs(ty - sy) * 0.28 + spread;
    c1 = [sx + bow, sy]; c2 = [tx + bow, ty];
  }
  const trim = (px: number, py: number, cx: number, cy: number, r: number): [number, number] => {
    const dx = cx - px, dy = cy - py, len = Math.hypot(dx, dy) || 1;
    return [px + (dx / len) * r, py + (dy / len) * r];
  };
  const a = trim(sx, sy, c1[0], c1[1], radius(s) + 2), b = trim(tx, ty, c2[0], c2[1], radius(t) + 5);
  return {
    d: `M${a[0]},${a[1]} C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${b[0]},${b[1]}`,
    mx: (a[0] + 3 * c1[0] + 3 * c2[0] + b[0]) / 8, my: (a[1] + 3 * c1[1] + 3 * c2[1] + b[1]) / 8,
  };
}

function rangeText(d: OntologyDraft) {
  if (d.effectiveFrom && d.effectiveTo) return `${d.effectiveFrom} – ${d.effectiveTo}`;
  return d.effectiveFrom || d.effectiveTo;
}

export function OntologyGraphView({ drafts, time, companyName }: {
  drafts: OntologyDraft[]; time?: { at: string; known: string }; companyName?: string;
}) {
  const t = useT(TEXT);
  const [withSources, setWithSources] = useState(false);
  const [hidden, setHidden] = useState<Set<NodeType>>(() => new Set());
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [focusCite, setFocusCite] = useState<number | null>(null);
  const [descOpen, setDescOpen] = useState(false);
  const full = useMemo(() => buildOntologyGraph(drafts, { withSources }), [drafts, withSources]);
  const graph = useMemo(() => {
    if (!hidden.size) return full;
    const nodes = full.nodes.filter(n => !hidden.has(n.type));
    const ids = new Set(nodes.map(n => n.id));
    return { nodes, links: full.links.filter(l => ids.has(idOf(l.source)) && ids.has(idOf(l.target))) };
  }, [full, hidden]);
  const counts = useMemo(() => {
    const map = new Map<NodeType, number>();
    for (const n of full.nodes) map.set(n.type, (map.get(n.type) ?? 0) + 1);
    return map;
  }, [full]);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const zoomRef = useRef<{ zoom: d3.ZoomBehavior<SVGSVGElement, unknown>; fit: () => void } | null>(null);
  const selectRef = useRef(setSelected);
  selectRef.current = setSelected;
  const edgeLabel = (label: string) => (label === DERIVED.sourced ? t('sourced') : label === DERIVED.uses ? t('uses') : label === DERIVED.assists ? t('assists') : label);
  const typeName = (type: NodeType) => t(`type_${type}` as TextKey);

  useEffect(() => { setFocusCite(null); setDescOpen(false); }, [selected]);
  useEffect(() => { if (selected && !graph.nodes.some(n => n.id === selected) && !graph.links.some(l => l.id === selected)) setSelected(null); }, [graph, selected]);

  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl || !graph.nodes.length) return;
    const nodes = graph.nodes.map(n => ({ ...n }));
    const byId = new Map(nodes.map(n => [n.id, n]));
    const links = graph.links.map(l => ({ ...l, source: byId.get(idOf(l.source))!, target: byId.get(idOf(l.target))! }));
    const neighbors = new Map<string, Set<string>>(nodes.map(n => [n.id, new Set([n.id])]));
    for (const l of links) { neighbors.get(l.source.id)!.add(l.target.id); neighbors.get(l.target.id)!.add(l.source.id); }

    const lanes = LANES.filter(type => nodes.some(n => n.type === type));
    const laneW = 250;
    const laneX = new Map(lanes.map((type, i) => [type, (i + 0.5) * laneW]));
    const perLane = new Map<NodeType, GraphNode[]>();
    for (const n of [...nodes].sort((a, b) => b.degree - a.degree || a.name.localeCompare(b.name))) perLane.set(n.type, [...(perLane.get(n.type) ?? []), n]);
    // Busy lanes split into two staggered columns so the lane stays readable instead of becoming one tall stack.
    const targetX = new Map<string, number>();
    for (const [type, list] of perLane) {
      const split = list.length > 7;
      list.forEach((n, i) => {
        const x = laneX.get(type)! + (split ? (i % 2 ? 62 : -62) : 0);
        targetX.set(n.id, x);
        n.x = x; n.fx = x; n.y = (split ? Math.floor(i / 2) * 92 + (i % 2) * 46 : i * 92) - (split ? list.length / 4 : list.length / 2) * 92;
      });
    }

    const svg = d3.select(svgEl);
    svg.selectAll('*').remove();
    const defs = svg.append('defs');
    for (const [id, cls] of [['onto-arrow', ''], ['onto-arrow-active', 'is-active']] as const) {
      defs.append('marker').attr('id', id).attr('viewBox', '0 0 10 10').attr('refX', 8).attr('refY', 5)
        .attr('markerWidth', 6).attr('markerHeight', 6).attr('orient', 'auto-start-reverse')
        .append('path').attr('d', 'M0,1 L9,5 L0,9 z').attr('class', `onto-arrowhead ${cls}`);
    }
    const root = svg.append('g').attr('class', 'onto-root');
    const laneLayer = root.append('g').attr('class', 'onto-lanes');
    const linkSel = root.append('g').selectAll<SVGGElement, typeof links[number]>('g').data(links).join('g')
      .attr('class', l => `onto-link${l.derived ? ' is-derived' : ''}`)
      .on('click', (event: MouseEvent, l) => { event.stopPropagation(); selectRef.current(l.id); });
    linkSel.append('path').attr('class', 'onto-link-hit');
    linkSel.append('path').attr('class', 'onto-link-line').attr('marker-end', 'url(#onto-arrow)');
    const labelSel = linkSel.append('g').attr('class', 'onto-link-label');
    labelSel.append('rect').attr('rx', 9).attr('height', 18);
    labelSel.append('text').attr('dy', '0.35em').attr('text-anchor', 'middle').text(l => {
      const label = edgeLabel(l.label);
      return label.length > 24 ? `${label.slice(0, 23)}…` : label;
    });

    const hover = (id: string | null) => {
      const near = id ? neighbors.get(id)! : null;
      svg.classed('has-hover', !!id);
      nodeSel.classed('is-hover-near', n => !!near?.has(n.id));
      linkSel.classed('is-hover', l => !!id && (l.source.id === id || l.target.id === id));
    };
    const nodeSel = root.append('g').selectAll<SVGGElement, GraphNode>('g').data(nodes).join('g')
      .attr('class', n => `onto-node onto-type-${n.type}${n.draft.humanLocked ? ' is-confirmed' : ''}${n.draft.privateMcp ? ' is-private' : ''}${n.degree < 2 ? ' is-minor' : ''}`)
      .attr('tabindex', 0).attr('role', 'button').attr('aria-label', n => `${n.name}, ${typeName(n.type)}`)
      .on('click', (event: MouseEvent, n) => { event.stopPropagation(); selectRef.current(n.id); })
      .on('mouseenter', (_e, n) => hover(n.id)).on('mouseleave', () => hover(null))
      .on('focus', (_e, n) => hover(n.id)).on('blur', () => hover(null))
      .on('keydown', (event: KeyboardEvent, n) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectRef.current(n.id); } });
    nodeSel.append('circle').attr('class', 'onto-node-halo').attr('r', n => radius(n) + 6);
    nodeSel.append('circle').attr('class', 'onto-node-dot').attr('r', radius);
    nodeSel.filter(n => !!n.draft.privateMcp).append('circle').attr('class', 'onto-node-private').attr('r', n => radius(n) + 3.5);
    const text = nodeSel.append('text').attr('class', 'onto-node-label').attr('text-anchor', 'middle').attr('y', n => radius(n) + 15);
    text.selectAll('tspan').data(n => n.lines).join('tspan').attr('x', 0).attr('dy', (_l, i) => (i ? 15 : 0)).text(l => l);
    nodeSel.append('title').text(n => `${n.name} · ${typeName(n.type)}`);

    const sim = d3.forceSimulation<GraphNode>(nodes)
      .force('link', d3.forceLink<GraphNode, typeof links[number]>(links).id(n => n.id).distance(150).strength(0.08))
      .force('charge', d3.forceManyBody().strength(-180).distanceMax(320))
      .force('collide', d3.forceCollide<GraphNode>().radius(n => radius(n) + 34).strength(1))
      .force('x', d3.forceX<GraphNode>(n => targetX.get(n.id) ?? 0).strength(0.9))
      .force('y', d3.forceY(0).strength(0.035))
      .stop();
    for (let i = 0; i < 360; i++) sim.tick();

    const drawLanes = () => {
      laneLayer.selectAll('*').remove();
      const ys = nodes.map(n => n.y ?? 0);
      const top = Math.min(...ys) - 70, bottom = Math.max(...ys) + 70;
      for (const type of lanes) {
        const x = laneX.get(type)! - laneW / 2 + 8;
        const g = laneLayer.append('g').attr('class', `onto-lane onto-type-${type}`);
        g.append('rect').attr('x', x).attr('y', top).attr('width', laneW - 16).attr('height', bottom - top).attr('rx', 14);
        g.append('text').attr('x', x + 14).attr('y', top + 24).text(`${typeName(type)} · ${perLane.get(type)!.length}`);
      }
    };
    const tick = () => {
      linkSel.each(function (l) {
        const g = linkPath(l), sel = d3.select(this);
        sel.selectAll('path').attr('d', g.d);
        sel.select('.onto-link-label').attr('transform', `translate(${g.mx},${g.my})`);
      });
      nodeSel.attr('transform', n => `translate(${n.x ?? 0},${n.y ?? 0})`);
    };
    drawLanes(); tick();
    labelSel.each(function () {
      const label = (this as SVGGElement).querySelector('text') as SVGTextElement;
      const bw = (label.getComputedTextLength?.() || 50) + 16;
      d3.select(this).select('rect').attr('x', -bw / 2).attr('y', -9).attr('width', bw);
    });

    const zoom = d3.zoom<SVGSVGElement, unknown>().scaleExtent([0.2, 2.5])
      .filter(event => !event.button && (event.type !== 'wheel' || event.ctrlKey || event.metaKey) && (event.type !== 'touchstart' || event.touches.length > 1))
      .on('zoom', event => { root.attr('transform', event.transform.toString()); svg.classed('is-far', event.transform.k < 0.45); });
    svg.call(zoom).on('dblclick.zoom', null).on('click', () => selectRef.current(null));
    const fit = () => {
      const box = svgEl.getBoundingClientRect();
      const bb = (root.node() as SVGGElement).getBBox?.();
      if (!bb || !box.width) return;
      const pad = 24;
      const k = Math.min(1.25, (box.width - pad * 2) / Math.max(bb.width, 1), (box.height - pad * 2) / Math.max(bb.height, 1));
      svg.interrupt().call(zoom.transform, d3.zoomIdentity.translate(box.width / 2 - k * (bb.x + bb.width / 2), box.height / 2 - k * (bb.y + bb.height / 2)).scale(k));
    };
    zoomRef.current = { zoom, fit };
    const resize = new ResizeObserver(fit);
    resize.observe(svgEl);

    nodeSel.call(d3.drag<SVGGElement, GraphNode>()
      .on('start', (e, n) => { n.fx = n.x; n.fy = n.y; })
      .on('drag', (e, n) => { n.x = n.fx = e.x; n.y = n.fy = e.y; tick(); })
      .on('end', (_e, n) => { n.fx = null; n.fy = null; }));

    fit();
    return () => { resize.disconnect(); sim.stop(); svg.interrupt().on('.zoom', null); zoomRef.current = null; };
  }, [graph, t]);

  // Selection and search only restyle the drawn graph; they never re-run the layout.
  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;
    const svg = d3.select(svgEl);
    const link = graph.links.find(l => l.id === selected);
    const near = new Set<string>();
    if (link) { near.add(idOf(link.source)); near.add(idOf(link.target)); }
    else if (selected) {
      near.add(selected);
      for (const l of graph.links) if (idOf(l.source) === selected || idOf(l.target) === selected) { near.add(idOf(l.source)); near.add(idOf(l.target)); }
    }
    const touches = (l: GraphLink) => (link ? l.id === link.id : !!selected && (idOf(l.source) === selected || idOf(l.target) === selected));
    const q = query.trim().toLowerCase();
    svg.classed('has-selection', !!selected).classed('has-query', !!q);
    svg.selectAll<SVGGElement, GraphNode>('.onto-node').classed('is-selected', n => n.id === selected).classed('is-near', n => near.has(n.id))
      .classed('is-match', n => !!q && (n.name.toLowerCase().includes(q) || (n.draft.attributes ?? []).some(a => `${a.name} ${a.value}`.toLowerCase().includes(q))));
    svg.selectAll<SVGGElement, GraphLink>('.onto-link').classed('is-active', touches)
      .select('.onto-link-line').attr('marker-end', l => (touches(l) ? 'url(#onto-arrow-active)' : 'url(#onto-arrow)'));
  }, [selected, graph, query]);

  const nodeById = new Map(graph.nodes.map(n => [n.id, n]));
  const nodeOf = (end: string | GraphNode) => nodeById.get(idOf(end));
  const selNode = selected ? nodeById.get(selected) : undefined;
  const selLink = selected ? graph.links.find(l => l.id === selected) : undefined;
  const zoomBy = (k: number) => { const z = zoomRef.current; if (svgRef.current && z) d3.select(svgRef.current).transition().duration(200).call(z.zoom.scaleBy, k); };
  const toggleType = (type: NodeType) => setHidden(current => { const next = new Set(current); if (next.has(type)) next.delete(type); else next.add(type); return next; });
  const pickFirstMatch = () => {
    const q = query.trim().toLowerCase();
    const hit = q && graph.nodes.find(n => n.name.toLowerCase().includes(q));
    if (hit) setSelected(hit.id);
  };

  if (!full.nodes.length) {
    return <section className="onto-empty" aria-label={t('canvas')}>
      <h3>{t('emptyTitle')}</h3>
      <p className="helper">{t('emptyBody')}</p>
      <a className="btn" href="#knowledge?view=analysis">{t('openAnalysis')}</a>
    </section>;
  }

  const draft = selNode?.draft ?? selLink?.draft;
  const evidence = draft?.evidence ?? [];
  const groups = groupEvidence(evidence);
  const recorded = draft?.recordedAt?.slice(0, 10);
  const version = evidence.map(e => e.version).find(Boolean);
  const nodeLinks = selNode ? graph.links.filter(l => idOf(l.source) === selNode.id || idOf(l.target) === selNode.id) : [];
  const relationGroups = new Map<string, { label: string; dir: 'out' | 'in'; items: { node: GraphNode; link: GraphLink }[] }>();
  for (const l of nodeLinks) {
    const out = idOf(l.source) === selNode!.id;
    const other = nodeOf(out ? l.target : l.source);
    if (!other) continue;
    const key = `${out ? 'out' : 'in'}:${l.label}`;
    const group = relationGroups.get(key) ?? { label: edgeLabel(l.label), dir: out ? 'out' as const : 'in' as const, items: [] };
    group.items.push({ node: other, link: l });
    relationGroups.set(key, group);
  }
  const attributes = selNode?.draft.attributes ?? [];
  const summary = t('summary', { objects: graph.nodes.length, relations: graph.links.length });

  return <section className="onto" aria-label={t('canvas')}>
    <header className="onto-bar">
      <div className="onto-heading">
        <strong>{companyName ? t('titleOf', { company: companyName }) : t('title')}</strong>
        <span className="onto-summary">{summary}</span>
      </div>
      <input className="onto-search" type="search" value={query} placeholder={t('search')} aria-label={t('search')}
        onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') pickFirstMatch(); }} />
      <div className="onto-tools">
        <button type="button" className="onto-icon" aria-label={t('zoomOut')} title={t('zoomOut')} onClick={() => zoomBy(1 / 1.3)}>−</button>
        <button type="button" className="onto-icon" aria-label={t('zoomIn')} title={t('zoomIn')} onClick={() => zoomBy(1.3)}>+</button>
        <button type="button" className="onto-icon onto-fit" onClick={() => zoomRef.current?.fit()}>{t('fit')}</button>
      </div>
    </header>
    <div className="onto-legend" role="group" aria-label={t('typeFilter')}>
      {LANES.filter(type => type !== 'source' && counts.has(type)).map(type => <button key={type} type="button" className={`onto-chip onto-type-${type}`}
        aria-pressed={!hidden.has(type)} onClick={() => toggleType(type)}>
        <i aria-hidden="true" />{typeName(type)}<span>{counts.get(type)}</span>
      </button>)}
      <label className="onto-switch"><input type="checkbox" checked={withSources} onChange={event => setWithSources(event.target.checked)} /><span>{t('showSources')}</span></label>
    </div>
    <div className="onto-body">
      <div className="onto-canvas">
        <svg ref={svgRef} role="img" aria-label={`${t('canvas')}: ${summary}`} />
        <p className="onto-hint">{t('hint')}</p>
      </div>
      <aside className="onto-panel" aria-live="polite">
        {selNode || selLink ? <>
          <button type="button" className="onto-back" onClick={() => setSelected(null)}>← {t('back')}</button>
          <div className="onto-badges">
            {selNode ? <span className={`onto-chip is-static onto-type-${selNode.type}`}><i aria-hidden="true" />{typeName(selNode.type)}</span> : <span className="onto-chip is-static">{t('relation')}</span>}
            {selNode && selNode.type !== 'source' ? <span className={`onto-status ${draft?.humanLocked ? 'is-confirmed' : ''}`}>{t(draft?.humanLocked ? 'confirmed' : 'pending')}</span> : null}
            {draft?.privateMcp ? <span className="onto-status is-private" title={t('privateNote')}>{t('private')}</span> : null}
          </div>
          {selLink ? <h3 className="onto-rel-title">
            <button type="button" onClick={() => setSelected(nodeOf(selLink.source)?.id ?? null)}>{nodeOf(selLink.source)?.name}</button>
            <span>{edgeLabel(selLink.label)} →</span>
            <button type="button" onClick={() => setSelected(nodeOf(selLink.target)?.id ?? null)}>{nodeOf(selLink.target)?.name}</button>
          </h3> : <h3>{selNode!.name}</h3>}
          {draft?.description && !selLink?.derived ? <div className="onto-desc">
            <p className={descOpen ? '' : 'is-clamped'}>{draft.description}</p>
            {draft.description.length > 140 ? <button type="button" className="onto-link-btn" onClick={() => setDescOpen(v => !v)}>{t(descOpen ? 'less' : 'more')}</button> : null}
          </div> : null}

          {selNode && selNode.type !== 'source' ? <div className="onto-section">
            <h4>{t('attributes')}{attributes.length ? <span>{attributes.length}</span> : null}</h4>
            {attributes.length ? <dl className="onto-attrs">{attributes.map(a => <div key={a.name}>
              <dt>{a.name}</dt>
              <dd>{a.value}{a.citation && a.citation <= evidence.length ? <button type="button" className="onto-cite" aria-label={t('cite', { n: a.citation })}
                onClick={() => setFocusCite(a.citation! - 1)}>{a.citation}</button> : null}</dd>
            </div>)}</dl> : <p className="onto-muted">{t('noAttributes')}</p>}
          </div> : null}

          {selNode ? <div className="onto-section">
            <h4>{t('relations')}{nodeLinks.length ? <span>{nodeLinks.length}</span> : null}</h4>
            {relationGroups.size ? <ul className="onto-rels">{[...relationGroups.values()].map(group => <li key={`${group.dir}:${group.label}`}>
              <span className="onto-rel-label">{group.dir === 'out' ? `${group.label} →` : `← ${group.label}`}</span>
              <div>{group.items.map(({ node, link }) => <button key={link.id} type="button" className={`onto-chip onto-type-${node.type}`} onClick={() => setSelected(node.id)}>
                <i aria-hidden="true" />{node.name}
              </button>)}</div>
            </li>)}</ul> : <p className="onto-muted">{t('noRelations')}</p>}
          </div> : null}

          <div className="onto-section">
            <h4>{t('time')}</h4>
            <p className="onto-time">
              {draft && rangeText(draft) ? t('effective', { range: rangeText(draft)! }) : t('effectiveUnknown')}
              {recorded ? <> · {t('recorded', { date: recorded })}</> : null}
              {time ? <> · {t('known', { date: time.known })}</> : null}
            </p>
          </div>

          <div className="onto-section">
            <h4>{t('sources')}{evidence.length ? <span>{evidence.length}</span> : null}</h4>
            {groups.length ? <ul className="onto-sources">{groups.map(group => {
              const focused = focusCite !== null && group.items.some(item => item.index === focusCite);
              return <li key={`${group.key}:${focused ? 'f' : ''}`}>
                <details open={focused || groups.length === 1 || undefined}>
                  <summary><strong>{group.label}</strong><span>{t('citations', { n: group.items.length })}</span></summary>
                  <ol>{group.items.map(({ entry, index }) => <li key={index} className={index === focusCite ? 'is-focused' : ''}
                    ref={el => { if (el && index === focusCite) el.scrollIntoView({ block: 'nearest' }); }}>
                    <span className="onto-cite is-static">{index + 1}</span>
                    <p>{readableQuote(entry.quote)}</p>
                  </li>)}</ol>
                </details>
              </li>;
            })}</ul> : <p className="onto-muted">{t('noSources')}</p>}
          </div>

          <details className="onto-tech">
            <summary>{t('technical')}</summary>
            <dl className="onto-meta">
              <dt>{t('stableId')}</dt><dd><code>{draft?.id ?? selected}</code></dd>
              <dt>{t('version')}</dt><dd>{version || t('notStated')}</dd>
            </dl>
          </details>
        </> : <>
          <h4 className="onto-panel-title">{t('entities')}</h4>
          {LANES.filter(type => graph.nodes.some(n => n.type === type)).map(type => {
            const list = graph.nodes.filter(n => n.type === type).sort((a, b) => b.degree - a.degree || a.name.localeCompare(b.name));
            return <div key={type} className="onto-group">
              <h5 className={`onto-type-${type}`}><span className="onto-swatch" aria-hidden="true" />{typeName(type)}<span>{list.length}</span></h5>
              <ul className="onto-list">{list.map(n => <li key={n.id}>
                <button type="button" onClick={() => setSelected(n.id)}>
                  <span>{n.name}</span>
                  {n.draft.attributes?.length ? <small>{n.draft.attributes.length} {t('attributes')}</small> : null}
                  {n.draft.privateMcp ? <small className="is-private">{t('private')}</small> : null}
                </button>
              </li>)}</ul>
            </div>;
          })}
        </>}
      </aside>
    </div>
  </section>;
}
