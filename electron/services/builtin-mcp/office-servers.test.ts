/**
 * The Spreadsheet, Presentation and PDF built-ins: files they write open in
 * Office apps (checked structurally here), edits keep what earlier calls made,
 * and confined servers stay in their working directory.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createSpreadsheetServer } from './spreadsheet.server';
import { createPresentationServer } from './presentation.server';
import { createPdfServer } from './pdf.server';
import { chartXml, CHART_TYPES, type ChartSpec } from './xlsx-charts';
import { WRITTEN_FILES_META, openPackage } from './office-files';
import { officeAsHtml } from './office-convert';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudia-office-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Result {
  text: string;
  isError: boolean;
  files: Array<{ path: string; name: string; size: number }>;
}

async function connect(server: McpServer) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(a);
  return async (name: string, args: Record<string, unknown>): Promise<Result> => {
    const r = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text?: string }>;
      isError?: boolean;
      _meta?: Record<string, unknown>;
    };
    return {
      text: r.content.map((c) => c.text ?? '').join('\n'),
      isError: !!r.isError,
      files: (r._meta?.[WRITTEN_FILES_META] as Result['files']) ?? [],
    };
  };
}

const zipOf = async (file: string) => JSZip.loadAsync(fs.readFileSync(file));

function wellFormed(xml: string): boolean {
  let failed = false;
  new DOMParser({ onError: () => (failed = true) }).parseFromString(xml, 'text/xml');
  return !failed;
}

/** A 2×2 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==',
  'base64'
);

describe('Spreadsheet server', () => {
  it('builds a budget with formulas, formats and charts that survive later edits', async () => {
    const call = await connect(createSpreadsheetServer({ workingDirectory: dir }));
    const created = await call('create_workbook', { filename: 'budget', sheets: ['Budget', 'Notes'] });
    expect(created.isError).toBe(false);
    expect(created.files.map((f) => f.name)).toEqual(['budget.xlsx']);

    const wrote = await call('write_range', {
      filename: 'budget.xlsx',
      sheet: 'Budget',
      rows: [
        ['Item', 'Cost'],
        ['Rent', 1200],
        ['Food', 450],
        ['Total', '=SUM(B2:B3)'],
        ['Literal', "'=not a formula"],
        ['Start', '2026-01-31'],
      ],
    });
    expect(wrote.text).toContain('1 formulas');
    await call('format_range', { filename: 'budget.xlsx', sheet: 'Budget', range: 'B2:B4', number_format: 'currency', bold: true });
    await call('set_sheet_layout', { filename: 'budget.xlsx', sheet: 'Budget', freeze: 'A2', auto_fit_columns: true });
    const chart = await call('add_chart', { filename: 'budget.xlsx', sheet: 'Budget', type: 'pie', categories: 'A2:A3', series: [{ values: 'B2:B3', name: 'B1' }], title: 'Split' });
    expect(chart.text).toContain('chart1');

    // Later edits (and a rename) keep the chart, pointing at the renamed sheet
    await call('write_range', { filename: 'budget.xlsx', sheet: 'Notes', rows: [['ok']] });
    await call('rename_sheet', { filename: 'budget.xlsx', sheet: 'Budget', new_name: 'My Budget' });
    const zip = await zipOf(path.join(dir, 'budget.xlsx'));
    const chartFile = zip.file('xl/charts/chart1.xml');
    expect(chartFile).toBeTruthy();
    const xml = await chartFile!.async('string');
    expect(xml).toContain("'My Budget'!$B$2:$B$3");
    expect(wellFormed(xml)).toBe(true);
    expect(await zip.file('[Content_Types].xml')!.async('string')).toContain('drawingml.chart+xml');
    const workbookXml = await zip.file('xl/workbook.xml')!.async('string');
    expect(workbookXml).toMatch(/fullCalcOnLoad="1"/);

    const read = await call('read_range', { filename: 'budget.xlsx', sheet: 'My Budget', range: 'A1:B6' });
    expect(read.text).toContain('=SUM(B2:B3)');
    expect(read.text).toContain('| 5 | Literal | =not a formula |');
    expect(read.text).toContain('2026-01-31');
    const info = await call('get_workbook_info', { filename: 'budget.xlsx' });
    expect(info.text).toContain('chart chart1: pie "Split"');
    expect(info.text).toContain('frozen at A2');

    await call('delete_chart', { filename: 'budget.xlsx', chart_id: 'chart1' });
    expect((await zipOf(path.join(dir, 'budget.xlsx'))).file('xl/charts/chart1.xml')).toBeNull();
  });

  it('writes well-formed chart XML for every chart type', () => {
    for (const type of CHART_TYPES) {
      const spec: ChartSpec = {
        id: 'c',
        sheet: 'Data & more',
        type,
        title: 'T <1>',
        categories: 'A2:A4',
        series: [{ values: 'B2:B4', name: 'B1' }, { values: 'C2:C4', name: 'Literal & name' }],
        anchor: 'E2',
        widthCols: 8,
        heightRows: 16,
        xAxisTitle: 'x',
        yAxisTitle: 'y',
        legend: 'bottom',
        stacked: type === 'column',
        dataLabels: true,
      };
      const xml = chartXml(spec, () => [1, 2, 3]);
      expect(wellFormed(xml), type).toBe(true);
      expect(xml).toContain("'Data &amp; more'!$B$2:$B$4");
    }
  });

  it('refuses to edit a workbook whose pivot tables a save would drop', async () => {
    const call = await connect(createSpreadsheetServer({ workingDirectory: dir }));
    await call('create_workbook', { filename: 'pivot.xlsx' });
    const file = path.join(dir, 'pivot.xlsx');
    const zip = await zipOf(file);
    zip.file('xl/pivotTables/pivotTable1.xml', '<pivotTableDefinition/>');
    fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
    const before = fs.readFileSync(file);

    const res = await call('write_range', { filename: 'pivot.xlsx', sheet: 'Sheet1', rows: [[1]] });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('pivot tables');
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it('stays in the working directory when confined', async () => {
    const call = await connect(createSpreadsheetServer({ workingDirectory: dir, confineToWorkingDirectory: true }));
    const res = await call('create_workbook', { filename: '../outside.xlsx' });
    expect(res.isError).toBe(true);
    expect(fs.existsSync(path.join(dir, '..', 'outside.xlsx'))).toBe(false);
    // A root-relative name lands in the working directory
    expect((await call('create_workbook', { filename: '/inside.xlsx' })).isError).toBe(false);
    expect(fs.existsSync(path.join(dir, 'inside.xlsx'))).toBe(true);
  });
});

describe('openPackage', () => {
  it('refuses archives with too many entries before inflating them', async () => {
    const zip = new JSZip();
    for (let i = 0; i <= 10_000; i++) zip.file(`f${i}`, '');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(openPackage(buf, 'bomb.xlsx')).rejects.toThrow('too large when unpacked');
    await expect(openPackage(Buffer.from('not a zip'), 'x.xlsx')).rejects.toThrow('not a valid Office file');
  });
});

describe('Presentation server', () => {
  const slides = [
    { layout: 'title', title: 'Deck', subtitle: 'Sub', notes: 'Hello' },
    { title: 'Points', bullets: ['One', { text: 'Two', level: 1 }], image: { path: 'pic.png', caption: 'Pic' } },
    { title: 'Numbers', chart: { type: 'column', categories: ['A', 'B'], series: [{ name: 'S', values: [1, 2] }] } },
    { title: 'Table', table: { header: ['k', 'v'], rows: [['a', 1]] } },
    { layout: 'quote', quote: { text: 'Q', attribution: 'Me' } },
  ];

  it('creates a 5-slide deck with a chart and notes, and edits it', async () => {
    fs.writeFileSync(path.join(dir, 'pic.png'), PNG);
    const call = await connect(createPresentationServer({ workingDirectory: dir }));
    const created = await call('create_presentation', { filename: 'deck', theme: { name: 'corporate' }, slides });
    expect(created.isError).toBe(false);
    expect(created.files.map((f) => f.name)).toEqual(['deck.pptx']);

    const file = path.join(dir, 'deck.pptx');
    let zip = await zipOf(file);
    const slideFiles = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    expect(slideFiles).toHaveLength(5);
    expect(Object.keys(zip.files).some((n) => n.startsWith('ppt/charts/'))).toBe(true);
    expect(Object.keys(zip.files).some((n) => n.startsWith('ppt/media/'))).toBe(true);
    expect(await zip.file('ppt/_rels/presentation.xml.rels')!.async('string')).toContain('customXml/claudiaDeck.xml');

    await call('add_slides', { filename: 'deck.pptx', slides: [{ title: 'End', text: 'Thanks' }], position: 2 });
    await call('update_slide', { filename: 'deck.pptx', slide_number: 3, slide: { title: 'Points (updated)' } });
    await call('move_slide', { filename: 'deck.pptx', from: 2, to: 6 });
    await call('delete_slides', { filename: 'deck.pptx', slide_numbers: [5] });
    const read = await call('read_presentation', { filename: 'deck.pptx' });
    expect(read.text).toContain('5 slides');
    expect(read.text).toMatch(/2\. \[bullets\] Points \(updated\)/);
    expect(read.text).toMatch(/5\. \[bullets\] End/);
    expect(read.text).toContain('notes: Hello');

    zip = await zipOf(file);
    expect(Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))).toHaveLength(5);
  });

  it('reads, but does not edit, decks it did not make', async () => {
    const call = await connect(createPresentationServer({ workingDirectory: dir }));
    await call('create_presentation', { filename: 'mine.pptx', slides: [{ title: 'Kept text', notes: 'Note text' }] });
    // Strip the definition: now it looks like any other deck
    const zip = await zipOf(path.join(dir, 'mine.pptx'));
    zip.remove('customXml/claudiaDeck.xml');
    fs.writeFileSync(path.join(dir, 'other.pptx'), await zip.generateAsync({ type: 'nodebuffer' }));

    const read = await call('read_presentation', { filename: 'other.pptx' });
    expect(read.text).toContain('not made by Claudia');
    expect(read.text).toContain('Kept text');
    expect(read.text).toContain('notes: Note text');
    const edit = await call('add_slides', { filename: 'other.pptx', slides: [{ title: 'x' }] });
    expect(edit.isError).toBe(true);
    expect(edit.text).toContain('was not made with create_presentation');
  });

  it('refuses images outside a confined working directory', async () => {
    const outside = path.join(dir, '..', `outside-${path.basename(dir)}.png`);
    fs.writeFileSync(outside, PNG);
    try {
      const call = await connect(createPresentationServer({ workingDirectory: dir, confineToWorkingDirectory: true }));
      const res = await call('create_presentation', { filename: 'd.pptx', slides: [{ layout: 'image', image: { path: outside } }] });
      expect(res.isError).toBe(true);
      expect(fs.existsSync(path.join(dir, 'd.pptx'))).toBe(false);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});

describe('PDF server', () => {
  it('lays out Markdown without a browser, and says what it could not show', async () => {
    fs.writeFileSync(path.join(dir, 'pic.png'), PNG);
    const call = await connect(createPdfServer({ workingDirectory: dir }));
    const res = await call('create_pdf', {
      filename: 'report',
      content: '# Title\n\nText with **bold**.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n\n![pic](pic.png)\n\n![remote](https://example.com/x.png)\n\nمرحبا',
    });
    expect(res.isError).toBe(false);
    expect(res.files.map((f) => f.name)).toEqual(['report.pdf']);
    expect(fs.readFileSync(path.join(dir, 'report.pdf')).subarray(0, 5).toString()).toBe('%PDF-');
    expect(res.text).toContain('https://example.com/x.png');
    expect(res.text).toContain('Arabic');

    // Not replaced without overwrite
    expect((await call('create_pdf', { filename: 'report.pdf', content: 'x' })).isError).toBe(true);
  });

  it('uses the injected HTML renderer, with the working directory for relative paths', async () => {
    const seen: Array<{ html: string; baseDir?: string; landscape: boolean }> = [];
    const call = await connect(
      createPdfServer({
        workingDirectory: dir,
        renderHtmlPdf: async (html: string, opts: { baseDir?: string; landscape: boolean }) => {
          seen.push({ html, baseDir: opts.baseDir, landscape: opts.landscape });
          return Buffer.from('%PDF-1.7 fake');
        },
      })
    );
    fs.writeFileSync(path.join(dir, 'notes.md'), '# Notes\n\n*hi*');
    const res = await call('convert_file_to_pdf', { filename: 'notes.md', landscape: true });
    expect(res.isError).toBe(false);
    expect(seen[0].html).toContain('<h1>Notes</h1>');
    expect(seen[0].html).toContain('<em>hi</em>');
    expect(seen[0].baseDir).toBe(dir);
    expect(seen[0].landscape).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'notes.pdf'), 'utf-8')).toBe('%PDF-1.7 fake');
  });

  it('stays in the working directory when confined', async () => {
    const call = await connect(createPdfServer({ workingDirectory: dir, confineToWorkingDirectory: true }));
    expect((await call('create_pdf', { filename: '../x.pdf', content: 'x' })).isError).toBe(true);
    expect((await call('convert_file_to_pdf', { filename: path.join(os.tmpdir(), 'nope.md') })).isError).toBe(true);
  });

  it('turns Office files into HTML for the approximate route', async () => {
    const xlsx = await connect(createSpreadsheetServer({ workingDirectory: dir }));
    await xlsx('create_workbook', { filename: 'b.xlsx' });
    await xlsx('write_range', { filename: 'b.xlsx', sheet: 'Sheet1', rows: [['Item', 'Cost'], ['Tea & cake', 3], ['Total', '=SUM(B2:B2)']] });
    const sheet = await officeAsHtml(path.join(dir, 'b.xlsx'));
    expect(sheet.html).toContain('<td>Tea &amp; cake</td>');
    expect(sheet.html).toContain('=SUM(B2:B2)');

    const pptx = await connect(createPresentationServer({ workingDirectory: dir }));
    await pptx('create_presentation', { filename: 'd.pptx', slides: [{ title: 'R&D', bullets: ['a < b'] }] });
    const deck = await officeAsHtml(path.join(dir, 'd.pptx'));
    expect(deck.html).toContain('<p>R&amp;D</p>');
    expect(deck.html).toContain('<p>a &lt; b</p>');
  });
});
