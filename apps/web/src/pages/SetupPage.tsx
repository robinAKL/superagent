import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useT, type Dict, type Vars } from '../i18n';
import { WorkerConnectPanel } from './WorkerConnectPanel';
import { CompanyContextPanel } from './CompanyContextPanel';
import './SetupPage.css';

interface LlmStatus {
  status: string;
  provider: string | null;
  keyLast4: string | null;
  primaryModel: string | null;
  economyModel: string | null;
  monthlyCapMicroUsd: number | null;
  reminder: string | null;
}
interface TestResponse {
  auth: string;
  listing: string;
  tools: string;
  selectable: string[];
}

const TEXT = {
  en: {
    title: 'Settings', lead: 'The company, the model and its budget, computers and the audit trail, in the order they are set up.', companyLink: 'Company profile and boundaries',
    tabRun: 'Runtime settings', tabAudit: 'Audit log', tabArch: 'Architecture',
    sectionsNav: 'Settings sections', secCompany: 'Company', secModel: 'Model and usage', secComputers: 'Computers', secDanger: 'Danger zone',
    auditLead: 'Append-only events. Secrets and source text are never shown.',
    auditEmpty: 'No model-configuration events on this page yet. Status above is the current runtime setting.',
    auditStatus: 'Current model status',
    archLead: 'How the workbench, control plane and workers stay separate.',
    archWorkbench: 'Workbench', archWorkbenchBody: 'People use seven entries. Closing a window does not stop the control plane.',
    archControl: 'Control plane', archControlBody: 'Tasks, leases and audit stay in the server. Agents are started only when there is work.',
    archWorker: 'Workers', archWorkerBody: 'A worker identity can be reachable without a model occupying a seat. Unconnected roles never appear online.',
    connection: 'Model connection', budget: 'Monthly usage cap',
    providerAnthropic: 'Anthropic (Claude)', providerOpenai: 'OpenAI (GPT)', providerAzure: 'Azure OpenAI',
    statusUnconfigured: 'Not configured', statusConfigured: 'Configured', statusRevoked: 'Revoked', statusKeyInvalid: 'Key invalid',
    status: 'Status: ', loading: 'Loading…', statusUnavailable: 'Could not load model settings.',
    primaryModelIs: ' · Primary model {model}', economyModelIs: ' · Economy model {model}',
    provider: 'Provider', apiKey: 'API key', keyStored: 'Saved securely in Key Vault after activation.',
    modelId: 'Model ID', deploymentName: 'Deployment name', testConnection: 'Test connection', testing: 'Testing…',
    choose: 'Choose a model', primaryModel: 'Primary model', economyModel: 'Economy model', sameAsPrimary: 'Same as primary model',
    advanced: 'Model options', connected: 'Credentials verified',
    ready: '{model} is selected as the primary model.',
    chooseVerified: 'Choose a verified primary model to continue.',
    noVerified: '{model} is awaiting platform verification. No verified model is available for activation.',
    toolIncomplete: 'The tool test ended before the model responded. Try testing again.',
    toolFailed: 'The tool test did not return the expected result.',
    listingFailed: 'The provider did not return the full model list.',
    invalidKey: 'Authentication: Invalid key', quota: 'The provider rejected the test due to quota or rate limits.',
    network: 'Could not reach the provider. Check the endpoint and try again.',
    testError: 'The provider did not accept the test. Check the model ID or Azure deployment name.',
    saveActivate: 'Save and apply', saving: 'Saving…', activated: 'Model saved and active.',
    notActivated: 'Could not activate the model. Test the connection again and retry.',
    requestFailed: 'Request failed. Try again.',
    capCurrent: 'Current cap: {value}', capValue: 'US${amount} / month', capUnset: 'Not set (model calls will be refused)',
    capNew: 'New cap (USD, up to two decimals)', saveCap: 'Save cap',
    capSaved: 'Saved; applies to this month right away', capNotSaved: 'Not saved: Enter a positive USD amount with up to two decimals.',
    resetHeading: 'Reset tenant knowledge base',
    resetLead: 'Delete this tenant’s knowledge documents, excerpts, analyses, drafts, ontology, SOP drafts and rules. Accounts, company info and MCP connections are kept.',
    resetAction: 'Reset tenant knowledge base',
    resetPreviewLoading: 'Loading preview…',
    resetDialogTitle: 'Confirm tenant knowledge base reset',
    resetDialogBody: 'This permanently deletes the following items for this tenant:',
    resetCounts: 'Sources: {sources} · Excerpts: {chunks} · Analyses: {analyses} · SOP drafts: {sops} · Rules: {rules} · Ontology: {ontology} · Other drafts: {otherDrafts}',
    resetPreserved: 'Preserved: accounts, company info{company}, {connections} source/MCP connection(s), and global SOP versions without tenant ownership.',
    resetPrompt: 'Type RESET or {target} to confirm',
    resetPromptOnly: 'Type RESET to confirm',
    resetConfirmBtn: 'Confirm reset',
    resetCancelBtn: 'Cancel',
    resetting: 'Resetting…',
    resetDone: 'Tenant knowledge base cleared. Return to Enterprise Knowledge to upload materials and run analysis.',
    resetFailed: 'Could not reset the knowledge base. Check permissions and try again.',
  },
  zh: {
    title: '管理设置', lead: '企业信息、模型与用量、电脑和审计，按设置的先后排列。', companyLink: '企业信息与工作边界',
    tabRun: '运行设置', tabAudit: '审计记录', tabArch: '架构说明',
    sectionsNav: '设置分区', secCompany: '企业', secModel: '模型与用量', secComputers: '电脑', secDanger: '危险区',
    auditLead: '只追加、不可改。密钥和原文不会出现在这里。',
    auditEmpty: '本页还没有列出模型配置事件。上方状态就是当前运行设置。',
    auditStatus: '当前模型状态',
    archLead: '工作台、控制面和 worker 分开，关掉窗口不会停后台。',
    archWorkbench: '工作台', archWorkbenchBody: '负责人七个入口。关掉窗口不等于停止控制面。',
    archControl: '控制面', archControlBody: '任务、租约和审计留在服务端。有任务时才拉起 agent。',
    archWorker: 'Worker', archWorkerBody: '身份可达不必占模型座位。未连接的岗位不会显示在线。',
    connection: '模型连接', budget: '月度用量上限',
    providerAnthropic: 'Anthropic（Claude）', providerOpenai: 'OpenAI（GPT）', providerAzure: 'Azure OpenAI',
    statusUnconfigured: '未配置', statusConfigured: '已配置', statusRevoked: '已撤销', statusKeyInvalid: 'Key 失效',
    status: '状态：', loading: '读取中…', statusUnavailable: '无法读取模型设置。',
    primaryModelIs: ' · 主模型 {model}', economyModelIs: ' · 经济模型 {model}',
    provider: '服务商', apiKey: 'API Key', keyStored: '保存生效后，密钥将存入 Key Vault。',
    modelId: '模型 ID', deploymentName: '部署名', testConnection: '测试连接', testing: '测试中…',
    choose: '请选择模型', primaryModel: '主模型', economyModel: '经济模型', sameAsPrimary: '与主模型相同',
    advanced: '模型选项', connected: '凭据验证通过',
    ready: '已选择 {model} 作为主模型。',
    chooseVerified: '请选择一个已验证的主模型。',
    noVerified: '{model} 仍待平台验证，当前没有可启用的已验证模型。',
    toolIncomplete: '模型还未返回工具调用，测试就达到了输出上限。可以重新测试。',
    toolFailed: '工具测试没有返回预期结果。',
    listingFailed: '服务商未返回完整模型列表。',
    invalidKey: '认证：Key 无效', quota: '服务商因额度或频率限制拒绝了测试。',
    network: '无法连接服务商，请检查地址后重试。',
    testError: '服务商未接受测试，请检查模型 ID 或 Azure 部署名。',
    saveActivate: '保存并生效', saving: '正在保存…', activated: '模型已保存并生效。',
    notActivated: '模型未能生效，请重新测试连接后再试。',
    requestFailed: '请求失败，请重试。',
    capCurrent: '当前上限：{value}', capValue: 'US${amount} / 月', capUnset: '未设置（模型调用会被拒绝）',
    capNew: '新的上限（美元，最多两位小数）', saveCap: '保存上限',
    capSaved: '已保存，立即对本月生效', capNotSaved: '未保存：请输入大于零且最多含两位小数的美元金额。',
    resetHeading: '清空本租户知识库',
    resetLead: '清空本租户的知识文档、摘录、分析记录、草稿、本体实体/关系、SOP 草案与规则。账号、企业信息和 MCP 连接配置会保留。',
    resetAction: '清空本租户知识库',
    resetPreviewLoading: '正在统计将删除的数据…',
    resetDialogTitle: '确认清空本租户知识库',
    resetDialogBody: '此操作不可恢复，将清空本租户以下数据：',
    resetCounts: '知识源 {sources} · 摘录 {chunks} · 分析 {analyses} · SOP 草案 {sops} · 规则 {rules} · 本体 {ontology} · 其他草案 {otherDrafts}',
    resetPreserved: '保留：账号、企业信息{company}、{connections} 个来源/MCP 连接配置，以及无法证明租户归属的全局 SOP 版本。',
    resetPrompt: '输入 RESET 或「{target}」以确认清空',
    resetPromptOnly: '输入 RESET 以确认清空',
    resetConfirmBtn: '确认清空',
    resetCancelBtn: '取消',
    resetting: '正在清空…',
    resetDone: '已清空本租户知识库，可前往「企业知识」重新上传资料并分析。',
    resetFailed: '清空知识库失败，请检查管理员权限后重试。',
  },
} satisfies Dict<string>;
type Key = keyof typeof TEXT.en;
type Notice = { key: Key; error?: boolean; vars?: Vars };
const PROVIDERS: { id: string; label: Key }[] = [
  { id: 'anthropic', label: 'providerAnthropic' },
  { id: 'openai', label: 'providerOpenai' },
  { id: 'azure-openai', label: 'providerAzure' },
];
const STATUS: Record<string, Key> = { unconfigured: 'statusUnconfigured', configured: 'statusConfigured', revoked: 'statusRevoked', key_invalid: 'statusKeyInvalid' };
const AUTH_ERROR: Record<string, Key> = { invalid_key: 'invalidKey', quota: 'quota', network: 'network' };

