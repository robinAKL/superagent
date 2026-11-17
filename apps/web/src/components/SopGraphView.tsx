import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { linkHorizontal, linkVertical, select, zoom, zoomIdentity, type ZoomBehavior } from 'd3';
import { layoutSopGraph, type SopGraph, type SopGraphIssue, type SopNodeKind } from '@superagent/shared';
import { translate, useLang, type Dict, type Lang } from '../i18n';
import './SopGraphView.css';

const TEXT = {
  en: {
    trigger: 'Trigger', agent: 'Super agent', employee: 'Employee', tool: 'Tool', human_review: 'Human review',
    zoomIn: 'Zoom in', zoomOut: 'Zoom out', fit: 'Fit diagram', empty: 'The draft has no nodes yet.', graph: 'Flow chart', nodeLabel: '{kind}: {label}', problems: '. Issues: {list}', problemSep: '; ',
  },
  zh: {
    trigger: '触发点', agent: '超级智能体', employee: '员工', tool: '工具', human_review: '人工审核',
    zoomIn: '放大', zoomOut: '缩小', fit: '适应画布', empty: '草稿里还没有节点。', graph: '流程图', nodeLabel: '{kind}：{label}', problems: '。问题：{list}', problemSep: '；',
  },
} satisfies Dict<string>;

/** Node kind in the given language. */
export function kindLabel(kind: SopNodeKind, lang: Lang): string {
  return translate(TEXT, lang, kind);
}

/** Chinese node kind labels, kept for callers that have not moved to kindLabel() yet. */
export const KIND_LABEL: Record<SopNodeKind, string> = {
  trigger: TEXT.zh.trigger,
  agent: TEXT.zh.agent,
  employee: TEXT.zh.employee,
  tool: TEXT.zh.tool,
  human_review: TEXT.zh.human_review,
};

const W = 184;
const H = 66;
const GX = 54;
const GY = 35;
const PAD = 28;
type Point = [number, number];
type Link = { source: Point; target: Point };
const verticalLink = linkVertical<Link, Point>().x(point => point[0]).y(point => point[1]);
const horizontalLink = linkHorizontal<Link, Point>().x(point => point[0]).y(point => point[1]);

function plot(graph: SopGraph, vertical: boolean) {
  const positions = [...layoutSopGraph(graph)];
  const depth = Math.max(1, ...positions.map(([, position]) => position.col + 1));
  const counts = new Map<number, number>();
  for (const [, position] of positions) counts.set(position.col, (counts.get(position.col) ?? 0) + 1);
  const lanes = Math.max(1, ...counts.values());
  const position = new Map<string, Point>();
  for (const [id, { col, row }] of positions) {
    const lane = row + (lanes - (counts.get(col) ?? 1)) / 2;
    position.set(id, vertical ? [PAD + lane * (W + GX), PAD + col * (H + GY)] : [PAD + col * (W + GX), PAD + lane * (H + GY)]);
  }
  return {
    position,
    width: (vertical ? lanes : depth) * (W + GX) - GX + PAD * 2,
    height: (vertical ? depth : lanes) * (H + GY) - GY + PAD * 2,
    links: graph.edges.flatMap(edge => {
      const start = position.get(edge.from);
      const end = position.get(edge.to);
      if (!start || !end) return [];
      const endpoints: Link = vertical
        ? { source: [start[0] + W / 2, start[1] + H], target: [end[0] + W / 2, end[1] - 4] }
        : { source: [start[0] + W, start[1] + H / 2], target: [end[0] - 4, end[1] + H / 2] };
      return [{ edge, path: (vertical ? verticalLink : horizontalLink)(endpoints) }];
    }),
  };
}

