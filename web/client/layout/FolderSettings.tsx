import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import type { Folder } from '@shared/chats';
import { errorMessage, useKnowledgeListQuery, useUpdateFolderMutation } from '../api/rtk-api';
import { AccessDialog } from '../workspace/AccessDialog';

/**
 * A folder's system prompt and knowledge bases, for every chat in it and its
 * subfolders. Read-only for people it was shared with as viewers; its owner
 * shares it from here too.
 */
export function FolderSettings({ folder, onClose }: { folder: Folder; onClose: () => void }) {
  const { t } = useTranslation();
  const { data: kbs } = useKnowledgeListQuery();
  const [update, state] = useUpdateFolderMutation();
  const [systemPrompt, setSystemPrompt] = useState(folder.systemPrompt ?? '');
  const [knowledgeIds, setKnowledgeIds] = useState<string[]>(folder.knowledgeIds ?? []);
  const [sharing, setSharing] = useState(false);
  const readOnly = !folder.canEdit;
  const mineToPick = kbs?.knowledge ?? [];
  // Knowledge the owner attached that this user can't list (it still applies to their chats)
  const others = (folder.knowledgeIds ?? []).filter((id) => !mineToPick.some((k) => k.id === id)).length;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const res = await update({ id: folder.id, systemPrompt: systemPrompt.trim() ? systemPrompt : null, knowledgeIds });
    if (!('error' in res)) onClose();
  };

  if (sharing) return <AccessDialog kind="folders" id={folder.id} name={folder.name} onClose={() => setSharing(false)} />;

  return (
    <Modal isOpen onClose={onClose} title={t('folder.settingsTitle', { name: folder.name })}>
      <form className="space-y-4" onSubmit={submit} data-testid="folder-settings">
        {!folder.mine && (
          <p className="rounded border border-border px-3 py-2 text-xs text-text-secondary" data-testid="folder-shared-note">
            {t(readOnly ? 'folder.sharedViewer' : 'folder.sharedEditor', { name: folder.ownerName ?? '' })}
          </p>
        )}
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t('chat.params.systemPrompt')}</span>
          <textarea
            className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm disabled:opacity-70"
            rows={4}
            value={systemPrompt}
            disabled={readOnly}
            placeholder={t('folder.systemPromptPlaceholder')}
            onChange={(e) => setSystemPrompt(e.target.value)}
          />
        </label>
        <div className="text-sm">
          <span className="mb-1 block font-medium">{t('folder.knowledge')}</span>
          <span className="mb-2 block text-xs text-text-secondary">{t('folder.knowledgeHelp')}</span>
          {mineToPick.length === 0 && others === 0 ? (
            <p className="text-xs text-text-secondary">{t('folder.noKnowledge')}</p>
          ) : (
            <div className="grid max-h-48 gap-1 overflow-y-auto sm:grid-cols-2">
              {mineToPick.map((k) => (
                <label key={k.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    disabled={readOnly}
                    checked={knowledgeIds.includes(k.id)}
                    onChange={(e) => setKnowledgeIds(e.target.checked ? [...knowledgeIds, k.id] : knowledgeIds.filter((x) => x !== k.id))}
                  />
                  <span className="truncate">{k.name}</span>
                </label>
              ))}
            </div>
          )}
          {others > 0 && <p className="mt-1 text-xs text-text-secondary">{t('folder.ownerKnowledge', { count: others })}</p>}
        </div>
        {state.error && <p className="text-sm text-error">{errorMessage(state.error)}</p>}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {folder.canManage && (
            <Button type="button" variant="ghost" size="sm" className="me-auto" onClick={() => setSharing(true)}>
              {t('folder.share')}
            </Button>
          )}
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            {readOnly ? t('app.close') : t('app.cancel')}
          </Button>
          {!readOnly && (
            <Button type="submit" size="sm" disabled={state.isLoading}>
              {t('app.save')}
            </Button>
          )}
        </div>
      </form>
    </Modal>
  );
}
