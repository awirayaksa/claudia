/**
 * A document as segments that keep where text came from: PDF pages and
 * PowerPoint slides become pages, spreadsheet sheets become headings, HTML
 * becomes markdown (whose headings the chunker follows).
 */
import { detectDocumentFormat, stripBom } from '../../../electron/services/builtin-mcp/document-extractor';
import type { ExtractPool } from '../extract/pool';
import { EXTRACT_LIMITS } from '../extract/limits';
import type { Segment } from './chunk';

export class UnsupportedDocumentError extends Error {}

/** Keep the total text under the extraction limit. */
function capped(segments: Segment[]): { segments: Segment[]; truncated: boolean } {
  let left = EXTRACT_LIMITS.maxTextChars;
  const out: Segment[] = [];
  for (const s of segments) {
    if (left <= 0) return { segments: out, truncated: true };
    out.push(s.text.length > left ? { ...s, text: s.text.slice(0, left) } : s);
    left -= s.text.length;
  }
  return { segments: out, truncated: left < 0 };
}

export async function documentSegments(
  extract: ExtractPool,
  data: Buffer,
  name: string,
  mime = ''
): Promise<{ segments: Segment[]; truncated: boolean }> {
  if (mime === 'text/html' || /\.html?$/i.test(name)) {
    // An uploaded page has no address of its own
    const res = await extract.run<{ title: string | null; markdown: string }>({ op: 'html', html: data.toString('utf-8') });
    return capped([{ text: res.title ? `# ${res.title}\n\n${res.markdown}` : res.markdown }]);
  }
  const format = detectDocumentFormat(name, mime);
  const x = extract.extractor();
  switch (format) {
    case 'pdf':
      return capped((await x.pdf(data)).pages.map((text, i) => ({ text, page: i + 1 })).filter((s) => s.text.trim()));
    case 'pptx':
      return capped((await x.pptx(data)).slides.map((s) => ({ text: s.text, page: s.num })).filter((s) => s.text.trim()));
    case 'xlsx':
      return capped((await x.xlsx(data)).sheets.map((s) => ({ text: s.tsv, heading: s.name })).filter((s) => s.text.trim()));
    case 'docx':
      return capped([{ text: (await x.docx(data)).text }]);
    case 'text':
      return capped([{ text: stripBom(data.toString('utf-8')) }]);
    default:
      throw new UnsupportedDocumentError("This file type can't be read. Add PDF, Word, Excel, PowerPoint, HTML or text files.");
  }
}
