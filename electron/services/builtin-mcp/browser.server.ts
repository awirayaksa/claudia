/**
 * Web browser: open pages, read them, click, type and take screenshots.
 *
 * The server only defines the tools. The host passes a `browser` that runs
 * the actions (the web server: a headless Chromium on the server, behind
 * the SSRF guard), so nothing here imports a browser. Each call carries the
 * chat's session key in its request `_meta` (set by the host, never by the
 * model): one chat keeps one browser session across calls and replies.
 *
 * Tools that act on a page (click, type, choose, press a key) are marked
 * readOnlyHint: false, so the host can ask the user first.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { errorResult } from './office-files';

// ============================================================================
// Host interface
// ============================================================================

export type BrowserAction =
  | { type: 'navigate'; url: string }
  | { type: 'snapshot' }
  | { type: 'click'; ref: string; element: string; button?: 'left' | 'right' | 'middle'; doubleClick?: boolean }
  | { type: 'type'; ref: string; element: string; text: string; submit?: boolean; slowly?: boolean }
  | { type: 'select'; ref: string; element: string; values: string[] }
  | { type: 'press_key'; key: string; ref?: string; element?: string }
  | { type: 'scroll'; direction: 'up' | 'down'; pages?: number; ref?: string }
  | { type: 'screenshot'; fullPage?: boolean; ref?: string }
  | { type: 'back' }
  | { type: 'tabs'; action: 'list' | 'select' | 'new' | 'close'; index?: number; url?: string }
  | { type: 'wait'; text?: string; seconds?: number }
  | { type: 'close' };

export interface BrowserReply {
  /** What the model reads: the outcome, then the page (title, address, elements). */
  text: string;
  /** A screenshot, base64. */
  image?: { mime: string; data: string };
  isError?: boolean;
}

export interface BrowserHost {
  run(sessionKey: string, action: BrowserAction): Promise<BrowserReply>;
}

/** The request `_meta` key holding the chat's session key (the web's mcp-pool sets it). */
export const SESSION_META = 'claudia/session';

// ============================================================================
// Server
// ============================================================================

