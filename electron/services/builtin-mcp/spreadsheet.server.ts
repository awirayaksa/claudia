import * as fs from 'fs';
import * as path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Workbook, Worksheet, Cell, Borders, Alignment } from 'exceljs';
import { atomicWrite, errorResult, fileScope, openPackage, resolveFile, withFileLock, wroteFiles, type FileScope } from './office-files';
import {
  CHART_TYPES,
  LEGEND_POSITIONS,
  colLetter,
  parseCell,
  parseRange,
  readChartSpecs,
  renameSheetInSpec,
  unsupportedContent,
  writeCharts,
  type ChartSpec,
  type RangeRef,
} from './xlsx-charts';

// ============================================================================
// Lazy-loaded dependencies
// ============================================================================

let excelModule: typeof import('exceljs') | null = null;

function getExcel(): typeof import('exceljs') {
  if (!excelModule) excelModule = require('exceljs');
  return excelModule!;
}

// ============================================================================
// Values and formats
// ============================================================================

type InputValue = string | number | boolean | null;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/** Short names for common number formats; anything else is used as an Excel format code. */
const NUMBER_FORMATS: Record<string, string> = {
  general: 'General',
  integer: '#,##0',
  decimal: '#,##0.00',
  currency: '"$"#,##0.00',
  accounting: '_("$"* #,##0.00_);_("$"* (#,##0.00);_("$"* "-"??_);_(@_)',
  percent: '0.0%',
  date: 'yyyy-mm-dd',
  datetime: 'yyyy-mm-dd hh:mm',
  text: '@',
};

function numberFormat(f: string): string {
  return NUMBER_FORMATS[f.toLowerCase()] ?? f;
}

/** "#1F4E79", "1f4e79" → "FF1F4E79" (ExcelJS wants ARGB). */
function argb(color: string): string {
  const hex = color.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return `FF${hex.toUpperCase()}`;
  if (/^[0-9a-fA-F]{8}$/.test(hex)) return hex.toUpperCase();
  throw new Error(`Invalid color "${color}" (use hex like "#1F4E79")`);
}

/** Put one input value in a cell: "=…" is a formula, "'…" literal text, ISO dates become dates. */
function setCellValue(cell: Cell, value: InputValue): void {
  if (value === null || value === undefined || value === '') {
    cell.value = null;
    return;
  }
  if (typeof value !== 'string') {
    cell.value = value;
    return;
  }
  if (value.startsWith("'")) {
    cell.value = value.slice(1);
    return;
  }
  if (value.startsWith('=') && value.length > 1) {
    cell.value = { formula: value.slice(1) } as never;
    return;
  }
  const d = ISO_DATE.exec(value);
  if (d) {
    const [, y, mo, da, h, mi, s] = d;
    cell.value = new Date(Date.UTC(+y, +mo - 1, +da, +(h ?? 0), +(mi ?? 0), +(s ?? 0)));
    if (!cell.numFmt || cell.numFmt === 'General') cell.numFmt = h ? NUMBER_FORMATS.datetime : NUMBER_FORMATS.date;
    return;
  }
  cell.value = value;
}

/** A cell as the model reads it: formulas as "=…" (with their last result, when the file has one). */
function cellText(cell: Cell): string {
  const v = cell.value as unknown;
  if (v === null || v === undefined) return '';
  if (cell.formula) {
    const result = cell.result as unknown;
    const shown = result === undefined || result === null ? '' : ` → ${plain(result)}`;
    return `=${cell.formula}${shown}`;
  }
  return plain(v);
}

function plain(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().replace(/T00:00:00\.000Z$/, '').replace(/\.000Z$/, 'Z');
  if (typeof v === 'object') {
    const o = v as { richText?: Array<{ text: string }>; text?: string; error?: string; result?: unknown };
    if (o.richText) return o.richText.map((r) => r.text).join('');
    if (o.error) return o.error;
    if (o.text !== undefined) return String(o.text);
    if ('result' in o) return plain(o.result);
    return JSON.stringify(v);
  }
  return String(v);
}

