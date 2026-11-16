import { discoverOAuthServerInfo, extractWWWAuthenticateParams } from '@modelcontextprotocol/client';
import { hash, KnowledgeError } from './domain.js';
import { publicMcpEndpoint } from './plugins/mcp-public-http.js';

export const MCP_CALLBACK = '/mcp/oauth/callback';
export const MCP_CLIENT_DOCUMENT = '/mcp/oauth/client';

export function mcpClientDocument(origin: string, issuerKey = '') {
  const suffix = issuerKey ? '/' + issuerKey : '';
  return {
    client_id: origin + MCP_CLIENT_DOCUMENT + suffix, client_name: 'Super Agent',
    redirect_uris: [origin + MCP_CALLBACK + suffix], response_types: ['code'],
    grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none',
  };
}

export interface OAuthConnection {
  issuer: string;
  tokenEndpoint: string;
  callback: string;
  checkIssuer: boolean;
  clientId: string;
  scope?: string;
}

export function reauthorize() {
  return new KnowledgeError('mcp_reauthorize', '请在知识来源中重新授权此 MCP 连接。', 401);
}

async function json(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw Error('Missing OAuth response');
  const decoder = new TextDecoder();
  let body = '', bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 128_000) throw Error('OAuth response too large');
      body += decoder.decode(value, { stream: true });
    }
    const value = JSON.parse(body + decoder.decode());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid OAuth response');
    return value as Record<string, unknown>;
  } finally { await reader.cancel().catch(() => undefined); }
}

function oauthFetch(network: typeof fetch, signal = AbortSignal.timeout(10_000)): typeof fetch {
  return async (input, init) => {
    const url = publicMcpEndpoint(input instanceof Request ? input.url : String(input), true);
    const response = await network(url, { ...init, redirect: 'error', signal });
    if (response.ok) return Response.json(await json(response), { status: response.status });
    await response.body?.cancel();
    return new Response(null, { status: response.status, headers: response.headers });
  };
}

export async function mcpOAuth(
  network: typeof fetch, endpoint: string, challenge: Response, origin: string | undefined, host: string | undefined,
  options: { clientId?: unknown; scope?: unknown }, existing?: OAuthConnection,
) {
  const base = publicMcpEndpoint(origin);
  if (base.origin !== origin || base.host !== host) throw new KnowledgeError('mcp_oauth_origin', '请从 Super Agent 的 HTTPS 页面发起授权。');
  const { resourceMetadataUrl, scope: challengeScope } = extractWWWAuthenticateParams(challenge);
  const fetchFn = oauthFetch(network);
  try {
    const info = await discoverOAuthServerInfo(endpoint, { resourceMetadataUrl, fetchFn });
    const metadata = info.authorizationServerMetadata;
    if (!metadata || (info.resourceMetadata && publicMcpEndpoint(info.resourceMetadata.resource).href !== endpoint)) {
      throw Error('Invalid OAuth metadata');
    }
    const issuer = metadata.issuer;
    const authorizationUrl = publicMcpEndpoint(metadata.authorization_endpoint, true);
    const tokenEndpoint = publicMcpEndpoint(metadata.token_endpoint, true).href;
    if (metadata.code_challenge_methods_supported && !metadata.code_challenge_methods_supported.includes('S256')) throw Error('PKCE unavailable');
    const checkIssuer = 'authorization_response_iss_parameter_supported' in metadata && metadata.authorization_response_iss_parameter_supported === true;
    const client = mcpClientDocument(base.origin, checkIssuer ? '' : hash(issuer).slice(0, 32));
    const callback = client.redirect_uris[0]!;
    const previous = existing?.issuer === issuer ? existing : undefined;
    const scope = (typeof options.scope === 'string' ? options.scope.trim() : '') || previous?.scope || challengeScope;
    let clientId = typeof options.clientId === 'string' ? options.clientId.trim() : '';
    if (clientId.length > 1024 || (scope?.length ?? 0) > 1024) throw new KnowledgeError('invalid_input', 'OAuth 客户端或权限范围过长。');
    if (!clientId && previous?.callback === callback && previous.scope === scope) clientId = previous.clientId;
    if (!clientId && 'client_id_metadata_document_supported' in metadata && metadata.client_id_metadata_document_supported === true) {
      clientId = client.client_id;
    }
    if (!clientId && metadata.registration_endpoint) {
      const { client_id: _, ...registration } = client;
      const response = await fetchFn(metadata.registration_endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...registration, ...(scope ? { scope } : {}) }),
      });
      if (!response.ok) throw new KnowledgeError('mcp_oauth_registration', `MCP 服务拒绝动态注册。请核对回调地址或填写已注册的公开客户端 ID。回调地址为 ${callback}`, 422);
      const registered = await response.json();
      if (typeof registered.client_id !== 'string' || !registered.client_id || registered.client_secret
          || (registered.token_endpoint_auth_method && registered.token_endpoint_auth_method !== 'none')) throw Error('Public OAuth client required');
      clientId = registered.client_id;
    }
    if (!clientId) throw new KnowledgeError('mcp_oauth_client_required', `请注册 OAuth 公开客户端并填写客户端 ID。回调地址为 ${callback}`, 422);
    return { oauth: { issuer, tokenEndpoint, callback, clientId, checkIssuer, scope }, authorizationUrl, scope };
  } catch (error) {
    if (error instanceof KnowledgeError && error.code !== 'mcp_invalid_url') throw error;
    throw new KnowledgeError('mcp_oauth_unavailable', '无法发现 MCP 服务的 OAuth 授权设置。', 422);
  }
}

export interface McpTokens { access: string; refresh?: string }

export async function exchangeMcpToken(network: typeof fetch, endpoint: string, oauth: OAuthConnection, values: Record<string, string>, previousRefresh?: string) {
  const response = await oauthFetch(network)(oauth.tokenEndpoint, {
    method: 'POST', body: new URLSearchParams({ ...values, client_id: oauth.clientId, resource: endpoint }),
  }).catch(() => { throw new KnowledgeError('mcp_oauth_unavailable', '暂时无法连接 MCP 授权服务。', 502); });
  if ([400, 401, 403].includes(response.status)) throw reauthorize();
  if (!response.ok) throw new KnowledgeError('mcp_oauth_unavailable', '暂时无法连接 MCP 授权服务。', 502);
  const data = await response.json();
  if (typeof data.access_token !== 'string' || !data.access_token || (data.token_type && String(data.token_type).toLowerCase() !== 'bearer')) throw reauthorize();
  const refresh = typeof data.refresh_token === 'string' ? data.refresh_token : previousRefresh;
  const lifetime = data.expires_in;
  const deadline = typeof lifetime === 'number' && Number.isFinite(lifetime) ? Date.now() + Math.max(0, lifetime) * 1000 : null;
  return { deadline, tokens: { access: data.access_token, refresh } as McpTokens };
}
