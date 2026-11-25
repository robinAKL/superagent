import { AccountError, type AccountProvider, type ProviderTokens } from './accounts.js';

/**
 * Microsoft 365 sign-in for one mailbox and its calendar (delegated permissions: the account signs in as itself and
 * grants only its own mail and calendar). One multi-tenant app registration for the platform, a confidential web
 * client: MS_ACCOUNTS_CLIENT_ID and MS_ACCOUNTS_CLIENT_SECRET.
 */
export const MICROSOFT_SCOPES = 'openid profile email offline_access User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite';
const AUTHORITY = 'https://login.microsoftonline.com/organizations/oauth2/v2.0';

export function microsoftProvider(config: { clientId: string; clientSecret: string }, network: typeof fetch = fetch): AccountProvider {
  async function token(body: Record<string, string>): Promise<ProviderTokens> {
    const response = await network(AUTHORITY + '/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, scope: MICROSOFT_SCOPES, ...body }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || typeof data.access_token !== 'string') {
      const code = typeof data.error === 'string' ? data.error : 'token_failed';
      throw new AccountError(code === 'invalid_grant' ? 'reauthorize' : 'sign_in_failed', 'Microsoft 365 登录没有完成，请重新连接。', 401);
    }
    return {
      access: data.access_token,
      refresh: typeof data.refresh_token === 'string' ? data.refresh_token : null,
      expiresIn: typeof data.expires_in === 'number' ? data.expires_in : Number(data.expires_in) || null,
      scope: typeof data.scope === 'string' ? data.scope : MICROSOFT_SCOPES,
    };
  }
  return {
    id: 'microsoft',
    scopes: MICROSOFT_SCOPES,
    authorizeUrl({ state, challenge, redirectUri }) {
      const url = new URL(AUTHORITY + '/authorize');
      for (const [key, value] of Object.entries({
        client_id: config.clientId, response_type: 'code', redirect_uri: redirectUri, response_mode: 'query', scope: MICROSOFT_SCOPES,
        state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
      })) url.searchParams.set(key, value);
      return url.href;
    },
    redeem: ({ code, verifier, redirectUri }) => token({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri }),
    refresh: (refreshToken) => token({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    async whoAmI(accessToken) {
      const response = await network('https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName', {
        headers: { authorization: 'Bearer ' + accessToken }, signal: AbortSignal.timeout(15_000),
      });
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      const address = typeof data.mail === 'string' && data.mail ? data.mail : typeof data.userPrincipalName === 'string' ? data.userPrincipalName : '';
      if (!response.ok || !address) throw new AccountError('sign_in_failed', '读不到这个账号的邮箱地址。', 502);
      return { address, displayName: typeof data.displayName === 'string' ? data.displayName : address };
    },
  };
}
