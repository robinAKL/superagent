import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { validateSopGraph, type SopGraph } from '@superagent/shared';
import { SopGraphView } from '../src/components/SopGraphView';
import { LangProvider } from '../src/i18n';
import { employeeContext } from '../src/pages/SuperAgentPage';

const graph: SopGraph = {
  nodes: [
    { id: 't', kind: 'trigger', label: '收到发票' },
    { id: 'e', kind: 'employee', label: '应付专员', ref: 'emp-1' },
    { id: 'w', kind: 'tool', label: '登记付款', ref: 'erp.post' },
  ],
  edges: [{ from: 't', to: 'e' }, { from: 'e', to: 'w' }],
};

describe('SOP graph view', () => {
  it('draws every node as a labelled button with its kind, and marks nodes that have structural issues', () => {
    const issues = validateSopGraph(graph, { employees: { 'emp-1': { status: 'active' } }, tools: { 'erp.post': { stage: 'available', effect: 'write' } } });
    expect(issues.map((i) => i.code)).toEqual(['write_without_review']);
    const html = renderToStaticMarkup(<LangProvider initial="zh"><SopGraphView graph={graph} issues={issues} selected="e" /></LangProvider>);
    expect(html.match(/data-node=/g)).toHaveLength(3);
    expect(html).toContain('aria-label="触发点：收到发票"');
    expect(html).toContain('问题：登记付款 会写入外部系统，之前必须经过人工审核');
    expect(html).toMatch(/class="sop-node kind-tool has-issue"/);
    expect(html).toMatch(/kind-employee selected/);
    expect(html.match(/class="sop-edge"/g)).toHaveLength(2);
  });

  it('an empty draft says so instead of drawing nothing', () => {
    expect(renderToStaticMarkup(<LangProvider initial="zh"><SopGraphView graph={{ nodes: [], edges: [] }} /></LangProvider>)).toContain('草稿里还没有节点');
    // English is the default: no Chinese UI text.
    const en = renderToStaticMarkup(<SopGraphView graph={{ nodes: [], edges: [] }} />);
    expect(en).toContain('The draft has no nodes yet.');
    expect(en).not.toMatch(/[一-鿿]/);
  });

  it('maps employee runtime status onto graph availability', () => {
    expect(employeeContext([{ id: 'a', name: 'A', status: 'online' }, { id: 'b', name: 'B', status: 'paused' }, { id: 'c', name: 'C', status: 'unconnected' }])).toEqual({
      a: { status: 'active' },
      b: { status: 'paused' },
      c: { status: 'offline' },
    });
  });
});
