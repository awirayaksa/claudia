/**
 * Models write math as `\(…\)`, `\[…\]`, `$…$` and `$$…$$`. The markdown
 * renderer runs remark-math with single-dollar math off (so "$5 and $10"
 * stays text) and therefore only understands `$$`. This rewrites the other
 * forms to `$$`, leaving code spans and fenced code alone:
 * - `\[…\]` on lines of its own → a display block; elsewhere → inline math;
 * - `\(…\)` → inline math;
 * - `$…$` → inline math, using pandoc's rule: the opening `$` is followed by a
 *   non-space, the closing `$` follows a non-space, is not followed by a digit,
 *   and both are on the same line.
 */

type Segment = { code: boolean; text: string };

/** Split into code (fenced blocks, inline code spans) and everything else. */
function splitCode(markdown: string): Segment[] {
  const out: Segment[] = [];
  const push = (code: boolean, text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.code === code) last.text += text;
    else out.push({ code, text });
  };

  const lines = markdown.split(/(?<=\n)/);
  let fence: string | null = null;
  let prose = '';
  const flushProse = () => {
    splitInlineCode(prose, push);
    prose = '';
  };
  for (const line of lines) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      push(true, line);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) fence = null;
    } else if (m) {
      flushProse();
      fence = m[1];
      push(true, line);
    } else {
      prose += line;
    }
  }
  flushProse();
  return out;
}

function splitInlineCode(text: string, push: (code: boolean, text: string) => void): void {
  let i = 0;
  let start = 0;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] !== '`') {
      i++;
      continue;
    }
    let n = 0;
    while (text[i + n] === '`') n++;
    // The span closes at the next run of exactly n backticks
    const re = new RegExp(`(?<!\`)\`{${n}}(?!\`)`, 'g');
    re.lastIndex = i + n;
    const close = re.exec(text);
    if (!close) {
      i += n;
      continue;
    }
    push(false, text.slice(start, i));
    push(true, text.slice(i, close.index + n));
    i = close.index + n;
    start = i;
  }
  push(false, text.slice(start));
}

function rewriteBrackets(text: string): string {
  // \[ … \] (may span lines)
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (match, inner: string, offset: number, all: string) => {
    const lineStart = all.lastIndexOf('\n', offset - 1) + 1;
    const before = all.slice(lineStart, offset);
    const afterEnd = all.indexOf('\n', offset + match.length);
    const after = all.slice(offset + match.length, afterEnd === -1 ? all.length : afterEnd);
    if (/^\s*$/.test(before) && /^\s*$/.test(after)) {
      return `$$\n${inner.trim()}\n${before}$$`;
    }
    return `$$${inner.trim()}$$`;
  });
  // \( … \) (one paragraph)
  return text.replace(/\\\(((?:(?!\n\s*\n)[\s\S])+?)\\\)/g, (_m, inner: string) => `$$${inner.trim()}$$`);
}

function rewriteDollars(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') {
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c !== '$') {
      out += c;
      i++;
      continue;
    }
    // $$ … $$: already in the target form; copy through to its end
    if (text[i + 1] === '$') {
      const end = text.indexOf('$$', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop);
      i = stop;
      continue;
    }
    const close = findClosingDollar(text, i);
    if (close === -1) {
      out += c;
      i++;
      continue;
    }
    out += `$$${text.slice(i + 1, close)}$$`;
    i = close + 1;
  }
  return out;
}

function findClosingDollar(text: string, open: number): number {
  const next = text[open + 1];
  if (next === undefined || /\s/.test(next)) return -1;
  for (let j = open + 1; j < text.length; j++) {
    const c = text[j];
    if (c === '\n') return -1;
    if (c === '\\') {
      j++;
      continue;
    }
    if (c !== '$') continue;
    if (text[j + 1] === '$') return -1;
    if (!/\s/.test(text[j - 1]) && !/[0-9]/.test(text[j + 1] ?? '')) return j;
  }
  return -1;
}

export function normalizeMath(markdown: string): string {
  if (!/[$\\]/.test(markdown)) return markdown;
  return splitCode(markdown)
    .map((s) => (s.code ? s.text : rewriteDollars(rewriteBrackets(s.text))))
    .join('');
}
