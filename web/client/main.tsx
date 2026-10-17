import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';
import { setPlatform } from '@/platform';
import '@/styles/globals.css';
import './i18n';
import { createWebPlatform } from './platform/web.platform';
import { createWebStore } from './store';
import { App } from './App.web';

setPlatform(createWebPlatform({ sandboxOrigin: import.meta.env.VITE_CLAUDIA_SANDBOX_ORIGIN }));
const store = createWebStore();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Provider store={store}>
      <App />
    </Provider>
  </React.StrictMode>
);
