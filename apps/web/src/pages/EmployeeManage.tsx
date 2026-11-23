import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import type { WallEmployee } from './EmployeeWall';
import { agentLabel, getEmployeeLink, LINK_INSTALLER_URL, useLinkDevices } from './link-devices';

interface CatalogTool {
  toolId: string;
  name: { en: string; zh: string };
  status: string;
  installedEmployees: string[];
}

export interface RegistryEmployee extends WallEmployee {
  promptVersion?: number;
}

const TEXT = {
  en: {
    title: 'Manage {name}', close: 'Close', duty: 'Responsibilities', owner: 'Owner',
    ownerUnknown: 'Not set', ownerYou: 'You', ownerOther: 'Another member', computer: 'Computer', computerNone: 'Not bound', bindComputer: 'Bind a computer', downloadLink: 'Download Link for Windows', manageComputer: 'Change', prompt: 'Prompt version', promptValue: 'v{n}',
    promptEdit: 'New prompt text', promptSave: 'Save as new version', promptHint: 'Saving creates a new version. Running work keeps the snapshot it already claimed.',
    tools: 'Tool authorizations', toolsEmpty: 'No tools installed on this employee yet.',
    toolsLink: 'Open employee tools', pause: 'Pause', resume: 'Resume', paused: 'Paused',
    saving: 'Saving…', saved: 'Saved.', error: 'The request did not complete. Try again.',
  },
  zh: {
    title: '管理 {name}', close: '关闭', duty: '职责', owner: '负责人',
    ownerUnknown: '未设置', ownerYou: '你', ownerOther: '其他成员', computer: '电脑', computerNone: '未绑定', bindComputer: '绑定电脑', downloadLink: '下载 Link（Windows）', manageComputer: '更改', prompt: '提示词版本', promptValue: 'v{n}',
    promptEdit: '新的提示词', promptSave: '保存为新版本', promptHint: '保存会新增一个版本。正在跑的任务继续用它领取时的快照。',
    tools: '工具授权', toolsEmpty: '这名员工还没有安装工具。',
    toolsLink: '打开员工工具', pause: '暂停', resume: '恢复', paused: '已暂停',
    saving: '保存中…', saved: '已保存。', error: '请求未完成，请重试。',
  },
};

export function EmployeeManage({ employee, lang, onClose, onChanged }: {
  employee: RegistryEmployee; lang: 'en' | 'zh'; onClose: () => void; onChanged: () => void;
}) {
  const t = useT(TEXT);
  const { devices } = useLinkDevices();
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [tools, setTools] = useState<CatalogTool[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api<{ viewer?: { userId?: string } }>('/api/v1/room/roster')
      .then(r => { if (!cancelled && r.status === 200) setViewerId(r.body.viewer?.userId ?? null); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = document.getElementById('emp-manage') as HTMLDialogElement | null;
    dialog?.showModal();
    return () => dialog?.close();
  }, [employee.id]);

  useEffect(() => {
    let cancelled = false;
    void api<{ tools: CatalogTool[] }>(`/api/v1/tools/catalog?employeeId=${encodeURIComponent(employee.id)}`)
      .then(r => { if (!cancelled) setTools(r.status === 200 && Array.isArray(r.body.tools) ? r.body.tools.filter(tool => tool.installedEmployees.includes(employee.id)) : []); })
      .catch(() => { if (!cancelled) setTools([]); });
    return () => { cancelled = true; };
  }, [employee.id]);

  async function mutate(path: string, init?: RequestInit) {
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await api(path, init);
      if (r.status >= 400) { setError(t('error')); return; }
      setNotice(t('saved'));
      onChanged();
    } catch { setError(t('error')); }
    finally { setBusy(false); }
  }

  function savePrompt(event: FormEvent) {
    event.preventDefault();
    if (!prompt.trim()) return;
    void mutate(`/api/v1/employees/${encodeURIComponent(employee.id)}/prompt`, { method: 'PUT', body: JSON.stringify({ prompt: prompt.trim() }) });
  }

  const installed = tools ?? [];
  // People are named, never shown as an account id.
  const ownerLabel = !employee.owner ? t('ownerUnknown')
    : viewerId && employee.owner === viewerId ? t('ownerYou')
    : /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(employee.owner) ? t('ownerOther') : employee.owner;
  const link = devices ? getEmployeeLink(devices, employee.id) : null;
  const bindHref = `#settings?link=1&employee=${encodeURIComponent(employee.id)}`;
  return <dialog id="emp-manage" className="emp-drawer" aria-labelledby="emp-manage-title" onClose={onClose}>
    <form method="dialog" className="emp-drawer-bar">
      <h2 id="emp-manage-title">{t('title', { name: employee.name })}</h2>
      <button className="btn" value="close">{t('close')}</button>
    </form>
    {error ? <p className="warn" role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    <dl className="emp-drawer-facts">
      <div><dt>{t('duty')}</dt><dd>{employee.duty}</dd></div>
      <div><dt>{t('owner')}</dt><dd>{ownerLabel}</dd></div>
      <div><dt>{t('computer')}</dt><dd>{devices === null ? '…' : link && link.status !== 'unbound' && link.status !== 'ambiguous'
        ? <>{link.device?.name}{link.project ? `，${link.project.name}（${agentLabel(link.project.agent)}）` : ''} <a href={bindHref}>{t('manageComputer')}</a></>
        : <>{t('computerNone')} <a href={bindHref}>{t('bindComputer')}</a> <a href={LINK_INSTALLER_URL}>{t('downloadLink')}</a></>}</dd></div>
      <div><dt>{t('prompt')}</dt><dd>{t('promptValue', { n: employee.promptVersion ?? 1 })}</dd></div>
    </dl>
    <form className="stack" onSubmit={savePrompt}>
      <label className="field"><span>{t('promptEdit')}</span>
        <textarea rows={4} value={prompt} onChange={e => setPrompt(e.target.value)} maxLength={8000} /></label>
      <p className="helper">{t('promptHint')}</p>
      <button className="btn" disabled={busy || !prompt.trim()}>{busy ? t('saving') : t('promptSave')}</button>
    </form>
    <section aria-labelledby="emp-manage-tools">
      <h3 id="emp-manage-tools">{t('tools')}</h3>
      {tools === null ? <p className="helper">…</p> : installed.length === 0 ? <p className="helper">{t('toolsEmpty')}</p> :
        <ul className="emp-tool-list">{installed.map(tool => <li key={tool.toolId}>{lang === 'zh' ? tool.name.zh : tool.name.en}</li>)}</ul>}
      <a href={`#tools?employee=${encodeURIComponent(employee.id)}`}>{t('toolsLink')}</a>
    </section>
    <div className="org-row">
      {employee.status === 'paused'
        ? <button className="btn primary" type="button" disabled={busy} onClick={() => void mutate(`/api/v1/employees/${encodeURIComponent(employee.id)}/resume`, { method: 'POST', body: '{}' })}>{t('resume')}</button>
        : <button className="btn" type="button" disabled={busy} onClick={() => void mutate(`/api/v1/employees/${encodeURIComponent(employee.id)}/pause`, { method: 'POST', body: '{}' })}>{t('pause')}</button>}
    </div>
  </dialog>;
}

export function mentionsEmployee(payload: Record<string, unknown>, ids: Set<string>): boolean {
  const values = [payload.employeeId, payload.employee, payload.assignee, payload.owner];
  return values.some(value => typeof value === 'string' && ids.has(value));
}
