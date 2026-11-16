import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { MemoryKnowledgeRepository } from '../src/modules/knowledge/repository.js';
import { VeraMcpKnowledge, VERA_CALLBACK_PATH, VERA_MCP_URL } from '../src/modules/knowledge/vera-mcp.js';
import { InMemorySecretStore } from '../src/modules/setup/secrets.js';

const issuer = 'https://blinds-crm.vercel.app/api/mcp-auth';
const host = 'superagent.example.com';
const origin = 'https://' + host;
const root = '/api/v1/knowledge';
const connection = root + '/connections/mcp/vera';
const schemas = { type: 'object', properties: {} };

it('connects by staff OAuth and lets the Brain read CRM guides under the same user’s grant', async () => {
  let challenge = '';
  let accessToken = 'short-lived-access';
  const scope = 'crm:read crm:knowledge:read';
  const usedTools: string[] = [];
  let refreshes = 0;
  const network = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(new URL(VERA_MCP_URL).origin);
    expect(init?.redirect).toBe('error');
    if (url.pathname.includes('oauth-protected-resource')) return Response.json({ resource: VERA_MCP_URL, authorization_servers: [issuer] });
    if (url.pathname.includes('oauth-authorization-server')) return Response.json({
      issuer, registration_endpoint: issuer + '/register', authorization_endpoint: issuer + '/authorize',
      token_endpoint: issuer + '/token', code_challenge_methods_supported: ['S256'],
      scopes_supported: ['crm:read', 'crm:knowledge:read', 'crm:orders:write'],
    });
    if (url.href === issuer + '/register') {
      expect(JSON.parse(String(init?.body))).toMatchObject({ redirect_uris: [origin + VERA_CALLBACK_PATH], scope, token_endpoint_auth_method: 'none' });
      return Response.json({ client_id: 'test-client' }, { status: 201 });
    }
    if (url.href === issuer + '/token') {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get('client_id')).toBe('test-client');
      expect(body.get('resource')).toBe(VERA_MCP_URL);
      if (body.get('grant_type') === 'authorization_code') {
        expect(body.get('code')).toBe('test-code');
        expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(challenge);
        return Response.json({ access_token: accessToken, refresh_token: 'first-refresh', scope, expires_in: 15 });
      }
      expect(body.get('refresh_token')).toBe('first-refresh');
      refreshes++;
      accessToken = 'rotated-access';
      return Response.json({ access_token: accessToken, refresh_token: 'rotated-refresh', scope, expires_in: 900 });
    }
    expect(url.href).toBe(VERA_MCP_URL);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ' + accessToken);
    if (init?.method !== 'POST') return new Response(null, { status: 405 });
    const req = JSON.parse(String(init.body));
    let result: unknown;
    switch (req.method) {
      case 'notifications/initialized': return new Response(null, { status: 202 });
      case 'initialize': result = {
        protocolVersion: req.params.protocolVersion, serverInfo: { name: 'VERA CRM', version: 'test' }, capabilities: { tools: {}, resources: {} },
      }; break;
      case 'resources/list': result = { resources: [{ uri: 'crm://reference/handbook', name: 'Handbook' }] }; break;
      case 'resources/templates/list': result = { resourceTemplates: [{ uriTemplate: 'crm://guide/{chapter}', name: 'Guide' }] }; break;
      case 'resources/read': result = { contents: [{ uri: req.params.uri, text: 'Verify receipt before recording a deposit.' }] }; break;
      case 'tools/list': result = {
        tools: [
          { name: 'get_crm_guide', inputSchema: schemas, annotations: { readOnlyHint: true } },
          { name: 'get_pricing_knowledge', inputSchema: schemas, annotations: { readOnlyHint: true } },
          { name: 'approve_order', inputSchema: schemas, annotations: { readOnlyHint: false } },
        ],
      }; break;
      case 'tools/call':
        usedTools.push(req.params.name);
        result = { content: [], structuredContent: { guide: 'Verify receipt before recording a deposit.' } };
        break;
      default: throw Error('Unexpected CRM request');
    }
    return Response.json({ jsonrpc: '2.0', id: req.id, result });
  });
  const repo = new MemoryKnowledgeRepository();
  const veraMcp = new VeraMcpKnowledge(repo, new InMemorySecretStore(), network);
  const chat = vi.fn().mockResolvedValueOnce({ text: '[{"name":"get_crm_guide","arguments":{}}]', toolCalls: [] })
    .mockResolvedValueOnce({ text: 'Verify receipt first. [1]', toolCalls: [] });
  const app = await buildApp({
    auth: { mode: 'dev', platformTenantId: 'test' },
    knowledgeDeps: { repo, veraMcp, veraAnswerGateway: { check: async () => ({ ok: true, model: 'test' }), chat } },
  });
  const send = (path: string, payload?: object, user = 'alice|employee|') => app.inject({
    method: payload ? 'POST' : 'GET', url: path, headers: { 'x-dev-user': user, host, ...(path.endsWith('/connections/mcp') ? { origin } : {}) }, payload,
  });
  try {
    const start = await send(root + '/connections/mcp', { endpoint: VERA_MCP_URL });
    expect(start.statusCode, start.body).toBe(200);
    const authorization = new URL(start.json().authorizationUrl);
    expect(authorization.searchParams.get('scope')).toBe(scope);
    expect(authorization.searchParams.get('redirect_uri')).toBe(origin + VERA_CALLBACK_PATH);
    challenge = authorization.searchParams.get('code_challenge')!;
    const callbackData = { state: authorization.searchParams.get('state')!, code: 'test-code', iss: issuer };
    const callback = await app.inject(VERA_CALLBACK_PATH + '?' + new URLSearchParams(callbackData));
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toContain('/#knowledge?vera_state=');
    expect(callback.headers['cache-control']).toBe('no-store');
    expect((await send(connection + '/finish', callbackData, 'bob|employee|')).statusCode).toBe(400);
    const finish = await send(connection + '/finish', callbackData);
    expect(finish.statusCode, finish.body).toBe(200);
    expect(finish.json().tools.map((tool: { name: string }) => tool.name)).toEqual(['get_crm_guide', 'get_pricing_knowledge']);
    expect((await send(connection + '/finish', callbackData)).statusCode).toBe(400);
    expect((await send(connection + '/catalog', undefined, 'bob|employee|')).statusCode).toBe(401);

    const [guide, catalog] = await Promise.all([
      send(connection + '/read', { uri: 'crm://guide/deposit' }), send(connection + '/catalog'),
    ]);
    expect(guide.statusCode, guide.body).toBe(200);
    expect(guide.json().contents[0].text).toContain('Verify receipt');
    expect(catalog.statusCode, catalog.body).toBe(200);
    expect(refreshes).toBe(1);
    expect((await send(connection + '/read', { uri: 'crm://other/private' })).statusCode).toBe(404);
    expect((await send(connection + '/query', { name: 'approve_order', arguments: {} })).statusCode).toBe(403);

    const ask = await send(connection + '/ask', { question: 'How do I record a deposit?' });
    expect(ask.statusCode, ask.body).toBe(200);
    expect(ask.json()).toMatchObject({ answer: 'Verify receipt first. [1]', sources: [{ number: 1, locator: 'get_crm_guide' }] });
    expect(chat.mock.calls[1]?.[2].messages[1].content).toContain('Verify receipt before recording a deposit');
    expect(usedTools).toEqual(['get_crm_guide']);
    const mcp = await send(root + '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(mcp.json().result.tools).toContainEqual(expect.objectContaining({ name: 'read_vera_knowledge' }));

    const state = JSON.stringify(await repo.read({ tenantId: 'test', userId: 'alice', roles: ['employee'], projectScopes: [] }));
    for (const value of ['rotated-access', 'rotated-refresh', 'first-refresh', 'Verify receipt']) expect(state).not.toContain(value);
    await app.inject({ method: 'DELETE', url: connection, headers: { 'x-dev-user': 'alice|employee|' } });
    expect((await send(connection + '/catalog')).statusCode).toBe(401);
  } finally { await app.close(); }
});
