/**
 * A conversation as Markdown: the branch that is shown, each turn under a
 * heading, attachments by name, tool calls folded away, sources listed.
 * Used for Markdown and PDF exports. Pure; shared by desktop and web.
 */
import type { MessageNode, MessagePart, PartOf } from '../../types/turn.types';

export interface ChatMarkdownOptions {
  title: string;
  /** The nodes from the first message to the last one shown, in order. */
  path: MessageNode[];
  /** A model's display name (defaults to its id). */
  modelName?: (id: string) => string;
  /** When the export was made (in the header). */
  exportedAt?: Date;
  /**
   * HTML <details> blocks for tool calls and reasoning (Markdown files), or
   * plain quotes (renderers that ignore HTML, e.g. PDF).
   */
  folding?: 'details' | 'quote';
  /** An image attachment's reference for ![](…) (PDF: embedded); null lists it by name. */
  imageRef?: (part: PartOf<'file'>) => string | null;
}

/** Longest tool argument or result written out. */
const TOOL_CHARS = 2000;

const clip = (s: string, max = TOOL_CHARS) => (s.length > max ? `${s.slice(0, max)}\n…` : s);

/** A fence longer than any backtick run in the text, so the text can't close it. */
function fence(text: string, lang = ''): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}${lang}\n${text}\n${ticks}`;
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

function folded(summary: string, body: string, folding: 'details' | 'quote'): string {
  if (folding === 'details') return `<details>\n<summary>${summary.replace(/</g, '&lt;')}</summary>\n\n${body}\n\n</details>`;
  return `> **${summary}**\n>\n${body
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n')}`;
}

function partsMarkdown(node: MessageNode, opts: ChatMarkdownOptions): string {
  const folding = opts.folding ?? 'details';
  const out: string[] = [];
  const results = new Map(node.parts.flatMap((p) => (p.type === 'tool_result' ? [[p.callId, p] as const] : [])));
  const files: Array<PartOf<'file'>> = [];
  const citations: Array<PartOf<'citation'>> = [];
  for (const p of node.parts as MessagePart[]) {
    switch (p.type) {
      case 'text':
        if (p.text.trim()) out.push(p.text.trim());
        break;
      case 'reasoning':
        if (p.text.trim()) out.push(folded('Thinking', p.text.trim(), folding));
        break;
      case 'tool_call': {
        const result = results.get(p.callId);
        const body = [
          fence(clip(prettyJson(p.args || '{}')), 'json'),
          ...(result ? [`${result.isError ? 'Error' : 'Result'}:`, fence(clip(result.content))] : []),
        ].join('\n\n');
        out.push(folded(`Tool: ${p.tool || p.alias}`, body, folding));
        break;
      }
      case 'file':
        files.push(p);
        break;
      case 'workspace_file':
        files.push({ type: 'file', fileId: '', name: p.path, mime: '', size: p.size });
        break;
      case 'citation':
        citations.push(p);
        break;
      default:
        break;
    }
  }
  if (files.length) {
    const lines = files.map((f) => {
      const ref = f.mime.startsWith('image/') ? opts.imageRef?.(f) : null;
      return ref ? `![${f.name.replace(/[[\]]/g, '')}](${ref})` : `- 📎 ${f.name}`;
    });
    out.push(lines.join('\n'));
  }
  if (citations.length) {
    const lines = [...citations]
      .sort((a, b) => a.index - b.index)
      .map((c) => `${c.index}. ${c.source.url ? `[${c.source.title}](${c.source.url})` : c.source.title}${c.source.page ? `, p. ${c.source.page}` : ''}`);
    out.push(`**Sources**\n\n${lines.join('\n')}`);
  }
  if (node.status === 'error' && node.error) out.push(`> ⚠️ ${node.error}`);
  return out.join('\n\n');
}

export function chatToMarkdown(opts: ChatMarkdownOptions): string {
  const when = opts.exportedAt ?? new Date();
  const blocks = [`# ${opts.title.replace(/\n/g, ' ')}`, `_Exported from Claudia on ${when.toISOString().slice(0, 10)}_`];
  for (const node of opts.path) {
    if (node.role === 'system') continue;
    const who = node.role === 'user' ? 'You' : node.modelId ? (opts.modelName?.(node.modelId) ?? node.modelId) : 'Assistant';
    const body = partsMarkdown(node, opts);
    if (!body) continue;
    blocks.push(`## ${who}`, body);
    if (node.compaction) blocks.push(`---\n\n_Earlier messages were summarized here to fit the model's context._`);
  }
  return `${blocks.join('\n\n')}\n`;
}
