import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useT, type Dict, type Vars } from '../i18n';
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
    title: 'Settings', lead: 'Connect a model and set its monthly budget', connection: 'Model connection', budget: 'Monthly usage cap',
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
  },
  zh: {
    title: '管理设置', lead: '连接模型并设置月度预算', connection: '模型连接', budget: '月度用量上限',
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

export function SetupPage() {
  const t = useT(TEXT);
  const [status, setStatus] = useState<LlmStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [form, setForm] = useState({ provider: 'anthropic', apiKey: '', endpoint: '', probeModel: '' });
  const [test, setTest] = useState<TestResponse | null>(null);
  const [primary, setPrimary] = useState('');
  const [economy, setEconomy] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [capUsd, setCapUsd] = useState('');
  const [capNotice, setCapNotice] = useState<Notice | null>(null);
  const [pending, setPending] = useState<'test' | 'activate' | 'budget' | null>(null);

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

  const capText = status?.monthlyCapMicroUsd != null ? t('capValue', { amount: (status.monthlyCapMicroUsd / 1_000_000).toFixed(2) }) : t('capUnset');
  const tested = test?.auth === 'ok';
  const available = tested ? test.selectable : [];
  const toolFeedback = test?.tools === 'inconclusive' ? 'toolIncomplete' : test?.tools === 'failed' ? 'toolFailed' : undefined;

  return <div className="setup-page">
    <header className="page-head"><h1>{t('title')}</h1><p>{t('lead')}</p></header>
    <section className="panel setup-card" aria-labelledby="setup-connection">
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
  </div>;
}
