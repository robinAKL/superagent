import { createHash, randomBytes } from 'node:crypto';
import { type Client, UriTemplate } from '@modelcontextprotocol/client';
import { SourceError, type UserContext } from '@superagent/shared';
import type { SecretStore, SecretVersion } from '../setup/secrets.js';
import { hash, id as newId, KnowledgeError, type KnowledgeState } from './domain.js';
import type { KnowledgeRepository } from './repository.js';
import { exchangeMcpToken, mcpOAuth, reauthorize, type OAuthConnection, type McpTokens } from './mcp-oauth.js';
import { publicMcpEndpoint, publicMcpFetch } from './plugins/mcp-public-http.js';
import { withMcpClient } from './plugins/mcp-resources.js';

interface Grant { deadline: number | null; secret: SecretVersion }
export interface LiveMcpSource {
  id: string;
  endpoint: string;
  name: string;
  allowTools: boolean;
  revision?: string;
  oauth?: OAuthConnection;
  grant?: Grant;
}
interface Attempt {
  key: string;
  deadline: number;
  endpoint: string;
  allowTools: boolean;
  oauth: OAuthConnection;
  verifier: SecretVersion;
}
export interface LiveMcpUser {
  sources: Record<string, LiveMcpSource>;
  attempt?: Attempt;
  completing?: string;
}
type UserEntries = Pick<KnowledgeState, 'liveMcp' | 'veraMcp'>;

function enabled(state: KnowledgeState) {
  if (state.disabledPlugins.includes('mcp')) throw new KnowledgeError('plugin_disabled', 'MCP 知识来源已暂停。', 409);
}

function invalidCallback() {
  return new KnowledgeError('mcp_oauth_callback', 'MCP 授权已取消或已过期。请重新连接。');
}

// Former releases stored only the user grant. Recover its endpoint once when the account is next updated.
function entries(state: UserEntries, user: string): LiveMcpUser {
  const existing = state.liveMcp[user];
  if (existing) return existing;
  const sources: LiveMcpUser['sources'] = {};
  const grant = state.veraMcp[user]?.grant;
  if (grant) {
    const endpoint = 'https://blinds-crm.vercel.app/api/mcp', id = hash(endpoint);
    const issuer = 'https://blinds-crm.vercel.app/api/mcp-auth';
    sources[id] = { id, endpoint, name: 'VERA CRM', allowTools: true, grant,
      oauth: { issuer, tokenEndpoint: issuer + '/token', clientId: grant.clientId, callback: '', checkIssuer: true, scope: 'crm:read crm:knowledge:read' } };
  }
  return { sources };
}

function updateEntries(state: UserEntries, user: string) {
  const current = entries(state, user);
  state.liveMcp[user] = current;
  delete state.veraMcp[user];
  return current;
}

function sourceRevision(source: LiveMcpSource) {
  return source.revision ?? hash(JSON.stringify([source.id, source.oauth?.clientId, source.allowTools]));
}

export function liveMcpSelection(state: KnowledgeState, ctx: UserContext, id: string) {
  const source = entries(state, hash(ctx.userId)).sources[id];
  if (!source || state.disabledPlugins.includes('mcp')) return undefined;
  return { id, name: source.name, revision: sourceRevision(source) };
}

async function collect<T>(fetchPage: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10 && items.length < 100; page++) {
    const result = await fetchPage(cursor);
    items.push(...result.items.slice(0, 100 - items.length));
    if (!result.nextCursor || result.nextCursor === cursor) break;
    cursor = result.nextCursor;
  }
  return items;
}

const resources = (client: Client) => client.getServerCapabilities()?.resources
  ? collect(async cursor => { const page = await client.listResources({ cursor }); return { items: page.resources, nextCursor: page.nextCursor }; })
  : Promise.resolve([]);
const templates = (client: Client) => client.getServerCapabilities()?.resources
  ? collect(async cursor => { const page = await client.listResourceTemplates({ cursor }); return { items: page.resourceTemplates, nextCursor: page.nextCursor }; })
  : Promise.resolve([]);
