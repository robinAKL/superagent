import { useState } from 'react';
import { api } from '../api';
import { useT, type Dict } from '../i18n';
import type { LinkDevice } from './link-devices';

/**
 * How freely an employee's local agent may act on its computer: three modes, one click. What each mode lets through
 * is decided on the computer by Link (apps/link/policy.mjs); anything set to ask comes to the command room.
 */
export type PermissionModeName = 'strict' | 'standard' | 'full';

const TEXT = {
  en: {
    label: 'Authorisation mode', strict: 'Strict', standard: 'Standard', full: 'Allow all',
    strictHint: 'Only reading and searching run on their own. Everything else waits for you in the command room.',
    standardHint: 'Reading, searching, editing files in the project and read-only tools run. Commands, tools that change data, and sending mail wait for you.',
    fullHint: 'Everything runs without asking.',
    askEmail: 'Still ask me before sending mail',
    failed: 'Could not change the mode.',
  },
  zh: {
    label: '授权模式', strict: '严格', standard: '标准', full: '全部放行',
    strictHint: '只有读文件、搜索直接执行，其他操作都在指挥室等你批准。',
    standardHint: '读文件、搜索、在项目里改文件和查询类工具直接执行；运行命令、会改数据的工具、发邮件在指挥室等你批准。',
    fullHint: '全部直接执行，不再询问。',
    askEmail: '发邮件前仍然问我',
    failed: '没能切换授权模式。',
  },
} satisfies Dict<string>;

export function policyOf(device: LinkDevice | undefined, employeeId: string) {
  return device?.capabilities.permissions?.[employeeId] ?? { mode: 'standard' as PermissionModeName };
}

