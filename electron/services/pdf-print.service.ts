/**
 * HTML → PDF with Chromium (the built-in PDF and Word servers use it on the
 * desktop). The page is loaded in a hidden window with JavaScript off, in its
 * own in-memory session, and printed with printToPDF.
 */
import { BrowserWindow, session } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { pathToFileURL } from 'url';
import type { HtmlPdfRenderer } from './builtin-mcp/pdf-render';

const PARTITION = 'claudia-pdf-render';
let sessionReady = false;

function renderSession(): Electron.Session {
  const ses = session.fromPartition(PARTITION, { cache: false });
  if (!sessionReady) {
    // Pages and images only: no websockets, no downloads of other kinds
    ses.webRequest.onBeforeRequest((details, cb) => {
      const ok = /^(file|data|https?):/i.test(details.url) && ['mainFrame', 'image', 'stylesheet', 'font', 'other'].includes(details.resourceType);
      cb({ cancel: !ok });
    });
    ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
    sessionReady = true;
  }
  return ses;
}

/** Relative image paths in the page point at `baseDir`. */
function withBase(html: string, baseDir: string | undefined): string {
  if (!baseDir || /<base\s/i.test(html)) return html;
  const href = pathToFileURL(baseDir.endsWith(path.sep) ? baseDir : baseDir + path.sep).href;
  return html.replace(/<head([^>]*)>/i, `<head$1><base href="${href}">`);
}

export const printHtmlToPdf: HtmlPdfRenderer = async (html, opts) => {
  const tmp = path.join(os.tmpdir(), `claudia-pdf-${crypto.randomBytes(6).toString('hex')}.html`);
  await fs.promises.writeFile(tmp, withBase(html, opts.baseDir), 'utf-8');
  const win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 1400,
    webPreferences: { session: renderSession(), javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
  });
  try {
    await win.loadFile(tmp);
    const footer = opts.pageNumbers === false
      ? '<div></div>'
      : '<div style="width:100%;text-align:center;font-size:8px;color:#8c959f;font-family:sans-serif"><span class="pageNumber"></span> / <span class="totalPages"></span></div>';
    return await win.webContents.printToPDF({
      pageSize: opts.pageSize,
      landscape: opts.landscape,
      printBackground: true,
      margins: { top: 0.75, bottom: 0.75, left: 0.75, right: 0.75 },
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: footer,
    });
  } finally {
    win.destroy();
    fs.promises.unlink(tmp).catch(() => {});
  }
};
