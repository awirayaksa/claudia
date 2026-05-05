import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import axios from 'axios';
import { z } from 'zod';

// ============================================================================
// Lazy-loaded dependencies (heavy DOM / parsing modules)
// ============================================================================

let jsdomModule: any = null;
let readabilityModule: any = null;
let turndownModule: any = null;
let turndownGfmModule: any = null;

function getJSDOM(): any {
  if (!jsdomModule) {
    jsdomModule = require('jsdom');
  }
  return jsdomModule;
}

function getReadability(): any {
  if (!readabilityModule) {
    readabilityModule = require('@mozilla/readability');
  }
  return readabilityModule;
}

function getTurndown(): any {
  if (!turndownModule) {
    turndownModule = require('turndown');
  }
  return turndownModule;
}

function getTurndownGfm(): any {
  if (!turndownGfmModule) {
    turndownGfmModule = require('turndown-plugin-gfm');
  }
  return turndownGfmModule;
}

// ============================================================================
// Config types
// ============================================================================

interface FetchConfig {
  userAgent?: string;
  timeoutMs?: number;
  maxBytes?: number;
  respectRobotsTxt?: boolean;
  allowPrivateNetworks?: boolean;
  defaultMaxLength?: number;
}

// ============================================================================
// SSRF Protection
// ============================================================================

function isPrivateIP(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h === '0.0.0.0') return true;

  const ipv4Private = [
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
    /^192\.168\./,
    /^169\.254\./,
  ];
  if (ipv4Private.some((re) => re.test(h))) return true;

  if (h === '::1') return true;
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // fc00::/7
  if (h.startsWith('fe80:')) return true; // fe80::/10

  return false;
}

// ============================================================================
// Robots.txt cache and parser
// ============================================================================

const robotsCache = new Map<string, { allowed: boolean; expires: number }>();

async function isAllowedByRobots(
  url: string,
  userAgent: string
): Promise<{ allowed: boolean; reason?: string }> {
  const parsed = new URL(url);
  const origin = parsed.origin;
  const cached = robotsCache.get(origin);
  if (cached && cached.expires > Date.now()) {
    if (!cached.allowed) {
      return { allowed: false, reason: 'Disallowed by robots.txt (cached)' };
    }
    return { allowed: true };
  }

  try {
    const robotsUrl = `${origin}/robots.txt`;
    const resp = await axios.get(robotsUrl, {
      timeout: 10000,
      maxRedirects: 5,
      headers: { 'User-Agent': userAgent },
      validateStatus: () => true,
      responseType: 'text',
    });

    if (resp.status >= 400) {
      robotsCache.set(origin, {
        allowed: true,
        expires: Date.now() + 5 * 60 * 1000,
      });
      return { allowed: true };
    }

    const lines = String(resp.data).split(/\r?\n/);
    let matched = false;
    let allowed = true;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;

      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) continue;

      const key = line.slice(0, colonIndex).trim().toLowerCase();
      const value = line.slice(colonIndex + 1).trim();

      if (key === 'user-agent') {
        const ua = value.toLowerCase();
        matched =
          ua === '*' || userAgent.toLowerCase().includes(ua);
      } else if (matched && (key === 'disallow' || key === 'allow')) {
        let rulePath = value;
        if (!rulePath.startsWith('/')) rulePath = '/' + rulePath;
        const targetPath = parsed.pathname + parsed.search;
        if (targetPath.startsWith(rulePath) || rulePath === '/') {
          allowed = key === 'allow';
        }
      }
    }

    robotsCache.set(origin, {
      allowed,
      expires: Date.now() + 5 * 60 * 1000,
    });
    if (!allowed) {
      return { allowed: false, reason: 'Disallowed by robots.txt' };
    }
    return { allowed: true };
  } catch {
    robotsCache.set(origin, {
      allowed: true,
      expires: Date.now() + 5 * 60 * 1000,
    });
    return { allowed: true };
  }
}

// ============================================================================
// Content helpers
// ============================================================================