const readOnlyTools = (client: Client) => client.getServerCapabilities()?.tools
  ? collect(async cursor => {
    const page = await client.listTools({ cursor });
    return { items: page.tools.filter(tool => tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint !== true), nextCursor: page.nextCursor };
  }) : Promise.resolve([]);

async function discover(client: Client, endpoint: string, allowTools: boolean) {
  const [items, patterns] = await Promise.all([resources(client), templates(client)]);
  // A server that publishes no documents is only readable through its read-only queries, so opting out would leave
  // nothing to read. Servers that also publish documents keep the explicit opt-in.
  const queryOnly = !items.length && !patterns.length;
  const tools = allowTools || queryOnly ? await readOnlyTools(client) : [];
  const name = (client.getServerVersion()?.title || client.getServerVersion()?.name || new URL(endpoint).hostname).slice(0, 160);
  return {
    name, source: endpoint, allowTools: allowTools || (queryOnly && tools.length > 0),
    resources: items.map(({ uri, name, title, description, mimeType }) => ({ uri, name, title, description, mimeType })),
    resourceTemplates: patterns.map(({ uriTemplate, name, title, description }) => ({ uriTemplate, name, title, description })),
    tools: tools.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema })),
  };
}

export class LiveMcpKnowledge {
  constructor(private readonly repo: KnowledgeRepository, private readonly secrets: SecretStore, private readonly network: typeof fetch = publicMcpFetch) {}

  list(state: KnowledgeState, ctx: UserContext) {
    return Object.values(entries(state, hash(ctx.userId)).sources).map(({ id, endpoint, name, oauth, allowTools }) =>
      ({ id, endpoint, name, authorization: oauth ? 'oauth' : 'public', allowTools, enabled: !state.disabledPlugins.includes('mcp') }));
  }

  async connect(ctx: UserContext, input: Record<string, unknown>, origin?: string, host?: string) {
    const current = await this.repo.read(ctx);
    enabled(current);
    const endpoint = publicMcpEndpoint(input.endpoint).href;
    const allowTools = input.allowTools === true;
    const id = hash(endpoint), user = hash(ctx.userId);
    let challenge: Response | undefined;
    try {
      const catalog = await withMcpClient(endpoint, this.network, client => discover(client, endpoint, allowTools), undefined, response => { challenge = response; });
      const old = await this.repo.transact(ctx, state => {
        enabled(state);
        const entry = updateEntries(state, user);
        const previous = entry.sources[id]?.grant?.secret;
        entry.sources[id] = { id, endpoint, name: catalog.name, allowTools: catalog.allowTools, revision: newId() };
        return previous;
      });
      await this.disable(old);
      return { source: { id, name: catalog.name }, catalog };
    } catch (error) {
      if (!challenge) {
        if (error instanceof KnowledgeError) throw error;
        if (error instanceof SourceError && error.kind === 'auth') throw new KnowledgeError('mcp_auth_required', '此 MCP 服务未提供可用的 OAuth 授权方式。', 422);
        throw new KnowledgeError('mcp_connection_failed', '无法验证 MCP 地址，请检查地址和服务器是否可访问。', 422);
      }
    }
    const existing = entries(current, user).sources[id]?.oauth;
    const { oauth, authorizationUrl, scope } = await mcpOAuth(this.network, endpoint, challenge, origin, host, input, existing);
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const key = hash(state);
    const old = await this.repo.transact(ctx, async store => {
      enabled(store);
      const entry = updateEntries(store, user);
      const oldVerifier = entry.attempt?.verifier;
      const secret = await this.secrets.put(this.secretName(ctx, 'pkce', ''), verifier);
      entry.attempt = { key, deadline: Date.now() + 10 * 60_000, endpoint, allowTools, oauth, verifier: secret };
      delete entry.completing;
      return oldVerifier;
    });
    await this.disable(old);
    const query = {
      response_type: 'code', client_id: oauth.clientId, redirect_uri: oauth.callback,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      resource: endpoint, state,
    };
    for (const [name, value] of Object.entries(query)) authorizationUrl.searchParams.set(name, value);
    if (scope) authorizationUrl.searchParams.set('scope', scope);
    return { authorizationUrl: authorizationUrl.href };
  }

