/**
 * A streamable-HTTP MCP server on localhost for tests: `echo` (read-only),
 * `wipe` (destructive) and `panel` (returns an MCP-UI resource).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export interface MockMcp {
  url: string;
  /** Tool calls received, in order. */
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
  /** Headers of the last request (checks configured auth headers). */
  lastHeaders: http.IncomingHttpHeaders;
  close(): Promise<void>;
}

export async function startMockMcp(): Promise<MockMcp> {
  const calls: MockMcp['calls'] = [];
  let lastHeaders: http.IncomingHttpHeaders = {};

  const build = () => {
    const server = new McpServer({ name: 'mock', version: '1.0.0' });
    server.registerTool(
      'echo',
      { description: 'Echo text back', inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
      async (args) => {
        calls.push({ tool: 'echo', args });
        return { content: [{ type: 'text' as const, text: `echo: ${args.text}` }] };
      }
    );
    server.registerTool(
      'wipe',
      { description: 'Delete everything', inputSchema: {}, annotations: { title: 'Wipe data', destructiveHint: true } },
      async (args) => {
        calls.push({ tool: 'wipe', args });
        return { content: [{ type: 'text' as const, text: 'wiped' }] };
      }
    );
    server.registerTool('panel', { description: 'Show a panel', inputSchema: {} }, async (args) => {
      calls.push({ tool: 'panel', args });
      return {
        content: [{ type: 'resource' as const, resource: { uri: 'ui://mock/panel', mimeType: 'text/html', text: '<p>panel</p>' } }],
      };
    });
    return server;
  };

  const httpServer = http.createServer(async (req, res) => {
    lastHeaders = req.headers;
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : undefined;
    // Stateless: a fresh server and transport per request
    const server = build();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    get lastHeaders() {
      return lastHeaders;
    },
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      }),
  };
}
