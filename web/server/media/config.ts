/**
 * Admin settings for image generation and voice, in app_config ("media");
 * API keys encrypted in "media.secrets" and never returned.
 */
import { eq } from 'drizzle-orm';
import type { Database } from '../db/client';
import { appConfig } from '../db/schema';
import type { SecretBox } from '../crypto/secrets';
import type { Cluster } from '../cluster/cluster';
import { badRequest } from '../lib/errors';
import { MediaSettings, type MediaSettingsResponse, type MediaSettingsUpdate } from '../../shared/media';

export const MEDIA_DEFAULTS: MediaSettings = {
  image: { engine: 'none', baseUrl: '', model: '', size: '1024x1024', steps: 25, comfyWorkflow: '' },
  stt: { engine: 'browser', baseUrl: '', model: 'whisper-1', language: '' },
  tts: { engine: 'browser', baseUrl: '', model: 'tts-1', voice: 'alloy' },
};

interface Secrets {
  imageKey?: string;
  audioKey?: string;
}

export class MediaConfig {
  private cached: { settings: MediaSettings; secrets: Secrets } | null = null;

  constructor(private readonly deps: { db: Database; secrets: SecretBox; cluster?: Cluster }) {
    deps.cluster?.on('media', () => this.reset());
  }

  /** Forget the cached settings (another instance changed them). */
  reset(): void {
    this.cached = null;
  }

  private async load() {
    if (this.cached) return this.cached;
    const [row] = await this.deps.db.select().from(appConfig).where(eq(appConfig.key, 'media'));
    const [sec] = await this.deps.db.select().from(appConfig).where(eq(appConfig.key, 'media.secrets'));
    const stored = (row?.value ?? {}) as Partial<MediaSettings>;
    const parsed = MediaSettings.safeParse({
      image: { ...MEDIA_DEFAULTS.image, ...stored.image },
      stt: { ...MEDIA_DEFAULTS.stt, ...stored.stt },
      tts: { ...MEDIA_DEFAULTS.tts, ...stored.tts },
    });
    const cipher = (sec?.value ?? {}) as Record<string, string>;
    const secrets: Secrets = {};
    for (const k of ['imageKey', 'audioKey'] as const) if (cipher[k]) secrets[k] = this.deps.secrets.decrypt(cipher[k]);
    this.cached = { settings: parsed.success ? parsed.data : MEDIA_DEFAULTS, secrets };
    return this.cached;
  }

  async settings(): Promise<MediaSettings> {
    return (await this.load()).settings;
  }

  async secret(name: keyof Secrets): Promise<string | undefined> {
    return (await this.load()).secrets[name];
  }

  async view(): Promise<MediaSettingsResponse> {
    const { settings, secrets } = await this.load();
    return { settings, hasImageKey: !!secrets.imageKey, hasAudioKey: !!secrets.audioKey };
  }

  async update(patch: MediaSettingsUpdate): Promise<MediaSettingsResponse> {
    const { settings, secrets } = await this.load();
    const { imageKey, audioKey, ...fields } = patch;
    const next = MediaSettings.parse({
      image: { ...settings.image, ...fields.image },
      stt: { ...settings.stt, ...fields.stt },
      tts: { ...settings.tts, ...fields.tts },
    });
    if (next.image.engine === 'comfyui' && next.image.comfyWorkflow) {
      try {
        JSON.parse(next.image.comfyWorkflow);
      } catch {
        throw badRequest('The ComfyUI workflow is not valid JSON.', 'invalid_workflow');
      }
    }
    const nextSecrets: Secrets = { ...secrets };
    for (const [k, v] of Object.entries({ imageKey, audioKey }) as Array<[keyof Secrets, string | undefined]>) {
      if (v === undefined) continue;
      if (v === '') delete nextSecrets[k];
      else nextSecrets[k] = v;
    }
    const cipher = Object.fromEntries(Object.entries(nextSecrets).map(([k, v]) => [k, this.deps.secrets.encrypt(v!)]));
    for (const [key, value] of [
      ['media', next],
      ['media.secrets', cipher],
    ] as const) {
      await this.deps.db
        .insert(appConfig)
        .values({ key, value })
        .onConflictDoUpdate({ target: appConfig.key, set: { value, updatedAt: new Date() } });
    }
    this.cached = null;
    this.deps.cluster?.signal('media');
    return this.view();
  }
}
