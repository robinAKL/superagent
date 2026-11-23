import { useEffect, useState, type ReactNode } from 'react';
import { SetupPage } from './pages/SetupPage';
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

type NavGroupId = 'daily' | 'build';
type NavItemId = 'room' | 'work' | 'employees' | 'knowledge' | 'settings';
type PageId = NavItemId | 'tools' | 'brain' | 'connect';
type NavItem = { id: NavItemId };

/**
 * Five destinations in a top bar (UX plan step 2; Hallmark app screens: a sidebar is earned past about seven).
 * Daily work for everyone; building the team for administrators. The server still decides what each role may call.
 */
const NAV: { group: NavGroupId; items: NavItem[] }[] = [
  { group: 'daily', items: [{ id: 'room' }, { id: 'work' }] },
  { group: 'build', items: [{ id: 'employees' }, { id: 'knowledge' }, { id: 'settings' }] },
];

/** Pages that left the menu keep their routes and light up the destination they now belong to. */
// The super agent page now holds workflows, which belong to the team (UX plan step 6); its company profile moved to settings.
const PARENT: Partial<Record<PageId, NavItemId>> = { tools: 'employees', brain: 'employees' };
const PAGES: readonly PageId[] = ['room', 'work', 'employees', 'knowledge', 'settings', 'tools', 'brain', 'connect'];

type ShellKey = `group.${NavGroupId}` | `nav.${NavItemId}` | 'menu' | 'signOut' | 'language' | 'noRole';

const TEXT: Dict<ShellKey> = {
  en: {
    'group.daily': 'Daily work',
    'group.build': 'Team and setup',
    'nav.room': 'Command room',
    'nav.work': 'My work',
    'nav.employees': 'Digital employees',
    'nav.knowledge': 'Company knowledge',
    'nav.settings': 'Admin settings',
    menu: 'Main menu',
    signOut: 'Sign out',
    noRole: 'Your account has no Super Agent role yet, so there is nothing you can open here. Ask an administrator to assign you a role (Owner, Admin, Employee or Reviewer) for this app, then sign out and back in.',
    language: 'Language',
  },
  zh: {
    'group.daily': '日常工作',
    'group.build': '团队与配置',
    'nav.room': '指挥室',
    'nav.work': '待我处理',
    'nav.employees': '数字员工',
    'nav.knowledge': '企业知识',
    'nav.settings': '管理设置',
    menu: '主菜单',
    signOut: '退出',
    noRole: '你的账号还没有 Super Agent 角色，所以这里暂时没有可用的内容。请联系管理员为你分配此应用的角色（所有者、管理员、员工或审核人），然后退出并重新登录。',
    language: '语言',
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

export function canManage(roles: readonly string[] | null): boolean {
  return roles === null || roles.some(role => role === 'owner' || role === 'admin');
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

function useHashPage(): PageId {
  const read = (): PageId => {
    const id = window.location.hash.slice(1).split('?')[0] || 'room';
    return (PAGES as readonly string[]).includes(id) ? id as PageId : 'room';
  };
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
  const requested = useHashPage();
  const roles = useRoles();
  const nav = navFor(roles);
  const allowed = new Set<PageId>(nav.flatMap(g => g.items.map(i => i.id)));
  for (const [child, parent] of Object.entries(PARENT)) if (allowed.has(parent)) allowed.add(child as PageId);
  allowed.add('connect');
  // A page the menu does not offer this role falls back to the command room, as before.
  const page: PageId = allowed.has(requested) ? requested : 'room';
  const current = PARENT[page] ?? page;
  const pages: Record<PageId, () => ReactNode> = {
    room: () => <CommandRoomPage />,
    work: () => <WorkInboxPage />,
    employees: () => <EmployeesPage />,
    knowledge: () => <KnowledgePage />,
    settings: () => <SetupPage />,
    tools: () => <ToolsPage />,
    brain: () => <SuperAgentPage />,
    connect: () => <ConnectComputerPage canManage={canManage(roles)} />,
  };
  return (
    <>
      <header className="topbar">
        <span className="brand">INNOPRO</span>
        <span className="product">Super Agent</span>
        <nav className="topnav" aria-label={t('menu')}>
          {nav.map((g) => (
            <div key={g.group} className="topnav-group" role="group" aria-label={t(`group.${g.group}`)}>
              {g.items.map((i) => (
                <a key={i.id} className="nav-item" href={`#${i.id}`} aria-current={i.id === current ? 'page' : undefined}>{t(`nav.${i.id}`)}</a>
              ))}
            </div>
          ))}
        </nav>
        <span className="topbar-end">
          <LangSwitch label={t('language')} />
          {user.mode === 'entra' ? (
            <span className="who">
              <span title={user.username}>{user.name ?? user.username}</span>
              <button className="btn quiet" type="button" onClick={() => void signOut()}>{t('signOut')}</button>
            </span>
          ) : null}
        </span>
      </header>
      <main className="content">
        {roles !== null && roles.length === 0 ? <section className="panel" role="alert"><p>{t('noRole')}</p></section> : pages[page]()}
      </main>
    </>
  );
}
