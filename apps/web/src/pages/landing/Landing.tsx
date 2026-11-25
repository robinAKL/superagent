import { LANGS, useLang, useT } from '../../i18n';
import mark from '../../assets/landing/innopro-mark.svg';
import roomZh from '../../assets/landing/room-zh.webp';
import roomEn from '../../assets/landing/room-en.webp';
import taskZh from '../../assets/landing/task-zh.webp';
import taskEn from '../../assets/landing/task-en.webp';
import calendarZh from '../../assets/landing/calendar-zh.webp';
import calendarEn from '../../assets/landing/calendar-en.webp';
import phoneZh from '../../assets/landing/room-phone-zh.webp';
import phoneEn from '../../assets/landing/room-phone-en.webp';
import './Landing.css';

/**
 * The public front page of Super Agent (super.innopro.co.nz), shown to visitors who are not signed in. Built with
 * Hallmark: every picture is a screenshot of the real app running on sample data (apps/e2e server, sample names).
 * It leads to a free-pilot request (an email to INNOPRO) or to sign-in.
 */
const PILOT_MAIL = 'hello@innopro.co.nz';

const SHOTS = {
  zh: { room: roomZh, task: taskZh, calendar: calendarZh, phone: phoneZh },
  en: { room: roomEn, task: taskEn, calendar: calendarEn, phone: phoneEn },
};

