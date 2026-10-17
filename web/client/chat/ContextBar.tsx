/**
 * References for the next message (#kb, #url, #chat) and the web search
 * switch, shown above the message box. The "#" menu in the box adds them;
 * so does typing "#https://…" in the message.
 */
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import type { Skill } from '@/types/skill.types';
import type { MessageRef } from '@shared/knowledge';
import type { ChatSummary } from '@shared/chats';
import type { KnowledgeView } from '@shared/knowledge';
import { BookIcon, CloseIcon, GlobeIcon } from '../components/icons';

const URL_ITEM_ID = 'web-page';

/** Items of the "#" menu: knowledge bases, recent chats, and "a web page…". */
export function hashMenuItems(kbs: KnowledgeView[], chats: ChatSummary[], labels: { kb: string; chat: string; url: string; urlHelp: string }): Skill[] {
  const item = (id: string, name: string, description: string): Skill => ({ id, name, description, body: '', builtin: false, filePath: null });
  return [
    ...kbs.map((k) => item(`kb:${k.id}`, k.name, k.description || labels.kb)),
    item(URL_ITEM_ID, labels.url, labels.urlHelp),
    ...chats.slice(0, 20).map((c) => item(`chat:${c.id}`, c.title, labels.chat)),
  ];
}

/** What a "#" menu pick means: a reference, or "ask for a URL". */
export function refFromItem(item: Skill): MessageRef | 'ask-url' | null {
  if (item.id === URL_ITEM_ID) return 'ask-url';
  const [kind, id] = item.id.split(':');
  if (kind === 'kb' && id) return { type: 'kb', id, name: item.name };
  if (kind === 'chat' && id) return { type: 'chat', id, name: item.name };
  return null;
}

/** "#https://…" in a message: those pages become references (the text keeps the address). */
export function urlRefsIn(text: string): { text: string; refs: MessageRef[] } {
  const refs: MessageRef[] = [];
  const out = text.replace(/(^|\s)#(https?:\/\/[^\s<>"']+)/g, (_m, space: string, url: string) => {
    if (refs.length < 10) refs.push({ type: 'url', url });
    return `${space}${url}`;
  });
  return { text: out, refs };
}

export const sameRef = (a: MessageRef, b: MessageRef) =>
  a.type === b.type && (a.type === 'url' ? a.url === (b as { url: string }).url : a.id === (b as { id: string }).id);

export function ContextBar({
  refs,
  onRemove,
  webSearch,
  onWebSearch,
  canSearchWeb,
}: {
  refs: MessageRef[];
  onRemove: (ref: MessageRef) => void;
  webSearch: boolean;
  onWebSearch: (on: boolean) => void;
  canSearchWeb: boolean;
}) {
  const { t } = useTranslation();
  if (refs.length === 0 && !canSearchWeb) return null;
  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-xs" data-testid="context-bar">
      {canSearchWeb && (
        <button
          className={`flex items-center gap-1 rounded-full border px-2 py-0.5 ${webSearch ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-accent'}`}
          aria-pressed={webSearch}
          onClick={() => onWebSearch(!webSearch)}
          title={t('refs.webSearchHelp')}
          data-testid="web-search-toggle"
        >
          <GlobeIcon />
          {t('refs.webSearch')}
        </button>
      )}
      {refs.map((r) => (
        <span
          key={r.type === 'url' ? r.url : r.id}
          className="flex max-w-[18rem] items-center gap-1 rounded-full border border-accent/50 bg-accent/5 py-0.5 pl-2 pr-1"
          data-testid="pending-ref"
        >
          {r.type === 'kb' ? <BookIcon /> : <span className="text-accent">#</span>}
          <span className="truncate">{r.type === 'url' ? r.url.replace(/^https?:\/\//, '') : (r.name ?? t(`refs.${r.type}`))}</span>
          <button className="rounded-full p-0.5 text-text-secondary hover:text-error" aria-label={t('refs.remove')} onClick={() => onRemove(r)}>
            <CloseIcon />
          </button>
        </span>
      ))}
    </div>
  );
}

/** Asks for a web page address to read with the next message. */
export function UrlDialog({ onAdd, onClose }: { onAdd: (url: string) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [url, setUrl] = useState('');
  const valid = /^https?:\/\/\S+\.\S+/.test(url.trim());
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) onAdd(url.trim());
  };
  return (
    <Modal isOpen onClose={onClose} title={t('refs.addUrl')} size="sm">
      <form className="space-y-3" onSubmit={submit}>
        <input
          className="w-full rounded border border-border bg-background px-3 py-2 text-sm"
          type="url"
          autoFocus
          placeholder="https://example.com/article"
          aria-label={t('refs.url')}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <p className="text-xs text-text-secondary">{t('refs.urlHelp')}</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button type="submit" size="sm" disabled={!valid}>
            {t('app.add')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
