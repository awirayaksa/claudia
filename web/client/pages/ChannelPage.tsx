import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import type { ChannelEvent, ChannelMessageView } from '@shared/channels';
import { ARENA_MODEL_ID } from '@shared/arena';
import {
  errorMessage,
  useChannelsQuery,
  useDeleteChannelMessageMutation,
  useDeleteChannelMutation,
  useEditChannelMessageMutation,
  useLazyChannelMessagesQuery,
  useModelsQuery,
  usePostChannelMessageMutation,
  useSessionQuery,
  useUpdateChannelMutation,
} from '../api/rtk-api';
import { useTopic } from '../api/ws';
import { AccessDialog } from '../workspace/AccessDialog';

/** A channel: its messages (live), and a box to write in ("@model" asks a model). */
export function ChannelPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const navigate = useNavigate();
  const { data: list } = useChannelsQuery();
  const { data: session } = useSessionQuery();
  const channel = list?.channels.find((c) => c.id === id);
  const [messages, setMessages] = useState<ChannelMessageView[]>([]);
  const [more, setMore] = useState(false);
  const [load, loadState] = useLazyChannelMessagesQuery();
  const [sharing, setSharing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [removeChannel] = useDeleteChannelMutation();
  const [updateChannel] = useUpdateChannelMutation();
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!id) return;
    setMessages([]);
    void load({ id }).then((res) => {
      if (res.data) {
        setMessages(res.data.messages);
        setMore(res.data.more);
      }
    });
  }, [id, load]);

  // New, edited and streaming messages from everyone in the channel
  useTopic(id ? `channel:${id}` : null, (event: ChannelEvent) => {
    setMessages((list) => {
      if (event.type === 'channel.message') return list.some((m) => m.id === event.message.id) ? list : [...list, event.message];
      if (event.type === 'channel.message.updated') return list.map((m) => (m.id === event.message.id ? event.message : m));
      return list.map((m) => (m.id === event.messageId ? { ...m, content: m.content + event.text } : m));
    });
  });

  const count = messages.length;
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [count]);

  const older = async () => {
    if (!id || messages.length === 0) return;
    const res = await load({ id, before: messages[0].id });
    if (res.data) {
      setMessages((list) => [...res.data!.messages, ...list]);
      setMore(res.data.more);
    }
  };

  if (!id) return null;
  if (list && !channel) return <p className="p-6 text-sm text-text-secondary">{t('channels.notFound')}</p>;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="channel">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <h1 className="font-semibold">
          <span className="text-accent">#</span> {channel?.name}
        </h1>
        {channel?.description && <span className="truncate text-sm text-text-secondary">{channel.description}</span>}
        {channel?.canManage && (
          <div className="ms-auto flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setSharing(true)}>
              {t('channels.members')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void updateChannel({ id, archived: !channel.archived })}>
              {channel.archived ? t('channels.unarchive') : t('channels.archive')}
            </Button>
            <Button size="sm" variant="ghost" className="text-error" onClick={() => setDeleting(true)}>
              {t('app.delete')}
            </Button>
          </div>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" role="log" aria-label={channel?.name}>
        {more && (
          <button className="mb-3 text-sm text-accent hover:underline" onClick={() => void older()} disabled={loadState.isFetching}>
            {t('channels.older')}
          </button>
        )}
        {messages.length === 0 && !loadState.isFetching && <p className="text-sm text-text-secondary">{t('channels.empty')}</p>}
        <ul className="space-y-3">
          {messages.map((m) => (
            <ChannelMessage key={m.id} channelId={id} message={m} mine={m.author.kind === 'user' && m.author.id === session?.user?.id} canModerate={!!channel?.canManage} />
          ))}
        </ul>
        <div ref={bottom} />
      </div>
      {channel?.archived ? (
        <p className="border-t border-border p-4 text-center text-sm text-text-secondary">{t('channels.archived')}</p>
      ) : (
        <Composer channelId={id} />
      )}
      {sharing && channel && <AccessDialog kind="channels" id={channel.id} name={channel.name} onClose={() => setSharing(false)} />}
      <ConfirmDialog
        isOpen={deleting}
        onClose={() => setDeleting(false)}
        onConfirm={async () => {
          await removeChannel(id);
          setDeleting(false);
          navigate('/');
        }}
        title={t('channels.deleteTitle')}
        message={t('channels.deleteBody', { name: channel?.name ?? '' })}
        confirmText={t('app.delete')}
        isDestructive
      />
    </div>
  );
}

