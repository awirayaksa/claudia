/**
 * Server-side code runs. The tar and log-stream helpers are tested here
 * always; the runs themselves need a Docker daemon: set CLAUDIA_TEST_DOCKER
 * (e.g. unix:///var/run/docker.sock) to run them against a real one.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { chatFixture, type ChatFixture } from '../test/chat-fixture';
import { LogDemuxer, logFrame } from './docker';
import { packTar, unpackTar } from './tar';
import { workspaceNames } from './sandbox';
import { startMockDocker, type MockDocker } from '../test/mock-docker';

const DOCKER = process.env.CLAUDIA_TEST_DOCKER;

describe('tar', () => {
  it('round-trips files and folders, with long paths', () => {
    const long = `${'deep/'.repeat(28)}file.txt`; // over 100 characters: split into prefix and name
    const tar = packTar(
      [
        { path: 'workspace/' },
        { path: 'workspace/a.txt', data: Buffer.from('hello') },
        { path: `workspace/${long}`, data: Buffer.alloc(1500, 1) },
      ],
      { uid: 65534, gid: 65534 }
    );
    expect(tar.length % 512).toBe(0);
    const files = unpackTar(tar);
    expect(files.map((f) => f.path)).toEqual(['workspace/a.txt', `workspace/${long}`]);
    expect(files[0].data.toString()).toBe('hello');
    expect(files[1].data.length).toBe(1500);
  });

  it('reads PAX long names', () => {
    const name = `${'x'.repeat(150)}.txt`;
    const record = (k: string, v: string) => {
      let len = k.length + v.length + 3;
      len += String(len).length;
      if (String(len).length !== String(len - String(len).length).length) len++;
      return `${len} ${k}=${v}\n`;
    };
    const pax = Buffer.from(record('path', name));
    // A PAX header ('x') before the file, as Docker writes for long names
    const header = (n: string, size: number, type: string) => {
      const h = Buffer.alloc(512);
      h.write(n, 0);
      h.write(size.toString(8).padStart(11, '0') + '\0', 124);
      h.write(type, 156);
      h.write('ustar\0', 257);
      return h;
    };
    const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
    const tar = Buffer.concat([header('PaxHeader', pax.length, 'x'), pad(pax), header('short', 3, '0'), pad(Buffer.from('abc')), Buffer.alloc(1024)]);
    expect(unpackTar(tar)).toEqual([{ path: name, data: Buffer.from('abc') }]);
  });

  it('splits a log stream into stdout and stderr, across chunks', () => {
    const seen: string[] = [];
    const d = new LogDemuxer((s, t) => seen.push(`${s}:${t}`));
    const all = Buffer.concat([logFrame('stdout', 'one\n'), logFrame('stderr', 'oops\n'), logFrame('stdout', 'two\n')]);
    d.push(all.subarray(0, 5));
    d.push(all.subarray(5, 17));
    d.push(all.subarray(17));
    expect(seen).toEqual(['stdout:one\n', 'stderr:oops\n', 'stdout:two\n']);
  });

  it('gives attachments safe, unique names', () => {
    expect(workspaceNames(['data.csv', '../../etc/passwd', 'data.csv', '.claudia', 'a b?.txt'])).toEqual([
      'data.csv',
      'passwd',
      'data (2).csv',
      'claudia',
      'a b_.txt',
    ]);
  });
});

describe.skipIf(!DOCKER)('code runs in Docker', () => {
  let f: ChatFixture | undefined;
  afterEach(async () => {
    await f?.close();
    f = undefined;
  });

  async function setup(extra: Record<string, unknown> = {}) {
    f = await chatFixture({ env: { CLAUDIA_CODE_DOCKER: DOCKER! } });
    const res = await f.admin.patch('/api/admin/settings/code', {
      engine: 'server',
      pythonImage: 'python:3.12-slim',
      nodeImage: 'node:22-slim',
      memoryMb: 256,
      cpus: 1,
      timeoutSeconds: 20,
      network: false,
      runtime: null,
      ...extra,
    });
    expect(res.statusCode, res.body).toBe(200);
    return f;
  }

  async function runCode(fx: ChatFixture, code: string, opts: { language?: string; fileIds?: string[] } = {}) {
    fx.mock.push({ toolCalls: [{ id: 'call_1', name: 'run_code', arguments: JSON.stringify({ code, ...(opts.language ? { language: opts.language } : {}) }) }] }, { text: ['Done.'] });
    const chat = (await fx.admin.post('/api/chats', {})).json().chat.id;
    const res = await fx.admin.post(`/api/chats/${chat}/completions`, {
      parentId: null,
      content: 'Run it',
      modelIds: ['mock/gpt-test'],
      features: { code: true },
      fileIds: opts.fileIds ?? [],
    });
    expect(res.statusCode, res.body).toBe(202);
    const events = await fx.readRun(fx.admin, res.json().runId);
    const result = (events.find((e) => e.event.type === 'tool.result')!.event as any).part;
    return { events, result, output: JSON.parse(result.content) };
  }

  it('analyses an attached CSV, streams its output and returns the chart it draws', { timeout: 180_000 }, async () => {
    const fx = await setup();
    expect((await fx.admin.post('/api/admin/code/test')).json()).toMatchObject({ ok: true });
    expect((await fx.admin.get('/api/auth/session')).json().features.codeInterpreter).toBe(true);
    const csv = (await fx.admin.upload('sales.csv', 'month,revenue\nJan,100\nFeb,250\nMar,175\n', 'text/csv')).json().file.id;

    const { events, result, output } = await runCode(
      fx,
      [
        'import csv, struct, zlib',
        "rows = list(csv.DictReader(open('sales.csv')))",
        "total = sum(int(r['revenue']) for r in rows)",
        "print('total', total, flush=True)",
        "best = max(rows, key=lambda r: int(r['revenue']))['month']",
        "print('best', best)",
        // A tiny PNG without matplotlib (not in the slim image)
        'def png(w, h):',
        "    raw = b''.join(b'\\x00' + b'\\xff\\x00\\x00' * w for _ in range(h))",
        "    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d))",
        "    return b'\\x89PNG\\r\\n\\x1a\\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')",
        "open('chart.png', 'wb').write(png(4, 3))",
      ].join('\n'),
      { fileIds: [csv] }
    );
    expect(result.isError).toBeFalsy();
    expect(output).toMatchObject({ exitCode: 0, stdout: 'total 525\nbest Feb\n', files: ['chart.png'] });
    // Output came as it was printed, before the result
    const streamed = events.filter((e) => e.event.type === 'tool.output').map((e) => (e.event as any).text).join('');
    expect(streamed).toContain('total 525');
    // The chart is the user's file, shown under the reply (the unchanged CSV isn't)
    const parts = events.filter((e) => e.event.type === 'message.part').map((e) => (e.event as any).part);
    expect(parts).toEqual([expect.objectContaining({ type: 'file', name: 'chart.png', mime: 'image/png' })]);
  });

  it('has no network, cannot see the host, and stops at the limits', { timeout: 180_000 }, async () => {
    const fx = await setup({ timeoutSeconds: 5, memoryMb: 128 });

    const net = await runCode(fx, "import socket\ntry:\n  socket.create_connection(('1.1.1.1', 53), 3)\n  print('online')\nexcept OSError as e:\n  print('offline')");
    expect(net.output.stdout.trim()).toBe('offline');

    const who = await runCode(fx, "import os\nprint(os.getuid(), sorted(os.listdir('/workspace')), os.path.exists('/var/run/docker.sock'))");
    expect(who.output.stdout.trim()).toBe("65534 ['.claudia'] False");

    const slow = await runCode(fx, 'import time\nprint("start", flush=True)\ntime.sleep(60)');
    expect(slow.result.isError).toBe(true);
    expect(slow.output.error).toMatch(/time limit/);
    expect(slow.output.stdout).toContain('start');

    const hungry = await runCode(fx, "x = bytearray(512 * 1024 * 1024)\nprint('allocated')");
    expect(hungry.result.isError).toBe(true);
    expect(hungry.output.stdout ?? '').not.toContain('allocated');

    const node = await runCode(fx, 'console.log([1, 2, 3].map((n) => n * 2).join(","))', { language: 'node' });
    expect(node.output).toMatchObject({ exitCode: 0, stdout: '2,4,6\n' });
  });
});

describe('code runs (Engine API)', () => {
  let f: ChatFixture | undefined;
  let docker: MockDocker | undefined;
  afterEach(async () => {
    await f?.close();
    await docker?.close();
    f = undefined;
    docker = undefined;
  });

  const settings = { engine: 'server', pythonImage: 'python:3.12-slim', nodeImage: 'node:22-slim', memoryMb: 256, cpus: 0.5, timeoutSeconds: 5, network: false, runtime: null };

  async function start(code: string, fx: ChatFixture, fileIds: string[] = []) {
    fx.mock.push({ toolCalls: [{ id: 'call_1', name: 'run_code', arguments: JSON.stringify({ code }) }] }, { text: ['Done.'] });
    const chat = (await fx.admin.post('/api/chats', {})).json().chat.id;
    const res = await fx.admin.post(`/api/chats/${chat}/completions`, { parentId: null, content: 'Run', modelIds: ['mock/gpt-test'], features: { code: true }, fileIds });
    expect(res.statusCode, res.body).toBe(202);
    const events = await fx.readRun(fx.admin, res.json().runId);
    return { events, result: (events.find((e) => e.event.type === 'tool.result')!.event as any).part };
  }

  it('runs in a locked-down container with the attachments, and returns output and files', async () => {
    docker = await startMockDocker();
    f = await chatFixture({ env: { CLAUDIA_CODE_DOCKER: docker.endpoint } });
    await f.admin.patch('/api/admin/settings/code', settings);
    const csv = (await f.admin.upload('sales.csv', 'a,b\n1,2\n', 'text/csv')).json().file.id;
    docker.push({ stdout: ['rows: 1\n'], stderr: ['warning\n'], writes: { 'out/summary.txt': 'done' } });

    const { events, result } = await start("print('rows: 1')", f, [csv]);
    const [body] = docker.created;
    expect(body).toMatchObject({
      Image: 'python:3.12-slim',
      User: '65534:65534',
      WorkingDir: '/workspace',
      NetworkDisabled: true,
      HostConfig: { NetworkMode: 'none', Memory: 256 * 1024 * 1024, NanoCpus: 5e8, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], PidsLimit: 256 },
    });
    expect(body.HostConfig.Binds).toBeUndefined();
    // The attachment and the program went in through the archive API
    expect(docker.uploads[0].map((x) => x.path)).toEqual(['workspace/.claudia/main.py', 'workspace/sales.csv']);
    expect(docker.uploads[0][0].data.toString()).toBe("print('rows: 1')");

    expect(JSON.parse(result.content)).toMatchObject({ exitCode: 0, stdout: 'rows: 1\n', stderr: 'warning\n', files: ['out/summary.txt'] });
    expect(events.some((e) => e.event.type === 'tool.output')).toBe(true);
    const part = events.find((e) => e.event.type === 'message.part')!.event as any;
    expect(part.part).toMatchObject({ type: 'file', name: 'out/summary.txt' });
    expect(docker.removed).toEqual(['c1']);
  });

  it('kills a run at the time limit, and refuses when the sandbox is not set up', async () => {
    docker = await startMockDocker();
    f = await chatFixture({ env: { CLAUDIA_CODE_DOCKER: docker.endpoint } });
    await f.admin.patch('/api/admin/settings/code', settings);
    docker.push({ stdout: ['working\n'], hang: true });
    const { result } = await start('while True: pass', f);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content)).toMatchObject({ exitCode: 137, error: expect.stringMatching(/time limit/) });
    expect(docker.killed).toEqual(['c1']);
    expect(docker.removed).toEqual(['c1']);

    // Off: no code interpreter at all
    await f.admin.patch('/api/admin/settings/code', { ...settings, engine: 'off' });
    expect((await f.admin.get('/api/auth/session')).json().features.codeInterpreter).toBe(false);
    const chat = (await f.admin.post('/api/chats', {})).json().chat.id;
    const off = await f.admin.post(`/api/chats/${chat}/completions`, { parentId: null, content: 'x', modelIds: ['mock/gpt-test'], features: { code: true } });
    expect(off.json().error.code).toBe('code_unavailable');
  });

  it('is unavailable without a Docker daemon', async () => {
    f = await chatFixture();
    await f.admin.patch('/api/admin/settings/code', settings);
    expect((await f.admin.get('/api/admin/code')).json()).toEqual({ dockerConfigured: false });
    expect((await f.admin.post('/api/admin/code/test')).json()).toMatchObject({ ok: false });
    const chat = (await f.admin.post('/api/chats', {})).json().chat.id;
    const res = await f.admin.post(`/api/chats/${chat}/completions`, { parentId: null, content: 'x', modelIds: ['mock/gpt-test'], features: { code: true } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/CLAUDIA_CODE_DOCKER/);
  });
});