function getCharset(contentType: string | undefined): string {
  if (!contentType) return 'utf-8';
  const match = contentType.match(/charset=([^;]+)/i);
  if (match) {
    return match[1].trim().replace(/["']/g, '').toLowerCase();
  }
  return 'utf-8';
}

function isBinaryContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  if (ct.includes('image/')) return true;
  if (ct.includes('application/octet-stream')) return true;
  if (ct.includes('application/pdf')) return true;
  if (ct.includes('audio/')) return true;
  if (ct.includes('video/')) return true;
  if (ct.includes('application/zip')) return true;
  if (ct.includes('application/gzip')) return true;
  return false;
}

function decodeBody(buffer: Buffer, charset: string): string {
  try {
    const decoder = new TextDecoder(charset, { fatal: false });
    return decoder.decode(buffer);
  } catch {
    return buffer.toString('utf-8');
  }
}

function getFinalUrl(response: any): string {
  return response?.request?.res?.responseUrl || response?.config?.url || '';
}

// ============================================================================
// Server Factory
// ============================================================================

export function createFetchServer(config?: Record<string, unknown>): McpServer {
  const cfg: FetchConfig = (config as FetchConfig) || {};
  const userAgent =
    cfg.userAgent ??
    'ModelContextProtocol/1.0 (Claudia; +https://github.com/modelcontextprotocol)';
  const timeoutMs = cfg.timeoutMs ?? 30000;
  const maxBytes = cfg.maxBytes ?? 10 * 1024 * 1024;
  const respectRobotsTxt = cfg.respectRobotsTxt ?? false;
  const allowPrivateNetworks = cfg.allowPrivateNetworks ?? false;
  const defaultMaxLength = cfg.defaultMaxLength ?? 5000;

  const server = new McpServer(
    { name: 'Claudia Fetch', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.tool(
    'fetch',
    'Fetch a URL and return its content as markdown (or raw text/html/json). ' +
      'Useful for reading documentation, articles, blog posts, and API responses. ' +
      'For HTML pages, the main article content is extracted and converted to markdown. ' +
      'Use max_length and start_index to paginate through long pages.',
    {
      url: z
        .string()
        .url()
        .describe('The URL to fetch. Must be http: or https:'),
      max_length: z
        .number()
        .int()
        .min(1)
        .max(1_000_000)
        .optional()
        .describe('Maximum length of content to return (default: 5000)'),
      start_index: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Start index for pagination (default: 0)'),
      raw: z
        .boolean()
        .optional()
        .describe(
          'Return raw response body without HTML-to-markdown conversion (default: false)'
        ),
    },
    async ({ url, max_length, start_index, raw }) => {
      // 1. Validate URL scheme
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        return {
          content: [{ type: 'text' as const, text: 'Invalid URL' }],
          isError: true,
        };
      }

      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Unsupported protocol: ${parsedUrl.protocol}`,
            },
          ],
          isError: true,
        };
      }

      // 2. SSRF guard
      if (!allowPrivateNetworks && isPrivateIP(parsedUrl.hostname)) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                'Private network access is not allowed. Set allowPrivateNetworks to true in builtinConfig to enable.',
            },
          ],
          isError: true,
        };
      }

      // 3. robots.txt check
      if (respectRobotsTxt) {
        const robotsResult = await isAllowedByRobots(url, userAgent);
        if (!robotsResult.allowed) {
          return {
            content: [
              {
                type: 'text' as const,
                text: robotsResult.reason || 'Blocked by robots.txt',
              },
            ],
            isError: true,
          };
        }
      }

      // 4. Fetch
      let response;
      try {
        response = await axios.get(url, {
          responseType: 'arraybuffer',
          timeout: timeoutMs,
          maxContentLength: maxBytes,
          maxRedirects: 5,
          headers: {
            'User-Agent': userAgent,
            Accept:
              'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5',
          },
          validateStatus: () => true,
        });
      } catch (err: any) {
        const msg = err?.message || String(err);
        return {
          content: [{ type: 'text' as const, text: `Network error: ${msg}` }],
          isError: true,
        };
      }

      // 5. Handle HTTP errors
      if (response.status < 200 || response.status >= 300) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `HTTP error ${response.status}: ${response.statusText}`,
            },
          ],
          isError: true,
        };
      }

      const contentTypeHeader: string | undefined =
        response.headers['content-type'];
      const charset = getCharset(contentTypeHeader);
      const buffer = Buffer.from(response.data);
      const isBinary = isBinaryContentType(contentTypeHeader);

      // 6. Binary content
      if (isBinary) {
        const mime = contentTypeHeader?.split(';')[0].trim() ?? 'unknown';
        return {
          content: [
            {
              type: 'text' as const,
              text: `Binary content (${mime}, ${buffer.length} bytes) — not displayed`,
            },
          ],
        };
      }

      // 7. Decode body
      const decoded = decodeBody(buffer, charset);

      // 8. Raw mode or non-HTML
      const isHtml = contentTypeHeader?.toLowerCase().includes('text/html');
      if (raw || !isHtml) {
        const maxLen = max_length ?? defaultMaxLength;
        const start = start_index ?? 0;
        const slice = decoded.slice(start, start + maxLen);
        let result = slice;
        if (start + slice.length < decoded.length) {
          result += `\n\n<error>Content truncated. Call fetch again with start_index=${start + slice.length} to get more.</error>`;
        }
        return {
          content: [{ type: 'text' as const, text: result }],
        };
      }

      // 9. HTML → readability → turndown
      let markdown: string;
      try {
        const { JSDOM } = getJSDOM();
        const { Readability } = getReadability();
        const TurndownService = getTurndown();
        const { gfm } = getTurndownGfm();

        const dom = new JSDOM(decoded, { url: getFinalUrl(response) || url });
        const document = dom.window.document;
        const reader = new Readability(document);
        const article = reader.parse();

        const turndownService = new TurndownService({
          headingStyle: 'atx',
          codeBlockStyle: 'fenced',
        });
        turndownService.use(gfm);

        let html: string;
        let title: string | undefined;
        const finalUrl = getFinalUrl(response) || url;

        if (article && article.content) {
          html = article.content;
          title = article.title;
        } else {
          html = document.body?.innerHTML ?? decoded;
          title = document.title;
        }

        markdown = turndownService.turndown(html);

        if (title) {
          markdown = `# ${title}\n${finalUrl}\n\n${markdown}`;
        } else {
          markdown = `# ${finalUrl}\n\n${markdown}`;
        }
      } catch (err: any) {
        // Fallback to raw decoded text on conversion error
        markdown = decoded;
      }

      // 10. Pagination
      const maxLen = max_length ?? defaultMaxLength;
      const start = start_index ?? 0;
      const slice = markdown.slice(start, start + maxLen);
      let result = slice;
      if (start + slice.length < markdown.length) {
        result += `\n\n<error>Content truncated. Call fetch again with start_index=${start + slice.length} to get more.</error>`;
      }

      return {
        content: [{ type: 'text' as const, text: result }],
      };
    }
  );

  return server;
}
