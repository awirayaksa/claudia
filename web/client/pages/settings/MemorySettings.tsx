import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { useSettingsSection } from '@/components/settings/SettingsDraft';
import {
  errorMessage,
  useAddMemoryMutation,
  useClearMemoriesMutation,
  useDeleteMemoryMutation,
  useMemoriesQuery,
  useMySettingsQuery,
  useUpdateMemoryMutation,
  useUpdateMySettingsMutation,
} from '../../api/rtk-api';

/** Things every chat should know about you. */
export function MemorySettings() {
  const { t } = useTranslation();
  const { data } = useMemoriesQuery();
  const { data: settings } = useMySettingsQuery();
  const [updateSettings] = useUpdateMySettingsMutation();
  const [add, addState] = useAddMemoryMutation();
  const [update] = useUpdateMemoryMutation();
  const [remove] = useDeleteMemoryMutation();
  const [clear] = useClearMemoriesMutation();
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<{ id: string; content: string } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const saved = settings?.settings.memory?.enabled !== false;
  // The switch is a setting: stored with the page's Save (the memories below are saved as you edit them)
  const [draft, setDraft] = useState<boolean | null>(null);
  const enabled = draft ?? saved;
  useSettingsSection('memory', {
    dirty: draft !== null && draft !== saved,
    save: async () => {
      await updateSettings({ memory: { enabled } }).unwrap();
      setDraft(null);
    },
    discard: () => setDraft(null),
  });

  return (
    <div className="space-y-4 p-5">
      <p className="text-sm text-text-secondary">{t('memory.help')}</p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setDraft(e.target.checked)}
          data-testid="memory-enabled"
        />
        {t('memory.enabled')}
      </label>
      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!text.trim()) return;
          const res = await add(text.trim());
          if (!('error' in res)) setText('');
        }}
      >
        <input
          className="min-w-0 flex-1 rounded border border-border bg-background px-3 py-2 text-sm"
          placeholder={t('memory.placeholder')}
          aria-label={t('memory.add')}
          maxLength={1000}
          value={text}
          onChange={(e) => setText(e.target.value)}
          data-testid="memory-input"
        />
        <Button type="submit" size="sm" disabled={!text.trim() || addState.isLoading}>
          {t('memory.add')}
        </Button>
      </form>
      {addState.error && <p className="text-sm text-error">{errorMessage(addState.error)}</p>}
      <ul className="divide-y divide-border rounded border border-border" data-testid="memories">
        {data?.memories.length === 0 && <li className="px-3 py-2 text-sm text-text-secondary">{t('memory.none')}</li>}
        {data?.memories.map((m) => (
          <li key={m.id} className="flex items-center gap-2 px-3 py-2 text-sm">
            {editing?.id === m.id ? (
              <form
                className="flex min-w-0 flex-1 gap-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (editing.content.trim()) await update({ id: m.id, content: editing.content.trim() });
                  setEditing(null);
                }}
              >
                <input
                  className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1"
                  autoFocus
                  maxLength={1000}
                  value={editing.content}
                  onChange={(e) => setEditing({ id: m.id, content: e.target.value })}
                  aria-label={t('memory.edit')}
                />
                <Button type="submit" size="sm">
                  {t('app.save')}
                </Button>
              </form>
            ) : (
              <>
                <span className="min-w-0 flex-1 break-words">{m.content}</span>
                <button className="text-xs text-text-secondary hover:text-accent" onClick={() => setEditing({ id: m.id, content: m.content })}>
                  {t('app.edit')}
                </button>
                <button className="text-xs text-error hover:underline" onClick={() => void remove(m.id)}>
                  {t('app.delete')}
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      {(data?.memories.length ?? 0) > 0 && (
        <Button size="sm" variant="ghost" className="text-error" onClick={() => setConfirmClear(true)}>
          {t('memory.clear')}
        </Button>
      )}
      <ConfirmDialog
        isOpen={confirmClear}
        onClose={() => setConfirmClear(false)}
        onConfirm={async () => {
          await clear();
          setConfirmClear(false);
        }}
        title={t('memory.clearTitle')}
        message={t('memory.clearBody', { count: data?.memories.length ?? 0 })}
        confirmText={t('app.delete')}
        cancelText={t('app.cancel')}
        isDestructive
      />
    </div>
  );
}
