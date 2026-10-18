/**
 * Builds OpenAI-compatible request messages, for the desktop's flat records
 * and for the web's turn nodes. Pure: shared by the desktop renderer and the
 * web server.
 *
 * Normalization rules (strict providers and proxies):
 * - An assistant message with tool_calls has no `content` at all; Kimi and
 *   DeepSeek reject one that has both.
 * - Reasoning is echoed back as `reasoning_content` (DeepSeek thinking mode).
 * - Tool messages carry only role, content and tool_call_id (no `name`); empty
 *   content becomes "{}" and long content is truncated.
 * - An empty tool_calls array is never sent.
 */
import type { Attachment, Message, ToolCall } from '../../types/message.types';
import type { ChatMessage, ContentPart } from '../../types/api.types';
import type { MessageNode, MessagePart, PartOf } from '../../types/turn.types';

/** Tool output sent back to the model is cut to this many characters. */
export const TOOL_RESULT_MAX_CHARS = 4000;

/** What the model is told when a tool rendered an interactive UI instead of text. */
export function uiResourceConfirmation(toolName: string): string {
  return `Interactive UI component displayed successfully. The user can now interact with the ${toolName} interface.`;
}

/** Truncate text to a maximum length, adding an ellipsis if truncated. */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

/** Tool output as the model should see it: never empty, never too long. */
export function toolContentForModel(content: string): string {
  return content.trim() ? truncateText(content, TOOL_RESULT_MAX_CHARS) : '{}';
}