  async finish(ctx: UserContext, input: Record<string, unknown>) {
    const { state, code, iss, callbackPath } = input;
    if (typeof state !== 'string' || !/^[\w-]{43}$/.test(state)) throw invalidCallback();
    const user = hash(ctx.userId);
    const attempt = await this.repo.transact(ctx, store => {
      enabled(store);
      const entry = updateEntries(store, user), pending = entry.attempt;
      if (!pending || pending.key !== hash(state) || callbackPath !== new URL(pending.oauth.callback).pathname) throw invalidCallback();
      delete entry.attempt;
      entry.completing = pending.key;
      return pending;
    });
    let verifier: string;
    try {
      if (attempt.deadline <= Date.now() || typeof code !== 'string' || !code || code.length > 2048
        || ((attempt.oauth.checkIssuer || typeof iss === 'string') && iss !== attempt.oauth.issuer)) throw invalidCallback();
      verifier = await this.secrets.get(attempt.verifier);
    } finally { await this.disable(attempt.verifier); }
    const { endpoint, oauth, allowTools } = attempt;
    const id = hash(endpoint);
    const reply = await exchangeMcpToken(this.network, endpoint, oauth, {
      grant_type: 'authorization_code', redirect_uri: oauth.callback, code, code_verifier: verifier,
    });
    const catalog = await this.request(endpoint, reply.tokens.access, client => discover(client, endpoint, allowTools));
    const old = await this.repo.transact(ctx, async store => {
      enabled(store);
      const entry = updateEntries(store, user);
      if (entry.completing !== attempt.key) throw invalidCallback();
      const previous = entry.sources[id]?.grant?.secret;
      const grant = await this.saveGrant(ctx, id, reply);
      entry.sources[id] = { id, endpoint, name: catalog.name, allowTools: catalog.allowTools, oauth, grant, revision: newId() };
      delete entry.completing;
      return previous;
    });
    await this.disable(old);
    return { id, name: catalog.name };
  }

  async disconnect(ctx: UserContext, id: string) {
    const old = await this.repo.transact(ctx, store => {
      const entry = updateEntries(store, hash(ctx.userId));
      const previous = entry.sources[id]?.grant?.secret;
      delete entry.sources[id];
      return previous;
    });
    await this.disable(old);
    return { connected: false };
  }

  async catalog(ctx: UserContext, id: unknown, revision?: string) {
    const { source, token } = await this.access(ctx, id, revision);
    return this.request(source.endpoint, token, client => discover(client, source.endpoint, source.allowTools));
  }

  async read(ctx: UserContext, id: unknown, uri: unknown, revision?: string) {
    if (typeof uri !== 'string' || uri.length > 1500 || !/^[a-z][a-z0-9+.-]*:[^\s\x00-\x1f]+$/i.test(uri)) throw new KnowledgeError('invalid_input', 'MCP 资料地址无效。');
    const { source, token } = await this.access(ctx, id, revision);
    return this.request(source.endpoint, token, async client => {
      const [items, patterns] = await Promise.all([resources(client), templates(client)]);
      if (!items.some(item => item.uri === uri) && !patterns.some(({ uriTemplate }) => {
        try { return !!new UriTemplate(uriTemplate).match(uri); } catch { return false; }
      })) throw new KnowledgeError('mcp_resource_unavailable', '此资料未在该 MCP 目录中公开。', 404);
      const { contents } = await client.readResource({ uri });
      return { source: source.endpoint, uri, retrievedAt: new Date().toISOString(), contents };
    });
  }

