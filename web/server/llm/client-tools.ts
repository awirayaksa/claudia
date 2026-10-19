/**
 * Tools that run in the user's browser: the server sends tool.client_request,
 * the page runs the tool (the code interpreter runs Python with Pyodide on
 * the sandbox origin) and posts the result to /api/runs/:id/tool-results. If
 * no browser answers in time — the tab was closed — the model gets an error
 * result and the run carries on.
 */
import type { OpenAITool } from '../../../src/types/api.types';

export const CODE_TOOL_NAME = 'run_python';

export const CODE_TOOL: OpenAITool = {
  type: 'function',
  function: {
    name: CODE_TOOL_NAME,
    description:
      "Run Python 3 code (Pyodide, in the user's browser) and get back what it printed and the value of its last expression. " +
      'Use it for calculations, data analysis and checking code. The standard library is available; numpy, pandas and other ' +
      "common packages are downloaded when first imported. There is no access to the user's files or private networks. Each call " +
      'starts fresh: define everything you need in the same call. Files the code writes in its working folder (/home/pyodide, ' +
      'the default for relative paths) are given to the user as downloads under your reply, and the result lists them; ' +
      "that folder is temporary and only in the user's browser, so never tell the user a file is saved at a sandbox path. " +
      'To give the user a file, write it with a relative path such as "report.csv".',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string', description: 'The Python code to run.' } },
      required: ['code'],
    },
  },
};

export const CLIENT_TOOL_NAMES = new Set([CODE_TOOL_NAME]);

export const NO_BROWSER_MESSAGE = 'No browser answered in time (the tab may have been closed), so the code was not run.';
