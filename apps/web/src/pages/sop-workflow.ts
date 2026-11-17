/**
 * Pure rules behind the SOP workspace (T-48): validation freshness, regression-case completeness, SOP packs from
 * the knowledge analysis, and the impact of knowledge changes on a draft. Kept free of React so they are unit-tested.
 */
import type { SopGraph, SopNodeKind } from '@superagent/shared';

/** The ten runtime gates run as regression cases on every validation (T-41 runtime). */
export const REGRESSION_CASES = [
  'read_ok',
  'missing_field',
  'over_threshold',
  'approval_denied',
  'duplicate_event',
  'employee_offline',
  'paused',
  'outcome_unknown',
  'permission_revoked',
  'write_approval',
] as const;

export interface KnowledgeEvidence {
  sourceId: string;
  version: string;
  locator: string;
  quote: string;
}

export interface RecommendedWorkflow {
  completion?: string;
  steps: {
    key: string; kind: SopNodeKind; label: string; detail?: string; after: string[];
    employeeKey?: string; toolKey?: string; citations: number[];
  }[];
}

export interface PackItem {
  id: string;
  kind: 'trigger' | 'rule';
  text: string;
  confirmed: boolean;
  evidence: KnowledgeEvidence[];
}

export interface SopPack {
  key: string;
  name: string;
  items: PackItem[];
  workflow?: RecommendedWorkflow;
}

export interface GateReport {
  ok: boolean;
  gates: Record<string, { ok: boolean; detail: string }>;
}

export interface DraftState {
  status: 'draft' | 'passed' | 'failed' | 'published';
  revision?: number;
  validatedRevision?: number | null;
  report: GateReport | null;
}

/** Regression cases a validation report must contain; any missing one blocks publishing. */
export function missingRegressionCases(report: GateReport | null): string[] {
  if (!report) return [...REGRESSION_CASES];
  return REGRESSION_CASES.filter((c) => !(c in report.gates));
}

export type ValidationState =
  | { kind: 'none' }
  | { kind: 'dirty' }
  | { kind: 'stale'; validatedRevision: number; revision: number }
  | { kind: 'failed' }
  | { kind: 'incomplete'; missing: string[] }
  | { kind: 'valid' };

/** Whether the current draft may be published, and if not, why (shown to the user, never silent). */
export function validationState(v: DraftState | undefined, dirty: boolean): ValidationState {
  if (!v || v.status === 'published') return { kind: 'none' };
  if (dirty) return { kind: 'dirty' };
  const rev = v.revision ?? 1;
  if (v.validatedRevision != null && v.validatedRevision !== rev) return { kind: 'stale', validatedRevision: v.validatedRevision, revision: rev };
  if (v.status === 'failed') return { kind: 'failed' };
  if (v.status !== 'passed') return { kind: 'none' };
  const missing = missingRegressionCases(v.report);
  if (missing.length) return { kind: 'incomplete', missing };
  return { kind: 'valid' };
}

interface SopRecommendation {
  key: string;
  kind: string;
  name: string;
  description: string;
  evidence: KnowledgeEvidence[];
  workflow?: RecommendedWorkflow;
}

/** Retain legacy citations for old drafts. New packs have one evidence item per concrete node. */
export function packFromRecommendation(r: SopRecommendation): SopPack {
  const items = r.workflow?.steps.map(step => ({
    id: `${r.key}:step:${step.key}`, kind: step.kind === 'trigger' ? 'trigger' as const : 'rule' as const,
    text: step.label, confirmed: false,
    evidence: step.citations.flatMap(reference => r.evidence[reference - 1] ?? []),
  })) ?? [
    { id: `${r.key}:trigger`, kind: 'trigger' as const, text: r.name, confirmed: false, evidence: r.evidence.slice(0, 1) },
    ...r.evidence.map((e, i) => ({ id: `${r.key}:rule:${i + 1}`, kind: 'rule' as const, text: e.quote, confirmed: false, evidence: [e] })),
  ];
  return { key: r.key, name: r.name, items, workflow: r.workflow };
}

interface WorkflowRefs {
  employees?: ReadonlyMap<string, string>;
  tools?: ReadonlyMap<string, string>;
}

/** Copy the actual dependencies and bind only capabilities already recorded by organization confirmation. */
export function graphFromWorkflow(workflow: RecommendedWorkflow, refs: WorkflowRefs = {}): SopGraph {
  return {
    nodes: workflow.steps.map(step => {
      const ref = step.kind === 'employee' && step.employeeKey ? refs.employees?.get(step.employeeKey)
        : step.kind === 'tool' && step.toolKey ? refs.tools?.get(step.toolKey) : undefined;
      return { id: step.key, kind: step.kind, label: step.label, ...(ref && { ref }) };
    }),
    edges: workflow.steps.flatMap(step => step.after.map(from => ({ from, to: step.key }))),
  };
}

/** Older recommendations can already contain an explicit ordered flow in their retained description. */
export function legacyWorkflow(description: string): RecommendedWorkflow | undefined {
  const sequence = description.split(/\r?\n/).find(line => /→|->/.test(line));
  if (!sequence) return;
  const labels = sequence.trim().replace(/^(?:流程|步骤|workflow|steps)\s*[:：]\s*/i, '')
    .split(/\s*(?:→|->)\s*/).map(line => line.trim().replace(/[。；;.]$/, ''));
  if (labels.length < 2 || labels.length > 12 || labels.some(label => !label || label.length > 160)) return;
  return {
    steps: labels.map((label, index) => ({
      key: `legacy-${index + 1}`, kind: index === 0 ? 'trigger' : 'agent', label,
      after: index === 0 ? [] : [`legacy-${index}`], citations: [],
    })),
  };
}

export const unconfirmedItems = (p: SopPack | undefined) => (p ? p.items.filter((i) => !i.confirmed) : []);

export interface KnowledgeImpact {
  itemId: string;
  text: string;
  locator: string;
  from: string;
  to: string | null; // null = source no longer available to this user
}

/** Compare the evidence a draft was built on with the current knowledge: changed or withdrawn sources. */
export function knowledgeImpact(pack: SopPack | undefined, current: { evidence: KnowledgeEvidence[] }[]): KnowledgeImpact[] {
  if (!pack) return [];
  const now = new Map<string, string>();
  for (const r of current) for (const e of r.evidence) now.set(e.sourceId, e.version);
  const out: KnowledgeImpact[] = [];
  for (const item of pack.items) {
    for (const e of item.evidence) {
      const v = now.get(e.sourceId);
      if (v !== e.version) out.push({ itemId: item.id, text: item.text, locator: e.locator, from: e.version, to: v ?? null });
    }
  }
  return out;
}