  async call(ctx: UserContext, id: unknown, name: unknown, args: unknown, revision?: string) {
    if (typeof name !== 'string' || !/^[\w.-]{1,128}$/.test(name) || !args || typeof args !== 'object' || Array.isArray(args)) throw new KnowledgeError('invalid_input', 'MCP 查询参数无效。');
    const { source, token } = await this.access(ctx, id, revision);
    return this.request(source.endpoint, token, async client => {
      const catalog = await discover(client, source.endpoint, source.allowTools);
      if (!catalog.allowTools) throw new KnowledgeError('mcp_query_unavailable', '此来源未启用只读 MCP 查询。', 403);
      if (!catalog.tools.some(tool => tool.name === name)) throw new KnowledgeError('mcp_query_unavailable', '该 MCP 服务未公开此只读查询。', 403);
      const result = await client.callTool({ name, arguments: args as Record<string, unknown> });
      if (result.isError) throw new KnowledgeError('mcp_query_failed', 'MCP 查询失败，请检查参数和账号权限。', 422);
      return { source: source.endpoint, tool: name, retrievedAt: new Date().toISOString(), result: result.structuredContent ?? result.content };
    });
  }

  private async request<T>(endpoint: string, token: string | undefined, operation: (client: Client) => Promise<T>): Promise<T> {
    try { return await withMcpClient(endpoint, this.network, operation, token); }
    catch (error) {
      if (error instanceof SourceError && error.kind === 'auth') throw reauthorize();
      if (error instanceof KnowledgeError) throw error;
      throw new KnowledgeError('mcp_unavailable', '暂时无法读取此 MCP 来源。', 502);
    }
  }

  private secretName(ctx: UserContext, kind: string, id: string) {
    return 'knowledge-mcp-' + kind + '-' + hash(JSON.stringify([ctx.tenantId, ctx.userId, id]));
  }

  private async saveGrant(ctx: UserContext, id: string, reply: { deadline: number | null; tokens: McpTokens }): Promise<Grant> {
    return { deadline: reply.deadline, secret: await this.secrets.put(this.secretName(ctx, 'tokens', id), JSON.stringify(reply.tokens)) };
  }

  private source(state: KnowledgeState, user: string, id: unknown) {
    enabled(state);
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new KnowledgeError('invalid_input', '请选择 MCP 来源。');
    const source = entries(state, user).sources[id];
    if (!source) throw new KnowledgeError('not_found', 'MCP 来源不存在。', 404);
    return source;
  }

  private async access(ctx: UserContext, id: unknown, revision?: string) {
    const user = hash(ctx.userId);
    const selected = (state: KnowledgeState) => {
      if (revision && (typeof id !== 'string' || liveMcpSelection(state, ctx, id)?.revision !== revision)) {
        throw new KnowledgeError('mcp_analysis_scope_changed', 'MCP 授权已变化，请重新选择来源。', 409);
      }
      return this.source(state, user, id);
    };
    const source = selected(await this.repo.read(ctx));
    if (!source.oauth) return { source, token: undefined };
    if (!source.grant) throw reauthorize();
    if (source.grant.deadline === null || source.grant.deadline > Date.now() + 30_000) {
      try { return { source, token: (JSON.parse(await this.secrets.get(source.grant.secret)) as McpTokens).access }; }
      catch { /* A concurrent refresh can retire this version. Recheck under the tenant lock. */ }
    }
    const refreshed = await this.repo.transact(ctx, async store => {
      const current = selected(store);
      if (!current.oauth || !current.grant) throw reauthorize();
      let tokens: McpTokens;
      try { tokens = JSON.parse(await this.secrets.get(current.grant.secret)) as McpTokens; } catch { throw reauthorize(); }
      if (current.grant.deadline === null || current.grant.deadline > Date.now() + 30_000) return { source: current, token: tokens.access };
      if (!tokens.refresh) throw reauthorize();
      const reply = await exchangeMcpToken(this.network, current.endpoint, current.oauth, {
        grant_type: 'refresh_token', refresh_token: tokens.refresh,
      }, tokens.refresh);
      const old = current.grant.secret;
      updateEntries(store, user).sources[current.id]!.grant = await this.saveGrant(ctx, current.id, reply);
      return { source: current, token: reply.tokens.access, old };
    });
    await this.disable(refreshed.old);
    return { source: refreshed.source, token: refreshed.token };
  }

  private async disable(ref?: SecretVersion) {
    if (ref) await this.secrets.disable(ref).catch(() => undefined);
  }
}
