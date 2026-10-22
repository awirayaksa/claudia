/**
 * Office files (Word, Excel, PowerPoint, OpenDocument) to PDF.
 *
 * In order: Microsoft Office through COM (Windows), then LibreOffice where it
 * is installed. When neither is there, callers fall back to an approximate
 * route through HTML (see officeAsHtml).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { pathToFileURL } from 'url';
import { openPackage } from './office-files';

// ============================================================================
// Processes
// ============================================================================

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = '';
    let err = '';
    const t = setTimeout(() => {
      p.kill();
      reject(new Error(`${path.basename(cmd)} took longer than ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);
    p.stdout.on('data', (d: Buffer) => (out += d.toString()));
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, out: out.trim(), err: err.trim() });
    });
    p.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

/** Run a PowerShell script (Windows). Rejects with stderr when it fails. */
export async function runPowerShell(script: string, timeoutMs = 60_000): Promise<string> {
  const { code, out, err } = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], timeoutMs);
  if (code !== 0 && err) throw new Error(err);
  return out;
}

// ============================================================================
// Microsoft Office (Windows)
// ============================================================================

export type OfficeKind = 'word' | 'excel' | 'powerpoint';

const KIND_BY_EXT: Record<string, OfficeKind> = {
  '.docx': 'word', '.docm': 'word', '.doc': 'word', '.dotx': 'word', '.rtf': 'word', '.odt': 'word',
  '.xlsx': 'excel', '.xlsm': 'excel', '.xls': 'excel', '.ods': 'excel', '.csv': 'excel',
  '.pptx': 'powerpoint', '.pptm': 'powerpoint', '.ppt': 'powerpoint', '.odp': 'powerpoint',
};

export function officeKind(file: string): OfficeKind | null {
  return KIND_BY_EXT[path.extname(file).toLowerCase()] ?? null;
}

const APP_NAME: Record<OfficeKind, string> = { word: 'Microsoft Word', excel: 'Microsoft Excel', powerpoint: 'Microsoft PowerPoint' };

/** Convert with the matching Office app. Resolves false when that app isn't installed. */
async function msOfficeToPdf(src: string, out: string, kind: OfficeKind): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const scripts: Record<OfficeKind, string> = {
    word: `
      if (-not [type]::GetTypeFromProgID('Word.Application')) { 'NOT_INSTALLED'; exit 0 }
      $app = New-Object -ComObject Word.Application
      $app.Visible = $false; $app.DisplayAlerts = 0
      try { $d = $app.Documents.Open(${q(src)}, $false, $true); $d.ExportAsFixedFormat(${q(out)}, 17); $d.Close(0); 'OK' }
      finally { $app.Quit(); [Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null }`,
    excel: `
      if (-not [type]::GetTypeFromProgID('Excel.Application')) { 'NOT_INSTALLED'; exit 0 }
      $app = New-Object -ComObject Excel.Application
      $app.Visible = $false; $app.DisplayAlerts = $false
      try { $w = $app.Workbooks.Open(${q(src)}, 0, $true); $w.ExportAsFixedFormat(0, ${q(out)}); $w.Close($false); 'OK' }
      finally { $app.Quit(); [Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null }`,
    // PowerPoint runs as a single instance: quit only when no other presentation is open
    powerpoint: `
      if (-not [type]::GetTypeFromProgID('PowerPoint.Application')) { 'NOT_INSTALLED'; exit 0 }
      $app = New-Object -ComObject PowerPoint.Application
      try { $p = $app.Presentations.Open(${q(src)}, -1, 0, 0); $p.SaveAs(${q(out)}, 32); $p.Close(); 'OK' }
      finally { if ($app.Presentations.Count -eq 0) { $app.Quit() }; [Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null }`,
  };
  const result = await runPowerShell(scripts[kind], 180_000);
  if (result.includes('NOT_INSTALLED')) return false;
  if (!fs.existsSync(out)) throw new Error(`${APP_NAME[kind]} did not produce a PDF.`);
  return true;
}

// ============================================================================
// LibreOffice
// ============================================================================

let libreOfficePath: string | null | undefined;

function onPath(names: string[]): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const n of names) {
      const p = path.join(dir, n);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

/** LibreOffice's soffice, if installed (LIBREOFFICE_PATH wins). Cached. */
export function findLibreOffice(): string | null {
  if (libreOfficePath !== undefined) return libreOfficePath;
  const fromEnv = process.env.LIBREOFFICE_PATH;
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'LibreOffice', 'program', 'soffice.com'),
          path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'LibreOffice', 'program', 'soffice.com'),
        ]
      : process.platform === 'darwin'
        ? ['/Applications/LibreOffice.app/Contents/MacOS/soffice']
        : ['/usr/bin/soffice', '/usr/bin/libreoffice', '/usr/lib/libreoffice/program/soffice', '/opt/libreoffice/program/soffice', '/snap/bin/libreoffice'];
  libreOfficePath =
    (fromEnv && fs.existsSync(fromEnv) ? fromEnv : null) ??
    candidates.find((c) => fs.existsSync(c)) ??
    onPath(process.platform === 'win32' ? ['soffice.com', 'soffice.exe'] : ['soffice', 'libreoffice']);
  return libreOfficePath;
}

