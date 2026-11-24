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
