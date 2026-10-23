/**
 * Server-side code execution: every run is a fresh Docker container, without
 * network (unless an admin allows it), with memory, CPU, process and time
 * limits, as an unprivileged user with no capabilities. The chat's
 * attachments are copied into /workspace, the code runs there, and the files
 * it writes come back. Nothing is mounted from the host, so the Docker
 * daemon may be on another machine (CLAUDIA_CODE_DOCKER).
 *
 * Containers never see each other's files or the server's: everything goes
 * in and out through the Engine API's archive endpoints, and the container
 * is removed after the run.
 */
import crypto from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { AppSettings, AppSettingValue } from '../modules/settings/app-settings';
import type { OpenAITool } from '../../../src/types/api.types';
import { DockerEngine, LogDemuxer } from './docker';
import { packTar, unpackTar } from './tar';

export const RUN_CODE_TOOL_NAME = 'run_code';

export type CodeSettings = AppSettingValue<'code'>;
export type CodeLanguage = 'python' | 'node';

export const RUN_CODE_TOOL: OpenAITool = {
  type: 'function',
  function: {
    name: RUN_CODE_TOOL_NAME,
    description:
      'Run code in an isolated sandbox on the server and get back what it printed (stdout and stderr) and its exit code. ' +
      'Use it for calculations, data analysis, charts and making files. Python 3 (with the packages of the sandbox image) or Node.js. ' +
      "The files attached to this chat are in the working folder (/workspace) under their names. There is no network and no access to the user's other files. " +
      'Each call starts fresh: define everything you need in the same call. Files the code writes in /workspace are given to the user ' +
      'under your reply (charts as images: save them with matplotlib, e.g. plt.savefig("chart.png")); never tell the user a file is at a sandbox path.',
    parameters: {
      type: 'object',
      properties: {
        language: { type: 'string', enum: ['python', 'node'], description: 'python (default) or node.' },
        code: { type: 'string', description: 'The program to run.' },
      },
      required: ['code'],
    },
  },
};

/** Container user: nobody. */
const UID = 65534;
const WORKDIR = '/workspace';
const SCRIPT_DIR = '.claudia';
/** Printed output kept per stream. */
const MAX_OUTPUT_CHARS = 64 * 1024;
/** Files given back: how many, and how large. */
export const MAX_OUTPUT_FILES = 10;
const MAX_OUTPUT_FILE_BYTES = 25 * 1024 * 1024;
const MAX_INPUT_BYTES = 100 * 1024 * 1024;
const PULL_TIMEOUT_MS = 10 * 60_000;

export interface RunInput {
  language: CodeLanguage;
  code: string;
  /** Copied into /workspace before the run. */
  files: Array<{ name: string; data: Buffer }>;
  /** Printed output as it comes. */
  onOutput?: (stream: 'stdout' | 'stderr', text: string) => void;
  signal?: AbortSignal;
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Stopped at the time limit. */
  timedOut: boolean;
  /** Killed for going over the memory limit. */
  oomKilled: boolean;
  /** Stopped by the user. */
  stopped: boolean;
  /** New or changed files in /workspace. */
  files: Array<{ path: string; data: Buffer }>;
  /** More files (or larger ones) were written than are given back. */
  skippedFiles: number;
}

