import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChatMessage } from '@/components/chat/ChatMessage';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import type { Message } from '@/types/message.types';
import { ReadyResponse } from '@shared/api';

const SAMPLE_MARKDOWN = `### Shared rendering

This block is the desktop **MarkdownRenderer**, compiled into the web client.

| Feature | Desktop | Web |
|---|---|---|
| Markdown, tables | ✓ | ✓ |
| Code highlighting | ✓ | ✓ |

\`\`\`ts
const greeting: string = 'Hello from ../src';
\`\`\`
`;

const ts = new Date().toISOString();
const SAMPLE_MESSAGES: Message[] = [
  { id: 'preview-user', role: 'user', content: 'What does Claudia Web reuse from the desktop app?', timestamp: ts },
  {
    id: 'preview-assistant',
    role: 'assistant',
    content: 'The chat components, the provider classes and the stream parser all come from `../src`.',
    timestamp: ts,
  },
];

type ServerState = { kind: 'loading' } | { kind: 'ready'; data: ReadyResponse } | { kind: 'error' };

export function PreviewPage() {
  const { t } = useTranslation();
  const [server, setServer] = useState<ServerState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetch('/readyz')
      .then(async (res) => ReadyResponse.parse(await res.json()))
      .then((data) => !cancelled && setServer({ kind: 'ready', data }))
      .catch(() => !cancelled && setServer({ kind: 'error' }));
    return () => {
      cancelled = true;
    };
  }, []);

  const serverLabel =
    server.kind === 'loading'
      ? '…'
      : server.kind === 'error'
        ? t('preview.serverUnreachable')
        : server.data.status === 'ready'
          ? t('preview.serverReady', { database: server.data.database, applied: server.data.migrations.applied })
          : t('preview.serverNotReady');

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 px-4 py-8 text-text-primary">
      <header>
        <h1 className="text-2xl font-semibold">{t('preview.title')}</h1>
        <p className="text-sm text-text-secondary">{t('preview.subtitle')}</p>
        <p className="mt-2 text-xs text-text-secondary" data-testid="server-status">
          {t('preview.server')}: {serverLabel}
        </p>
      </header>

      <section className="rounded-lg border border-border bg-surface p-4">
        <MarkdownRenderer content={SAMPLE_MARKDOWN} />
      </section>

      <section>
        {SAMPLE_MESSAGES.map((m) => (
          <ChatMessage key={m.id} message={m} />
        ))}
      </section>
    </main>
  );
}
