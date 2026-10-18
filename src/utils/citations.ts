/**
 * Inline citations: "[1]" in a reply becomes a link to "#cite-1" (rendered
 * as a small chip) when source 1 exists. Code blocks, inline code and real
 * markdown links ("[1](…)", "[1]: …", "[1][ref]") are left alone.
 */

export const CITE_HREF_PREFIX = '#cite-';

const FENCE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g;

export function linkCitations(markdown: string, indices: ReadonlySet<number>): string {
  if (indices.size === 0 || !markdown.includes('[')) return markdown;
  return markdown
    .split(FENCE)
    .map((piece, i) =>
      i % 2 === 1
        ? piece
        : // A run like "[1][2]" (not "[x][1]", "[1](url)", "[1]: url" or "[1][ref]")
          piece.replace(/(?<![\]\\])((?:\[\d{1,3}\])+)(?![(:[])/g, (run: string) =>
            run.replace(/\[(\d{1,3})\]/g, (match, n: string) => (indices.has(Number(n)) ? `[${n}](${CITE_HREF_PREFIX}${n})` : match))
          )
    )
    .join('');
}

/** The citation number of a "#cite-n" link, or null. */
export function citationIndex(href: string | undefined): number | null {
  if (!href?.startsWith(CITE_HREF_PREFIX)) return null;
  const n = Number(href.slice(CITE_HREF_PREFIX.length));
  return Number.isInteger(n) ? n : null;
}
