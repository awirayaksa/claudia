/**
 * /s/:token — a shared chat, for anyone with the link (signed in or not).
 * It is a snapshot: read-only, without tool UIs or attachments' contents.
 * Markdown is rendered without raw HTML, so a shared chat can't run script
 * on this origin for the people who open it.
 */
import { useEffect, useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useSharedChatQuery } from '../api/rtk-api';
import { MessageTurns } from '../chat/MessageTurns';
import { FullPageMessage } from '../components/FullPageMessage';

export function SharePage() {
  const { t } = useTranslation();
  const { token } = useParams();
  const { data, isLoading, error } = useSharedChatQuery(token!, { skip: !token });
  const chat = data?.chat;
  const path = useMemo(() => chat?.messages ?? [], [chat]);

  useEffect(() => {
    if (chat) document.title = `${chat.title} · ${t('app.name')}`;
  }, [chat, t]);

  if (isLoading) return <FullPageMessage>{t('app.loading')}</FullPageMessage>;
  if (error || !chat) {
    return (
      <FullPageMessage>
        <p className="mb-3">{t('share.notFound')}</p>
        <Link className="text-accent hover:underline" to="/">
          {t('share.openApp')}
        </Link>
      </FullPageMessage>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-background text-text-primary">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold" data-testid="shared-title">
              {chat.title}
            </h1>
            <p className="text-xs text-text-secondary">
              {t('share.byline', { name: chat.sharedBy, date: new Date(chat.sharedAt).toLocaleString() })}
            </p>
          </div>
          <Link to="/" className="shrink-0 rounded border border-border px-3 py-1.5 text-sm hover:border-accent">
            {t('share.openApp')}
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 pb-10 pt-4" data-testid="shared-messages">
        <MessageTurns nodes={path} path={path} running={false} readOnly modelName={(id) => id} />
      </main>
    </div>
  );
}
