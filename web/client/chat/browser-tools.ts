/**
 * Tools the server asks this browser to run (tool.client_request). The code
 * interpreter runs Python in a hidden frame on the sandbox origin
 * (sandbox/code-runner.html), never on the app origin: the code comes from
 * the model and may have been steered by anything it read.
 */
import { useEffect } from 'react';
import { apiFetchRaw, toApiError } from '../api/http';
import { usePublicConfigQuery } from '../api/rtk-api';
import { useWebSelector } from '../hooks';

/** One Python run's own limit (the server waits up to 120 s in all). */
const RUN_TIMEOUT_MS = 90_000;

interface RunResult {
  stdout?: string;
  stderr?: string;
  result?: string | null;
  error?: string;
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

/** What the model gets back from a run. */
export function formatRun(r: RunResult): { content: string; isError: boolean } {
  const out: Record<string, string> = {};
  if (r.stdout?.trim()) out.stdout = r.stdout;
  if (r.stderr?.trim()) out.stderr = r.stderr;
  if (r.result !== undefined && r.result !== null) out.result = r.result;
  if (r.error) out.error = r.error;
  if (Object.keys(out).length === 0) out.stdout = '(no output)';
  return { content: JSON.stringify(out), isError: !!r.error };
}

/** Requests this tab has taken on (a second tab following the run may answer too; the server takes the first). */
const started = new Set<string>();

async function answer(runId: string, callId: string, result: { content: string; isError: boolean }) {
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
        let result: { content: string; isError: boolean };
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
          result = code.trim()
            ? formatRun(await runnerFor(sandbox).run(code).catch((err: Error) => ({ error: err.message })))
            : { content: JSON.stringify({ error: 'No "code" to run.' }), isError: true };
        }
        await answer(live.runId, req.callId, result).catch(() => {});
      })();
    }
  }, [live, sandbox]);
}
