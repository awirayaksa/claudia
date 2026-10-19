/**
 * Tools the server asks this browser to run (tool.client_request). The code
 * interpreter runs Python in a hidden frame on the sandbox origin
 * (sandbox/code-runner.html), never on the app origin: the code comes from
 * the model and may have been steered by anything it read. Files the code
 * writes are uploaded as the user's files and shown under the reply.
 */
import { useEffect } from 'react';
import { apiFetchRaw, toApiError } from '../api/http';
import { usePublicConfigQuery } from '../api/rtk-api';
import { useWebSelector } from '../hooks';

/** One Python run's own limit (the server waits up to 120 s in all). */
const RUN_TIMEOUT_MS = 90_000;

/** A file the run wrote under /home/pyodide (path relative to it). */
interface RunFile {
  path: string;
  name: string;
  data: Uint8Array;
}

interface RunResult {
  stdout?: string;
  stderr?: string;
  result?: string | null;
  error?: string;
  files?: RunFile[];
  skipped?: Array<{ path: string; reason: string }>;
}

/** What became of the run's files: uploaded (with their ids) or not. */
export interface SavedFiles {
  saved: Array<{ path: string; id: string }>;
  notSaved: Array<{ path: string; reason: string }>;
}

const MIME_BY_EXT: Record<string, string> = {
  csv: 'text/csv',
  json: 'application/json',
  md: 'text/markdown',
  txt: 'text/plain',
  py: 'text/x-python',
  html: 'text/html',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
};

const mimeOf = (name: string) => MIME_BY_EXT[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

/**
 * Keep the run's files as the user's files. Unlike attachments, a file the
 * server can't extract text from is still kept: it is there to download.
 */
export async function saveRunFiles(r: RunResult): Promise<SavedFiles> {
  const out: SavedFiles = { saved: [], notSaved: [...(r.skipped ?? [])] };
  for (const f of r.files ?? []) {
    try {
      const form = new FormData();
      form.append('file', new Blob([f.data as BlobPart], { type: mimeOf(f.name) }), f.name);
      const res = await apiFetchRaw('/api/files', { method: 'POST', body: form });
      if (res.status !== 201) throw await toApiError(res);
      const { file } = (await res.json()) as { file: { id: string } };
      out.saved.push({ path: f.path, id: file.id });
    } catch (err) {
      out.notSaved.push({ path: f.path, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

class CodeRunner {
  private frame: HTMLIFrameElement | null = null;
  private ready: Promise<void> | null = null;
  private waiting = new Map<string, (r: RunResult) => void>();
  private seq = 0;

  constructor(private readonly origin: string) {
    window.addEventListener('message', (e) => {
      if (e.origin !== this.origin || e.source !== this.frame?.contentWindow) return;
      const m = e.data;
      if (m?.type === 'claudia-code-result' && typeof m.id === 'string') {
        this.waiting.get(m.id)?.(m);
        this.waiting.delete(m.id);
      }
    });
  }

  private load(): Promise<void> {
    this.ready ??= new Promise<void>((resolve, reject) => {
      const frame = document.createElement('iframe');
      // Its own (sandbox) origin, so it can start a worker and load Pyodide from there
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      frame.setAttribute('aria-hidden', 'true');
      frame.tabIndex = -1;
      frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
      const timer = setTimeout(() => {
        this.ready = null;
        frame.remove();
        reject(new Error('The code runner did not start.'));
      }, 20_000);
      const onReady = (e: MessageEvent) => {
        if (e.origin === this.origin && e.source === frame.contentWindow && e.data?.type === 'claudia-code-ready') {
          clearTimeout(timer);
          window.removeEventListener('message', onReady);
          resolve();
        }
      };
      window.addEventListener('message', onReady);
      frame.src = `${this.origin}/code-runner.html`;
      document.body.appendChild(frame);
      this.frame = frame;
    });
    return this.ready;
  }

  async run(code: string): Promise<RunResult> {
    await this.load();
    const id = `run-${Date.now()}-${this.seq++}`;
    return new Promise<RunResult>((resolve) => {
      this.waiting.set(id, resolve);
      this.frame!.contentWindow!.postMessage({ type: 'claudia-code-run', id, code, timeoutMs: RUN_TIMEOUT_MS }, this.origin);
    });
  }
}

let runner: CodeRunner | null = null;
const runnerFor = (origin: string) => (runner ??= new CodeRunner(origin));

/** What the model gets back from a run (and the ids of the files to show the user). */
export function formatRun(r: RunResult, files?: SavedFiles): { content: string; isError: boolean; fileIds?: string[] } {
  const out: Record<string, unknown> = {};
  if (r.stdout?.trim()) out.stdout = r.stdout;
  if (r.stderr?.trim()) out.stderr = r.stderr;
  if (r.result !== undefined && r.result !== null) out.result = r.result;
  if (r.error) out.error = r.error;
  if (files?.saved.length) {
    out.files_shared_with_user = files.saved.map((f) => f.path);
    out.note = 'These files are shown to the user as downloads under your reply. Refer to them by name, not by a sandbox path.';
  }
  if (files?.notSaved.length) out.files_not_shared = files.notSaved;
  if (Object.keys(out).length === 0) out.stdout = '(no output)';
  return {
    content: JSON.stringify(out),
    isError: !!r.error,
    ...(files?.saved.length ? { fileIds: files.saved.map((f) => f.id) } : {}),
  };
}

/** Requests this tab has taken on (a second tab following the run may answer too; the server takes the first). */
const started = new Set<string>();

async function answer(runId: string, callId: string, result: { content: string; isError: boolean; fileIds?: string[] }) {
  const res = await apiFetchRaw(`/api/runs/${runId}/tool-results`, { method: 'POST', json: { callId, ...result } });
  // 404: already answered elsewhere, or timed out
  if (!res.ok && res.status !== 404) throw await toApiError(res);
}

/** Run the browser tools the chat's live run asks for. */
export function useBrowserTools(chatId: string | undefined) {
  const live = useWebSelector((s) => (chatId ? s.runs[chatId] : undefined));
  const { data: config } = usePublicConfigQuery();
  const sandbox = config?.sandboxOrigin ?? null;

  useEffect(() => {
    if (!live || live.done) return;
    for (const req of live.clientRequests) {
      const key = `${live.runId}:${req.callId}`;
      if (started.has(key)) continue;
      started.add(key);
      void (async () => {
        let result: { content: string; isError: boolean; fileIds?: string[] };
        if (req.name !== 'run_python') {
          result = { content: JSON.stringify({ error: `This browser can't run "${req.name}".` }), isError: true };
        } else if (!sandbox) {
          result = { content: JSON.stringify({ error: 'The code interpreter needs a sandbox origin.' }), isError: true };
        } else {
          let code = '';
          try {
            code = String(JSON.parse(req.args || '{}').code ?? '');
          } catch {
            /* reported below */
          }
          if (code.trim()) {
            const run: RunResult = await runnerFor(sandbox)
              .run(code)
              .catch((err: Error) => ({ error: err.message }));
            result = formatRun(run, run.files?.length || run.skipped?.length ? await saveRunFiles(run) : undefined);
          } else {
            result = { content: JSON.stringify({ error: 'No "code" to run.' }), isError: true };
          }
        }
        await answer(live.runId, req.callId, result).catch(() => {});
      })();
    }
  }, [live, sandbox]);
}
