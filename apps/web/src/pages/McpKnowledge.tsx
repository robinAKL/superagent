import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useLang, useT } from '../i18n';
import './KnowledgePage.css';

const ROOT = '/api/v1/knowledge';
const LIVE = '/connections/mcp/live/';
export interface McpConnection { id: string; name: string; endpoint: string; enabled: boolean; allowTools: boolean; authorization: 'oauth' | 'public' }

const TEXT = {
  en: {
    title: 'MCP knowledge',
    connectPrompt: 'Add an MCP source to ask about its documents and data.',
    connect: 'Add an MCP source',
    unavailable: 'MCP knowledge is currently unavailable.',
    source: 'Knowledge source',
    ask: 'Ask the Brain',
    asking: 'Reading source…',
    question: 'What would you like to know?',
    noAnswer: 'This MCP source did not provide enough information to answer.',
    sources: 'Sources',
    reauthorize: 'Reauthorize this MCP source in Knowledge sources.',
    model: 'Configure the Brain model in Settings to ask about MCP knowledge.',
    error: 'Could not read this MCP source. Try again.',
  },
  zh: {
    title: 'MCP 知识',
    connectPrompt: '添加 MCP 来源后，可以询问其中的文档和数据。',
    connect: '添加 MCP 来源',
    unavailable: 'MCP 知识暂时不可用。',
    source: '知识来源',
    ask: '问大脑',
    asking: '正在读取来源…',
    question: '你想了解什么？',
    noAnswer: '该 MCP 来源没有提供足够的信息来回答。',
    sources: '来源',
    reauthorize: '请在知识来源中重新授权此 MCP 连接。',
    model: '请在管理设置中配置大脑模型后再提问。',
    error: '无法读取此 MCP 来源，请重试。',
  },
};
interface Answer {
  answer: string;
  sources: { number: number; locator: string; retrievedAt: string }[];
}

export function McpKnowledge() {
  const t = useT(TEXT);
  const [lang] = useLang();
  const [connections, setConnections] = useState<McpConnection[]>();
  const [selectedId, setSelectedId] = useState(() => new URLSearchParams(window.location.hash.split('?')[1]).get('source') ?? '');
  const [loading, setLoading] = useState(true);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<Answer>();
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void api<{ mcpConnections?: McpConnection[] }>(ROOT + '/overview').then(response => {
      if (active && response.status === 200) setConnections(response.body.mcpConnections?.filter(connection => connection.enabled));
    }).catch(() => undefined).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  const selected = connections?.find(connection => connection.id === selectedId) ?? connections?.[0];

  async function ask(event: FormEvent) {
    event.preventDefault();
    if (!selected || asking || !question.trim()) return;
    setAsking(true);
    setError('');
    setAnswer(undefined);
    try {
      const response = await api<Answer & { error?: string; message?: string }>(ROOT + LIVE + selected.id + '/ask', {
        method: 'POST', body: JSON.stringify({ question }),
      });
      if (response.status === 200) setAnswer(response.body);
      else if (response.body.error === 'mcp_reauthorize') {
        setError(t('reauthorize'));
      } else if (response.status === 503) setError(t('model'));
      else setError((lang === 'zh' ? response.body.message : undefined) ?? t('error'));
    } catch {
      setError(t('error'));
    } finally { setAsking(false); }
  }

  return <section className="panel knowledge-section" aria-labelledby="mcp-knowledge-title">
    <h2 id="mcp-knowledge-title">{t('title')}</h2>
    {error ? <p className="knowledge-alert" role="alert">{error}</p> : null}
    {!loading && !connections ? <p className="helper">{t('unavailable')}</p> : null}
    {connections && !selected ? <>
      <p className="helper">{t('connectPrompt')}</p>
      <a className="btn" href="/#knowledge?source=mcp">{t('connect')}</a>
    </> : null}
    {selected ? <>
      <form className="knowledge-form" onSubmit={ask}>
        <label className="field"><span>{t('source')}</span><select value={selected.id} disabled={asking} onChange={event => { setSelectedId(event.target.value); setAnswer(undefined); setError(''); }}>
          {connections?.map(connection => <option key={connection.id} value={connection.id}>{connection.name} · {connection.endpoint}</option>)}
        </select></label>
        <label className="field"><span>{t('question')}</span><textarea required maxLength={1000} rows={3} value={question} onChange={event => setQuestion(event.target.value)} /></label>
        <button className="btn primary" disabled={asking || !question.trim()}>{asking ? t('asking') : t('ask')}</button>
      </form>
      {answer ? <div className="knowledge-search-result" aria-live="polite">
        <p className="knowledge-answer" style={{ whiteSpace: 'pre-wrap' }}>{answer.answer || t('noAnswer')}</p>
        {answer.sources.length ? <section aria-label={t('sources')}>
          <h3>{t('sources')}</h3>
          <ol>{answer.sources.map(source => <li key={source.number}>
            <span>{source.locator}</span> <small>{new Date(source.retrievedAt).toLocaleString(lang === 'zh' ? 'zh-CN' : undefined)}</small>
          </li>)}</ol>
        </section> : null}
      </div> : null}
    </> : null}
  </section>;
}
