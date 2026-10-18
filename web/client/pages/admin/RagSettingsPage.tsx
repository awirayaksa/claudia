import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { EMBEDDING_ENGINES, RERANK_ENGINES, SEARCH_ENGINES, type RagSettings } from '@shared/knowledge';
import { errorMessage, useRagSettingsQuery, useTestEmbeddingsMutation, useUpdateRagSettingsMutation } from '../../api/rtk-api';

const input = 'w-full rounded border border-border bg-background px-2 py-1.5 text-sm';

/** Admin → Knowledge: embeddings, chunking, retrieval, reranking and web search. */
export function RagSettingsPage() {
  const { t } = useTranslation();
  const { data } = useRagSettingsQuery();
  const [save, saveState] = useUpdateRagSettingsMutation();
  const [test, testState] = useTestEmbeddingsMutation();
  const [draft, setDraft] = useState<RagSettings | null>(null);
  const [keys, setKeys] = useState({ embeddingKey: '', rerankKey: '', searchKey: '' });
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    if (data) setDraft(structuredClone(data.settings));
  }, [data]);
  if (!draft || !data) return <p className="text-sm text-text-secondary">{t('app.loading')}</p>;

  const set = <K extends keyof RagSettings>(key: K, value: RagSettings[K]) => {
    setSaved(null);
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  };
  const submit = async () => {
    const secrets = Object.fromEntries(Object.entries(keys).filter(([, v]) => v));
    const res = await save({ ...draft, ...secrets });
    if (!('error' in res)) {
      setKeys({ embeddingKey: '', rerankKey: '', searchKey: '' });
      setSaved(res.data.reindexing ? t('rag.savedReindexing') : t('app.saved'));
    }
  };
  const e = draft.embedding;

  return (
    <div className="space-y-4">
      <Card title={t('rag.embeddings')}>
        <p className="mb-3 text-sm text-text-secondary">{t('rag.embeddingsHelp')}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('rag.engine')}>
            <select className={input} value={e.engine} onChange={(ev) => set('embedding', { ...e, engine: ev.target.value as typeof e.engine })} data-testid="embedding-engine">
              {EMBEDDING_ENGINES.map((x) => (
                <option key={x} value={x} disabled={x === 'local' && !data.localAvailable}>
                  {t(`rag.engines.${x}`)}
                </option>
              ))}
            </select>
          </Field>
          {e.engine !== 'none' && (
            <Field label={t('rag.model')}>
              <input
                className={input}
                value={e.model}
                placeholder={e.engine === 'local' ? 'Xenova/all-MiniLM-L6-v2' : e.engine === 'ollama' ? 'nomic-embed-text' : 'text-embedding-3-small'}
                onChange={(ev) => set('embedding', { ...e, model: ev.target.value })}
                data-testid="embedding-model"
              />
            </Field>
          )}
          {(e.engine === 'openai' || e.engine === 'ollama') && (
            <>
              <Field label={t('rag.baseUrl')}>
                <input
                  className={input}
                  value={e.baseUrl}
                  placeholder={e.engine === 'ollama' ? 'http://ollama:11434' : 'https://api.openai.com/v1'}
                  onChange={(ev) => set('embedding', { ...e, baseUrl: ev.target.value })}
                  data-testid="embedding-url"
                />
              </Field>
              <Field label={t('rag.apiKey')} help={data.hasEmbeddingKey ? t('rag.keyStored') : undefined}>
                <input className={input} type="password" autoComplete="off" value={keys.embeddingKey} onChange={(ev) => setKeys({ ...keys, embeddingKey: ev.target.value })} />
              </Field>
            </>
          )}
        </div>
        {e.engine === 'local' && !data.localAvailable && <p className="mt-2 text-xs text-error">{t('rag.localMissing')}</p>}
        <div className="mt-3 flex items-center gap-3">
          <Button size="sm" variant="secondary" onClick={() => void test()} disabled={testState.isLoading}>
            {t('rag.test')}
          </Button>
          {testState.data && (
            <span className={`text-sm ${testState.data.ok ? 'text-success' : 'text-error'}`}>
              {testState.data.ok ? t('rag.testOk', { dims: testState.data.dims }) : testState.data.error}
            </span>
          )}
        </div>
        <p className="mt-2 text-xs text-text-secondary">{t('rag.changeWarning')}</p>
      </Card>

      <Card title={t('rag.retrieval')}>
        <div className="grid gap-3 sm:grid-cols-4">
          {(
            [
              ['chunkSize', 100, 8000],
              ['chunkOverlap', 0, 2000],
              ['topK', 1, 50],
              ['maxContextTokens', 500, 200000],
            ] as const
          ).map(([key, min, max]) => (
            <Field key={key} label={t(`rag.${key}`)}>
              <input
                type="number"
                className={input}
                min={min}
                max={max}
                value={draft[key]}
                onChange={(ev) => set(key, Math.min(max, Math.max(min, Number(ev.target.value) || min)))}
              />
            </Field>
          ))}
        </div>
        <h3 className="mb-2 mt-4 text-sm font-semibold">{t('rag.rerank')}</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('rag.engine')}>
            <select className={input} value={draft.rerank.engine} onChange={(ev) => set('rerank', { ...draft.rerank, engine: ev.target.value as RagSettings['rerank']['engine'] })}>
              {RERANK_ENGINES.map((x) => (
                <option key={x} value={x}>
                  {t(`rag.rerankEngines.${x}`)}
                </option>
              ))}
            </select>
          </Field>
          {draft.rerank.engine !== 'none' && (
            <>
              <Field label={t('rag.baseUrl')}>
                <input className={input} value={draft.rerank.baseUrl} placeholder="https://api.cohere.com/v2" onChange={(ev) => set('rerank', { ...draft.rerank, baseUrl: ev.target.value })} />
              </Field>
              {draft.rerank.engine === 'cohere' && (
                <Field label={t('rag.model')}>
                  <input className={input} value={draft.rerank.model} placeholder="rerank-v3.5" onChange={(ev) => set('rerank', { ...draft.rerank, model: ev.target.value })} />
                </Field>
              )}
              <Field label={t('rag.apiKey')} help={data.hasRerankKey ? t('rag.keyStored') : undefined}>
                <input className={input} type="password" autoComplete="off" value={keys.rerankKey} onChange={(ev) => setKeys({ ...keys, rerankKey: ev.target.value })} />
              </Field>
            </>
          )}
        </div>
      </Card>

      <Card title={t('rag.webSearch')}>
        <p className="mb-3 text-sm text-text-secondary">{t('rag.webSearchHelp')}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('rag.engine')}>
            <select
              className={input}
              value={draft.webSearch.engine}
              onChange={(ev) => set('webSearch', { ...draft.webSearch, engine: ev.target.value as RagSettings['webSearch']['engine'] })}
              data-testid="search-engine"
            >
              {SEARCH_ENGINES.map((x) => (
                <option key={x} value={x}>
                  {t(`rag.searchEngines.${x}`)}
                </option>
              ))}
            </select>
          </Field>
          {draft.webSearch.engine === 'searxng' && (
            <Field label={t('rag.baseUrl')}>
              <input className={input} value={draft.webSearch.baseUrl} placeholder="http://searxng:8080" onChange={(ev) => set('webSearch', { ...draft.webSearch, baseUrl: ev.target.value })} />
            </Field>
          )}
          {['brave', 'tavily', 'google_pse'].includes(draft.webSearch.engine) && (
            <Field label={t('rag.apiKey')} help={data.hasSearchKey ? t('rag.keyStored') : undefined}>
              <input className={input} type="password" autoComplete="off" value={keys.searchKey} onChange={(ev) => setKeys({ ...keys, searchKey: ev.target.value })} />
            </Field>
          )}
          {draft.webSearch.engine === 'google_pse' && (
            <Field label={t('rag.cx')}>
              <input className={input} value={draft.webSearch.cx} onChange={(ev) => set('webSearch', { ...draft.webSearch, cx: ev.target.value })} />
            </Field>
          )}
          {draft.webSearch.engine !== 'none' && (
            <Field label={t('rag.resultCount')}>
              <input
                type="number"
                className={input}
                min={1}
                max={10}
                value={draft.webSearch.resultCount}
                onChange={(ev) => set('webSearch', { ...draft.webSearch, resultCount: Math.min(10, Math.max(1, Number(ev.target.value) || 1)) })}
              />
            </Field>
          )}
        </div>
        {draft.webSearch.engine !== 'none' && (
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={draft.webSearch.fetchPages} onChange={(ev) => set('webSearch', { ...draft.webSearch, fetchPages: ev.target.checked })} />
            {t('rag.fetchPages')}
          </label>
        )}
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={() => void submit()} disabled={saveState.isLoading} data-testid="rag-save">
          {t('app.save')}
        </Button>
        {saved && <span className="text-sm text-success">{saved}</span>}
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
