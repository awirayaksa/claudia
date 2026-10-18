import { describe, it, expect } from 'vitest';
import { findArtifacts } from './artifacts';

describe('findArtifacts', () => {
  it('finds complete HTML, SVG and React blocks with titles', () => {
    const md = [
      'Here is a page:',
      '```html',
      '<!doctype html><html><head><title>Tip calculator</title></head><body>…</body></html>',
      '```',
      'And a logo:',
      '```xml',
      '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>',
      '```',
      '```jsx',
      "import { useState } from 'react';",
      'export default function CounterButton() { const [n, setN] = useState(0); return <button onClick={() => setN(n + 1)}>{n}</button>; }',
      '```',
      '```python',
      'print("not an artifact")',
      '```',
    ].join('\n');
    expect(findArtifacts(md).map((a) => [a.kind, a.title])).toEqual([
      ['html', 'Tip calculator'],
      ['svg', 'SVG image'],
      ['react', 'Counter Button'],
    ]);
  });

  it('skips blocks still being written and tiny snippets', () => {
    expect(findArtifacts('```html\n<div>still streaming…')).toEqual([]);
    expect(findArtifacts('```html\n<b>x</b>\n```')).toEqual([]);
  });

  it('recognizes React components in js/ts blocks', () => {
    const md = "```tsx\nimport React from 'react';\nexport default function App() { return <p>Hi there</p>; }\n```";
    expect(findArtifacts(md)[0]).toMatchObject({ kind: 'react', title: 'App' });
    const ts = "```typescript\nimport { useMemo } from 'react';\nexport default () => null;\n```";
    expect(findArtifacts(ts)[0].kind).toBe('react');
  });
});
