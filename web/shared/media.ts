import { z } from 'zod';

export const IMAGE_ENGINES = ['none', 'openai', 'automatic1111', 'comfyui', 'gemini'] as const;
export const STT_ENGINES = ['none', 'browser', 'openai'] as const;
export const TTS_ENGINES = ['none', 'browser', 'openai'] as const;

export const MediaSettings = z.object({
  image: z.object({
    /** openai: any OpenAI-compatible /images/generations; automatic1111: /sdapi/v1/txt2img; comfyui: a workflow; gemini: the Gemini API. */
    engine: z.enum(IMAGE_ENGINES),
    baseUrl: z.string().trim().max(500),
    model: z.string().trim().max(200),
    /** "1024x1024" */
    size: z.string().regex(/^\d{2,4}x\d{2,4}$/),
    steps: z.number().int().min(1).max(150),
    /**
     * ComfyUI: the API-format workflow JSON; "%prompt%", "%negative%",
     * "%width%", "%height%", "%steps%" and "%seed%" are replaced.
     */
    comfyWorkflow: z.string().max(200_000),
  }),
  stt: z.object({
    /** browser: the Web Speech API (nothing leaves the browser for the server); openai: a Whisper-compatible endpoint. */
    engine: z.enum(STT_ENGINES),
    baseUrl: z.string().trim().max(500),
    model: z.string().trim().max(200),
    language: z.string().trim().max(20),
  }),
  tts: z.object({
    engine: z.enum(TTS_ENGINES),
    baseUrl: z.string().trim().max(500),
    model: z.string().trim().max(200),
    voice: z.string().trim().max(100),
  }),
});
export type MediaSettings = z.infer<typeof MediaSettings>;

export const MediaSettingsUpdate = MediaSettings.partial().extend({
  /** Omitted = keep; '' = remove. */
  imageKey: z.string().max(10_000).optional(),
  audioKey: z.string().max(10_000).optional(),
});
export type MediaSettingsUpdate = z.infer<typeof MediaSettingsUpdate>;

export interface MediaSettingsResponse {
  settings: MediaSettings;
  hasImageKey: boolean;
  hasAudioKey: boolean;
}

export const SpeechRequest = z.object({
  text: z.string().trim().min(1).max(4096),
  voice: z.string().trim().max(100).optional(),
});