/** Values of a range for a chart's cached data; undefined when a formula has no result yet. */
function rangeValues(wb: Workbook) {
  return (ref: RangeRef): Array<string | number | null> | undefined => {
    const ws = wb.getWorksheet(ref.sheet);
    if (!ws) return undefined;
    const out: Array<string | number | null> = [];
    for (let r = ref.start.row; r <= ref.end.row; r++) {
      for (let c = ref.start.col; c <= ref.end.col; c++) {
        const cell = ws.getCell(r + 1, c + 1);
        let v = cell.value as unknown;
        if (cell.formula) {
          v = cell.result;
          if (v === undefined || v === null) return undefined;
        }
        if (v === null || v === undefined) out.push(null);
        else if (typeof v === 'number') out.push(v);
        else if (typeof v === 'string') out.push(v);
        else if (typeof v === 'boolean') out.push(v ? 1 : 0);
        else return undefined; // dates, rich text: let the app read the cells
      }
    }
    return out;
  };
}

// ============================================================================
// Sheets
// ============================================================================

function checkSheetName(name: string): void {
  if (!name || name.length > 31 || /[\\/?*[\]:]/.test(name) || /^'|'$/.test(name)) {
    throw new Error(`Invalid sheet name "${name}": 1–31 characters, none of \\ / ? * [ ] :`);
  }
}

function getSheet(wb: Workbook, name: string | undefined): Worksheet {
  const ws = name === undefined ? wb.worksheets[0] : wb.getWorksheet(name);
  if (!ws) {
    const names = wb.worksheets.map((w) => `"${w.name}"`).join(', ');
    throw new Error(name === undefined ? 'The workbook has no sheets.' : `No sheet named "${name}". Sheets: ${names}`);
  }
  return ws;
}

function usedRange(ws: Worksheet): string {
  const dims = (ws as unknown as { dimensions?: { range?: string } }).dimensions;
  return ws.actualRowCount === 0 ? '(empty)' : dims?.range ?? `A1:${colLetter(Math.max(ws.columnCount, 1) - 1)}${ws.rowCount}`;
}

/** Every cell of a range ("A1:C3"). */
function eachCell(ws: Worksheet, range: string, fn: (cell: Cell) => void): number {
  const r = parseRange(range, ws.name);
  let n = 0;
  for (let row = r.start.row; row <= r.end.row; row++) {
    for (let col = r.start.col; col <= r.end.col; col++) {
      fn(ws.getCell(row + 1, col + 1));
      n++;
    }
  }
  return n;
}

// ============================================================================
// Opening and saving
// ============================================================================

async function loadWorkbook(filepath: string): Promise<{ wb: Workbook; charts: ChartSpec[]; lossy: string[] }> {
  let buf: Buffer;
  try {
    buf = await fs.promises.readFile(filepath);
  } catch {
    throw new Error(`Workbook not found: ${filepath}. Create it first with create_workbook.`);
  }
  const zip = await openPackage(buf, path.basename(filepath));
  const charts = await readChartSpecs(zip);
  const lossy = await unsupportedContent(zip, charts);
  const wb = new (getExcel().Workbook)();
  await wb.xlsx.load(buf as never);
  return { wb, charts, lossy };
}

async function saveWorkbook(filepath: string, wb: Workbook, charts: ChartSpec[]): Promise<void> {
  // Excel recalculates every formula on open (the file holds formulas without results)
  wb.calcProperties = { ...(wb.calcProperties ?? {}), fullCalcOnLoad: true };
  let out: Buffer = Buffer.from(await wb.xlsx.writeBuffer());
  if (charts.length) out = await writeCharts(out, charts, rangeValues(wb));
  await atomicWrite(filepath, out);
}

/** Open a workbook, change it, save it. Refuses workbooks whose content a save would drop. */
async function editWorkbook(
  scope: FileScope,
  filename: string,
  change: (wb: Workbook, charts: ChartSpec[]) => string | { text: string; charts: ChartSpec[] }
) {
  const filepath = resolveFile(scope, filename, '.xlsx');
  return withFileLock(filepath, async () => {
    const { wb, charts, lossy } = await loadWorkbook(filepath);
    if (lossy.length) {
      return errorResult(
        `${path.basename(filepath)} contains ${lossy.join(', ')} that this tool cannot keep, so it was not changed. ` +
          'Create a new workbook instead (read this one with read_range and write the data there), or edit it in Excel.'
      );
    }
    const res = change(wb, charts);
    const text = typeof res === 'string' ? res : res.text;
    await saveWorkbook(filepath, wb, typeof res === 'string' ? charts : res.charts);
    return wroteFiles(`${text}\nSaved: ${filepath}`, filepath);
  });
}

