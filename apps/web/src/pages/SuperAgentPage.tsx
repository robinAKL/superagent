import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { SOP_NODE_KINDS, validateSopGraph, type SopGraph, type SopGraphContext, type SopNodeKind } from '@superagent/shared';
import { api } from '../api';
import { useT } from '../i18n';
import { OntologyGraphView } from '../components/OntologyGraphView';
import { KIND_LABEL, SopGraphView } from '../components/SopGraphView';
import { graphFromWorkflow, legacyWorkflow, knowledgeImpact, packFromRecommendation, unconfirmedItems, validationState, type KnowledgeEvidence, type RecommendedWorkflow, type SopPack } from './sop-workflow';
import { McpKnowledge } from './McpKnowledge';
import { AnalysisDraftIndex } from './AnalysisDraftIndex';
import { CompanyContextPanel } from './CompanyContextPanel';
import { OrganizationPublish } from './OrganizationPublish';
import { ExecutionsPanel } from './ExecutionsPanel';
import './SuperAgentPage.css';
import './EmployeesPage.css';

/** Contract agreed with the SOP runtime (T-41): /api/v1/sop. */
interface GateReport {
  ok: boolean;
  gates: Record<string, { ok: boolean; detail: string }>;
}
export interface SopVersionView {
  id: string;
  sopId: string;
  number: number;
  status: 'draft' | 'passed' | 'failed' | 'published';
  report: GateReport | null;
  runningInstances: number;
  effectiveAt?: string | null;
  /** Bumped by every saved revision; validation is valid only for the revision it ran on. */
  revision?: number;
  validatedRevision?: number | null;
  definition: { graph?: SopGraph; pack?: SopPack | null; workflow?: { title: string; completion: string }; [k: string]: unknown };
}
interface SopSummary {
  sopId: string;
  latest?: { id: string; number: number; status: SopVersionView['status'] };
}
interface ToolRow {
  toolId: string;
  name: string;
  stage: SopGraphContext['tools'][string]['stage'];
  effect: SopGraphContext['tools'][string]['effect'];
}
interface EmployeeRow {
  id: string;
  name: string;
  status: string;
}
interface Evidence {
  locator: string;
  quote: string;
}
interface Recommendation {
  id: string;
  key: string;
  kind: string;
  name: string;
  description: string;
  evidence: Evidence[];
  relation?: { from: string; to: string; label: string };
  workflow?: RecommendedWorkflow;
}

interface Organization {
  sops: { key: string; privateSource: boolean }[];
  employees: { key: string; employeeId: string | null; privateSource: boolean }[];
  tools: { key: string; toolId: string | null; privateSource: boolean }[];
  confirmation: unknown;
  changedSinceConfirmation: boolean;
}

async function confirmedOrganization(workflowKey: string): Promise<Organization | undefined> {
  try {
    const { status, body } = await api<Organization>('/api/v1/knowledge/organization', { signal: AbortSignal.timeout(7000) });
    if (status === 200 && body.confirmation && !body.changedSinceConfirmation &&
        body.sops.some(sop => sop.key === workflowKey && !sop.privateSource)) return body;
  } catch {
    // The editor can still create a draft whose assignments are resolved explicitly.
  }
}

