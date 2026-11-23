import { useEffect, useState } from 'react';
import { SetupPage } from './pages/SetupPage';
import { Icon } from './components/Icon';
import { Placeholder } from './pages/Placeholder';
import { ToolsPage } from './pages/ToolsPage';
import { KnowledgePage } from './pages/KnowledgePage';
import { signOut, type SignedIn } from './auth';
import { authHeaders } from './api';
import { SuperAgentPage } from './pages/SuperAgentPage';
import { CommandRoomPage } from './pages/CommandRoomPage';
import { WorkInboxPage } from './pages/WorkInboxPage';
import { EmployeesPage } from './pages/EmployeesPage';
import { ConnectComputerPage } from './pages/ConnectComputerPage';
import { LangSwitch, useT, type Dict } from './i18n';

type NavGroupId = 'daily' | 'team' | 'config';
type NavItemId = 'room' | 'work' | 'knowledge' | 'employees' | 'tools' | 'brain' | 'settings';
type NavItem = { id: NavItemId; owner: string };

/** Owner navigation: 7 entries, same as the accepted prototype (PRD §1.2). Labels live in TEXT below. */
const NAV: { group: NavGroupId; items: NavItem[] }[] = [
  {
    group: 'daily',
    items: [
      { id: 'room', owner: 'T-41' },
      { id: 'work', owner: 'T-41' },
    ],
  },
  {
    group: 'team',
    items: [
      { id: 'knowledge', owner: 'T-40' },
      { id: 'employees', owner: 'T-42' },
      { id: 'tools', owner: 'T-42' },
    ],
  },
  {
    group: 'config',
    items: [
      { id: 'brain', owner: 'T-40' },
      { id: 'settings', owner: 'T-39' },
    ],
  },
];

type ShellKey = `group.${NavGroupId}` | `nav.${NavItemId}` | 'menu' | 'signOut' | 'language' | 'workspace' | 'collapse' | 'expand' | 'noRole';

const TEXT: Dict<ShellKey> = {
  en: {
    'group.daily': 'Daily work',
    'group.team': 'Team & knowledge',
    'group.config': 'Configuration',
    'nav.room': 'Command room',
    'nav.work': 'My work',
    'nav.knowledge': 'Company knowledge',
    'nav.employees': 'Digital employees',
    'nav.tools': 'Employee tools',
    'nav.brain': 'Super agent',
    'nav.settings': 'Admin settings',
    menu: 'Main menu',
    signOut: 'Sign out',
    noRole: 'Your account has no Super Agent role yet, so there is nothing you can open here. Ask an administrator to assign you a role (Owner, Admin, Employee or Reviewer) for this app, then sign out and back in.',
    language: 'Language',
    workspace: 'Workspace',
    collapse: 'Collapse menu',
    expand: 'Expand menu',
  },
  zh: {
    'group.daily': '日常工作',
    'group.team': '团队与知识',
    'group.config': '配置',
    'nav.room': '指挥室',
    'nav.work': '待我处理',
    'nav.knowledge': '企业知识',
    'nav.employees': '数字员工',
    'nav.tools': '员工工具',
    'nav.brain': '超级智能体',
    'nav.settings': '管理设置',
    menu: '主菜单',
    signOut: '退出',
    noRole: '你的账号还没有 Super Agent 角色，所以这里暂时没有可用的内容。请联系管理员为你分配此应用的角色（所有者、管理员、员工或审核人），然后退出并重新登录。',
    language: '语言',
    workspace: '企业工作区',
    collapse: '收起菜单',
    expand: '展开菜单',
  },
};

/**
 * Someone signed in only as an employee works from the two daily pages (prototype QA: "Employee navigation
 * expanded"). This trims the menu; the server still decides what each role may call.
 */
export function navFor(roles: readonly string[] | null): typeof NAV {
  const staffOnly = roles !== null && roles.includes('employee') && !roles.some((role) => role === 'owner' || role === 'admin' || role === 'reviewer');
  return staffOnly ? NAV.filter((group) => group.group === 'daily') : NAV;
}

