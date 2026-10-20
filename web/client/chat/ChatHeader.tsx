/**
 * Above the messages: the chat's title, the temporary-chat switch (before
 * the first message) or badge, per-chat settings, sharing and export.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Modal } from '@/components/common/Modal';
import { useAppSelector } from '@/store';
import type { ChatDetail, ChatParams } from '@shared/chats';
import { errorMessage, usePermissions, useShareChatMutation, useUnshareChatMutation, useUpdateChatMutation } from '../api/rtk-api';
import { Menu } from '../components/Menu';
import { DotsIcon, GhostIcon, ShareIcon, SlidersIcon } from '../components/icons';
import { downloadFrom } from './download';
import { copyText } from '@/utils/clipboard';

export function ChatHeader({
  chat,
  temporary,
  onTemporaryChange,
}: {
  chat?: ChatDetail;
  /** Before the first message: whether the new chat will be temporary. */
  temporary: boolean;
  onTemporaryChange: (on: boolean) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const sidebarOpen = useAppSelector((s) => s.ui.sidebarOpen);
  const [updateChat] = useUpdateChatMutation();
  const [dialog, setDialog] = useState<'settings' | 'share' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const permissions = usePermissions();

  const iconBtn = 'rounded p-2 text-text-secondary hover:bg-surface hover:text-text-primary';
  const isTemporary = chat ? chat.temporary : temporary;

  return (
    <header className={`flex h-12 shrink-0 items-center gap-1 px-3 ${sidebarOpen ? '' : 'md:pl-14'}`}>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {chat && !chat.temporary && (
          <h1 className="truncate text-sm font-medium" title={chat.title} data-testid="chat-title">
            {chat.title}
          </h1>
        )}
        {isTemporary && (
          <span className="flex items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 text-xs text-text-secondary" data-testid="temporary-badge">
            <GhostIcon />
            {t('chat.temporary')}
          </span>
        )}
        {chat?.temporary && (
          <button
            className="text-xs text-accent hover:underline"
            onClick={() => void updateChat({ id: chat.id, temporary: false })}
            title={t('chat.keepHelp')}
          >
            {t('chat.keep')}
          </button>
        )}
        {error && (
          <span className="truncate text-xs text-error" role="alert">
            {error}
          </span>
        )}
      </div>

      {!chat && permissions?.['chat.temporary'] && (
        <button
          className={`${iconBtn} ${temporary ? 'bg-surface text-accent' : ''}`}
          aria-pressed={temporary}
          aria-label={t('chat.temporaryToggle')}
          title={t('chat.temporaryHelp')}
          onClick={() => onTemporaryChange(!temporary)}
          data-testid="temporary-toggle"
        >
          <GhostIcon />
        </button>
      )}
      {chat && (
        <>
          <button className={iconBtn} aria-label={t('chat.settings')} title={t('chat.settings')} onClick={() => setDialog('settings')}>
            <SlidersIcon />
          </button>
          {!chat.temporary && permissions?.['chat.share'] && (
            <button className={iconBtn} aria-label={t('chat.share')} title={t('chat.share')} onClick={() => setDialog('share')}>
              <ShareIcon />
            </button>
          )}
          <Menu
            label={t('chat.actions')}
            trigger={<DotsIcon />}
            items={[
              ...(permissions?.['chat.export']
                ? [
                    {
                      label: t('chat.export'),
                      onSelect: () =>
                        void downloadFrom(`/api/chats/${chat.id}/export`, 'claudia-chat.json').catch((e) => setError(errorMessage(e))),
                    },
                  ]
                : []),
              {
                label: chat.archived ? t('chat.unarchive') : t('chat.archive'),
                onSelect: async () => {
                  await updateChat({ id: chat.id, archived: !chat.archived });
                  if (!chat.archived) navigate('/');
                },
              },
            ]}
          />
          <ChatSettingsDialog chat={chat} open={dialog === 'settings'} onClose={() => setDialog(null)} />
          <ShareDialog chat={chat} open={dialog === 'share'} onClose={() => setDialog(null)} />
        </>
      )}
    </header>
  );
}

const NUMBER_FIELDS: Array<{ key: Exclude<keyof ChatParams, 'systemPrompt'>; min: number; max: number; step: number }> = [
  { key: 'temperature', min: 0, max: 2, step: 0.1 },
  { key: 'topP', min: 0, max: 1, step: 0.05 },
  { key: 'maxTokens', min: 1, max: 1_000_000, step: 1 },
  { key: 'frequencyPenalty', min: -2, max: 2, step: 0.1 },
  { key: 'presencePenalty', min: -2, max: 2, step: 0.1 },
];

