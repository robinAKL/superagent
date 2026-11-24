/**
 * What a command-room message is asking for. These are fixed wording rules, not a model call: they decide only
 * whether a message may become a task. Anything they do not recognise is treated as discussion and gets a question
 * back, so a wrong guess costs one more message and never an unwanted task.
 */

const GREETING = /^(你好|您好|早上好|下午好|晚上好|在吗|hi|hello|hey)[!！。.?？~\s]*$/iu;

const AVAILABILITY = /(哪些|有没有|多少|几[个名位]).*(数字员工|员工|同事)|(数字员工|员工|同事).*(在线|有空|能用|可用|能不能用)|能不能用|可以用吗|谁在线/u;

/** Verbs that change something outside the platform: sending, paying, ordering. */
const EXTERNAL = /(发送|发出|发给|发邮件|寄给|寄出|付款|支付|转账|汇款|下单|退款|开票)/u;

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/u;
const QUOTED = /[「『“"][^」』”"]+[」』”"]/u;
/** A document or record number such as Q-1001, INV2024-07 or C-DEMO-002. */
const RECORD = /[A-Za-z]+(?:-[A-Za-z0-9]+)*-?\d{2,}/u;

const SMALL_TALK: [RegExp, string][] = [
  [/^(?=.*(测|test|忽略|无视|别管|不用管|不用回|ignore))(测试|测一下|测试一下|test|testing)?[,，。.!！\s]*(请)?(忽略|无视|别管|不用管|不用回|ignore( this| it)?)?[!！。.~\s]*$/iu, '好的，这条不用处理。'],
  [/^(谢谢|多谢|感谢|谢了|thanks|thank you|thx)[!！。.~\s]*$/iu, '不客气。'],
  [/^(好的|好|嗯|ok|okay|收到|知道了|明白)[!！。.~\s]*$/iu, '好的。'],
];

/**
 * "测试，请忽略", "谢谢", "收到": a fixed short reply, never a model call, so a message that asks for nothing is not
 * answered with the status of whatever the conversation was about before.
 */
export function smallTalkReply(body: string): string | null {
  const text = body.trim();
  if (!text || text.length > 24) return null;
  for (const [pattern, reply] of SMALL_TALK) if (pattern.test(text)) return reply;
  return null;
}

/**
 * "进行中的任务怎么还没完成", "还有哪些任务没做完", "看板", "进度怎么样": a question about the board as a whole
 * (a question about one numbered task is askedTaskNumber's).
 */
const BOARD = /(看板|进度|进展|进行中|未完成|没完成|没有完成|没做完|还没好|卡住|卡在|还有(哪些|什么|几个)?任务|任务(都|还)?(怎么样|如何|完成了吗|做完了吗)|在做什么|在忙什么)/u;
export function asksBoard(body: string): boolean {
  const text = body.trim();
  return text.length <= 80 && BOARD.test(text) && askedTaskNumber(text) === null;
}

/** "重试 T-5 T-12" → [5, 12]; "全部重试" / "都重新派一下" → 'all'; anything else → null. */
export function asksRetry(body: string): number[] | 'all' | null {
  const text = body.trim();
  if (text.length > 80 || !/(重试|再试|重新(派|派发|执行|做|跑)|retry)/iu.test(text)) return null;
  const numbers = [...text.matchAll(/(?:^|[^A-Za-z0-9])[Tt]-?\s*(\d{1,6})(?!\d)/gu)].map((match) => Number(match[1]));
  if (numbers.length) return [...new Set(numbers)];
  return /(全部|所有|都|这些|这几个|卡住的|没完成的|未完成的|all)/iu.test(text) ? 'all' : null;
}

export function isGreeting(body: string): boolean {
  return GREETING.test(body.trim());
}

export function asksAvailability(body: string): boolean {
  return AVAILABILITY.test(body);
}

export function isExternalAction(body: string): boolean {
  return EXTERNAL.test(body);
}

/** The message with its @mentions removed: what is left is the work being asked for. */
export function workText(body: string): string {
  // Only ASCII before "@" marks an email address; "请@某员工" is still a mention.
  return body.replace(/(?<![A-Za-z0-9_.+-])@[^\s@]+/gu, ' ').replace(/[ \t]+/gu, ' ').trim();
}

/**
 * An outward action with nobody and nothing named ("发送邮件给客户"). A recipient address, a quoted name or a
 * record number counts as a concrete object; without one the room asks before it hands the work over.
 */
export function needsParameters(body: string): boolean {
  if (!isExternalAction(body)) return false;
  const text = workText(body);
  return !(EMAIL.test(text) || QUOTED.test(text) || RECORD.test(text));
}

const TASK_NUMBER = /(?:^|[^A-Za-z0-9])t-?(\d{1,6})(?![0-9])/iu;
const ASKS_ABOUT = /[?？]|是什么|是啥|什么任务|怎么样|怎样了|进展|进度|状态|完成了吗|好了吗|做完|在干嘛|what|status|how/iu;

/** "T-5是什么任务？", "t5 怎么样了": the number of the task a question is about, else null. */
export function askedTaskNumber(body: string): number | null {
  const match = TASK_NUMBER.exec(body);
  if (!match || !ASKS_ABOUT.test(body)) return null;
  return Number(match[1]);
}
