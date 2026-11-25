import { useEffect, useState } from 'react';
import { LangSwitch, useT } from '../i18n';
import './Landing.css';

/**
 * The public front page of Super Agent (super.innopro.co.nz), shown to visitors who are not signed in. It says what
 * the product does for a small company with few people and many processes, and leads to sign-in or a pilot request.
 */
const PILOT_MAIL = 'hello@innopro.co.nz';

const TEXT = {
  zh: {
    navPains: '痛点', navHow: '怎么运作', navFeatures: '能力', navPilot: '首期免费', signIn: '登录', language: '语言',
    badge: '新西兰本地企业 · 首期免费落地招募中',
    heroTitle: '人少事多，流程复杂？\n让 AI 数字员工把活干起来',
    heroLead: 'Super Agent 先读懂你公司的资料，组建一支数字员工团队：自动派活、盯进度、按时跑流程、收邮件转任务。关键操作仍由你拍板。',
    heroCta: '申请首期免费落地', heroSecondary: '已有账号，登录',
    heroNote: '不用写代码，不用换系统。用你现有的电脑、邮箱和业务系统。',
    mockRoom: '指挥室', mockUser: '把这周新订单核对一遍，有问题的列出来', mockAgent: '已交给 @订单专员：核对本周 12 张新订单', mockReport: '核对完成：2 张单价不一致，已列在下面，等你确认。',
    mockClerk: '@订单专员', mockBoard: '看板', mockDone: '已完成', mockRunning: '进行中', mockWaiting: '等你确认',
    mockT1: '每周一 09:00 汇总周报', mockT2: '收到询价邮件 → 起草报价', mockT3: '供应商下单 · 待审批',
    painsTitle: '这些事，是不是每天都在发生？',
    pain1: '一个人顶三个岗', pain1d: '接单、对账、跟供应商、回客户邮件，全靠几个人来回切换，重要的事总被琐事打断。',
    pain2: '流程全靠人记、靠人催', pain2d: '每周的报表、每月的对账、到期的跟进，一忙就忘，出了错才发现。',
    pain3: '资料散在各处', pain3d: '价格表在 Excel，规则在邮件，经验在老员工脑子里，新人上手慢，问一圈也找不到依据。',
    pain4: '想用 AI，不知道从哪下手', pain4d: '聊天机器人只会回答问题，真正要它干活、接进业务系统、又要安全可控，就卡住了。',
    howTitle: '四步，让数字员工上岗',
    how1: '交资料', how1d: '上传操作手册、价格表、合同模板，或接入邮箱和业务系统。',
    how2: '自动分析', how2d: 'Super Agent 读懂资料，提出岗位、工具和业务流程，每一条都带原文依据。',
    how3: '数字员工上岗', how3d: '在你自己的电脑上，用 Claude Code / Codex 等 AI 客户端执行任务，结果回报到指挥室。',
    how4: '你来拍板', how4d: '对外发信、下单、付款等关键动作先问你，全部留痕可追溯。',
    featuresTitle: '一个指挥室，管好整个数字团队',
    f1: '指挥室', f1d: '像在群里一样说话、@员工派活。Super Agent 当主持人和项目经理：拆任务、盯进度、催卡点。',
    f2: '数字员工', f2d: '按你的业务组建岗位：订单专员、财务助理、客服……每个员工有职责、工具和权限边界。',
    f3: '企业知识', f3d: '文件、表格、数据库、MCP 连接都能接入，回答必有出处，找不到依据就直说。',
    f4: '日历与定时流程', f4d: '从资料里自动找出「每周一」「每月最后一天」这类流程，确认后按时自动开工。',
    f5: '邮件自动化', f5d: '员工邮箱收到的邮件自动变成任务，回复先给你过目，确认后才发出。',
    f6: '待我处理', f6d: '所有需要人决定的事集中一处：审批、核对、补充信息，手机上也能处理。',
    f7: '接入你的系统', f7d: 'CRM、ERP、Gmail、Microsoft 365……通过 MCP 和本地客户端连接，不用换掉现有系统。',
    f8: '安全可控', f8d: '三档权限模式、逐个工具开关、关键动作审批、全程审计；数据留在你的电脑和澳洲数据中心。',
    forTitle: '特别适合这些公司',
    for1: '贸易与批发', for1d: '询价、报价、下单、对账、发货跟踪',
    for2: '定制与制造', for2d: '订单核对、供应商下单、生产与交付进度',
    for3: '专业服务', for3d: '客户资料整理、文书起草、到期提醒',
    for4: '物业与运营', for4d: '报修工单、定期巡检、租户沟通',
    pilotTitle: '首期免费落地 · 只招少量新西兰本地企业',
    pilotLead: '我们为每家入选企业免费完成实施：梳理流程、配置数字员工、陪跑上线。你只需要真实使用，并告诉我们哪里好用、哪里不好用。',
    pilot1: '一对一梳理你的业务流程', pilot2: '配置第一批数字员工和定时流程', pilot3: '接入你的邮箱和业务系统', pilot4: '上线后持续陪跑和优化',
    pilotFit: '适合：员工 2–50 人，流程多、重复工作多、愿意尝鲜并给反馈的新西兰本地企业。',
    pilotCta: '申请首期免费落地', pilotMail: '或发邮件到 {mail}',
    footer: '© INNOPRO · Super Agent · 新西兰',
    mailSubject: '申请 Super Agent 首期免费落地',
    mailBody: '公司名称：\n所在城市：\n行业：\n员工人数：\n最想交给数字员工的工作：\n联系人与电话：\n',
  },
  en: {
    navPains: 'Problems', navHow: 'How it works', navFeatures: 'Features', navPilot: 'Free pilot', signIn: 'Sign in', language: 'Language',
    badge: 'New Zealand businesses · free pilot now open',
    heroTitle: 'Small team, too much to do?\nPut AI digital employees to work',
    heroLead: 'Super Agent learns your company from its own documents and builds a team of digital employees that take on work, chase progress, run processes on schedule and turn email into tasks. You still make the key calls.',
    heroCta: 'Apply for the free pilot', heroSecondary: 'Sign in',
    heroNote: 'No code, no new system. Works with the computers, mailboxes and business systems you already use.',
    mockRoom: 'Command room', mockUser: 'Check this week’s new orders and list any problems', mockAgent: 'Assigned to @Order clerk: check 12 new orders', mockReport: 'Done: 2 orders have mismatched prices, listed below for you to confirm.',
    mockClerk: '@Order clerk', mockBoard: 'Board', mockDone: 'Done', mockRunning: 'Running', mockWaiting: 'Waiting for you',
    mockT1: 'Weekly report, Monday 09:00', mockT2: 'Quote request email → draft quote', mockT3: 'Supplier order · needs approval',
    painsTitle: 'Does this happen every day?',
    pain1: 'One person, three jobs', pain1d: 'Orders, reconciliation, suppliers and customer email all fall on a few people, and the important work keeps getting interrupted.',
    pain2: 'Processes live in people’s heads', pain2d: 'Weekly reports, month-end reconciliation and follow-ups get forgotten when it’s busy, and mistakes show up late.',
    pain3: 'Knowledge is scattered', pain3d: 'Prices in Excel, rules in email, know-how in senior staff. New people take ages, and nobody can find the source.',
    pain4: 'AI, but where to start?', pain4d: 'Chatbots answer questions. Getting AI to actually do work, inside your systems, safely, is where it stalls.',
    howTitle: 'Four steps to a working digital team',
    how1: 'Share your documents', how1d: 'Upload manuals, price lists and templates, or connect your mailbox and business systems.',
    how2: 'Automatic analysis', how2d: 'Super Agent proposes roles, tools and workflows, each backed by a quote from your sources.',
    how3: 'Digital employees start', how3d: 'They work on your own computer through AI clients such as Claude Code and Codex, and report back to the command room.',
    how4: 'You decide', how4d: 'Sending email, placing orders and payments ask you first. Everything is recorded.',
    featuresTitle: 'One command room for your whole digital team',
    f1: 'Command room', f1d: 'Talk like in a group chat and @mention employees. Super Agent hosts and project-manages: splits work, tracks progress, chases blockers.',
    f2: 'Digital employees', f2d: 'Roles built around your business: order clerk, finance assistant, customer service, each with duties, tools and limits.',
    f3: 'Company knowledge', f3d: 'Files, spreadsheets, databases and MCP connections. Answers always cite their source, or say none was found.',
    f4: 'Calendar & scheduled processes', f4d: 'Finds “every Monday” or “last day of the month” processes in your documents and runs them on time once you confirm.',
    f5: 'Email automation', f5d: 'Mail to an employee’s mailbox becomes its task; replies wait for your OK before they go out.',
    f6: 'My work', f6d: 'Everything that needs a person in one place: approvals, checks, missing details. Works on your phone too.',
    f7: 'Your systems', f7d: 'CRM, ERP, Gmail, Microsoft 365… connected through MCP and local clients. Keep the systems you have.',
    f8: 'Safe and controlled', f8d: 'Three permission modes, per-tool switches, approvals for key actions and a full audit trail. Data stays on your computer and in Australian data centres.',
    forTitle: 'Made for businesses like these',
    for1: 'Trade & wholesale', for1d: 'Quotes, orders, reconciliation, shipment tracking',
    for2: 'Custom & manufacturing', for2d: 'Order checks, supplier orders, production and delivery',
    for3: 'Professional services', for3d: 'Client files, drafting, deadline reminders',
    for4: 'Property & operations', for4d: 'Maintenance jobs, routine inspections, tenant communication',
    pilotTitle: 'Free pilot · a few New Zealand businesses only',
    pilotLead: 'For each business we take on, we do the whole setup for free: map your processes, configure your digital employees and support you through go-live. All we ask is that you really use it and tell us what works and what doesn’t.',
    pilot1: 'One-to-one process mapping', pilot2: 'Your first digital employees and scheduled processes', pilot3: 'Connected to your mailbox and business systems', pilot4: 'Ongoing support after go-live',
    pilotFit: 'A good fit: 2–50 staff, many processes and repetitive work, happy to try new things and share feedback.',
    pilotCta: 'Apply for the free pilot', pilotMail: 'or email {mail}',
    footer: '© INNOPRO · Super Agent · New Zealand',
    mailSubject: 'Super Agent free pilot application',
    mailBody: 'Company:\nCity:\nIndustry:\nNumber of staff:\nWork you would hand to digital employees first:\nContact name and phone:\n',
  },
};