const TEXT = {
  zh: {
    title: 'Super Agent · INNOPRO', language: '界面语言', home: 'INNOPRO Super Agent 首页',
    navWork: '怎么干活', navPilot: '免费试点', navQa: '常见问题', signIn: '登录',
    h1: '一句话，|数字员工就开工',
    lead: '在指挥室 @数字员工派活，做完回报给你，关键一步你来拍板。',
    apply: '申请免费试点', terms: '首期免费，只招少量新西兰本地企业。',
    roomAlt: 'Super Agent 指挥室：左边是数字员工，中间是派活和回报的对话，右边是任务进度。',
    proofTitle: '每件事都有回报和依据',
    proofLead: '派出去的活，谁在做、做到哪、凭什么，一点就看到。',
    proof1: '派活', proof1d: '超级智能体听懂你的话，交给对的数字员工。',
    proof2: '回报', proof2d: '员工做完，在对话里回报结果。',
    proof3: '依据', proof3d: '来源、权限和结果都记在任务上，随时回看。',
    taskAlt: '任务详情：订单核对的来源消息、状态、权限和回报结果。',
    calTitle: '到点自己开工',
    calLead: '每天、每周、每月固定要做的事，排进日历，按时交给对应的员工。',
    cal1t: '每天 08:30', cal1: '检查新订单',
    cal2t: '每周一 09:00', cal2: '出销售周报',
    cal3t: '每月最后一天 17:00', cal3: '应收对账',
    calNote: '这类流程可以从你的资料里找出来，你确认后才启用。',
    calAlt: '日历周视图：每天 08:30 的新订单检查排给订单专员。',
    fitTitle: '接进你已经在用的东西',
    fit1: '邮件', fit1d: '客户来信变成任务，回复先给你过目再发。',
    fit2: '资料', fit2d: '手册、价格表、数据库都能读，回答带出处。',
    fit3: '业务系统', fit3d: 'CRM、ERP、Microsoft 365，通过 MCP 连接，不用换系统。',
    fit4: '你的电脑', fit4d: '员工在你自己的电脑上，用 Claude Code 或 Codex 干活。',
    safe: '对外发信、下单、付款，都先问你。',
    safeLead: '每个员工能用哪些工具，由你逐个开关；每一步都留记录。',
    pilotTitle: '首期免费试点',
    pilotLead: '我们帮你把第一批数字员工用起来，你告诉我们哪里好用、哪里不好用。',
    pilot1: '一对一梳理你的业务流程', pilot2: '配置第一批数字员工和定时流程', pilot3: '接入你的邮箱和业务系统', pilot4: '上线后持续陪跑和调整',
    pilotFit: '适合员工 2 到 50 人、流程多、重复工作多的新西兰本地企业。',
    pilotMail: '也可以直接写信到 {mail}',
    phoneAlt: '手机上的指挥室：同样可以派活、看回报。',
    phoneCap: '手机上也能派活、看回报。',
    qaTitle: '常见问题',
    q1: '要换掉现在的系统吗？', a1: '不用。数字员工直接连你现有的邮箱和系统。',
    q2: '要会写代码吗？', a2: '不用。派活就是说一句话，授权时页面会引导你。',
    q3: '数字员工会自己乱发邮件吗？', a3: '不会。对外的事都要你确认才发出。',
    q4: '试点怎么收费？', a4: '首期免费，名额有限，只需要你真实使用并反馈。',
    footLine: '人少事多的公司，也能有一支干活的团队。',
    footSite: 'innopro.co.nz', legal: '© 2026 INNOPRO，新西兰',
    mailSubject: '申请 Super Agent 首期免费试点',
    mailBody: '公司名称：\n所在城市：\n行业：\n员工人数：\n最想交给数字员工的工作：\n联系人与电话：\n',
  },
  en: {
    title: 'Super Agent · INNOPRO', language: 'Language', home: 'INNOPRO Super Agent home',
    navWork: 'How it works', navPilot: 'Free pilot', navQa: 'Questions', signIn: 'Sign in',
    h1: 'Say it once, the work gets done',
    lead: 'Assign work to digital employees in one room. They report back; you approve what matters.',
    apply: 'Apply for the free pilot', terms: 'Free first phase, for a few New Zealand businesses.',
    roomAlt: 'The Super Agent command room: digital employees on the left, the conversation where work is assigned and reported in the middle, task progress on the right.',
    proofTitle: 'Every task reports back',
    proofLead: 'Who has it and how far it got, one click away.',
    proof1: 'Assigned', proof1d: 'Super Agent hands your request to the right employee.',
    proof2: 'Reported', proof2d: 'The employee reports back in the conversation.',
    proof3: 'On record', proof3d: 'The source, permissions and result stay on the task.',
    taskAlt: 'Task details: the source message, status, permissions and reported result of an order check.',
    calTitle: 'Work that starts on time',
    calLead: 'Daily, weekly and monthly jobs go on a calendar and start with the right employee.',
    cal1t: 'Every day 08:30', cal1: 'New-order check',
    cal2t: 'Mondays 09:00', cal2: 'Weekly sales report',
    cal3t: 'Last day of the month 17:00', cal3: 'Receivables check',
    calNote: 'Super Agent can find these routines in your documents. Nothing runs until you switch it on.',
    calAlt: 'Calendar week view: the 08:30 new-order check assigned to the order coordinator each day.',
    fitTitle: 'Works with what you already use',
    fit1: 'Email', fit1d: 'Customer email becomes a task. Replies wait for your review.',
    fit2: 'Documents', fit2d: 'Manuals, price lists and databases, with sources in every answer.',
    fit3: 'Business systems', fit3d: 'CRM, ERP and Microsoft 365 over MCP. No system to replace.',
    fit4: 'Your computers', fit4d: 'Employees work on your own computers with Claude Code or Codex.',
    safe: 'Emails out, orders and payments wait for you.',
    safeLead: 'You switch each employee’s tools on or off one by one, and every step is recorded.',
    pilotTitle: 'The free pilot',
    pilotLead: 'We get your first digital employees working. You tell us what works and what does not.',
    pilot1: 'A one-to-one review of your processes', pilot2: 'Your first digital employees and schedules', pilot3: 'Your mailbox and business systems connected', pilot4: 'Ongoing help after go-live',
    pilotFit: 'For New Zealand businesses of 2 to 50 people with many processes and repeat work.',
    pilotMail: 'Or write to {mail}',
    phoneAlt: 'The command room on a phone: assign work and read reports.',
    phoneCap: 'Assign work and read reports from your phone.',
    qaTitle: 'Questions',
    q1: 'Do we replace our systems?', a1: 'No. Employees connect to the mailbox and systems you have.',
    q2: 'Do we need to code?', a2: 'No. You assign work in a message; sign-ins are guided.',
    q3: 'Will it send email on its own?', a3: 'No. Anything that leaves the company waits for you.',
    q4: 'What does the pilot cost?', a4: 'Nothing in the first phase. We ask for real use and feedback.',
    footLine: 'A small company can still have a team that gets work done.',
    footSite: 'innopro.co.nz', legal: '© 2026 INNOPRO, New Zealand',
    mailSubject: 'Super Agent free pilot application',
    mailBody: 'Company:\nCity:\nIndustry:\nNumber of staff:\nWork you would most like digital employees to take on:\nContact name and phone:\n',
  },
};

