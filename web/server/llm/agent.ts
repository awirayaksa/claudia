/**
 * Agent tasks: a turn sent with `features.agent` works in a folder of the
 * user's workspace until it is done, with budgets in steps, time and tokens
 * instead of the tool-round cap. The model keeps its plan as a checklist with
 * the todo tool; the filesystem and Office built-ins work in the workspace,
 * and server code runs see the task folder as /workspace (what they write is
 * copied back). Each task gets its own folder (tasks/<date>-<words>) unless
 * the user picks one; later tasks in the chat reuse it.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { OpenAITool } from '../../../src/types/api.types';
import type { TodoItem } from '../../../src/types/turn.types';
import { badRequest } from '../lib/errors';
import { resolveInWorkspace, relativeToWorkspace } from '../workspace/files';
import { RUN_CODE_TOOL } from '../code/sandbox';

export const TODO_TOOL_NAME = 'todo_write';
export const MAX_TODO_ITEMS = 30;
const MAX_TODO_CHARS = 300;

/** The built-ins a task always has (they work in the user's workspace). */
export const AGENT_BUILTINS = [
  'builtin-filesystem-001',
  'builtin-msoffice-001',
  'builtin-spreadsheet-001',
  'builtin-presentation-001',
  'builtin-pdf-001',
] as const;

/** Where new task folders go, inside the workspace. */
export const TASKS_DIR = 'tasks';

/** Code runs of a task: the folder is copied in up to this size. */
export const TASK_INPUT_BYTES = 100 * 1024 * 1024;

/** Code runs of a task: how many files (and bytes) come back into the folder. */
export const TASK_OUTPUT_LIMITS = { files: 200, bytes: 100 * 1024 * 1024 };

export interface AgentBudget {
  maxSteps: number;
  maxMinutes: number;
  maxTokens: number;
}

export const TODO_TOOL: OpenAITool = {
  type: 'function',
  function: {
    name: TODO_TOOL_NAME,
    description:
      'Write the plan of this task as a checklist the user sees live. Call it first with every step pending, ' +
      'then again whenever a step starts or finishes, always with the whole list. Keep exactly one step in_progress while you work. ' +
      'Add, split or drop steps as you learn more. Mark a step completed only when it is really done.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          maxItems: MAX_TODO_ITEMS,
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'The step, in a few words ("Read the receipts").' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
  },
};

/** run_code as a task sees it: /workspace is the task folder, and what is written there stays. */
export const RUN_CODE_TASK_TOOL: OpenAITool = {
  type: 'function',
  function: {
    ...RUN_CODE_TOOL.function,
    description:
      'Run code in an isolated sandbox on the server and get back what it printed (stdout and stderr) and its exit code. ' +
      'Python 3 (with the packages of the sandbox image) or Node.js. The working folder (/workspace) holds the files of the task folder, ' +
      'with their subfolders; files the code writes or changes there are saved back into the task folder and stay for later steps. ' +
      'There is no network. Each call starts a fresh process: define everything you need in the same call.',
  },
};

/** The task's instructions, after the other system prompts. */
export function agentPrompt(folder: string, codeRuns: boolean): string {
  return [
    'You are working on a task, not just answering a message. Keep going, step by step, until it is done; the user may not be watching.',
    `Your task folder is "${folder}" in the user's workspace. Read the files there, and put everything you make there, ` +
      'using paths that start with that folder (e.g. "' + folder + '/summary.xlsx"). Don\'t change or delete files outside it unless the user asks.',
    `First call ${TODO_TOOL_NAME} with a short plan (3 to 10 steps). Update it as you go, with exactly one step in_progress, and mark steps completed when done.`,
    codeRuns
      ? 'Use run_code for calculations, parsing and data work: its /workspace is the task folder, and files it writes there stay for later steps.'
      : 'Use the file tools to read and write files.',
    'Prefer doing the work over asking. Ask the user only when you cannot reasonably go on without them.',
    'When you are done, mark every step completed and end with a short summary: what you did, the files you made or changed (by path), and anything left open.',
  ].join('\n');
}

/** Check the todo tool's arguments: the new list, or what is wrong with it. */
export function parseTodos(raw: string): { items: TodoItem[] } | { error: string } {
  let args: { todos?: unknown };
  try {
    args = JSON.parse(raw || '{}');
  } catch {
    return { error: 'Invalid arguments: expected JSON with "todos".' };
  }
  if (!Array.isArray(args.todos)) return { error: 'Give the whole list as "todos": [{ "content", "status" }].' };
  if (args.todos.length > MAX_TODO_ITEMS) return { error: `Keep the plan to ${MAX_TODO_ITEMS} steps or fewer.` };
  const items: TodoItem[] = [];
  for (const t of args.todos as Array<{ content?: unknown; status?: unknown }>) {
    const content = typeof t?.content === 'string' ? t.content.trim().slice(0, MAX_TODO_CHARS) : '';
    if (!content) return { error: 'Every step needs a "content".' };
    const status = t.status === 'in_progress' || t.status === 'completed' ? t.status : 'pending';
    items.push({ content, status });
  }
  return { items };
}