function useRoles(): string[] | null {
  const [roles, setRoles] = useState<string[] | null>(null);
  useEffect(() => {
    let stop = false;
    void (async () => {
      try {
        const response = await fetch('/api/v1/room/roster', { headers: await authHeaders() });
        if (!response.ok) return;
        const data = (await response.json()) as { viewer?: { roles?: string[] } };
        if (!stop && Array.isArray(data.viewer?.roles)) setRoles(data.viewer.roles);
      } catch {
        // Without an answer the full menu stays; every module still checks the role on the server.
      }
    })();
    return () => {
      stop = true;
    };
  }, []);
  return roles;
}

const SIDEBAR_KEY = 'superagent.sidebar';
/** Desktop sidebar collapsed to an icon rail; remembered in this browser (storage may be blocked — then it just resets). */
function useCollapsedSidebar(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(SIDEBAR_KEY) === 'collapsed'; } catch { return false; } });
  const toggle = () => setCollapsed(value => {
    try { localStorage.setItem(SIDEBAR_KEY, value ? 'expanded' : 'collapsed'); } catch { /* not remembered */ }
    return !value;
  });
  return [collapsed, toggle];
}

function useHashPage(): string {
  const read = () => window.location.hash.slice(1).split('?')[0] || 'room';
  const [page, setPage] = useState(read);
  useEffect(() => {
    const onChange = () => setPage(read());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return page;
}

export function App({ user = { mode: 'dev' } }: { user?: SignedIn }) {
  const t = useT(TEXT);
  const page = useHashPage();
  const roles = useRoles();
  const nav = navFor(roles);
  const current = nav.flatMap((g) => g.items).find((i) => i.id === page) ?? nav[0]!.items[0]!;
  const [collapsed, toggleSidebar] = useCollapsedSidebar();
  return (
    <>
      <header className="topbar">
        <span className="brand">INNOPRO</span>
        <span className="product">Super Agent</span>
        <span className="topbar-end">
          <LangSwitch label={t('language')} />
          {user.mode === 'entra' ? (
            <span className="who">
              <span title={user.username}>{user.name ?? user.username}</span>
              <button className="btn" type="button" onClick={() => void signOut()}>{t('signOut')}</button>
            </span>
          ) : null}
        </span>
      </header>
      <div className={`app${collapsed ? ' is-collapsed' : ''}`}>
        <nav className="sidebar" aria-label={t('menu')}>
          <div className="sidebar-head">
            <span className="sidebar-title">{t('workspace')}</span>
            <button type="button" className="sidebar-toggle" aria-pressed={collapsed} aria-label={t(collapsed ? 'expand' : 'collapse')} title={t(collapsed ? 'expand' : 'collapse')} onClick={toggleSidebar}>
              <Icon name={collapsed ? 'expand' : 'collapse'} />
            </button>
          </div>
          {nav.map((g) => (
            <div key={g.group}>
              <div className="nav-group">{t(`group.${g.group}`)}</div>
              {g.items.map((i) => (
                <a key={i.id} className="nav-item" href={`#${i.id}`} title={collapsed ? t(`nav.${i.id}`) : undefined} aria-current={i.id === current.id ? 'page' : undefined}>
                  <Icon name={i.id} /><span className="nav-label">{t(`nav.${i.id}`)}</span>
                </a>
              ))}
            </div>
          ))}
        </nav>
        <main className="content">
          {roles !== null && roles.length === 0 ? <section className="panel" role="alert"><p>{t('noRole')}</p></section> : page === 'connect' ? <ConnectComputerPage canManage={roles === null || roles.some(role => role === 'owner' || role === 'admin')} /> : current.id === 'settings' ? <SetupPage /> : current.id === 'tools' ? <ToolsPage /> : current.id === 'knowledge' ? <KnowledgePage /> : current.id === 'brain' ? <SuperAgentPage /> : current.id === 'room' ? <CommandRoomPage /> : current.id === 'work' ? <WorkInboxPage /> : current.id === 'employees' ? <EmployeesPage /> : <Placeholder title={t(`nav.${current.id}`)} owner={current.owner} />}
        </main>
      </div>
    </>
  );
}
