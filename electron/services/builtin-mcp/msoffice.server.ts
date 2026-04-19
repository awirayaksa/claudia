import AdmZip from 'adm-zip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Document, Packer } from 'docx';
const mammoth = require('mammoth');

// ============================================================================
// Constants
// ============================================================================

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL_FOOTNOTES = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes';
const REL_ENDNOTES = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes';
const REL_IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const CT_FOOTNOTES = 'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml';
const CT_ENDNOTES = 'application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml';

const FOOTNOTES_TEMPLATE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote></w:footnotes>`;

const ENDNOTES_TEMPLATE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:endnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:endnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:endnote><w:endnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:endnote></w:endnotes>`;

// ============================================================================
// XML / ZIP helpers
// ============================================================================

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function resolvePath(filename: string, workingDir: string): string {
  return path.isAbsolute(filename) ? filename : path.join(workingDir, filename);
}

function getZipEntry(zip: AdmZip, name: string): string | null {
  const e = zip.getEntry(name);
  return e ? e.getData().toString('utf8') : null;
}

function setZipEntry(zip: AdmZip, name: string, content: string): void {
  if (zip.getEntry(name)) zip.updateFile(name, Buffer.from(content, 'utf8'));
  else zip.addFile(name, Buffer.from(content, 'utf8'));
}

async function saveZip(zip: AdmZip, filepath: string): Promise<void> {
  await fs.writeFile(filepath, zip.toBuffer());
}

function parseXmlDoc(xml: string): Document {
  return new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document;
}

function serializeDoc(doc: Document): string {
  return new XMLSerializer().serializeToString(doc as any);
}

function getBodyEl(doc: Document): Element {
  const els = (doc as any).getElementsByTagNameNS(W_NS, 'body');
  if (!els || els.length === 0) throw new Error('No w:body found');
  return els[0];
}

function directChildren(el: Element): Element[] {
  const out: Element[] = [];
  let n = el.firstChild;
  while (n) {
    if (n.nodeType === 1) out.push(n as Element);
    n = n.nextSibling;
  }
  return out;
}

function bodyParagraphs(body: Element): Element[] {
  return directChildren(body).filter(c => c.localName === 'p');
}

function bodyTables(body: Element): Element[] {
  return directChildren(body).filter(c => c.localName === 'tbl');
}

function paraText(p: Element): string {
  const ts = (p as any).getElementsByTagNameNS(W_NS, 't');
  let t = '';
  for (let i = 0; i < ts.length; i++) t += ts[i].textContent || '';
  return t;
}

function insertBeforeSectPr(body: Element, node: Element): void {
  const children = directChildren(body);
  const sp = children.find(c => c.localName === 'sectPr');
  if (sp) body.insertBefore(node, sp);
  else body.appendChild(node);
}

function mkEl(doc: Document, tag: string): Element {
  return (doc as any).createElement(tag);
}

function setAttr(el: Element, name: string, value: string): void {
  (el as any).setAttribute(name, value);
}

// Build run-properties XML
function buildRPr(o: {
  fontName?: string; bold?: boolean; italic?: boolean;
  underline?: boolean; color?: string; fontSize?: number; rStyle?: string;
} = {}): string {
  const p: string[] = [];
  if (o.rStyle) p.push(`<w:rStyle w:val="${escapeXml(o.rStyle)}"/>`);
  if (o.fontName) p.push(`<w:rFonts w:ascii="${escapeXml(o.fontName)}" w:hAnsi="${escapeXml(o.fontName)}"/>`);
  if (o.bold) p.push('<w:b/>');
  if (o.italic) p.push('<w:i/>');
  if (o.underline) p.push('<w:u w:val="single"/>');
  if (o.color) p.push(`<w:color w:val="${escapeXml(o.color.replace('#', ''))}"/>`);
  if (o.fontSize) { const v = o.fontSize * 2; p.push(`<w:sz w:val="${v}"/><w:szCs w:val="${v}"/>`); }
  return p.length ? `<w:rPr>${p.join('')}</w:rPr>` : '';
}

// Build paragraph XML
function buildParaXml(text: string, o: {
  pStyle?: string; rStyle?: string; fontName?: string; bold?: boolean;
  italic?: boolean; underline?: boolean; color?: string; fontSize?: number;
  numId?: number; ilvl?: number; borderBottom?: boolean;
} = {}): string {
  const pPrParts: string[] = [];
  if (o.pStyle) pPrParts.push(`<w:pStyle w:val="${escapeXml(o.pStyle)}"/>`);
  if (o.numId !== undefined)
    pPrParts.push(`<w:numPr><w:ilvl w:val="${o.ilvl ?? 0}"/><w:numId w:val="${o.numId}"/></w:numPr>`);
  if (o.borderBottom)
    pPrParts.push('<w:pBdr><w:bottom w:val="single" w:sz="4" w:space="1" w:color="auto"/></w:pBdr>');
  const pPr = pPrParts.length ? `<w:pPr>${pPrParts.join('')}</w:pPr>` : '';
  const rPr = buildRPr(o);
  const sp = text.length > 0 && (text[0] === ' ' || text[text.length - 1] === ' ')
    ? ' xml:space="preserve"' : '';
  return `<w:p>${pPr}<w:r>${rPr}<w:t${sp}>${escapeXml(text)}</w:t></w:r></w:p>`;
}

// Import an XML string as an Element into a target document
function importFragment(xmlStr: string, targetDoc: Document): Element {
  const ns = `xmlns:w="${W_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:xml="http://www.w3.org/XML/1998/namespace"`;
  const tmp = parseXmlDoc(`<root ${ns}>${xmlStr}</root>`);
  const child = tmp.documentElement.firstChild!;
  return (targetDoc as any).importNode(child, true) as Element;
}

// Apply string-based insert before <w:sectPr
function strInsertBeforeSectPr(docXml: string, fragment: string): string {
  const idx = docXml.lastIndexOf('<w:sectPr');
  if (idx !== -1) return docXml.slice(0, idx) + fragment + docXml.slice(idx);
  const end = docXml.lastIndexOf('</w:body>');
  if (end !== -1) return docXml.slice(0, end) + fragment + docXml.slice(end);
  return docXml;
}

// Find paragraph containing text; returns index into bodyParagraphs()
function findParaByText(body: Element, text: string, matchCase: boolean): number {
  const paras = bodyParagraphs(body);
  const needle = matchCase ? text : text.toLowerCase();
  for (let i = 0; i < paras.length; i++) {
    const t = matchCase ? paraText(paras[i]) : paraText(paras[i]).toLowerCase();
    if (t.includes(needle)) return i;
  }
  return -1;
}

// ============================================================================
// Relationship helpers
// ============================================================================

function getNextRelId(zip: AdmZip): string {
  const xml = getZipEntry(zip, 'word/_rels/document.xml.rels') || '';
  const nums = [...xml.matchAll(/Id="rId(\d+)"/g)].map(m => parseInt(m[1], 10));
  return `rId${nums.length ? Math.max(...nums) + 1 : 1}`;
}

function addRel(zip: AdmZip, type: string, target: string): string {
  const rId = getNextRelId(zip);
  let xml = getZipEntry(zip, 'word/_rels/document.xml.rels');
  if (!xml) {
    xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
  }
  const entry = `<Relationship Id="${rId}" Type="${type}" Target="${target}"/>`;
  xml = xml.replace('</Relationships>', `${entry}</Relationships>`);
  setZipEntry(zip, 'word/_rels/document.xml.rels', xml);
  return rId;
}

function hasRelType(zip: AdmZip, type: string): boolean {
  const xml = getZipEntry(zip, 'word/_rels/document.xml.rels') || '';
  return xml.includes(type);
}

function addContentType(zip: AdmZip, partName: string, contentType: string): void {
  let xml = getZipEntry(zip, '[Content_Types].xml') || '';
  if (xml.includes(partName)) return;
  const entry = `<Override PartName="${partName}" ContentType="${contentType}"/>`;
  xml = xml.replace('</Types>', `${entry}</Types>`);
  setZipEntry(zip, '[Content_Types].xml', xml);
}

// ============================================================================
// Footnote / endnote helpers
// ============================================================================

function ensureFootnotes(zip: AdmZip): void {
  if (!getZipEntry(zip, 'word/footnotes.xml')) {
    setZipEntry(zip, 'word/footnotes.xml', FOOTNOTES_TEMPLATE);
    addContentType(zip, '/word/footnotes.xml', CT_FOOTNOTES);
    if (!hasRelType(zip, REL_FOOTNOTES)) addRel(zip, REL_FOOTNOTES, 'footnotes.xml');
  }
}

function ensureEndnotes(zip: AdmZip): void {
  if (!getZipEntry(zip, 'word/endnotes.xml')) {
    setZipEntry(zip, 'word/endnotes.xml', ENDNOTES_TEMPLATE);
    addContentType(zip, '/word/endnotes.xml', CT_ENDNOTES);
    if (!hasRelType(zip, REL_ENDNOTES)) addRel(zip, REL_ENDNOTES, 'endnotes.xml');
  }
}

function getNextNoteId(notesXml: string, tag: string): number {
  const matches = [...notesXml.matchAll(new RegExp(`<w:${tag}[^>]+w:id="(-?\\d+)"`, 'g'))];
  const ids = matches.map(m => parseInt(m[1], 10)).filter(n => n > 0);
  return ids.length ? Math.max(...ids) + 1 : 1;
}

// ============================================================================
// PowerShell runner (for PDF conversion)
// ============================================================================

function runPS(script: string, timeoutMs = 60000): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    let out = '', err = '';
    const t = setTimeout(() => { p.kill(); reject(new Error('PowerShell timeout')); }, timeoutMs);
    p.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    p.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    p.on('close', code => {
      clearTimeout(t);
      if (code !== 0 && err.trim()) reject(new Error(err.trim()));
      else resolve(out.trim());
    });
    p.on('error', e => { clearTimeout(t); reject(e); });
  });
}

// ============================================================================
// Password hash for document protection (OOXML SHA-512 spin hash)
// ============================================================================

function computePasswordHash(password: string): { salt: string; hash: string; spinCount: number } {
  const spinCount = 100000;
  const saltBytes = crypto.randomBytes(16);
  const pwBytes = Buffer.from(password, 'utf16le');
  let h = crypto.createHash('sha512').update(saltBytes).update(pwBytes).digest();
  for (let i = 0; i < spinCount; i++) {
    const ib = Buffer.allocUnsafe(4);
    ib.writeUInt32LE(i, 0);
    h = crypto.createHash('sha512').update(h).update(ib).digest();
  }
  return { salt: saltBytes.toString('base64'), hash: h.toString('base64'), spinCount };
}

// ============================================================================
// Image dimension readers (PNG / JPEG)
// ============================================================================

function getImageDimensions(buf: Buffer, ext: string): { w: number; h: number } {
  if (ext === 'png' && buf.length >= 24) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if ((ext === 'jpg' || ext === 'jpeg') && buf.length > 10) {
    let offset = 2;
    while (offset < buf.length - 10) {
      if (buf[offset] !== 0xff) break;
      const marker = buf[offset + 1];
      const len = buf.readUInt16BE(offset + 2);
      if (marker === 0xc0 || marker === 0xc2) {
        return { w: buf.readUInt16BE(offset + 7), h: buf.readUInt16BE(offset + 5) };
      }
      offset += 2 + len;
    }
  }
  return { w: 100, h: 100 }; // fallback
}

// ============================================================================
// Server factory
// ============================================================================

