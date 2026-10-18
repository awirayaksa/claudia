/**
 * The desktop app's store instance. Shared code must not import this file;
 * it imports hooks and types from `./index` instead.
 */
import { createAppStore } from './create-store';
import chatReducer from './slices/chatSlice';
import conversationReducer from './slices/conversationSlice';
import projectReducer from './slices/projectSlice';
import { setProviderConfigSource } from '../services/api/provider.service';

export const store = createAppStore(
  {
    chat: chatReducer,
    conversation: conversationReducer,
    project: projectReducer,
  },
  {
    // The AbortController for the running stream lives in state
    ignoredActions: ['chat/setAbortController'],
    ignoredPaths: ['chat.abortController'],
  }
);

setProviderConfigSource(() => store.getState().settings.api);

export type DesktopStore = typeof store;