const ICONS = ['◎', '◇', '▤', '◷', '✉', '☑', '⇄', '⛨'];

export function Landing({ onSignIn }: { onSignIn: () => void }) {
  const t = useT(TEXT);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener('scroll', onScroll, { passive: true });
    document.title = 'Super Agent · INNOPRO';
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  const mail = `mailto:${PILOT_MAIL}?subject=${encodeURIComponent(t('mailSubject'))}&body=${encodeURIComponent(t('mailBody'))}`;
  const features = [1, 2, 3, 4, 5, 6, 7, 8] as const;

  return <div className="lp">
    <header className={`lp-nav${scrolled ? ' is-scrolled' : ''}`}>
      <a className="lp-brand" href="#" aria-label="INNOPRO Super Agent"><span className="lp-logo">INNOPRO</span><span className="lp-product">Super Agent</span></a>
      <nav className="lp-links" aria-label="Super Agent">
        <a href="#lp-pains">{t('navPains')}</a><a href="#lp-how">{t('navHow')}</a><a href="#lp-features">{t('navFeatures')}</a><a href="#lp-pilot">{t('navPilot')}</a>
      </nav>
      <div className="lp-nav-end">
        <LangSwitch label={t('language')} />
        <button type="button" className="lp-btn lp-btn-ghost" onClick={onSignIn}>{t('signIn')}</button>
      </div>
    </header>

    <section className="lp-hero">
      <div className="lp-hero-copy">
        <p className="lp-badge">{t('badge')}</p>
        <h1>{t('heroTitle').split('\n').map((line, i) => <span key={i}>{line}</span>)}</h1>
        <p className="lp-lead">{t('heroLead')}</p>
        <div className="lp-cta">
          <a className="lp-btn lp-btn-primary" href="#lp-pilot">{t('heroCta')}</a>
          <button type="button" className="lp-btn lp-btn-ghost" onClick={onSignIn}>{t('heroSecondary')}</button>
        </div>
        <p className="lp-note">{t('heroNote')}</p>
      </div>
      <div className="lp-mock" aria-hidden="true">
        <div className="lp-mock-chat">
          <p className="lp-mock-title">{t('mockRoom')}</p>
          <div className="lp-bubble is-user">{t('mockUser')}</div>
          <div className="lp-bubble is-agent"><b>Super Agent</b>{t('mockAgent')}</div>
          <div className="lp-bubble is-report"><b>{t('mockClerk')}</b>{t('mockReport')}</div>
        </div>
        <div className="lp-mock-board">
          <p className="lp-mock-title">{t('mockBoard')}</p>
          <div className="lp-progress"><span style={{ width: '72%' }} /></div>
          <p className="lp-task is-done">✓ {t('mockT1')}<small>{t('mockDone')}</small></p>
          <p className="lp-task is-running">● {t('mockT2')}<small>{t('mockRunning')}</small></p>
          <p className="lp-task is-waiting">! {t('mockT3')}<small>{t('mockWaiting')}</small></p>
        </div>
      </div>
    </section>

    <section id="lp-pains" className="lp-section">
      <h2>{t('painsTitle')}</h2>
      <div className="lp-grid lp-grid-4">
        {([1, 2, 3, 4] as const).map((n) => <article key={n} className="lp-card lp-pain">
          <span className="lp-num">0{n}</span><h3>{t(`pain${n}`)}</h3><p>{t(`pain${n}d`)}</p>
        </article>)}
      </div>
    </section>

    <section id="lp-how" className="lp-section">
      <h2>{t('howTitle')}</h2>
      <ol className="lp-steps">
        {([1, 2, 3, 4] as const).map((n) => <li key={n}><span className="lp-step-n">{n}</span><h3>{t(`how${n}`)}</h3><p>{t(`how${n}d`)}</p></li>)}
      </ol>
    </section>

    <section id="lp-features" className="lp-section">
      <h2>{t('featuresTitle')}</h2>
      <div className="lp-grid lp-grid-4">
        {features.map((n) => <article key={n} className="lp-card lp-feature">
          <span className="lp-icon" aria-hidden="true">{ICONS[n - 1]}</span><h3>{t(`f${n}`)}</h3><p>{t(`f${n}d`)}</p>
        </article>)}
      </div>
    </section>

    <section className="lp-section">
      <h2>{t('forTitle')}</h2>
      <div className="lp-grid lp-grid-4">
        {([1, 2, 3, 4] as const).map((n) => <article key={n} className="lp-card lp-for"><h3>{t(`for${n}`)}</h3><p>{t(`for${n}d`)}</p></article>)}
      </div>
    </section>

    <section id="lp-pilot" className="lp-section lp-pilot">
      <div>
        <p className="lp-badge">{t('badge')}</p>
        <h2>{t('pilotTitle')}</h2>
        <p className="lp-lead">{t('pilotLead')}</p>
        <ul className="lp-checks">{([1, 2, 3, 4] as const).map((n) => <li key={n}>{t(`pilot${n}`)}</li>)}</ul>
        <p className="lp-note">{t('pilotFit')}</p>
        <div className="lp-cta">
          <a className="lp-btn lp-btn-primary" href={mail}>{t('pilotCta')}</a>
          <span className="lp-note">{t('pilotMail', { mail: PILOT_MAIL })}</span>
        </div>
      </div>
    </section>

    <footer className="lp-footer">
      <span className="lp-logo">INNOPRO</span>
      <span>{t('footer')}</span>
      <button type="button" className="lp-link-btn" onClick={onSignIn}>{t('signIn')}</button>
    </footer>
  </div>;
}