interface Drafts {
  recommendations: (Recommendation & { evidence: KnowledgeEvidence[] })[];
  mcpRecommendations: Recommendation[];
}
type DraftRead = { status: 'loading' | 'error' } | { status: 'ready'; drafts: Drafts };
interface DraftViewProps { knowledge: DraftRead; retryKnowledge: () => void }
const READ_TIMEOUT_MS = 15_000;
const TEXT = {
  en: {
    title: 'Super Agent', subtitle: 'Company context and operating workflows',
    tabConfig: 'Company setup & digital org', tabFlow: 'Company workflows',
    allDrafts: 'All analysis drafts', context: 'Company context', candidates: 'Workflow candidates', useCandidate: 'Open in workflow editor',
    noStepMap: 'Run analysis again to generate source-backed steps for this workflow.',
    legacyStepMap: 'Sequence from an earlier analysis. Analyze again to add evidence and assignments to each step.',
    stepEvidence: 'Step evidence', selectStep: 'Select a step to view its evidence.',
    employeeRef: 'Assigned employee', toolRef: 'Assigned tool', unresolvedRef: 'Choose an assignment',
    importingWorkflow: 'Creating draft…', importFailed: 'Could not create the workflow draft. Try again.',
    stepDetails: 'Step details', currentStage: 'Current stage {stage}', openTool: 'Open tool card', openEmployee: 'Open employee',
    stepName: 'Step name', publishedFlow: 'View the published workflow', closeNode: 'Remove node',
    workflowTitle: 'Workflow name', completion: 'Expected deliverable', runWorkflow: 'Open in command room',
    results: 'Analysis results', sop: 'Workflows', ontology: 'Ontology', mcp: 'MCP knowledge', mcpAdvanced: 'Advanced: MCP knowledge',
    loadingDrafts: 'Loading analysis drafts…', draftError: 'Could not load analysis drafts.',
    retry: 'Try again', loadingSops: 'Loading workflows…', sopError: 'Could not load workflows.',
    privateDraft: 'Private MCP draft',
    noDrafts: 'Analysis results will appear here after you analyze a source.',
    reviewDrafts: 'Open knowledge analysis', evidence: 'View source evidence',
    chooseWorkflow: 'Select workflow', workflowPlaceholder: 'Choose a workflow',
    workflowKey: 'ID for a new workflow', workflowKeyPlaceholder: 'e.g. sop.invoice-intake',
    workflowPacks: 'Workflow packs', workflowPackTitle: 'Workflow packs from knowledge analysis',
    noWorkflowPacks: 'No shared workflow packs are available.',
    applyPack: 'Apply to draft', confirmAllPack: 'Confirm all items',
    viewPrivateWorkflows: 'View my MCP workflow drafts',
    sopDraft: 'Workflow', objectDraft: 'Business object', relationDraft: 'Relationship',
    employeeDraft: 'Role', toolDraft: 'Tool',
  },
  zh: {
    title: '超级智能体', subtitle: '企业上下文与运行流程',
    tabConfig: '企业配置与数字组织', tabFlow: '企业流程',
    allDrafts: '所有分析草案', context: '企业上下文', candidates: '候选流程', useCandidate: '在流程编辑器中打开',
    noStepMap: '重新分析来源，即可为这个流程生成带依据的步骤。',
    legacyStepMap: '这是上次分析中记录的步骤顺序。重新分析可补齐逐节点依据和岗位工具。',
    stepEvidence: '步骤依据', selectStep: '选择节点查看原文依据。',
    employeeRef: '执行员工', toolRef: '执行工具', unresolvedRef: '选择执行对象',
    importingWorkflow: '正在创建草稿…', importFailed: '无法创建流程草稿，请重试。',
    stepDetails: '节点详情', currentStage: '当前阶段 {stage}', openTool: '打开工具卡', openEmployee: '查看员工',
    stepName: '步骤名称', publishedFlow: '查看已发布流程', closeNode: '从草稿删除此节点',
    workflowTitle: '流程名称', completion: '预期交付', runWorkflow: '在指挥室运行',
    results: '分析结果', sop: '流程', ontology: '本体关系', mcp: 'MCP 知识', mcpAdvanced: '高级：MCP 知识',
    loadingDrafts: '正在读取分析草案…', draftError: '无法读取分析草案。',
    retry: '重试', loadingSops: '正在读取流程…', sopError: '无法读取流程列表。',
    privateDraft: '仅自己可见的 MCP 草案',
    noDrafts: '分析来源后，结果会出现在这里。',
    reviewDrafts: '打开知识分析', evidence: '查看来源依据',
    chooseWorkflow: '选择流程', workflowPlaceholder: '请选择',
    workflowKey: '新流程编号（从流程包新建时使用）', workflowKeyPlaceholder: '例如 sop.invoice-intake',
    workflowPacks: '流程包', workflowPackTitle: '流程包（来自企业知识分析）',
    noWorkflowPacks: '暂无共享流程包。',
    applyPack: '套用到草稿', confirmAllPack: '确认全部流程项',
    viewPrivateWorkflows: '查看我的 MCP 流程草案',
    sopDraft: '流程', objectDraft: '业务对象', relationDraft: '关系',
    employeeDraft: '角色', toolDraft: '工具',
  },
};
const DRAFT_KIND: Record<string, keyof typeof TEXT.en> = {
  sop: 'sopDraft', object: 'objectDraft', relation: 'relationDraft', employee: 'employeeDraft', tool: 'toolDraft',
};
type AgentTab = 'context' | 'results' | 'sop' | 'ontology' | 'mcp';
const PRIMARY_TABS: readonly AgentTab[] = ['context', 'sop'];
const TABS: readonly AgentTab[] = ['context', 'sop', 'results', 'ontology', 'mcp'];

function agentLocation() {
  const params = new URLSearchParams(typeof window === 'undefined' ? undefined : window.location.hash.split('?')[1]);
  const tab = TABS.find(entry => entry === params.get('tab')) ?? (params.has('type') ? 'results' : 'context');
  return { tab, draftType: params.get('type') ?? '', workflowId: params.get('sop') ?? '', candidate: params.get('candidate') ?? '', fromOrganization: params.has('org') };
}

const STATUS_LABEL: Record<SopVersionView['status'], string> = { draft: '草稿', passed: '校验通过', failed: '校验未通过', published: '已发布' };
const GATE_LABEL: Record<string, string> = {
  read_ok: '只读步骤可用',
  missing_field: '缺字段时停下补充',
  over_threshold: '超阈值转人工',
  approval_denied: '审批拒绝不执行',
  duplicate_event: '同一事件只开一次',
  employee_offline: '员工离线时不开工',
  paused: '暂停时不开工',
  outcome_unknown: '结果未知不重发',
  permission_revoked: '撤权后停止',
  write_approval: '写入需审批',
};

interface RulesForm {
  requiredFields: string;
  thresholdField: string;
  thresholdMax: string;
}
/** SOP run rules as edited on the page (the runtime's SopDefinition requiredFields / threshold). */
function rulesFrom(def: SopVersionView['definition'] | undefined): RulesForm {
  const req = Array.isArray(def?.requiredFields) ? (def!.requiredFields as string[]) : [];
  const th = def?.threshold as { field?: string; max?: number } | undefined;
  return { requiredFields: req.join(', '), thresholdField: th?.field ?? '', thresholdMax: th?.max != null ? String(th.max) : '' };
}
/** Always sets both keys: a cleared threshold becomes undefined (dropped on save), never the previous value. */
function rulesTo(r: RulesForm): { requiredFields: string[]; threshold: { field: string; max: number } | undefined } {
  const requiredFields = r.requiredFields.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
  const max = Number(r.thresholdMax);
  return { requiredFields, threshold: r.thresholdField.trim() && r.thresholdMax.trim() && Number.isFinite(max) ? { field: r.thresholdField.trim(), max } : undefined };
}

