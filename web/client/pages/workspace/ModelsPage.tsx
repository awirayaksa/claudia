import { useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Modal } from '@/components/common/Modal';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import type { CustomModelInput, CustomModelParams, CustomModelView } from '@shared/workspace';
import {
  errorMessage,
  useCreateWorkspaceModelMutation,
  useDeleteWorkspaceModelMutation,
  useMcpServersQuery,
  useModelsQuery,
  usePermissions,
  useUpdateWorkspaceModelMutation,
  useWorkspaceModelsQuery,
} from '../../api/rtk-api';
import { AccessDialog } from '../../workspace/AccessDialog';

const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;

/** Custom models: an assistant on a base model with its own prompt, parameters and tools. */
export function ModelsPage() {
  const { t } = useTranslation();
  const permissions = usePermissions();
  const { data, isLoading } = useWorkspaceModelsQuery();
  const [remove] = useDeleteWorkspaceModelMutation();
  const [editing, setEditing] = useState<CustomModelView | 'new' | null>(null);
  const [sharing, setSharing] = useState<CustomModelView | null>(null);
  const [toDelete, setToDelete] = useState<CustomModelView | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-text-secondary">{t('workspace.modelsHelp')}</p>
        {permissions?.['workspace.models'] && (
          <Button size="sm" onClick={() => setEditing('new')}>
            {t('workspace.newModel')}
          </Button>
        )}
      </div>
      <ul className="grid gap-3 sm:grid-cols-2" data-testid="custom-models">
        {isLoading && <li className="text-sm text-text-secondary">{t('app.loading')}</li>}
        {data?.models.length === 0 && <li className="text-sm text-text-secondary">{t('workspace.noModels')}</li>}
        {data?.models.map((m) => (
          <li key={m.id} className="flex flex-col rounded-lg border border-border bg-surface p-4" data-testid={`custom-model-${m.name}`}>
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">
                  {m.name}
                  {!m.active && <span className="ml-2 text-xs font-normal text-text-secondary">({t('workspace.inactive')})</span>}
                </div>
                <div className="truncate text-xs text-text-secondary">
                  {m.baseModelId}
                  {!m.access.manage && ` · ${t('workspace.by', { name: m.ownerName })}`}
                </div>
              </div>
            </div>
            {m.description && <p className="mt-2 line-clamp-2 text-sm text-text-secondary">{m.description}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              {m.access.write && (
                <Button size="sm" variant="secondary" onClick={() => setEditing(m)}>
                  {t('app.edit')}
                </Button>
              )}
              {m.access.manage && (
                <>
                  <Button size="sm" variant="secondary" onClick={() => setSharing(m)}>
                    {t('access.share')}
                  </Button>
                  <Button size="sm" variant="ghost" className="text-error" onClick={() => setToDelete(m)}>
                    {t('app.delete')}
                  </Button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
      {editing && <ModelModal model={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {sharing && <AccessDialog kind="models" id={sharing.id} name={sharing.name} onClose={() => setSharing(null)} />}
      <ConfirmDialog
        isOpen={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={async () => {
          if (toDelete) await remove(toDelete.id);
          setToDelete(null);
        }}
        title={t('workspace.deleteModelTitle')}
        message={t('workspace.deleteModelBody', { name: toDelete?.name ?? '' })}
        confirmText={t('app.delete')}
        cancelText={t('app.cancel')}
        isDestructive
      />
    </div>
  );
}

function Field({ label, children, help }: { label: string; children: ReactNode; help?: string }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      {children}
      {help && <span className="mt-1 block text-xs text-text-secondary">{help}</span>}
    </label>
  );
}

const inputClass = 'w-full rounded border border-border bg-background px-2 py-1.5 text-sm';

function ModelModal({ model, onClose }: { model: CustomModelView | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { data: models } = useModelsQuery();
  const { data: servers } = useMcpServersQuery();
  const [create, createState] = useCreateWorkspaceModelMutation();
  const [update, updateState] = useUpdateWorkspaceModelMutation();
  const bases = (models?.models ?? []).filter((m) => !m.custom && !m.own);
  const [draft, setDraft] = useState<CustomModelInput>({
    name: model?.name ?? '',
    description: model?.description ?? '',
    baseModelId: model?.baseModelId ?? bases[0]?.id ?? '',
    systemPrompt: model?.systemPrompt ?? '',
    params: model?.params ?? {},
    toolIds: model?.toolIds ?? [],
    suggestions: model?.suggestions ?? [],
    active: model?.active ?? true,
  });
  const [suggestionsText, setSuggestionsText] = useState((model?.suggestions ?? []).join('\n'));
  const error = errorMessage(createState.error ?? updateState.error);

  const setParam = <K extends keyof CustomModelParams>(key: K, raw: string) => {
    const params = { ...draft.params };
    if (raw === '') delete params[key];
    else params[key] = (key === 'effort' ? raw : Number(raw)) as CustomModelParams[K];
    setDraft({ ...draft, params });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body: CustomModelInput = {
      ...draft,
      suggestions: suggestionsText
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 8),
    };
    const res = model ? await update({ id: model.id, ...body }) : await create(body);
    if (!('error' in res)) onClose();
  };

  return (
    <Modal isOpen onClose={onClose} title={model ? t('workspace.editModel') : t('workspace.newModel')} size="lg">
      <form className="space-y-4" onSubmit={submit} data-testid="model-form">
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label={t('workspace.name')} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} required />
          <Field label={t('workspace.baseModel')}>
            <select
              className={inputClass}
              value={draft.baseModelId}
              onChange={(e) => setDraft({ ...draft, baseModelId: e.target.value })}
              data-testid="base-model"
            >
              {!bases.some((b) => b.id === draft.baseModelId) && draft.baseModelId && (
                <option value={draft.baseModelId}>{draft.baseModelId}</option>
              )}
              {bases.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name === b.id ? b.id : `${b.name} (${b.id})`}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Input
          label={t('workspace.description')}
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        />
        <Field label={t('workspace.systemPrompt')} help={t('workspace.systemPromptHelp')}>
          <textarea
            className={`${inputClass} font-mono text-xs`}
            rows={6}
            value={draft.systemPrompt}
            onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
            data-testid="model-system-prompt"
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-3">
          {(
            [
              ['temperature', 0, 2, 0.1],
              ['topP', 0, 1, 0.05],
              ['maxTokens', 1, 1_000_000, 1],
              ['frequencyPenalty', -2, 2, 0.1],
              ['presencePenalty', -2, 2, 0.1],
            ] as const
          ).map(([key, min, max, step]) => (
            <Field key={key} label={t(`chat.params.${key}`)}>
              <input
                type="number"
                className={inputClass}
                min={min}
                max={max}
                step={step}
                placeholder={t('workspace.default')}
                value={draft.params[key] ?? ''}
                onChange={(e) => setParam(key, e.target.value)}
              />
            </Field>
          ))}
          <Field label={t('workspace.effort')}>
            <select className={inputClass} value={draft.params.effort ?? ''} onChange={(e) => setParam('effort', e.target.value)}>
              <option value="">{t('workspace.default')}</option>
              {EFFORTS.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {(servers?.servers.length ?? 0) > 0 && (
          <Field label={t('workspace.tools')} help={t('workspace.toolsHelp')}>
            <div className="grid gap-1 sm:grid-cols-2">
              {servers!.servers.map((s) => (
                <label key={s.id} className="flex items-center gap-2 text-sm font-normal">
                  <input
                    type="checkbox"
                    checked={draft.toolIds.includes(s.id)}
                    onChange={(e) =>
                      setDraft({ ...draft, toolIds: e.target.checked ? [...draft.toolIds, s.id] : draft.toolIds.filter((x) => x !== s.id) })
                    }
                  />
                  {s.name}
                </label>
              ))}
            </div>
          </Field>
        )}

        <Field label={t('workspace.suggestions')} help={t('workspace.suggestionsHelp')}>
          <textarea className={inputClass} rows={3} value={suggestionsText} onChange={(e) => setSuggestionsText(e.target.value)} />
        </Field>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
          {t('workspace.active')}
        </label>

        {error && <p className="text-sm text-error">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button type="submit" size="sm" disabled={createState.isLoading || updateState.isLoading || !draft.baseModelId}>
            {t('app.save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
