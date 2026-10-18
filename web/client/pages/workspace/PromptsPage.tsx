import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Modal } from '@/components/common/Modal';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import type { PromptInput, PromptView } from '@shared/workspace';
import { templateVariables } from '@shared/prompts';
import {
  errorMessage,
  useCreatePromptMutation,
  useDeletePromptMutation,
  usePermissions,
  usePromptsQuery,
  useUpdatePromptMutation,
} from '../../api/rtk-api';
import { AccessDialog } from '../../workspace/AccessDialog';

/** The prompt library: /commands that put text (with {{variables}}) into the message box. */
export function PromptsPage() {
  const { t } = useTranslation();
  const permissions = usePermissions();
  const { data, isLoading } = usePromptsQuery({ scope: 'all' });
  const [remove] = useDeletePromptMutation();
  const [editing, setEditing] = useState<PromptView | 'new' | null>(null);
  const [sharing, setSharing] = useState<PromptView | null>(null);
  const [toDelete, setToDelete] = useState<PromptView | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-text-secondary">{t('workspace.promptsHelp')}</p>
        {permissions?.['workspace.prompts'] && (
          <Button size="sm" onClick={() => setEditing('new')}>
            {t('workspace.newPrompt')}
          </Button>
        )}
      </div>
      <ul className="divide-y divide-border rounded-lg border border-border bg-surface" data-testid="prompts">
        {isLoading && <li className="p-4 text-sm text-text-secondary">{t('app.loading')}</li>}
        {data?.prompts.length === 0 && <li className="p-4 text-sm text-text-secondary">{t('workspace.noPrompts')}</li>}
        {data?.prompts.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid={`prompt-${p.command}`}>
            <div className="min-w-0 flex-1">
              <div className="truncate">
                <span className="font-mono font-medium">/{p.command}</span> <span className="text-text-secondary">{p.title}</span>
              </div>
              <div className="truncate text-xs text-text-secondary">
                {p.description || p.body.slice(0, 120)}
                {!p.access.manage && ` · ${t('workspace.by', { name: p.ownerName })}`}
              </div>
            </div>
            {p.access.write && (
              <Button size="sm" variant="secondary" onClick={() => setEditing(p)}>
                {t('app.edit')}
              </Button>
            )}
            {p.access.manage && (
              <>
                <Button size="sm" variant="secondary" onClick={() => setSharing(p)}>
                  {t('access.share')}
                </Button>
                <Button size="sm" variant="ghost" className="text-error" onClick={() => setToDelete(p)}>
                  {t('app.delete')}
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
      {editing && <PromptModal prompt={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {sharing && <AccessDialog kind="prompts" id={sharing.id} name={`/${sharing.command}`} onClose={() => setSharing(null)} />}
      <ConfirmDialog
        isOpen={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={async () => {
          if (toDelete) await remove(toDelete.id);
          setToDelete(null);
        }}
        title={t('workspace.deletePromptTitle')}
        message={t('workspace.deletePromptBody', { command: toDelete?.command ?? '' })}
        confirmText={t('app.delete')}
        cancelText={t('app.cancel')}
        isDestructive
      />
    </div>
  );
}

function PromptModal({ prompt, onClose }: { prompt: PromptView | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [create, createState] = useCreatePromptMutation();
  const [update, updateState] = useUpdatePromptMutation();
  const [draft, setDraft] = useState<PromptInput>({
    command: prompt?.command ?? '',
    title: prompt?.title ?? '',
    description: prompt?.description ?? '',
    body: prompt?.body ?? '',
  });
  const vars = templateVariables(draft.body);
  const error = errorMessage(createState.error ?? updateState.error);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const res = prompt ? await update({ id: prompt.id, ...draft }) : await create(draft);
    if (!('error' in res)) onClose();
  };

  return (
    <Modal isOpen onClose={onClose} title={prompt ? t('workspace.editPrompt') : t('workspace.newPrompt')} size="lg">
      <form className="space-y-3" onSubmit={submit} data-testid="prompt-form">
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label={t('workspace.command')}
            value={draft.command}
            placeholder="email-reply"
            onChange={(e) => setDraft({ ...draft, command: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })}
            required
          />
          <Input label={t('workspace.promptTitle')} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} required />
        </div>
        <Input
          label={t('workspace.description')}
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        />
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t('workspace.promptBody')}</span>
          <textarea
            className="w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-xs"
            rows={8}
            value={draft.body}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            required
            data-testid="prompt-body"
          />
          <span className="mt-1 block text-xs text-text-secondary">{t('workspace.promptBodyHelp')}</span>
        </label>
        {vars.length > 0 && (
          <p className="text-xs text-text-secondary">
            {t('workspace.asksFor')} {vars.map((v) => v.name).join(', ')}
          </p>
        )}
        {error && <p className="text-sm text-error">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button type="submit" size="sm" disabled={createState.isLoading || updateState.isLoading}>
            {t('app.save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
