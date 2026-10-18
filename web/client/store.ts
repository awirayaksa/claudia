import { createAppStore } from '@/store';
import { api } from './api/rtk-api';
import runReducer from './chat/run-slice';

/**
 * The web store: the shared desktop slices (settings, ui, mcp, plugins,
 * skills, composer), RTK Query for server data and live run state.
 */
export function createWebStore() {
  return createAppStore({ [api.reducerPath]: api.reducer, runs: runReducer }, { extraMiddleware: [api.middleware] });
}

export type WebStore = ReturnType<typeof createWebStore>;
export type WebRootState = ReturnType<WebStore['getState']>;
export type WebDispatch = WebStore['dispatch'];
