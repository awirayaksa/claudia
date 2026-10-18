import { describe, it, expect } from 'vitest';
import { citationIndex, linkCitations } from './citations';

const has = new Set([1, 2, 3]);

describe('linkCitations', () => {
  it('links [n] of known sources only', () => {
    expect(linkCitations('Twenty-five days [1][2]. Also [7].', has)).toBe('Twenty-five days [1](#cite-1)[2](#cite-2). Also [7].');
  });

  it('leaves code, real links and references alone', () => {
    const md = 'See `arr[1]` and\n```\nx = a[2]\n```\n[1](https://example.com) [2]: https://x.test [3][ref] \\[1] and [3].';
    expect(linkCitations(md, has)).toBe(
      'See `arr[1]` and\n```\nx = a[2]\n```\n[1](https://example.com) [2]: https://x.test [3][ref] \\[1] and [3](#cite-3).'
    );
  });

  it('does nothing without sources', () => {
    expect(linkCitations('[1]', new Set())).toBe('[1]');
  });

  it('reads citation links', () => {
    expect(citationIndex('#cite-12')).toBe(12);
    expect(citationIndex('#cite-x')).toBeNull();
    expect(citationIndex('https://example.com')).toBeNull();
  });
});