/** What the model is told after updating its plan. */
export function todoResult(items: TodoItem[]): string {
  const done = items.filter((i) => i.status === 'completed').length;
  const doing = items.find((i) => i.status === 'in_progress');
  return JSON.stringify({ ok: true, progress: `${done}/${items.length} completed`, ...(doing ? { inProgress: doing.content } : {}) });
}

/** A folder name from the first words of the task: "2026-11-15-organise-these-receipts". */
export function taskFolderName(text: string, now = new Date()): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, 5)
    .join('-')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `${now.toISOString().slice(0, 10)}-${slug || 'task'}`;
}

/**
 * The task's folder, relative to the workspace: the one asked for (it must
 * exist and be a folder), else a new one under tasks/ (unique).
 */
export async function resolveTaskFolder(workspace: string, opts: { requested?: string | null; text: string; now?: Date }): Promise<string> {
  if (opts.requested) {
    const rel = opts.requested.replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+$/, '');
    if (!rel) throw badRequest('Choose a folder in your workspace, not the workspace itself.', 'invalid_task_folder');
    const abs = resolveInWorkspace(workspace, rel);
    const stat = await fs.promises.stat(abs).catch(() => null);
    if (!stat?.isDirectory()) throw badRequest(`There is no folder "${rel}" in your workspace.`, 'invalid_task_folder');
    const folder = relativeToWorkspace(workspace, abs);
    // "." or "a/.." is the workspace itself
    if (!folder) throw badRequest('Choose a folder in your workspace, not the workspace itself.', 'invalid_task_folder');
    return folder;
  }
  const base = taskFolderName(opts.text, opts.now);
  for (let i = 1; i < 1000; i++) {
    const rel = `${TASKS_DIR}/${i === 1 ? base : `${base}-${i}`}`;
    const abs = resolveInWorkspace(workspace, rel);
    try {
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.mkdir(abs);
      return rel;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw badRequest('Too many task folders with this name.', 'invalid_task_folder');
}

/** Files of the task folder for a code run (relative paths), up to `maxBytes` together. */
export async function readTaskFiles(
  folderAbs: string,
  maxBytes: number
): Promise<{ files: Array<{ name: string; data: Buffer }>; tooLarge: boolean }> {
  const files: Array<{ name: string; data: Buffer }> = [];
  let total = 0;
  const walk = async (dir: string): Promise<boolean> => {
    const dirents = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[]);
    for (const d of dirents) {
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (!(await walk(abs))) return false;
      } else if (d.isFile()) {
        const stat = await fs.promises.stat(abs).catch(() => null);
        if (!stat) continue;
        total += stat.size;
        if (total > maxBytes) return false;
        files.push({ name: path.relative(folderAbs, abs).split(path.sep).join('/'), data: await fs.promises.readFile(abs) });
      }
    }
    return true;
  };
  const complete = await walk(folderAbs);
  return { files, tooLarge: !complete };
}

/** Write what a code run made back into the task folder; returns the workspace-relative paths written. */
export async function writeTaskFiles(
  workspace: string,
  folder: string,
  files: Array<{ path: string; data: Buffer }>
): Promise<Array<{ path: string; size: number }>> {
  const out: Array<{ path: string; size: number }> = [];
  for (const f of files) {
    const rel = `${folder}/${f.path.replace(/\\/g, '/').replace(/^\/+/, '')}`;
    let abs: string;
    try {
      abs = resolveInWorkspace(workspace, rel);
    } catch {
      continue; // a path that leads outside the folder is dropped
    }
    if (!abs.startsWith(resolveInWorkspace(workspace, folder) + path.sep)) continue;
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, f.data);
    out.push({ path: relativeToWorkspace(workspace, abs), size: f.data.byteLength });
  }
  return out;
}

/** Why a task stopped early, or null while it is within its budget. */
export function overBudget(budget: AgentBudget, used: { steps: number; startedAt: number; tokens: number }, now = Date.now()): string | null {
  if (used.steps >= budget.maxSteps) return `Stopped at the task's budget of ${budget.maxSteps} steps.`;
  if (now - used.startedAt >= budget.maxMinutes * 60_000) return `Stopped at the task's time budget of ${budget.maxMinutes} minutes.`;
  if (used.tokens >= budget.maxTokens) return `Stopped at the task's budget of ${budget.maxTokens.toLocaleString('en-US')} tokens.`;
  return null;
}
