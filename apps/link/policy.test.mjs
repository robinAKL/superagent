import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { decide, describe, mcpKind, mcpToolsByServer } from './policy.mjs';

test('three modes: what runs, what asks', () => {
  const table = {
    Read: ['allow', 'allow', 'allow'],
    Edit: ['ask', 'allow', 'allow'],
    Bash: ['ask', 'ask', 'allow'],
    WebFetch: ['ask', 'allow', 'allow'],
    'mcp__vera-crm__search_orders': ['ask', 'allow', 'allow'],
    'mcp__vera-crm__approve_order': ['ask', 'ask', 'allow'],
    'mcp__vera-crm__get_crm_guide': ['ask', 'allow', 'allow'],
    'mcp__claude_ai_Gmail__send_email': ['ask', 'ask', 'ask'],
    'mcp__vera-crm__frobnicate': ['ask', 'ask', 'allow'],
  };
  for (const [tool, [strict, standard, full]] of Object.entries(table)) {
    assert.equal(decide({ mode: 'strict' }, tool), strict, `strict ${tool}`);
    assert.equal(decide({ mode: 'standard' }, tool), standard, `standard ${tool}`);
    assert.equal(decide({ mode: 'full' }, tool), full, `full ${tool}`);
  }
  // Full mode can let mail go too, if the person turns that off.
  assert.equal(decide({ mode: 'full', askEmail: false }, 'mcp__claude_ai_Gmail__send_email'), 'allow');
  // No policy at all: standard.
  assert.equal(decide(undefined, 'Bash'), 'ask');
});

test('rules override the mode: a tool first, then its whole MCP server', () => {
  assert.equal(decide({ mode: 'standard', rules: { 'mcp__vera-crm__approve_order': 'allow' } }, 'mcp__vera-crm__approve_order'), 'allow');
  assert.equal(decide({ mode: 'full', rules: { 'mcp__vera-crm': 'deny' } }, 'mcp__vera-crm__search_orders'), 'deny');
  assert.equal(decide({ mode: 'strict', rules: { 'mcp__vera-crm': 'allow', 'mcp__vera-crm__delete_order': 'ask' } }, 'mcp__vera-crm__delete_order'), 'ask');
  assert.equal(decide({ mode: 'standard', rules: { Bash: 'allow' } }, 'Bash'), 'allow');
});

test('names say whether an MCP tool reads or changes things, and requests read plainly', () => {
  assert.equal(mcpKind('mcp__vera-crm__search_orders'), 'read');
  assert.equal(mcpKind('mcp__vera-crm__record_order_deposit'), 'write');
  assert.equal(mcpKind('mcp__vera-crm__frobnicate'), 'unknown');
  assert.equal(describe('mcp__vera-crm__approve_order', {}), '想使用 vera-crm 的「approve_order」');
  assert.equal(describe('Bash', { command: 'dir C:\\work' }), '想运行命令：dir C:\\work');
});

test('the permission tool answers Claude Code over MCP with what Link decided', async (t) => {
  const seen = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    seen.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(JSON.parse(raw).tool_name === 'Bash' ? { behavior: 'deny', message: 'Not approved.' } : { behavior: 'allow' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const child = spawn(process.execPath, [fileURLToPath(new URL('./permission-mcp.mjs', import.meta.url))], {
    env: { ...process.env, SUPERAGENT_APPROVER_URL: `http://127.0.0.1:${server.address().port}/approve`, SUPERAGENT_APPROVER_SECRET: 's3cret' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  t.after(() => child.kill());
  const replies = new Map();
  createInterface({ input: child.stdout }).on('line', (line) => { const m = JSON.parse(line); replies.get(m.id)?.(m); });
  const call = (id, method, params) => new Promise((resolve) => {
    replies.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const init = await call(1, 'initialize', { protocolVersion: '2025-06-18' });
  assert.equal(init.result.serverInfo.name, 'superagent-link');
  assert.deepEqual((await call(2, 'tools/list', {})).result.tools.map((tool) => tool.name), ['approve']);
  const allowed = await call(3, 'tools/call', { name: 'approve', arguments: { tool_name: 'Read', input: { file_path: 'a.txt' } } });
  assert.deepEqual(JSON.parse(allowed.result.content[0].text), { behavior: 'allow', updatedInput: { file_path: 'a.txt' } });
  const denied = await call(4, 'tools/call', { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'dir' } } });
  assert.deepEqual(JSON.parse(denied.result.content[0].text), { behavior: 'deny', message: 'Not approved.' });
  assert.equal(seen[0].auth, 'Bearer s3cret');
});

test('reads `claude mcp list` into servers named as Claude Code names their tools', async () => {
  const { parseMcpList } = await import('./policy.mjs');
  const text = [
    'Checking MCP server health…',
    '',
    'claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✓ Connected',
    'vera-crm: https://blinds-crm.vercel.app/api/mcp (HTTP) - ! Needs authentication',
    'broken: node broken.js - ✗ Failed to connect',
  ].join('\r\n');
  assert.deepEqual(parseMcpList(text), [
    { name: 'claude_ai_Gmail', status: 'connected' },
    { name: 'vera-crm', status: 'needs_auth' },
    { name: 'broken', status: 'failed' },
  ]);
});

test('a switch on Bash or Edit covers the whole group', () => {
  const policy = { mode: 'standard', rules: { Bash: 'allow', Edit: 'deny' } };
  assert.equal(decide(policy, 'PowerShell'), 'allow');
  assert.equal(decide(policy, 'Write'), 'deny');
  assert.equal(decide({ mode: 'standard', rules: { Bash: 'allow', PowerShell: 'ask' } }, 'PowerShell'), 'ask');
});

test('MCP tools by server: names cleaned, duplicates once, Link’s own permission tool left out', () => {
  assert.deepEqual(mcpToolsByServer(['Read', 'mcp__vera-crm__list_invoices', 'mcp__vera-crm__list_invoices', 'mcp__vera-crm__approve_order', 'mcp__superagent_link__approve', 'mcp__a b__c/d', 42]), {
    'vera-crm': ['list_invoices', 'approve_order'], a_b: ['c_d'],
  });
  assert.deepEqual(mcpToolsByServer(undefined), {});
});
