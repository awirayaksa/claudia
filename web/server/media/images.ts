/**
 * Image generation engines (admin-configured endpoints, so no SSRF guard):
 * - openai: POST /images/generations (OpenAI, and compatible servers);
 * - automatic1111: POST /sdapi/v1/txt2img;
 * - comfyui: the admin's API-format workflow, queued with POST /prompt,
 *   then /history and /view;
 * - gemini: generateContent with image output.
 */
import { randomInt } from 'node:crypto';
import type { MediaSettings } from '../../shared/media';

export interface GeneratedImage {
  data: Buffer;
  mime: string;
}

const TIMEOUT_MS = 180_000;
const trim = (u: string) => u.replace(/\/+$/, '');

async function json(url: string, init: RequestInit): Promise<any> {
  const res = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 300);
    let message = text;
    try {
      const j = JSON.parse(text);
      message = j.error?.message ?? j.message ?? j.detail ?? text;
    } catch {
      /* plain text */
    }
    throw new Error(`Image generation failed (${res.status}): ${message || res.statusText}`);
  }
  return res.json();
}

async function bytes(url: string, headers: Record<string, string> = {}): Promise<GeneratedImage> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Downloading the image failed (${res.status}).`);
  return { data: Buffer.from(await res.arrayBuffer()), mime: res.headers.get('content-type')?.split(';')[0] || 'image/png' };
}

function sizeOf(size: string): { width: number; height: number } {
  const [w, h] = size.split('x').map(Number);
  return { width: w || 1024, height: h || 1024 };
}

export async function generateImage(
  cfg: MediaSettings['image'],
  apiKey: string | undefined,
  prompt: string,
  opts: { size?: string; signal?: AbortSignal } = {}
): Promise<GeneratedImage[]> {
  const size = opts.size && /^\d{2,4}x\d{2,4}$/.test(opts.size) ? opts.size : cfg.size;
  const auth: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  switch (cfg.engine) {
    case 'openai': {
      const base = trim(cfg.baseUrl || 'https://api.openai.com/v1');
      const res = await json(`${base}/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ model: cfg.model || 'gpt-image-1', prompt, size, n: 1 }),
        signal: opts.signal,
      });
      const out: GeneratedImage[] = [];
      for (const d of res.data ?? []) {
        if (d.b64_json) out.push({ data: Buffer.from(d.b64_json, 'base64'), mime: 'image/png' });
        else if (d.url) out.push(await bytes(d.url));
      }
      return out;
    }
    case 'automatic1111': {
      const { width, height } = sizeOf(size);
      const res = await json(`${trim(cfg.baseUrl)}/sdapi/v1/txt2img`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ prompt, steps: cfg.steps, width, height, ...(cfg.model ? { override_settings: { sd_model_checkpoint: cfg.model } } : {}) }),
        signal: opts.signal,
      });
      return (res.images ?? []).map((b64: string) => ({ data: Buffer.from(b64, 'base64'), mime: 'image/png' }));
    }
    case 'comfyui': {
      if (!cfg.comfyWorkflow) throw new Error('Set a ComfyUI workflow in Admin → Media.');
      const base = trim(cfg.baseUrl);
      const { width, height } = sizeOf(size);
      const values: Record<string, string> = {
        '%prompt%': JSON.stringify(prompt).slice(1, -1),
        '%negative%': '',
        '%width%': String(width),
        '%height%': String(height),
        '%steps%': String(cfg.steps),
        '%seed%': String(randomInt(0, 2 ** 31)),
      };
      const workflow = JSON.parse(cfg.comfyWorkflow.replace(/%(prompt|negative|width|height|steps|seed)%/g, (m) => values[m]));
      const queued = await json(`${base}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ prompt: workflow, client_id: 'claudia' }),
        signal: opts.signal,
      });
      const id = queued.prompt_id as string;
      const deadline = Date.now() + TIMEOUT_MS;
      for (;;) {
        if (opts.signal?.aborted) throw new Error('Stopped.');
        const history = await json(`${base}/history/${encodeURIComponent(id)}`, { headers: auth });
        const outputs = history[id]?.outputs as Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }> }> | undefined;
        const images = outputs ? Object.values(outputs).flatMap((o) => o.images ?? []) : [];
        if (images.length > 0) {
          return Promise.all(
            images.map((img) =>
              bytes(`${base}/view?${new URLSearchParams({ filename: img.filename, subfolder: img.subfolder, type: img.type })}`, auth)
            )
          );
        }
        if (Date.now() > deadline) throw new Error('ComfyUI took too long.');
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    case 'gemini': {
      const base = trim(cfg.baseUrl || 'https://generativelanguage.googleapis.com/v1beta');
      const model = cfg.model || 'gemini-2.5-flash-image';
      const res = await json(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey ?? '' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }),
        signal: opts.signal,
      });
      const parts = (res.candidates?.[0]?.content?.parts ?? []) as Array<{ inlineData?: { mimeType: string; data: string } }>;
      return parts.flatMap((p) => (p.inlineData ? [{ data: Buffer.from(p.inlineData.data, 'base64'), mime: p.inlineData.mimeType }] : []));
    }
    case 'none':
      throw new Error('Image generation is not set up.');
  }
}

export const IMAGE_TOOL_NAME = 'generate_image';

export const IMAGE_TOOL = {
  type: 'function' as const,
  function: {
    name: IMAGE_TOOL_NAME,
    description:
      'Generate an image from a text description and show it to the user. Write a detailed, visual prompt in English. ' +
      'Use only when the user asks for an image.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What the image shows, in detail.' },
        size: { type: 'string', description: 'Optional, e.g. "1024x1024", "1536x1024".' },
      },
      required: ['prompt'],
    },
  },
};
