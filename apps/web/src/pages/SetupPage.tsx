import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useT, type Dict, type Vars } from '../i18n';

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
  message: string;
  selectable: string[];
  unverified: string[];
}

const TEXT = {
  en: {
    providerAnthropic: 'Anthropic (Claude)', providerOpenai: 'OpenAI (GPT)', providerAzure: 'Azure OpenAI',
    statusUnconfigured: 'Not configured', statusConfigured: 'Configured', statusRevoked: 'Revoked', statusKeyInvalid: 'Key invalid',
    authOk: 'Passed', authInvalidKey: 'Invalid key', authQuota: 'Out of quota', authNetwork: 'Network error', authError: 'Other error',
    testing: 'Testing…', requestFailed: 'Request failed', activated: 'Saved to Key Vault and active', notActivated: 'Not applied: {reason}',
    capSaved: 'Saved; applies to this month right away', capNotSaved: 'Not saved: {reason}',
    capValue: 'US${amount} / month', capUnset: 'Not set (model calls will be refused)',
    title: 'Settings', lead: 'Model provider, key and usage cap',
    currentModel: 'Current model', status: 'Status: ', loading: 'Loading…',
    primaryModelIs: ' · Primary model {model}', economyModelIs: ' · Economy model {model}',
    capTitle: 'Monthly usage cap', capCurrent: 'Current cap: {value}',
    capHelp: 'Hard cap: each call reserves its maximum possible cost first, and calls over the cap are not sent. Lowering it below what this month has already used refuses new calls.',
    capNew: 'New cap (USD, up to two decimals)', capPlaceholder: 'e.g. 200', saveCap: 'Save cap',
    keyTitle: 'Set or change the key', provider: 'Provider', apiKey: 'API key (sent only to the server, stored in Key Vault)',
    probeModel: 'Model ID to test with (Azure: deployment name)', testConnection: 'Test connection',
    testResult: 'Test result', resultLine: 'Authentication: {auth} · Model list: {listing} · Tool calls: {tools}',
    listingOk: 'retrieved', listingFailed: 'could not be retrieved automatically',
    toolsOk: 'passed', toolsSkipped: 'not tested', toolsFailed: 'failed',
    primaryModel: 'Primary model (only models that passed the platform capability test)', choose: 'Choose',
    economyModel: 'Economy model (optional, for bulk extraction)', sameAsPrimary: 'Same as primary model',
    unverified: 'Not verified (cannot be selected): {models}', listSep: ', ', saveActivate: 'Save and apply',
  },
  zh: {
    providerAnthropic: 'Anthropic（Claude）', providerOpenai: 'OpenAI（GPT）', providerAzure: 'Azure OpenAI',
    statusUnconfigured: '未配置', statusConfigured: '已配置', statusRevoked: '已撤销', statusKeyInvalid: 'Key 失效',
    authOk: '通过', authInvalidKey: 'Key 无效', authQuota: '额度不足', authNetwork: '网络错误', authError: '其他错误',
    testing: '测试中…', requestFailed: '请求失败', activated: '已保存到 Key Vault 并生效', notActivated: '未生效：{reason}',
    capSaved: '已保存，立即对本月生效', capNotSaved: '未保存：{reason}',
    capValue: 'US${amount} / 月', capUnset: '未设置（模型调用会被拒绝）',
    title: '管理设置', lead: '模型服务商、Key 与用量上限',
    currentModel: '当前模型', status: '状态：', loading: '读取中…',
    primaryModelIs: ' · 主模型 {model}', economyModelIs: ' · 经济模型 {model}',
    capTitle: '月度用量上限', capCurrent: '当前上限：{value}',
    capHelp: '硬上限：每次调用前按最大可能费用预留，超出上限的调用不会发出。下调到低于本月已用额度时，新调用会被拒绝。',
    capNew: '新的上限（美元，最多两位小数）', capPlaceholder: '例如 200', saveCap: '保存上限',
    keyTitle: '设置或更换 Key', provider: '服务商', apiKey: 'API Key（只发送到服务端，保存于 Key Vault）',
    probeModel: '用于测试的模型 ID（Azure 填部署名）', testConnection: '测试连接',
    testResult: '测试结果', resultLine: '认证：{auth} · 模型列表：{listing} · 工具调用：{tools}',
    listingOk: '已获取', listingFailed: '无法自动获取',
    toolsOk: '通过', toolsSkipped: '未测', toolsFailed: '未通过',
    primaryModel: '主模型（仅显示已通过平台能力测试的模型）', choose: '请选择',
    economyModel: '经济模型（可选，批量抽取用）', sameAsPrimary: '与主模型相同',
    unverified: '未验证（不可选）：{models}', listSep: '，', saveActivate: '保存并生效',
  },
} satisfies Dict<string>;
type Key = keyof typeof TEXT.en;
/** Messages are kept as keys, so switching language re-renders what is already on screen. */
type Msg = { key: Key; vars?: Vars } | null;

