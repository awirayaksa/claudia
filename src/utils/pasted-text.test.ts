import { describe, it, expect } from 'vitest';
import { isLongPaste, lineCount, pastedTextFile } from './pasted-text';

describe('long pastes', () => {
  it('are long by characters or by lines', () => {
    expect(isLongPaste('short')).toBe(false);
    expect(isLongPaste('x'.repeat(2000))).toBe(true);
    expect(isLongPaste('a\n'.repeat(39) + 'a')).toBe(true);
    expect(isLongPaste('a\n'.repeat(10))).toBe(false);
    expect(lineCount('a\r\nb\nc')).toBe(3);
    expect(lineCount('')).toBe(0);
  });

  it('become a numbered text file', async () => {
    const f = pastedTextFile('hello', 2);
    expect(f.name).toBe('Pasted text 2.txt');
    expect(f.type).toBe('text/plain');
    expect(await f.text()).toBe('hello');
  });
});