export function createBrowserServer(config?: Record<string, unknown>): McpServer {
  const server = new McpServer({ name: 'Claudia Web Browser', version: '1.0.0' }, { capabilities: { tools: {} } });
  const host = config?.browser as BrowserHost | undefined;

  const look = { readOnlyHint: true, openWorldHint: true } as const;
  const act = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

  const ref = z
    .string()
    .trim()
    .regex(/^[a-z0-9]{1,24}$/i, 'Use a ref from the latest snapshot, e.g. "e12".')
    .describe('The element\'s ref from the latest snapshot, e.g. "e12".');
  const element = z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe('What the element is, in a few words (e.g. "Search button"). Shown to the user when they approve the action.');

  /** Run an action for the chat this call came from. */
  const run = async (action: BrowserAction, extra: { _meta?: Record<string, unknown> }) => {
    if (!host) return errorResult("The web browser isn't available on this server.");
    const key = extra._meta?.[SESSION_META];
    if (typeof key !== 'string' || !key) return errorResult('The web browser works in chats only.');
    try {
      const reply = await host.run(key, action);
      return {
        content: [
          { type: 'text' as const, text: reply.text },
          ...(reply.image ? [{ type: 'image' as const, data: reply.image.data, mimeType: reply.image.mime }] : []),
        ],
        ...(reply.isError ? { isError: true } : {}),
      };
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  };

  server.tool(
    'browser_navigate',
    'Open a web page in the browser (http or https). Returns the page as text, with a ref like [ref=e12] for each element you can click or type in. ' +
      'Use this to read a site, look something up, or work through a page step by step; for a single document, the fetch tool is faster.',
    { url: z.string().trim().min(1).max(4000).describe('The address to open, e.g. https://example.com/page.') },
    look,
    async ({ url }, extra) => run({ type: 'navigate', url }, extra)
  );

  server.tool(
    'browser_snapshot',
    'Read the current page again: its title, address, text and the refs of its elements. Refs change when the page does, so take a new snapshot before acting on a changed page.',
    {},
    look,
    async (_args, extra) => run({ type: 'snapshot' }, extra)
  );

  server.tool(
    'browser_click',
    'Click an element of the page (a link, button, checkbox, tab...).',
    {
      element,
      ref,
      button: z.enum(['left', 'right', 'middle']).optional().describe('Default left.'),
      doubleClick: z.boolean().optional(),
    },
    act,
    async (args, extra) => run({ type: 'click', ...args }, extra)
  );

  server.tool(
    'browser_type',
    'Type text into a field of the page, replacing what it holds. Never type passwords or payment details: ask the user to do that.',
    {
      element,
      ref,
      text: z.string().max(10_000),
      submit: z.boolean().optional().describe('Press Enter afterwards (e.g. to search).'),
      slowly: z.boolean().optional().describe('Type one key at a time, for fields that react to each key (suggestions).'),
    },
    act,
    async (args, extra) => run({ type: 'type', ...args }, extra)
  );

  server.tool(
    'browser_select',
    'Choose one or more options in a drop-down list.',
    { element, ref, values: z.array(z.string().max(500)).min(1).max(50).describe('The options to choose, by their label or value.') },
    act,
    async (args, extra) => run({ type: 'select', ...args }, extra)
  );

  server.tool(
    'browser_press_key',
    'Press a key or a shortcut, e.g. "Enter", "Escape", "ArrowDown", "Control+A". Pass a ref to press it in that element.',
    { key: z.string().trim().min(1).max(50), ref: ref.optional(), element: element.optional() },
    act,
    async (args, extra) => run({ type: 'press_key', ...args }, extra)
  );

  server.tool(
    'browser_scroll',
    'Scroll the page up or down (by screens), or pass a ref to scroll that element into view. Returns the page again.',
    {
      direction: z.enum(['up', 'down']).default('down'),
      pages: z.number().min(0.25).max(10).optional().describe('How far, in screens (default 1).'),
      ref: ref.optional(),
    },
    look,
    async (args, extra) => run({ type: 'scroll', ...args }, extra)
  );

  server.tool(
    'browser_screenshot',
    'See the page as a picture: the visible part, the whole page, or one element. Use it when the layout, a chart or an image matters; read text with browser_snapshot.',
    { fullPage: z.boolean().optional().describe('The whole page instead of the visible part (long pages are cut).'), ref: ref.optional() },
    look,
    async (args, extra) => run({ type: 'screenshot', ...args }, extra)
  );

  server.tool('browser_back', 'Go back to the previous page.', {}, look, async (_args, extra) => run({ type: 'back' }, extra));

  server.tool(
    'browser_tabs',
    'List the open tabs, switch to one, open a new one (with a url) or close one. Links that open a new window appear as tabs.',
    {
      action: z.enum(['list', 'select', 'new', 'close']),
      index: z.number().int().min(1).max(50).optional().describe('Tab number from the list (select, close; default the current tab).'),
      url: z.string().trim().max(4000).optional().describe('For "new": the address to open.'),
    },
    look,
    async (args, extra) => run({ type: 'tabs', ...args }, extra)
  );

  server.tool(
    'browser_wait',
    'Wait for some text to appear on the page, or for a few seconds (for pages that load slowly).',
    { text: z.string().trim().min(1).max(500).optional(), seconds: z.number().min(0.5).max(10).optional() },
    look,
    async (args, extra) => run({ type: 'wait', ...args }, extra)
  );

  server.tool(
    'browser_close',
    'Close the browser when the task is done. Its pages, cookies and sign-ins are gone afterwards.',
    {},
    look,
    async (_args, extra) => run({ type: 'close' }, extra)
  );

  return server;
}
