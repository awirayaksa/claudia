import { createAppStore } from '@/store';

/**
 * The web store: the shared desktop slices (settings, ui, mcp, plugins,
 * skills, composer). Server data joins as RTK Query in Phase 1a.
 */
export function createWebStore() {
  return createAppStore({});
}

export type WebStore = ReturnType<typeof createWebStore>;
export type WebRootState = ReturnType<WebStore['getState']>;