function ChannelMessage({ channelId, message: m, mine, canModerate }: { channelId: string; message: ChannelMessageView; mine: boolean; canModerate: boolean }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(m.content);
  const [edit] = useEditChannelMessageMutation();
  const [remove] = useDeleteChannelMessageMutation();
  const model = m.author.kind === 'model';
  return (
    <li className="group" data-testid="channel-message">
      <div className="flex items-baseline gap-2 text-sm">
        <span className={`font-semibold ${model ? 'text-accent' : ''}`}>{model ? `🤖 ${m.author.name}` : m.author.name}</span>
        <span className="text-xs text-text-secondary">{new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        {m.editedAt && <span className="text-xs text-text-secondary">{t('channels.edited')}</span>}
        {!m.deleted && (mine || canModerate) && !editing && (
          <span className="ms-auto hidden gap-2 text-xs group-hover:flex group-focus-within:flex">
            {mine && (
              <button className="text-text-secondary hover:text-text-primary" onClick={() => setEditing(true)}>
                {t('app.edit')}
              </button>
            )}
            <button className="text-text-secondary hover:text-error" onClick={() => void remove({ id: channelId, messageId: m.id })}>
              {t('app.delete')}
            </button>
          </span>
        )}
      </div>
      {m.deleted ? (
        <p className="text-sm italic text-text-secondary">{t('channels.deleted')}</p>
      ) : editing ? (
        <form
          className="mt-1 flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (text.trim()) await edit({ id: channelId, messageId: m.id, content: text.trim() });
            setEditing(false);
          }}
        >
          <input className="flex-1 rounded border border-border bg-background px-2 py-1 text-sm" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
          <Button size="sm" type="submit">
            {t('app.save')}
          </Button>
        </form>
      ) : (
        <div className={`text-[14px] leading-[1.6] ${m.status === 'error' ? 'text-error' : ''}`}>
          <MarkdownRenderer content={m.content || (m.status === 'streaming' ? '…' : '')} isUser={false} />
        </div>
      )}
    </li>
  );
}

/** The message box, with "@" offering the models the user may ask. */
function Composer({ channelId }: { channelId: string }) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [post, state] = usePostChannelMessageMutation();
  const { data: modelsData } = useModelsQuery();
  const models = useMemo(() => (modelsData?.models ?? []).filter((m) => m.id !== ARENA_MODEL_ID), [modelsData]);
  const mention = /(?:^|\s)@([\w./:-]*)$/.exec(text);
  const matches = mention ? models.filter((m) => m.id.toLowerCase().includes(mention[1].toLowerCase()) || m.name.toLowerCase().includes(mention[1].toLowerCase())).slice(0, 6) : [];
  const [active, setActive] = useState(0);

  const pick = (id: string) => {
    setText((v) => v.replace(/@([\w./:-]*)$/, `@${id} `));
    setActive(0);
  };
  const send = async () => {
    const content = text.trim();
    if (!content) return;
    // Clear at once (the next message may already be on its way in); put it back if posting failed
    setText('');
    const res = await post({ id: channelId, content });
    if ('error' in res) setText((now) => now || content);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (matches.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
    } else if (matches.length > 0 && (e.key === 'Tab' || e.key === 'Enter')) {
      e.preventDefault();
      pick(matches[Math.min(active, matches.length - 1)].id);
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="relative border-t border-border p-3">
      {matches.length > 0 && (
        <ul className="absolute bottom-full start-3 mb-1 w-72 overflow-hidden rounded-md border border-border bg-surface shadow-lg" role="listbox" aria-label={t('channels.mentionModel')}>
          {matches.map((m, i) => (
            <li key={m.id} role="option" aria-selected={i === active}>
              <button className={`block w-full truncate px-3 py-1.5 text-start text-sm ${i === active ? 'bg-accent text-white' : 'hover:bg-background'}`} onClick={() => pick(m.id)}>
                {m.name} <span className="text-xs opacity-70">@{m.id}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-end gap-2">
        <textarea
          className="max-h-40 min-h-[2.5rem] flex-1 resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-accent focus:outline-none"
          placeholder={t('channels.placeholder')}
          aria-label={t('channels.placeholder')}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
        />
        <Button onClick={() => void send()} disabled={!text.trim() || state.isLoading}>
          {t('channels.send')}
        </Button>
      </div>
      {state.error && <p className="mt-1 text-sm text-error">{errorMessage(state.error)}</p>}
    </div>
  );
}