interface ResetPreview {
  tenantId: string;
  companyName: string;
  counts: {
    sources: number;
    chunks: number;
    analyses: number;
    sops: number;
    rules: number;
    ontology: number;
    otherDrafts: number;
    parseJobs: number;
    sopVersions: number;
    preserved: { connections: number; mcpUsers: number };
  };
}
type SetupSection = 'company' | 'model' | 'computers' | 'audit' | 'danger';
const SECTIONS: readonly SetupSection[] = ['company', 'model', 'computers', 'audit', 'danger'];
const ADMIN_SECTIONS = new Set<SetupSection>(['company', 'computers', 'danger']);
const SECTION_LABELS = { company: 'secCompany', model: 'secModel', computers: 'secComputers', audit: 'tabAudit', danger: 'secDanger' } as const;
/** Old links (?tab=audit) and section links (?section=…) open the page at that section. */
function requestedSection(): SetupSection | null {
  const params = new URLSearchParams(typeof window === 'undefined' ? undefined : window.location.hash.split('?')[1]);
  const wanted = params.get('section') ?? params.get('tab');
  return SECTIONS.find(section => section === wanted) ?? null;
}

export function SetupPage() {
  const t = useT(TEXT);
  // The section in view is the highlighted one in the menu (the room's "you are here" look).
  const [current, setCurrent] = useState<SetupSection>(() => requestedSection() ?? 'company');
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      const top = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      const id = top?.target.id.replace(/^settings-/, '') as SetupSection | undefined;
      if (id && SECTIONS.includes(id)) setCurrent(id);
    }, { rootMargin: '-20% 0px -60% 0px' });
    const timer = window.setTimeout(() => {
      for (const section of SECTIONS) { const el = document.getElementById(`settings-${section}`); if (el) observer.observe(el); }
    }, 400);
    return () => { window.clearTimeout(timer); observer.disconnect(); };
  }, []);
  useEffect(() => {
    const jump = () => { const section = requestedSection(); if (section) document.getElementById(`settings-${section}`)?.scrollIntoView({ block: 'start' }); };
    const timer = window.setTimeout(jump, 300);
    window.addEventListener('hashchange', jump);
    return () => { window.clearTimeout(timer); window.removeEventListener('hashchange', jump); };
  }, []);
  const [status, setStatus] = useState<LlmStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [form, setForm] = useState({ provider: 'anthropic', apiKey: '', endpoint: '', probeModel: '' });
  const [test, setTest] = useState<TestResponse | null>(null);
  const [primary, setPrimary] = useState('');
  const [economy, setEconomy] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [capUsd, setCapUsd] = useState('');
  const [capNotice, setCapNotice] = useState<Notice | null>(null);
  const [pending, setPending] = useState<'test' | 'activate' | 'budget' | 'resetPreview' | 'reset' | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [resetPreview, setResetPreview] = useState<ResetPreview | null>(null);
  const [resetConfirmText, setResetConfirmText] = useState('');
  const [resetNotice, setResetNotice] = useState<Notice | null>(null);

  useEffect(() => {
    let active = true;
    void api<{ viewer?: { roles?: string[] } }>('/api/v1/room/roster').then(response => {
      if (!active || response.status !== 200) return;
      const roles = response.body.viewer?.roles ?? [];
      setIsAdmin(roles.some(role => role === 'admin' || role === 'owner'));
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    void api<LlmStatus>('/api/v1/setup/llm').then(response => {
      if (!active) return;
      if (response.status !== 200) { setLoadFailed(true); return; }
      setStatus(response.body);
      const { provider, primaryModel } = response.body;
      if (provider && primaryModel) setForm(current => current.apiKey || current.probeModel || current.endpoint
        ? current : { ...current, provider, probeModel: primaryModel });
    }).catch(() => { if (active) setLoadFailed(true); });
    return () => { active = false; };
  }, []);

  const { provider, apiKey, endpoint, probeModel } = form;
  const isAzure = provider === 'azure-openai';
  const body = () => ({ provider, apiKey: apiKey.trim(), probeModel: probeModel.trim(), ...(isAzure ? { endpoint: endpoint.trim() } : {}) });
  const change = (field: keyof typeof form, value: string) => {
    setForm(current => ({ ...current, [field]: value }));
    setTest(null);
    setPrimary('');
    setEconomy('');
    setNotice(null);
  };
  const feedback = (value: Notice | null) => value
    ? <p className={value.error ? 'setup-error' : 'setup-success'} role={value.error ? 'alert' : 'status'}>{t(value.key, value.vars)}</p>
    : null;

  async function onTest(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending('test');
    setNotice(null);
    setTest(null);
    setPrimary('');
    setEconomy('');
    try {
      const response = await api<TestResponse>('/api/v1/setup/llm/test', { method: 'POST', body: JSON.stringify(body()) });
      if (response.status !== 200) { setNotice({ key: 'requestFailed', error: true }); return; }
      setTest(response.body);
      setPrimary(response.body.selectable.includes(probeModel.trim()) ? probeModel.trim() : '');
    } catch { setNotice({ key: 'requestFailed', error: true }); }
    finally { setPending(null); }
  }

  async function onActivate() {
    if (pending || !test?.selectable.includes(primary)) return;
    setPending('activate');
    setNotice(null);
    try {
      const response = await api<LlmStatus>('/api/v1/setup/llm', {
        method: 'PUT', body: JSON.stringify({ ...body(), primaryModel: primary, economyModel: economy || undefined }),
      });
      if (response.status !== 200) { setNotice({ key: 'notActivated', error: true }); return; }
      setStatus(response.body);
      setNotice({ key: 'activated' });
    } catch { setNotice({ key: 'requestFailed', error: true }); }
    finally {
      setTest(null);
      setForm(current => ({ ...current, apiKey: '' }));
      setPending(null);
    }
  }

  async function onSaveCap(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending('budget');
    setCapNotice(null);
    try {
      const response = await api<LlmStatus>('/api/v1/setup/llm/budget', { method: 'PUT', body: JSON.stringify({ monthlyCapUsd: Number(capUsd) }) });
      if (response.status !== 200) { setCapNotice({ key: response.status === 400 ? 'capNotSaved' : 'requestFailed', error: true }); return; }
      setStatus(response.body);
      setCapUsd('');
      setCapNotice({ key: 'capSaved' });
    } catch { setCapNotice({ key: 'requestFailed', error: true }); }
    finally { setPending(null); }
  }

  async function onOpenReset() {
    if (pending || !isAdmin) return;
    setPending('resetPreview');
    setResetNotice(null);
    setResetConfirmText('');
    try {
      const response = await api<ResetPreview>('/api/v1/knowledge/reset/preview');
      if (response.status !== 200) { setResetNotice({ key: 'resetFailed', error: true }); return; }
      setResetPreview(response.body);
    } catch { setResetNotice({ key: 'resetFailed', error: true }); }
    finally { setPending(null); }
  }

  const trimmedResetConfirm = resetConfirmText.trim();
  const canConfirmReset = !!resetPreview && (
    trimmedResetConfirm === 'RESET' ||
    (!!resetPreview.companyName && trimmedResetConfirm === resetPreview.companyName)
  );

  async function onConfirmReset(event: FormEvent) {
    event.preventDefault();
    if (pending || !canConfirmReset) return;
    setPending('reset');
    setResetNotice(null);
    try {
      const response = await api<{ ok: boolean }>('/api/v1/knowledge/reset', {
        method: 'POST',
        body: JSON.stringify({ confirmText: trimmedResetConfirm }),
      });
      if (response.status !== 200) { setResetNotice({ key: 'resetFailed', error: true }); return; }
      setResetPreview(null);
      setResetConfirmText('');
      setResetNotice({ key: 'resetDone' });
    } catch { setResetNotice({ key: 'resetFailed', error: true }); }
    finally { setPending(null); }
  }

  const capText = status?.monthlyCapMicroUsd != null ? t('capValue', { amount: (status.monthlyCapMicroUsd / 1_000_000).toFixed(2) }) : t('capUnset');
  const tested = test?.auth === 'ok';
  const available = tested ? test.selectable : [];
  const toolFeedback = test?.tools === 'inconclusive' ? 'toolIncomplete' : test?.tools === 'failed' ? 'toolFailed' : undefined;

  return <div className="setup-page">
    <header className="page-head"><h1>{t('title')}</h1><p>{t('lead')}</p></header>
    {/* One page in the order things are set up (UX plan step 6): company, model and usage, computers, audit,
        and the danger zone last. A section menu jumps; it scrolls rather than changing the route. */}
    <div className="setup-layout">
      <nav className="setup-sections" aria-label={t('sectionsNav')}>
        {SECTIONS.filter(section => isAdmin || !ADMIN_SECTIONS.has(section)).map(section =>
          <button key={section} type="button" className={`btn quiet${section === 'danger' ? ' is-danger' : ''}`} aria-current={current === section ? 'true' : undefined}
            onClick={() => { setCurrent(section); document.getElementById(`settings-${section}`)?.scrollIntoView({ block: 'start' }); }}>{t(SECTION_LABELS[section])}</button>)}
      </nav>
      <div className="setup-body">
    {isAdmin ? <div id="settings-company"><CompanyContextPanel fromOrganization={false} guide={false} /></div> : null}
    <section id="settings-model" className="panel setup-card" aria-labelledby="setup-connection">
      <header className="setup-card-head">
        <h2 id="setup-connection" className="h2">{t('connection')}</h2>
        <p className="helper">
          {t('status')}{status ? t(STATUS[status.status] ?? 'statusUnconfigured') : t(loadFailed ? 'statusUnavailable' : 'loading')}
          {status?.keyLast4 ? ` · Key ••••${status.keyLast4}` : ''}
          {status?.primaryModel ? t('primaryModelIs', { model: status.primaryModel }) : ''}
          {status?.economyModel ? t('economyModelIs', { model: status.economyModel }) : ''}
        </p>
      </header>
      {status?.reminder ? <p className="warn">{status.reminder}</p> : null}
      <form onSubmit={onTest}>
        <fieldset disabled={!!pending} className="setup-fields">
          <label className="field"><span>{t('provider')}</span>
            <select value={provider} onChange={e => change('provider', e.target.value)}>{PROVIDERS.map(p => <option key={p.id} value={p.id}>{t(p.label)}</option>)}</select>
          </label>
          <label className="field"><span>{t(isAzure ? 'deploymentName' : 'modelId')}</span>
            <input value={probeModel} onChange={e => change('probeModel', e.target.value)} required />
          </label>
          {isAzure ? <label className="field setup-wide"><span>Endpoint</span>
            <input type="url" value={endpoint} onChange={e => change('endpoint', e.target.value)} placeholder="https://<resource>.openai.azure.com" required />
          </label> : null}
          <label className="field setup-wide"><span>{t('apiKey')}</span>
            <input type="password" autoComplete="off" value={apiKey} onChange={e => change('apiKey', e.target.value)} required aria-describedby="setup-key-note" />
          </label>
        </fieldset>
        <div className="setup-actions"><button className="btn" disabled={!!pending} type="submit">{t(pending === 'test' ? 'testing' : 'testConnection')}</button>
          <small id="setup-key-note" className="helper">{t('keyStored')}</small>
        </div>
      </form>
      {feedback(notice)}
      {test && !tested ? <p className="setup-error" role="alert">{t(AUTH_ERROR[test.auth] ?? 'testError')}</p> : null}
      {tested ? <div className="setup-result">
        <p className="setup-success" role="status">{t('connected')}</p>
        {available.length ? <>
          {primary ? <p>{t('ready', { model: primary })}</p> : <p>{t('chooseVerified')}</p>}
          {!primary || available.length > 1 ? <details open={!primary || undefined}>
            <summary>{t('advanced')}</summary>
            <div className="setup-fields">
              <label className="field"><span>{t('primaryModel')}</span><select value={primary} disabled={!!pending} onChange={e => setPrimary(e.target.value)}>
                <option value="">{t('choose')}</option>{available.map(model => <option key={model} value={model}>{model}</option>)}
              </select></label>
              {available.length > 1 ? <label className="field"><span>{t('economyModel')}</span><select value={economy} disabled={!!pending} onChange={e => setEconomy(e.target.value)}>
                <option value="">{t('sameAsPrimary')}</option>{available.map(model => <option key={model} value={model}>{model}</option>)}
              </select></label> : null}
            </div>
          </details> : null}
          <button className="btn primary" type="button" disabled={!primary || !!pending} onClick={() => void onActivate()}>{t(pending === 'activate' ? 'saving' : 'saveActivate')}</button>
        </> : <p>{t(available.length === 0 && toolFeedback ? toolFeedback : 'noVerified', { model: probeModel.trim() })}</p>}
        {available.length > 0 && toolFeedback ? <p className="helper">{t(toolFeedback)}</p> : null}
        {test.listing !== 'ok' ? <p className="helper">{t('listingFailed')}</p> : null}
      </div> : null}
    </section>
    <form className="panel setup-card" onSubmit={onSaveCap} aria-labelledby="setup-budget">
      <header className="setup-card-head">
        <h2 id="setup-budget" className="h2">{t('budget')}</h2>
        <p className="helper">{t('capCurrent', { value: capText })}</p>
      </header>
      <div className="setup-actions setup-budget-controls">
        <label className="field"><span>{t('capNew')}</span><input inputMode="decimal" value={capUsd} onChange={e => setCapUsd(e.target.value)} disabled={!!pending} required /></label>
        <button className="btn" type="submit" disabled={!!pending}>{t(pending === 'budget' ? 'saving' : 'saveCap')}</button>
      </div>
      {feedback(capNotice)}
    </form>
    {isAdmin ? <div id="settings-computers"><WorkerConnectPanel /></div> : null}
    <section id="settings-audit" className="panel setup-card" aria-labelledby="setup-audit">
      <h2 id="setup-audit" className="h2">{t('tabAudit')}</h2>
      <p className="helper">{t('auditLead')}</p>
      <dl className="setup-audit">
        <dt>{t('auditStatus')}</dt>
        <dd>{status ? t(STATUS[status.status] ?? 'statusUnconfigured') : t(loadFailed ? 'statusUnavailable' : 'loading')}
          {status?.keyLast4 ? ` · Key ••••${status.keyLast4}` : ''}
          {status?.primaryModel ? t('primaryModelIs', { model: status.primaryModel }) : ''}
        </dd>
      </dl>
      {status?.reminder ? <p className="warn">{status.reminder}</p> : <p className="helper">{t('auditEmpty')}</p>}
    </section>
    {isAdmin ? <section id="settings-danger" className="panel setup-card setup-danger" aria-labelledby="setup-knowledge-reset">
      <header className="setup-card-head">
        <h2 id="setup-knowledge-reset" className="h2">{t('resetHeading')}</h2>
        <p className="helper">{t('resetLead')}</p>
      </header>
      <div className="setup-actions">
        <button className="btn setup-danger-btn" type="button" disabled={!!pending} onClick={() => void onOpenReset()}>
          {t(pending === 'resetPreview' ? 'resetPreviewLoading' : 'resetAction')}
        </button>
      </div>
      {feedback(resetNotice)}
    </section> : null}
    {resetPreview ? <div className="setup-modal-backdrop" role="presentation">
      <form className="panel setup-modal" role="dialog" aria-modal="true" aria-labelledby="setup-reset-dialog-title" onSubmit={onConfirmReset}>
        <h2 id="setup-reset-dialog-title" className="h2">{t('resetDialogTitle')}</h2>
        <p className="helper">{t('resetDialogBody')}</p>
        <p className="setup-reset-counts">{t('resetCounts', {
          sources: resetPreview.counts.sources,
          chunks: resetPreview.counts.chunks,
          analyses: resetPreview.counts.analyses,
          sops: resetPreview.counts.sops,
          rules: resetPreview.counts.rules,
          ontology: resetPreview.counts.ontology,
          otherDrafts: resetPreview.counts.otherDrafts,
        })}</p>
        <p className="helper">{t('resetPreserved', {
          company: resetPreview.companyName ? `（${resetPreview.companyName}）` : '',
          connections: resetPreview.counts.preserved.connections,
        })}</p>
        <label className="field">
          <span>{resetPreview.companyName ? t('resetPrompt', { target: resetPreview.companyName }) : t('resetPromptOnly')}</span>
          <input value={resetConfirmText} onChange={e => setResetConfirmText(e.target.value)} disabled={pending === 'reset'} placeholder="RESET" autoFocus />
        </label>
        <div className="setup-actions">
          <button className="btn setup-danger-btn" type="submit" disabled={!canConfirmReset || pending === 'reset'}>
            {t(pending === 'reset' ? 'resetting' : 'resetConfirmBtn')}
          </button>
          <button className="btn" type="button" disabled={pending === 'reset'} onClick={() => { setResetPreview(null); setResetConfirmText(''); }}>
            {t('resetCancelBtn')}
          </button>
        </div>
        {feedback(resetNotice)}
      </form>
    </div> : null}
      </div>
    </div>
  </div>;
}
