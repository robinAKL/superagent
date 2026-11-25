/**
 * Browser sign-in (PRD §7.1). In Azure the server runs AUTH_MODE=entra: the page signs the user in with
 * Microsoft Entra (MSAL, redirect flow, session storage only) and sends an access token as a Bearer header.
 * In local development the server reports mode "dev" and nothing here runs.
 */
import type { AccountInfo, IPublicClientApplication } from '@azure/msal-browser';

export interface PublicAuthConfig {
  mode: 'dev' | 'entra';
  tenantId?: string;
  clientId?: string;
  scopes?: string[];
}

export interface SignedIn {
  mode: 'dev' | 'entra';
  name?: string;
  username?: string;
}

let client: IPublicClientApplication | null = null;
let account: AccountInfo | null = null;
let scopes: string[] = [];

/** Test seam: inject a fake MSAL client. */
export function __setClientForTest(c: IPublicClientApplication | null, a: AccountInfo | null, s: string[] = []): void {
  client = c;
  account = a;
  scopes = s;
}

export async function initAuth(fetchFn: typeof fetch = fetch): Promise<SignedIn> {
  const cfg = (await (await fetchFn('/auth/config')).json()) as PublicAuthConfig;
  if (cfg.mode !== 'entra') return { mode: 'dev' };
  if (!cfg.tenantId || !cfg.clientId || !cfg.scopes?.length) throw new Error('sign-in is not configured on the server');
  const { PublicClientApplication } = await import('@azure/msal-browser');
  const pca = new PublicClientApplication({
    auth: { clientId: cfg.clientId, authority: `https://login.microsoftonline.com/${cfg.tenantId}`, redirectUri: window.location.origin },
    cache: { cacheLocation: 'sessionStorage' }, // never localStorage: tokens end with the tab session
  });
  await pca.initialize();
  const result = await pca.handleRedirectPromise();
  scopes = cfg.scopes;
  account = result?.account ?? pca.getAllAccounts()[0] ?? null;
  client = pca;
  // A new tab has no tokens (they stay in each tab's session). The account it last signed in with (a name, not a
  // credential) lets it sign in quietly with the Microsoft session it already has, instead of the account picker.
  const hint = rememberedAccount();
  if (!account && hint) {
    try { account = (await pca.ssoSilent({ scopes, loginHint: hint })).account; } catch { /* the redirect below asks */ }
  }
  if (!account) {
    await pca.loginRedirect({ scopes, ...(hint ? { loginHint: hint } : {}) });
    return new Promise<SignedIn>(() => undefined); // the page is navigating to the sign-in page
  }
  pca.setActiveAccount(account);
  rememberAccount(account.username);
  return { mode: 'entra', name: account.name, username: account.username };
}

/** Access token for the API, or null in dev mode. Expired sessions go back through the sign-in redirect. */
export async function bearerToken(): Promise<string | null> {
  if (!client || !account) return null;
  try {
    return (await client.acquireTokenSilent({ scopes, account })).accessToken;
  } catch (e) {
    const { InteractionRequiredAuthError } = await import('@azure/msal-browser');
    if (e instanceof InteractionRequiredAuthError) await client.acquireTokenRedirect({ scopes, account });
    throw e;
  }
}

export async function signOut(): Promise<void> {
  rememberAccount(null);
  if (client) await client.logoutRedirect({ account: account ?? undefined });
}

const HINT_KEY = 'superagent.signin-hint';
function rememberedAccount(): string | null {
  try { return localStorage.getItem(HINT_KEY); } catch { return null; }
}
function rememberAccount(username: string | null): void {
  try { if (username) localStorage.setItem(HINT_KEY, username); else localStorage.removeItem(HINT_KEY); } catch { /* private mode */ }
}