/** One `<attachment>` block with a document's extracted text. */
export function attachmentBlock(name: string, text: string, truncated?: boolean): string {
  const safeName = name.replace(/"/g, "'");
  const note = truncated ? '\n[The rest of this file was cut off because it is too long.]' : '';
  return `<attachment name="${safeName}">\n${text}${note}\n</attachment>`;
}

/**
 * Append the extracted text of document attachments to the message text, one
 * `<attachment>` block per file.
 */
export function appendAttachmentText(text: string, attachments?: Attachment[]): string {
  const docs = attachments?.filter((a) => a.type === 'file' && a.extractedText) ?? [];
  if (docs.length === 0) return text;
  const blocks = docs.map((a) => attachmentBlock(a.name, a.extractedText!, a.textTruncated));
  return [text, ...blocks].filter(Boolean).join('\n\n');
}

/** Provider file ids (Open WebUI) referenced by these attachments. */
export function remoteFileIds(attachments?: Attachment[]): string[] {
  return (attachments ?? []).flatMap((a) => (a.remoteFileId ? [a.remoteFileId] : []));
}

/** Text plus image URLs → plain string, or multi-part content when there are images. */
function contentWithImages(text: string, imageUrls: string[]): string | ContentPart[] {
  if (imageUrls.length === 0) return text;
  const parts: ContentPart[] = [];
  if (text) parts.push({ type: 'text', text });
  for (const url of imageUrls) parts.push({ type: 'image_url', image_url: { url } });
  return parts;
}

/**
 * Build message content with attachments in OpenAI multi-part format.
 * Images are embedded as image_url content parts; document text is inlined.
 */
export function buildMessageContent(rawText: string, attachments?: Attachment[]): string | ContentPart[] {
  const text = appendAttachmentText(rawText, attachments);
  const images = attachments?.filter((a) => a.type === 'image' && a.data).map((a) => a.data!) ?? [];
  return contentWithImages(text, images);
}

/** An assistant message carrying tool calls, normalized for strict providers. */
function assistantToolCallMessage(toolCalls: ToolCall[], reasoning?: string): ChatMessage {
  const msg: ChatMessage = { role: 'assistant', tool_calls: toolCalls };
  if (reasoning && reasoning.trim()) msg.reasoning_content = reasoning;
  return msg;
}

/**
 * Build an API message from a desktop (flat) Message with normalization for
 * tool calling.
 */
export function buildAPIMessage(msg: Message): ChatMessage {
  let content: string | ContentPart[] = buildMessageContent(msg.content, msg.attachments);
  const hasToolCalls = !!msg.toolCalls && msg.toolCalls.length > 0;

  if (msg.role === 'tool') {
    if (Array.isArray(content)) {
      content = content.length === 0 ? '{}' : content;
    } else {
      content = toolContentForModel(content);
    }
  }

  const result: ChatMessage = { role: msg.role };

  // Strict providers (e.g. Kimi) reject assistant messages that have BOTH
  // 'content' and 'tool_calls'. When tool_calls are present, omit content.
  if (!hasToolCalls) {
    result.content = content;
  }

  // Only include tool_calls for non-empty arrays (some proxies reject [])
  if (hasToolCalls) {
    result.tool_calls = msg.toolCalls;
  }
  if (msg.tool_call_id) result.tool_call_id = msg.tool_call_id;

  // 'name' is NOT part of the OpenAI tool-message spec and can cause 400s on
  // strict proxies. Keep it for other roles only.
  if (msg.name && msg.role !== 'tool') {
    result.name = msg.name;
  }

  // DeepSeek (and some other providers) require reasoning_content to be echoed
  // back in the conversation history when the assistant used thinking mode.
  if (msg.role === 'assistant' && msg.reasoning) {
    result.reasoning_content = msg.reasoning;
  }

  return result;
}

// ─── Turn model ──────────────────────────────────────────────────────────────

/** How a stored file is shown to the model. */
export type ResolvedFile =
  | { kind: 'image'; url: string }
  | { kind: 'text'; text: string; truncated?: boolean };

export interface ToOpenAIOptions {
  /**
   * Turns a file part into an image URL or extracted text. Files it returns
   * null for (still processing, unsupported) are left out.
   */
  resolveFile?: (part: PartOf<'file'>) => ResolvedFile | null;
}

function textOf(parts: MessagePart[], type: 'text' | 'reasoning'): string {
  return parts
    .filter((p): p is PartOf<'text'> | PartOf<'reasoning'> => p.type === type)
    .map((p) => p.text)
    .join('');
}

function userMessage(node: MessageNode, opts: ToOpenAIOptions): ChatMessage {
  const text = textOf(node.parts, 'text');
  const blocks: string[] = [];
  const images: string[] = [];
  for (const part of node.parts) {
    if (part.type !== 'file') continue;
    const resolved = opts.resolveFile?.(part);
    if (!resolved) continue;
    if (resolved.kind === 'image') images.push(resolved.url);
    else blocks.push(attachmentBlock(part.name, resolved.text, resolved.truncated));
  }
  const fullText = [text, ...blocks].filter(Boolean).join('\n\n');
  return { role: 'user', content: contentWithImages(fullText, images) };
}

/**
 * Expand one assistant turn into `assistant(tool_calls) → tool…` rounds and a
 * final assistant text message — the same records the desktop sends.
 */
function assistantMessages(node: MessageNode): ChatMessage[] {
  const out: ChatMessage[] = [];
  let text = '';
  let reasoning = '';
  let calls: PartOf<'tool_call'>[] = [];
  let results = new Map<string, PartOf<'tool_result'>>();

  const flushRound = () => {
    if (calls.length === 0) return;
    out.push(
      assistantToolCallMessage(
        calls.map((c) => ({ id: c.callId, type: 'function', function: { name: c.alias, arguments: c.args || '{}' } })),
        reasoning
      )
    );
    for (const call of calls) {
      const result = results.get(call.callId);
      out.push({
        role: 'tool',
        tool_call_id: call.callId,
        // A call without a recorded result (stopped mid-run) still needs an answer
        content: toolContentForModel(result ? result.content : JSON.stringify({ error: 'No result: the run was stopped.' })),
      });
    }
    // Text written before the calls was dropped from the API message (strict
    // providers), exactly as on desktop.
    text = '';
    reasoning = '';
    calls = [];
    results = new Map();
  };

  for (const part of node.parts) {
    switch (part.type) {
      case 'text':
      case 'reasoning':
        // New text after results starts the next round
        if (calls.length > 0 && results.size > 0) flushRound();
        if (part.type === 'text') text += part.text;
        else reasoning += part.text;
        break;
      case 'tool_call':
        if (results.size > 0) flushRound();
        calls.push(part);
        break;
      case 'tool_result':
        results.set(part.callId, part);
        break;
      default:
        break; // citations and files are not sent back
    }
  }
  flushRound();

  if (text.trim()) {
    const final: ChatMessage = { role: 'assistant', content: text };
    if (reasoning) final.reasoning_content = reasoning;
    out.push(final);
  }
  return out;
}

/**
 * The visible path of a chat (root → leaf) as OpenAI-compatible messages.
 * Providers see exactly what the desktop app sends for the same history.
 */
export function toOpenAIMessages(turns: MessageNode[], opts: ToOpenAIOptions = {}): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const node of turns) {
    if (node.role === 'system') {
      const text = textOf(node.parts, 'text');
      if (text) out.push({ role: 'system', content: text });
    } else if (node.role === 'user') {
      out.push(userMessage(node, opts));
    } else {
      out.push(...assistantMessages(node));
    }
  }
  return out;
}