/** Convert with LibreOffice in its own profile (so it works while LibreOffice is open, and in parallel). */
async function libreOfficeToPdf(soffice: string, src: string, out: string): Promise<void> {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'claudia-lo-'));
  try {
    const profile = path.join(tmp, 'profile');
    const outDir = path.join(tmp, 'out');
    await fs.promises.mkdir(outDir);
    const { code, err } = await run(
      soffice,
      [`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--norestore', '--nolockcheck', '--convert-to', 'pdf', '--outdir', outDir, src],
      180_000
    );
    const produced = path.join(outDir, `${path.parse(src).name}.pdf`);
    if (!fs.existsSync(produced)) throw new Error(`LibreOffice could not convert the file${err ? `: ${err}` : code ? ` (exit code ${code})` : ''}.`);
    await fs.promises.mkdir(path.dirname(out), { recursive: true });
    await fs.promises.copyFile(produced, out);
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// ============================================================================
// Public API
// ============================================================================

export interface OfficeConvertOptions {
  /** Use LibreOffice when it is installed (the web server only does when the admin set LIBREOFFICE_PATH). */
  useLibreOffice: boolean;
}

/**
 * Convert an Office file to PDF with Microsoft Office or LibreOffice.
 * Resolves with the app used, or null when neither is available.
 */
export async function officeToPdf(src: string, out: string, opts: OfficeConvertOptions): Promise<string | null> {
  const kind = officeKind(src);
  if (!kind) throw new Error(`Not an Office file: ${path.basename(src)}`);
  let officeError: Error | null = null;
  try {
    if (await msOfficeToPdf(src, out, kind)) return APP_NAME[kind];
  } catch (err) {
    officeError = err as Error; // try LibreOffice before giving up
  }
  const soffice = opts.useLibreOffice ? findLibreOffice() : null;
  if (soffice) {
    await libreOfficeToPdf(soffice, src, out);
    return 'LibreOffice';
  }
  if (officeError) throw officeError;
  return null;
}

/** Office file → HTML for the approximate route (when there is no Office or LibreOffice). */
export async function officeAsHtml(src: string): Promise<{ html: string; note: string }> {
  const kind = officeKind(src);
  const ext = path.extname(src).toLowerCase();
  if (!['.docx', '.docm', '.dotx', '.xlsx', '.xlsm', '.pptx', '.pptm'].includes(ext)) {
    throw new Error(`Converting ${ext} files to PDF needs Microsoft Office (Windows) or LibreOffice, and neither was found.`);
  }
  const buf = await fs.promises.readFile(src);
  // Every route below unzips the file: check it first
  const zip = await openPackage(buf, path.basename(src));
  if (kind === 'word' && (ext === '.docx' || ext === '.docm' || ext === '.dotx')) {
    const mammoth = require('mammoth');
    const { value } = await mammoth.convertToHtml({ buffer: buf });
    return { html: value, note: 'converted from the document\'s content; page layout, headers and footers may differ from Word' };
  }
  if (kind === 'excel' && (ext === '.xlsx' || ext === '.xlsm')) {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const parts: string[] = [];
    wb.eachSheet((ws: any) => {
      if (ws.state !== 'visible') return;
      parts.push(`<h2>${esc(ws.name)}</h2><table>`);
      ws.eachRow({ includeEmpty: false }, (row: any, rowNumber: number) => {
        const cells: string[] = [];
        for (let c = 1; c <= ws.columnCount; c++) {
          const cell = row.getCell(c);
          const text = cell.formula && (cell.result === undefined || cell.result === null) ? `=${cell.formula}` : String(cell.text ?? '');
          cells.push(rowNumber === 1 ? `<th>${esc(text)}</th>` : `<td>${esc(text)}</td>`);
        }
        parts.push(`<tr>${cells.join('')}</tr>`);
      });
      parts.push('</table>');
    });
    return { html: parts.join('\n'), note: 'cell values only; charts and most formatting are left out, and formulas without a saved result are shown as formulas' };
  }
  if (kind === 'powerpoint' && (ext === '.pptx' || ext === '.pptm')) {
    const names = Object.keys(zip.files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => parseInt(a.replace(/\D/g, ''), 10) - parseInt(b.replace(/\D/g, ''), 10));
    const parts: string[] = [];
    for (const [i, n] of names.entries()) {
      const xml = await zip.file(n)!.async('string');
      // Run text stays XML-escaped, which is also what HTML needs
      const paras = xml.split(/<\/a:p>/).map((p) => [...p.matchAll(/<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>/g)].map((m) => m[1]).join('')).filter((t) => t.trim());
      parts.push(`<h2>Slide ${i + 1}</h2>${paras.map((p) => `<p>${p}</p>`).join('')}`);
    }
    return { html: parts.join('\n'), note: 'text of each slide only (no layout, images or charts)' };
  }
  throw new Error(`Unexpected file type: ${ext}`);
}