export function SopGraphView({ graph, issues = [], selected, onSelect, assignments }: {
  graph: SopGraph; issues?: SopGraphIssue[]; selected?: string; onSelect?: (id: string) => void;
  assignments?: ReadonlyMap<string, string>;
}) {
  const [lang] = useLang();
  const t = (key: keyof typeof TEXT.en, vars?: Record<string, string>) => translate(TEXT, lang, key, vars);
  const marker = useId();
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const behavior = useRef<ZoomBehavior<HTMLDivElement, unknown>>();
  const [width, setWidth] = useState(760);
  const vertical = width < 600;
  const layout = useMemo(() => plot(graph, vertical), [graph, vertical]);
  const height = Math.min(470, Math.max(218, layout.height));
  const hasNodes = graph.nodes.length > 0;
  const issuesByNode = new Map<string, string[]>();
  for (const issue of issues) if (issue.nodeId) {
    issuesByNode.set(issue.nodeId, [...(issuesByNode.get(issue.nodeId) ?? []), issue.message]);
  }

  useEffect(() => {
    if (!viewport.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry?.contentRect.width) setWidth(entry.contentRect.width);
    });
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, [hasNodes]);

  useEffect(() => {
    if (!viewport.current || !content.current) return;
    const canvas = select<HTMLDivElement, unknown>(viewport.current);
    const layers = content.current;
    const operation = zoom<HTMLDivElement, unknown>()
      .extent([[0, 0], [width, height]])
      .scaleExtent([0.18, 2.5])
      .filter(event => event.type !== 'wheel' && !event.button && !(event.target instanceof Element && event.target.closest('button')))
      .on('zoom', event => {
        const { x, y, k } = event.transform;
        layers.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
      });
    behavior.current = operation;
    canvas.call(operation).on('dblclick.zoom', null);
    const scale = Math.min(1, width / layout.width, height / layout.height);
    canvas.call(operation.transform, zoomIdentity
      .translate((width - layout.width * scale) / 2, (height - layout.height * scale) / 2).scale(scale));
    return () => { canvas.on('.zoom', null); behavior.current = undefined; };
  }, [height, layout.height, layout.width, width, hasNodes]);

  function changeZoom(factor?: number) {
    if (!viewport.current || !behavior.current) return;
    const canvas = select<HTMLDivElement, unknown>(viewport.current);
    const operation = behavior.current;
    if (factor) {
      canvas.call(operation.scaleBy, factor);
    } else {
      const scale = Math.min(1, width / layout.width, height / layout.height);
      canvas.call(operation.transform, zoomIdentity
        .translate((width - layout.width * scale) / 2, (height - layout.height * scale) / 2).scale(scale));
    }
  }

  if (!hasNodes) return <p className="helper">{t('empty')}</p>;
  return <div className="sop-graph" role="group" aria-label={t('graph')}>
    <header className="sop-graph-toolbar">
      <strong>{t('graph')}</strong>
      <div className="sop-graph-controls">
        <button type="button" aria-label={t('zoomOut')} onClick={() => changeZoom(0.8)}>−</button>
        <button type="button" onClick={() => changeZoom()}>{t('fit')}</button>
        <button type="button" aria-label={t('zoomIn')} onClick={() => changeZoom(1.25)}>+</button>
      </div>
    </header>
    <div className="sop-graph-canvas" ref={viewport} style={{ height }}>
      <div className="sop-graph-content" ref={content}>
        <svg width={layout.width} height={layout.height} aria-hidden="true" className="sop-edges">
          <defs><marker id={marker} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 9 5 L 0 10 z" className="sop-arrow" />
          </marker></defs>
          {layout.links.map(({ edge, path }, index) =>
            <path key={index} d={path ?? undefined} data-edge={edge.from + ':' + edge.to} className="sop-edge" markerEnd={`url(#${marker})`} />)}
        </svg>
        {graph.nodes.map(node => {
          const [left, top] = layout.position.get(node.id) ?? [0, 0];
          const problems = issuesByNode.get(node.id);
          const assigned = assignments?.get(node.id);
          return <button key={node.id} type="button" data-node={node.id}
            className={`sop-node kind-${node.kind}${problems ? ' has-issue' : ''}${selected === node.id ? ' selected' : ''}`}
            style={{ left, top, width: W, height: H }} onClick={() => onSelect?.(node.id)}
            aria-pressed={onSelect ? selected === node.id : undefined}
            title={assigned ? node.label + ' · ' + assigned : node.label}
            aria-label={t('nodeLabel', { kind: kindLabel(node.kind, lang), label: node.label }) + (problems ? t('problems', { list: problems.join(t('problemSep')) }) : '')}>
            <small>{kindLabel(node.kind, lang)}{assigned ? ' · ' + assigned : ''}</small>
            <span>{node.label}</span>
          </button>;
        })}
      </div>
    </div>
  </div>;
}
