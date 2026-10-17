/**
 * /api/audio — voice through the server (when the admin chose an
 * OpenAI-compatible engine; "browser" engines never reach here):
 * - POST /transcriptions: an audio recording → text (Whisper API);
 * - POST /speech: text → audio (TTS API), streamed back.
 * /api/admin/media — image generation and voice settings.
 */
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context';
import { badRequest, tooManyRequests } from '../lib/errors';
import { currentUser, requireAdmin, requireUser } from '../auth/rbac';
import { MediaSettingsUpdate, SpeechRequest } from '../../shared/media';
import { generateImage } from './images';

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const trim = (u: string) => u.replace(/\/+$/, '');

export async function audioRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireUser);
  const rate = {
    rateLimit: {
      max: async () => (await ctx.settings.get('limits')).completionsPerMinute,
      timeWindow: '1 minute',
      keyGenerator: (req: any) => `audio:${req.user?.id ?? req.ip}`,
    },
  };

  app.post('/transcriptions', { config: rate }, async (req) => {
    const me = currentUser(req);
    await ctx.access.require(me, 'features.voice');
    const { stt } = await ctx.media.settings();
    if (stt.engine !== 'openai') throw badRequest('Speech recognition through the server is not set up.', 'stt_off');
    const part = await req.file({ limits: { fileSize: MAX_AUDIO_BYTES, files: 1 } });
    if (!part) throw badRequest('No audio in the request.', 'no_file');
    const data = await part.toBuffer().catch((err: Error & { code?: string }) => {
      if (err.code === 'FST_REQ_FILE_TOO_LARGE') throw badRequest('The recording is too long.', 'file_too_large');
      throw err;
    });
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(data)], { type: part.mimetype || 'audio/webm' }), part.filename || 'audio.webm');
    form.append('model', stt.model || 'whisper-1');
    if (stt.language) form.append('language', stt.language);
    const key = await ctx.media.secret('audioKey');
    const res = await fetch(`${trim(stt.baseUrl || 'https://api.openai.com/v1')}/audio/transcriptions`, {
      method: 'POST',
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    if (res.status === 429) throw tooManyRequests('The speech service is busy. Try again in a moment.');
    if (!res.ok) throw badRequest(`Speech recognition failed (${res.status}).`, 'stt_failed');
    const json = (await res.json()) as { text?: string };
    return { text: (json.text ?? '').trim() };
  });

  app.post('/speech', { config: rate }, async (req, reply) => {
    const me = currentUser(req);
    await ctx.access.require(me, 'features.voice');
    const { tts } = await ctx.media.settings();
    if (tts.engine !== 'openai') throw badRequest('Read-aloud through the server is not set up.', 'tts_off');
    const body = SpeechRequest.parse(req.body);
    const key = await ctx.media.secret('audioKey');
    const res = await fetch(`${trim(tts.baseUrl || 'https://api.openai.com/v1')}/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model: tts.model || 'tts-1', voice: body.voice || tts.voice || 'alloy', input: body.text, response_format: 'mp3' }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok || !res.body) throw badRequest(`Read-aloud failed (${res.status}).`, 'tts_failed');
    reply.header('Content-Type', res.headers.get('content-type') ?? 'audio/mpeg').header('Cache-Control', 'no-store');
    return reply.send(Buffer.from(await res.arrayBuffer()));
  });
}

export async function adminMediaRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', requireAdmin);

  app.get('/', async () => ctx.media.view());

  app.put('/', async (req) => ctx.media.update(MediaSettingsUpdate.parse(req.body)));

  // "Test": one small image, returned as a data URL for the settings page
  app.post('/test-image', async () => {
    try {
      const [img] = await generateImage((await ctx.media.settings()).image, await ctx.media.secret('imageKey'), 'A small red apple on a white table', {
        size: '256x256',
      });
      if (!img) return { ok: false, error: 'No image came back.', image: null };
      return { ok: true, error: null, image: `data:${img.mime};base64,${img.data.toString('base64')}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), image: null };
    }
  });
}
