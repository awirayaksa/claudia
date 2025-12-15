#!/usr/bin/env node
import express, { Request, Response } from 'express';
import cors from 'cors';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { getCounterUI, getFormUI, getFormConfirmationUI } from './ui-templates.js';

// Server state with type
interface ServerState {
  counter: number;
}

const state: ServerState = {
  counter: 0,
};

// Create MCP server
const server = new Server(
  {
    name: 'mcp-ui-test-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'show_counter',
        description: 'Display an interactive counter with increment/decrement buttons',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'counter_action',
        description: 'Handle counter button actions (increment, decrement, reset)',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['increment', 'decrement', 'reset'],
              description: 'The action to perform on the counter',
            },
          },
          required: ['action'],
        },
      },
      {
        name: 'show_form',
        description: 'Display an interactive contact form',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'form_submit',
        description: 'Handle form submission',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            email: { type: 'string' },
            message: { type: 'string' },
          },
          required: ['name', 'email', 'message'],
        },
      },
    ],
  };
});

// Tool argument types
interface CounterActionArgs {
  action: 'increment' | 'decrement' | 'reset';
}

interface FormSubmitArgs {
  name: string;
  email: string;
  message: string;
}

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'show_counter':
      return {
        content: [
          {
            type: 'text',
            text: `Counter initialized at ${state.counter}`,
          },
          getCounterUI(state.counter),
        ],
      };

    case 'counter_action': {
      const { action } = args as unknown as CounterActionArgs;

      if (action === 'increment') {
        state.counter++;
      } else if (action === 'decrement') {
        state.counter--;
      } else if (action === 'reset') {
        state.counter = 0;
      }

      return {
        content: [
          {
            type: 'text',
            text: `Counter ${action}ed. New value: ${state.counter}`,
          },
          getCounterUI(state.counter),
        ],
      };
    }

    case 'show_form':
      return {
        content: [
          {
            type: 'text',
            text: 'Contact form displayed',
          },
          getFormUI(),
        ],
      };

    case 'form_submit': {
      const { name: userName, email, message } = args as unknown as FormSubmitArgs;

      console.error('[Form Submission]', { userName, email, message });

      return {
        content: [
          {
            type: 'text',
            text: `Form submitted by ${userName} (${email})`,
          },
          getFormConfirmationUI(userName),
        ],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// Start HTTP server with streamable transport
const PORT = process.env.PORT || 3000;
const app = express();

app.use(cors());
app.use(express.json());

// Create transport (stateless for simplicity)
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined, // stateless server
});

// Setup server connection
const setupServer = async (): Promise<void> => {
  await server.connect(transport);
  console.error('MCP server connected to StreamableHTTP transport');
};

// Main MCP endpoint - POST handles all MCP requests
app.post('/mcp', async (req: Request, res: Response) => {
  try {
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('Error handling MCP request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : 'Internal server error',
        },
        id: req.body?.id || null,
      });
    }
  }
});

// GET/DELETE not supported for stateless transport
app.get('/mcp', (req: Request, res: Response) => {
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed. Use POST.' },
      id: null,
    })
  );
});

app.delete('/mcp', (req: Request, res: Response) => {
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    })
  );
});

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', server: 'mcp-ui-test-server', version: '1.0.0' });
});

// Initialize and start server
setupServer()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`MCP UI Test Server running on http://localhost:${PORT}`);
      console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
      console.log(`Health check: http://localhost:${PORT}/health`);
    });
  })
  .catch((error) => {
    console.error('Failed to set up server:', error);
    process.exit(1);
  });
