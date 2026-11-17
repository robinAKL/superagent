import { useLang, type Lang } from '../i18n';

/**
 * English for the My work page. The Chinese wording stays the source (server rules, specs and older tests use it);
 * the page translates at display time, so a missing entry falls back to the Chinese text instead of breaking.
 */
const ENGLISH: Readonly<Record<string, string>> = {
  // kinds, renderers, states
  '数据核对与修正': 'Check and correct data',
  '精确动作批准': 'Approve an exact action',
  '人工执行并回填': 'Do it by hand and record the result',
  '正常分支选择': 'Choose a path',
  '例外裁定': 'Rule on an exception',
  '补资料': 'Supply missing information',
  '成果复核': 'Review a deliverable',
  '字段差异卡': 'Field changes',
  '批量明细表': 'Batch table',
  '邮件 / 文档预览': 'Email / document preview',
  '问题清单': 'Issue list',
  '待处理': 'Open', '处理中': 'In progress', '缺资料': 'Needs information', '已决定': 'Decided', '已关闭': 'Closed', '已过期': 'Expired',
  '已撤回，等待按新版本决定': 'Withdrawn; decide again on the new version',
  '待批准': 'Awaiting approval', '已批准，未提交': 'Approved, not submitted', '提交中，等待核对': 'Submitting, waiting to verify',
  '已回读核验': 'Read back and verified', '失败或已取消，不会重发': 'Failed or cancelled; will not be resent', '结果未知，只能回读': 'Outcome unknown; read back only',
  // decision reasons and results
  '版本已变，请按新版本再决定。': 'The version changed. Decide again on the new version.',
  '结果未知，不能再次提交。': 'The outcome is unknown, so it cannot be submitted again.',
  '任务的验收契约已修订，这条批准已作废，不能再用。': 'The task contract was revised. This approval is void and cannot be used.',
  '这次外部动作已执行并回读一致，这条批准不能再用；新的动作需要新的批准。': 'This external action ran and was read back. The approval cannot be reused; a new action needs a new approval.',
  '金额无效，不能确认。': 'The amount is not valid, so it cannot be confirmed.',
  '上游的数据核对还没确认，不能批准写入。': 'The upstream data check is not confirmed yet, so the write cannot be approved.',
  '这一项已经决定过了。': 'This item has already been decided.',
  '没能确认处理结果，请核对当前状态；结果未知的动作只做回读。': 'Could not confirm the result. Check the current state; an action with an unknown outcome is only read back.',
  '这不是分给你的事项，只能查看。': 'This item is not assigned to you. You can only view it.',
  '未配置可用连接器；没有提交任何外部动作，已批准的行仍保留。': 'No connector is configured. Nothing was submitted, and approved rows are kept.',
  '未完成：{reason}': 'Not completed: {reason}',
  '已决定。': 'Decided.',
  '没有决定成功。': 'The decision did not go through.',
  // list row
  '截止 {due}': 'Due {due}',
  '未设截止': 'No due date',
  ' · 等待 {who}': ' · Waiting on {who}',
  // drawers: common
  '工作项': 'Work item',
  '状态：{status}': 'Status: {status}',
  '状态：{status} · 版本 {version}': 'Status: {status} · Version {version}',
  '处理结果': 'Result',
  // long-work drawer
  '流程状态：{reason}': 'Workflow status: {reason}',
  ' 版本 {v}': ' version {v}',
  ' · 实例 {v}': ' · instance {v}',
  ' · 执行 {v}': ' · run {v}',
  '原始来件（仅作数据）': 'Original message (data only)',
  '原事项证据': 'Original item evidence',
  '事项已关闭，保留原始证据和处理记录。': 'This item is closed. The original evidence and the handling record are kept.',
  '已另立新事项：{id}。来件只作数据，没有执行外部动作。': 'Filed as a new item: {id}. The message is data only; no external action ran.',
  '已并回原事项：{id}。来件只作数据，没有执行外部动作。': 'Merged into the original item: {id}. The message is data only; no external action ran.',
  '选择原事项': 'Choose the original item',
  '来件已并回所选原事项；没有执行外部动作。': 'The message was merged into the chosen item. No external action ran.',
  '确认并回原事项': 'Merge into the original item',
  '来件已登记为独立新事项；原候选未改变，没有执行外部动作。': 'The message was filed as a new item. The candidates are unchanged and no external action ran.',
  '另立新事项': 'File as a new item',
  '原事项已关闭；没有执行或重复外部调用。': 'The original item is closed. No external call ran or repeated.',
  '关闭原事项': 'Close the original item',
  '来件、人工判断和阶段记录都不等于系统已核验外部结果。': 'Messages, human judgement and stage records are not system-verified external results.',
  // batch drawer
  '部分行被阻止，请核对逐行状态；成功行不会重复。': 'Some rows were blocked. Check each row; rows that succeeded will not repeat.',
  '已处理 {n} 行；请核对逐行回读结果，成功行不会重复。': 'Processed {n} rows. Check each row’s read-back; rows that succeeded will not repeat.',
  '逐行动作批准': 'Row-by-row approval',
  '持久批量明细': 'Batch rows',
  '行': 'Row', '选择': 'Select', '内容与状态': 'Content and status',
  '选择行 {id}': 'Select row {id}',
  '冲突行，不能选择': 'Conflicting row; cannot be selected',
  '批准人：{who}': 'Approved by: {who}',
  '结果凭证：{ref}': 'Result evidence: {ref}',
  '只批准所选行的当前内容，尚未执行。': 'Approved the current content of the selected rows only. Nothing has run yet.',
  '批准所选行': 'Approve selected rows',
  '执行已批准的所选行': 'Run approved selected rows',
  '只回读未知结果': 'Read back unknown results only',
  '失败或取消的行不会重发；修订需要新的批次和批准。未配置连接器时不提交任何外部动作。': 'Failed or cancelled rows are not resent; a revision needs a new batch and approval. Without a connector, nothing is submitted.',
  // collection drawer
  '我的回复': 'My reply', '收集汇总': 'Collection summary',
  '截止：{due} · {state}': 'Due: {due} · {state}',
  '已截止，汇总固定': 'Closed; summary fixed', '收集中': 'Collecting',
  '我的已存回复（人工回报，未经系统核验）：{reply}': 'My saved reply (human report, not system-verified): {reply}',
  '尚未回复。': 'No reply yet.',
  '我的收集回复': 'My collection reply',
  '你的回复已保存；仍是人工回报，未经系统核验。': 'Your reply is saved. It is still a human report, not system-verified.',
  '我的回复凭证': 'My reply evidence',
  '保存我的回复': 'Save my reply',
  '截止后不能再改回复。': 'Replies cannot change after the due date.',
  '已回读核验的请求发送：{sent} / {total}。仅创建收集不代表请求已发送。': 'Requests read back as sent: {sent} / {total}. Creating a collection does not mean requests were sent.',
  '截止时未回复': 'No reply by the due date', '尚未回复': 'Not replied yet',
  '{label}：{names}': '{label}: {names}',
  '无': 'None', '、': ', ',
  '收到的人工回复（未经系统核验）': 'Human replies received (not system-verified)',
  // main drawer
  '邮件预览': 'Email preview', '收件人': 'To', '附件': 'Attachments', '未命名': 'Untitled', '无编号': 'no ID',
  '原始来件': 'Original message', 'AI 改动的字段': 'Fields changed by AI',
  '决定的内容': 'What you are deciding',
  '有未保存的修改（{draft}），旧的批准不能执行。保存修订后要按新版本重新决定。': 'There are unsaved changes ({draft}); the old approval cannot run. After saving the revision, decide again on the new version.',
  '修改数据': 'Edit data',
  '修改 {key}': 'Edit {key}',
  '修改已暂存，还没保存成新版本。': 'Changes are staged, not yet saved as a new version.',
  '暂存修改': 'Stage changes',
  '已保存为版本 {v}，原来的批准已失效。': 'Saved as version {v}. The earlier approval no longer applies.',
  '保存修订': 'Save revision',
  '批量明细': 'Batch rows', '勾选': 'Select', '状态': 'Status',
  '勾选 {id}': 'Select {id}',
  '已执行': 'Ran', '冲突行，不能选，留在例外里': 'Conflicting row; cannot be selected, kept as an exception', '已勾选': 'Selected', '未勾选': 'Not selected',
  '已执行 {n} 行；冲突行没有执行。': 'Ran {n} rows. Conflicting rows did not run.',
  '执行勾选的干净行': 'Run selected clean rows',
  '按版本 {v} 决定': 'Decide on version {v}',
  '已由 {who} 决定{stale}。': 'Decided by {who}{stale}.',
  '（针对旧版本，已失效）': ' (on an older version; no longer applies)',
  '复核只决定是否接受成果，不授予任何执行权限。': 'A review only decides whether to accept the deliverable. It grants no permission to run anything.',
  '这是决定，不是执行授权。': 'This is a decision, not permission to run.',
  '已记录的路径：{branch}（由 {who} 记录）。记录路径不等于外部审批已通过。': 'Recorded path: {branch} (recorded by {who}). Recording a path is not external approval.',
  '选择路径': 'Choose a path',
  '已记录选择。': 'Choice recorded.',
  '记录选择': 'Record choice',
  '已重新打开，原来的选择仍保留。': 'Reopened. The earlier choice is kept.',
  '重新打开': 'Reopen',
  '人工回填': 'Manual result',
  '已记录人工回填。': 'Manual result recorded.',
  '回填凭证（外部系统单号或文件编号，必填）': 'Evidence (external system reference or file number, required)',
  '回填凭证': 'Evidence',
  '提交人工回填': 'Submit manual result',
  '人工回报，未经系统核验：{ref}': 'Human report, not system-verified: {ref}',
  '例外原因：{reason}': 'Exception reason: {reason}',
  '批准的值：': 'Approved value: ',
  '系统回读：': 'System read-back: ',
  '备注：{note}（备注不会改变系统结果）': 'Note: {note} (a note does not change the system result)',
  '例外备注': 'Exception note',
  '备注已记录；系统结果不变。': 'Note recorded. The system result is unchanged.',
  '备注': 'Note',
  '记录备注': 'Record note',
  '截止': 'Due',
  '等待': 'Waiting on',
  '{who}（仍挂在原事项上）': '{who} (still attached to the original item)',
  '完成之后': 'After you finish',
  '批准只改变决定，执行前会重新鉴权并回读。': 'Approval only changes the decision. Before anything runs, permissions are checked again and the result is read back.',
};

export type WorkText = (zh: string, vars?: Record<string, string | number>) => string;

export function workText(zh: string, lang: Lang, vars?: Record<string, string | number>): string {
  const text = lang === 'en' && Object.hasOwn(ENGLISH, zh) ? ENGLISH[zh]! : zh;
  return vars ? text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole)) : text;
}

export function useWorkText(): WorkText {
  const [lang] = useLang();
  return (zh, vars) => workText(zh, lang, vars);
}

/** Every Chinese source string has an English entry (checked by a unit test). */
export const WORK_ENGLISH_KEYS = Object.keys(ENGLISH);
