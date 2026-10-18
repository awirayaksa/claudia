import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import type { Folder } from '@shared/chats';
import { errorMessage, useKnowledgeListQuery, useUpdateFolderMutation } from '../api/rtk-api';

/** A folder's system prompt and knowledge bases, for every chat in it and its subfolders. */
export function FolderSettings({ folder, onClose }: { folder: Folder; onClose: () => void }) {
  const { t } = useTranslation();
  const { data: kbs } = useKnowledgeListQuery();
  const [update, state] = useUpdateFolderMutation();
  const [systemPrompt, setSystemPrompt] = useState(folder.systemPrompt ?? '');
  const [knowledgeIds, setKnowledgeIds] = useState<string[]>(folder.knowledgeIds ?? []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const res = await update({ id: folder.id, systemPrompt: systemPrompt.trim() ? systemPrompt : null, knowledgeIds });
    if (!('error' in res)) onClose();
  };

  return (
    <Modal isOpen onClose={onClose} title={t('folder.settingsTitle', { name: folder.name })}>
      <form className="space-y-4" onSubmit={submit} data-testid="folder-settings">
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t('chat.params.systemPrompt')}</span>
          <textarea
            className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
            rows={4}
            value={systemPrompt}
            placeholder={t('folder.systemPromptPlaceholder')}
            onChange={(e) => setSystemPrompt(e.target.value)}
          />
        </label>
        <div className="text-sm">
          <span className="mb-1 block font-medium">{t('folder.knowledge')}</span>
          <span className="mb-2 block text-xs text-text-secondary">{t('folder.knowledgeHelp')}</span>
          {(kbs?.knowledge.length ?? 0) === 0 ? (
            <p className="text-xs text-text-secondary">{t('folder.noKnowledge')}</p>
          ) : (
            <div className="grid max-h-48 gap-1 overflow-y-auto sm:grid-cols-2">
              {kbs!.knowledge.map((k) => (
                <label key={k.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={knowledgeIds.includes(k.id)}
                    onChange={(e) => setKnowledgeIds(e.target.checked ? [...knowledgeIds, k.id] : knowledgeIds.filter((x) => x !== k.id))}
                  />
                  <span className="truncate">{k.name}</span>
                </label>
              ))}
            </div>
          )}
        </div>
        {state.error && <p className="text-sm text-error">{errorMessage(state.error)}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button type="submit" size="sm" disabled={state.isLoading}>
            {t('app.save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
