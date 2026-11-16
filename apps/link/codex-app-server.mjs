import { createInterface } from 'node:readline';

const COMMAND_APPROVAL = 'item/commandExecution/requestApproval';
const FILE_APPROVAL = 'item/fileChange/requestApproval';
const AUTH_ERROR = /not logged in|please (log|sign) in|authentication required|unauthorized|invalid api key|login required|token (has )?expired/i;

/** One stdio App Server connection and one task turn. The caller supplies the approval channel. */
export async function runCodexTurn({ input, output, cwd, prompt, session, notify, approve, signal }) {
  const lines = createInterface({ input: output });
  const requests = new Map();
  const approvals = new Map();
  const changes = new Map();
  let sequence = 0;
  let threadId;
  let turnId;
  let answer = '';
  let errorText = '';
  let closed = false;
  let finish;
  const completed = new Promise((resolve) => { finish = resolve; });
  const write = (message) => {
    if (!closed && !input.destroyed && !input.writableEnded) input.write(JSON.stringify(message) + '\n');
  };
  function request(method, params) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      requests.set(id, { resolve, reject });
      write({ id, method, params });
    });
  }
  function close(outcome) {
    if (closed) return;
    closed = true;
    lines.close();
    input.off('error', inputFailed);
    signal.removeEventListener('abort', abort);
    for (const request of requests.values()) request.reject(new Error('Codex App Server ended.'));
    requests.clear();
    for (const approval of approvals.values()) approval.abort();
    approvals.clear();
    finish(outcome);
  }
  function abort() { close({ cancelled: true }); }
  function resultFailure() {
    return AUTH_ERROR.test(errorText)
      ? { authentication: 'codex requires sign-in.' }
      : { failure: 'Codex App Server ended without a final response.' };
  }
  function inputFailed() { close(resultFailure()); }

  async function serverRequest(message) {
    const { id, method, params = {} } = message;
    if (approvals.has(id)) return;
    if (method !== COMMAND_APPROVAL && method !== FILE_APPROVAL) {
      write({ id, error: { code: -32601, message: 'Unsupported server request' } });
      return;
    }
    if (params.threadId !== threadId || !turnId || params.turnId !== turnId) {
      write({ id, result: { decision: 'decline' } });
      return;
    }
    const waiting = new AbortController();
    approvals.set(id, waiting);
    const paths = changes.get(params.itemId) ?? [];
    const context = {
      requestId: String(id),
      threadId,
      turnId,
      itemId: params.itemId,
      kind: method === FILE_APPROVAL ? 'file_change' : params.networkApprovalContext ? 'network_access' : 'command',
      reason: params.reason,
      command: params.command,
      cwd: params.cwd,
      host: params.networkApprovalContext?.host,
      protocol: params.networkApprovalContext?.protocol,
      grantRoot: params.grantRoot,
      paths,
    };
    try {
      const decision = await approve(context, waiting.signal).catch(() => 'deny');
      if (!waiting.signal.aborted) {
        const available = params.availableDecisions;
        const allow = decision === 'allow' && (!Array.isArray(available) || available.includes('accept'));
        write({ id, result: { decision: allow ? 'accept' : 'decline' } });
      }
    } finally {
      approvals.delete(id);
    }
  }

  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined) {
      if (typeof message.method === 'string') {
        void serverRequest(message).catch(() => write({ id: message.id, result: { decision: 'decline' } }));
      } else {
        const waiting = requests.get(message.id);
        requests.delete(message.id);
        if (message.error) waiting?.reject(new Error(message.error.message));
        else waiting?.resolve(message.result);
      }
      return;
    }
    const params = message.params ?? {};
    if (message.method === 'serverRequest/resolved' && params.threadId === threadId) {
      approvals.get(params.requestId)?.abort();
      return;
    }
    if (params.threadId !== threadId) return;
    if (message.method === 'turn/started' && !turnId) turnId = params.turn?.id;
    if (message.method === 'error') errorText = params.error?.message ?? '';
    const item = params.item;
    if (message.method === 'item/started' && params.turnId === turnId) {
      if (item?.type === 'fileChange') {
        changes.set(item.id, (item.changes ?? []).map((change) => change.path).filter((path) => typeof path === 'string'));
      }
      notify({ progress: 'Codex is processing the task.' });
    }
    if (message.method === 'item/completed' && params.turnId === turnId && item?.type === 'agentMessage' && typeof item.text === 'string') {
      answer = item.text.slice(0, 60_000);
    }
    if (message.method === 'turn/completed' && params.turn?.id === turnId) {
      if (params.turn.status === 'completed' && answer) close({ result: answer });
      else {
        errorText = params.turn.error?.message ?? errorText;
        close(resultFailure());
      }
    }
  });
  lines.once('close', () => close(resultFailure()));
  input.on('error', inputFailed);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  if (!closed) {
    try {
      await request('initialize', { clientInfo: { name: 'superagent_link', title: 'Super Agent Link', version: '0.1.0' } });
      write({ method: 'initialized' });
      const thread = session
        ? await request('thread/resume', { threadId: session, cwd, excludeTurns: true })
        : await request('thread/start', { cwd });
      threadId = thread.thread.id;
      notify({ session: threadId });
      const started = await request('turn/start', { threadId, input: [{ type: 'text', text: prompt }] });
      turnId ??= started.turn.id;
    } catch (error) {
      errorText = error.message;
      close(resultFailure());
    }
  }
  return completed;
}
