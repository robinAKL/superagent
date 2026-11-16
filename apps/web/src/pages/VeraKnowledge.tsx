import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useLang, useT } from '../i18n';
import './KnowledgePage.css';

const ROOT = '/api/v1/knowledge';
const VERA = '/connections/mcp/vera';
export interface VeraConnection { endpoint: string; connected: boolean }

const TEXT = {
  en: {
    title: 'CRM knowledge',
    connectPrompt: 'Connect VERA CRM to ask about its knowledge and business records.',
    connect: 'Connect VERA CRM',
    unavailable: 'CRM knowledge is currently unavailable.',
    ask: 'Ask the Brain',
    asking: 'Reading CRM…',
    question: 'Question for VERA CRM',
    placeholder: 'What are the pricing rules for roller blinds?',
    noAnswer: 'The available CRM sources did not answer this question.',
    sources: 'Sources',
    reauthorize: 'Your VERA CRM connection needs authorization.',
    model: 'Configure the Brain model in Settings to ask about CRM knowledge.',
    error: 'Could not read VERA CRM knowledge. Try again.',
  },
  zh: {
    title: 'CRM 知识',
    connectPrompt: '连接 VERA CRM 后，可以询问它的知识和业务记录。',
    connect: '连接 VERA CRM',
    unavailable: 'CRM 知识暂时不可用。',
    ask: '问大脑',
    asking: '正在读取 CRM…',
    question: '关于 VERA CRM 的问题',
    placeholder: '卷帘的报价规则是什么？',
    noAnswer: '当前可读的 CRM 来源无法回答这个问题。',
    sources: '来源',
    reauthorize: '请重新授权 VERA CRM 连接。',
    model: '请在管理设置中配置大脑模型后再提问。',
    error: '无法读取 VERA CRM 知识，请重试。',
  },
};
interface Answer {
  answer: string;
  sources: { number: number; locator: string; retrievedAt: string }[];
}

export function VeraKnowledge() {
  const t = useT(TEXT);
  const [lang] = useLang();
  const [connection, setConnection] = useState<VeraConnection>();
  const [loading, setLoading] = useState(true);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<Answer>();
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void api<{ veraMcp?: VeraConnection }>(ROOT + '/overview').then(response => {
      if (active && response.status === 200) setConnection(response.body.veraMcp);
    }).catch(() => undefined).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function ask(event: FormEvent) {
    event.preventDefault();
    if (asking || !question.trim()) return;
    setAsking(true);
    setError('');
    setAnswer(undefined);
    try {
      const response = await api<Answer & { error?: string; message?: string }>(ROOT + VERA + '/ask', {
        method: 'POST', body: JSON.stringify({ question }),
      });
      if (response.status === 200) setAnswer(response.body);
      else if (response.body.error === 'vera_reauthorize') {
        setConnection(current => current && { ...current, connected: false });
        setError(t('reauthorize'));
      } else if (response.status === 503) setError(t('model'));
      else setError((lang === 'zh' ? response.body.message : undefined) ?? t('error'));
    } catch {
      setError(t('error'));
    } finally { setAsking(false); }
  }

  return <section className="panel knowledge-section" aria-labelledby="vera-knowledge-title">
    <h2 id="vera-knowledge-title">{t('title')}</h2>
    {error ? <p className="knowledge-alert" role="alert">{error}</p> : null}
    {!loading && !connection ? <p className="helper">{t('unavailable')}</p> : null}
    {connection && !connection.connected ? <>
      <p className="helper">{t('connectPrompt')}</p>
      <a className="btn" href="/#knowledge?source=mcp">{t('connect')}</a>
    </> : null}
    {connection?.connected ? <>
      <form className="knowledge-form" onSubmit={ask}>
        <label className="field"><span>{t('question')}</span><textarea required maxLength={1000} rows={3} placeholder={t('placeholder')} value={question} onChange={event => setQuestion(event.target.value)} /></label>
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