function Shot({ src, alt, w, h, priority = false, className = '' }: { src: string; alt: string; w: number; h: number; priority?: boolean; className?: string }) {
  return (
    <figure className={`lp-shot ${className}`} data-slot={className || 'shot'} data-kind="product">
      <img src={src} alt={alt} width={w} height={h} decoding="async" {...(priority ? { fetchPriority: 'high' as const } : { loading: 'lazy' as const })} />
    </figure>
  );
}

export function Landing({ onSignIn }: { onSignIn: () => void }) {
  const t = useT(TEXT);
  const [lang, setLang] = useLang();
  const shots = SHOTS[lang];
  const mail = `mailto:${PILOT_MAIL}?subject=${encodeURIComponent(t('mailSubject'))}&body=${encodeURIComponent(t('mailBody'))}`;
  document.title = t('title');

  return (
    <div className="lp" lang={lang === 'zh' ? 'zh-CN' : 'en'}>
      <header className="lp-nav">
        <div className="container lp-nav-row">
          <a className="lp-brand" href="#home" aria-label={t('home')}>
            <img src={mark} alt="" width={24} height={28} />
            <b className="lp-wordmark">INNOPRO</b><span>Super Agent</span>
          </a>
          <nav className="lp-links" aria-label={t('navWork')}>
            <a href="#lp-work">{t('navWork')}</a>
            <a href="#lp-pilot">{t('navPilot')}</a>
            <a href="#lp-qa">{t('navQa')}</a>
          </nav>
          <div className="lp-nav-end">
            <div className="lp-lang" role="group" aria-label={t('language')}>
              {LANGS.map((item) => (
                <button key={item.id} type="button" lang={item.htmlLang} aria-pressed={item.id === lang} onClick={() => setLang(item.id)}>{item.label}</button>
              ))}
            </div>
            <button type="button" className="lp-btn lp-btn--quiet" onClick={onSignIn}>{t('signIn')}</button>
          </div>
        </div>
      </header>

      <main>
        <section className="lp-hero" id="home">
          <div className="container lp-hero-grid">
            <div className="lp-hero-text">
              <h1>{t('h1').split('|').map((line, i) => <span key={i}>{line}</span>)}</h1>
              <p className="lead">{t('lead')}</p>
              <div className="lp-actions">
                <a className="lp-btn lp-btn--primary" href={mail}>{t('apply')}</a>
                <button type="button" className="lp-btn lp-btn--secondary" onClick={onSignIn}>{t('signIn')}</button>
              </div>
              <p className="lp-terms">{t('terms')}</p>
            </div>
            <Shot src={shots.room} alt={t('roomAlt')} w={2560} h={1552} priority className="hero" />
          </div>
        </section>

        <section className="lp-proof" id="lp-work">
          <div className="container">
            <div className="lp-head lp-head--split">
              <h2>{t('proofTitle')}</h2>
              <p className="lead">{t('proofLead')}</p>
            </div>
            <Shot src={shots.task} alt={t('taskAlt')} w={2340} h={1330} className="task" />
            <ol className="lp-proof-list">
              <li><h3>{t('proof1')}</h3><p>{t('proof1d')}</p></li>
              <li><h3>{t('proof2')}</h3><p>{t('proof2d')}</p></li>
              <li><h3>{t('proof3')}</h3><p>{t('proof3d')}</p></li>
            </ol>
          </div>
        </section>

        <section className="lp-fit">
          <div className="container lp-fit-grid">
            <h2>{t('fitTitle')}</h2>
            <dl className="lp-rows">
              <div><dt>{t('fit1')}</dt><dd>{t('fit1d')}</dd></div>
              <div><dt>{t('fit2')}</dt><dd>{t('fit2d')}</dd></div>
              <div><dt>{t('fit3')}</dt><dd>{t('fit3d')}</dd></div>
              <div><dt>{t('fit4')}</dt><dd>{t('fit4d')}</dd></div>
            </dl>
          </div>
        </section>

        <section className="lp-cal">
          <div className="container">
            <div className="lp-cal-head">
              <div className="lp-cal-text">
                <h2>{t('calTitle')}</h2>
                <p className="lead">{t('calLead')}</p>
              </div>
              <dl className="lp-times">
                <div><dt>{t('cal1t')}</dt><dd>{t('cal1')}</dd></div>
                <div><dt>{t('cal2t')}</dt><dd>{t('cal2')}</dd></div>
                <div><dt>{t('cal3t')}</dt><dd>{t('cal3')}</dd></div>
              </dl>
            </div>
            <Shot src={shots.calendar} alt={t('calAlt')} w={2880} h={1170} className="calendar" />
            <p className="lp-note lp-cal-note">{t('calNote')}</p>
          </div>
        </section>

        <section className="lp-safe">
          <div className="container">
            <p className="lp-statement">{t('safe')}</p>
            <p className="lead">{t('safeLead')}</p>
          </div>
        </section>

        <section className="lp-pilot" id="lp-pilot">
          <div className="container lp-pilot-grid">
            <div className="lp-pilot-text">
              <h2>{t('pilotTitle')}</h2>
              <p className="lead">{t('pilotLead')}</p>
              <ol className="lp-offer">
                <li>{t('pilot1')}</li>
                <li>{t('pilot2')}</li>
                <li>{t('pilot3')}</li>
                <li>{t('pilot4')}</li>
              </ol>
              <p className="lp-note">{t('pilotFit')}</p>
              <div className="lp-actions">
                <a className="lp-btn lp-btn--primary" href={mail}>{t('apply')}</a>
              </div>
              <p className="lp-note">{t('pilotMail', { mail: PILOT_MAIL })}</p>
            </div>
            <figure className="lp-phone">
              <Shot src={shots.phone} alt={t('phoneAlt')} w={780} h={1688} className="phone" />
              <figcaption>{t('phoneCap')}</figcaption>
            </figure>
          </div>
        </section>

        <section className="lp-qa" id="lp-qa">
          <div className="container lp-fit-grid">
            <h2>{t('qaTitle')}</h2>
            <dl className="lp-rows lp-rows--qa">
              <div><dt>{t('q1')}</dt><dd>{t('a1')}</dd></div>
              <div><dt>{t('q2')}</dt><dd>{t('a2')}</dd></div>
              <div><dt>{t('q3')}</dt><dd>{t('a3')}</dd></div>
              <div><dt>{t('q4')}</dt><dd>{t('a4')}</dd></div>
            </dl>
          </div>
        </section>
      </main>

      <footer className="lp-foot">
        <div className="container">
          <div className="lp-foot-mast">
            <img src={mark} alt="" width={48} height={55} />
            <p>{t('footLine')}</p>
          </div>
          <div className="lp-foot-links">
            <a href={mail}>{t('apply')}</a>
            <button type="button" className="lp-link lp-btn--quiet lp-btn" onClick={onSignIn}>{t('signIn')}</button>
            <a href="https://innopro.co.nz">{t('footSite')}</a>
            <small>{t('legal')}</small>
          </div>
        </div>
      </footer>
    </div>
  );
}
