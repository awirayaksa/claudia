/**
 * Long pastes (logs, code, documents) become a "Pasted text" attachment
 * instead of filling the message box.
 */

export const LONG_PASTE_CHARS = 2000;
export const LONG_PASTE_LINES = 40;

export function lineCount(text: string): number {
  return text ? text.split(/\r\n|\r|\n/).length : 0;
}

/** Long enough to attach rather than paste into the message box. */
export function isLongPaste(text: string): boolean {
  return text.length >= LONG_PASTE_CHARS || lineCount(text) >= LONG_PASTE_LINES;
}

/** The file a paste becomes ("Pasted text 2.txt"). */
export function pastedTextFile(text: string, n: number): File {
  return new File([text], `Pasted text ${n}.txt`, { type: 'text/plain' });
}
