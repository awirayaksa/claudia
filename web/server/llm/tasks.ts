/**
 * Background model calls that aren't part of the conversation: chat titles
 * (later: follow-up suggestions, tags). They use the admin's "task model"
 * when one is set, else the chat's model.
 */
import type { IAPIProvider } from '../../../src/services/api/provider.interface';

const TITLE_TIMEOUT_MS = 15_000;

export function fallbackTitle(userText: string): string {
  const firstLine = userText.trim().split('\n')[0] ?? '';
  return firstLine.slice(0, 50) + (firstLine.length > 50 ? '…' : '') || 'New chat';
}

/** Clean a model's title answer: no quotes, no trailing period, one line, ≤ 60 chars. */
export function cleanTitle(raw: string): string {
  return raw
    .trim()
    .split('\n')[0]
    .replace(/^(title:\s*)/i, '')
    .replace(/^["'“”‘’*#\s]+|["'“”‘’*\s]+$/g, '')
    .replace(/[.。]+$/, '')
    .slice(0, 60)
    .trim();
}

export async function generateTitle(
  provider: IAPIProvider,
  model: string,
  userText: string,
  assistantText: string
): Promise<string> {
  const call = provider.chatCompletion({
    model,
    messages: [
      {
        role: 'system',
        content:
          'Generate a very short title (3-6 words) for this conversation. Reply with only the title, no quotes, no punctuation at the end.',
      },
      { role: 'user', content: userText.slice(0, 500) },
      { role: 'assistant', content: assistantText.slice(0, 500) },
    ],
    stream: false,
    max_tokens: 30,
    temperature: 0.3,
  });
  const timeout = new Promise<never>((_, reject) => {
    const t = setTimeout(() => reject(new Error('Title generation timed out')), TITLE_TIMEOUT_MS);
    t.unref?.();
  });
  const response = await Promise.race([call, timeout]);
  const content = response.choices[0]?.message?.content;
  const title = typeof content === 'string' ? cleanTitle(content) : '';
  return title || fallbackTitle(userText);
}
