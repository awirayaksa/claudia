import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Document, Packer, Paragraph } from 'docx';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { ExtractPool } from './pool';
import { ExtractLimitError, inspectZip } from './limits';
import { minimalPdf } from '../test/documents';

let pool: ExtractPool;
beforeAll(() => {
  pool = new ExtractPool({ maxThreads: 2, timeoutMs: 20_000, maxInputBytes: 5 * 1024 * 1024 });
});
afterAll(async () => {
  await pool.close();
});

describe('ExtractPool formats', () => {
  it('reads PDF', async () => {
    const doc = await pool.documentText(minimalPdf('Hello PDF'), 'a.pdf', 'application/pdf');
    expect(doc).toMatchObject({ format: 'pdf', truncated: false });
    expect(doc!.text).toContain('Hello PDF');
  });

  it('reads DOCX', async () => {
    const buf = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('Quarterly review')] }] }));
    expect((await pool.documentText(buf, 'r.docx'))!.text).toContain('Quarterly review');
  });

  it('reads XLSX with the SheetJS CDN build', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['item', 'qty'], ['pear', 4]]), 'Stock');
    const buf: Buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    expect((await pool.documentText(buf, 's.xlsx'))!.text).toBe('--- Sheet: Stock ---\nitem\tqty\npear\t4');
  });

  it('reads PPTX', async () => {
    const zip = new JSZip();
    zip.file('ppt/slides/slide1.xml', '<p:sld><a:t>Intro</a:t></p:sld>');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    expect((await pool.documentText(buf, 'd.pptx'))!.text).toBe('--- Slide 1 ---\nIntro');
  });

  it('reads HTML as markdown without running scripts', async () => {
    const html =
      '<html><head><title>Doc</title><script>globalThis.pwned = true</script></head><body><article><h2>Part</h2><p>Body text that is long enough for readability to keep it as the main content of the page.</p></article></body></html>';
    const doc = await pool.documentText(Buffer.from(html), 'p.html', 'text/html');
    expect(doc!.format).toBe('html');
    expect(doc!.text).toContain('Body text');
    expect((globalThis as any).pwned).toBeUndefined();
  });

  it('returns null for unsupported files', async () => {
    expect(await pool.documentText(Buffer.from([0, 1, 2]), 'a.exe')).toBeNull();
  });

  it('renders DOT to SVG in a worker', async () => {
    expect(await pool.renderSvg('digraph { a -> b }', 'dot')).toContain('<svg');
  });

  it('turns SVG into PNG in a worker', async () => {
    const png = await pool.svgToPng(await pool.renderSvg('digraph { a -> b }', 'dot'), 2);
    expect(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
  });

  it('turns a fetched page into markdown in a worker', async () => {
    const html = '<html><head><title>Docs</title><script>alert(1)</script></head><body><article><h1>Install</h1><p>Run <code>npm i</code> first.</p></article></body></html>';
    const res = await pool.htmlToMarkdown(html, 'https://docs.example.com/install');
    expect(res.markdown).toContain('npm i');
    expect(res.markdown).not.toContain('alert(1)');
  });
});

describe('ExtractPool limits', () => {
  it('refuses oversized input before parsing', async () => {
    await expect(pool.documentText(Buffer.alloc(6 * 1024 * 1024), 'big.txt')).rejects.toThrow(/larger than 5 MB/);
  });

  it('kills a job that runs too long and keeps working afterwards', async () => {
    const started = Date.now();
    await expect(pool.run({ op: 'spin' }, 500)).rejects.toThrow(ExtractLimitError);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect((await pool.documentText(Buffer.from('still alive'), 'a.txt'))!.text).toBe('still alive');
  });

  it('refuses a zip that claims to expand too far', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml', 'x');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    // Forge the declared uncompressed size in the central directory entry
    const cd = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    buf.writeUInt32LE(300 * 1024 * 1024, cd + 24);
    expect(() => inspectZip(buf)).toThrow(/expands to more than/);
    await expect(pool.documentText(buf, 'bomb.docx')).rejects.toThrow(/expands to more than/);
  });

  it('refuses a real compression bomb by its ratio', async () => {
    const zip = new JSZip();
    zip.file('xl/worksheets/sheet1.xml', Buffer.alloc(30 * 1024 * 1024)); // zeros compress ~1000:1
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    expect(buf.length).toBeLessThan(1024 * 1024);
    await expect(pool.documentText(buf, 'bomb.xlsx')).rejects.toThrow(/zip bomb/);
  });

  it('refuses archives with too many parts and damaged archives', () => {
    expect(() =>
      inspectZip(Buffer.from('not a zip at all, just text padding padding padding'))
    ).toThrow(/Not a valid zip/);
    expect(() => inspectZip(Buffer.alloc(100), { maxUncompressedBytes: 1, maxZipEntries: 1, maxCompressionRatio: 1 })).toThrow();
  });
});
