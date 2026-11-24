#!/usr/bin/env node
/**
 * The permission tool Link gives Claude Code (`--permission-prompt-tool mcp__superagent_link__approve`).
 *
 * Claude Code runs headless under Link, so it cannot show a prompt. Each time it needs permission it calls this tool;
 * the tool asks the Link that started it — over loopback, with a secret made for this task — and Link answers from the
 * employee's authorisation mode, its "always allow" rules, or a person's decision in the command room.
 * Nothing here holds the worker token: it only knows the local address and the per-task secret.
 */
import { createInterface } from 'node:readline';

const URL_ = process.env.SUPERAGENT_APPROVER_URL ?? '';
const SECRET = process.env.SUPERAGENT_APPROVER_SECRET ?? '';
const TOOL = {
  name: 'approve',
  description: 'Asks the SuperAgent Link on this computer whether a tool call may run.',
  inputSchema: {
    type: 'object',
    properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
    required: ['tool_name', 'input'],
  },
};

function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
}

async function ask(args) {
  const deny = (message) => ({ behavior: 'deny', message });
  if (!/^http:\/\/127\.0\.0\.1:\d+\/approve$/.test(URL_) || !SECRET) return deny('SuperAgent Link is not available to approve this.');
  try {
    const response = await fetch(URL_, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + SECRET },
      body: JSON.stringify({ tool_name: String(args?.tool_name ?? ''), input: args?.input ?? {} }),
    });
    if (!response.ok) return deny('SuperAgent Link refused the request.');
    const decision = await response.json();
    if (decision?.behavior === 'allow') return { behavior: 'allow', updatedInput: args?.input ?? {} };
    return deny(typeof decision?.message === 'string' ? decision.message : 'Not allowed.');
  } catch {
    return deny('SuperAgent Link could not be reached.');
  }
}

async function handle(message) {
  const { id, method, params } = message;
  if (method === 'initialize') {
    return send({ id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'superagent-link', version: '1.0.0' } } });
  }
  if (method === 'ping') return send({ id, result: {} });
  if (method === 'tools/list') return send({ id, result: { tools: [TOOL] } });
  if (method === 'tools/call') {
    if (params?.name !== 'approve') return send({ id, error: { code: -32602, message: 'Unknown tool' } });
    const decision = await ask(params.arguments);
    return send({ id, result: { content: [{ type: 'text', text: JSON.stringify(decision) }] } });
  }
  if (id !== undefined) send({ id, error: { code: -32601, message: 'Method not found' } });
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message && typeof message === 'object') void handle(message);
});