export function employeeContext(rows: EmployeeRow[]): SopGraphContext['employees'] {
  return Object.fromEntries(rows.map((e) => [e.id, { status: e.status === 'online' || e.status === 'busy' || e.status === 'active' ? 'active' : e.status === 'paused' ? 'paused' : 'offline' }]));
}

export function SuperAgentPage() {
  const t = useT(TEXT);
  const [{ tab, draftType, workflowId, candidate, fromOrganization }, setLocation] = useState(agentLocation);
  useEffect(() => {
    const updateTab = () => setLocation(agentLocation());
    window.addEventListener('hashchange', updateTab);
    return () => window.removeEventListener('hashchange', updateTab);
  }, []);
  const [knowledge, setKnowledge] = useState<DraftRead>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(READ_TIMEOUT_MS)]);
    void api<Drafts>('/api/v1/knowledge/recommendations', { signal }).then(response => {
      if (controller.signal.aborted) return;
      setKnowledge(response.status === 200 && Array.isArray(response.body?.recommendations) && Array.isArray(response.body?.mcpRecommendations)
        ? { status: 'ready', drafts: response.body }
        : { status: 'error' });
    }).catch(() => {
      if (!controller.signal.aborted) setKnowledge({ status: 'error' });
    });
    return () => controller.abort();
  }, [attempt]);
  function retryKnowledge() {
    setKnowledge({ status: 'loading' });
    setAttempt(value => value + 1);
  }
  const count = knowledge.status === 'ready' ? [...knowledge.drafts.recommendations, ...knowledge.drafts.mcpRecommendations].filter(draft => draft.kind === 'sop').length : 0;
  return (
    <>
      <div className="page-head">
        <h1>{t('title')}</h1>
        <p>{t('subtitle')}</p>
      </div>
      <div className="tabs" role="tablist" aria-label={t('title')}>
        {PRIMARY_TABS.map(entry => <button key={entry} role="tab" type="button" aria-selected={tab === entry || (entry === 'context' && (tab === 'mcp' || tab === 'ontology')) || (entry === 'sop' && tab === 'results')} className="tab" onClick={() => {
          if (tab !== entry) window.location.hash = entry === 'context' ? 'brain' : `brain?tab=${entry}${fromOrganization ? '&org=1' : ''}`;
        }}>{t(entry === 'context' ? 'tabConfig' : 'tabFlow')}{entry === 'sop' && count ? ` (${count})` : ''}</button>)}
      </div>
      {tab === 'context' ? <>
        <CompanyContextPanel fromOrganization={fromOrganization} />
        <OrganizationPublish />
        <details className="panel stack agent-mcp-advanced">
          <summary>{t('mcpAdvanced')}</summary>
          {typeof window === 'undefined' ? null : <McpKnowledge />}
        </details>
      </> :
        tab === 'sop' ? <SopWorkspace key={`${workflowId}|${candidate}`} initialSop={workflowId} candidate={candidate} knowledge={knowledge} retryKnowledge={retryKnowledge} /> :
        tab === 'ontology' ? <OntologyView knowledge={knowledge} retryKnowledge={retryKnowledge} /> :
        tab === 'results' ? <AnalysisResults key={draftType} knowledge={knowledge} retryKnowledge={retryKnowledge} initialKind={draftType} fromOrganization={fromOrganization} /> : <McpKnowledge />}
    </>
  );
}

function DraftLoadStatus({ knowledge, retryKnowledge }: DraftViewProps) {
  const t = useT(TEXT);
  if (knowledge.status === 'ready') return null;
  if (knowledge.status === 'loading') return <p className="helper" role="status">{t('loadingDrafts')}</p>;
  return <div className="draft-load-error">
    <p className="warn" role="alert">{t('draftError')}</p>
    <button className="btn" type="button" onClick={retryKnowledge}>{t('retry')}</button>
  </div>;
}

function AnalysisResults({ knowledge, retryKnowledge, initialKind, fromOrganization }: DraftViewProps & { initialKind: string; fromOrganization: boolean }) {
  const t = useT(TEXT);
  const drafts = knowledge.status === 'ready' ? [
    ...knowledge.drafts.mcpRecommendations.map(draft => ({ ...draft, privateMcp: true })),
    ...knowledge.drafts.recommendations,
  ].filter(draft => initialKind || draft.kind === 'sop').sort((a, b) => Number(b.kind === 'sop') - Number(a.kind === 'sop')) : [];
  return <section className="panel stack agent-results-page" aria-labelledby="agent-results-heading">
    <div className="agent-results-head">
      <h2 className="h2" id="agent-results-heading">{t(initialKind ? 'results' : 'candidates')}</h2>
      <div className="workflow-actions">
        {!initialKind && knowledge.status === 'ready' && knowledge.drafts.mcpRecommendations.length
          ? <a href={`#brain?tab=results&type=all${fromOrganization ? '&org=1' : ''}`}>{t('allDrafts')}</a> : null}
        <a href="#knowledge?view=analysis">{t('reviewDrafts')}</a>
      </div>
    </div>
    <DraftLoadStatus knowledge={knowledge} retryKnowledge={retryKnowledge} />
    {knowledge.status === 'ready' ? drafts.length ? <AnalysisDraftIndex drafts={drafts} initialKind={initialKind} renderDraft={draft =>
        <article className="agent-result-draft" key={draft.id}>
          <div className="mcp-draft-heading">
            <h3>{draft.name}</h3>
            <span className="helper">{'privateMcp' in draft ? t('privateDraft') : DRAFT_KIND[draft.kind] ? t(DRAFT_KIND[draft.kind]!) : draft.kind}</span>
          </div>
          <p className="mcp-draft-description">{draft.description}</p>
          {draft.kind === 'sop' && draft.evidence.length ? <WorkflowPreview key={draft.id} draft={draft}
            recommendations={'privateMcp' in draft && knowledge.status === 'ready' ? knowledge.drafts.mcpRecommendations : knowledge.status === 'ready' ? knowledge.drafts.recommendations : []} /> : null}
          {draft.evidence.length ? <details>
            <summary>{t('evidence')}</summary>
            <Evidences ev={draft.evidence} label={t('evidence')} />
          </details> : null}
          {draft.kind === 'sop' && !('privateMcp' in draft) && draft.workflow && draft.evidence.length
            ? <a className="btn" href={`#brain?tab=sop&candidate=${encodeURIComponent(draft.key)}${fromOrganization ? '&org=1' : ''}`}>{t('useCandidate')}</a> : null}
        </article>
      } /> : <p className="helper">{t('noDrafts')}</p> : null}
  </section>;
}

