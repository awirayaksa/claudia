/**
 * Loads the admin's enabled ESM plugins into the shared renderer registry
 * (the desktop's plugin API). Plugins import "react", "react/jsx-runtime"
 * and "unified"; the import map in index.html points those at shims that
 * hand out the app's own copies from window.__claudiaPluginHost.
 */
import { useEffect } from 'react';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { unified } from 'unified';
import { useAppDispatch } from '@/store';
import { setActiveExtensions, setActiveReplacement } from '@/store/slices/pluginSlice';
import { getPluginRendererRegistry } from '@/services/plugins/plugin-renderer.service';
import type { MarkdownExtensionPlugin, PluginContext, PluginManifest, RendererReplacementPlugin } from '@/types/plugin.types';
import type { PluginView } from '@shared/plugins';
import { apiFetch } from '../api/http';

declare global {
  interface Window {
    __claudiaPluginHost?: { React: typeof React; jsxRuntime: typeof jsxRuntime; unified: typeof unified };
  }
}

/** A plugin's own settings and storage (per browser), logger and event bus. */
function contextFor(p: PluginView, manifest: PluginManifest, events: PluginContext['events']): PluginContext {
  const key = (k: string) => `claudia.plugin.${p.id}.${k}`;
  return {
    pluginId: p.id,
    manifest,
    settings: p.settings,
    events,
    storage: {
      async get(k, fallback) {
        try {
          const v = localStorage.getItem(key(k));
          return v === null ? fallback : JSON.parse(v);
        } catch {
          return fallback;
        }
      },
      async set(k, v) {
        localStorage.setItem(key(k), JSON.stringify(v));
      },
      async delete(k) {
        localStorage.removeItem(key(k));
      },
      async clear() {
        for (const k of Object.keys(localStorage)) if (k.startsWith(`claudia.plugin.${p.id}.`)) localStorage.removeItem(k);
      },
    },
    logger: {
      debug: (m, ...a) => console.debug(`[plugin ${p.id}]`, m, ...a),
      info: (m, ...a) => console.info(`[plugin ${p.id}]`, m, ...a),
      warn: (m, ...a) => console.warn(`[plugin ${p.id}]`, m, ...a),
      error: (m, ...a) => console.error(`[plugin ${p.id}]`, m, ...a),
    },
  };
}

function eventBus(): PluginContext['events'] {
  const handlers = new Map<string, Set<(d: unknown) => void>>();
  return {
    emit: (e, d) => handlers.get(e)?.forEach((h) => h(d)),
    on: (e, h) => {
      if (!handlers.has(e)) handlers.set(e, new Set());
      handlers.get(e)!.add(h);
      return () => handlers.get(e)?.delete(h);
    },
    off: (e, h) => void handlers.get(e)?.delete(h),
  };
}

let loaded = false;

export async function loadPlugins(): Promise<{ extensions: string[]; replacement: string | null }> {
  window.__claudiaPluginHost ??= { React, jsxRuntime, unified };
  const { plugins } = await apiFetch<{ plugins: PluginView[] }>('/api/plugins');
  const registry = getPluginRendererRegistry();
  const events = eventBus();
  const extensions: string[] = [];
  let replacement: string | null = null;
  for (const p of plugins) {
    try {
      const mod = await import(/* @vite-ignore */ p.url);
      const plugin = (mod.default ?? mod) as MarkdownExtensionPlugin | RendererReplacementPlugin;
      const manifest = { ...p.manifest, ...(plugin.manifest ?? {}), main: 'index.mjs', id: p.id, type: p.manifest.type } as PluginManifest;
      plugin.manifest = manifest as never;
      const ctx = contextFor(p, manifest, events);
      await plugin.init?.(ctx);
      await plugin.activate?.(ctx);
      if (manifest.type === 'renderer-replacement') {
        registry.registerReplacement(p.id, plugin as RendererReplacementPlugin);
        replacement = p.id;
      } else {
        registry.registerExtension(p.id, plugin as MarkdownExtensionPlugin, p.manifest.renderer?.priority ?? 100);
        extensions.push(p.id);
      }
    } catch (err) {
      console.error(`[plugins] ${p.id} failed to load`, err);
    }
  }
  return { extensions, replacement };
}

/** Load plugins once per page, then let the renderer know. */
export function usePlugins(enabled: boolean): void {
  const dispatch = useAppDispatch();
  useEffect(() => {
    if (!enabled || loaded) return;
    loaded = true;
    void loadPlugins()
      .then(({ extensions, replacement }) => {
        dispatch(setActiveExtensions(extensions));
        dispatch(setActiveReplacement(replacement));
      })
      .catch((err) => console.error('[plugins] could not be listed', err));
  }, [enabled, dispatch]);
}
