/**
 * Background model calls that aren't part of the conversation: chat titles
 * and follow-up suggestions. They use the admin's "task model" when one is
 * set, else the chat's model.
 */
import type { IAPIProvider } from '../../../src/services/api/provider.interface';

const TASK_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  const timeout = new Promise<never>((_, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out`)), TASK_TIMEOUT_MS);
    t.unref?.();
  });
  return Promise.race([promise, timeout]);
}

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
  const response = await withTimeout(call, 'Title generation');
  const content = response.choices[0]?.message?.content;
  const title = typeof content === 'string' ? cleanTitle(content) : '';
  return title || fallbackTitle(userText);
}

const MAX_FOLLOW_UPS = 3;

/**
 * The questions in a model's answer: a JSON array of strings, or failing
 * that one question per line (bullets and numbers removed).
 */
export function parseFollowUps(raw: string): string[] {
  let items: unknown[] = [];
  const json = /\[[\s\S]*\]/.exec(raw);
  if (json) {
    try {
      const parsed = JSON.parse(json[0]);
      if (Array.isArray(parsed)) items = parsed;
    } catch {
      /* not JSON: read lines below */
    }
  }
  if (items.length === 0) items = raw.split('\n');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const q = item
      .trim()
      .replace(/^([-*•]|\d+[.)])\s*/, '')
      .replace(/^["'“”]+|["'“”,]+$/g, '')
      .trim();
    if (q.length < 3 || q.length > 200 || seen.has(q.toLowerCase())) continue;
    seen.add(q.toLowerCase());
    out.push(q);
    if (out.length === MAX_FOLLOW_UPS) break;
  }
  return out;
}

export async function generateFollowUps(
  provider: IAPIProvider,
  model: string,
  userText: string,
  assistantText: string
): Promise<string[]> {
  const call = provider.chatCompletion({
    model,
    messages: [
      {
        role: 'system',
        content:
          'Suggest 3 short follow-up questions the user might ask next, in the language of the conversation. ' +
          "Write them from the user's point of view. Reply with only a JSON array of strings.",
      },
      { role: 'user', content: userText.slice(0, 1000) },
      { role: 'assistant', content: assistantText.slice(-2000) },
    ],
    stream: false,
    max_tokens: 200,
    temperature: 0.5,
  });
  const response = await withTimeout(call, 'Follow-up suggestions');
  const content = response.choices[0]?.message?.content;
  return typeof content === 'string' ? parseFollowUps(content) : [];
}