export function PermissionMode({ device, employeeId, onChanged }: { device: LinkDevice; employeeId: string; onChanged: () => void }) {
  const t = useT(TEXT);
  const policy = policyOf(device, employeeId);
  const [mode, setMode] = useState<PermissionModeName>(policy.mode);
  const [askEmail, setAskEmail] = useState(policy.askEmail !== false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save(change: { mode?: PermissionModeName; askEmail?: boolean }) {
    setBusy(true);
    setError('');
    try {
      const response = await api(`/api/v1/workers/${encodeURIComponent(device.id)}/permissions`, {
        method: 'POST', body: JSON.stringify({ employeeId, ...change }),
      });
      if (response.status !== 200) throw new Error('failed');
      if (change.mode) setMode(change.mode);
      if (change.askEmail !== undefined) setAskEmail(change.askEmail);
      onChanged();
    } catch {
      setError(t('failed'));
    } finally {
      setBusy(false);
    }
  }

  return <div className="permission-mode" data-permission-mode={mode}>
    <div className="chip-row" role="group" aria-label={t('label')}>
      {(['strict', 'standard', 'full'] as const).map((name) => (
        <button key={name} type="button" className="chip" aria-pressed={mode === name} disabled={busy} onClick={() => { if (name !== mode) void save({ mode: name }); }}>
          {t(name)}
        </button>
      ))}
    </div>
    <p className="helper">{t(`${mode}Hint` as 'strictHint')}</p>
    {mode === 'full' ? <label className="permission-email">
      <input type="checkbox" checked={askEmail} disabled={busy} onChange={(event) => void save({ askEmail: event.target.checked })} />
      {t('askEmail')}
    </label> : null}
    {error ? <p className="warn" role="alert">{error}</p> : null}
  </div>;
}

type Rule = 'allow' | 'ask' | 'deny';

const RULE_TEXT = {
  en: {
    toolsTitle: 'Tools on this computer', computerOps: 'On the computer', other: 'Other tools',
    bash: 'Run commands', edit: 'Change files in the project', fetch: 'Open web pages', wholeServer: 'All of {name}',
    allow: 'Run', ask: 'Ask me', deny: 'Block', follows: 'Follows the mode: {what}', reset: 'Back to the mode',
    connected: 'connected', needs_auth: 'needs sign-in', failed: 'not connecting', unknown: 'unknown',
    toolsHint: 'Tools appear here the first time this employee uses them. A new tool follows the mode: read-only tools run, tools that change data ask.',
    saveFailed: 'Could not save this tool setting.',
  },
  zh: {
    toolsTitle: '这台电脑上的工具', computerOps: '电脑操作', other: '其他工具',
    bash: '运行命令', edit: '修改项目里的文件', fetch: '访问网页', wholeServer: '{name} 全部',
    allow: '直接用', ask: '先问我', deny: '不允许', follows: '跟随模式：{what}', reset: '恢复跟随模式',
    connected: '已连接', needs_auth: '需要登录', failed: '连接失败', unknown: '状态未知',
    toolsHint: '员工第一次用到某个工具，它就会出现在这里。新工具先跟随模式：查询类直接用，会改数据的先问你。',
    saveFailed: '没能保存这个工具的设置。',
  },
} satisfies Dict<string>;

// Mirrors apps/link/policy.mjs: what the mode does with a tool when no rule is set (the computer decides for real).
const READ_VERB = /^(get|list|search|find|query|read|fetch|lookup|describe|show|view|count|check|status|guide|preview|summar|explain|export|download|inspect|browse)/i;
const WRITE_VERB = /^(create|update|delete|remove|approve|reject|send|post|record|mark|assign|set|add|write|upload|pay|cancel|submit|move|rename|archive|close|reopen|forward|reply|invite|grant|revoke|edit|patch|put|insert|import|publish|trigger|run|execute|book|order|refund|transfer)/i;
function modeDefault(mode: PermissionModeName, tool: string, askEmail: boolean): Rule {
  const match = /^mcp__(.+?)__(.+)$/.exec(tool);
  const mcp = match ? { server: match[1] ?? '', name: match[2] ?? '' } : null;
  const mail = Boolean(mcp && /(gmail|outlook|microsoft[_-]?365|mail|exchange|smtp)/i.test(mcp.server) && /^(send|reply|forward)/i.test(mcp.name));
  if (mail) return askEmail || mode !== 'full' ? 'ask' : 'allow';
  if (mode === 'full') return 'allow';
  if (mode === 'strict') return 'ask';
  if (tool === 'Edit' || tool === 'WebFetch') return 'allow';
  if (tool === 'Bash') return 'ask';
  if (mcp) return !WRITE_VERB.test(mcp.name) && READ_VERB.test(mcp.name) ? 'allow' : 'ask';
  return 'ask';
}

function RuleSwitch({ label, tool, rule, fallback, busy, onSet }: {
  label: string; tool: string; rule: Rule | undefined; fallback: Rule; busy: boolean; onSet: (tool: string, rule: Rule | null) => void;
}) {
  const t = useT(RULE_TEXT);
  return <li className="tool-rule" data-tool={tool} data-rule={rule ?? 'mode'}>
    <span className="tool-rule-name" title={tool}>{label}</span>
    <span className="chip-row" role="group" aria-label={label}>
      {(['allow', 'ask', 'deny'] as const).map((value) => (
        <button key={value} type="button" className="chip chip-small" aria-pressed={rule === value} disabled={busy}
          onClick={() => onSet(tool, rule === value ? null : value)}>{t(value)}</button>
      ))}
    </span>
    <small className="tool-rule-note">{rule ? <button type="button" className="exec-link" onClick={() => onSet(tool, null)}>{t('reset')}</button> : t('follows', { what: t(fallback) })}</small>
  </li>;
}

export function ToolRules({ device, employeeId, onChanged }: { device: LinkDevice; employeeId: string; onChanged: () => void }) {
  const t = useT(RULE_TEXT);
  const policy = policyOf(device, employeeId);
  const [rules, setRules] = useState<Record<string, Rule>>(policy.rules ?? {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mode = policy.mode;
  const askEmail = policy.askEmail !== false;
  const seen = policy.seen ?? [];
  const servers = device.capabilities.mcpServers ?? [];
  const serverNames = new Set(servers.map((server) => server.name));
  const toolsOf = (name: string) => seen.filter((tool) => tool.startsWith(`mcp__${name}__`));
  const others = seen.filter((tool) => /^mcp__/.test(tool) && ![...serverNames].some((name) => tool.startsWith(`mcp__${name}__`)));

  async function set(tool: string, rule: Rule | null) {
    setBusy(true);
    setError('');
    try {
      const response = await api(`/api/v1/workers/${encodeURIComponent(device.id)}/permissions`, {
        method: 'POST', body: JSON.stringify({ employeeId, tool, rule }),
      });
      if (response.status !== 200) throw new Error('failed');
      setRules((current) => {
        const next = { ...current };
        if (rule) next[tool] = rule; else delete next[tool];
        return next;
      });
      onChanged();
    } catch {
      setError(t('saveFailed'));
    } finally {
      setBusy(false);
    }
  }

  const row = (label: string, tool: string, serverRule?: Rule) => (
    <RuleSwitch key={tool} label={label} tool={tool} rule={rules[tool]} busy={busy} onSet={(name, rule) => void set(name, rule)}
      fallback={serverRule ?? modeDefault(mode, tool, askEmail)} />
  );

  return <details className="tool-rules disclosure">
    <summary>{t('toolsTitle')}</summary>
    <p className="helper">{t('toolsHint')}</p>
    <h4>{t('computerOps')}</h4>
    <ul>{row(t('bash'), 'Bash')}{row(t('edit'), 'Edit')}{row(t('fetch'), 'WebFetch')}</ul>
    {servers.map((server) => {
      const key = `mcp__${server.name}`;
      return <section key={server.name} className="tool-rules-server" data-mcp={server.name}>
        <h4>{server.name} <span className={`state ${server.status === 'connected' ? 'is-good' : server.status === 'needs_auth' ? 'is-warn' : server.status === 'failed' ? 'is-bad' : ''}`}>{t(server.status)}</span></h4>
        <ul>
          {row(t('wholeServer', { name: server.name }), key)}
          {toolsOf(server.name).map((tool) => row(tool.slice(key.length + 2), tool, rules[key]))}
        </ul>
      </section>;
    })}
    {others.length ? <section className="tool-rules-server"><h4>{t('other')}</h4><ul>{others.map((tool) => row(tool, tool))}</ul></section> : null}
    {error ? <p className="warn" role="alert">{error}</p> : null}
  </details>;
}