const PROVIDERS: { id: string; label: Key }[] = [
  { id: 'anthropic', label: 'providerAnthropic' },
  { id: 'openai', label: 'providerOpenai' },
  { id: 'azure-openai', label: 'providerAzure' },
];
const STATUS_LABEL: Record<string, Key> = { unconfigured: 'statusUnconfigured', configured: 'statusConfigured', revoked: 'statusRevoked', key_invalid: 'statusKeyInvalid' };
const AUTH_LABEL: Record<string, Key> = { ok: 'authOk', invalid_key: 'authInvalidKey', quota: 'authQuota', network: 'authNetwork', error: 'authError' };

/** Setup (PRD §3.1). The key is sent once to the server for testing/activation and never kept in the browser. */
export function SetupPage() {
  const t = useT(TEXT);
  const say = (m: Msg) => (m ? t(m.key, m.vars) : '');
  const label = (map: Record<string, Key>, value: string) => (map[value] ? t(map[value]!) : value);
  const [status, setStatus] = useState<LlmStatus | null>(null);
  const [provider, setProvider] = useState('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [probeModel, setProbeModel] = useState('');
  const [test, setTest] = useState<TestResponse | null>(null);
  const [primary, setPrimary] = useState('');
  const [economy, setEconomy] = useState('');
  const [msg, setMsg] = useState<Msg>(null);
  const [capUsd, setCapUsd] = useState('');
  const [capMsg, setCapMsg] = useState<Msg>(null);

  const load = () => api<LlmStatus>('/api/v1/setup/llm').then((r) => setStatus(r.status === 200 ? r.body : null));
  useEffect(() => void load(), []);

  const body = () => ({ provider, apiKey, probeModel, ...(provider === 'azure-openai' ? { endpoint } : {}) });

  async function onTest(e: FormEvent) {
    e.preventDefault();
    setMsg({ key: 'testing' });
    const r = await api<TestResponse>('/api/v1/setup/llm/test', { method: 'POST', body: JSON.stringify(body()) });
    setTest(r.status === 200 ? r.body : null);
    setMsg(r.status === 200 ? null : { key: 'requestFailed' });
  }

  async function onActivate() {
    const r = await api<LlmStatus & { error?: string; message?: string }>('/api/v1/setup/llm', {
      method: 'PUT',
      body: JSON.stringify({ ...body(), primaryModel: primary, economyModel: economy || undefined }),
    });
    setApiKey(''); // never keep the key in the page after submit
    setMsg(r.status === 200 ? { key: 'activated' } : { key: 'notActivated', vars: { reason: r.body.message ?? r.body.error ?? r.status } });
    if (r.status === 200) {
      setTest(null);
      await load();
    }
  }

  async function onSaveCap(e: FormEvent) {
    e.preventDefault();
    const r = await api<LlmStatus & { message?: string }>('/api/v1/setup/llm/budget', { method: 'PUT', body: JSON.stringify({ monthlyCapUsd: Number(capUsd) }) });
    setCapMsg(r.status === 200 ? { key: 'capSaved' } : { key: 'capNotSaved', vars: { reason: r.body.message ?? t('requestFailed') } });
    if (r.status === 200) {
      setCapUsd('');
      await load();
    }
  }

  const capText = status?.monthlyCapMicroUsd != null ? t('capValue', { amount: (status.monthlyCapMicroUsd / 1_000_000).toFixed(2) }) : t('capUnset');

  return (
    <>
      <div className="page-head">
        <h1>{t('title')}</h1>
        <p>{t('lead')}</p>
      </div>
      <section className="panel stack">
        <h2 className="h2">{t('currentModel')}</h2>
        <p>
          {t('status')}{status ? label(STATUS_LABEL, status.status) : t('loading')}
          {status?.keyLast4 ? ` · Key ••••${status.keyLast4}` : ''}
          {status?.primaryModel ? t('primaryModelIs', { model: status.primaryModel }) : ''}
          {status?.economyModel ? t('economyModelIs', { model: status.economyModel }) : ''}
        </p>
        {status?.reminder ? <p className="warn">{status.reminder}</p> : null}
      </section>

      <form className="panel stack" onSubmit={onSaveCap}>
        <h2 className="h2">{t('capTitle')}</h2>
        <p>{t('capCurrent', { value: capText })}</p>
        <p className="helper">{t('capHelp')}</p>
        <label className="field">
          <span>{t('capNew')}</span>
          <input inputMode="decimal" value={capUsd} onChange={(e) => setCapUsd(e.target.value)} placeholder={t('capPlaceholder')} required />
        </label>
        <button className="btn" type="submit">{t('saveCap')}</button>
        {capMsg ? <p className="helper">{say(capMsg)}</p> : null}
      </form>

      <form className="panel stack" onSubmit={onTest}>
        <h2 className="h2">{t('keyTitle')}</h2>
        <label className="field">
          <span>{t('provider')}</span>
          <select value={provider} onChange={(e) => setProvider(e.target.value)}>
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>{t(p.label)}</option>
            ))}
          </select>
        </label>
        {provider === 'azure-openai' ? (
          <label className="field">
            <span>Endpoint</span>
            <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://<resource>.openai.azure.com" />
          </label>
        ) : null}
        <label className="field">
          <span>{t('apiKey')}</span>
          <input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} required />
        </label>
        <label className="field">
          <span>{t('probeModel')}</span>
          <input value={probeModel} onChange={(e) => setProbeModel(e.target.value)} required />
        </label>
        <button className="btn primary" type="submit">{t('testConnection')}</button>
        {msg ? <p className="helper">{say(msg)}</p> : null}
      </form>

      {test ? (
        <section className="panel stack">
          <h2 className="h2">{t('testResult')}</h2>
          <p>{t('resultLine', {
            auth: label(AUTH_LABEL, test.auth),
            listing: t(test.listing === 'ok' ? 'listingOk' : 'listingFailed'),
            tools: t(test.tools === 'ok' ? 'toolsOk' : test.tools === 'skipped' ? 'toolsSkipped' : 'toolsFailed'),
          })}</p>
          {test.message ? <p className="helper">{test.message}</p> : null}
          {test.auth === 'ok' ? (
            <>
              <label className="field">
                <span>{t('primaryModel')}</span>
                <select value={primary} onChange={(e) => setPrimary(e.target.value)}>
                  <option value="">{t('choose')}</option>
                  {test.selectable.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t('economyModel')}</span>
                <select value={economy} onChange={(e) => setEconomy(e.target.value)}>
                  <option value="">{t('sameAsPrimary')}</option>
                  {test.selectable.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </label>
              {test.unverified.length ? <p className="helper">{t('unverified', { models: test.unverified.join(t('listSep')) })}</p> : null}
              <button className="btn primary" type="button" disabled={!primary || !apiKey} onClick={onActivate}>{t('saveActivate')}</button>
            </>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