function WorkflowPreview({ draft, recommendations }: { draft: Recommendation; recommendations: Recommendation[] }) {
  const t = useT(TEXT);
  const [selected, select] = useState<string>();
  const workflow = draft.workflow ?? legacyWorkflow(draft.description);
  const step = workflow?.steps.find(item => item.key === selected);
  if (!workflow) return <p className="helper">{t('noStepMap')} <a href="#knowledge?view=analysis">{t('reviewDrafts')}</a></p>;
  const roles = new Map(recommendations.filter(item => item.kind === 'employee').map(item => [item.key, item.name]));
  const tools = new Map(recommendations.filter(item => item.kind === 'tool').map(item => [item.key, item.name]));
  const role = step?.employeeKey ? roles.get(step.employeeKey) : undefined;
  const tool = step?.toolKey ? tools.get(step.toolKey) : undefined;
  const assignments = new Map<string, string>();
  for (const item of workflow.steps) {
    const name = item.kind === 'tool' && item.toolKey ? tools.get(item.toolKey) : item.employeeKey ? roles.get(item.employeeKey) : undefined;
    if (name) assignments.set(item.key, name);
  }
  return <div className="workflow-preview stack">
    {!draft.workflow ? <p className="helper">{t('legacyStepMap')} <a href="#knowledge?view=analysis">{t('reviewDrafts')}</a></p> : null}
    <div className="workflow-diagram-layout">
      <SopGraphView graph={graphFromWorkflow(workflow)} assignments={assignments} selected={selected} onSelect={select} />
      <aside className="workflow-inspector" aria-label={t('stepEvidence')}>
        <h4>{step?.label ?? t('stepEvidence')}</h4>
        {step ? <>
          {step.detail ? <p>{step.detail}</p> : null}
          {role ? <p className="helper">{t('employeeRef')} · {role}</p> : null}
          {tool ? <p className="helper">{t('toolRef')} · {tool}</p> : null}
          <Evidences ev={step.citations.length ? step.citations.flatMap(reference => draft.evidence[reference - 1] ?? []) : draft.evidence} label={t('stepEvidence')} />
        </> : <p className="helper">{t('selectStep')}</p>}
      </aside>
    </div>
  </div>;
}