/** System prompt and request parameters of this chat; empty fields use the defaults. */
function ChatSettingsDialog({ chat, open, onClose }: { chat: ChatDetail; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [updateChat, { isLoading }] = useUpdateChatMutation();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const value = (key: keyof ChatParams) => draft[key] ?? (chat.params[key] !== undefined ? String(chat.params[key]) : '');

  const save = async () => {
    setError(null);
    const params: Record<string, number | string | null> = {};
    for (const f of NUMBER_FIELDS) {
      const raw = value(f.key).trim();
      if (raw === '') params[f.key] = null;
      else {
        const n = Number(raw);
        if (!Number.isFinite(n) || n < f.min || n > f.max) {
          setError(t('chat.paramRange', { name: t(`chat.params.${f.key}`), min: f.min, max: f.max }));
          return;
        }
        params[f.key] = f.key === 'maxTokens' ? Math.round(n) : n;
      }
    }
    params.systemPrompt = value('systemPrompt').trim() ? value('systemPrompt') : null;
    try {
      await updateChat({ id: chat.id, params }).unwrap();
      setDraft({});
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={t('chat.settings')}
      footer={
        <div className="flex justify-end gap-2">
          <button className="rounded px-3 py-1.5 text-sm text-text-secondary hover:bg-background" onClick={onClose}>
            {t('app.cancel')}
          </button>
          <button className="rounded bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-50" disabled={isLoading} onClick={save}>
            {t('app.save')}
          </button>
        </div>
      }
    >
      <div className="space-y-4 text-sm">
        <label className="block">
          <span className="mb-1 block font-medium">{t('chat.params.systemPrompt')}</span>
          <textarea
            className="w-full rounded border border-border bg-background p-2 outline-none focus:border-accent"
            rows={5}
            value={value('systemPrompt')}
            placeholder={t('chat.systemPromptPlaceholder')}
            onChange={(e) => setDraft((d) => ({ ...d, systemPrompt: e.target.value }))}
          />
          <span className="text-xs text-text-secondary">{t('chat.systemPromptHelp')}</span>
        </label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {NUMBER_FIELDS.map((f) => (
            <label key={f.key} className="block">
              <span className="mb-1 block font-medium">{t(`chat.params.${f.key}`)}</span>
              <input
                type="number"
                inputMode="decimal"
                min={f.min}
                max={f.max}
                step={f.step}
                placeholder={t('chat.paramDefault')}
                className="w-full rounded border border-border bg-background px-2 py-1.5 outline-none focus:border-accent"
                value={value(f.key)}
                onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
              />
            </label>
          ))}
        </div>
        {error && (
          <p className="text-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

function ShareDialog({ chat, open, onClose }: { chat: ChatDetail; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [share, { isLoading: sharing }] = useShareChatMutation();
  const [unshare, { isLoading: removing }] = useUnshareChatMutation();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = chat.share ? `${window.location.origin}/s/${chat.share.token}` : null;

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Modal isOpen={open} onClose={onClose} title={t('chat.shareTitle')}>
      <div className="space-y-3 text-sm">
        <p className="text-text-secondary">{t('chat.shareHelp')}</p>
        {url ? (
          <>
            <div className="flex gap-2">
              <input
                readOnly
                className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5"
                value={url}
                aria-label={t('chat.shareLink')}
                onFocus={(e) => e.target.select()}
                data-testid="share-url"
              />
              <button
                className="rounded bg-accent px-3 py-1.5 text-white"
                onClick={async () => {
                  if (!(await copyText(url))) return;
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? t('chat.copied') : t('chat.copy')}
              </button>
            </div>
            <p className="text-xs text-text-secondary">
              {t('chat.sharedAt', { date: new Date(chat.share!.updatedAt).toLocaleString() })}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                className="rounded border border-border px-3 py-1.5 hover:border-accent disabled:opacity-50"
                disabled={sharing}
                onClick={() => run(() => share(chat.id).unwrap())}
              >
                {t('chat.shareUpdate')}
              </button>
              <button
                className="rounded border border-error/40 px-3 py-1.5 text-error hover:bg-error/10 disabled:opacity-50"
                disabled={removing}
                onClick={() => run(() => unshare(chat.id).unwrap())}
              >
                {t('chat.shareDelete')}
              </button>
            </div>
          </>
        ) : (
          <button
            className="rounded bg-accent px-3 py-1.5 text-white disabled:opacity-50"
            disabled={sharing}
            onClick={() => run(() => share(chat.id).unwrap())}
          >
            {t('chat.shareCreate')}
          </button>
        )}
        {error && (
          <p className="text-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
