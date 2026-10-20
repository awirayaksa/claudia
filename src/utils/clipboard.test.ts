// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { copyText } from './clipboard';

const setClipboard = (value: unknown) => Object.defineProperty(navigator, 'clipboard', { value, configurable: true });

describe('copyText', () => {
  afterEach(() => setClipboard(undefined));

  it('uses the Clipboard API when there is one', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    expect(await copyText('hello')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('falls back to execCommand without the Clipboard API (plain HTTP)', async () => {
    setClipboard(undefined);
    let copied = '';
    document.execCommand = vi.fn(() => {
      copied = (document.activeElement as HTMLTextAreaElement).value;
      return true;
    });
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    expect(await copyText('from http')).toBe(true);
    expect(copied).toBe('from http');
    expect(document.querySelector('textarea')).toBeNull();
    expect(document.activeElement).toBe(input);
    input.remove();
  });

  it('falls back when the Clipboard API refuses, and reports failure', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) });
    document.execCommand = vi.fn(() => false);
    expect(await copyText('x')).toBe(false);
    expect(document.execCommand).toHaveBeenCalledWith('copy');
  });
});
