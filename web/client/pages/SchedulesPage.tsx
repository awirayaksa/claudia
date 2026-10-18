import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { CRON_PRESETS, type ScheduleInput, type ScheduleView } from '@shared/schedules';
import { ARENA_MODEL_ID } from '@shared/arena';
import {
  errorMessage,
  useCreateScheduleMutation,
  useDeleteScheduleMutation,
  useModelsQuery,
  useRunScheduleMutation,
  useSchedulesQuery,
  useUpdateScheduleMutation,
} from '../api/rtk-api';
import { PageFrame } from '../components/PageFrame';

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** Prompts that run on a schedule; each reply lands in a chat. */
export function SchedulesPage() {
  const { t } = useTranslation();
  const { data, error } = useSchedulesQuery();
  const [editing, setEditing] = useState<ScheduleView | 'new' | null>(null);
  const [toDelete, setToDelete] = useState<ScheduleView | null>(null);
  const [update] = useUpdateScheduleMutation();
  const [run, runState] = useRunScheduleMutation();
  const [remove] = useDeleteScheduleMutation();

  return (
    <PageFrame title={t('schedules.title')} actions={<Button onClick={() => setEditing('new')}>{t('schedules.new')}</Button>}>
      <p className="mb-4 text-sm text-text-secondary">{t('schedules.help')}</p>
      {error && <p className="text-sm text-error">{errorMessage(error)}</p>}
      {data?.schedules.length === 0 && <p className="text-sm text-text-secondary">{t('schedules.none')}</p>}
      <ul className="space-y-2" data-testid="schedules">
        {data?.schedules.map((s) => (
          <li key={s.id} className="rounded-lg border border-border bg-surface p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{s.name}</span>
              <code className="text-xs text-text-secondary">
                {s.cron} · {s.timezone}
              </code>
              <label className="ml-auto flex items-center gap-1 text-sm">
                <input type="checkbox" checked={s.enabled} onChange={(e) => void update({ id: s.id, enabled: e.target.checked })} />
                {t('webhooks.enabled')}
              </label>
              <Button size="sm" variant="secondary" disabled={runState.isLoading} onClick={() => void run(s.id)}>
                {t('schedules.runNow')}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setEditing(s)}>
                {t('app.edit')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setToDelete(s)}>
                {t('app.delete')}
              </Button>
            </div>
            <p className="mt-1 truncate text-sm text-text-secondary">{s.prompt}</p>
            <p className="mt-1 text-xs text-text-secondary">
              {s.enabled && s.nextRunAt ? t('schedules.next', { when: new Date(s.nextRunAt).toLocaleString() }) : t('schedules.paused')}
              {s.lastRunAt && (
                <>
                  {' · '}
                  {t('schedules.last', { when: new Date(s.lastRunAt).toLocaleString(), status: t(`schedules.status.${s.lastStatus ?? 'started'}`) })}
                  {s.lastChatId && (
                    <>
                      {' · '}
                      <Link className="text-accent hover:underline" to={`/c/${s.lastChatId}`}>
                        {t('schedules.openChat')}
                      </Link>
                    </>
                  )}
                </>
              )}
            </p>
            {s.lastError && <p className="mt-1 text-xs text-error">{s.lastError}</p>}
          </li>
        ))}
      </ul>
      {runState.error && <p className="mt-2 text-sm text-error">{errorMessage(runState.error)}</p>}
      {editing && <ScheduleForm schedule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        isOpen={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={async () => {
          if (toDelete) await remove(toDelete.id);
          setToDelete(null);
        }}
        title={t('schedules.deleteTitle')}
        message={t('schedules.deleteBody', { name: toDelete?.name ?? '' })}
        confirmText={t('app.delete')}
        isDestructive
      />
    </PageFrame>
  );
}

function ScheduleForm({ schedule, onClose }: { schedule: ScheduleView | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { data: modelsData } = useModelsQuery();
  const models = (modelsData?.models ?? []).filter((m) => m.id !== ARENA_MODEL_ID);
  const [draft, setDraft] = useState<ScheduleInput>({
    name: schedule?.name ?? '',
    prompt: schedule?.prompt ?? '',
    modelId: schedule?.modelId ?? modelsData?.defaultModel ?? models[0]?.id ?? '',
    cron: schedule?.cron ?? CRON_PRESETS[0].cron,
    timezone: schedule?.timezone ?? browserZone(),
    chatMode: schedule?.chatMode ?? 'new',
    webSearch: schedule?.webSearch ?? false,
    enabled: schedule?.enabled ?? true,
  });
  const preset = CRON_PRESETS.find((p) => p.cron === draft.cron)?.id ?? 'custom';
  const [create, createState] = useCreateScheduleMutation();
  const [update, updateState] = useUpdateScheduleMutation();
  const err = createState.error ?? updateState.error;
  const set = (patch: Partial<ScheduleInput>) => setDraft((d) => ({ ...d, ...patch }));
  // The models may arrive after the form opens: start from the default one
  const fallbackModel = modelsData?.defaultModel ?? models[0]?.id;
  useEffect(() => {
    if (fallbackModel) setDraft((d) => (d.modelId ? d : { ...d, modelId: fallbackModel }));
  }, [fallbackModel]);

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={schedule ? t('schedules.edit') : t('schedules.new')}
      size="lg"
      footer={
        <div className="flex items-center justify-end gap-2">
          {err && <span className="mr-auto text-sm text-error">{errorMessage(err)}</span>}
          <Button variant="secondary" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button
            disabled={!draft.name?.trim() || !draft.prompt?.trim() || !draft.modelId}
            onClick={async () => {
              const res = schedule ? await update({ id: schedule.id, ...draft }) : await create(draft);
              if ('data' in res) onClose();
            }}
          >
            {t('app.save')}
          </Button>
        </div>
      }
    >
      <div className="space-y-3 text-sm">
        <label className="block">
          <span className="mb-1 block font-medium">{t('schedules.name')}</span>
          <input className="w-full rounded border border-border bg-background px-2 py-1" value={draft.name} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label className="block">
          <span className="mb-1 block font-medium">{t('schedules.prompt')}</span>
          <textarea className="w-full rounded border border-border bg-background px-2 py-1" rows={4} value={draft.prompt} onChange={(e) => set({ prompt: e.target.value })} />
        </label>
        <label className="block">
          <span className="mb-1 block font-medium">{t('schedules.model')}</span>
          <select className="w-full rounded border border-border bg-background px-2 py-1" value={draft.modelId} onChange={(e) => set({ modelId: e.target.value })}>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block font-medium">{t('schedules.when')}</span>
            <select
              className="w-full rounded border border-border bg-background px-2 py-1"
              value={preset}
              onChange={(e) => {
                const p = CRON_PRESETS.find((x) => x.id === e.target.value);
                if (p) set({ cron: p.cron });
              }}
            >
              {CRON_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {t(`schedules.presets.${p.id}`)}
                </option>
              ))}
              <option value="custom">{t('schedules.presets.custom')}</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block font-medium">{t('schedules.cron')}</span>
            <input className="w-full rounded border border-border bg-background px-2 py-1 font-mono" value={draft.cron} onChange={(e) => set({ cron: e.target.value })} />
          </label>
        </div>
        <label className="block">
          <span className="mb-1 block font-medium">{t('schedules.timezone')}</span>
          <input className="w-full rounded border border-border bg-background px-2 py-1" value={draft.timezone} onChange={(e) => set({ timezone: e.target.value })} />
        </label>
        <fieldset>
          <legend className="mb-1 font-medium">{t('schedules.where')}</legend>
          {(['new', 'same'] as const).map((m) => (
            <label key={m} className="mr-4 inline-flex items-center gap-1">
              <input type="radio" name="chatMode" checked={draft.chatMode === m} onChange={() => set({ chatMode: m })} />
              {t(`schedules.chatMode.${m}`)}
            </label>
          ))}
        </fieldset>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={draft.webSearch} onChange={(e) => set({ webSearch: e.target.checked })} />
          {t('schedules.webSearch')}
        </label>
        <p className="text-xs text-text-secondary">{t('schedules.cronHelp')}</p>
      </div>
    </Modal>
  );
}
