import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { useSettingsSection } from '@/components/settings/SettingsDraft';
import { MEMORY_TOPICS, type MemoryTopic, type MemoryView } from '@shared/workspace';
import {
  errorMessage,
  useAddMemoryMutation,
  useClearMemoriesMutation,
  useDeleteMemoryMutation,
  useFoldersQuery,
  useImportMemoriesMutation,
  useMemoriesQuery,
  useMySettingsQuery,
  useUpdateMemoryMutation,
  useUpdateMySettingsMutation,
} from '../../api/rtk-api';

type Switches = { enabled: boolean; learn: boolean; sensitive: boolean };

const selectClass = 'rounded border border-border bg-background px-2 py-1 text-sm';

/** What chats know about you, by topic; how it is learned; importing another assistant's. */
export function MemorySettings() {
  const { t } = useTranslation();
  const { data } = useMemoriesQuery();
  const { data: settings } = useMySettingsQuery();
  const { data: folderData } = useFoldersQuery();
  const [updateSettings] = useUpdateMySettingsMutation();
  const [add, addState] = useAddMemoryMutation();
  const [clear] = useClearMemoriesMutation();
  const [text, setText] = useState('');
  const [topic, setTopic] = useState<MemoryTopic>('other');
  const [folderId, setFolderId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const folders = folderData?.folders ?? [];

  const own = settings?.settings.memory;
  const saved: Switches = { enabled: own?.enabled !== false, learn: own?.learn !== false, sensitive: own?.sensitive === true };
  // The switches are settings: stored with the page's Save (the memories below are saved as you edit them)
  const [draft, setDraft] = useState<Partial<Switches>>({});
  const value: Switches = { ...saved, ...draft };
  const changed = (Object.keys(draft) as Array<keyof Switches>).filter((k) => draft[k] !== saved[k]);
  useSettingsSection('memory', {
    dirty: changed.length > 0,
    save: async () => {
      await updateSettings({ memory: Object.fromEntries(changed.map((k) => [k, value[k]])) }).unwrap();
      setDraft({});
    },
    discard: () => setDraft({}),
  });
  const toggle = (key: keyof Switches) => (e: React.ChangeEvent<HTMLInputElement>) => setDraft((d) => ({ ...d, [key]: e.target.checked }));

  const memories = data?.memories ?? [];
  const byTopic = MEMORY_TOPICS.map((tp) => ({ topic: tp, items: memories.filter((m) => m.topic === tp) })).filter((g) => g.items.length > 0);

  return (
    <div className="space-y-4 p-5">
      <p className="text-sm text-text-secondary">{t('memory.help')}</p>
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={value.enabled} onChange={toggle('enabled')} data-testid="memory-enabled" />
          {t('memory.enabled')}
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5" checked={value.learn} disabled={!value.enabled} onChange={toggle('learn')} data-testid="memory-learn" />
          <span>
            {t('memory.learn')}
            <span className="block text-xs text-text-secondary">{t('memory.learnHelp')}</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={value.sensitive}
            disabled={!value.enabled || !value.learn}
            onChange={toggle('sensitive')}
            data-testid="memory-sensitive"
          />
          <span>
            {t('memory.sensitive')}
            <span className="block text-xs text-text-secondary">{t('memory.sensitiveHelp')}</span>
          </span>
        </label>
      </div>

      <form
        className="flex flex-wrap gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!text.trim()) return;
          const res = await add({ content: text.trim(), topic, folderId });
          if (!('error' in res)) setText('');
        }}
      >
        <input
          className="min-w-0 flex-1 basis-60 rounded border border-border bg-background px-3 py-2 text-sm"
          placeholder={t('memory.placeholder')}
          aria-label={t('memory.add')}
          maxLength={1000}
          value={text}
          onChange={(e) => setText(e.target.value)}
          data-testid="memory-input"
        />
        <TopicSelect value={topic} onChange={setTopic} />
        {folders.length > 0 && <FolderSelect value={folderId} onChange={setFolderId} folders={folders} />}
        <Button type="submit" size="sm" disabled={!text.trim() || addState.isLoading}>
          {t('memory.add')}
        </Button>
      </form>
      {addState.error && <p className="text-sm text-error">{errorMessage(addState.error)}</p>}

      <div className="space-y-3" data-testid="memories">
        {memories.length === 0 && <p className="rounded border border-border px-3 py-2 text-sm text-text-secondary">{t('memory.none')}</p>}
        {byTopic.map((g) => (
          <section key={g.topic} aria-label={t(`memory.topics.${g.topic}`)}>
            <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-text-secondary">{t(`memory.topics.${g.topic}`)}</h3>
            <ul className="divide-y divide-border rounded border border-border">
              {g.items.map((m) => (
                <MemoryItem key={m.id} memory={m} folders={folders} />
              ))}
            </ul>
          </section>
        ))}
      </div>
      {memories.length > 0 && (
        <Button size="sm" variant="ghost" className="text-error" onClick={() => setConfirmClear(true)}>
          {t('memory.clear')}
        </Button>
      )}

      <ImportMemories />

      <ConfirmDialog
        isOpen={confirmClear}
        onClose={() => setConfirmClear(false)}
        onConfirm={async () => {
          await clear();
          setConfirmClear(false);
        }}
        title={t('memory.clearTitle')}
        message={t('memory.clearBody', { count: memories.length })}
        confirmText={t('app.delete')}
        cancelText={t('app.cancel')}
        isDestructive
      />
    </div>
  );
}

