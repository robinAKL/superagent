import { useEffect, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';

/**
 * The setup path in order (UX plan, main flow). Shown to an owner or admin until every step is done; each step's
 * state is read from the API that owns it, nothing is assumed. It waits for every answer before it renders, so it
 * never flashes a wrong state, and it stays away when an answer cannot be read.
 */
type StepId = 'model' | 'company' | 'knowledge' | 'team' | 'computer' | 'result';
const ORDER: StepId[] = ['model', 'company', 'knowledge', 'team', 'computer', 'result'];
const HREF: Record<StepId, string> = {
  model: '#settings?section=model', company: '#settings?section=company', knowledge: '#knowledge', team: '#employees', computer: '#settings?link=1', result: '#room',
};

const TEXT = {
  en: {
    title: 'Getting started: {n} of 6 done', hide: 'Hide', show: 'Show the steps',
    model: 'Connect a model', company: 'Describe the company and its boundaries', knowledge: 'Add materials and run an analysis',
    team: 'Confirm the team', computer: 'Bind a computer to an employee', result: 'Get the first result back',
    go: 'Go', done: 'Done', resultHint: 'Mention an employee below and ask for a piece of work.',
  },
  zh: {
    title: '开始使用：已完成 {n} / 6 步', hide: '收起', show: '展开步骤',
    model: '连接模型', company: '填写企业信息与工作边界', knowledge: '添加资料并完成分析',
    team: '确认团队', computer: '给员工绑定一台电脑', result: '收到第一份结果',
    go: '去完成', done: '已完成', resultHint: '在下方 @ 一名员工，交给它一件事。',
  },
};

const HIDDEN_KEY = 'superagent.gettingStarted.folded';

async function json<T>(path: string): Promise<T | null> {
  try {
    const response = await api<T>(path);
    return response.status === 200 ? response.body : null;
  } catch { return null; }
}

export async function readSetupState(): Promise<Record<StepId, boolean> | null> {
  const [llm, company, overview, organization, workers, tasks] = await Promise.all([
    json<{ status?: string }>('/api/v1/setup/llm'),
    json<{ context?: { name?: string } | null }>('/api/v1/sop/company-context'),
    json<{ items?: { confirmed: boolean }[]; analyses?: { status: string }[] }>('/api/v1/knowledge/overview'),
    json<{ confirmation?: unknown }>('/api/v1/knowledge/organization'),
    json<{ workers?: { revokedAt: number | null; capabilities?: { roomAssignments?: unknown[] } }[] }>('/api/v1/workers'),
    json<{ tasks?: { status: string }[] }>('/api/v1/room/tasks?roomId=room-1'),
  ]);
  if (!llm || !company || !overview || !organization || !workers || !tasks) return null;
  return {
    model: llm.status === 'configured',
    company: !!company.context?.name,
    knowledge: !!overview.items?.some(item => item.confirmed) && !!overview.analyses?.some(run => run.status === 'completed'),
    team: !!organization.confirmation,
    computer: !!workers.workers?.some(worker => worker.revokedAt === null && (worker.capabilities?.roomAssignments?.length ?? 0) > 0),
    result: !!tasks.tasks?.some(task => task.status === 'completed' || task.status === 'reviewed'),
  };
}

export function GettingStarted() {
  const t = useT(TEXT);
  const [state, setState] = useState<Record<StepId, boolean> | null>(null);
  const [folded, setFolded] = useState(() => { try { return localStorage.getItem(HIDDEN_KEY) === '1'; } catch { return false; } });
  useEffect(() => {
    let stop = false;
    void readSetupState().then(next => { if (!stop) setState(next); });
    return () => { stop = true; };
  }, []);
  if (!state) return null;
  const done = ORDER.filter(step => state[step]).length;
  if (done === ORDER.length) return null;
  const next = ORDER.find(step => !state[step])!;
  const fold = (value: boolean) => {
    setFolded(value);
    try { localStorage.setItem(HIDDEN_KEY, value ? '1' : '0'); } catch { /* not remembered */ }
  };
  return <section className="getting-started" aria-labelledby="getting-started-title">
    <div className="getting-started-head">
      <h2 id="getting-started-title">{t('title', { n: done })}</h2>
      <button type="button" className="btn quiet small" aria-expanded={!folded} aria-controls="getting-started-steps" onClick={() => fold(!folded)}>
        {t(folded ? 'show' : 'hide')}
      </button>
    </div>
    {folded ? null : <ol id="getting-started-steps" className="getting-started-steps">
      {ORDER.map(step => <li key={step} data-step={step} data-done={state[step] ? 'yes' : undefined} aria-current={step === next ? 'step' : undefined}>
        <span className="getting-started-name">{t(step)}</span>
        {state[step] ? <span className="status is-good">{t('done')}</span>
          : step === next ? (step === 'result' ? <span className="helper">{t('resultHint')}</span> : <a className="btn small" href={HREF[step]}>{t('go')}</a>)
          : <a className="getting-started-link" href={HREF[step]}>{t('go')}</a>}
      </li>)}
    </ol>}
  </section>;
}
