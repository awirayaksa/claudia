import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { CONVERSATION_SOURCES, type ConversationLogSetting, type ConversationTurnSummary } from '@shared/admin';
import {
  errorMessage,
  useAppSettingsQuery,
  useConversationLogQuery,
  useConversationTurnQuery,
  useUpdateAppSettingMutation,
} from '../../api/rtk-api';

const PAGE = 50;

/** Admin: what users sent to models and the replies (when recording is on), with its settings. */
export function ConversationsPage() {
  const { t } = useTranslation();
  const [user, setUser] = useState('');
  const [text, setText] = useState('');
  const [query, setQuery] = useState({ user: '', q: '' });
  const [source, setSource] = useState('');
  const [before, setBefore] = useState<string | undefined>(undefined);
  const [older, setOlder] = useState<ConversationTurnSummary[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  // Type, then search (not on every key)
  useEffect(() => {
    const id = setTimeout(() => setQuery({ user: user.trim(), q: text.trim() }), 300);
    return () => clearTimeout(id);
  }, [user, text]);
  useEffect(() => {
    setBefore(undefined);
    setOlder([]);
  }, [query, source]);

  const filters = { user: query.user || undefined, q: query.q || undefined, source: (source || undefined) as never, limit: PAGE };
  const { data, error, isFetching } = useConversationLogQuery({ ...filters, before });
  const turns = before ? [...older, ...(data?.turns ?? [])] : (data?.turns ?? []);
  const exportUrl = `/api/admin/conversations/export.csv?${new URLSearchParams(
    Object.entries({ user: query.user, q: query.q, source }).filter(([, v]) => v)
  )}`;

  const loadMore = () => {
    if (!data?.next) return;
    setOlder(turns);
    setBefore(data.next);
  };

  return (
    <div className="space-y-4" data-testid="conversations">
      <RecordingSettings />

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="mb-1 block text-text-secondary">{t('conversations.user')}</span>
          <input
            className="rounded border border-border bg-background px-2 py-1"
            placeholder={t('audit.actorPlaceholder')}
            value={user}
            onChange={(e) => setUser(e.target.value)}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-text-secondary">{t('conversations.search')}</span>
          <input
            className="rounded border border-border bg-background px-2 py-1"
            placeholder={t('conversations.searchPlaceholder')}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-text-secondary">{t('conversations.source')}</span>
          <select className="rounded border border-border bg-background px-2 py-1" value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">{t('conversations.allSources')}</option>
            {CONVERSATION_SOURCES.map((s) => (
              <option key={s} value={s}>
                {t(`conversations.sources.${s}`)}
              </option>
            ))}
          </select>
        </label>
        <a className="ms-auto text-sm text-accent underline" href={exportUrl} download>
          {t('analytics.exportCsv')}
        </a>
      </div>

      {error && <p className="text-sm text-error">{errorMessage(error)}</p>}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-start text-sm">
          <thead className="bg-surface text-xs text-text-secondary">
            <tr>
              <th className="px-3 py-2 font-normal">{t('audit.time')}</th>
              <th className="px-3 py-2 font-normal">{t('conversations.user')}</th>
              <th className="px-3 py-2 font-normal">{t('conversations.model')}</th>
              <th className="px-3 py-2 font-normal">{t('conversations.message')}</th>
            </tr>
          </thead>
          <tbody>
            {turns.map((turn) => (
              <TurnRow key={turn.id} turn={turn} open={open === turn.id} onToggle={() => setOpen(open === turn.id ? null : turn.id)} />
            ))}
            {turns.length === 0 && !isFetching && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-text-secondary">
                  {t('conversations.empty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {data?.next && (
        <Button variant="secondary" onClick={loadMore} disabled={isFetching}>
          {t('audit.older')}
        </Button>
      )}
    </div>
  );
}

/** Whether and what is recorded, and for how long. */
function RecordingSettings() {
  const { t } = useTranslation();
  const { data } = useAppSettingsQuery();
  const [save, state] = useUpdateAppSettingMutation();
  const [draft, setDraft] = useState<ConversationLogSetting | null>(null);
  const [saved, setSaved] = useState(false);
  const current = data?.settings['audit.conversations'];
  useEffect(() => {
    if (current) setDraft(current);
  }, [current]);
  if (!draft) return null;

  const set = (patch: Partial<ConversationLogSetting>) => {
    setSaved(false);
    setDraft({ ...draft, ...patch });
  };
  const changed = JSON.stringify(draft) !== JSON.stringify(current);
  const submit = async () => {
    const res = await save({ key: 'audit.conversations', value: draft });
    if (!('error' in res)) setSaved(true);
  };
  const sources = [
    ['chats', 'chat'],
    ['api', 'api'],
    ['channels', 'channel'],
  ] as const;

  return (
    <section className="rounded-lg border border-border bg-surface p-4" data-testid="conversation-recording">
      <label className="flex items-center gap-2 text-sm font-semibold">
        <input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        {t('conversations.enabled')}
      </label>
      <p className="mt-1 text-sm text-text-secondary">{t('conversations.help')}</p>
      <div className={`mt-3 flex flex-wrap items-end gap-x-6 gap-y-3 ${draft.enabled ? '' : 'opacity-60'}`}>
        <fieldset className="text-sm">
          <legend className="mb-1 text-text-secondary">{t('conversations.record')}</legend>
          <div className="flex flex-wrap gap-4">
            {sources.map(([key, label]) => (
              <label key={key} className="flex items-center gap-2">
                <input type="checkbox" disabled={!draft.enabled} checked={draft[key]} onChange={(e) => set({ [key]: e.target.checked })} />
                {t(`conversations.sources.${label}`)}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="text-sm">
          <span className="mb-1 block text-text-secondary">{t('conversations.retentionDays')}</span>
          <input
            type="number"
            min={1}
            max={3650}
            disabled={!draft.enabled}
            className="w-32 rounded border border-border bg-background px-2 py-1"
            value={draft.retentionDays}
            onChange={(e) => set({ retentionDays: Math.min(3650, Math.max(1, Number(e.target.value) || 1)) })}
          />
        </label>
      </div>
      <p className="mt-3 text-xs text-text-secondary">{t('conversations.privacyNote')}</p>
      <div className="mt-3 flex items-center gap-3">
        <Button onClick={() => void submit()} disabled={!changed || state.isLoading}>
          {t('app.save')}
        </Button>
        {saved && !changed && <span className="text-sm text-success">{t('app.saved')}</span>}
        {state.error && <span className="text-sm text-error">{errorMessage(state.error)}</span>}
      </div>
    </section>
  );
}

function TurnRow({ turn, open, onToggle }: { turn: ConversationTurnSummary; open: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  return (
    <>
      <tr className="cursor-pointer border-t border-border align-top hover:bg-surface" onClick={onToggle} aria-expanded={open}>
        <td className="whitespace-nowrap px-3 py-2 tabular-nums text-text-secondary">{new Date(turn.createdAt).toLocaleString()}</td>
        <td className="max-w-[14rem] truncate px-3 py-2">{turn.userEmail ?? <span className="text-text-secondary">{t('conversations.deletedUser')}</span>}</td>
        <td className="px-3 py-2">
          <div className="font-mono text-xs">{turn.modelId}</div>
          <div className="text-xs text-text-secondary">
            {t(`conversations.sources.${turn.source}`)}
            {turn.chatTitle ? ` · ${turn.chatTitle}` : ''}
          </div>
        </td>
        <td className="px-3 py-2">
          <div className="line-clamp-2 break-words">{turn.promptPreview || <span className="text-text-secondary">—</span>}</div>
          {turn.status !== 'completed' && <span className="text-xs text-error">{t(`conversations.status.${turn.status}`, { defaultValue: turn.status })}</span>}
        </td>
      </tr>
      {open && (
        <tr className="border-t border-border bg-surface">
          <td colSpan={4} className="px-3 py-3">
            <TurnDetails id={turn.id} />
          </td>
        </tr>
      )}
    </>
  );
}

function TurnDetails({ id }: { id: string }) {
  const { t } = useTranslation();
  const { data, error, isLoading } = useConversationTurnQuery(id);
  if (isLoading) return <p className="text-sm text-text-secondary">{t('app.loading')}</p>;
  if (error || !data) return <p className="text-sm text-error">{errorMessage(error)}</p>;
  const { turn } = data;
  const { attachments = [], toolCalls = [] } = turn.details;
  return (
    <div className="space-y-3 text-sm">
      <Block title={t('conversations.prompt')} text={turn.prompt} />
      {attachments.length > 0 && (
        <p className="text-xs text-text-secondary">
          {t('conversations.attachments')}: {attachments.map((a) => a.name).join(', ')}
        </p>
      )}
      <Block title={t('conversations.reply')} text={turn.reply} />
      {toolCalls.length > 0 && (
        <div>
          <h3 className="mb-1 text-xs font-semibold text-text-secondary">{t('conversations.toolCalls')}</h3>
          <ul className="space-y-1">
            {toolCalls.map((c, i) => (
              <li key={i} className="break-all font-mono text-xs">
                {c.name}({c.args})
              </li>
            ))}
          </ul>
        </div>
      )}
      {turn.error && <p className="text-xs text-error">{turn.error}</p>}
      <p className="text-xs text-text-secondary">
        {[
          turn.promptTokens !== null || turn.completionTokens !== null
            ? t('conversations.tokens', { prompt: turn.promptTokens ?? 0, completion: turn.completionTokens ?? 0 })
            : null,
          turn.chatId ? `${t('conversations.chatId')}: ${turn.chatId}` : null,
          turn.ip ? `${t('audit.ip')}: ${turn.ip}` : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
    </div>
  );
}

function Block({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold text-text-secondary">{title}</h3>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-background p-2 font-sans text-sm">{text || '—'}</pre>
    </div>
  );
}
