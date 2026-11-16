import { createHash, randomBytes } from 'node:crypto';
import { type Client, UriTemplate } from '@modelcontextprotocol/client';
import { SourceError, type UserContext } from '@superagent/shared';
import type { SecretStore, SecretVersion } from '../setup/secrets.js';
import { hash, KnowledgeError, type KnowledgeState } from './domain.js';
import type { KnowledgeRepository } from './repository.js';
import { publicMcpEndpoint, publicMcpFetch } from './plugins/mcp-public-http.js';
import { withMcpClient } from './plugins/mcp-resources.js';

export const VERA_MCP_URL = 'https://blinds-crm.vercel.app/api/mcp';
export const VERA_CALLBACK_PATH = '/mcp/vera/callback';
const issuer = 'https://blinds-crm.vercel.app/api/mcp-auth';
const resourceMetadata = 'https://blinds-crm.vercel.app/.well-known/oauth-protected-resource/api/mcp';
const issuerMetadata = 'https://blinds-crm.vercel.app/.well-known/oauth-authorization-server/api/mcp-auth';
const scopes = ['crm:read', 'crm:knowledge:read'];
const oauthTimeout = 10_000;

interface Attempt {
  stateHash: string;
  deadline: number;
  callback: string;
  clientId: string;
  verifier: SecretVersion;
}
interface Grant {
  clientId: string;
  deadline: number;
  secret: SecretVersion;
}
export interface VeraMcpState {
  attempt?: Attempt;
  completing?: string;
  grant?: Grant;
}
interface Tokens { access: string; refresh: string }

function enabled(state: KnowledgeState): void {
  if (state.disabledPlugins.includes('mcp')) throw new KnowledgeError('plugin_disabled', 'MCP 知识来源已暂停。', 409);
}

function reauthorize(): KnowledgeError {
  return new KnowledgeError('vera_reauthorize', '请在知识来源中连接或重新授权 VERA CRM。', 401);
}

