/**
 * Which of a local agent's requests run at once, which wait for a person in the command room, and which are refused.
 *
 *   strict   — reading and searching run; everything else asks.
 *   standard — reading, searching, editing files in the project and read-only MCP tools run; commands, MCP tools that
 *              change data, and sending mail ask. (The default.)
 *   full     — everything runs, except sending mail, which still asks unless askEmail is false.
 *
 * Per-tool rules ("以后都允许" in the room, or the tool list) override the mode: an exact tool name first, then its MCP
 * server ("mcp__vera-crm"). Decisions are 'allow', 'ask' or 'deny'.
 */
export const MODES = ['strict', 'standard', 'full'];
export const DEFAULT_POLICY = Object.freeze({ mode: 'standard', rules: {}, askEmail: true });

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'TodoWrite', 'TodoRead', 'NotebookRead', 'Task', 'WebSearch', 'BashOutput', 'ExitPlanMode']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const COMMAND_TOOLS = new Set(['Bash', 'PowerShell', 'KillShell', 'KillBash']);
const FETCH_TOOLS = new Set(['WebFetch']);

const READ_VERB = /^(get|list|search|find|query|read|fetch|lookup|describe|show|view|count|check|status|guide|preview|summar|explain|export|download|inspect|browse)/i;
const WRITE_VERB = /^(create|update|delete|remove|approve|reject|send|post|record|mark|assign|set|add|write|upload|pay|cancel|submit|move|rename|archive|close|reopen|forward|reply|invite|grant|revoke|edit|patch|put|insert|import|publish|trigger|run|execute|book|order|refund|transfer)/i;
const MAIL_SERVER = /(gmail|outlook|microsoft[_-]?365|mail|exchange|smtp)/i;
const MAIL_SEND = /^(send|reply|forward)/i;

/** "mcp__vera-crm__search_orders" → { server: "vera-crm", tool: "search_orders" }. */
export function mcpParts(name) {
  const match = /^mcp__(.+?)__(.+)$/.exec(name ?? '');
  return match ? { server: match[1], tool: match[2] } : null;
}

/** read | write | unknown, from an MCP tool's name. */
export function mcpKind(name) {
  const parts = mcpParts(name);
  if (!parts) return 'unknown';
  const verb = parts.tool.replace(/^(claude_ai_)/, '');
  if (WRITE_VERB.test(verb)) return 'write';
  if (READ_VERB.test(verb)) return 'read';
  return 'unknown';
}

export function isSendingMail(name) {
  const parts = mcpParts(name);
  return Boolean(parts && MAIL_SERVER.test(parts.server) && MAIL_SEND.test(parts.tool));
}

export function cleanPolicy(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const mode = MODES.includes(value.mode) ? value.mode : DEFAULT_POLICY.mode;
  const rules = {};
  for (const [tool, rule] of Object.entries(value.rules && typeof value.rules === 'object' ? value.rules : {})) {
    if (typeof tool === 'string' && tool.length <= 128 && ['allow', 'ask', 'deny'].includes(rule)) rules[tool] = rule;
  }
  return { mode, rules, askEmail: value.askEmail !== false };
}

/** 'allow' | 'ask' | 'deny' for one request from the local agent. */
export function decide(policy, toolName) {
  const { mode, rules, askEmail } = cleanPolicy(policy);
  const parts = mcpParts(toolName);
  // The room's tool list sets one switch per group: "Bash" covers every command tool, "Edit" every file edit.
  const group = COMMAND_TOOLS.has(toolName) ? rules.Bash : EDIT_TOOLS.has(toolName) ? rules.Edit : FETCH_TOOLS.has(toolName) ? rules.WebFetch : undefined;
  const rule = rules[toolName] ?? (parts ? rules['mcp__' + parts.server] : group);
  if (rule) return rule;
  if (READ_TOOLS.has(toolName)) return 'allow';
  if (isSendingMail(toolName)) return askEmail || mode !== 'full' ? 'ask' : 'allow';
  if (mode === 'full') return 'allow';
  if (mode === 'strict') return 'ask';
  // standard
  if (EDIT_TOOLS.has(toolName) || FETCH_TOOLS.has(toolName)) return 'allow';
  if (COMMAND_TOOLS.has(toolName)) return 'ask';
  if (parts) return mcpKind(toolName) === 'read' ? 'allow' : 'ask';
  return 'ask';
}

/**
 * `claude mcp list` → [{ name, status }]. Names take the form Claude Code uses in tool names ("claude.ai Gmail" →
 * "claude_ai_Gmail", as in mcp__claude_ai_Gmail__send_email), so the room's tool list lines up with the requests.
 */
export function parseMcpList(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^([^:]+?):\s.*\s-\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    const name = match[1].trim().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
    const state = match[2];
    const status = /connected/i.test(state) ? 'connected' : /auth/i.test(state) ? 'needs_auth' : /fail|error/i.test(state) ? 'failed' : 'unknown';
    if (name && !out.some((server) => server.name === name)) out.push({ name, status });
  }
  return out.slice(0, 32);
}

/** A short line for the approval card: what the employee wants to do, in plain words. */
export function describe(toolName, input = {}) {
  const parts = mcpParts(toolName);
  const text = (value, limit = 160) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
  if (parts) return `想使用 ${parts.server} 的「${parts.tool}」`;
  if (COMMAND_TOOLS.has(toolName)) return `想运行命令：${text(input.command)}`;
  if (EDIT_TOOLS.has(toolName)) return `想修改文件：${text(input.file_path ?? input.notebook_path)}`;
  if (FETCH_TOOLS.has(toolName)) return `想访问网页：${text(input.url)}`;
  return `想使用「${text(toolName, 64)}」`;
}
