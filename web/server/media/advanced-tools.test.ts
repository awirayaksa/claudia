/**
 * Phase 5 tools: the code interpreter's browser round trip (and the timeout
 * when no tab answers), image generation with each engine, and voice
 * through the server.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, afterEach } from 'vitest';
import { chatFixture, types, type ChatFixture } from '../test/chat-fixture';
import { NO_BROWSER_MESSAGE } from '../llm/client-tools';
import { generateImage } from './images';
import { DEFAULT_PERMISSIONS } from '../../shared/access';
import { MEDIA_DEFAULTS } from './config';

const SANDBOX = { CLAUDIA_PUBLIC_URL: 'http://app.example.test', CLAUDIA_SANDBOX_ORIGIN: 'http://sandbox.example.test' };

let f: ChatFixture | undefined;
let server: http.Server | undefined;
afterEach(async () => {
  await f?.close();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  f = undefined;
  server = undefined;
});

async function start(fx: ChatFixture, body: Record<string, unknown>) {
  const chat = (await fx.admin.post('/api/chats', {})).json().chat.id;
  const res = await fx.admin.post(`/api/chats/${chat}/completions`, { parentId: null, content: 'Compute', modelIds: ['mock/gpt-test'], ...body });
  return { chat, res };
}

describe('code interpreter (tools that run in the browser)', () => {
  it('asks the browser to run the code and gives the model its answer', async () => {
    f = await chatFixture({ env: SANDBOX });
    f.mock.push({ toolCalls: [{ id: 'call_py', name: 'run_python', arguments: '{"code":"print(6*7)"}' }] }, { text: ['It is 42.'] });
    const { chat, res } = await start(f, { features: { code: true } });
    expect(res.statusCode, res.body).toBe(202);
    const runId = res.json().runId;

    // The browser sees the request…
    const seen = await f.readRun(f.admin, runId, 0, (e) => e.event.type === 'tool.client_request');
    const request = seen.at(-1)!.event as any;
    expect(request).toMatchObject({ type: 'tool.client_request', runId, callId: 'call_py', name: 'run_python', args: '{"code":"print(6*7)"}' });
    expect(f.mock.requests[0].tools.map((t: any) => t.function.name)).toContain('run_python');

    // …runs it and answers (only once)
    const answer = { callId: 'call_py', content: JSON.stringify({ stdout: '42\n' }) };
    expect((await f.admin.post(`/api/runs/${runId}/tool-results`, answer)).statusCode).toBe(200);
    expect((await f.admin.post(`/api/runs/${runId}/tool-results`, answer)).statusCode).toBe(404);
    const rest = await f.readRun(f.admin, runId, seen.at(-1)!.seq);
    expect(types(rest)).toContain('run.completed');
    const followUp = f.mock.requests.filter((r) => r.stream)[1];
    expect(followUp.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_py', content: '{"stdout":"42\\n"}' });

    const node = (await f.admin.get(`/api/chats/${chat}`)).json().chat.messages.find((m: any) => m.role === 'assistant');
    expect(node.parts.map((p: any) => p.type)).toEqual(['tool_call', 'tool_result', 'text']);
    expect(node.parts[0]).toMatchObject({ serverId: 'browser', tool: 'run_python' });

    // Someone else can't answer it
    const bob = await f.newUser('bob@example.com');
    expect((await bob.post(`/api/runs/${runId}/tool-results`, answer)).statusCode).toBe(404);
  });

  it('carries on with an error when no browser answers (the tab was closed)', async () => {
    f = await chatFixture({ env: SANDBOX, orchestrator: { clientToolTimeoutMs: 300 } });
    f.mock.push({ toolCalls: [{ id: 'call_lost', name: 'run_python', arguments: '{"code":"1+1"}' }] }, { text: ['I could not run it.'] });
    const { chat, res } = await start(f, { features: { code: true } });
    // Nobody follows the run or answers
    await new Promise((r) => setTimeout(r, 200));
    const events = await f.readRun(f.admin, res.json().runId);
    expect(types(events)).toContain('run.completed');
    const followUp = f.mock.requests.filter((r) => r.stream)[1];
    expect(JSON.parse(followUp.messages.at(-1).content)).toEqual({ error: NO_BROWSER_MESSAGE });
    const node = (await f.admin.get(`/api/chats/${chat}`)).json().chat.messages.find((m: any) => m.role === 'assistant');
    expect(node).toMatchObject({ status: 'completed' });
    expect(node.parts[1]).toMatchObject({ type: 'tool_result', isError: true });
  });

  it('needs a sandbox origin and the permission', async () => {
    f = await chatFixture();
    const off = await start(f, { features: { code: true } });
    expect(off.res.statusCode).toBe(400);
    expect(off.res.json().error.code).toBe('code_unavailable');
    await f.close();

    f = await chatFixture({ env: SANDBOX });
    expect((await f.admin.get('/api/auth/session')).json().features.codeInterpreter).toBe(true);
    await f.admin.patch('/api/admin/settings/permissions.default', { ...DEFAULT_PERMISSIONS, 'features.code': false });
    const bob = await f.newUser('bob@example.com');
    const chat = (await bob.post('/api/chats', {})).json().chat.id;
    const denied = await bob.post(`/api/chats/${chat}/completions`, { parentId: null, content: 'x', modelIds: ['mock/gpt-test'], features: { code: true } });
    expect(denied.statusCode).toBe(403);
  });
});

describe('image generation', () => {
  it('generates an image as a tool, keeps it as a file and shows it in the reply', async () => {
    f = await chatFixture();
    const off = await start(f, { features: { imageGen: true } });
    expect(off.res.statusCode).toBe(400);

    const saved = await f.admin.put('/api/admin/media', {
      image: { ...MEDIA_DEFAULTS.image, engine: 'openai', baseUrl: f.mock.url, model: 'img-test' },
      imageKey: 'sk-image',
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ hasImageKey: true, settings: { image: { engine: 'openai' } } });
    expect(saved.body).not.toContain('sk-image');
    expect((await f.admin.get('/api/auth/session')).json().features.imageGen).toBe(true);

    f.mock.push(
      { toolCalls: [{ id: 'call_img', name: 'generate_image', arguments: '{"prompt":"a lighthouse at dusk","size":"1024x1024"}' }] },
      { text: ['Here it is.'] }
    );
    const { chat, res } = await start(f, { features: { imageGen: true }, content: 'Draw a lighthouse' });
    expect(res.statusCode).toBe(202);
    const events = await f.readRun(f.admin, res.json().runId);
    expect(types(events)).toContain('message.part');
    expect(f.mock.imageCalls[0]).toMatchObject({ model: 'img-test', prompt: 'a lighthouse at dusk', size: '1024x1024' });

    const node = (await f.admin.get(`/api/chats/${chat}`)).json().chat.messages.find((m: any) => m.role === 'assistant');
    expect(node.parts.map((p: any) => p.type)).toEqual(['tool_call', 'tool_result', 'file', 'text']);
    const file = node.parts[2];
    expect(file).toMatchObject({ mime: 'image/png' });
    const download = await f.admin.get(`/api/files/${file.fileId}/content`);
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.subarray(1, 4).toString()).toBe('PNG');
    // The model is told it was shown, not given the image
    expect(f.mock.requests.filter((r) => r.stream)[1].messages.at(-1).content).toContain('Generated 1 image');
  });

  it('speaks to AUTOMATIC1111, ComfyUI and Gemini', async () => {
    const seen: Array<{ url: string; body: any }> = [];
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    server = http.createServer(async (req, res) => {
      let raw = '';
      for await (const c of req) raw += c;
      seen.push({ url: req.url ?? '', body: raw ? JSON.parse(raw) : null });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/sdapi/v1/txt2img') return res.end(JSON.stringify({ images: [png.toString('base64')] }));
      if (req.url === '/prompt') return res.end(JSON.stringify({ prompt_id: 'p1' }));
      if (req.url === '/history/p1') {
        return res.end(JSON.stringify({ p1: { outputs: { '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } } }));
      }
      if (req.url?.startsWith('/view?')) {
        res.setHeader('Content-Type', 'image/png');
        return res.end(png);
      }
      if (req.url?.startsWith('/models/')) {
        return res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }, { inlineData: { mimeType: 'image/png', data: png.toString('base64') } }] } }] }));
      }
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const cfg = { ...MEDIA_DEFAULTS.image, baseUrl: base, size: '512x768', steps: 12 };

    const a = await generateImage({ ...cfg, engine: 'automatic1111' }, undefined, 'a cat');
    expect(a[0].data.equals(png)).toBe(true);
    expect(seen.at(-1)!.body).toMatchObject({ prompt: 'a cat', steps: 12, width: 512, height: 768 });

    const workflow = JSON.stringify({ '3': { inputs: { text: '%prompt%', seed: '%seed%' } }, '5': { inputs: { width: '%width%', height: '%height%' } } });
    const c = await generateImage({ ...cfg, engine: 'comfyui', comfyWorkflow: workflow }, undefined, 'a "quoted" dog');
    expect(c[0].mime).toBe('image/png');
    const queued = seen.find((s) => s.url === '/prompt')!.body.prompt;
    expect(queued['3'].inputs.text).toBe('a "quoted" dog');
    expect(queued['5'].inputs).toEqual({ width: '512', height: '768' });

    const g = await generateImage({ ...cfg, engine: 'gemini', model: 'gemini-image' }, 'gkey', 'a fox');
    expect(g).toHaveLength(1);
    expect(seen.at(-1)!.url).toBe('/models/gemini-image:generateContent');
    expect(seen.at(-1)!.body.generationConfig.responseModalities).toContain('IMAGE');
  });
});

describe('voice through the server', () => {
  it('transcribes recordings and reads text aloud with an OpenAI-compatible engine', async () => {
    f = await chatFixture();
    // The default is the browser's own speech: the server endpoints are off
    expect((await f.admin.get('/api/auth/session')).json().features).toMatchObject({ voiceInput: 'browser', readAloud: 'browser' });
    expect((await f.admin.post('/api/audio/speech', { text: 'Hi' })).statusCode).toBe(400);

    await f.admin.put('/api/admin/media', {
      stt: { ...MEDIA_DEFAULTS.stt, engine: 'openai', baseUrl: f.mock.url },
      tts: { ...MEDIA_DEFAULTS.tts, engine: 'openai', baseUrl: f.mock.url, voice: 'nova' },
      audioKey: 'sk-audio',
    });
    expect((await f.admin.get('/api/auth/session')).json().features).toMatchObject({ voiceInput: 'server', readAloud: 'server' });

    const speech = await f.admin.post('/api/audio/speech', { text: 'Hello there' });
    expect(speech.statusCode).toBe(200);
    expect(speech.headers['content-type']).toContain('audio/mpeg');
    expect(f.mock.audioCalls.at(-1)).toMatchObject({ kind: 'speech', body: { input: 'Hello there', voice: 'nova', model: 'tts-1' } });

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(Buffer.from('fake-webm-audio'))], { type: 'audio/webm' }), 'rec.webm');
    const encoded = new Request('http://localhost/', { method: 'POST', body: form });
    const transcribed = await f.admin.request({
      method: 'POST',
      url: '/api/audio/transcriptions',
      headers: { 'content-type': encoded.headers.get('content-type')! },
      payload: Buffer.from(await encoded.arrayBuffer()),
    });
    expect(transcribed.statusCode, transcribed.body).toBe(200);
    expect(transcribed.json()).toEqual({ text: 'Hello from the microphone' });
    expect(f.mock.audioCalls.at(-1)).toMatchObject({ kind: 'transcription' });

    // Not for users without the permission
    await f.admin.patch('/api/admin/settings/permissions.default', { ...DEFAULT_PERMISSIONS, 'features.voice': false });
    const bob = await f.newUser('bob@example.com');
    expect((await bob.post('/api/audio/speech', { text: 'Hi' })).statusCode).toBe(403);
  });
});
