import { useEffect, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import type { PublishedWorkflow } from './CompanyContextPanel';
import { ExecutionsPanel } from './ExecutionsPanel';
import './SuperAgentPage.css';

const TEXT = {
  en: {
    title: 'Business workflows', select: 'Published workflow', placeholder: 'Choose a workflow',
    loading: 'Loading published workflows…', unavailable: 'Could not load published workflows.', retry: 'Try again',
    empty: 'No workflow is enabled yet. Choose the agreed workflow in Workflow management and enable it once.',
    missing: 'The selected workflow is currently unavailable.', settings: 'Go to workflow management',
  },
  zh: {
    title: '业务流程', select: '已发布流程', placeholder: '选择流程',
    loading: '正在读取已发布流程…', unavailable: '无法读取已发布流程。', retry: '重试',
    empty: '还没有已启用的流程。到流程管理选择已定的流程，启用一次即可。',
    missing: '所选流程目前尚未生效。', settings: '去流程管理',
  },
};

function workflowInLocation() {
  return new URLSearchParams(window.location.hash.split('?')[1]).get('workflow') ?? '';
}

export function CommandWorkflowPanel({ defaultOpen = false }: { defaultOpen?: boolean } = {}) {
  const t = useT(TEXT);
  const [selected, setSelected] = useState(workflowInLocation);
  const [open, setOpen] = useState(() => defaultOpen || Boolean(workflowInLocation()));
  const [workflows, setWorkflows] = useState<PublishedWorkflow[] | null>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    function navigate() {
      const workflow = workflowInLocation();
      if (workflow) {
        setSelected(workflow);
        setOpen(true);
      }
    }
    window.addEventListener('hashchange', navigate);
    return () => window.removeEventListener('hashchange', navigate);
  }, []);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]);
    void api<{ workflows: PublishedWorkflow[] }>('/api/v1/sop/published', { signal }).then(({ status, body }) => {
      if (!controller.signal.aborted) setWorkflows(status === 200 && Array.isArray(body.workflows) ? body.workflows : null);
    }).catch(() => { if (!controller.signal.aborted) setWorkflows(null); });
    return () => controller.abort();
  }, [open, attempt]);

  const workflow = workflows?.find(row => row.sopId === selected) ?? (!selected && workflows?.length === 1 ? workflows[0] : undefined);

  return <details className="panel command-workflows" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{t('title')}</summary>
    <div className="stack command-workflows-body">
      {workflows?.length ? <label className="field">
        <span>{t('select')}</span>
        <select value={workflow?.sopId ?? ''} onChange={event => setSelected(event.target.value)}>
          <option value="">{t('placeholder')}</option>
          {workflows.map(row => <option key={row.id} value={row.sopId}>{row.title} · v{row.version}</option>)}
        </select>
      </label> : null}
      {workflows === undefined ? <p className="helper" role="status">{t('loading')}</p> : null}
      {workflows === null ? <div className="workflow-actions">
        <p className="warn" role="alert">{t('unavailable')}</p>
        <button className="btn" type="button" onClick={() => { setWorkflows(undefined); setAttempt(value => value + 1); }}>{t('retry')}</button>
      </div> : null}
      {workflows && selected && !workflow ? <p className="warn">{t('missing')}</p> : null}
      {workflows?.length === 0 ? <p className="helper">{t('empty')} <a href="#brain?tab=sop">{t('settings')}</a></p> : null}
      {workflow ? <ExecutionsPanel key={workflow.id} sopId={workflow.sopId} publishedVersionId={workflow.id} roomWorkflow={workflow} /> : null}
    </div>
  </details>;
}