function SopWorkspace({ knowledge, retryKnowledge, initialSop, candidate }: DraftViewProps & { initialSop: string; candidate: string }) {
  const t = useT(TEXT);
  const [sops, setSops] = useState<SopSummary[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [sopId, setSopId] = useState(initialSop);
  const [newSopId, setNewSopId] = useState('');
  const [versions, setVersions] = useState<SopVersionView[]>([]);
  const [tools, setTools] = useState<ToolRow[]>([]);
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [draft, setDraft] = useState<SopGraph>({ nodes: [], edges: [] });
  const [pack, setPack] = useState<SopPack | undefined>();
  const [workflow, setWorkflow] = useState({ title: '', completion: '' });
  const [rules, setRules] = useState<RulesForm>(rulesFrom(undefined));
  const [applyingPack, setApplyingPack] = useState(false);
  const [pendingPack, setPendingPack] = useState<SopPack | undefined>();
  const [selected, setSelected] = useState<string>();
  const [effectiveAt, setEffectiveAt] = useState('');
  const [msg, setMsg] = useState('');

  const loadList = useCallback(async () => {
    setUnavailable(false);
    try {
      const r = await api<{ sops: SopSummary[] }>('/api/v1/sop', { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
      if (r.status !== 200 || !Array.isArray(r.body?.sops)) throw new Error('SOP list unavailable');
      setSops(r.body.sops);
    } catch {
      setUnavailable(true);
    }
  }, []);

  useEffect(() => {
    void loadList();
    void api<ToolRow[]>('/api/v1/tools/').then((r) => r.status === 200 && setTools(r.body)).catch(() => undefined);
    void api<EmployeeRow[]>('/api/v1/employees/').then((r) => r.status === 200 && setEmployees(r.body)).catch(() => undefined);
  }, [loadList]);

  const loadVersions = useCallback(async (id: string) => {
    const r = await api<{ versions: SopVersionView[] }>(`/api/v1/sop/${encodeURIComponent(id)}/versions`);
    const list = r.status === 200 && Array.isArray(r.body.versions) ? [...r.body.versions].sort((a, b) => b.number - a.number) : [];
    setVersions(list);
    const editable = list.find((v) => v.status !== 'published') ?? list.find((v) => v.status === 'published');
    setDraft(structuredClone(editable?.definition.graph ?? { nodes: [], edges: [] }));
    setPack(editable?.definition.pack ? structuredClone(editable.definition.pack) : undefined);
    setRules(rulesFrom(editable?.definition));
    setWorkflow(editable?.definition.workflow ?? { title: editable?.definition.pack?.name ?? '', completion: '' });
    setPendingPack(undefined);
    setSelected(undefined);
  }, []);

  useEffect(() => {
    if (sopId) void loadVersions(sopId);
  }, [sopId, loadVersions]);

  const ctx = useMemo<SopGraphContext>(
    () => ({ employees: employeeContext(employees), tools: Object.fromEntries(tools.map((t) => [t.toolId, { stage: t.stage, effect: t.effect }])) }),
    [employees, tools],
  );
  const issues = useMemo(() => validateSopGraph(draft, ctx), [draft, ctx]);
  const published = versions.find((v) => v.status === 'published');
  const openDraft = versions.find((v) => v.status !== 'published');
  const saved = openDraft ?? published;
  const dirty =
    !!saved &&
    (JSON.stringify(saved.definition.graph ?? { nodes: [], edges: [] }) !== JSON.stringify(draft) ||
      JSON.stringify(saved.definition.pack ?? null) !== JSON.stringify(pack ?? null) ||
      JSON.stringify(rulesFrom(saved.definition)) !== JSON.stringify(rules) ||
      JSON.stringify(saved.definition.workflow ?? { title: saved.definition.pack?.name ?? '', completion: '' }) !== JSON.stringify(workflow));
  const vstate = validationState(openDraft, dirty);
  const unconfirmed = unconfirmedItems(pack);
  const recs = knowledge.status === 'ready' ? knowledge.drafts.recommendations : [];
  const packs = recs.filter(r => r.kind === 'sop' && r.evidence.length && (!candidate || r.key === candidate)).map(packFromRecommendation);
  const privateWorkflows = knowledge.status === 'ready' && knowledge.drafts.mcpRecommendations.some(draft => draft.kind === 'sop');
  const impact = knowledge.status === 'ready' ? knowledgeImpact(pack, recs) : [];
  const node = draft.nodes.find((n) => n.id === selected);
  const employeeNames = new Map(employees.map(item => [item.id, item.name]));
  const toolNames = new Map(tools.map(item => [item.toolId, item.name]));
  function assignmentsOf(graph: SopGraph) {
    const assignments = new Map<string, string>();
    for (const item of graph.nodes) {
      if (!item.ref) continue;
      const name = item.kind === 'tool' ? toolNames.get(item.ref) : item.kind === 'employee' ? employeeNames.get(item.ref) : undefined;
      if (name) assignments.set(item.id, name);
    }
    return assignments;
  }
  const canValidate = !!openDraft && !dirty && draft.nodes.every(node => node.label.trim()) && !issues.length && !unconfirmed.length;
  const canPublish = canValidate && vstate.kind === 'valid';

  async function save(graph = draft, nextPack = pack, forSop = sopId, metadata = workflow) {
    const base = forSop === sopId ? (openDraft ?? published) : undefined;
    const definition = { ...(base?.definition ?? { employeeStatus: 'active' }), ...rulesTo(rules), graph, workflow: metadata, pack: nextPack ?? null };
    const r = base
      ? await api<SopVersionView>(`/api/v1/sop/drafts/${encodeURIComponent(base.id)}`, { method: 'PUT', body: JSON.stringify({ definition }) })
      : await api<SopVersionView>('/api/v1/sop/drafts', { method: 'POST', body: JSON.stringify({ sopId: forSop, definition }) });
    setMsg(r.status === 200 ? `已保存为草稿 v${r.body.number}；已发布版本不受影响` : `未保存（${r.status}）`);
    if (r.status === 200) {
      await loadList();
      if (forSop !== sopId) setSopId(forSop);
      else await loadVersions(forSop);
    }
  }

  async function validate() {
    if (!openDraft) return;
    const r = await api<{ status?: string; error?: string; issues?: { message: string }[] }>(`/api/v1/sop/${encodeURIComponent(openDraft.id)}/validate`, {
      method: 'POST',
      body: JSON.stringify({ employees: ctx.employees, tools: ctx.tools }),
    });
    await loadVersions(sopId);
    setMsg(r.status === 200 ? (r.body.status === 'passed' ? '校验通过，可以发布' : '校验未通过，见回归用例') : `未校验：${r.body.issues?.map((i) => i.message).join('；') || r.body.error || r.status}`);
  }

  async function publish() {
    if (!openDraft) return;
    const r = await api<SopVersionView & { error?: string; issues?: { message: string }[] }>(`/api/v1/sop/${encodeURIComponent(openDraft.id)}/publish`, {
      method: 'POST',
      body: JSON.stringify({ ...(effectiveAt ? { effectiveAt: new Date(effectiveAt).toISOString() } : {}), employees: ctx.employees, tools: ctx.tools }),
    });
    await loadVersions(sopId); // reload first: it resets the editor state
    setMsg(r.status === 200 ? `v${r.body.number} 已发布；在途实例继续按原版本运行` : `未发布：${r.body.issues?.map((i) => i.message).join('；') || (r.body.error === 'validation_stale' ? '校验已失效，请重新校验' : r.body.error) || r.status}`);
  }

  /** Applying a pack never touches a published version and never replaces a non-empty draft without confirmation. */
  function requestPack(p: SopPack) {
    if (sopId && draft.nodes.length && openDraft) setPendingPack(p);
    else void applyPack(p);
  }
  async function applyPack(p: SopPack) {
    if (!p.workflow || applyingPack) return;
    setApplyingPack(true);
    setPendingPack(undefined);
    try {
      const target = sopId || newSopId.trim() || `sop.${p.key}`;
      const fresh = structuredClone(p);
      const organization = await confirmedOrganization(p.key);
      const employeeRefs = new Map<string, string>();
      const toolRefs = new Map<string, string>();
      for (const employee of organization?.employees ?? []) {
        if (employee.employeeId && !employee.privateSource) employeeRefs.set(employee.key, employee.employeeId);
      }
      for (const tool of organization?.tools ?? []) {
        if (tool.toolId && !tool.privateSource) toolRefs.set(tool.key, tool.toolId);
      }
      const graph = graphFromWorkflow(p.workflow, { employees: employeeRefs, tools: toolRefs });
      await save(graph, fresh, target, { title: fresh.name, completion: p.workflow.completion ?? '' });
    } catch {
      setMsg(t('importFailed'));
    } finally {
      setApplyingPack(false);
    }
  }

  return (
    <div className="sop-workspace">
      <section className="panel stack">
        {unavailable ? <div className="draft-load-error">
          <p className="warn" role="alert">{t('sopError')}</p>
          <button type="button" className="btn" onClick={() => void loadList()}>{t('retry')}</button>
        </div> : sops === null ? <p className="helper" role="status">{t('loadingSops')}</p> : null}
        <label className="field">
          <span>{t('chooseWorkflow')}</span>
          <select disabled={sops === null || unavailable || applyingPack} value={sopId} onChange={(e) => setSopId(e.target.value)}>
            <option value="">{t('workflowPlaceholder')}</option>
            {sops?.map((s) => (
              <option key={s.sopId} value={s.sopId}>{s.sopId}{s.latest ? `（v${s.latest.number} ${STATUS_LABEL[s.latest.status]}）` : ''}</option>
            ))}
          </select>
        </label>
        {!sopId ? (
          <label className="field">
            <span>{t('workflowKey')}</span>
            <input value={newSopId} onChange={(e) => setNewSopId(e.target.value)} placeholder={t('workflowKeyPlaceholder')} />
          </label>
        ) : null}
      </section>

      <section className="panel stack" aria-label={t('workflowPacks')}>
        <h2 className="h2">{t('workflowPackTitle')}</h2>
        <DraftLoadStatus knowledge={knowledge} retryKnowledge={retryKnowledge} />
        {knowledge.status === 'ready' && !packs.length ? <p className="helper">{t('noWorkflowPacks')}</p> : null}
        {privateWorkflows ? <a href="#brain?type=sop">{t('viewPrivateWorkflows')}</a> : null}
        <ul className="onto-list">
          {packs.map((p) => (
            <li key={p.key} data-pack={p.key}>
              <strong>{p.name}</strong>
              {p.workflow ? <button className="btn" type="button" disabled={sops === null || unavailable || applyingPack} onClick={() => requestPack(p)}>{t(applyingPack ? 'importingWorkflow' : 'applyPack')}</button>
                : <p className="helper">{t('noStepMap')} <a href="#knowledge?view=analysis">{t('reviewDrafts')}</a></p>}
            </li>
          ))}
        </ul>
        {pendingPack ? (
          <div className="warn" role="alertdialog" aria-label="确认替换草稿">
            <p>将用流程包「{pendingPack.name}」替换当前草稿 v{openDraft?.number} 的内容。已发布版本不受影响。</p>
            <button className="btn primary" type="button" onClick={() => void applyPack(pendingPack)}>确认替换</button>
            <button className="btn" type="button" onClick={() => setPendingPack(undefined)}>取消</button>
          </div>
        ) : null}
      </section>

      {sopId ? (
        <>
          <section className="panel stack" aria-label="版本">
            <h2 className="h2">版本</h2>
            <table className="versions">
              <thead>
                <tr><th>版本</th><th>状态</th><th>生效</th><th>在途实例</th></tr>
              </thead>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.id} data-version={v.number}>
                    <td>v{v.number}</td>
                    <td>{STATUS_LABEL[v.status]}</td>
                    <td>{v.effectiveAt ? new Date(v.effectiveAt).toLocaleString() : '—'}</td>
                    <td>{v.runningInstances}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="helper">修改总是在草稿上进行，不会改动已发布版本；发布新版本后，在途实例继续按原版本运行。</p>
            {openDraft && published?.definition.graph ? <details className="workflow-published">
              <summary>{t('publishedFlow')} · v{published.number}</summary>
              <SopGraphView graph={published.definition.graph} assignments={assignmentsOf(published.definition.graph)} />
            </details> : null}
          </section>

          <section className="panel stack" aria-label="流程图">
            <h2 className="h2">{openDraft ? `草稿 v${openDraft.number}` : published ? `已发布 v${published.number}（编辑将新建草稿）` : '新流程草稿'}</h2>
            <div className="agent-fields">
              <label className="field"><span>{t('workflowTitle')}</span>
                <input maxLength={160} value={workflow.title} onChange={event => setWorkflow({ ...workflow, title: event.target.value })} />
              </label>
              <label className="field"><span>{t('completion')}</span>
                <input maxLength={1000} value={workflow.completion} onChange={event => setWorkflow({ ...workflow, completion: event.target.value })} />
              </label>
            </div>
            <div className="workflow-diagram-layout">
              <SopGraphView graph={draft} assignments={assignmentsOf(draft)} issues={issues} selected={selected} onSelect={setSelected} />
              {node ? <NodeDetail node={node} tools={tools} employees={employees}
                step={pack?.workflow?.steps.find(step => step.key === node.id)}
                evidence={pack?.items.find(item => item.id === pack.key + ':step:' + node.id)?.evidence}
                onChange={next => setDraft(graph => ({ ...graph, nodes: graph.nodes.map(item => item.id === next.id ? next : item) }))}
                onRemove={() => {
                  setDraft(graph => ({
                    nodes: graph.nodes.filter(item => item.id !== node.id),
                    edges: graph.edges.filter(edge => edge.from !== node.id && edge.to !== node.id),
                  }));
                  setSelected(undefined);
                }} /> : <aside className="workflow-inspector"><p className="helper">{t('selectStep')}</p></aside>}
            </div>
            <GraphEditor graph={draft} tools={tools} employees={employees} onChange={setDraft} />
            <fieldset className="pack-items" aria-label="运行规则">
              <legend>运行规则（校验时用作回归用例的输入）</legend>
              <label className="field">
                <span>必填字段（逗号分隔，缺少时停下补充）</span>
                <input aria-label="必填字段" value={rules.requiredFields} onChange={(e) => setRules({ ...rules, requiredFields: e.target.value })} placeholder="例如 发票号, 金额" />
              </label>
              <label className="field">
                <span>超阈值转人工：字段</span>
                <input aria-label="阈值字段" value={rules.thresholdField} onChange={(e) => setRules({ ...rules, thresholdField: e.target.value })} placeholder="例如 金额" />
              </label>
              <label className="field">
                <span>超阈值转人工：上限</span>
                <input aria-label="阈值上限" inputMode="decimal" value={rules.thresholdMax} onChange={(e) => setRules({ ...rules, thresholdMax: e.target.value })} placeholder="例如 5000" />
              </label>
            </fieldset>
            {pack ? (
              <fieldset className="pack-items" aria-label="流程包确认">
                <legend>核对流程包「{pack.name}」的规则和触发条件</legend>
                {unconfirmed.length > 1 ? <button type="button" className="btn" onClick={() => setPack(current => current && ({
                  ...current, items: current.items.map(item => ({ ...item, confirmed: true })),
                }))}>{t('confirmAllPack')}</button> : null}
                {pack.items.map((it) => (
                  <label key={it.id} className="pack-item" data-item={it.id}>
                    <input
                      type="checkbox"
                      checked={it.confirmed}
                      onChange={(e) => setPack((p) => p && { ...p, items: p.items.map((x) => (x.id === it.id ? { ...x, confirmed: e.target.checked } : x)) })}
                    />
                    <span>{it.kind === 'trigger' ? '触发' : '规则'}：{it.text}</span>
                    <small>{it.evidence.map((e) => e.locator).join('，')}</small>
                  </label>
                ))}
              </fieldset>
            ) : null}
            {impact.length ? (
              <div className="warn" role="region" aria-label="知识变化影响">
                <strong>企业知识已变化，以下内容的依据受影响：</strong>
                <ul>
                  {impact.map((i, k) => (
                    <li key={k} data-impact={i.itemId}>{i.text}（{i.locator}）：依据 {i.from} → {i.to ?? '已不可用'}</li>
                  ))}
                </ul>
                <p>请核对后修改草稿并重新校验。</p>
              </div>
            ) : null}
            <button className="btn" type="button" onClick={() => void save()}>保存草稿</button>
          </section>

          <section className="panel stack" aria-label="校验与发布">
            <h2 className="h2">校验与发布</h2>
            {issues.length ? (
              <ul className="issues" aria-label="结构问题">
                {issues.map((i, k) => <li key={k} data-issue={i.code}>{i.message}</li>)}
              </ul>
            ) : <p className="helper">结构检查通过。</p>}
            {unconfirmed.length ? <p className="warn" data-block="pack">流程包还有 {unconfirmed.length} 项规则或触发未确认，确认并保存后才能校验和发布。</p> : null}
            {vstate.kind === 'dirty' ? <p className="warn" data-block="dirty">有未保存的修改：保存后需要重新校验。</p> : null}
            {vstate.kind === 'stale' ? <p className="warn" data-block="stale">草稿已修改，之前的校验已失效（校验于第 {vstate.validatedRevision} 次修订，当前第 {vstate.revision} 次）。请重新校验。</p> : null}
            {vstate.kind === 'incomplete' ? <p className="warn" data-block="incomplete">校验缺少回归用例：{vstate.missing.map((m) => GATE_LABEL[m] ?? m).join('，')}。不能发布。</p> : null}
            {vstate.kind === 'failed' ? <p className="warn" data-block="failed">校验未通过，修改后重新校验。</p> : null}
            <button className="btn" type="button" disabled={!canValidate} onClick={() => void validate()}>校验（运行回归用例）</button>
            {openDraft?.report ? (
              <ul className="gates" aria-label="回归用例">
                {Object.entries(openDraft.report.gates).map(([k, g]) => (
                  <li key={k} className={g.ok ? 'ok' : 'fail'} data-gate={k}>{g.ok ? '✓' : '✗'} {GATE_LABEL[k] ?? k}{g.detail ? `：${g.detail}` : ''}</li>
                ))}
              </ul>
            ) : null}
            <label className="field">
              <span>生效时间（可选）</span>
              <input type="datetime-local" value={effectiveAt} onChange={(e) => setEffectiveAt(e.target.value)} />
            </label>
            <button className="btn primary" type="button" disabled={!canPublish} onClick={() => void publish()}>发布</button>
            {!openDraft ? <p className="helper">先保存草稿，再校验和发布。</p> : null}
          </section>

          {published ? <a className="btn" href={`#room?workflow=${encodeURIComponent(sopId)}`}>{t('runWorkflow')}</a> : null}
          <ExecutionsPanel sopId={sopId} publishedVersionId={published?.id ?? null} />
        </>
      ) : null}
      {msg ? <p className="helper" role="status">{msg}</p> : null}
    </div>
  );
}

function NodeDetail({ node, tools, employees, step, evidence, onChange, onRemove }: {
  node: SopGraph['nodes'][number]; tools: ToolRow[]; employees: EmployeeRow[];
  step?: RecommendedWorkflow['steps'][number]; evidence?: Evidence[];
  onChange: (node: SopGraph['nodes'][number]) => void; onRemove: () => void;
}) {
  const t = useT(TEXT);
  const tool = node.kind === 'tool' ? tools.find(item => item.toolId === node.ref) : undefined;
  const employee = node.kind === 'employee' ? employees.find(item => item.id === node.ref) : undefined;
  const options = node.kind === 'tool' ? tools.map(item => ({ key: item.toolId, label: item.name }))
    : node.kind === 'employee' ? employees.map(item => ({ key: item.id, label: item.name })) : null;
  return <aside className="workflow-inspector" aria-label={t('stepDetails')}>
    <label className="field"><span>{t('stepName')}</span>
      <input value={node.label} maxLength={160} onChange={event => onChange({ ...node, label: event.target.value })} />
    </label>
    {step?.detail ? <p>{step.detail}</p> : null}
    {options ? <label className="field">
      <span>{t(node.kind === 'tool' ? 'toolRef' : 'employeeRef')}</span>
      <select value={node.ref ?? ''} onChange={event => onChange({ ...node, ref: event.target.value || undefined })}>
        <option value="">{t('unresolvedRef')}</option>
        {node.ref && !options.some(item => item.key === node.ref) ? <option value={node.ref}>{node.ref}</option> : null}
        {options.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
      </select>
    </label> : null}
    {tool ? <p className="helper">{t('currentStage', { stage: tool.stage })} · {tool.effect} · <a href="#tools">{t('openTool')}</a></p> : null}
    {employee ? <p className="helper">{employee.status} · <a href="#employees">{t('openEmployee')}</a></p> : null}
    {evidence?.length ? <Evidences ev={evidence} label={t('stepEvidence')} /> : null}
    <button className="btn" type="button" onClick={onRemove}>{t('closeNode')}</button>
  </aside>;
}

function GraphEditor({ graph, tools, employees, onChange }: { graph: SopGraph; tools: ToolRow[]; employees: EmployeeRow[]; onChange: (g: SopGraph) => void }) {
  const [kind, setKind] = useState<SopNodeKind>('agent');
  const [label, setLabel] = useState('');
  const [ref, setRef] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  function addNode(e: FormEvent) {
    e.preventDefault();
    let n = graph.nodes.length + 1;
    while (graph.nodes.some((x) => x.id === `n${n}`)) n++;
    onChange({ ...graph, nodes: [...graph.nodes, { id: `n${n}`, kind, label: label.trim() || KIND_LABEL[kind], ...(ref ? { ref } : {}) }] });
    setLabel('');
    setRef('');
  }
  function addEdge(e: FormEvent) {
    e.preventDefault();
    if (!from || !to || graph.edges.some((x) => x.from === from && x.to === to)) return;
    onChange({ ...graph, edges: [...graph.edges, { from, to }] });
  }
  const refOptions = kind === 'tool' ? tools.map((t) => ({ id: t.toolId, label: `${t.name}（${t.stage}）` })) : kind === 'employee' ? employees.map((x) => ({ id: x.id, label: x.name })) : [];
  return (
    <div className="graph-editor">
      <form className="row" onSubmit={addNode} aria-label="添加节点">
        <select aria-label="节点类型" value={kind} onChange={(e) => (setKind(e.target.value as SopNodeKind), setRef(''))}>
          {SOP_NODE_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
        <input aria-label="节点名称" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="名称" />
        {refOptions.length ? (
          <select aria-label="引用" value={ref} onChange={(e) => setRef(e.target.value)}>
            <option value="">选择{KIND_LABEL[kind]}</option>
            {refOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        ) : kind === 'trigger' ? <input aria-label="引用" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="来源或日期规则" /> : null}
        <button className="btn" type="submit">添加节点</button>
      </form>
      <form className="row" onSubmit={addEdge} aria-label="添加连线">
        <select aria-label="从" value={from} onChange={(e) => setFrom(e.target.value)}>
          <option value="">从…</option>
          {graph.nodes.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
        </select>
        <select aria-label="到" value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">到…</option>
          {graph.nodes.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
        </select>
        <button className="btn" type="submit">添加连线</button>
      </form>
    </div>
  );
}

function OntologyView({ knowledge, retryKnowledge }: DraftViewProps) {
  if (knowledge.status !== 'ready') return <DraftLoadStatus knowledge={knowledge} retryKnowledge={retryKnowledge} />;
  const { recommendations, mcpRecommendations } = knowledge.drafts;
  return <OntologyGraphView
    shared={recommendations.filter(item => item.evidence.length > 0)}
    personal={mcpRecommendations.filter(item => item.evidence.length > 0)}
  />;
}

function Evidences({ ev, label = '依据' }: { ev: Evidence[]; label?: string }) {
  return (
    <ul className="evidence" aria-label={label}>
      {ev.map((e, i) => <li key={i}><cite>{e.locator}</cite> “{e.quote}”</li>)}
    </ul>
  );
}
