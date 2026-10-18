/**
 * Turn exported chats into Claudia's import format, in the browser, so the
 * server only ever reads one validated format. Recognised files:
 * - Claudia Web exports (`{ format: 'claudia-web' }`);
 * - Claudia desktop conversation files and project files (pick the
 *   `conversations` and `projects` folders, or the files in them);
 * - Open WebUI chat exports;
 * - ChatGPT `conversations.json`.
 */
import { EXPORT_FORMAT, ExportedChatSchema, type ExportedChat } from '../chats';
import { convertChatGPTConversation, isChatGPTConversation } from './chatgpt';
import { convertDesktopConversation, isDesktopConversation, isDesktopProject, type DesktopConversation } from './desktop';
import { convertOpenWebUIChat, isOpenWebUIChat } from './openwebui';

export type ImportSource = 'claudia' | 'desktop' | 'openwebui' | 'chatgpt';

export interface ImportFile {
  name: string;
  text: string;
}

export interface ConvertedImport {
  chats: ExportedChat[];
  /** How many chats came from each kind of file. */
  counts: Record<ImportSource, number>;
  /** Files (or chats in them) that could not be read. */
  problems: Array<{ file: string; message: string }>;
}

export function convertImportFiles(files: ImportFile[]): ConvertedImport {
  const result: ConvertedImport = { chats: [], counts: { claudia: 0, desktop: 0, openwebui: 0, chatgpt: 0 }, problems: [] };
  const projectNames = new Map<string, string>();
  const desktop: Array<{ file: string; conv: DesktopConversation }> = [];

  const add = (file: string, source: ImportSource, convert: () => ExportedChat) => {
    try {
      const parsed = ExportedChatSchema.safeParse(convert());
      if (!parsed.success) {
        result.problems.push({ file, message: parsed.error.issues[0]?.message ?? 'Not a valid chat' });
        return;
      }
      if (parsed.data.messages.length === 0) return;
      result.chats.push(parsed.data);
      result.counts[source]++;
    } catch (err) {
      result.problems.push({ file, message: err instanceof Error ? err.message : String(err) });
    }
  };

  for (const f of files) {
    let data: unknown;
    try {
      data = JSON.parse(f.text);
    } catch {
      result.problems.push({ file: f.name, message: 'Not a JSON file' });
      continue;
    }
    const items: unknown[] = Array.isArray(data) ? data : [data];
    let recognised = false;
    if (!Array.isArray(data) && (data as { format?: string })?.format === EXPORT_FORMAT) {
      recognised = true;
      for (const chat of (data as { chats?: unknown[] }).chats ?? []) add(f.name, 'claudia', () => chat as ExportedChat);
    } else {
      for (const item of items) {
        if (isDesktopProject(item)) {
          recognised = true;
          projectNames.set(item.id, item.name);
        } else if (isDesktopConversation(item)) {
          recognised = true;
          desktop.push({ file: f.name, conv: item });
        } else if (isOpenWebUIChat(item)) {
          recognised = true;
          add(f.name, 'openwebui', () => convertOpenWebUIChat(item));
        } else if (isChatGPTConversation(item)) {
          recognised = true;
          add(f.name, 'chatgpt', () => convertChatGPTConversation(item));
        }
      }
    }
    if (!recognised) result.problems.push({ file: f.name, message: 'Not a chat export Claudia knows' });
  }

  // Desktop conversations last, once every project's name is known
  for (const { file, conv } of desktop) add(file, 'desktop', () => convertDesktopConversation(conv, projectNames));
  return result;
}

/** Split chats into requests of at most `maxBytes` of JSON and `maxChats` chats. */
export function batchChats(chats: ExportedChat[], maxBytes = 8 * 1024 * 1024, maxChats = 100): ExportedChat[][] {
  const batches: ExportedChat[][] = [];
  let current: ExportedChat[] = [];
  let size = 0;
  for (const chat of chats) {
    const bytes = new TextEncoder().encode(JSON.stringify(chat)).length;
    if (current.length && (size + bytes > maxBytes || current.length >= maxChats)) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(chat);
    size += bytes;
  }
  if (current.length) batches.push(current);
  return batches;
}