// ============================================================================
// Server factory
// ============================================================================

const cellValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export function createSpreadsheetServer(config?: Record<string, unknown>): McpServer {
  const server = new McpServer({ name: 'Claudia Spreadsheets', version: '1.0.0' }, { capabilities: { tools: {} } });
  const scope = fileScope(config);
  const fileParam = z.string().describe('Workbook path, e.g. "budget.xlsx" (relative to the working directory).');
  const sheetParam = z.string().describe('Sheet name, e.g. "Sheet1".');

  // ---- create_workbook ----
  server.tool(
    'create_workbook',
    'Create a new Excel workbook (.xlsx) with one or more empty sheets. Then fill it with write_range, style it with ' +
      'format_range and set_sheet_layout, and add charts with add_chart. The file opens in Excel, LibreOffice and Google Sheets.',
    {
      filename: fileParam,
      sheets: z.array(z.string()).optional().describe('Sheet names in order (default: ["Sheet1"]).'),
      title: z.string().optional().describe('Document title (file properties).'),
      author: z.string().optional().describe('Author (file properties).'),
      overwrite: z.boolean().optional().describe('Replace the file if it exists (default: false).'),
    },
    async ({ filename, sheets, title, author, overwrite }) => {
      const filepath = resolveFile(scope, filename, '.xlsx');
      if (!overwrite && fs.existsSync(filepath)) {
        return errorResult(`${filepath} already exists. Pass overwrite: true to replace it, or edit it with the other tools.`);
      }
      const names = sheets?.length ? sheets : ['Sheet1'];
      names.forEach(checkSheetName);
      if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) return errorResult('Sheet names must be unique.');
      const wb = new (getExcel().Workbook)();
      wb.creator = author || 'Claudia';
      if (title) wb.title = title;
      wb.created = new Date();
      for (const n of names) wb.addWorksheet(n);
      await withFileLock(filepath, () => saveWorkbook(filepath, wb, []));
      return wroteFiles(`Created workbook ${filepath} with sheets: ${names.join(', ')}`, filepath);
    }
  );

  // ---- get_workbook_info ----
  server.tool(
    'get_workbook_info',
    'Describe an Excel workbook: its sheets, the used range of each, frozen panes, merged cells and charts.',
    { filename: fileParam },
    async ({ filename }) => {
      const filepath = resolveFile(scope, filename, '.xlsx');
      const { wb, charts, lossy } = await loadWorkbook(filepath);
      const lines = [`Workbook: ${filepath}`, ''];
      for (const ws of wb.worksheets) {
        const view = ws.views?.[0] as { state?: string; xSplit?: number; ySplit?: number } | undefined;
        const frozen = view?.state === 'frozen' ? `, frozen at ${colLetter(view.xSplit ?? 0)}${(view.ySplit ?? 0) + 1}` : '';
        const merges = Object.keys((ws as unknown as { _merges?: object })._merges ?? {}).length;
        lines.push(`- "${ws.name}": ${usedRange(ws)}${frozen}${merges ? `, ${merges} merged ranges` : ''}${ws.state !== 'visible' ? ` (${ws.state})` : ''}`);
        for (const c of charts.filter((ch) => ch.sheet === ws.name)) {
          lines.push(`  - chart ${c.id}: ${c.type}${c.title ? ` "${c.title}"` : ''} at ${c.anchor}, ${c.series.length} series`);
        }
      }
      if (lossy.length) lines.push('', `Also contains ${lossy.join(', ')}; the editing tools refuse this workbook so they are not lost.`);
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    }
  );

  // ---- read_range ----
  server.tool(
    'read_range',
    'Read cells from a sheet as a table. Formulas are shown as "=FORMULA → last result" (no result until the file has been ' +
      'opened and saved in a spreadsheet app). Reads the used range when no range is given (at most 200 rows × 40 columns).',
    {
      filename: fileParam,
      sheet: z.string().optional().describe('Sheet name (default: the first sheet).'),
      range: z.string().optional().describe('Cells to read, e.g. "A1:F20" (default: the used range).'),
    },
    async ({ filename, sheet, range }) => {
      const filepath = resolveFile(scope, filename, '.xlsx');
      const { wb } = await loadWorkbook(filepath);
      const ws = getSheet(wb, sheet);
      if (!range && ws.actualRowCount === 0) return { content: [{ type: 'text' as const, text: `Sheet "${ws.name}" is empty.` }] };
      const r = parseRange(range ?? usedRange(ws), ws.name);
      const lastRow = Math.min(r.end.row, r.start.row + 199);
      const lastCol = Math.min(r.end.col, r.start.col + 39);
      const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
      const header = ['', ...Array.from({ length: lastCol - r.start.col + 1 }, (_, i) => colLetter(r.start.col + i))];
      const rows = [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`];
      for (let row = r.start.row; row <= lastRow; row++) {
        const cells = [String(row + 1)];
        for (let col = r.start.col; col <= lastCol; col++) cells.push(esc(cellText(ws.getCell(row + 1, col + 1))));
        rows.push(`| ${cells.join(' | ')} |`);
      }
      const cut = lastRow < r.end.row || lastCol < r.end.col ? `\n(Showing ${colLetter(r.start.col)}${r.start.row + 1}:${colLetter(lastCol)}${lastRow + 1}; read the rest with a range.)` : '';
      return { content: [{ type: 'text' as const, text: `Sheet "${ws.name}"\n\n${rows.join('\n')}${cut}` }] };
    }
  );

  // ---- write_range ----
  server.tool(
    'write_range',
    'Write a block of values into a sheet, starting at a cell. Each inner array is one row. Strings starting with "=" are ' +
      'formulas (e.g. "=SUM(B2:B10)", "=B2*C2", "=AVERAGE(Data!B:B)"); start a string with an apostrophe to store it as text ' +
      'instead. ISO dates ("2026-03-31") become real dates. Use formulas rather than computed numbers so the sheet stays live.',
    {
      filename: fileParam,
      sheet: sheetParam,
      start_cell: z.string().optional().describe('Top-left cell to write from (default: "A1").'),
      rows: z.array(z.array(cellValue)).describe('Rows of values, e.g. [["Item","Cost"],["Rent",1200],["Total","=SUM(B2:B2)"]].'),
      number_format: z.string().optional().describe('Number format for the written cells: integer, decimal, currency, accounting, percent, date, datetime, text, or an Excel format code like "#,##0.00 €".'),
    },
    async ({ filename, sheet, start_cell, rows, number_format }) =>
      editWorkbook(scope, filename, (wb) => {
        const ws = getSheet(wb, sheet);
        const start = parseCell(start_cell ?? 'A1');
        const fmt = number_format ? numberFormat(number_format) : undefined;
        let formulas = 0;
        let width = 0;
        rows.forEach((row, ri) => {
          width = Math.max(width, row.length);
          row.forEach((value, ci) => {
            const cell = ws.getCell(start.row + ri + 1, start.col + ci + 1);
            if (fmt) cell.numFmt = fmt;
            setCellValue(cell, value);
            if (cell.formula) formulas++;
          });
        });
        const end = `${colLetter(start.col + Math.max(width, 1) - 1)}${start.row + Math.max(rows.length, 1)}`;
        return `Wrote ${rows.length} rows to "${ws.name}"!${colLetter(start.col)}${start.row + 1}:${end}${formulas ? ` (${formulas} formulas)` : ''}.`;
      })
  );

  // ---- format_range ----
  server.tool(
    'format_range',
    'Style cells: number format, font, fill color, alignment and borders. Only the options given are changed.',
    {
      filename: fileParam,
      sheet: sheetParam,
      range: z.string().describe('Cells to format, e.g. "A1:F1" or "B2:B20".'),
      number_format: z.string().optional().describe('integer, decimal, currency, accounting, percent, date, datetime, text, or an Excel format code.'),
      bold: z.boolean().optional(),
      italic: z.boolean().optional(),
      underline: z.boolean().optional(),
      font_size: z.number().min(6).max(72).optional(),
      font_name: z.string().optional().describe('e.g. "Calibri", "Arial".'),
      font_color: z.string().optional().describe('Hex color, e.g. "#FFFFFF".'),
      fill_color: z.string().optional().describe('Background hex color, e.g. "#1F4E79".'),
      horizontal_align: z.enum(['left', 'center', 'right', 'justify']).optional(),
      vertical_align: z.enum(['top', 'middle', 'bottom']).optional(),
      wrap_text: z.boolean().optional(),
      border: z.enum(['none', 'thin', 'medium', 'thick', 'double']).optional().describe('Border on every side of every cell.'),
      border_color: z.string().optional().describe('Hex color for the border (default: black).'),
    },
    async (a) =>
      editWorkbook(scope, a.filename, (wb) => {
        const ws = getSheet(wb, a.sheet);
        const fmt = a.number_format ? numberFormat(a.number_format) : undefined;
        const fontColor = a.font_color ? argb(a.font_color) : undefined;
        const fill = a.fill_color ? argb(a.fill_color) : undefined;
        const borderColor = a.border_color ? argb(a.border_color) : 'FF000000';
        const n = eachCell(ws, a.range, (cell) => {
          if (fmt) cell.numFmt = fmt;
          const font = { ...(cell.font ?? {}) } as Record<string, unknown>;
          if (a.bold !== undefined) font.bold = a.bold;
          if (a.italic !== undefined) font.italic = a.italic;
          if (a.underline !== undefined) font.underline = a.underline;
          if (a.font_size !== undefined) font.size = a.font_size;
          if (a.font_name !== undefined) font.name = a.font_name;
          if (fontColor) font.color = { argb: fontColor };
          cell.font = font;
          if (fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
          if (a.horizontal_align || a.vertical_align || a.wrap_text !== undefined) {
            const al: Partial<Alignment> = { ...(cell.alignment ?? {}) };
            if (a.horizontal_align) al.horizontal = a.horizontal_align;
            if (a.vertical_align) al.vertical = a.vertical_align;
            if (a.wrap_text !== undefined) al.wrapText = a.wrap_text;
            cell.alignment = al;
          }
          if (a.border) {
            const side = a.border === 'none' ? {} : { style: a.border, color: { argb: borderColor } };
            cell.border = { top: side, left: side, bottom: side, right: side } as Partial<Borders>;
          }
        });
        return `Formatted ${n} cells in "${ws.name}"!${a.range}.`;
      })
  );

  // ---- set_sheet_layout ----
  server.tool(
    'set_sheet_layout',
    'Arrange a sheet: column widths (or fit them to the content), row heights, frozen panes, merged cells, an auto filter, ' +
      'gridlines and the tab color. Only the options given are changed.',
    {
      filename: fileParam,
      sheet: sheetParam,
      column_widths: z.record(z.string(), z.number().min(0).max(255)).optional().describe('Width per column in characters, e.g. {"A": 28, "B": 12}.'),
      auto_fit_columns: z.boolean().optional().describe('Fit every used column to its longest value.'),
      row_heights: z.record(z.string(), z.number().min(0).max(409)).optional().describe('Height per row in points, e.g. {"1": 30}.'),
      freeze: z.string().optional().describe('Freeze the rows above and columns left of this cell, e.g. "A2" (header row) or "B2". "none" unfreezes.'),
      merge: z.array(z.string()).optional().describe('Ranges to merge, e.g. ["A1:F1"].'),
      unmerge: z.array(z.string()).optional().describe('Merged ranges to split.'),
      auto_filter: z.string().optional().describe('Range for filter buttons, e.g. "A1:F50" (header row first). "none" removes it.'),
      show_gridlines: z.boolean().optional(),
      tab_color: z.string().optional().describe('Hex color of the sheet tab.'),
    },
    async (a) =>
      editWorkbook(scope, a.filename, (wb) => {
        const ws = getSheet(wb, a.sheet);
        const done: string[] = [];
        for (const [col, width] of Object.entries(a.column_widths ?? {})) ws.getColumn(col.toUpperCase()).width = width;
        if (a.column_widths) done.push('column widths');
        if (a.auto_fit_columns) {
          ws.columns.forEach((column) => {
            let longest = 0;
            column.eachCell?.({ includeEmpty: false }, (cell) => {
              const text = cell.formula ? plain(cell.result ?? '') || '0000000000' : cell.numFmt && typeof cell.value === 'number' ? cell.text : plain(cell.value);
              longest = Math.max(longest, ...text.split('\n').map((l) => l.length));
            });
            if (longest) column.width = Math.min(Math.max(longest + 2, 8), 60);
          });
          done.push('fitted columns');
        }
        for (const [row, height] of Object.entries(a.row_heights ?? {})) ws.getRow(parseInt(row, 10)).height = height;
        if (a.row_heights) done.push('row heights');
        if (a.freeze) {
          if (a.freeze.toLowerCase() === 'none') ws.views = [{ state: 'normal' }];
          else {
            const at = parseCell(a.freeze);
            ws.views = [{ state: 'frozen', xSplit: at.col, ySplit: at.row, topLeftCell: a.freeze.toUpperCase() }];
          }
          done.push(`freeze ${a.freeze}`);
        }
        for (const r of a.unmerge ?? []) ws.unMergeCells(r);
        for (const r of a.merge ?? []) ws.mergeCells(r);
        if (a.merge?.length) done.push(`merged ${a.merge.join(', ')}`);
        if (a.unmerge?.length) done.push(`unmerged ${a.unmerge.join(', ')}`);
        if (a.auto_filter) {
          ws.autoFilter = a.auto_filter.toLowerCase() === 'none' ? (undefined as never) : a.auto_filter;
          done.push(`filter ${a.auto_filter}`);
        }
        if (a.show_gridlines !== undefined) {
          const view = { ...(ws.views?.[0] ?? { state: 'normal' }), showGridLines: a.show_gridlines };
          ws.views = [view as never];
          done.push(a.show_gridlines ? 'gridlines on' : 'gridlines off');
        }
        if (a.tab_color) {
          ws.properties.tabColor = { argb: argb(a.tab_color) };
          done.push('tab color');
        }
        return done.length ? `Updated "${ws.name}": ${done.join('; ')}.` : 'Nothing to change.';
      })
  );

  // ---- add_sheet ----
  server.tool(
    'add_sheet',
    'Add an empty sheet to a workbook.',
    {
      filename: fileParam,
      name: z.string().describe('New sheet name (1–31 characters).'),
      position: z.number().int().min(1).optional().describe('1-based position among the sheets (default: last).'),
    },
    async ({ filename, name, position }) =>
      editWorkbook(scope, filename, (wb) => {
        checkSheetName(name);
        if (wb.getWorksheet(name)) throw new Error(`A sheet named "${name}" already exists.`);
        const ws = wb.addWorksheet(name);
        if (position && position < wb.worksheets.length) {
          // Reorder by orderNo (ExcelJS writes sheets in that order)
          const ordered = wb.worksheets.filter((w) => w !== ws);
          ordered.splice(position - 1, 0, ws);
          ordered.forEach((w, i) => ((w as unknown as { orderNo: number }).orderNo = i));
        }
        return `Added sheet "${name}".`;
      })
  );

  // ---- rename_sheet ----
  server.tool(
    'rename_sheet',
    'Rename a sheet. Charts made with add_chart follow the new name; formulas in cells that mention the old name are not changed.',
    { filename: fileParam, sheet: sheetParam, new_name: z.string() },
    async ({ filename, sheet, new_name }) =>
      editWorkbook(scope, filename, (wb, charts) => {
        checkSheetName(new_name);
        const ws = getSheet(wb, sheet);
        if (wb.getWorksheet(new_name) && new_name.toLowerCase() !== sheet.toLowerCase()) throw new Error(`A sheet named "${new_name}" already exists.`);
        ws.name = new_name;
        return { text: `Renamed "${sheet}" to "${new_name}".`, charts: charts.map((c) => renameSheetInSpec(c, sheet, new_name)) };
      })
  );

  // ---- delete_sheet ----
  server.tool(
    'delete_sheet',
    'Delete a sheet and the charts on it.',
    { filename: fileParam, sheet: sheetParam },
    async ({ filename, sheet }) =>
      editWorkbook(scope, filename, (wb, charts) => {
        const ws = getSheet(wb, sheet);
        if (wb.worksheets.length === 1) throw new Error('A workbook needs at least one sheet.');
        wb.removeWorksheet(ws.id);
        return { text: `Deleted sheet "${sheet}".`, charts: charts.filter((c) => c.sheet !== ws.name) };
      })
  );

  // ---- add_chart ----
  server.tool(
    'add_chart',
    'Add a native Excel chart that plots cells of the workbook (it updates when the data changes). Types: column, bar ' +
      '(horizontal), line, area, pie, doughnut, scatter. Give each series a values range and, optionally, a name (literal ' +
      'text or the header cell, e.g. "B1"); categories are the labels (x values for scatter). Charts are kept when the ' +
      'workbook is edited with these tools.',
    {
      filename: fileParam,
      sheet: z.string().describe('Sheet to place the chart on.'),
      type: z.enum(CHART_TYPES),
      series: z
        .array(z.object({ values: z.string().describe('e.g. "B2:B13" or "Data!B2:B13"'), name: z.string().optional().describe('e.g. "B1" or "Revenue"') }))
        .min(1)
        .describe('Data series (pie and doughnut use the first only).'),
      categories: z.string().optional().describe('Category labels, e.g. "A2:A13".'),
      title: z.string().optional(),
      anchor: z.string().optional().describe('Top-left cell of the chart (default: right of the data).'),
      width: z.number().int().min(2).max(40).optional().describe('Width in columns (default: 8).'),
      height: z.number().int().min(4).max(80).optional().describe('Height in rows (default: 16).'),
      x_axis_title: z.string().optional(),
      y_axis_title: z.string().optional(),
      legend: z.enum(LEGEND_POSITIONS).optional().describe('Legend position (default: right; bottom for pie/doughnut).'),
      stacked: z.boolean().optional().describe('Stack the series (column, bar, line, area).'),
      data_labels: z.boolean().optional().describe('Show values on the chart (percentages for pie/doughnut).'),
    },
    async (a) =>
      editWorkbook(scope, a.filename, (wb, charts) => {
        const ws = getSheet(wb, a.sheet);
        // Check every reference now: a bad one would only show up as a broken chart
        for (const ref of [a.categories, ...a.series.map((s) => s.values)]) {
          if (!ref) continue;
          const r = parseRange(ref, ws.name);
          getSheet(wb, r.sheet);
        }
        let anchor = a.anchor?.toUpperCase();
        if (!anchor) {
          const below = charts.filter((c) => c.sheet === ws.name).reduce((m, c) => Math.max(m, parseCell(c.anchor).row + c.heightRows + 1), 1);
          anchor = `${colLetter(Math.max(ws.columnCount, 1) + 1)}${below + (charts.some((c) => c.sheet === ws.name) ? 1 : 0)}`;
        }
        parseCell(anchor);
        const pie = a.type === 'pie' || a.type === 'doughnut';
        const id = `chart${charts.reduce((m, c) => Math.max(m, parseInt(c.id.replace(/\D/g, ''), 10) || 0), 0) + 1}`;
        const spec: ChartSpec = {
          id,
          sheet: ws.name,
          type: a.type,
          title: a.title,
          categories: a.categories,
          series: a.series,
          anchor,
          widthCols: a.width ?? 8,
          heightRows: a.height ?? 16,
          xAxisTitle: a.x_axis_title,
          yAxisTitle: a.y_axis_title,
          legend: a.legend ?? (pie ? 'bottom' : a.series.length > 1 ? 'right' : 'none'),
          stacked: a.stacked,
          dataLabels: a.data_labels,
        };
        return { text: `Added ${a.type} chart ${id} on "${ws.name}" at ${anchor}.`, charts: [...charts, spec] };
      })
  );

  // ---- delete_chart ----
  server.tool(
    'delete_chart',
    'Delete a chart made with add_chart (ids are listed by get_workbook_info).',
    { filename: fileParam, chart_id: z.string().describe('e.g. "chart1"') },
    async ({ filename, chart_id }) =>
      editWorkbook(scope, filename, (_wb, charts) => {
        if (!charts.some((c) => c.id === chart_id)) throw new Error(`No chart "${chart_id}". Charts: ${charts.map((c) => c.id).join(', ') || 'none'}`);
        return { text: `Deleted ${chart_id}.`, charts: charts.filter((c) => c.id !== chart_id) };
      })
  );

  return server;
}