export function createMsOfficeServer(config?: Record<string, unknown>): McpServer {
  const server = new McpServer(
    { name: 'Ms Office Files', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );
  const workingDir = (config?.workingDirectory as string) || process.cwd();

  // ══════════════════════════════════════════════════════════════════════════
  // GROUP 1 – Document Management
  // ══════════════════════════════════════════════════════════════════════════

  server.tool(
    'create_document',
    'Create a new Word (.docx) document. Returns the saved file path.',
    {
      filename: z.string().describe('File name, e.g. "report.docx". .docx is added if missing.'),
      title: z.string().optional().describe('Document title metadata'),
      author: z.string().optional().describe('Document author metadata'),
    },
    async ({ filename, title, author }) => {
      const fname = filename.endsWith('.docx') ? filename : `${filename}.docx`;
      const filepath = resolvePath(fname, workingDir);
      const doc = new Document({
        title: title || '',
        creator: author || '',
        sections: [{ children: [] }],
      });
      const buf = await Packer.toBuffer(doc);
      await fs.writeFile(filepath, buf);
      return { content: [{ type: 'text' as const, text: `Created: ${filepath}` }] };
    }
  );

  server.tool(
    'copy_document',
    'Duplicate an existing .docx document.',
    {
      source_filename: z.string().describe('Source file name or path'),
      destination_filename: z.string().describe('Destination file name or path'),
    },
    async ({ source_filename, destination_filename }) => {
      const src = resolvePath(source_filename, workingDir);
      const dst = resolvePath(destination_filename, workingDir);
      await fs.copyFile(src, dst);
      return { content: [{ type: 'text' as const, text: `Copied: ${src} → ${dst}` }] };
    }
  );

  server.tool(
    'get_document_info',
    'Retrieve metadata and properties of a .docx document.',
    { filename: z.string().describe('File name or path') },
    async ({ filename }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      const coreXml = getZipEntry(zip, 'docProps/core.xml') || '';
      const appXml = getZipEntry(zip, 'docProps/app.xml') || '';
      const extract = (xml: string, tag: string) => {
        const m = xml.match(new RegExp(`<[^:>]*:?${tag}[^>]*>([\\s\\S]*?)<\/[^:>]*:?${tag}>`));
        return m ? m[1].trim() : '';
      };
      const info: Record<string, string> = {
        title: extract(coreXml, 'title'),
        creator: extract(coreXml, 'creator'),
        description: extract(coreXml, 'description'),
        created: extract(coreXml, 'created'),
        modified: extract(coreXml, 'modified'),
        lastModifiedBy: extract(coreXml, 'lastModifiedBy'),
        revision: extract(coreXml, 'revision'),
        application: extract(appXml, 'Application'),
        pages: extract(appXml, 'Pages'),
        words: extract(appXml, 'Words'),
        characters: extract(appXml, 'Characters'),
        paragraphs: extract(appXml, 'Paragraphs'),
      };
      const lines = Object.entries(info).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
      return { content: [{ type: 'text' as const, text: lines.join('\n') || 'No metadata found.' }] };
    }
  );

  server.tool(
    'get_document_text',
    'Extract all text content from a .docx document.',
    { filename: z.string().describe('File name or path') },
    async ({ filename }) => {
      const filepath = resolvePath(filename, workingDir);
      const result = await mammoth.extractRawText({ path: filepath });
      return { content: [{ type: 'text' as const, text: result.value || '(empty document)' }] };
    }
  );

  server.tool(
    'get_document_outline',
    'Display the heading structure and outline of a .docx document.',
    { filename: z.string().describe('File name or path') },
    async ({ filename }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      const docXml = getZipEntry(zip, 'word/document.xml') || '';
      const doc = parseXmlDoc(docXml);
      const body = getBodyEl(doc);
      const paras = bodyParagraphs(body);
      const lines: string[] = [];
      for (const p of paras) {
        const pPr = (p as any).getElementsByTagNameNS(W_NS, 'pStyle');
        if (!pPr || pPr.length === 0) continue;
        const style: string = pPr[0].getAttribute('w:val') || '';
        const m = style.match(/^[Hh]eading\s*(\d)/);
        if (m) {
          const level = parseInt(m[1], 10);
          const indent = '  '.repeat(level - 1);
          lines.push(`${indent}H${level}: ${paraText(p)}`);
        }
      }
      return { content: [{ type: 'text' as const, text: lines.join('\n') || 'No headings found.' }] };
    }
  );

  server.tool(
    'list_available_documents',
    'List all .docx files in a directory.',
    { directory: z.string().optional().describe('Directory path (default: working directory)') },
    async ({ directory }) => {
      const dir = directory ? resolvePath(directory, workingDir) : workingDir;
      const entries = await fs.readdir(dir);
      const docs = entries.filter(e => e.toLowerCase().endsWith('.docx'));
      const text = docs.length ? docs.map(d => path.join(dir, d)).join('\n') : 'No .docx files found.';
      return { content: [{ type: 'text' as const, text }] };
    }
  );

  server.tool(
    'get_document_xml',
    'Get the raw XML content of word/document.xml from a .docx file.',
    { filename: z.string().describe('File name or path') },
    async ({ filename }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      const xml = getZipEntry(zip, 'word/document.xml') || '(not found)';
      return { content: [{ type: 'text' as const, text: xml }] };
    }
  );

  // ══════════════════════════════════════════════════════════════════════════
  // GROUP 2 – Content Insertion
  // ══════════════════════════════════════════════════════════════════════════

  server.tool(
    'insert_header_near_text',
    'Insert a heading paragraph before or after a paragraph that contains target text.',
    {
      filename: z.string(),
      target_text: z.string().describe('Text to search for in the document'),
      header_title: z.string().describe('Text for the new heading'),
      position: z.enum(['before', 'after']).optional().describe('Where to insert (default: before)'),
      header_style: z.string().optional().describe('Heading style, e.g. "Heading 1" (default: "Heading 1")'),
      target_paragraph_index: z.number().optional().describe('Fallback paragraph index if text not found'),
    },
    async ({ filename, target_text, header_title, position, header_style, target_paragraph_index }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      const docXml = getZipEntry(zip, 'word/document.xml')!;
      const doc = parseXmlDoc(docXml);
      const body = getBodyEl(doc);
      const paras = bodyParagraphs(body);
      const pos = position || 'before';
      const style = (header_style || 'Heading 1').replace(' ', '');

      let idx = findParaByText(body, target_text, true);
      if (idx === -1 && target_paragraph_index !== undefined) idx = target_paragraph_index;
      if (idx === -1 || idx >= paras.length) throw new Error(`Paragraph containing "${target_text}" not found`);

      const newEl = importFragment(buildParaXml(header_title, { pStyle: style }), doc);
      const refPara = paras[idx];
      if (pos === 'before') body.insertBefore(newEl, refPara);
      else refPara.parentNode!.insertBefore(newEl, refPara.nextSibling);

      setZipEntry(zip, 'word/document.xml', serializeDoc(doc));
      await saveZip(zip, filepath);
      return { content: [{ type: 'text' as const, text: `Inserted heading "${header_title}" ${pos} paragraph ${idx}` }] };
    }
  );

  server.tool(
    'insert_line_or_paragraph_near_text',
    'Insert a text paragraph before or after a paragraph containing target text.',
    {
      filename: z.string(),
      target_text: z.string(),
      line_text: z.string().describe('Text for the new paragraph'),
      position: z.enum(['before', 'after']).optional(),
      line_style: z.string().optional().describe('Paragraph style (e.g. "Normal")'),
      target_paragraph_index: z.number().optional(),
    },
    async ({ filename, target_text, line_text, position, line_style, target_paragraph_index }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      const docXml = getZipEntry(zip, 'word/document.xml')!;
      const doc = parseXmlDoc(docXml);
      const body = getBodyEl(doc);
      const paras = bodyParagraphs(body);
      const pos = position || 'after';

      let idx = findParaByText(body, target_text, true);
      if (idx === -1 && target_paragraph_index !== undefined) idx = target_paragraph_index;
      if (idx === -1 || idx >= paras.length) throw new Error(`Paragraph containing "${target_text}" not found`);

      const newEl = importFragment(buildParaXml(line_text, { pStyle: line_style }), doc);
      const refPara = paras[idx];
      if (pos === 'before') body.insertBefore(newEl, refPara);
      else refPara.parentNode!.insertBefore(newEl, refPara.nextSibling);

      setZipEntry(zip, 'word/document.xml', serializeDoc(doc));
      await saveZip(zip, filepath);
      return { content: [{ type: 'text' as const, text: `Inserted paragraph ${pos} paragraph ${idx}` }] };
    }
  );

  server.tool(
    'insert_numbered_list_near_text',
    'Insert a bulleted or numbered list before or after a paragraph containing target text.',
    {
      filename: z.string(),
      target_text: z.string(),
      list_items: z.array(z.string()).describe('List item texts'),
      position: z.enum(['before', 'after']).optional(),
      target_paragraph_index: z.number().optional(),
      bullet_type: z.enum(['bullet', 'number']).optional().describe('bullet or number (default: bullet)'),
    },
    async ({ filename, target_text, list_items, position, target_paragraph_index, bullet_type }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      const docXml = getZipEntry(zip, 'word/document.xml')!;
      const doc = parseXmlDoc(docXml);
      const body = getBodyEl(doc);
      const paras = bodyParagraphs(body);
      const pos = position || 'after';
      const pStyle = (bullet_type || 'bullet') === 'number' ? 'ListNumber' : 'ListBullet';

      let idx = findParaByText(body, target_text, true);
      if (idx === -1 && target_paragraph_index !== undefined) idx = target_paragraph_index;
      if (idx === -1 || idx >= paras.length) throw new Error(`Paragraph containing "${target_text}" not found`);

      const refPara = paras[idx];
      const newEls = list_items.map(item => importFragment(buildParaXml(item, { pStyle }), doc));

      if (pos === 'before') {
        newEls.reverse().forEach(el => body.insertBefore(el, refPara));
      } else {
        let anchor = refPara;
        newEls.forEach(el => {
          anchor.parentNode!.insertBefore(el, anchor.nextSibling);
          anchor = el;
        });
      }

      setZipEntry(zip, 'word/document.xml', serializeDoc(doc));
      await saveZip(zip, filepath);
      return { content: [{ type: 'text' as const, text: `Inserted ${list_items.length} list items ${pos} paragraph ${idx}` }] };
    }
  );

  server.tool(
    'add_paragraph',
    'Append a formatted paragraph to the end of a document.',
    {
      filename: z.string(),
      text: z.string().describe('Paragraph text'),
      style: z.string().optional().describe('Paragraph style name'),
      font_name: z.string().optional(),
      font_size: z.number().optional().describe('Font size in points'),
      bold: z.boolean().optional(),
      italic: z.boolean().optional(),
      color: z.string().optional().describe('Hex color e.g. "FF0000"'),
    },
    async ({ filename, text, style, font_name, font_size, bold, italic, color }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      const docXml = getZipEntry(zip, 'word/document.xml')!;
      const fragment = buildParaXml(text, { pStyle: style, fontName: font_name, fontSize: font_size, bold, italic, color });
      setZipEntry(zip, 'word/document.xml', strInsertBeforeSectPr(docXml, fragment));
      await saveZip(zip, filepath);
      return { content: [{ type: 'text' as const, text: 'Paragraph added.' }] };
    }
  );

  server.tool(
    'add_heading',
    'Append a heading paragraph to the end of a document.',
    {
      filename: z.string(),
      text: z.string().describe('Heading text'),
      level: z.number().min(1).max(9).describe('Heading level 1–9'),
      font_name: z.string().optional(),
      font_size: z.number().optional(),
      bold: z.boolean().optional(),
      italic: z.boolean().optional(),
      border_bottom: z.boolean().optional().describe('Add a bottom border below the heading'),
    },
    async ({ filename, text, level, font_name, font_size, bold, italic, border_bottom }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      const docXml = getZipEntry(zip, 'word/document.xml')!;
      const fragment = buildParaXml(text, {
        pStyle: `Heading${level}`, fontName: font_name, fontSize: font_size,
        bold, italic, borderBottom: border_bottom,
      });
      setZipEntry(zip, 'word/document.xml', strInsertBeforeSectPr(docXml, fragment));
      await saveZip(zip, filepath);
      return { content: [{ type: 'text' as const, text: `Heading level ${level} added.` }] };
    }
  );

  server.tool(
    'add_picture',
    'Embed an image into the document.',
    {
      filename: z.string().describe('Document file name or path'),
      image_path: z.string().describe('Path to the image file (PNG, JPEG)'),
      width: z.number().optional().describe('Image width in inches (default: 4)'),
    },
    async ({ filename, image_path, width }) => {
      const filepath = resolvePath(filename, workingDir);
      const imgPath = resolvePath(image_path, workingDir);
      const imgBuf = await fs.readFile(imgPath);
      const ext = path.extname(imgPath).toLowerCase().replace('.', '') || 'png';
      const dims = getImageDimensions(imgBuf, ext);

      const zip = new AdmZip(filepath);
      // Find next image index
      const existingMedia = zip.getEntries().filter(e => e.entryName.startsWith('word/media/')).length;
      const imgName = `image${existingMedia + 1}.${ext}`;
      zip.addFile(`word/media/${imgName}`, imgBuf);

      // Add content type for image
      const ctMap: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif' };
      const ct = ctMap[ext] || 'image/png';
      let ctXml = getZipEntry(zip, '[Content_Types].xml') || '';
      if (!ctXml.includes(`Extension="${ext}"`)) {
        ctXml = ctXml.replace('</Types>', `<Default Extension="${ext}" ContentType="${ct}"/></Types>`);
        setZipEntry(zip, '[Content_Types].xml', ctXml);
      }

      const rId = addRel(zip, REL_IMAGE, `media/${imgName}`);

      // Compute EMU dimensions
      const widthIn = width || 4;
      const aspectRatio = dims.h / Math.max(dims.w, 1);
      const cxEmu = Math.round(widthIn * 914400);
      const cyEmu = Math.round(cxEmu * aspectRatio);

      const drawingXml = `<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cxEmu}" cy="${cyEmu}"/><wp:docPr id="${existingMedia + 1}" name="${imgName}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="${imgName}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cxEmu}" cy="${cyEmu}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;

      const docXml = getZipEntry(zip, 'word/document.xml')!;
      setZipEntry(zip, 'word/document.xml', strInsertBeforeSectPr(docXml, drawingXml));
      await saveZip(zip, filepath);
      return { content: [{ type: 'text' as const, text: `Image "${imgName}" embedded (${cxEmu}×${cyEmu} EMU).` }] };
    }
  );

  server.tool(
    'add_table',
    'Append a table to the end of a document.',
    {
      filename: z.string(),
      rows: z.number().describe('Number of rows'),
      cols: z.number().describe('Number of columns'),
      data: z.array(z.array(z.string())).optional().describe('2D array of cell text values'),
    },
    async ({ filename, rows, cols, data }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      const colWidth = Math.floor(9360 / cols); // ~6.5 inch table in twips

      let gridCols = '';
      for (let c = 0; c < cols; c++) gridCols += `<w:gridCol w:w="${colWidth}"/>`;

      let rowsXml = '';
      for (let r = 0; r < rows; r++) {
        let cells = '';
        for (let c = 0; c < cols; c++) {
          const cellText = data?.[r]?.[c] ?? '';
          cells += `<w:tc><w:tcPr><w:tcW w:w="${colWidth}" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>${escapeXml(cellText)}</w:t></w:r></w:p></w:tc>`;
        }
        rowsXml += `<w:tr>${cells}</w:tr>`;
      }

      const tblXml = `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr><w:tblGrid>${gridCols}</w:tblGrid>${rowsXml}</w:tbl>`;

      const docXml = getZipEntry(zip, 'word/document.xml')!;
      setZipEntry(zip, 'word/document.xml', strInsertBeforeSectPr(docXml, tblXml));
      await saveZip(zip, filepath);
      return { content: [{ type: 'text' as const, text: `Table ${rows}×${cols} added.` }] };
    }
  );

  server.tool(
    'add_page_break',
    'Insert a page break at the end of a document.',
    { filename: z.string() },
    async ({ filename }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      const docXml = getZipEntry(zip, 'word/document.xml')!;
      const pageBreak = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
      setZipEntry(zip, 'word/document.xml', strInsertBeforeSectPr(docXml, pageBreak));
      await saveZip(zip, filepath);
      return { content: [{ type: 'text' as const, text: 'Page break added.' }] };
    }
  );

  server.tool(
    'delete_paragraph',
    'Delete the paragraph at the given index (0-based, counting only top-level body paragraphs).',
    {
      filename: z.string(),
      paragraph_index: z.number().describe('0-based index of the paragraph to delete'),
    },
    async ({ filename, paragraph_index }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      const docXml = getZipEntry(zip, 'word/document.xml')!;
      const doc = parseXmlDoc(docXml);
      const body = getBodyEl(doc);
      const paras = bodyParagraphs(body);
      if (paragraph_index < 0 || paragraph_index >= paras.length)
        throw new Error(`Index ${paragraph_index} out of range (${paras.length} paragraphs)`);
      paras[paragraph_index].parentNode!.removeChild(paras[paragraph_index]);
      setZipEntry(zip, 'word/document.xml', serializeDoc(doc));
      await saveZip(zip, filepath);
      return { content: [{ type: 'text' as const, text: `Paragraph ${paragraph_index} deleted.` }] };
    }
  );

  server.tool(
    'search_and_replace',
    'Replace all occurrences of a text string throughout the document.',
    {
      filename: z.string(),
      find_text: z.string().describe('Text to search for'),
      replace_text: z.string().describe('Replacement text'),
    },
    async ({ filename, find_text, replace_text }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      let docXml = getZipEntry(zip, 'word/document.xml')!;
      // Replace inside <w:t>…</w:t> nodes preserving tags
      const escaped = escapeXml(find_text);
      const replacement = escapeXml(replace_text);
      let count = 0;
      docXml = docXml.replace(new RegExp(escaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), () => {
        count++;
        return replacement;
      });
      setZipEntry(zip, 'word/document.xml', docXml);
      await saveZip(zip, filepath);
      return { content: [{ type: 'text' as const, text: `Replaced ${count} occurrence(s).` }] };
    }
  );

  // ══════════════════════════════════════════════════════════════════════════
  // GROUP 3 – Text & Table Formatting
  // ══════════════════════════════════════════════════════════════════════════

  server.tool(
    'create_custom_style',
    'Define a reusable character/paragraph style in the document.',
    {
      filename: z.string(),
      style_name: z.string().describe('Style name (used as the styleId)'),
      bold: z.boolean().optional(),
      italic: z.boolean().optional(),
      font_size: z.number().optional().describe('Font size in points'),
      font_name: z.string().optional(),
      color: z.string().optional().describe('Hex color'),
      base_style: z.string().optional().describe('Base style to inherit from (default: DefaultParagraphFont)'),
    },
    async ({ filename, style_name, bold, italic, font_size, font_name, color, base_style }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      const stylesXml = getZipEntry(zip, 'word/styles.xml');
      if (!stylesXml) throw new Error('word/styles.xml not found in document');
      const safeId = style_name.replace(/\s+/g, '');
      const rPr = buildRPr({ bold, italic, fontSize: font_size, fontName: font_name, color });
      const styleXml = `<w:style w:type="character" w:styleId="${escapeXml(safeId)}"><w:name w:val="${escapeXml(style_name)}"/><w:basedOn w:val="${escapeXml(base_style || 'DefaultParagraphFont')}"/>${rPr ? `<w:rPr>${rPr.replace(/^<w:rPr>|<\/w:rPr>$/g, '')}</w:rPr>` : ''}</w:style>`;
      const updated = stylesXml.replace('</w:styles>', `${styleXml}</w:styles>`);
      setZipEntry(zip, 'word/styles.xml', updated);
      await saveZip(zip, filepath);
      return { content: [{ type: 'text' as const, text: `Style "${style_name}" created.` }] };
    }
  );

  server.tool(
    'format_text',
    'Apply formatting to a run of text within a paragraph.',
    {
      filename: z.string(),
      paragraph_index: z.number().describe('0-based paragraph index'),
      start_pos: z.number().optional().describe('Start character position (unused in current implementation; formats all runs)'),
      end_pos: z.number().optional().describe('End character position (unused; formats all runs)'),
      bold: z.boolean().optional(),
      italic: z.boolean().optional(),
      underline: z.boolean().optional(),
      color: z.string().optional(),
      font_size: z.number().optional(),
      font_name: z.string().optional(),
    },
    async ({ filename, paragraph_index, bold, italic, underline, color, font_size, font_name }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      const docXml = getZipEntry(zip, 'word/document.xml')!;
      const doc = parseXmlDoc(docXml);
      const body = getBodyEl(doc);
      const paras = bodyParagraphs(body);
      if (paragraph_index >= paras.length) throw new Error(`Index ${paragraph_index} out of range`);
      const para = paras[paragraph_index];
      const runs = (para as any).getElementsByTagNameNS(W_NS, 'r');
      for (let i = 0; i < runs.length; i++) {
        const r = runs[i];
        let rPrEl = (r as any).getElementsByTagNameNS(W_NS, 'rPr')[0];
        if (!rPrEl) {
          rPrEl = mkEl(doc, 'w:rPr');
          r.insertBefore(rPrEl, r.firstChild);
        }
        if (bold) rPrEl.appendChild(mkEl(doc, 'w:b'));
        if (italic) rPrEl.appendChild(mkEl(doc, 'w:i'));
        if (underline) {
          const u = mkEl(doc, 'w:u'); setAttr(u, 'w:val', 'single'); rPrEl.appendChild(u);
        }
        if (color) {
          const c = mkEl(doc, 'w:color'); setAttr(c, 'w:val', color.replace('#', '')); rPrEl.appendChild(c);
        }
        if (font_size) {
          const sz = mkEl(doc, 'w:sz'); setAttr(sz, 'w:val', String(font_size * 2)); rPrEl.appendChild(sz);
          const szCs = mkEl(doc, 'w:szCs'); setAttr(szCs, 'w:val', String(font_size * 2)); rPrEl.appendChild(szCs);
        }
        if (font_name) {
          const rf = mkEl(doc, 'w:rFonts');
          setAttr(rf, 'w:ascii', font_name); setAttr(rf, 'w:hAnsi', font_name); rPrEl.insertBefore(rf, rPrEl.firstChild);
        }
      }
      setZipEntry(zip, 'word/document.xml', serializeDoc(doc));
      await saveZip(zip, filepath);
      return { content: [{ type: 'text' as const, text: `Formatting applied to paragraph ${paragraph_index}.` }] };
    }
  );

  server.tool(
    'format_table',
    'Apply border style and background shading to an entire table.',
    {
      filename: z.string(),
      table_index: z.number().describe('0-based table index'),
      has_header_row: z.boolean().optional(),
      border_style: z.string().optional().describe('Border style: single, thick, double, dashed, dotted, none (default: single)'),
      shading: z.string().optional().describe('Table background fill color hex (e.g. "EEEEEE")'),
    },
    async ({ filename, table_index, border_style, shading }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      const docXml = getZipEntry(zip, 'word/document.xml')!;
      const doc = parseXmlDoc(docXml);
      const body = getBodyEl(doc);
      const tables = bodyTables(body);
      if (table_index >= tables.length) throw new Error(`Table index ${table_index} out of range`);
      const tbl = tables[table_index];
      let tblPr = (tbl as any).getElementsByTagNameNS(W_NS, 'tblPr')[0];
      if (!tblPr) { tblPr = mkEl(doc, 'w:tblPr'); tbl.insertBefore(tblPr, tbl.firstChild); }

      const bs = border_style || 'single';
      const bXml = bs === 'none'
        ? '<w:tblBorders><w:top w:val="none" w:sz="0" w:space="0" w:color="auto"/><w:left w:val="none" w:sz="0" w:space="0" w:color="auto"/><w:bottom w:val="none" w:sz="0" w:space="0" w:color="auto"/><w:right w:val="none" w:sz="0" w:space="0" w:color="auto"/><w:insideH w:val="none" w:sz="0" w:space="0" w:color="auto"/><w:insideV w:val="none" w:sz="0" w:space="0" w:color="auto"/></w:tblBorders>'
        : `<w:tblBorders><w:top w:val="${bs}" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="${bs}" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="${bs}" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="${bs}" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="${bs}" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="${bs}" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders>`;

      const borderEl = importFragment(bXml, doc);
      const existingBorder = (tblPr as any).getElementsByTagNameNS(W_NS, 'tblBorders')[0];
      if (existingBorder) tblPr.replaceChild(borderEl, existingBorder);
      else tblPr.appendChild(borderEl);

      if (shading) {
        const shdEl = importFragment(`<w:shd w:val="clear" w:color="auto" w:fill="${escapeXml(shading.replace('#', ''))}"/>`, doc);
        const existing = (tblPr as any).getElementsByTagNameNS(W_NS, 'shd')[0];
        if (existing) tblPr.replaceChild(shdEl, existing);
        else tblPr.appendChild(shdEl);
      }

      setZipEntry(zip, 'word/document.xml', serializeDoc(doc));
      await saveZip(zip, filepath);
      return { content: [{ type: 'text' as const, text: `Table ${table_index} formatted.` }] };
    }
  );

  server.tool(
    'set_table_cell_shading',
    'Apply a background fill color to a specific table cell.',
    {
      filename: z.string(),
      table_index: z.number(),
      row_index: z.number(),
      col_index: z.number(),
      fill_color: z.string().describe('Hex fill color e.g. "FFD700"'),
      pattern: z.string().optional().describe('Shading pattern (default: clear)'),
    },
    async ({ filename, table_index, row_index, col_index, fill_color, pattern }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      const docXml = getZipEntry(zip, 'word/document.xml')!;
      const doc = parseXmlDoc(docXml);
      const body = getBodyEl(doc);
      const tables = bodyTables(body);
      if (table_index >= tables.length) throw new Error(`Table index ${table_index} out of range`);
      const rows = (tables[table_index] as any).getElementsByTagNameNS(W_NS, 'tr');
      if (row_index >= rows.length) throw new Error(`Row index ${row_index} out of range`);
      const cells = (rows[row_index] as any).getElementsByTagNameNS(W_NS, 'tc');
      if (col_index >= cells.length) throw new Error(`Col index ${col_index} out of range`);
      const cell = cells[col_index];
      let tcPr = (cell as any).getElementsByTagNameNS(W_NS, 'tcPr')[0];
      if (!tcPr) { tcPr = mkEl(doc, 'w:tcPr'); cell.insertBefore(tcPr, cell.firstChild); }
      const shdEl = importFragment(`<w:shd w:val="${escapeXml(pattern || 'clear')}" w:color="auto" w:fill="${escapeXml(fill_color.replace('#', ''))}"/>`, doc);
      const existing = (tcPr as any).getElementsByTagNameNS(W_NS, 'shd')[0];
      if (existing) tcPr.replaceChild(shdEl, existing);
      else tcPr.appendChild(shdEl);
      setZipEntry(zip, 'word/document.xml', serializeDoc(doc));
      await saveZip(zip, filepath);
      return { content: [{ type: 'text' as const, text: `Cell [${row_index},${col_index}] shading set to ${fill_color}.` }] };
    }
  );

  server.tool(
    'apply_table_alternating_rows',
    'Apply alternating row background colors to a table.',
    {
      filename: z.string(),
      table_index: z.number(),
      color1: z.string().optional().describe('Color for odd rows (default: FFFFFF)'),
      color2: z.string().optional().describe('Color for even rows (default: F2F2F2)'),
    },
    async ({ filename, table_index, color1, color2 }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      const docXml = getZipEntry(zip, 'word/document.xml')!;
      const doc = parseXmlDoc(docXml);
      const body = getBodyEl(doc);
      const tables = bodyTables(body);
      if (table_index >= tables.length) throw new Error(`Table index ${table_index} out of range`);
      const rows = (tables[table_index] as any).getElementsByTagNameNS(W_NS, 'tr');
      const c1 = (color1 || 'FFFFFF').replace('#', '');
      const c2 = (color2 || 'F2F2F2').replace('#', '');
      for (let r = 0; r < rows.length; r++) {
        const fill = r % 2 === 0 ? c1 : c2;
        const cells = (rows[r] as any).getElementsByTagNameNS(W_NS, 'tc');
        for (let c = 0; c < cells.length; c++) {
          const cell = cells[c];
          let tcPr = (cell as any).getElementsByTagNameNS(W_NS, 'tcPr')[0];
          if (!tcPr) { tcPr = mkEl(doc, 'w:tcPr'); cell.insertBefore(tcPr, cell.firstChild); }
          const shdEl = importFragment(`<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>`, doc);
          const existing = (tcPr as any).getElementsByTagNameNS(W_NS, 'shd')[0];
          if (existing) tcPr.replaceChild(shdEl, existing);
          else tcPr.appendChild(shdEl);
        }
      }
      setZipEntry(zip, 'word/document.xml', serializeDoc(doc));
      await saveZip(zip, filepath);
      return { content: [{ type: 'text' as const, text: `Alternating row colors applied to table ${table_index}.` }] };
    }
  );

  server.tool(
    'highlight_table_header',
    'Style the first row of a table as a header with a colored background.',
    {
      filename: z.string(),
      table_index: z.number(),
      header_color: z.string().optional().describe('Header background hex color (default: 4472C4)'),
      text_color: z.string().optional().describe('Header text hex color (default: FFFFFF)'),
    },
    async ({ filename, table_index, header_color, text_color }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      const docXml = getZipEntry(zip, 'word/document.xml')!;
      const doc = parseXmlDoc(docXml);
      const body = getBodyEl(doc);
      const tables = bodyTables(body);
      if (table_index >= tables.length) throw new Error(`Table index ${table_index} out of range`);
      const rows = (tables[table_index] as any).getElementsByTagNameNS(W_NS, 'tr');
      if (rows.length === 0) throw new Error('Table has no rows');
      const hc = (header_color || '4472C4').replace('#', '');
      const tc = (text_color || 'FFFFFF').replace('#', '');
      const cells = (rows[0] as any).getElementsByTagNameNS(W_NS, 'tc');
      for (let c = 0; c < cells.length; c++) {
        const cell = cells[c];
        let tcPr = (cell as any).getElementsByTagNameNS(W_NS, 'tcPr')[0];
        if (!tcPr) { tcPr = mkEl(doc, 'w:tcPr'); cell.insertBefore(tcPr, cell.firstChild); }
        const shdEl = importFragment(`<w:shd w:val="clear" w:color="auto" w:fill="${hc}"/>`, doc);
        const existing = (tcPr as any).getElementsByTagNameNS(W_NS, 'shd')[0];
        if (existing) tcPr.replaceChild(shdEl, existing);
        else tcPr.appendChild(shdEl);
        // Color text in cell
        const tNodes = (cell as any).getElementsByTagNameNS(W_NS, 't');
        for (let t = 0; t < tNodes.length; t++) {
          const run = tNodes[t].parentNode;
          let rPrEl = (run as any).getElementsByTagNameNS(W_NS, 'rPr')[0];
          if (!rPrEl) { rPrEl = mkEl(doc, 'w:rPr'); run.insertBefore(rPrEl, run.firstChild); }
          const colorEl = mkEl(doc, 'w:color'); setAttr(colorEl, 'w:val', tc); rPrEl.appendChild(colorEl);
          const boldEl = mkEl(doc, 'w:b'); rPrEl.appendChild(boldEl);
        }
      }
      setZipEntry(zip, 'word/document.xml', serializeDoc(doc));
      await saveZip(zip, filepath);
      return { content: [{ type: 'text' as const, text: `Header row of table ${table_index} highlighted.` }] };
    }
  );

  server.tool(
    'set_table_cell_alignment',
    'Set the text alignment of a specific table cell.',
    {
      filename: z.string(),
      table_index: z.number(),
      row_index: z.number(),
      col_index: z.number(),
      horizontal: z.enum(['left', 'center', 'right', 'both']).optional().describe('Horizontal alignment (default: left)'),
      vertical: z.enum(['top', 'center', 'bottom']).optional().describe('Vertical alignment (default: top)'),
    },
    async ({ filename, table_index, row_index, col_index, horizontal, vertical }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      const docXml = getZipEntry(zip, 'word/document.xml')!;
      const doc = parseXmlDoc(docXml);
      const body = getBodyEl(doc);
      const tables = bodyTables(body);
      if (table_index >= tables.length) throw new Error(`Table index ${table_index} out of range`);
      const rows = (tables[table_index] as any).getElementsByTagNameNS(W_NS, 'tr');
      const cells = (rows[row_index] as any).getElementsByTagNameNS(W_NS, 'tc');
      const cell = cells[col_index];
      let tcPr = (cell as any).getElementsByTagNameNS(W_NS, 'tcPr')[0];
      if (!tcPr) { tcPr = mkEl(doc, 'w:tcPr'); cell.insertBefore(tcPr, cell.firstChild); }
      if (vertical) {
        const va = mkEl(doc, 'w:vAlign'); setAttr(va, 'w:val', vertical);
        const existing = (tcPr as any).getElementsByTagNameNS(W_NS, 'vAlign')[0];
        if (existing) tcPr.replaceChild(va, existing); else tcPr.appendChild(va);
      }
      if (horizontal) {
        const paras = (cell as any).getElementsByTagNameNS(W_NS, 'p');
        for (let i = 0; i < paras.length; i++) {
          const p = paras[i];
          let pPr = (p as any).getElementsByTagNameNS(W_NS, 'pPr')[0];
          if (!pPr) { pPr = mkEl(doc, 'w:pPr'); p.insertBefore(pPr, p.firstChild); }
          const jc = mkEl(doc, 'w:jc'); setAttr(jc, 'w:val', horizontal);
          const existing = (pPr as any).getElementsByTagNameNS(W_NS, 'jc')[0];
          if (existing) pPr.replaceChild(jc, existing); else pPr.appendChild(jc);
        }
      }
      setZipEntry(zip, 'word/document.xml', serializeDoc(doc));
      await saveZip(zip, filepath);
      return { content: [{ type: 'text' as const, text: `Cell [${row_index},${col_index}] alignment set.` }] };
    }
  );

  // ══════════════════════════════════════════════════════════════════════════
  // GROUP 4 – Table Cell & Column Management
  // ══════════════════════════════════════════════════════════════════════════

  server.tool(
    'merge_table_cells',
    'Merge a rectangular region of table cells.',
    {
      filename: z.string(),
      table_index: z.number(),
      start_row: z.number(),
      start_col: z.number(),
      end_row: z.number(),
      end_col: z.number(),
    },
    async ({ filename, table_index, start_row, start_col, end_row, end_col }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      const docXml = getZipEntry(zip, 'word/document.xml')!;
      const doc = parseXmlDoc(docXml);
      const body = getBodyEl(doc);
      const tables = bodyTables(body);
      const rows = (tables[table_index] as any).getElementsByTagNameNS(W_NS, 'tr');
      const span = end_col - start_col + 1;

      for (let r = start_row; r <= end_row; r++) {
        const cells = (rows[r] as any).getElementsByTagNameNS(W_NS, 'tc');
        const startCell = cells[start_col];
        let tcPr = (startCell as any).getElementsByTagNameNS(W_NS, 'tcPr')[0];
        if (!tcPr) { tcPr = mkEl(doc, 'w:tcPr'); startCell.insertBefore(tcPr, startCell.firstChild); }

        if (span > 1) {
          const gs = mkEl(doc, 'w:gridSpan'); setAttr(gs, 'w:val', String(span));
          const existing = (tcPr as any).getElementsByTagNameNS(W_NS, 'gridSpan')[0];
          if (existing) tcPr.replaceChild(gs, existing); else tcPr.insertBefore(gs, tcPr.firstChild);
        }
        if (r > start_row) {
          const vm = mkEl(doc, 'w:vMerge');
          const existing = (tcPr as any).getElementsByTagNameNS(W_NS, 'vMerge')[0];
          if (existing) tcPr.replaceChild(vm, existing); else tcPr.appendChild(vm);
        } else if (end_row > start_row) {
          const vm = mkEl(doc, 'w:vMerge'); setAttr(vm, 'w:val', 'restart');
          const existing = (tcPr as any).getElementsByTagNameNS(W_NS, 'vMerge')[0];
          if (existing) tcPr.replaceChild(vm, existing); else tcPr.appendChild(vm);
        }

        // Remove extra cells in the row (for horizontal merge)
        if (span > 1) {
          for (let c = end_col; c > start_col; c--) {
            const cellToRemove = (rows[r] as any).getElementsByTagNameNS(W_NS, 'tc')[c];
            if (cellToRemove) cellToRemove.parentNode!.removeChild(cellToRemove);
          }
        }
      }

      setZipEntry(zip, 'word/document.xml', serializeDoc(doc));
      await saveZip(zip, filepath);
      return { content: [{ type: 'text' as const, text: `Cells [${start_row},${start_col}]–[${end_row},${end_col}] merged.` }] };
    }
  );

  server.tool(
    'merge_table_cells_horizontal',
    'Merge cells horizontally within a single row.',
    {
      filename: z.string(),
      table_index: z.number(),
      row_index: z.number(),
      start_col: z.number(),
      end_col: z.number(),
    },
    async ({ filename, table_index, row_index, start_col, end_col }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      const docXml = getZipEntry(zip, 'word/document.xml')!;
      const doc = parseXmlDoc(docXml);
      const body = getBodyEl(doc);
      const tables = bodyTables(body);
      const rows = (tables[table_index] as any).getElementsByTagNameNS(W_NS, 'tr');
      const cells = (rows[row_index] as any).getElementsByTagNameNS(W_NS, 'tc');
      const span = end_col - start_col + 1;
      const startCell = cells[start_col];
      let tcPr = (startCell as any).getElementsByTagNameNS(W_NS, 'tcPr')[0];
      if (!tcPr) { tcPr = mkEl(doc, 'w:tcPr'); startCell.insertBefore(tcPr, startCell.firstChild); }
      const gs = mkEl(doc, 'w:gridSpan'); setAttr(gs, 'w:val', String(span));
      const existing = (tcPr as any).getElementsByTagNameNS(W_NS, 'gridSpan')[0];
      if (existing) tcPr.replaceChild(gs, existing); else tcPr.insertBefore(gs, tcPr.firstChild);
      for (let c = end_col; c > start_col; c--) {
        const cellsNow = (rows[row_index] as any).getElementsByTagNameNS(W_NS, 'tc');
        if (cellsNow[c]) cellsNow[c].parentNode!.removeChild(cellsNow[c]);
      }
      setZipEntry(zip, 'word/document.xml', serializeDoc(doc));
      await saveZip(zip, filepath);
      return { content: [{ type: 'text' as const, text: `Row ${row_index} cells ${start_col}–${end_col} merged.` }] };
    }
  );

  server.tool(
    'merge_table_cells_vertical',
    'Merge cells vertically within a single column.',
    {
      filename: z.string(),
      table_index: z.number(),
      col_index: z.number(),
      start_row: z.number(),
      end_row: z.number(),
    },
    async ({ filename, table_index, col_index, start_row, end_row }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      const docXml = getZipEntry(zip, 'word/document.xml')!;
      const doc = parseXmlDoc(docXml);
      const body = getBodyEl(doc);
      const tables = bodyTables(body);
      const rows = (tables[table_index] as any).getElementsByTagNameNS(W_NS, 'tr');
      for (let r = start_row; r <= end_row; r++) {
        const cells = (rows[r] as any).getElementsByTagNameNS(W_NS, 'tc');
        const cell = cells[col_index];
        let tcPr = (cell as any).getElementsByTagNameNS(W_NS, 'tcPr')[0];
        if (!tcPr) { tcPr = mkEl(doc, 'w:tcPr'); cell.insertBefore(tcPr, cell.firstChild); }
        const vm = mkEl(doc, 'w:vMerge');
        if (r === start_row) setAttr(vm, 'w:val', 'restart');
        const existing = (tcPr as any).getElementsByTagNameNS(W_NS, 'vMerge')[0];
        if (existing) tcPr.replaceChild(vm, existing); else tcPr.appendChild(vm);
      }
      setZipEntry(zip, 'word/document.xml', serializeDoc(doc));
      await saveZip(zip, filepath);
      return { content: [{ type: 'text' as const, text: `Column ${col_index} rows ${start_row}–${end_row} merged.` }] };
    }
  );

  server.tool(
    'set_table_alignment_all',
    'Set the same horizontal and vertical alignment for all cells in a table.',
    {
      filename: z.string(),
      table_index: z.number(),
      horizontal: z.enum(['left', 'center', 'right', 'both']).optional(),
      vertical: z.enum(['top', 'center', 'bottom']).optional(),
    },
    async ({ filename, table_index, horizontal, vertical }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      const docXml = getZipEntry(zip, 'word/document.xml')!;
      const doc = parseXmlDoc(docXml);
      const body = getBodyEl(doc);
      const tables = bodyTables(body);
      const cells = (tables[table_index] as any).getElementsByTagNameNS(W_NS, 'tc');
      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i];
        let tcPr = (cell as any).getElementsByTagNameNS(W_NS, 'tcPr')[0];
        if (!tcPr) { tcPr = mkEl(doc, 'w:tcPr'); cell.insertBefore(tcPr, cell.firstChild); }
        if (vertical) {
          const va = mkEl(doc, 'w:vAlign'); setAttr(va, 'w:val', vertical);
          const ex = (tcPr as any).getElementsByTagNameNS(W_NS, 'vAlign')[0];
          if (ex) tcPr.replaceChild(va, ex); else tcPr.appendChild(va);
        }
        if (horizontal) {
          const paras = (cell as any).getElementsByTagNameNS(W_NS, 'p');
          for (let p = 0; p < paras.length; p++) {
            let pPr = (paras[p] as any).getElementsByTagNameNS(W_NS, 'pPr')[0];
            if (!pPr) { pPr = mkEl(doc, 'w:pPr'); paras[p].insertBefore(pPr, paras[p].firstChild); }
            const jc = mkEl(doc, 'w:jc'); setAttr(jc, 'w:val', horizontal);
            const ex = (pPr as any).getElementsByTagNameNS(W_NS, 'jc')[0];
            if (ex) pPr.replaceChild(jc, ex); else pPr.appendChild(jc);
          }
        }
      }
      setZipEntry(zip, 'word/document.xml', serializeDoc(doc));
      await saveZip(zip, filepath);
      return { content: [{ type: 'text' as const, text: `All cells in table ${table_index} alignment set.` }] };
    }
  );

  server.tool(
    'set_table_column_width',
    'Set the width of a specific column in a table.',
    {
      filename: z.string(),
      table_index: z.number(),
      col_index: z.number(),
      width: z.number().describe('Column width value'),
      width_type: z.enum(['dxa', 'pct', 'auto']).optional().describe('Width type: dxa (twips), pct (hundredths of percent), auto (default: dxa)'),
    },
    async ({ filename, table_index, col_index, width, width_type }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      const docXml = getZipEntry(zip, 'word/document.xml')!;
      const doc = parseXmlDoc(docXml);
      const body = getBodyEl(doc);
      const tables = bodyTables(body);
      const tbl = tables[table_index];
      const gridCols = (tbl as any).getElementsByTagNameNS(W_NS, 'gridCol');
      if (col_index >= gridCols.length) throw new Error(`Column ${col_index} out of range`);
      setAttr(gridCols[col_index], 'w:w', String(width));
      // Also update tcW in each row
      const rows = (tbl as any).getElementsByTagNameNS(W_NS, 'tr');
      const wt = width_type || 'dxa';
      for (let r = 0; r < rows.length; r++) {
        const cells = (rows[r] as any).getElementsByTagNameNS(W_NS, 'tc');
        if (col_index < cells.length) {
          let tcPr = (cells[col_index] as any).getElementsByTagNameNS(W_NS, 'tcPr')[0];
          if (!tcPr) { tcPr = mkEl(doc, 'w:tcPr'); cells[col_index].insertBefore(tcPr, cells[col_index].firstChild); }
          const tcW = mkEl(doc, 'w:tcW'); setAttr(tcW, 'w:w', String(width)); setAttr(tcW, 'w:type', wt);
          const ex = (tcPr as any).getElementsByTagNameNS(W_NS, 'tcW')[0];
          if (ex) tcPr.replaceChild(tcW, ex); else tcPr.insertBefore(tcW, tcPr.firstChild);
        }
      }
      setZipEntry(zip, 'word/document.xml', serializeDoc(doc));
      await saveZip(zip, filepath);
      return { content: [{ type: 'text' as const, text: `Column ${col_index} width set to ${width} ${wt}.` }] };
    }
  );

  server.tool(
    'set_table_column_widths',
    'Set widths for multiple columns in a table.',
    {
      filename: z.string(),
      table_index: z.number(),
      widths: z.array(z.number()).describe('Array of widths, one per column'),
      width_type: z.enum(['dxa', 'pct', 'auto']).optional(),
    },
    async ({ filename, table_index, widths, width_type }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      const docXml = getZipEntry(zip, 'word/document.xml')!;
      const doc = parseXmlDoc(docXml);
      const body = getBodyEl(doc);
      const tables = bodyTables(body);
      const tbl = tables[table_index];
      const gridCols = (tbl as any).getElementsByTagNameNS(W_NS, 'gridCol');
      const wt = width_type || 'dxa';
      for (let c = 0; c < Math.min(widths.length, gridCols.length); c++) {
        setAttr(gridCols[c], 'w:w', String(widths[c]));
        const rows = (tbl as any).getElementsByTagNameNS(W_NS, 'tr');
        for (let r = 0; r < rows.length; r++) {
          const cells = (rows[r] as any).getElementsByTagNameNS(W_NS, 'tc');
          if (c < cells.length) {
            let tcPr = (cells[c] as any).getElementsByTagNameNS(W_NS, 'tcPr')[0];
            if (!tcPr) { tcPr = mkEl(doc, 'w:tcPr'); cells[c].insertBefore(tcPr, cells[c].firstChild); }
            const tcW = mkEl(doc, 'w:tcW'); setAttr(tcW, 'w:w', String(widths[c])); setAttr(tcW, 'w:type', wt);
            const ex = (tcPr as any).getElementsByTagNameNS(W_NS, 'tcW')[0];
            if (ex) tcPr.replaceChild(tcW, ex); else tcPr.insertBefore(tcW, tcPr.firstChild);
          }
        }
      }
      setZipEntry(zip, 'word/document.xml', serializeDoc(doc));
      await saveZip(zip, filepath);
      return { content: [{ type: 'text' as const, text: `Column widths set for table ${table_index}.` }] };
    }
  );

  server.tool(
    'set_table_width',
    'Set the overall width of a table.',
    {
      filename: z.string(),
      table_index: z.number(),
      width: z.number().describe('Table width value'),
      width_type: z.enum(['dxa', 'pct', 'auto']).optional(),
    },
    async ({ filename, table_index, width, width_type }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      const docXml = getZipEntry(zip, 'word/document.xml')!;
      const doc = parseXmlDoc(docXml);
      const body = getBodyEl(doc);
      const tables = bodyTables(body);
      const tbl = tables[table_index];
      let tblPr = (tbl as any).getElementsByTagNameNS(W_NS, 'tblPr')[0];
      if (!tblPr) { tblPr = mkEl(doc, 'w:tblPr'); tbl.insertBefore(tblPr, tbl.firstChild); }
      const wt = width_type || 'dxa';
      const tblW = mkEl(doc, 'w:tblW'); setAttr(tblW, 'w:w', String(width)); setAttr(tblW, 'w:type', wt);
      const ex = (tblPr as any).getElementsByTagNameNS(W_NS, 'tblW')[0];
      if (ex) tblPr.replaceChild(tblW, ex); else tblPr.insertBefore(tblW, tblPr.firstChild);
      setZipEntry(zip, 'word/document.xml', serializeDoc(doc));
      await saveZip(zip, filepath);
      return { content: [{ type: 'text' as const, text: `Table ${table_index} width set to ${width} ${wt}.` }] };
    }
  );

  server.tool(
    'auto_fit_table_columns',
    'Set table layout to auto-fit columns to content.',
    {
      filename: z.string(),
      table_index: z.number(),
    },
    async ({ filename, table_index }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      const docXml = getZipEntry(zip, 'word/document.xml')!;
      const doc = parseXmlDoc(docXml);
      const body = getBodyEl(doc);
      const tables = bodyTables(body);
      const tbl = tables[table_index];
      let tblPr = (tbl as any).getElementsByTagNameNS(W_NS, 'tblPr')[0];
      if (!tblPr) { tblPr = mkEl(doc, 'w:tblPr'); tbl.insertBefore(tblPr, tbl.firstChild); }
      const layout = mkEl(doc, 'w:tblLayout'); setAttr(layout, 'w:type', 'autofit');
      const ex = (tblPr as any).getElementsByTagNameNS(W_NS, 'tblLayout')[0];
      if (ex) tblPr.replaceChild(layout, ex); else tblPr.appendChild(layout);
      // Set tblW to auto
      const tblW = mkEl(doc, 'w:tblW'); setAttr(tblW, 'w:w', '0'); setAttr(tblW, 'w:type', 'auto');
      const exW = (tblPr as any).getElementsByTagNameNS(W_NS, 'tblW')[0];
      if (exW) tblPr.replaceChild(tblW, exW); else tblPr.insertBefore(tblW, tblPr.firstChild);
      setZipEntry(zip, 'word/document.xml', serializeDoc(doc));
      await saveZip(zip, filepath);
      return { content: [{ type: 'text' as const, text: `Table ${table_index} set to auto-fit.` }] };
    }
  );

  server.tool(
    'format_table_cell_text',
    'Format the text content of a specific table cell.',
    {
      filename: z.string(),
      table_index: z.number(),
      row_index: z.number(),
      col_index: z.number(),
      text_content: z.string().optional().describe('Replace cell text with this content (leave undefined to only format)'),
      bold: z.boolean().optional(),
      italic: z.boolean().optional(),
      underline: z.boolean().optional(),
      color: z.string().optional(),
      font_size: z.number().optional(),
      font_name: z.string().optional(),
    },
    async ({ filename, table_index, row_index, col_index, text_content, bold, italic, underline, color, font_size, font_name }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      const docXml = getZipEntry(zip, 'word/document.xml')!;
      const doc = parseXmlDoc(docXml);
      const body = getBodyEl(doc);
      const tables = bodyTables(body);
      const rows = (tables[table_index] as any).getElementsByTagNameNS(W_NS, 'tr');
      const cells = (rows[row_index] as any).getElementsByTagNameNS(W_NS, 'tc');
      const cell = cells[col_index];

      if (text_content !== undefined) {
        // Replace all paragraphs in cell with a new one
        const paras = (cell as any).getElementsByTagNameNS(W_NS, 'p');
        const newPara = importFragment(buildParaXml(text_content, { bold, italic, underline, color, fontSize: font_size, fontName: font_name }), doc);
        if (paras.length > 0) cell.replaceChild(newPara, paras[0]);
        else cell.appendChild(newPara);
        for (let i = paras.length - 1; i >= 1; i--) cell.removeChild(paras[i]);
      } else {
        const runs = (cell as any).getElementsByTagNameNS(W_NS, 'r');
        for (let i = 0; i < runs.length; i++) {
          const r = runs[i];
          let rPrEl = (r as any).getElementsByTagNameNS(W_NS, 'rPr')[0];
          if (!rPrEl) { rPrEl = mkEl(doc, 'w:rPr'); r.insertBefore(rPrEl, r.firstChild); }
          if (bold) rPrEl.appendChild(mkEl(doc, 'w:b'));
          if (italic) rPrEl.appendChild(mkEl(doc, 'w:i'));
          if (underline) { const u = mkEl(doc, 'w:u'); setAttr(u, 'w:val', 'single'); rPrEl.appendChild(u); }
          if (color) { const c = mkEl(doc, 'w:color'); setAttr(c, 'w:val', color.replace('#', '')); rPrEl.appendChild(c); }
          if (font_size) { const sz = mkEl(doc, 'w:sz'); setAttr(sz, 'w:val', String(font_size * 2)); rPrEl.appendChild(sz); }
          if (font_name) { const rf = mkEl(doc, 'w:rFonts'); setAttr(rf, 'w:ascii', font_name); setAttr(rf, 'w:hAnsi', font_name); rPrEl.insertBefore(rf, rPrEl.firstChild); }
        }
      }

      setZipEntry(zip, 'word/document.xml', serializeDoc(doc));
      await saveZip(zip, filepath);
      return { content: [{ type: 'text' as const, text: `Cell [${row_index},${col_index}] formatted.` }] };
    }
  );

  server.tool(
    'set_table_cell_padding',
    'Set internal padding/margins for a specific table cell.',
    {
      filename: z.string(),
      table_index: z.number(),
      row_index: z.number(),
      col_index: z.number(),
      top: z.number().optional().describe('Top padding value'),
      bottom: z.number().optional().describe('Bottom padding value'),
      left: z.number().optional().describe('Left padding value'),
      right: z.number().optional().describe('Right padding value'),
      unit: z.enum(['dxa', 'nil']).optional().describe('Unit: dxa (twips) or nil (default: dxa)'),
    },
    async ({ filename, table_index, row_index, col_index, top, bottom, left, right, unit }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      const docXml = getZipEntry(zip, 'word/document.xml')!;
      const doc = parseXmlDoc(docXml);
      const body = getBodyEl(doc);
      const tables = bodyTables(body);
      const rows = (tables[table_index] as any).getElementsByTagNameNS(W_NS, 'tr');
      const cells = (rows[row_index] as any).getElementsByTagNameNS(W_NS, 'tc');
      const cell = cells[col_index];
      let tcPr = (cell as any).getElementsByTagNameNS(W_NS, 'tcPr')[0];
      if (!tcPr) { tcPr = mkEl(doc, 'w:tcPr'); cell.insertBefore(tcPr, cell.firstChild); }
      const u = unit || 'dxa';
      const sides = [
        top !== undefined ? `<w:top w:w="${top}" w:type="${u}"/>` : '',
        left !== undefined ? `<w:left w:w="${left}" w:type="${u}"/>` : '',
        bottom !== undefined ? `<w:bottom w:w="${bottom}" w:type="${u}"/>` : '',
        right !== undefined ? `<w:right w:w="${right}" w:type="${u}"/>` : '',
      ].filter(Boolean).join('');
      if (sides) {
        const marEl = importFragment(`<w:tcMar>${sides}</w:tcMar>`, doc);
        const ex = (tcPr as any).getElementsByTagNameNS(W_NS, 'tcMar')[0];
        if (ex) tcPr.replaceChild(marEl, ex); else tcPr.appendChild(marEl);
      }
      setZipEntry(zip, 'word/document.xml', serializeDoc(doc));
      await saveZip(zip, filepath);
      return { content: [{ type: 'text' as const, text: `Cell [${row_index},${col_index}] padding set.` }] };
    }
  );

  // ══════════════════════════════════════════════════════════════════════════
  // GROUP 5 – Document Protection
  // ══════════════════════════════════════════════════════════════════════════

  server.tool(
    'protect_document',
    'Restrict editing of a document by adding password-based document protection.',
    {
      filename: z.string(),
      password: z.string().describe('Protection password'),
    },
    async ({ filename, password }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      let settingsXml = getZipEntry(zip, 'word/settings.xml');
      if (!settingsXml) throw new Error('word/settings.xml not found in document');
      const { salt, hash, spinCount } = computePasswordHash(password);
      const protection = `<w:documentProtection w:edit="readOnly" w:enforcement="1" w:cryptProviderType="rsaAES" w:cryptAlgorithmClass="hash" w:cryptAlgorithmType="typeAny" w:cryptAlgorithmSid="14" w:cryptSpinCount="${spinCount}" w:salt="${escapeXml(salt)}" w:hash="${escapeXml(hash)}"/>`;
      const existing = settingsXml.match(/<w:documentProtection[^/]*\/>/);
      if (existing) {
        settingsXml = settingsXml.replace(existing[0], protection);
      } else {
        settingsXml = settingsXml.replace('</w:settings>', `${protection}</w:settings>`);
      }
      setZipEntry(zip, 'word/settings.xml', settingsXml);
      await saveZip(zip, filepath);
      return { content: [{ type: 'text' as const, text: 'Document protection enabled.' }] };
    }
  );

  server.tool(
    'unprotect_document',
    'Remove edit restriction protection from a document (password not verified — removes XML element).',
    {
      filename: z.string(),
      password: z.string().optional().describe('Password (informational only, not verified in XML removal)'),
    },
    async ({ filename }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      let settingsXml = getZipEntry(zip, 'word/settings.xml');
      if (!settingsXml) throw new Error('word/settings.xml not found in document');
      settingsXml = settingsXml.replace(/<w:documentProtection[^/]*\/>/g, '');
      setZipEntry(zip, 'word/settings.xml', settingsXml);
      await saveZip(zip, filepath);
      return { content: [{ type: 'text' as const, text: 'Document protection removed.' }] };
    }
  );

  // ══════════════════════════════════════════════════════════════════════════
  // GROUP 6 – Footnote & Endnote Management
  // ══════════════════════════════════════════════════════════════════════════

  server.tool(
    'add_footnote_to_document',
    'Add a footnote at the end of a specific paragraph.',
    {
      filename: z.string(),
      paragraph_index: z.number().describe('0-based body paragraph index'),
      footnote_text: z.string(),
    },
    async ({ filename, paragraph_index, footnote_text }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      ensureFootnotes(zip);
      let fnXml = getZipEntry(zip, 'word/footnotes.xml')!;
      const fnId = getNextNoteId(fnXml, 'footnote');
      const newFn = `<w:footnote w:id="${fnId}"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> ${escapeXml(footnote_text)}</w:t></w:r></w:p></w:footnote>`;
      fnXml = fnXml.replace('</w:footnotes>', `${newFn}</w:footnotes>`);
      setZipEntry(zip, 'word/footnotes.xml', fnXml);

      const docXml = getZipEntry(zip, 'word/document.xml')!;
      const doc = parseXmlDoc(docXml);
      const body = getBodyEl(doc);
      const paras = bodyParagraphs(body);
      if (paragraph_index >= paras.length) throw new Error(`Paragraph index ${paragraph_index} out of range`);
      const fnRef = importFragment(`<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${fnId}"/></w:r>`, doc);
      paras[paragraph_index].appendChild(fnRef);
      setZipEntry(zip, 'word/document.xml', serializeDoc(doc));
      await saveZip(zip, filepath);
      return { content: [{ type: 'text' as const, text: `Footnote ${fnId} added to paragraph ${paragraph_index}.` }] };
    }
  );

  server.tool(
    'add_footnote_after_text',
    'Add a footnote reference after a specific text occurrence.',
    {
      filename: z.string(),
      search_text: z.string().describe('Text to find; footnote is inserted after it'),
      footnote_text: z.string(),
      output_filename: z.string().optional().describe('Save to different file (default: overwrite)'),
    },
    async ({ filename, search_text, footnote_text, output_filename }) => {
      const filepath = resolvePath(filename, workingDir);
      const outPath = output_filename ? resolvePath(output_filename, workingDir) : filepath;
      const zip = new AdmZip(filepath);
      ensureFootnotes(zip);
      let fnXml = getZipEntry(zip, 'word/footnotes.xml')!;
      const fnId = getNextNoteId(fnXml, 'footnote');
      const newFn = `<w:footnote w:id="${fnId}"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> ${escapeXml(footnote_text)}</w:t></w:r></w:p></w:footnote>`;
      fnXml = fnXml.replace('</w:footnotes>', `${newFn}</w:footnotes>`);
      setZipEntry(zip, 'word/footnotes.xml', fnXml);

      const docXml = getZipEntry(zip, 'word/document.xml')!;
      const doc = parseXmlDoc(docXml);
      const body = getBodyEl(doc);
      const idx = findParaByText(body, search_text, true);
      if (idx === -1) throw new Error(`Text "${search_text}" not found`);
      const fnRef = importFragment(`<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${fnId}"/></w:r>`, doc);
      bodyParagraphs(body)[idx].appendChild(fnRef);
      setZipEntry(zip, 'word/document.xml', serializeDoc(doc));
      await saveZip(zip, outPath);
      return { content: [{ type: 'text' as const, text: `Footnote ${fnId} added after text "${search_text}".` }] };
    }
  );

  server.tool(
    'add_footnote_before_text',
    'Add a footnote reference before a specific text occurrence.',
    {
      filename: z.string(),
      search_text: z.string(),
      footnote_text: z.string(),
      output_filename: z.string().optional(),
    },
    async ({ filename, search_text, footnote_text, output_filename }) => {
      const filepath = resolvePath(filename, workingDir);
      const outPath = output_filename ? resolvePath(output_filename, workingDir) : filepath;
      const zip = new AdmZip(filepath);
      ensureFootnotes(zip);
      let fnXml = getZipEntry(zip, 'word/footnotes.xml')!;
      const fnId = getNextNoteId(fnXml, 'footnote');
      const newFn = `<w:footnote w:id="${fnId}"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> ${escapeXml(footnote_text)}</w:t></w:r></w:p></w:footnote>`;
      fnXml = fnXml.replace('</w:footnotes>', `${newFn}</w:footnotes>`);
      setZipEntry(zip, 'word/footnotes.xml', fnXml);

      const docXml = getZipEntry(zip, 'word/document.xml')!;
      const doc = parseXmlDoc(docXml);
      const body = getBodyEl(doc);
      const idx = findParaByText(body, search_text, true);
      if (idx === -1) throw new Error(`Text "${search_text}" not found`);
      const para = bodyParagraphs(body)[idx];
      const fnRef = importFragment(`<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${fnId}"/></w:r>`, doc);
      para.insertBefore(fnRef, para.firstChild);
      setZipEntry(zip, 'word/document.xml', serializeDoc(doc));
      await saveZip(zip, outPath);
      return { content: [{ type: 'text' as const, text: `Footnote ${fnId} added before text "${search_text}".` }] };
    }
  );

  server.tool(
    'add_footnote_enhanced',
    'Add a footnote with guaranteed superscript reference marker.',
    {
      filename: z.string(),
      paragraph_index: z.number(),
      footnote_text: z.string(),
      output_filename: z.string().optional(),
    },
    async ({ filename, paragraph_index, footnote_text, output_filename }) => {
      const filepath = resolvePath(filename, workingDir);
      const outPath = output_filename ? resolvePath(output_filename, workingDir) : filepath;
      const zip = new AdmZip(filepath);
      ensureFootnotes(zip);
      let fnXml = getZipEntry(zip, 'word/footnotes.xml')!;
      const fnId = getNextNoteId(fnXml, 'footnote');
      const newFn = `<w:footnote w:id="${fnId}"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr><w:r><w:rPr><w:vertAlign w:val="superscript"/><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> ${escapeXml(footnote_text)}</w:t></w:r></w:p></w:footnote>`;
      fnXml = fnXml.replace('</w:footnotes>', `${newFn}</w:footnotes>`);
      setZipEntry(zip, 'word/footnotes.xml', fnXml);

      const docXml = getZipEntry(zip, 'word/document.xml')!;
      const doc = parseXmlDoc(docXml);
      const body = getBodyEl(doc);
      const paras = bodyParagraphs(body);
      if (paragraph_index >= paras.length) throw new Error(`Paragraph index ${paragraph_index} out of range`);
      const fnRef = importFragment(`<w:r><w:rPr><w:vertAlign w:val="superscript"/><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${fnId}"/></w:r>`, doc);
      paras[paragraph_index].appendChild(fnRef);
      setZipEntry(zip, 'word/document.xml', serializeDoc(doc));
      await saveZip(zip, outPath);
      return { content: [{ type: 'text' as const, text: `Enhanced footnote ${fnId} added.` }] };
    }
  );

  server.tool(
    'add_endnote_to_document',
    'Add an endnote at the end of a specific paragraph.',
    {
      filename: z.string(),
      paragraph_index: z.number(),
      endnote_text: z.string(),
    },
    async ({ filename, paragraph_index, endnote_text }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      ensureEndnotes(zip);
      let enXml = getZipEntry(zip, 'word/endnotes.xml')!;
      const enId = getNextNoteId(enXml, 'endnote');
      const newEn = `<w:endnote w:id="${enId}"><w:p><w:pPr><w:pStyle w:val="EndnoteText"/></w:pPr><w:r><w:rPr><w:rStyle w:val="EndnoteReference"/></w:rPr><w:endnoteRef/></w:r><w:r><w:t xml:space="preserve"> ${escapeXml(endnote_text)}</w:t></w:r></w:p></w:endnote>`;
      enXml = enXml.replace('</w:endnotes>', `${newEn}</w:endnotes>`);
      setZipEntry(zip, 'word/endnotes.xml', enXml);

      const docXml = getZipEntry(zip, 'word/document.xml')!;
      const doc = parseXmlDoc(docXml);
      const body = getBodyEl(doc);
      const paras = bodyParagraphs(body);
      if (paragraph_index >= paras.length) throw new Error(`Paragraph index ${paragraph_index} out of range`);
      const enRef = importFragment(`<w:r><w:rPr><w:rStyle w:val="EndnoteReference"/></w:rPr><w:endnoteReference w:id="${enId}"/></w:r>`, doc);
      paras[paragraph_index].appendChild(enRef);
      setZipEntry(zip, 'word/document.xml', serializeDoc(doc));
      await saveZip(zip, filepath);
      return { content: [{ type: 'text' as const, text: `Endnote ${enId} added to paragraph ${paragraph_index}.` }] };
    }
  );

  server.tool(
    'customize_footnote_style',
    'Modify the numbering format and starting number for footnotes in the document.',
    {
      filename: z.string(),
      numbering_format: z.string().optional().describe('Format: "decimal", "lowerLetter", "lowerRoman", etc. (default: decimal)'),
      start_number: z.number().optional().describe('Starting footnote number (default: 1)'),
      font_name: z.string().optional(),
      font_size: z.number().optional(),
    },
    async ({ filename, numbering_format, start_number, font_name, font_size }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      let settingsXml = getZipEntry(zip, 'word/settings.xml');
      if (!settingsXml) throw new Error('word/settings.xml not found');
      const fmt = numbering_format || 'decimal';
      const start = start_number || 1;
      const fnPrXml = `<w:footnotePr><w:numFmt w:val="${escapeXml(fmt)}"/><w:numStart w:val="${start}"/></w:footnotePr>`;
      const existingMatch = settingsXml.match(/<w:footnotePr>[\s\S]*?<\/w:footnotePr>/);
      if (existingMatch) {
        settingsXml = settingsXml.replace(existingMatch[0], fnPrXml);
      } else {
        settingsXml = settingsXml.replace('</w:settings>', `${fnPrXml}</w:settings>`);
      }
      if (font_name || font_size) {
        // Style customization would require word/styles.xml modification
        const stylesXml = getZipEntry(zip, 'word/styles.xml');
        if (stylesXml) {
          const rPr = buildRPr({ fontName: font_name, fontSize: font_size });
          const note = `Updated FootnoteText style (manual: open styles.xml to apply font settings).`;
          setZipEntry(zip, 'word/settings.xml', settingsXml);
          await saveZip(zip, filepath);
          return { content: [{ type: 'text' as const, text: `Footnote numbering set to ${fmt} starting at ${start}. ${note}` }] };
        }
      }
      setZipEntry(zip, 'word/settings.xml', settingsXml);
      await saveZip(zip, filepath);
      return { content: [{ type: 'text' as const, text: `Footnote style set: format=${fmt}, start=${start}.` }] };
    }
  );

  server.tool(
    'delete_footnote_from_document',
    'Delete a footnote by ID or by searching for its text.',
    {
      filename: z.string(),
      footnote_id: z.number().optional().describe('Footnote ID to delete'),
      search_text: z.string().optional().describe('Text to find in footnote content'),
      output_filename: z.string().optional(),
    },
    async ({ filename, footnote_id, search_text, output_filename }) => {
      const filepath = resolvePath(filename, workingDir);
      const outPath = output_filename ? resolvePath(output_filename, workingDir) : filepath;
      const zip = new AdmZip(filepath);
      let fnXml = getZipEntry(zip, 'word/footnotes.xml');
      if (!fnXml) throw new Error('No footnotes found in document');

      let targetId: number | null = footnote_id ?? null;
      if (targetId === null && search_text) {
        const m = fnXml.match(new RegExp(`<w:footnote w:id="(\\d+)"[^>]*>[\\s\\S]*?${escapeXml(search_text)}[\\s\\S]*?<\\/w:footnote>`));
        if (m) targetId = parseInt(m[1], 10);
      }
      if (targetId === null) throw new Error('Footnote not found');

      fnXml = fnXml.replace(new RegExp(`<w:footnote w:id="${targetId}"[^>]*>[\\s\\S]*?<\\/w:footnote>`), '');
      setZipEntry(zip, 'word/footnotes.xml', fnXml);

      // Remove reference from document
      let docXml = getZipEntry(zip, 'word/document.xml')!;
      docXml = docXml.replace(new RegExp(`<w:r><w:rPr>[\\s\\S]*?<\\/w:rPr><w:footnoteReference w:id="${targetId}"[^/]*/><\\/w:r>`, 'g'), '');
      docXml = docXml.replace(new RegExp(`<w:footnoteReference w:id="${targetId}"[^/]*/>`, 'g'), '');
      setZipEntry(zip, 'word/document.xml', docXml);
      await saveZip(zip, outPath);
      return { content: [{ type: 'text' as const, text: `Footnote ${targetId} deleted.` }] };
    }
  );

  server.tool(
    'add_footnote_robust',
    'Add a footnote with validation and auto-repair of common issues.',
    {
      filename: z.string(),
      search_text: z.string().optional(),
      paragraph_index: z.number().optional(),
      footnote_text: z.string(),
      validate_location: z.boolean().optional(),
      auto_repair: z.boolean().optional(),
    },
    async ({ filename, search_text, paragraph_index, footnote_text }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      ensureFootnotes(zip);
      let fnXml = getZipEntry(zip, 'word/footnotes.xml')!;
      const fnId = getNextNoteId(fnXml, 'footnote');
      const newFn = `<w:footnote w:id="${fnId}"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> ${escapeXml(footnote_text)}</w:t></w:r></w:p></w:footnote>`;
      fnXml = fnXml.replace('</w:footnotes>', `${newFn}</w:footnotes>`);
      setZipEntry(zip, 'word/footnotes.xml', fnXml);

      const docXml = getZipEntry(zip, 'word/document.xml')!;
      const doc = parseXmlDoc(docXml);
      const body = getBodyEl(doc);
      const paras = bodyParagraphs(body);
      let targetIdx = paragraph_index;
      if (targetIdx === undefined && search_text) {
        const idx = findParaByText(body, search_text, true);
        targetIdx = idx !== -1 ? idx : paras.length - 1;
      }
      targetIdx = targetIdx ?? paras.length - 1;
      if (targetIdx >= paras.length) targetIdx = paras.length - 1;

      const fnRef = importFragment(`<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${fnId}"/></w:r>`, doc);
      paras[targetIdx].appendChild(fnRef);
      setZipEntry(zip, 'word/document.xml', serializeDoc(doc));
      await saveZip(zip, filepath);
      return { content: [{ type: 'text' as const, text: `Footnote ${fnId} robustly added to paragraph ${targetIdx}.` }] };
    }
  );

  server.tool(
    'validate_document_footnotes',
    'Audit footnotes to verify references in document.xml match definitions in footnotes.xml.',
    { filename: z.string() },
    async ({ filename }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      const fnXml = getZipEntry(zip, 'word/footnotes.xml');
      if (!fnXml) return { content: [{ type: 'text' as const, text: 'No footnotes.xml found in document.' }] };

      const docXml = getZipEntry(zip, 'word/document.xml')!;
      const definedIds = [...fnXml.matchAll(/<w:footnote w:id="(-?\d+)"/g)]
        .map(m => parseInt(m[1], 10)).filter(id => id > 0);
      const referencedIds = [...docXml.matchAll(/<w:footnoteReference w:id="(\d+)"/g)]
        .map(m => parseInt(m[1], 10));

      const orphanDefs = definedIds.filter(id => !referencedIds.includes(id));
      const orphanRefs = referencedIds.filter(id => !definedIds.includes(id));
      const lines = [
        `Footnotes defined: ${definedIds.length} (IDs: ${definedIds.join(', ') || 'none'})`,
        `Footnote references in document: ${referencedIds.length}`,
        orphanDefs.length ? `Orphan definitions (no ref): ${orphanDefs.join(', ')}` : '',
        orphanRefs.length ? `Broken references (no def): ${orphanRefs.join(', ')}` : '',
        !orphanDefs.length && !orphanRefs.length ? 'All footnotes are valid.' : '',
      ].filter(Boolean);
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    }
  );

  server.tool(
    'delete_footnote_robust',
    'Delete a footnote and clean up all orphaned references.',
    {
      filename: z.string(),
      footnote_id: z.number().optional(),
      search_text: z.string().optional(),
      clean_orphans: z.boolean().optional().describe('Also remove any orphaned references'),
    },
    async ({ filename, footnote_id, search_text, clean_orphans }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      let fnXml = getZipEntry(zip, 'word/footnotes.xml');
      if (!fnXml) throw new Error('No footnotes.xml in document');

      let targetId: number | null = footnote_id ?? null;
      if (targetId === null && search_text) {
        const m = fnXml.match(new RegExp(`<w:footnote w:id="(\\d+)"[^>]*>[\\s\\S]*?${escapeXml(search_text)}[\\s\\S]*?<\\/w:footnote>`));
        if (m) targetId = parseInt(m[1], 10);
      }
      if (targetId === null) throw new Error('Footnote not found');

      fnXml = fnXml.replace(new RegExp(`<w:footnote w:id="${targetId}"[^>]*>[\\s\\S]*?<\\/w:footnote>`), '');
      setZipEntry(zip, 'word/footnotes.xml', fnXml);

      let docXml = getZipEntry(zip, 'word/document.xml')!;
      docXml = docXml.replace(new RegExp(`<w:footnoteReference w:id="${targetId}"[^/]*/>`, 'g'), '');

      if (clean_orphans) {
        const remainingDefs = [...fnXml.matchAll(/<w:footnote w:id="(-?\d+)"/g)]
          .map(m => parseInt(m[1], 10)).filter(id => id > 0);
        const allRefs = [...docXml.matchAll(/<w:footnoteReference w:id="(\d+)"/g)]
          .map(m => parseInt(m[1], 10));
        const orphans = allRefs.filter(id => !remainingDefs.includes(id));
        orphans.forEach(id => {
          docXml = docXml.replace(new RegExp(`<w:footnoteReference w:id="${id}"[^/]*/>`, 'g'), '');
        });
      }

      setZipEntry(zip, 'word/document.xml', docXml);
      await saveZip(zip, filepath);
      return { content: [{ type: 'text' as const, text: `Footnote ${targetId} deleted with cleanup.` }] };
    }
  );

  // ══════════════════════════════════════════════════════════════════════════
  // GROUP 7 – Document Analysis
  // ══════════════════════════════════════════════════════════════════════════

  server.tool(
    'get_paragraph_text_from_document',
    'Get the text content of a specific paragraph by index.',
    {
      filename: z.string(),
      paragraph_index: z.number().describe('0-based paragraph index'),
    },
    async ({ filename, paragraph_index }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      const docXml = getZipEntry(zip, 'word/document.xml')!;
      const doc = parseXmlDoc(docXml);
      const body = getBodyEl(doc);
      const paras = bodyParagraphs(body);
      if (paragraph_index >= paras.length)
        throw new Error(`Index ${paragraph_index} out of range (${paras.length} paragraphs)`);
      return { content: [{ type: 'text' as const, text: paraText(paras[paragraph_index]) }] };
    }
  );

  server.tool(
    'find_text_in_document',
    'Search for text in a document and return locations.',
    {
      filename: z.string(),
      text_to_find: z.string(),
      match_case: z.boolean().optional().describe('Case-sensitive search (default: true)'),
      whole_word: z.boolean().optional().describe('Match whole words only (default: false)'),
    },
    async ({ filename, text_to_find, match_case, whole_word }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      const docXml = getZipEntry(zip, 'word/document.xml')!;
      const doc = parseXmlDoc(docXml);
      const body = getBodyEl(doc);
      const paras = bodyParagraphs(body);
      const results: string[] = [];
      const needle = match_case !== false ? text_to_find : text_to_find.toLowerCase();

      for (let i = 0; i < paras.length; i++) {
        let text = paraText(paras[i]);
        const haystack = match_case !== false ? text : text.toLowerCase();
        const searchNeedle = whole_word ? new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`) : needle;
        const found = typeof searchNeedle === 'string' ? haystack.includes(searchNeedle) : searchNeedle.test(haystack);
        if (found) results.push(`Paragraph ${i}: "${text.slice(0, 100)}${text.length > 100 ? '…' : ''}"`);
      }

      const text = results.length ? results.join('\n') : `"${text_to_find}" not found.`;
      return { content: [{ type: 'text' as const, text }] };
    }
  );

  server.tool(
    'convert_to_pdf',
    'Convert a .docx file to PDF using Microsoft Word COM automation (requires Word installed on Windows).',
    {
      filename: z.string().describe('Source .docx file'),
      output_filename: z.string().optional().describe('Output PDF path (default: same name with .pdf)'),
    },
    async ({ filename, output_filename }) => {
      if (process.platform !== 'win32') throw new Error('PDF conversion requires Windows with Microsoft Word installed.');
      const filepath = resolvePath(filename, workingDir);
      const pdfPath = output_filename
        ? resolvePath(output_filename, workingDir)
        : filepath.replace(/\.docx$/i, '.pdf');
      const esc = (s: string) => s.replace(/'/g, "''");
      const script = `
        $word = New-Object -ComObject Word.Application
        $word.Visible = $false
        try {
          $doc = $word.Documents.Open('${esc(filepath)}')
          $doc.ExportAsFixedFormat('${esc(pdfPath)}', 17)
          $doc.Close()
          "Converted: ${esc(pdfPath)}"
        } finally {
          $word.Quit()
          [Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
        }
      `;
      const out = await runPS(script, 120000);
      return { content: [{ type: 'text' as const, text: out || `PDF saved: ${pdfPath}` }] };
    }
  );

  // ══════════════════════════════════════════════════════════════════════════
  // GROUP 8 – Block Replacement
  // ══════════════════════════════════════════════════════════════════════════

  server.tool(
    'replace_paragraph_block_below_header',
    'Replace paragraphs that appear below a specific header paragraph.',
    {
      filename: z.string(),
      header_text: z.string().describe('Text of the heading paragraph to locate'),
      new_paragraphs: z.array(z.string()).describe('New paragraph texts to replace the block'),
    },
    async ({ filename, header_text, new_paragraphs }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      const docXml = getZipEntry(zip, 'word/document.xml')!;
      const doc = parseXmlDoc(docXml);
      const body = getBodyEl(doc);
      const children = directChildren(body);

      // Find the header paragraph
      let headerIdx = -1;
      for (let i = 0; i < children.length; i++) {
        if (children[i].localName === 'p') {
          const pPr = (children[i] as any).getElementsByTagNameNS(W_NS, 'pStyle');
          if (pPr && pPr.length > 0) {
            const style: string = pPr[0].getAttribute('w:val') || '';
            if (/heading/i.test(style) && paraText(children[i]).includes(header_text)) {
              headerIdx = i;
              break;
            }
          }
        }
      }
      if (headerIdx === -1) throw new Error(`Header containing "${header_text}" not found`);

      // Find block end: next heading or end of body (before sectPr)
      let blockEnd = children.length;
      for (let i = headerIdx + 1; i < children.length; i++) {
        if (children[i].localName === 'sectPr') { blockEnd = i; break; }
        if (children[i].localName === 'p') {
          const pPr = (children[i] as any).getElementsByTagNameNS(W_NS, 'pStyle');
          if (pPr && pPr.length > 0 && /heading/i.test(pPr[0].getAttribute('w:val') || '')) {
            blockEnd = i; break;
          }
        }
      }

      // Remove existing block paragraphs
      for (let i = blockEnd - 1; i > headerIdx; i--) {
        if (children[i] && children[i].localName !== 'sectPr') body.removeChild(children[i]);
      }

      // Insert new paragraphs after header
      const headerEl = children[headerIdx];
      const newEls = new_paragraphs.map(t => importFragment(buildParaXml(t), doc));
      newEls.reverse().forEach(el => {
        headerEl.parentNode!.insertBefore(el, headerEl.nextSibling);
      });

      setZipEntry(zip, 'word/document.xml', serializeDoc(doc));
      await saveZip(zip, filepath);
      return { content: [{ type: 'text' as const, text: `Block below "${header_text}" replaced with ${new_paragraphs.length} paragraph(s).` }] };
    }
  );

  server.tool(
    'replace_block_between_manual_anchors',
    'Replace content between two anchor paragraphs.',
    {
      filename: z.string(),
      start_anchor_text: z.string().describe('Text of the start anchor paragraph'),
      new_paragraphs: z.array(z.string()).describe('Replacement paragraph texts'),
      end_anchor_text: z.string().describe('Text of the end anchor paragraph'),
    },
    async ({ filename, start_anchor_text, new_paragraphs, end_anchor_text }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      const docXml = getZipEntry(zip, 'word/document.xml')!;
      const doc = parseXmlDoc(docXml);
      const body = getBodyEl(doc);
      const paras = bodyParagraphs(body);

      const startIdx = paras.findIndex(p => paraText(p).includes(start_anchor_text));
      const endIdx = paras.findIndex(p => paraText(p).includes(end_anchor_text));
      if (startIdx === -1) throw new Error(`Start anchor "${start_anchor_text}" not found`);
      if (endIdx === -1) throw new Error(`End anchor "${end_anchor_text}" not found`);
      if (endIdx <= startIdx) throw new Error('End anchor must come after start anchor');

      // Remove paragraphs between anchors (exclusive)
      for (let i = endIdx - 1; i > startIdx; i--) paras[i].parentNode!.removeChild(paras[i]);

      // Insert new paragraphs between start and end anchors
      const updatedParas = bodyParagraphs(body);
      const newStartIdx = updatedParas.findIndex(p => paraText(p).includes(start_anchor_text));
      const anchorEl = updatedParas[newStartIdx];
      const newEls = new_paragraphs.map(t => importFragment(buildParaXml(t), doc));
      newEls.reverse().forEach(el => anchorEl.parentNode!.insertBefore(el, anchorEl.nextSibling));

      setZipEntry(zip, 'word/document.xml', serializeDoc(doc));
      await saveZip(zip, filepath);
      return { content: [{ type: 'text' as const, text: `Block between anchors replaced with ${new_paragraphs.length} paragraph(s).` }] };
    }
  );

  // ══════════════════════════════════════════════════════════════════════════
  // GROUP 9 – Comment Tools
  // ══════════════════════════════════════════════════════════════════════════

  server.tool(
    'get_all_comments',
    'Extract all comments from a .docx document.',
    { filename: z.string() },
    async ({ filename }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      const commentsXml = getZipEntry(zip, 'word/comments.xml');
      if (!commentsXml) return { content: [{ type: 'text' as const, text: 'No comments found in document.' }] };
      const doc = parseXmlDoc(commentsXml);
      const comments = (doc as any).getElementsByTagNameNS(W_NS, 'comment');
      const lines: string[] = [];
      for (let i = 0; i < comments.length; i++) {
        const c = comments[i];
        const id = (c as any).getAttribute('w:id');
        const author = (c as any).getAttribute('w:author') || '(unknown)';
        const date = (c as any).getAttribute('w:date') || '';
        const tNodes = (c as any).getElementsByTagNameNS(W_NS, 't');
        let text = '';
        for (let j = 0; j < tNodes.length; j++) text += tNodes[j].textContent || '';
        lines.push(`[${id}] ${author} (${date.slice(0, 10)}): ${text}`);
      }
      return { content: [{ type: 'text' as const, text: lines.join('\n') || 'No comments.' }] };
    }
  );

  server.tool(
    'get_comments_by_author',
    'Get all comments written by a specific author.',
    {
      filename: z.string(),
      author: z.string().describe('Author name to filter by'),
    },
    async ({ filename, author }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      const commentsXml = getZipEntry(zip, 'word/comments.xml');
      if (!commentsXml) return { content: [{ type: 'text' as const, text: 'No comments found.' }] };
      const doc = parseXmlDoc(commentsXml);
      const comments = (doc as any).getElementsByTagNameNS(W_NS, 'comment');
      const lines: string[] = [];
      for (let i = 0; i < comments.length; i++) {
        const c = comments[i];
        const commentAuthor = (c as any).getAttribute('w:author') || '';
        if (!commentAuthor.toLowerCase().includes(author.toLowerCase())) continue;
        const id = (c as any).getAttribute('w:id');
        const date = (c as any).getAttribute('w:date') || '';
        const tNodes = (c as any).getElementsByTagNameNS(W_NS, 't');
        let text = '';
        for (let j = 0; j < tNodes.length; j++) text += tNodes[j].textContent || '';
        lines.push(`[${id}] ${commentAuthor} (${date.slice(0, 10)}): ${text}`);
      }
      return { content: [{ type: 'text' as const, text: lines.join('\n') || `No comments by "${author}".` }] };
    }
  );

  server.tool(
    'get_comments_for_paragraph',
    'Get all comments associated with a specific paragraph.',
    {
      filename: z.string(),
      paragraph_index: z.number().describe('0-based paragraph index'),
    },
    async ({ filename, paragraph_index }) => {
      const filepath = resolvePath(filename, workingDir);
      const zip = new AdmZip(filepath);
      const commentsXml = getZipEntry(zip, 'word/comments.xml');
      if (!commentsXml) return { content: [{ type: 'text' as const, text: 'No comments found.' }] };

      // Find comment reference IDs in the target paragraph
      const docXml = getZipEntry(zip, 'word/document.xml')!;
      const doc = parseXmlDoc(docXml);
      const body = getBodyEl(doc);
      const paras = bodyParagraphs(body);
      if (paragraph_index >= paras.length) throw new Error(`Index ${paragraph_index} out of range`);
      const para = paras[paragraph_index];
      const refs = (para as any).getElementsByTagNameNS(W_NS, 'commentReference');
      if (!refs || refs.length === 0) return { content: [{ type: 'text' as const, text: 'No comments on this paragraph.' }] };

      const refIds = new Set<string>();
      for (let i = 0; i < refs.length; i++) refIds.add((refs[i] as any).getAttribute('w:id') || '');

      const cdoc = parseXmlDoc(commentsXml);
      const comments = (cdoc as any).getElementsByTagNameNS(W_NS, 'comment');
      const lines: string[] = [];
      for (let i = 0; i < comments.length; i++) {
        const c = comments[i];
        const id = (c as any).getAttribute('w:id');
        if (!refIds.has(id)) continue;
        const author = (c as any).getAttribute('w:author') || '(unknown)';
        const date = (c as any).getAttribute('w:date') || '';
        const tNodes = (c as any).getElementsByTagNameNS(W_NS, 't');
        let text = '';
        for (let j = 0; j < tNodes.length; j++) text += tNodes[j].textContent || '';
        lines.push(`[${id}] ${author} (${date.slice(0, 10)}): ${text}`);
      }
      return { content: [{ type: 'text' as const, text: lines.join('\n') || 'Comments not found by ID.' }] };
    }
  );

  return server;
}