function TopicSelect({ value, onChange }: { value: MemoryTopic; onChange: (t: MemoryTopic) => void }) {
  const { t } = useTranslation();
  return (
    <select className={selectClass} aria-label={t('memory.topic')} value={value} onChange={(e) => onChange(e.target.value as MemoryTopic)}>
      {MEMORY_TOPICS.map((tp) => (
        <option key={tp} value={tp}>
          {t(`memory.topics.${tp}`)}
        </option>
      ))}
    </select>
  );
}

function FolderSelect({ value, onChange, folders }: { value: string | null; onChange: (id: string | null) => void; folders: Array<{ id: string; name: string }> }) {
  const { t } = useTranslation();
  return (
    <select className={selectClass} aria-label={t('memory.scope')} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{t('memory.allChats')}</option>
      {folders.map((f) => (
        <option key={f.id} value={f.id}>
          {f.name}
        </option>
      ))}
    </select>
  );
}

function MemoryItem({ memory: m, folders }: { memory: MemoryView; folders: Array<{ id: string; name: string }> }) {
  const { t } = useTranslation();
  const [update] = useUpdateMemoryMutation();
  const [remove] = useDeleteMemoryMutation();
  const [editing, setEditing] = useState<{ content: string; topic: MemoryTopic } | null>(null);
  const folder = m.folderId ? folders.find((f) => f.id === m.folderId) : undefined;

  if (editing) {
    return (
      <li className="px-3 py-2 text-sm">
        <form
          className="flex flex-wrap gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (editing.content.trim()) await update({ id: m.id, content: editing.content.trim(), topic: editing.topic, folderId: m.folderId });
            setEditing(null);
          }}
        >
          <input
            className="min-w-0 flex-1 basis-60 rounded border border-border bg-background px-2 py-1"
            autoFocus
            maxLength={1000}
            value={editing.content}
            onChange={(e) => setEditing({ ...editing, content: e.target.value })}
            aria-label={t('memory.edit')}
          />
          <TopicSelect value={editing.topic} onChange={(topic) => setEditing({ ...editing, topic })} />
          <Button type="submit" size="sm">
            {t('app.save')}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>
            {t('app.cancel')}
          </Button>
        </form>
      </li>
    );
  }
  return (
    <li className="flex items-center gap-2 px-3 py-2 text-sm">
      <span className="min-w-0 flex-1 break-words">
        {m.content}
        {(m.source !== 'user' || folder) && (
          <span className="ms-2 inline-flex gap-1 align-middle">
            {m.source !== 'user' && (
              <span className="rounded-full border border-border px-1.5 text-[10px] text-text-secondary">{t(`memory.sources.${m.source}`)}</span>
            )}
            {folder && <span className="rounded-full border border-border px-1.5 text-[10px] text-text-secondary">{folder.name}</span>}
          </span>
        )}
      </span>
      <button className="text-xs text-text-secondary hover:text-accent" onClick={() => setEditing({ content: m.content, topic: m.topic })}>
        {t('app.edit')}
      </button>
      <button className="text-xs text-error hover:underline" onClick={() => void remove(m.id)}>
        {t('app.delete')}
      </button>
    </li>
  );
}

/** Paste another assistant's memory export (e.g. ChatGPT's "Manage memories" list). */
function ImportMemories() {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [run, state] = useImportMemoriesMutation();
  return (
    <details className="rounded border border-border p-3 text-sm">
      <summary className="cursor-pointer font-medium">{t('memory.import')}</summary>
      <p className="mt-2 text-text-secondary">{t('memory.importHelp')}</p>
      <form
        className="mt-2 space-y-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const res = await run(text);
          if (!('error' in res)) setText('');
        }}
      >
        <textarea
          className="w-full rounded border border-border bg-background p-2 font-mono text-xs"
          rows={6}
          maxLength={100_000}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label={t('memory.import')}
          data-testid="memory-import"
        />
        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" disabled={!text.trim() || state.isLoading}>
            {state.isLoading ? t('memory.importing') : t('memory.importButton')}
          </Button>
          {state.data && <span className="text-text-secondary">{t('memory.imported', { added: state.data.added, skipped: state.data.skipped })}</span>}
          {state.error && <span className="text-error">{errorMessage(state.error)}</span>}
        </div>
      </form>
    </details>
  );
}
