import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { IMAGE_ENGINES, STT_ENGINES, TTS_ENGINES, type MediaSettings } from '@shared/media';
import { errorMessage, useMediaSettingsQuery, useTestImageMutation, useUpdateMediaSettingsMutation } from '../../api/rtk-api';

const input = 'w-full rounded border border-border bg-background px-2 py-1.5 text-sm';

/** Admin → Media: image generation, speech recognition and read-aloud. */
export function MediaSettingsPage() {
  const { t } = useTranslation();
  const { data } = useMediaSettingsQuery();
  const [save, saveState] = useUpdateMediaSettingsMutation();
  const [test, testState] = useTestImageMutation();
  const [draft, setDraft] = useState<MediaSettings | null>(null);
  const [keys, setKeys] = useState({ imageKey: '', audioKey: '' });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) setDraft(structuredClone(data.settings));
  }, [data]);
  if (!draft || !data) return <p className="text-sm text-text-secondary">{t('app.loading')}</p>;

  const set = <K extends keyof MediaSettings>(key: K, patch: Partial<MediaSettings[K]>) => {
    setSaved(false);
    setDraft((d) => (d ? { ...d, [key]: { ...d[key], ...patch } } : d));
  };
  const submit = async () => {
    const secrets = Object.fromEntries(Object.entries(keys).filter(([, v]) => v));
    const res = await save({ ...draft, ...secrets });
    if (!('error' in res)) {
      setKeys({ imageKey: '', audioKey: '' });
      setSaved(true);
    }
  };
  const img = draft.image;

  return (
    <div className="space-y-4">
      <Card title={t('media.images')}>
        <p className="mb-3 text-sm text-text-secondary">{t('media.imagesHelp')}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('rag.engine')}>
            <select className={input} value={img.engine} onChange={(e) => set('image', { engine: e.target.value as MediaSettings['image']['engine'] })} data-testid="image-engine">
              {IMAGE_ENGINES.map((x) => (
                <option key={x} value={x}>
                  {t(`media.imageEngines.${x}`)}
                </option>
              ))}
            </select>
          </Field>
          {img.engine !== 'none' && (
            <>
              <Field label={t('rag.baseUrl')}>
                <input
                  className={input}
                  value={img.baseUrl}
                  placeholder={{ openai: 'https://api.openai.com/v1', automatic1111: 'http://sd:7860', comfyui: 'http://comfyui:8188', gemini: 'https://generativelanguage.googleapis.com/v1beta' }[img.engine]}
                  onChange={(e) => set('image', { baseUrl: e.target.value })}
                />
              </Field>
              {img.engine !== 'comfyui' && (
                <Field label={t('rag.model')}>
                  <input className={input} value={img.model} placeholder={img.engine === 'gemini' ? 'gemini-2.5-flash-image' : img.engine === 'openai' ? 'gpt-image-1' : ''} onChange={(e) => set('image', { model: e.target.value })} />
                </Field>
              )}
              <Field label={t('media.size')}>
                <input className={input} value={img.size} onChange={(e) => set('image', { size: e.target.value.trim() })} />
              </Field>
              {(img.engine === 'automatic1111' || img.engine === 'comfyui') && (
                <Field label={t('media.steps')}>
                  <input type="number" min={1} max={150} className={input} value={img.steps} onChange={(e) => set('image', { steps: Math.min(150, Math.max(1, Number(e.target.value) || 1)) })} />
                </Field>
              )}
              {img.engine !== 'automatic1111' && (
                <Field label={t('rag.apiKey')} help={data.hasImageKey ? t('rag.keyStored') : undefined}>
                  <input className={input} type="password" autoComplete="off" value={keys.imageKey} onChange={(e) => setKeys({ ...keys, imageKey: e.target.value })} />
                </Field>
              )}
            </>
          )}
        </div>
        {img.engine === 'comfyui' && (
          <Field label={t('media.workflow')} help={t('media.workflowHelp')}>
            <textarea className={`${input} mt-1 font-mono text-xs`} rows={6} value={img.comfyWorkflow} onChange={(e) => set('image', { comfyWorkflow: e.target.value })} />
          </Field>
        )}
        {img.engine !== 'none' && (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button size="sm" variant="secondary" onClick={() => void test()} disabled={testState.isLoading}>
              {testState.isLoading ? t('media.testing') : t('media.testImage')}
            </Button>
            {testState.data?.error && <span className="text-sm text-error">{testState.data.error}</span>}
            {testState.data?.image && <img src={testState.data.image} alt={t('media.testImage')} className="h-16 w-16 rounded border border-border object-cover" />}
          </div>
        )}
      </Card>

      <Card title={t('media.voice')}>
        <p className="mb-3 text-sm text-text-secondary">{t('media.voiceHelp')}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('media.stt')}>
            <select className={input} value={draft.stt.engine} onChange={(e) => set('stt', { engine: e.target.value as MediaSettings['stt']['engine'] })}>
              {STT_ENGINES.map((x) => (
                <option key={x} value={x}>
                  {t(`media.voiceEngines.${x}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('media.tts')}>
            <select className={input} value={draft.tts.engine} onChange={(e) => set('tts', { engine: e.target.value as MediaSettings['tts']['engine'] })}>
              {TTS_ENGINES.map((x) => (
                <option key={x} value={x}>
                  {t(`media.voiceEngines.${x}`)}
                </option>
              ))}
            </select>
          </Field>
          {draft.stt.engine === 'openai' && (
            <>
              <Field label={`${t('media.stt')} · ${t('rag.baseUrl')}`}>
                <input className={input} value={draft.stt.baseUrl} placeholder="https://api.openai.com/v1" onChange={(e) => set('stt', { baseUrl: e.target.value })} />
              </Field>
              <Field label={`${t('media.stt')} · ${t('rag.model')}`}>
                <input className={input} value={draft.stt.model} onChange={(e) => set('stt', { model: e.target.value })} />
              </Field>
            </>
          )}
          {draft.tts.engine === 'openai' && (
            <>
              <Field label={`${t('media.tts')} · ${t('rag.baseUrl')}`}>
                <input className={input} value={draft.tts.baseUrl} placeholder="https://api.openai.com/v1" onChange={(e) => set('tts', { baseUrl: e.target.value })} />
              </Field>
              <Field label={`${t('media.tts')} · ${t('rag.model')}`}>
                <input className={input} value={draft.tts.model} onChange={(e) => set('tts', { model: e.target.value })} />
              </Field>
              <Field label={t('media.ttsVoice')}>
                <input className={input} value={draft.tts.voice} onChange={(e) => set('tts', { voice: e.target.value })} />
              </Field>
            </>
          )}
          {(draft.stt.engine === 'openai' || draft.tts.engine === 'openai') && (
            <Field label={t('rag.apiKey')} help={data.hasAudioKey ? t('rag.keyStored') : undefined}>
              <input className={input} type="password" autoComplete="off" value={keys.audioKey} onChange={(e) => setKeys({ ...keys, audioKey: e.target.value })} />
            </Field>
          )}
        </div>
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={() => void submit()} disabled={saveState.isLoading} data-testid="media-save">
          {t('app.save')}
        </Button>
        {saved && <span className="text-sm text-success">{t('app.saved')}</span>}
        {saveState.error && <span className="text-sm text-error">{errorMessage(saveState.error)}</span>}
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <h2 className="mb-3 font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block">{label}</span>
      {children}
      {help && <span className="mt-1 block text-xs text-text-secondary">{help}</span>}
    </label>
  );
}
