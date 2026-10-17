import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';
import App from './App';
import { store } from './store/desktop';
import { setPlatform } from './platform';
import { createElectronPlatform } from './platform/electron';
import { executeUIAction } from './store/slices/chatSlice';
import './styles/globals.css';

setPlatform(
  createElectronPlatform({
    getApiConfig: () => store.getState().settings.api,
    uiAction: (req) =>
      store
        .dispatch(
          executeUIAction({
            uri: req.uri,
            toolName: req.toolName,
            action: req.toolName,
            data: req.params,
            originalToolCallId: req.originalToolCallId,
          })
        )
        .unwrap(),
  })
);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Provider store={store}>
      <App />
    </Provider>
  </React.StrictMode>,
);
