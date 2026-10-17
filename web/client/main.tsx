import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';
import { setPlatform } from '@/platform';
import '@/styles/globals.css';
import './i18n';
import { PublicConfig } from '@shared/api';
import { createWebPlatform } from './platform/web.platform';
import { createWebStore } from './store';
import { App } from './App.web';

async function start() {
  // The sandbox origin is server configuration; MCP-UI frames need it before rendering
  let sandboxOrigin: string | undefined;
  try {
    const res = await fetch('/api/public-config');
    sandboxOrigin = PublicConfig.parse(await res.json()).sandboxOrigin ?? undefined;
  } catch {
    sandboxOrigin = undefined;
  }
  setPlatform(createWebPlatform({ sandboxOrigin }));
  const store = createWebStore();

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <Provider store={store}>
        <App />
      </Provider>
    </React.StrictMode>
  );
}

void start();
