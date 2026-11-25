import React from 'react';
import { createRoot } from 'react-dom/client';
// The agreed v2 type: DM Sans for Latin, Noto Sans SC for Chinese, bundled with the app (no external font request).
import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/600.css';
import '@fontsource/dm-sans/700.css';
import '@fontsource/noto-sans-sc/400.css';
import '@fontsource/noto-sans-sc/500.css';
import '@fontsource/noto-sans-sc/700.css';
import './styles/tokens.css';
import './styles/shell.css';
import { App } from './App';
import { initAuth } from './auth';
import { LangProvider, storedLang, translate, type Dict } from './i18n';

const TEXT: Dict<'cannotSignIn'> = {
  en: { cannotSignIn: 'Could not sign in: {reason}' },
  zh: { cannotSignIn: '无法登录：{reason}' },
};

const root = createRoot(document.getElementById('root')!);

function startApp() {
  initAuth()
    .then((user) =>
      root.render(
        <React.StrictMode>
          <LangProvider>
            <App user={user} />
          </LangProvider>
        </React.StrictMode>,
      ),
    )
    .catch((e: unknown) =>
      root.render(
        <p className="warn" role="alert">
          {translate(TEXT, storedLang(), 'cannotSignIn', { reason: e instanceof Error ? e.message : String(e) })}
        </p>,
      ),
    );
}

/**
 * A visitor who has not signed in and opened the site's front door sees the public front page; "登录" starts the
 * app. Anyone signed in before, coming back from Microsoft, or following a link into the app goes straight in.
 */
function showsLanding(): boolean {
  const hash = window.location.hash.replace(/^#/, '');
  if (/(^|&)(code|state|error)=/.test(hash) || window.location.search.includes('code=')) return false;
  if (hash !== '' && hash !== 'home' && !hash.startsWith('lp-')) return false;
  try {
    if (Object.keys(sessionStorage).some((key) => key.startsWith('msal.')) || localStorage.getItem('superagent.signin-hint')) return false;
  } catch { /* storage blocked: show the front page */ }
  return true;
}

/** The front page speaks Chinese to a Chinese browser unless the visitor chose a language before. */
function landingLang(): 'zh' | 'en' {
  try { if (localStorage.getItem('superagent.lang')) return storedLang(); } catch { /* ignore */ }
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : storedLang();
}

fetch('/auth/config')
  .then((response) => response.json() as Promise<{ mode?: string }>)
  .then((config) => {
    // ?landing shows the front page anywhere (previews, screenshots), even without sign-in configured.
    const forced = new URLSearchParams(window.location.search).has('landing');
    if (!forced && (config.mode !== 'entra' || !showsLanding())) return startApp();
    // The front page and its stylesheet load only here, and signing in reloads into the app, so none of its CSS
    // reaches the signed-in screens.
    return import('./pages/landing/Landing').then(({ Landing }) => root.render(
      <React.StrictMode>
        <LangProvider initial={landingLang()}>
          <Landing onSignIn={() => { window.history.replaceState(null, '', '/#room'); window.location.reload(); }} />
        </LangProvider>
      </React.StrictMode>,
    ));
  })
  .catch(startApp);
