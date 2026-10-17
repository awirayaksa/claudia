import { describe, it, expect } from 'vitest';
import { Document, Packer, Paragraph } from 'docx';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { extractText, MAX_ATTACHMENT_BYTES } from './text-extract.service';

const bytes = (b: Buffer | string) => new Uint8Array(typeof b === 'string' ? Buffer.from(b) : b);

/** A minimal one-page PDF that draws `text`, with a correct xref table. */
function minimalPdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

describe('extractText', () => {
  it('reads plain text and strips a BOM', async () => {
    const r = await extractText({ name: 'notes.md', data: bytes(String.fromCharCode(0xfeff) + '# Title\nbody\n') });
    expect(r).toEqual({ text: '# Title\nbody', truncated: false, format: 'text' });
  });

  it('treats unknown extensions with a text mime type as text', async () => {
    const r = await extractText({ name: 'data.weird', mimeType: 'text/plain', data: bytes('hello') });
    expect(r.text).toBe('hello');
  });

  it('extracts PDF text', async () => {
    const r = await extractText({ name: 'a.pdf', data: bytes(minimalPdf('Hello PDF')) });
    expect(r.format).toBe('pdf');
    expect(r.text).toContain('Hello PDF');
  });

  it('extracts DOCX text', async () => {
    const doc = new Document({ sections: [{ children: [new Paragraph('Hello docx'), new Paragraph('Line two')] }] });
    const r = await extractText({ name: 'a.docx', data: bytes(await Packer.toBuffer(doc)) });
    expect(r.format).toBe('docx');
    expect(r.text).toContain('Hello docx');
    expect(r.text).toContain('Line two');
  });

  it('extracts every XLSX sheet as tab-separated rows', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['name', 'qty'], ['apple', 3]]), 'Fruit');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['total', 3]]), 'Sum');
    const buf: Buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const r = await extractText({ name: 'a.xlsx', data: bytes(buf) });
    expect(r.text).toBe('--- Sheet: Fruit ---\nname\tqty\napple\t3\n\n--- Sheet: Sum ---\ntotal\t3');
  });

  it('extracts PPTX slide text in slide order', async () => {
    const zip = new JSZip();
    const slide = (t: string) => `<p:sld><a:t>${t}</a:t><a:t>&amp; more</a:t></p:sld>`;
    zip.file('ppt/slides/slide10.xml', slide('Ten'));
    zip.file('ppt/slides/slide2.xml', slide('Two'));
    const r = await extractText({ name: 'a.pptx', data: bytes(await zip.generateAsync({ type: 'nodebuffer' })) });
    expect(r.text).toBe('--- Slide 2 ---\nTwo & more\n\n--- Slide 10 ---\nTen & more');
  });

  it('truncates long text and says so', async () => {
    const r = await extractText({ name: 'a.txt', data: bytes('abcdef') }, 4);
    expect(r).toMatchObject({ text: 'abcd', truncated: true });
  });

  it('rejects unsupported and oversized files', async () => {
    await expect(extractText({ name: 'a.exe', data: bytes('MZ') })).rejects.toThrow(/Can't read text/);
    await expect(
      extractText({ name: 'a.txt', data: new Uint8Array(MAX_ATTACHMENT_BYTES + 1) })
    ).rejects.toThrow(/larger than/);
  });
});
