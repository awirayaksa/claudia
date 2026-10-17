import { describe, it, expect } from 'vitest';
import { normalizeMath } from './math-delimiters';

describe('normalizeMath', () => {
  it('leaves text without math alone', () => {
    expect(normalizeMath('Hello **world**')).toBe('Hello **world**');
  });

  it('turns \\( \\) into inline math', () => {
    expect(normalizeMath('Area is \\( \\pi r^2 \\).')).toBe('Area is $$\\pi r^2$$.');
  });

  it('turns \\[ \\] on its own lines into a display block', () => {
    expect(normalizeMath('Sum:\n\\[\n\\sum_{i=1}^n i\n\\]\nDone')).toBe('Sum:\n$$\n\\sum_{i=1}^n i\n$$\nDone');
  });

  it('turns \\[ \\] inside a sentence into inline math', () => {
    expect(normalizeMath('so \\[x=1\\] holds')).toBe('so $$x=1$$ holds');
  });

  it('turns $x$ into inline math', () => {
    expect(normalizeMath('Let $x^2$ and $y$ be')).toBe('Let $$x^2$$ and $$y$$ be');
  });

  it('keeps prices as text', () => {
    expect(normalizeMath('It costs $5 and $10.')).toBe('It costs $5 and $10.');
    expect(normalizeMath('From US$5 to US$6')).toBe('From US$5 to US$6');
    expect(normalizeMath('Pay $ 5 now $')).toBe('Pay $ 5 now $');
  });

  it('keeps escaped dollars and $$ math as they are', () => {
    expect(normalizeMath('\\$x\\$ and $$a+b$$')).toBe('\\$x\\$ and $$a+b$$');
    expect(normalizeMath('$$\nE=mc^2\n$$')).toBe('$$\nE=mc^2\n$$');
  });

  it('does not join dollars across lines', () => {
    expect(normalizeMath('$a\nb$')).toBe('$a\nb$');
  });

  it('never touches code', () => {
    const fenced = '```bash\necho $HOME and \\(x\\) $y$\n```\nthen $z$';
    expect(normalizeMath(fenced)).toBe('```bash\necho $HOME and \\(x\\) $y$\n```\nthen $$z$$');
    expect(normalizeMath('run `echo $a$` with $b$')).toBe('run `echo $a$` with $$b$$');
    expect(normalizeMath('``a ` $x$ ``')).toBe('``a ` $x$ ``');
  });

  it('treats an unclosed fence (still streaming) as code', () => {
    expect(normalizeMath('$a$\n```\n$b$')).toBe('$$a$$\n```\n$b$');
  });
});
