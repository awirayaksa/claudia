import { combineSlices, configureStore, type Middleware, type Reducer } from '@reduxjs/toolkit';
import settingsReducer from './slices/settingsSlice';
import uiReducer from './slices/uiSlice';
import mcpReducer from './slices/mcpSlice';
import pluginReducer from './slices/pluginSlice';
import skillReducer from './slices/skillSlice';
import composerReducer from './slices/composerSlice';

/** Slices every Claudia front end (desktop and web) has. */
export const sharedReducers = {
  settings: settingsReducer,
  ui: uiReducer,
  mcp: mcpReducer,
  plugins: pluginReducer,
  skills: skillReducer,
  composer: composerReducer,
};

export type SharedRootState = {
  [K in keyof typeof sharedReducers]: ReturnType<(typeof sharedReducers)[K]>;
};

/**
 * Create a store with the shared slices plus the host's own reducers
 * (desktop: chat, conversation, project; web: auth, the RTK Query API, ...).
 */
export function createAppStore<Extra extends Record<string, Reducer>>(
  extraReducers: Extra,
  options: { ignoredActions?: string[]; ignoredPaths?: string[]; extraMiddleware?: Middleware[] } = {}
) {
  const reducer = combineSlices(sharedReducers, extraReducers);
  return configureStore({
    reducer,
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({
        serializableCheck: {
          ignoredActions: options.ignoredActions ?? [],
          ignoredPaths: options.ignoredPaths ?? [],
        },
      }).concat(options.extraMiddleware ?? []),
  });
}
