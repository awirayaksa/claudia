import type { MessagePart, PartOf } from '../../../src/types/turn.types';

/**
 * Accumulates an assistant turn's parts in the order things happen. Text and
 * reasoning deltas extend the last part of the same kind, so a reply is one
 * text part per stretch of prose rather than one per token.
 */
export class PartsBuilder {
  readonly parts: MessagePart[] = [];
  /** Changed since the last persist. */
  dirty = false;

  appendText(text: string): void {
    this.append('text', text);
  }

  appendReasoning(text: string): void {
    this.append('reasoning', text);
  }

  add(part: MessagePart): void {
    this.parts.push(part);
    this.dirty = true;
  }

  /** The prose of the reply (text parts only). */
  text(): string {
    return this.parts
      .filter((p): p is PartOf<'text'> => p.type === 'text')
      .map((p) => p.text)
      .join('');
  }

  private append(type: 'text' | 'reasoning', text: string): void {
    if (!text) return;
    const last = this.parts[this.parts.length - 1];
    if (last && last.type === type) last.text += text;
    else this.parts.push({ type, text });
    this.dirty = true;
  }
}