function invalidCallback(): KnowledgeError {
  return new KnowledgeError('vera_oauth_callback', 'VERA CRM 的授权已取消或已过期。请重新连接。');
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

async function resources(client: Client) {
  if (!client.getServerCapabilities()?.resources) return [];
  return collect(async cursor => {
    const page = await client.listResources({ cursor });
    return { items: page.resources, nextCursor: page.nextCursor };
  });
}

async function templates(client: Client) {
  if (!client.getServerCapabilities()?.resources) return [];
  return collect(async cursor => {
    const page = await client.listResourceTemplates({ cursor });
    return { items: page.resourceTemplates, nextCursor: page.nextCursor };
  });
}

async function readOnlyTools(client: Client) {
  if (!client.getServerCapabilities()?.tools) return [];
  return collect(async cursor => {
    const page = await client.listTools({ cursor });
    // Annotations are trusted only for this pinned CRM origin.
    const items = page.tools.filter(tool => tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint !== true);
    return { items, nextCursor: page.nextCursor };
  });
}

export class VeraMcpKnowledge {
  constructor(
    private readonly repo: KnowledgeRepository,
    private readonly secrets: SecretStore,
    private readonly network: typeof fetch = publicMcpFetch,
  ) {}

  status(state: KnowledgeState, ctx: UserContext) {
    return { endpoint: VERA_MCP_URL, connected: !state.disabledPlugins.includes('mcp') && !!state.veraMcp[hash(ctx.userId)]?.grant };
  }

  async start(ctx: UserContext, origin: string | undefined, host: string | undefined) {
    enabled(await this.repo.read(ctx));
    const callback = this.callback(origin, host);
    const resource = await this.oauth(resourceMetadata);
    if (resource.resource !== VERA_MCP_URL || !Array.isArray(resource.authorization_servers) || !resource.authorization_servers.includes(issuer)) {
      throw new KnowledgeError('vera_oauth_unavailable', '无法验证 VERA CRM 的授权服务器。', 502);
    }
    const metadata = await this.oauth(issuerMetadata);
    if (metadata.issuer !== issuer || metadata.registration_endpoint !== issuer + '/register'
      || metadata.authorization_endpoint !== issuer + '/authorize' || metadata.token_endpoint !== issuer + '/token'
      || !Array.isArray(metadata.code_challenge_methods_supported) || !metadata.code_challenge_methods_supported.includes('S256')
      || !Array.isArray(metadata.scopes_supported) || !scopes.every(scope => (metadata.scopes_supported as unknown[]).includes(scope))) {
      throw new KnowledgeError('vera_oauth_unavailable', 'VERA CRM 的授权配置不完整。', 502);
    }
    const registered = await this.oauth(issuer + '/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Super Agent', redirect_uris: [callback], response_types: ['code'],
        grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none', scope: scopes.join(' '),
      }),
    });
    if (typeof registered.client_id !== 'string' || !registered.client_id) {
      throw new KnowledgeError('vera_oauth_unavailable', 'VERA CRM 未返回有效的授权客户端。', 502);
    }
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const clientId = registered.client_id;
    const key = hash(ctx.userId);
    const oldVerifier = await this.repo.transact(ctx, async store => {
      enabled(store);
      const previous = store.veraMcp[key] ?? {};
      const secretName = 'knowledge-vera-pkce-' + hash(JSON.stringify([ctx.tenantId, ctx.userId]));
      const secret = await this.secrets.put(secretName, verifier);
      const attempt: Attempt = { stateHash: hash(state), deadline: Date.now() + 10 * 60_000, callback, clientId, verifier: secret };
      store.veraMcp[key] = { grant: previous.grant, attempt };
      return previous.attempt?.verifier;
    });
    await this.disable(oldVerifier);
    const query = new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: callback, scope: scopes.join(' '),
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      resource: VERA_MCP_URL, state,
    });
    return { authorizationUrl: issuer + '/authorize?' + query };
  }

  async finish(ctx: UserContext, input: Record<string, unknown>) {
    const { state, code, iss } = input;
    if (typeof state !== 'string' || !/^[\w-]{43}$/.test(state)) throw invalidCallback();
    const key = hash(ctx.userId);
    const attempt = await this.repo.transact(ctx, store => {
      enabled(store);
      const entry = store.veraMcp[key], current = entry?.attempt;
      if (!entry || !current || current.stateHash !== hash(state)) throw invalidCallback();
      delete entry.attempt;
      entry.completing = current.stateHash;
      return current;
    });
    let verifier: string;
    try {
      if (attempt.deadline <= Date.now() || iss !== issuer || typeof code !== 'string' || !code || code.length > 2048) throw invalidCallback();
      verifier = await this.secrets.get(attempt.verifier);
    } finally {
      await this.disable(attempt.verifier);
    }
    const reply = await this.tokens({
      grant_type: 'authorization_code', client_id: attempt.clientId, redirect_uri: attempt.callback, code, code_verifier: verifier,
    });
    const catalog = await this.request(reply.tokens.access, this.discover);
    const old = await this.repo.transact(ctx, async store => {
      enabled(store);
      const entry = store.veraMcp[key];
      if (!entry || entry.completing !== attempt.stateHash) throw invalidCallback();
      const previous = entry.grant?.secret;
      entry.grant = await this.saveGrant(ctx, attempt.clientId, reply);
      delete entry.completing;
      return previous;
    });
    await this.disable(old);
    return catalog;
  }

  async disconnect(ctx: UserContext) {
    const old = await this.repo.transact(ctx, store => {
      const key = hash(ctx.userId), entry = store.veraMcp[key];
      delete store.veraMcp[key];
      return entry;
    });
    await Promise.all([this.disable(old?.grant?.secret), this.disable(old?.attempt?.verifier)]);
    return { connected: false };
  }

  async catalog(ctx: UserContext) {
    return this.request(await this.access(ctx), this.discover);
  }

  async read(ctx: UserContext, uri: unknown) {
    if (typeof uri !== 'string' || uri.length > 1500 || !/^[a-z][a-z0-9+.-]*:[^\s\x00-\x1f]+$/i.test(uri)) {
      throw new KnowledgeError('invalid_input', 'MCP 资料地址无效。');
    }
    return this.request(await this.access(ctx), async client => {
      const [items, patterns] = await Promise.all([resources(client), templates(client)]);
      if (!items.some(item => item.uri === uri) && !patterns.some(({ uriTemplate }) => {
        try { return !!new UriTemplate(uriTemplate).match(uri); } catch { return false; }
      })) throw new KnowledgeError('vera_resource_unavailable', '此资料未在 VERA CRM 的 MCP 目录中公开。', 404);
      const { contents } = await client.readResource({ uri });
      return { source: VERA_MCP_URL, uri, retrievedAt: new Date().toISOString(), contents };
    });
  }

  async call(ctx: UserContext, name: unknown, args: unknown) {
    if (typeof name !== 'string' || !/^[\w.-]{1,128}$/.test(name) || !args || typeof args !== 'object' || Array.isArray(args)) {
      throw new KnowledgeError('invalid_input', 'MCP 查询参数无效。');
    }
    return this.request(await this.access(ctx), async client => {
      if (!(await readOnlyTools(client)).some(tool => tool.name === name)) {
        throw new KnowledgeError('vera_query_unavailable', '此查询未在 VERA CRM 的只读 MCP 目录中公开。', 403);
      }
      const result = await client.callTool({ name, arguments: args as Record<string, unknown> });
      if (result.isError) throw new KnowledgeError('vera_query_failed', 'VERA CRM 无法完成查询。请检查参数和 CRM 账号权限。', 422);
      return {
        source: VERA_MCP_URL, tool: name, retrievedAt: new Date().toISOString(),
        result: result.structuredContent ?? result.content,
      };
    });
  }

  private discover = async (client: Client) => {
    const [items, patterns, tools] = await Promise.all([resources(client), templates(client), readOnlyTools(client)]);
    return {
      source: VERA_MCP_URL,
      resources: items.map(({ uri, name, title, description, mimeType }) => ({ uri, name, title, description, mimeType })),
      resourceTemplates: patterns.map(({ uriTemplate, name, title, description }) => ({ uriTemplate, name, title, description })),
      tools: tools.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema })),
    };
  };

  private callback(origin: string | undefined, host: string | undefined) {
    const url = publicMcpEndpoint(origin);
    if (url.origin !== origin || url.host !== host) throw new KnowledgeError('vera_oauth_origin', '请从 Super Agent 的 HTTPS 页面发起授权。');
    return url.origin + VERA_CALLBACK_PATH;
  }

  private async oauth(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
    try {
      const response = await this.network(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(oauthTimeout) });
      if (!response.ok) {
        await response.body?.cancel();
        if (url.endsWith('/register') && response.status === 400) {
          throw new KnowledgeError('vera_oauth_registration', 'VERA CRM 拒绝注册，请检查是否已允许此 Super Agent 的回调地址。', 422);
        }
        if (url.endsWith('/token') && [400, 401, 403].includes(response.status)) throw reauthorize();
        throw Error();
      }
      return await response.json() as Record<string, unknown>;
    } catch (error) {
      if (error instanceof KnowledgeError) throw error;
      throw new KnowledgeError('vera_oauth_unavailable', '暂时无法连接 VERA CRM 授权服务。', 502);
    }
  }

  private async request<T>(token: string, operation: (client: Client) => Promise<T>): Promise<T> {
    try { return await withMcpClient(VERA_MCP_URL, this.network, operation, token); }
    catch (error) {
      if (error instanceof SourceError && error.kind === 'auth') throw reauthorize();
      if (error instanceof KnowledgeError) throw error;
      throw new KnowledgeError('vera_mcp_unavailable', '暂时无法读取 VERA CRM 的 MCP 知识。', 502);
    }
  }

  private async tokens(params: Record<string, string>) {
    const data = await this.oauth(issuer + '/token', {
      method: 'POST', body: new URLSearchParams({ ...params, resource: VERA_MCP_URL }),
    });
    const access = data.access_token, refresh = data.refresh_token, lifetime = data.expires_in;
    if (typeof access !== 'string' || !access || typeof refresh !== 'string' || !refresh
      || typeof lifetime !== 'number' || !Number.isFinite(lifetime) || lifetime <= 0
      || typeof data.scope !== 'string') throw reauthorize();
    const granted = new Set(data.scope.split(/\s+/).filter(Boolean));
    if (granted.size !== scopes.length || !scopes.every(scope => granted.has(scope))) throw reauthorize();
    return { deadline: Date.now() + lifetime * 1000, tokens: { access, refresh } };
  }

  private async saveGrant(ctx: UserContext, clientId: string, reply: { deadline: number; tokens: Tokens }): Promise<Grant> {
    const key = hash(JSON.stringify([ctx.tenantId, ctx.userId]));
    const secret = await this.secrets.put('knowledge-vera-tokens-' + key, JSON.stringify(reply.tokens));
    return { clientId, deadline: reply.deadline, secret };
  }

  private async access(ctx: UserContext): Promise<string> {
    const key = hash(ctx.userId), state = await this.repo.read(ctx);
    enabled(state);
    const grant = state.veraMcp[key]?.grant;
    if (!grant) throw reauthorize();
    if (grant.deadline > Date.now() + 30_000) {
      try {
        const tokens = JSON.parse(await this.secrets.get(grant.secret)) as Tokens;
        return tokens.access;
      } catch { /* A concurrent refresh can retire the version. Recheck under the tenant lock. */ }
    }
    const refreshed = await this.repo.transact(ctx, async store => {
      enabled(store);
      const entry = store.veraMcp[key], current = entry?.grant;
      if (!entry || !current) throw reauthorize();
      let tokens: Tokens;
      try { tokens = JSON.parse(await this.secrets.get(current.secret)) as Tokens; } catch { throw reauthorize(); }
      if (current.deadline > Date.now() + 30_000) return { access: tokens.access };
      const reply = await this.tokens({ grant_type: 'refresh_token', client_id: current.clientId, refresh_token: tokens.refresh });
      entry.grant = await this.saveGrant(ctx, current.clientId, reply);
      return { access: reply.tokens.access, old: current.secret };
    });
    await this.disable(refreshed.old);
    return refreshed.access;
  }

  private async disable(ref?: SecretVersion) {
    if (ref) await this.secrets.disable(ref).catch(() => undefined);
  }
}
