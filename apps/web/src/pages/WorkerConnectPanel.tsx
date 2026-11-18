import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useT, type Dict } from '../i18n';

const TEXT = {
  en: {
    title: 'Linked computers',
    lead: 'Paired Link devices stay connected and can run work for this tenant’s digital employees. Restrict a device to specific employees or projects, or revoke it.',
    empty: 'No computer is paired yet. Install Link and allow it on Connect this computer.',
    loadError: 'Could not load linked computers.',
    revoke: 'Revoke',
    revoked: 'Revoked',
    employees: 'Allowed employees (blank = all)',
    projects: 'Allowed projects (blank = all)',
    save: 'Save limits',
    saved: 'Limits saved.',
    saveError: 'Could not save limits.',
    agents: 'Detected agents',
  },
  zh: {
    title: '已连接的电脑',
    lead: '配对后的 Link 会保持连接，并可执行本租户数字员工的任务。可以把设备限制到指定员工或项目，也可以吊销。',
    empty: '还没有配对电脑。安装 Link 后在「连接此电脑」页点允许。',
    loadError: '无法加载已连接电脑。',
    revoke: '吊销',
    revoked: '已吊销',
    employees: '允许的员工（留空=全部）',
    projects: '允许的项目（留空=全部）',
    save: '保存限制',
    saved: '限制已保存。',
    saveError: '无法保存限制。',
    agents: '已识别的 agent',
  },
} satisfies Dict<string>;

interface WorkerView {
  id: string;
  name: string;
  kind: string;
  status: string;
  capabilities: { agents?: string[]; allowEmployees?: string[]; allowProjects?: string[] };
}

export function WorkerConnectPanel() {
  const t = useT(TEXT);
  const [workers, setWorkers] = useState<WorkerView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<{ workers: WorkerView[] }>('/api/v1/workers');
      if (res.status !== 200) throw new Error('load');
      setWorkers(res.body.workers.filter((w) => w.kind === 'link'));
      setError(null);
    } catch {
      setError(t('loadError'));
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  async function revoke(id: string) {
    setNotice(null);
    const res = await api(`/api/v1/workers/${id}/revoke`, { method: 'POST', body: '{}' });
    if (res.status === 200) await load();
  }

  async function saveLimits(id: string, employees: string, projects: string) {
    setNotice(null);
    const res = await api(`/api/v1/workers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        allowEmployees: splitIds(employees),
        allowProjects: splitIds(projects),
      }),
    });
    if (res.status !== 200) setNotice(t('saveError'));
    else { setNotice(t('saved')); await load(); }
  }

  if (error) return <section className="panel setup-card"><h2 className="h2">{t('title')}</h2><p role="alert">{error}</p></section>;
  if (!workers) return null;

  return (
    <section className="panel setup-card" aria-labelledby="linked-computers">
      <header className="setup-card-head">
        <h2 id="linked-computers" className="h2">{t('title')}</h2>
        <p className="helper">{t('lead')}</p>
      </header>
      {workers.length === 0 ? <p className="helper">{t('empty')}</p> : workers.map((w) => (
        <article key={w.id} data-worker={w.id}>
          <h3>{w.name}</h3>
          <p className="helper">{w.status}{w.capabilities.agents?.length ? ` · ${t('agents')}: ${w.capabilities.agents.join(', ')}` : ''}</p>
          {w.status === 'revoked' ? <p>{t('revoked')}</p> : (
            <LimitForm worker={w} t={t} onSave={saveLimits} onRevoke={revoke} />
          )}
        </article>
      ))}
      {notice ? <p className="helper" role="status">{notice}</p> : null}
    </section>
  );
}

function splitIds(value: string): string[] {
  return value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

function LimitForm({ worker, t, onSave, onRevoke }: {
  worker: WorkerView;
  t: (key: keyof typeof TEXT.en) => string;
  onSave: (id: string, employees: string, projects: string) => Promise<void>;
  onRevoke: (id: string) => Promise<void>;
}) {
  const [employees, setEmployees] = useState((worker.capabilities.allowEmployees ?? []).join(', '));
  const [projects, setProjects] = useState((worker.capabilities.allowProjects ?? []).join(', '));
  return (
    <>
      <label className="field"><span>{t('employees')}</span>
        <input value={employees} onChange={(e) => setEmployees(e.target.value)} />
      </label>
      <label className="field"><span>{t('projects')}</span>
        <input value={projects} onChange={(e) => setProjects(e.target.value)} />
      </label>
      <div className="setup-actions">
        <button className="btn" type="button" onClick={() => void onSave(worker.id, employees, projects)}>{t('save')}</button>
        <button className="btn setup-danger-btn" type="button" onClick={() => void onRevoke(worker.id)}>{t('revoke')}</button>
      </div>
    </>
  );
}