// ─── Desktop import ──────────────────────────────────────────────────────────

/**
 * Convert a desktop conversation (flat records) into turn nodes: each run of
 * assistant and tool records between two user messages becomes one assistant
 * node. Attachments become file parts whose fileId is the attachment id.
 */
export function turnsFromDesktopMessages(messages: Message[], chatId: string): MessageNode[] {
  const nodes: MessageNode[] = [];
  let current: MessageNode | null = null;

  const push = (node: MessageNode) => {
    node.parentId = nodes.length > 0 ? nodes[nodes.length - 1].id : null;
    nodes.push(node);
  };

  for (const msg of messages) {
    if (msg.role === 'user' || msg.role === 'system') {
      current = null;
      const parts: MessagePart[] = [];
      if (msg.content) parts.push({ type: 'text', text: msg.content });
      for (const a of msg.attachments ?? []) {
        parts.push({ type: 'file', fileId: a.id, name: a.name, mime: a.mimeType });
      }
      push({
        id: msg.id,
        chatId,
        parentId: null,
        role: msg.role,
        parts,
        effort: msg.effort,
        status: 'completed',
        createdAt: msg.timestamp,
      });
      continue;
    }

    if (!current) {
      current = {
        id: msg.id,
        chatId,
        parentId: null,
        role: 'assistant',
        parts: [],
        status: 'completed',
        createdAt: msg.timestamp,
      };
      push(current);
    }

    if (msg.role === 'assistant') {
      if (msg.reasoning) current.parts.push({ type: 'reasoning', text: msg.reasoning });
      if (msg.content) current.parts.push({ type: 'text', text: msg.content });
      for (const call of msg.toolCalls ?? []) {
        const result = msg.toolResults?.find((r) => r.tool_call_id === call.id);
        current.parts.push({
          type: 'tool_call',
          callId: call.id,
          alias: call.function.name,
          serverId: result?.serverId ?? '',
          tool: result?.name ?? call.function.name,
          args: call.function.arguments,
        });
      }
      if (msg.usage) current.usage = msg.usage;
      if (msg.error) {
        current.status = 'error';
        current.error = msg.error;
      }
    } else if (msg.role === 'tool' && msg.tool_call_id) {
      const result = msg.toolResults?.[0];
      current.parts.push({
        type: 'tool_result',
        callId: msg.tool_call_id,
        content: msg.content,
        isError: result?.isError || undefined,
        uiResource: result?.uiResource,
      });
    }
  }

  return nodes;
}