/** A safe file name in the workspace: the base name, no odd characters, unique. */
export function workspaceNames(names: string[]): string[] {
  const used = new Set<string>([SCRIPT_DIR]);
  return names.map((n) => {
    const base =
      (n.split(/[\\/]/).pop() ?? '')
        .replace(/[^\w.\- ()+,@]/g, '_')
        .replace(/^\.+/, '')
        .slice(0, 120) || 'file';
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i++) {
      const dot = base.lastIndexOf('.');
      name = dot > 0 ? `${base.slice(0, dot)} (${i})${base.slice(dot)}` : `${base} (${i})`;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

function imageRef(image: string): { fromImage: string; tag: string } {
  const at = image.lastIndexOf('@');
  if (at > 0) return { fromImage: image.slice(0, at), tag: image.slice(at + 1) };
  const colon = image.lastIndexOf(':');
  return colon > image.lastIndexOf('/') ? { fromImage: image.slice(0, colon), tag: image.slice(colon + 1) } : { fromImage: image, tag: 'latest' };
}

export class CodeSandbox {
  private readonly docker: DockerEngine | null;

  constructor(
    private readonly deps: {
      /** CLAUDIA_CODE_DOCKER; null: no server sandbox. */
      endpoint: string | null;
      settings: AppSettings;
      log: FastifyBaseLogger;
    }
  ) {
    this.docker = deps.endpoint ? new DockerEngine(deps.endpoint) : null;
  }

  /** A Docker daemon is configured. */
  get configured(): boolean {
    return !!this.docker;
  }

  /** Whether chats can run code on the server now. */
  async available(): Promise<boolean> {
    return this.configured && (await this.deps.settings.get('code')).engine === 'server';
  }

  /** For the admin page: can the daemon be reached, and are the images there (pulled if not)? */
  async test(): Promise<{ ok: boolean; error: string | null; version: string | null }> {
    if (!this.docker) return { ok: false, error: 'No Docker daemon is configured (CLAUDIA_CODE_DOCKER).', version: null };
    try {
      const res = await this.docker.request('GET', '/version', { timeoutMs: 10_000 });
      if (res.status !== 200) throw new Error(`Docker answered ${res.status}.`);
      const version = (JSON.parse(res.body.toString('utf-8')) as { Version?: string }).Version ?? null;
      const settings = await this.deps.settings.get('code');
      for (const image of [settings.pythonImage, settings.nodeImage]) await this.ensureImage(image);
      const probe = await this.run({ language: 'python', code: 'print(6 * 7)', files: [] });
      if (probe.stdout.trim() !== '42') throw new Error(`A test run printed ${JSON.stringify(probe.stdout || probe.stderr).slice(0, 300)}.`);
      return { ok: true, error: null, version };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), version: null };
    }
  }

  private async ensureImage(image: string): Promise<void> {
    const docker = this.docker!;
    const found = await docker.request('GET', `/images/${encodeURIComponent(image)}/json`, { timeoutMs: 30_000 });
    if (found.status === 200) return;
    const { fromImage, tag } = imageRef(image);
    let error: string | null = null;
    let rest = '';
    const status = await docker.stream(
      'POST',
      `/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(tag)}`,
      (chunk) => {
        rest += chunk.toString('utf-8');
        const lines = rest.split('\n');
        rest = lines.pop() ?? '';
        for (const line of lines) {
          try {
            const msg = JSON.parse(line) as { error?: string };
            if (msg.error) error = msg.error;
          } catch {
            /* progress */
          }
        }
      },
      { timeoutMs: PULL_TIMEOUT_MS }
    );
    if (status >= 400 || error) throw new Error(`The image ${image} could not be pulled: ${error ?? `Docker answered ${status}`}.`);
  }

  async run(input: RunInput): Promise<RunResult> {
    const docker = this.docker;
    if (!docker) throw new Error('Server-side code execution is not set up.');
    const settings = await this.deps.settings.get('code');
    const image = input.language === 'node' ? settings.nodeImage : settings.pythonImage;
    const script = input.language === 'node' ? 'main.mjs' : 'main.py';

    const names = workspaceNames(input.files.map((f) => f.name));
    const inputs = new Map(input.files.map((f, i) => [names[i], sha(f.data)]));
    const total = input.files.reduce((n, f) => n + f.data.byteLength, 0);
    if (total > MAX_INPUT_BYTES) throw new Error(`The attachments are larger than ${MAX_INPUT_BYTES / (1024 * 1024)} MB together.`);
    const archive = packTar(
      [
        { path: 'workspace/' },
        { path: `workspace/${SCRIPT_DIR}/` },
        { path: `workspace/${SCRIPT_DIR}/${script}`, data: Buffer.from(input.code, 'utf-8') },
        ...input.files.map((f, i) => ({ path: `workspace/${names[i]}`, data: f.data })),
      ],
      { uid: UID, gid: UID }
    );

    const body = {
      Image: image,
      Cmd: input.language === 'node' ? ['node', `${WORKDIR}/${SCRIPT_DIR}/${script}`] : ['python', '-u', `${WORKDIR}/${SCRIPT_DIR}/${script}`],
      WorkingDir: WORKDIR,
      User: `${UID}:${UID}`,
      Env: ['HOME=/tmp', 'MPLBACKEND=Agg', 'PYTHONDONTWRITEBYTECODE=1', 'MPLCONFIGDIR=/tmp'],
      Tty: false,
      OpenStdin: false,
      NetworkDisabled: !settings.network,
      Labels: { 'claudia.code-run': '1' },
      HostConfig: {
        NetworkMode: settings.network ? 'bridge' : 'none',
        Memory: settings.memoryMb * 1024 * 1024,
        MemorySwap: settings.memoryMb * 1024 * 1024,
        NanoCpus: Math.round(settings.cpus * 1e9),
        PidsLimit: 256,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=256m' },
        Ulimits: [{ Name: 'nofile', Soft: 1024, Hard: 1024 }],
        ...(settings.runtime ? { Runtime: settings.runtime } : {}),
      },
    };
    let created = await docker.request('POST', '/containers/create', { json: body, timeoutMs: 60_000 });
    if (created.status === 404) {
      await this.ensureImage(image);
      created = await docker.request('POST', '/containers/create', { json: body, timeoutMs: 60_000 });
    }
    if (created.status !== 201) throw new Error(`The sandbox could not be created: ${created.body.toString('utf-8').slice(0, 300)}`);
    const id = (JSON.parse(created.body.toString('utf-8')) as { Id: string }).Id;

    const out = { stdout: '', stderr: '' };
    let timedOut = false;
    let stopped = false;
    try {
      const put = await docker.request('PUT', `/containers/${id}/archive?path=/`, { body: archive, timeoutMs: 120_000 });
      if (put.status !== 200) throw new Error(`The files could not be copied into the sandbox: ${put.body.toString('utf-8').slice(0, 300)}`);
      const started = await docker.request('POST', `/containers/${id}/start`, { timeoutMs: 60_000 });
      if (started.status !== 204 && started.status !== 304) throw new Error(`The sandbox did not start: ${started.body.toString('utf-8').slice(0, 300)}`);

      // Kept and streamed up to the limit (a program printing forever doesn't fill the run's events)
      let streamed = 0;
      const demux = new LogDemuxer((stream, text) => {
        if (out[stream].length < MAX_OUTPUT_CHARS) out[stream] += text;
        if (streamed < MAX_OUTPUT_CHARS * 2) {
          streamed += text.length;
          input.onOutput?.(stream, text);
        }
      });
      const logs = docker.stream('GET', `/containers/${id}/logs?follow=1&stdout=1&stderr=1`, (c) => demux.push(c)).catch(() => 0);

      const kill = async () => {
        await docker.request('POST', `/containers/${id}/kill`, { timeoutMs: 10_000 }).catch(() => undefined);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        void kill();
      }, settings.timeoutSeconds * 1000);
      timer.unref?.();
      const onAbort = () => {
        stopped = true;
        void kill();
      };
      input.signal?.addEventListener('abort', onAbort, { once: true });
      let exitCode: number | null = null;
      try {
        // The kill at the time limit ends the wait; the cap is for a daemon that stops answering
        const waited = await docker.request('POST', `/containers/${id}/wait`, { timeoutMs: (settings.timeoutSeconds + 120) * 1000 });
        exitCode = (JSON.parse(waited.body.toString('utf-8') || '{}') as { StatusCode?: number }).StatusCode ?? null;
      } finally {
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', onAbort);
      }
      // The log stream ends with the container; don't hang on a daemon that keeps it open
      await Promise.race([logs, new Promise((r) => setTimeout(r, 10_000).unref?.())]);

      const inspect = await docker.request('GET', `/containers/${id}/json`, { timeoutMs: 10_000 });
      const oomKilled = inspect.status === 200 && !!(JSON.parse(inspect.body.toString('utf-8')) as { State?: { OOMKilled?: boolean } }).State?.OOMKilled;

      // What the code wrote: new or changed files outside the script folder
      const files: RunResult['files'] = [];
      let skippedFiles = 0;
      const tar = await docker.request('GET', `/containers/${id}/archive?path=${WORKDIR}`, { timeoutMs: 120_000 });
      if (tar.status === 200) {
        for (const f of unpackTar(tar.body)) {
          const path = f.path.replace(/^workspace\//, '');
          if (!path || path === 'workspace' || path.startsWith(`${SCRIPT_DIR}/`)) continue;
          if (inputs.get(path) === sha(f.data)) continue;
          if (files.length >= MAX_OUTPUT_FILES || f.data.byteLength > MAX_OUTPUT_FILE_BYTES) {
            skippedFiles++;
            continue;
          }
          files.push({ path, data: f.data });
        }
      }
      return { exitCode, stdout: out.stdout, stderr: out.stderr, timedOut, oomKilled, stopped, files, skippedFiles };
    } finally {
      await docker.request('DELETE', `/containers/${id}?force=1&v=1`, { timeoutMs: 30_000 }).catch((err) => {
        this.deps.log.warn({ err: String(err), container: id }, 'removing a code sandbox failed');
      });
    }
  }
}

/** Where code runs now: the admin's choice, if what it needs is there (a sandbox origin, a Docker daemon). */
export async function activeCodeEngine(
  settings: AppSettings,
  sandboxOrigin: string | null | undefined,
  sandbox: CodeSandbox | undefined
): Promise<'browser' | 'server' | null> {
  const { engine } = await settings.get('code');
  if (engine === 'browser') return sandboxOrigin ? 'browser' : null;
  if (engine === 'server') return sandbox?.configured ? 'server' : null;
  return null;
}

/** What the model is told about a run. */
export function runSummary(r: RunResult, files: string[]): string {
  const clip = (s: string) => (s.length >= MAX_OUTPUT_CHARS ? `${s}\n[…output cut at ${MAX_OUTPUT_CHARS / 1024} kB]` : s);
  return JSON.stringify({
    exitCode: r.exitCode,
    ...(r.stdout ? { stdout: clip(r.stdout) } : {}),
    ...(r.stderr ? { stderr: clip(r.stderr) } : {}),
    ...(r.timedOut ? { error: 'Stopped: the run went over its time limit.' } : {}),
    ...(r.oomKilled ? { error: 'Stopped: the run went over its memory limit.' } : {}),
    ...(r.stopped ? { error: 'Stopped by the user.' } : {}),
    ...(files.length ? { files, note: 'These files were given to the user under your reply.' } : {}),
    ...(r.skippedFiles ? { skippedFiles: r.skippedFiles } : {}),
  });
}
