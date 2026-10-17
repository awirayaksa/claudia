/**
 * Extraction worker (one per thread in the pool). Receives a task, parses,
 * returns plain data. Runs with a heap limit; the pool kills it on timeout.
 */
import { parseDocx, parseHtml, parsePdf, parsePptx, parseXlsx, renderDot, svgToPng } from './parsers';

export type ExtractTask =
  | { op: 'pdf' | 'docx' | 'xlsx' | 'pptx'; data: Uint8Array }
  | { op: 'html'; html: string; url?: string }
  | { op: 'dot'; source: string; engine: string }
  | { op: 'png'; svg: string; scale: number }
  /** Test hook: spin forever (timeout tests). */
  | { op: 'spin' };

function toBuffer(data: Uint8Array): Buffer {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

export default async function run(task: ExtractTask): Promise<unknown> {
  switch (task.op) {
    case 'pdf':
      return parsePdf(toBuffer(task.data));
    case 'docx':
      return parseDocx(toBuffer(task.data));
    case 'xlsx':
      return parseXlsx(toBuffer(task.data));
    case 'pptx':
      return parsePptx(toBuffer(task.data));
    case 'html':
      return parseHtml(task.html, task.url);
    case 'dot':
      return renderDot(task.source, task.engine);
    case 'png':
      return svgToPng(task.svg, task.scale);
    case 'spin':
      for (;;) {
        /* deliberately never returns */
      }
  }
}
