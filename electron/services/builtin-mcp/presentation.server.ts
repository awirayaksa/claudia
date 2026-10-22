import * as fs from 'fs';
import * as path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import type PptxGenJS from 'pptxgenjs';
import { atomicWrite, errorResult, fileScope, openPackage, resolveFile, withFileLock, wroteFiles, type FileScope } from './office-files';

// ============================================================================
// Lazy-loaded dependencies
// ============================================================================

let pptxModule: typeof PptxGenJS | null = null;

function newPptx(): PptxGenJS {
  if (!pptxModule) pptxModule = require('pptxgenjs');
  return new pptxModule!();
}

// ============================================================================
// Deck definition
//
// A deck is built from a definition (DeckSpec) in one go. The definition is
// stored inside the .pptx (a custom XML part), so later calls can add, change
// or remove slides and build the file again.
// ============================================================================

const SLIDE_LAYOUTS = ['title', 'section', 'bullets', 'two_column', 'image', 'table', 'chart', 'quote', 'blank'] as const;
const CHART_TYPES = ['column', 'bar', 'line', 'area', 'pie', 'doughnut', 'scatter'] as const;
const THEME_NAMES = ['light', 'dark', 'corporate', 'warm', 'forest', 'minimal'] as const;
const ASPECTS = ['16:9', '4:3'] as const;

const bulletItem = z.union([z.string(), z.object({ text: z.string(), level: z.number().int().min(0).max(4).optional() })]);
const column = z.object({ heading: z.string().optional(), bullets: z.array(bulletItem).optional(), text: z.string().optional() });

const slideSchema = z.object({
  layout: z.enum(SLIDE_LAYOUTS).optional().describe('Default: bullets (or the layout the content implies).'),
  title: z.string().optional(),
  subtitle: z.string().optional().describe('title and section slides.'),
  bullets: z.array(bulletItem).optional().describe('Bullet points; {text, level} indents (level 1–4).'),
  text: z.string().optional().describe('A paragraph instead of (or before) bullets.'),
  left: column.optional().describe('two_column: left column.'),
  right: column.optional().describe('two_column: right column.'),
  image: z
    .object({ path: z.string().describe('PNG, JPEG or GIF file in the working directory.'), caption: z.string().optional() })
    .optional()
    .describe('image slides; on a bullets slide it sits on the right.'),
  table: z
    .object({
      header: z.array(z.string()).optional(),
      rows: z.array(z.array(z.union([z.string(), z.number()]))),
    })
    .optional(),
  chart: z
    .object({
      type: z.enum(CHART_TYPES),
      categories: z.array(z.union([z.string(), z.number()])).describe('Labels (x values for scatter).'),
      series: z.array(z.object({ name: z.string(), values: z.array(z.number()) })).min(1),
      title: z.string().optional(),
      stacked: z.boolean().optional(),
      data_labels: z.boolean().optional(),
      x_axis_title: z.string().optional(),
      y_axis_title: z.string().optional(),
      number_format: z.string().optional().describe('Excel format for values, e.g. "#,##0" or "0%".'),
    })
    .optional(),
  quote: z.object({ text: z.string(), attribution: z.string().optional() }).optional(),
  notes: z.string().optional().describe('Speaker notes.'),
});
type SlideSpec = z.infer<typeof slideSchema>;
type Bullet = z.infer<typeof bulletItem>;

const themeSchema = z.object({
  name: z.enum(THEME_NAMES).optional().describe('Preset (default: light).'),
  background: z.string().optional().describe('Hex color overrides, e.g. "#FFFFFF".'),
  title_color: z.string().optional(),
  text_color: z.string().optional(),
  accent_color: z.string().optional(),
  heading_font: z.string().optional().describe('e.g. "Calibri", "Georgia".'),
  body_font: z.string().optional(),
});
type ThemeSpec = z.infer<typeof themeSchema>;

interface DeckSpec {
  version: 1;
  title?: string;
  author?: string;
  aspect: (typeof ASPECTS)[number];
  theme: ThemeSpec;
  slides: SlideSpec[];
}

interface Theme {
  background: string;
  title: string;
  text: string;
  muted: string;
  accent: string;
  /** Background and text of title and section slides. */
  coverBackground: string;
  coverText: string;
  headingFont: string;
  bodyFont: string;
  chartColors: string[];
}

const PRESETS: Record<(typeof THEME_NAMES)[number], Theme> = {
  light: { background: 'FFFFFF', title: '111827', text: '1F2937', muted: '6B7280', accent: '2563EB', coverBackground: 'FFFFFF', coverText: '111827', headingFont: 'Calibri', bodyFont: 'Calibri', chartColors: ['2563EB', 'F59E0B', '10B981', 'EF4444', '8B5CF6', '06B6D4'] },
  dark: { background: '111827', title: 'FFFFFF', text: 'E5E7EB', muted: '9CA3AF', accent: '60A5FA', coverBackground: '0B1220', coverText: 'FFFFFF', headingFont: 'Calibri', bodyFont: 'Calibri', chartColors: ['60A5FA', 'FBBF24', '34D399', 'F87171', 'A78BFA', '22D3EE'] },
  corporate: { background: 'FFFFFF', title: '1F3864', text: '262626', muted: '7F7F7F', accent: '2E75B6', coverBackground: '1F3864', coverText: 'FFFFFF', headingFont: 'Calibri', bodyFont: 'Calibri', chartColors: ['2E75B6', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47'] },
  warm: { background: 'FFFBF5', title: '7C2D12', text: '44403C', muted: '78716C', accent: 'EA580C', coverBackground: '7C2D12', coverText: 'FFF7ED', headingFont: 'Georgia', bodyFont: 'Calibri', chartColors: ['EA580C', 'CA8A04', '65A30D', 'B91C1C', '9333EA', '0891B2'] },
  forest: { background: 'F7FAF7', title: '14532D', text: '1C2B22', muted: '5B6B60', accent: '16A34A', coverBackground: '14532D', coverText: 'F0FDF4', headingFont: 'Calibri', bodyFont: 'Calibri', chartColors: ['16A34A', '0D9488', 'CA8A04', '2563EB', 'DC2626', '7C3AED'] },
  minimal: { background: 'FFFFFF', title: '000000', text: '222222', muted: '777777', accent: '000000', coverBackground: 'FFFFFF', coverText: '000000', headingFont: 'Arial', bodyFont: 'Arial', chartColors: ['222222', '777777', 'AAAAAA', '444444', '999999', 'CCCCCC'] },
};

function hex(color: string | undefined): string | undefined {
  if (!color) return undefined;
  const h = color.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`Invalid color "${color}" (use hex like "#1F4E79")`);
  return h.toUpperCase();
}

function resolveTheme(spec: ThemeSpec): Theme {
  const base = PRESETS[spec.name ?? 'light'];
  const accent = hex(spec.accent_color) ?? base.accent;
  return {
    ...base,
    background: hex(spec.background) ?? base.background,
    title: hex(spec.title_color) ?? base.title,
    text: hex(spec.text_color) ?? base.text,
    accent,
    chartColors: [accent, ...base.chartColors.filter((c) => c !== accent)],
    headingFont: spec.heading_font ?? base.headingFont,
    bodyFont: spec.body_font ?? base.bodyFont,
  };
}

/** The layout a slide uses when none is given. */
function layoutOf(s: SlideSpec): (typeof SLIDE_LAYOUTS)[number] {
  if (s.layout) return s.layout;
  if (s.chart) return 'chart';
  if (s.table) return 'table';
  if (s.quote) return 'quote';
  if (s.left || s.right) return 'two_column';
  if (s.image && !s.bullets && !s.text) return 'image';
  return 'bullets';
}

// ============================================================================
// Images
// ============================================================================

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif' };

/** Pixel size of a PNG, JPEG or GIF (for fitting it without distortion). */
function imageSize(buf: Buffer): { w: number; h: number } {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'GIF') return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) break;
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      }
      i += 2 + len;
    }
  }
  return { w: 4, h: 3 };
}

interface LoadedImage {
  data: string;
  w: number;
  h: number;
}

function loadImage(scope: FileScope, file: string): LoadedImage {
  const p = resolveFile(scope, file);
  const type = IMAGE_TYPES[path.extname(p).toLowerCase()];
  if (!type) throw new Error(`Image "${file}" must be PNG, JPEG or GIF (render diagrams to PNG first).`);
  let buf: Buffer;
  try {
    buf = fs.readFileSync(p);
  } catch {
    throw new Error(`Image not found: ${p}`);
  }
  const { w, h } = imageSize(buf);
  return { data: `${type};base64,${buf.toString('base64')}`, w, h };
}

/** Fit w×h inside a box, centered. */
function fit(img: { w: number; h: number }, box: { x: number; y: number; w: number; h: number }) {
  const scale = Math.min(box.w / img.w, box.h / img.h);
  const w = img.w * scale;
  const h = img.h * scale;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

/** An image fitted in a box, with its caption right under it. */
function placeImage(
  slide: PptxGenJS.Slide,
  img: LoadedImage,
  box: { x: number; y: number; w: number; h: number },
  caption: string | undefined,
  theme: Theme,
  fontSize: number
): void {
  const captionH = caption ? 0.45 : 0;
  const at = fit(img, { ...box, h: box.h - captionH });
  // Keep the image and caption together, centered in the box
  const y = box.y + (box.h - at.h - captionH) / 2;
  slide.addImage({ data: img.data, x: at.x, y, w: at.w, h: at.h });
  if (caption) slide.addText(caption, { x: box.x, y: y + at.h + 0.05, w: box.w, h: 0.4, fontSize, color: theme.muted, align: 'center', fontFace: theme.bodyFont });
}

// ============================================================================
// Building the file
// ============================================================================

const SPEC_NS = 'urn:claudia:pptx-deck';
const SPEC_PART = 'customXml/claudiaDeck.xml';

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function bulletRuns(items: Bullet[], theme: Theme, size: number) {
  return items.map((b) => {
    const { text, level } = typeof b === 'string' ? { text: b, level: 0 } : { text: b.text, level: b.level ?? 0 };
    return {
      text,
      options: {
        bullet: level === 0 ? { code: '25A0' } : true,
        indentLevel: level,
        fontSize: Math.max(size - level * 2, 12),
        color: level === 0 ? theme.text : theme.muted,
        breakLine: true,
        paraSpaceAfter: 8,
      },
    };
  });
}

function textBlock(text: string | undefined, bullets: Bullet[] | undefined, theme: Theme, size: number) {
  const runs: Array<{ text: string; options: Record<string, unknown> }> = [];
  if (text) runs.push({ text, options: { fontSize: size, color: theme.text, breakLine: true, paraSpaceAfter: 12 } });
  if (bullets?.length) runs.push(...bulletRuns(bullets, theme, size));
  return runs;
}

/** Build the deck; returns the .pptx bytes and notes about content that may not fit. */
async function buildDeck(spec: DeckSpec, scope: FileScope): Promise<{ data: Buffer; warnings: string[] }> {
  const pptx = newPptx();
  pptx.layout = spec.aspect === '4:3' ? 'LAYOUT_4x3' : 'LAYOUT_WIDE';
  const W = spec.aspect === '4:3' ? 10 : 13.333;
  const H = 7.5;
  const M = 0.6;
  if (spec.title) pptx.title = spec.title;
  if (spec.author) pptx.author = spec.author;
  pptx.company = 'Claudia';
  const theme = resolveTheme(spec.theme);
  const warnings: string[] = [];
  const content = { x: M, y: 1.55, w: W - 2 * M, h: H - 1.55 - 0.65 };

  spec.slides.forEach((s, i) => {
    const n = i + 1;
    const layout = layoutOf(s);
    const slide = pptx.addSlide();
    const cover = layout === 'title' || layout === 'section';
    slide.background = { color: cover ? theme.coverBackground : theme.background };

    const heading = (title: string | undefined) => {
      if (!title) return;
      slide.addText(title, { x: M, y: 0.35, w: W - 2 * M, h: 0.95, fontFace: theme.headingFont, fontSize: 30, bold: true, color: theme.title, valign: 'bottom', fit: 'shrink' });
      slide.addShape('rect', { x: M, y: 1.33, w: 1.1, h: 0.06, fill: { color: theme.accent }, line: { color: theme.accent, width: 0 } });
    };

    switch (layout) {
      case 'title': {
        slide.addShape('rect', { x: 0, y: H - 0.18, w: W, h: 0.18, fill: { color: theme.accent }, line: { color: theme.accent, width: 0 } });
        slide.addText(s.title ?? spec.title ?? '', { x: M, y: 2.0, w: W - 2 * M, h: 1.6, fontFace: theme.headingFont, fontSize: 44, bold: true, color: theme.coverText, valign: 'bottom', fit: 'shrink' });
        slide.addShape('rect', { x: M, y: 3.75, w: 1.4, h: 0.07, fill: { color: theme.accent }, line: { color: theme.accent, width: 0 } });
        if (s.subtitle) slide.addText(s.subtitle, { x: M, y: 3.95, w: W - 2 * M, h: 1.0, fontFace: theme.bodyFont, fontSize: 22, color: theme.coverText, transparency: 15, valign: 'top' });
        break;
      }
      case 'section': {
        slide.addShape('rect', { x: M, y: 2.6, w: 0.12, h: 2.0, fill: { color: theme.accent }, line: { color: theme.accent, width: 0 } });
        slide.addText(s.title ?? '', { x: M + 0.4, y: 2.6, w: W - 2 * M - 0.4, h: 1.2, fontFace: theme.headingFont, fontSize: 38, bold: true, color: theme.coverText, valign: 'bottom', fit: 'shrink' });
        if (s.subtitle) slide.addText(s.subtitle, { x: M + 0.4, y: 3.8, w: W - 2 * M - 0.4, h: 0.8, fontFace: theme.bodyFont, fontSize: 20, color: theme.coverText, transparency: 20, valign: 'top' });
        break;
      }
      case 'bullets':
      case 'blank': {
        heading(s.title);
        const runs = textBlock(s.text, s.bullets, theme, 22);
        const withImage = layout === 'bullets' && s.image;
        const textBox = withImage ? { ...content, w: content.w * 0.55 } : content;
        if (runs.length) slide.addText(runs as never, { ...textBox, fontFace: theme.bodyFont, valign: 'top', fit: 'shrink' });
        if (withImage) {
          const box = { x: content.x + content.w * 0.6, y: content.y, w: content.w * 0.4, h: content.h };
          placeImage(slide, loadImage(scope, s.image!.path), box, s.image!.caption, theme, 12);
        }
        const lines = (s.bullets?.length ?? 0) + (s.text ? Math.ceil(s.text.length / 90) : 0);
        if (lines > 9) warnings.push(`Slide ${n} has a lot of text (${lines} lines); the text was shrunk to fit. Consider splitting it.`);
        break;
      }
      case 'two_column': {
        heading(s.title);
        const gap = 0.5;
        const colW = (content.w - gap) / 2;
        [s.left, s.right].forEach((col, ci) => {
          if (!col) return;
          const x = content.x + ci * (colW + gap);
          let y = content.y;
          if (col.heading) {
            slide.addText(col.heading, { x, y, w: colW, h: 0.55, fontFace: theme.headingFont, fontSize: 22, bold: true, color: theme.accent });
            y += 0.65;
          }
          const runs = textBlock(col.text, col.bullets, theme, 18);
          if (runs.length) slide.addText(runs as never, { x, y, w: colW, h: content.y + content.h - y, fontFace: theme.bodyFont, valign: 'top', fit: 'shrink' });
        });
        break;
      }
      case 'image': {
        heading(s.title);
        if (!s.image) {
          warnings.push(`Slide ${n} is an image slide without an image.`);
          break;
        }
        const box = s.title ? content : { x: M, y: M, w: W - 2 * M, h: H - 2 * M };
        placeImage(slide, loadImage(scope, s.image.path), box, s.image.caption, theme, 14);
        break;
      }
      case 'table': {
        heading(s.title);
        if (!s.table) break;
        const rowsCount = s.table.rows.length + (s.table.header ? 1 : 0);
        const size = rowsCount > 14 ? 10 : rowsCount > 10 ? 12 : 14;
        if (rowsCount > 16) warnings.push(`Slide ${n}: the table has ${rowsCount} rows and may run off the slide; split it over several slides.`);
        const rows: Array<Array<{ text: string; options?: Record<string, unknown> }>> = [];
        if (s.table.header) rows.push(s.table.header.map((h) => ({ text: h, options: { bold: true, color: 'FFFFFF', fill: { color: theme.accent } } })));
        s.table.rows.forEach((r, ri) =>
          rows.push(r.map((v) => ({ text: String(v), options: { color: theme.text, fill: { color: ri % 2 ? lighten(theme.background) : theme.background }, align: typeof v === 'number' ? 'right' : 'left' } })))
        );
        slide.addTable(rows as never, { x: content.x, y: content.y, w: content.w, fontFace: theme.bodyFont, fontSize: size, border: { type: 'solid', pt: 0.5, color: 'BFBFBF' }, valign: 'middle', margin: 0.06 });
        break;
      }
      case 'chart': {
        heading(s.title);
        if (!s.chart) break;
        const c = s.chart;
        const type = { column: 'bar', bar: 'bar', line: 'line', area: 'area', pie: 'pie', doughnut: 'doughnut', scatter: 'scatter' }[c.type] as never;
        const data =
          c.type === 'scatter'
            ? [{ name: 'X', values: c.categories.map(Number) }, ...c.series.map((se) => ({ name: se.name, values: se.values }))]
            : (c.type === 'pie' || c.type === 'doughnut' ? c.series.slice(0, 1) : c.series).map((se) => ({ name: se.name, labels: c.categories.map(String), values: se.values }));
        const pie = c.type === 'pie' || c.type === 'doughnut';
        slide.addChart(type, data as never, {
          ...content,
          barDir: c.type === 'bar' ? 'bar' : 'col',
          barGrouping: c.stacked ? 'stacked' : c.type === 'column' || c.type === 'bar' ? 'clustered' : 'standard',
          chartColors: pie ? theme.chartColors : theme.chartColors.slice(0, Math.max(c.series.length, 1)),
          showTitle: !!c.title,
          title: c.title,
          titleColor: theme.title,
          titleFontFace: theme.headingFont,
          showLegend: pie || c.series.length > 1,
          legendPos: pie ? 'r' : 'b',
          legendColor: theme.text,
          legendFontFace: theme.bodyFont,
          showValue: !!c.data_labels && !pie,
          showPercent: !!c.data_labels && pie,
          dataLabelColor: theme.text,
          catAxisLabelColor: theme.text,
          valAxisLabelColor: theme.text,
          catAxisLabelFontFace: theme.bodyFont,
          valAxisLabelFontFace: theme.bodyFont,
          ...(c.number_format ? { valAxisLabelFormatCode: c.number_format, dataLabelFormatCode: c.number_format } : {}),
          ...(c.x_axis_title ? { showCatAxisTitle: true, catAxisTitle: c.x_axis_title, catAxisTitleColor: theme.muted } : {}),
          ...(c.y_axis_title ? { showValAxisTitle: true, valAxisTitle: c.y_axis_title, valAxisTitleColor: theme.muted } : {}),
          valGridLine: { color: 'D9D9D9', size: 0.5 },
          catGridLine: { style: 'none' },
          ...(c.type === 'scatter' ? { lineSize: 0, lineDataSymbolSize: 8 } : {}),
          ...(c.type === 'doughnut' ? { holeSize: 55 } : {}),
        } as never);
        break;
      }
      case 'quote': {
        if (!s.quote) break;
        slide.addText('“', { x: M, y: 0.8, w: 1.5, h: 1.5, fontSize: 120, color: theme.accent, fontFace: 'Georgia' });
        slide.addText(s.quote.text, { x: M + 0.8, y: 1.9, w: W - 2 * M - 1.6, h: 3.0, fontSize: 30, italic: true, color: theme.title, fontFace: theme.headingFont, valign: 'middle', fit: 'shrink' });
        if (s.quote.attribution) slide.addText(`— ${s.quote.attribution}`, { x: M + 0.8, y: 5.0, w: W - 2 * M - 1.6, h: 0.6, fontSize: 18, color: theme.muted, align: 'right', fontFace: theme.bodyFont });
        break;
      }
    }

    if (!cover) slide.addText(String(n), { x: W - M - 1, y: H - 0.5, w: 1, h: 0.3, fontSize: 10, color: theme.muted, align: 'right', fontFace: theme.bodyFont });
    if (s.notes) slide.addNotes(s.notes);
  });

  const raw = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
  return { data: await storeSpec(raw, spec), warnings };
}

/** A slightly darker or lighter shade of the background, for table stripes. */
function lighten(bg: string): string {
  const n = parseInt(bg, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const dark = r * 0.299 + g * 0.587 + b * 0.114 < 128;
  const shift = (v: number) => Math.max(0, Math.min(255, Math.round(dark ? v + 22 : v - 12)));
  return [shift(r), shift(g), shift(b)].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** Keep the deck definition in the package (a custom XML part of the presentation). */
async function storeSpec(pptx: Buffer, spec: DeckSpec): Promise<Buffer> {
  const zip = await JSZip.loadAsync(pptx);
  zip.file(SPEC_PART, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<claudiaDeck xmlns="${SPEC_NS}">${escapeXml(JSON.stringify(spec))}</claudiaDeck>`);
  const types = await zip.file('[Content_Types].xml')!.async('string');
  if (!types.includes(`/${SPEC_PART}`)) {
    zip.file('[Content_Types].xml', types.replace('</Types>', `<Override PartName="/${SPEC_PART}" ContentType="application/xml"/></Types>`));
  }
  const relsName = 'ppt/_rels/presentation.xml.rels';
  const rels = await zip.file(relsName)!.async('string');
  if (!rels.includes(SPEC_PART)) {
    zip.file(
      relsName,
      rels.replace(
        '</Relationships>',
        `<Relationship Id="rIdClaudiaDeck" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml" Target="../${SPEC_PART}"/></Relationships>`
      )
    );
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function readSpec(zip: JSZip): Promise<DeckSpec | null> {
  for (const name of Object.keys(zip.files)) {
    if (!/^customXml\/[^/]+\.xml$/i.test(name)) continue;
    const xml = await zip.file(name)!.async('string');
    if (!xml.includes(SPEC_NS)) continue;
    try {
      const spec = JSON.parse(new DOMParser().parseFromString(xml, 'text/xml').documentElement?.textContent ?? '');
      if (spec?.version === 1 && Array.isArray(spec.slides)) return spec as DeckSpec;
    } catch {
      /* not ours after all */
    }
  }
  return null;
}

/** Slide texts and notes of any .pptx, in slide order. */
async function extractText(zip: JSZip): Promise<Array<{ text: string[]; notes: string }>> {
  const parser = new DOMParser();
  const pres = parser.parseFromString(await zip.file('ppt/presentation.xml')!.async('string'), 'text/xml');
  const rels = parser.parseFromString(await zip.file('ppt/_rels/presentation.xml.rels')!.async('string'), 'text/xml');
  const targets = new Map<string, string>();
  const relEls = rels.getElementsByTagName('Relationship');
  for (let i = 0; i < relEls.length; i++) targets.set(relEls[i].getAttribute('Id') ?? '', relEls[i].getAttribute('Target') ?? '');
  const ids = pres.getElementsByTagName('p:sldId');
  const texts = (xml: string) => {
    const doc = parser.parseFromString(xml, 'text/xml');
    const paras = doc.getElementsByTagName('a:p');
    const out: string[] = [];
    for (let i = 0; i < paras.length; i++) {
      const runs = paras[i].getElementsByTagName('a:t');
      let line = '';
      for (let j = 0; j < runs.length; j++) line += runs[j].textContent ?? '';
      if (line.trim()) out.push(line.trim());
    }
    return out;
  };
  const slides: Array<{ text: string[]; notes: string }> = [];
  for (let i = 0; i < ids.length; i++) {
    const rid = ids[i].getAttribute('r:id') ?? '';
    const part = `ppt/${(targets.get(rid) ?? '').replace(/^\/?ppt\//, '')}`;
    const xml = await zip.file(part)?.async('string');
    if (!xml) continue;
    const slideRels = await zip.file(part.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels'))?.async('string');
    const notesTarget = slideRels && /Target="([^"]*notesSlide\d+\.xml)"/.exec(slideRels)?.[1];
    const notesXml = notesTarget ? await zip.file(`ppt/notesSlides/${notesTarget.split('/').pop()}`)?.async('string') : undefined;
    // The notes page repeats the slide number; keep the speaker text only
    const notes = notesXml ? texts(notesXml).filter((t) => !/^\d+$/.test(t)).join(' ') : '';
    slides.push({ text: texts(xml), notes });
  }
  return slides;
}

// ============================================================================
// Server factory
// ============================================================================

const slideSummary = (s: SlideSpec, i: number) => {
  const parts = [`${i + 1}. [${layoutOf(s)}] ${s.title ?? s.quote?.text.slice(0, 60) ?? '(untitled)'}`];
  if (s.subtitle) parts.push(`   subtitle: ${s.subtitle}`);
  if (s.text) parts.push(`   text: ${s.text}`);
  for (const b of s.bullets ?? []) parts.push(`   ${'  '.repeat(typeof b === 'string' ? 0 : b.level ?? 0)}- ${typeof b === 'string' ? b : b.text}`);
  for (const [side, col] of [['left', s.left], ['right', s.right]] as const) {
    if (col) parts.push(`   ${side}: ${col.heading ?? ''} ${(col.bullets ?? []).map((b) => (typeof b === 'string' ? b : b.text)).join('; ')} ${col.text ?? ''}`.trimEnd());
  }
  if (s.image) parts.push(`   image: ${s.image.path}${s.image.caption ? ` (${s.image.caption})` : ''}`);
  if (s.table) parts.push(`   table: ${s.table.header ? `${s.table.header.join(' | ')}; ` : ''}${s.table.rows.length} rows`);
  if (s.chart) parts.push(`   chart: ${s.chart.type}, ${s.chart.series.map((x) => x.name).join(', ')} over ${s.chart.categories.length} categories`);
  if (s.notes) parts.push(`   notes: ${s.notes}`);
  return parts.join('\n');
};

export function createPresentationServer(config?: Record<string, unknown>): McpServer {
  const server = new McpServer({ name: 'Claudia Presentations', version: '1.0.0' }, { capabilities: { tools: {} } });
  const scope = fileScope(config);
  const fileParam = z.string().describe('Presentation path, e.g. "pitch.pptx" (relative to the working directory).');

  const write = async (filepath: string, spec: DeckSpec, verb: string) => {
    const { data, warnings } = await buildDeck(spec, scope);
    await atomicWrite(filepath, data);
    const text = `${verb} ${filepath} (${spec.slides.length} slides).${warnings.length ? `\n${warnings.join('\n')}` : ''}`;
    return wroteFiles(text, filepath);
  };

  /** Change the definition of a deck made with these tools, then build it again. */
  const editDeck = (filename: string, change: (spec: DeckSpec) => string) => {
    const filepath = resolveFile(scope, filename, '.pptx');
    return withFileLock(filepath, async () => {
      if (!fs.existsSync(filepath)) return errorResult(`Presentation not found: ${filepath}`);
      const zip = await openPackage(await fs.promises.readFile(filepath), path.basename(filepath));
      const spec = await readSpec(zip);
      if (!spec) {
        return errorResult(
          `${path.basename(filepath)} was not made with create_presentation, so it can't be edited here. ` +
            'Read it with read_presentation and create a new deck from its content.'
        );
      }
      const verb = change(spec);
      return write(filepath, spec, verb);
    });
  };

  const slideNumber = (spec: DeckSpec, n: number) => {
    if (n < 1 || n > spec.slides.length) throw new Error(`Slide ${n} does not exist (the deck has ${spec.slides.length} slides).`);
    return n - 1;
  };

  // ---- create_presentation ----
  server.tool(
    'create_presentation',
    'Create a PowerPoint deck (.pptx) in one call: give every slide. Layouts: title (cover), section (divider), bullets ' +
      '(optionally with an image on the right), two_column, image, table, chart (native, editable PowerPoint chart), quote, ' +
      'blank. Every slide can have speaker notes. Themes: light, dark, corporate, warm, forest, minimal, with optional ' +
      'colors and fonts. Keep slides short: a title and 3–6 bullets. The deck opens in PowerPoint, Keynote, LibreOffice and Google Slides.',
    {
      filename: fileParam,
      title: z.string().optional().describe('Deck title (file properties; also the cover title when a title slide has none).'),
      author: z.string().optional(),
      theme: themeSchema.optional(),
      aspect_ratio: z.enum(ASPECTS).optional().describe('Default 16:9.'),
      slides: z.array(slideSchema).min(1),
      overwrite: z.boolean().optional().describe('Replace the file if it exists (default: false).'),
    },
    async ({ filename, title, author, theme, aspect_ratio, slides, overwrite }) => {
      const filepath = resolveFile(scope, filename, '.pptx');
      if (!overwrite && fs.existsSync(filepath)) {
        return errorResult(`${filepath} already exists. Pass overwrite: true to replace it, or change it with add_slides / update_slide.`);
      }
      const spec: DeckSpec = { version: 1, title, author, aspect: aspect_ratio ?? '16:9', theme: theme ?? {}, slides };
      return withFileLock(filepath, () => write(filepath, spec, 'Created'));
    }
  );

  // ---- add_slides ----
  server.tool(
    'add_slides',
    'Add slides to a deck made with create_presentation (same slide format).',
    {
      filename: fileParam,
      slides: z.array(slideSchema).min(1),
      position: z.number().int().min(1).optional().describe('Slide number the first new slide gets (default: at the end).'),
    },
    async ({ filename, slides, position }) =>
      editDeck(filename, (spec) => {
        const at = position ? Math.min(position - 1, spec.slides.length) : spec.slides.length;
        spec.slides.splice(at, 0, ...slides);
        return `Added ${slides.length} slide${slides.length === 1 ? '' : 's'} at ${at + 1} to`;
      })
  );

  // ---- update_slide ----
  server.tool(
    'update_slide',
    'Change one slide of a deck made with create_presentation. The fields given replace the slide\'s fields; set replace: true to replace the whole slide.',
    {
      filename: fileParam,
      slide_number: z.number().int().min(1),
      slide: slideSchema,
      replace: z.boolean().optional(),
    },
    async ({ filename, slide_number, slide, replace }) =>
      editDeck(filename, (spec) => {
        const i = slideNumber(spec, slide_number);
        spec.slides[i] = replace ? slide : { ...spec.slides[i], ...slide };
        return `Updated slide ${slide_number} of`;
      })
  );

  // ---- delete_slides ----
  server.tool(
    'delete_slides',
    'Delete slides from a deck made with create_presentation.',
    { filename: fileParam, slide_numbers: z.array(z.number().int().min(1)).min(1) },
    async ({ filename, slide_numbers }) =>
      editDeck(filename, (spec) => {
        const drop = new Set(slide_numbers.map((n) => slideNumber(spec, n)));
        if (drop.size >= spec.slides.length) throw new Error('A deck needs at least one slide.');
        spec.slides = spec.slides.filter((_, i) => !drop.has(i));
        return `Deleted slide${drop.size === 1 ? '' : 's'} ${[...slide_numbers].sort((a, b) => a - b).join(', ')} from`;
      })
  );

  // ---- move_slide ----
  server.tool(
    'move_slide',
    'Move a slide to another position in a deck made with create_presentation.',
    { filename: fileParam, from: z.number().int().min(1), to: z.number().int().min(1) },
    async ({ filename, from, to }) =>
      editDeck(filename, (spec) => {
        const i = slideNumber(spec, from);
        const j = slideNumber(spec, to);
        const [s] = spec.slides.splice(i, 1);
        spec.slides.splice(j, 0, s);
        return `Moved slide ${from} to ${to} in`;
      })
  );

  // ---- set_theme ----
  server.tool(
    'set_theme',
    'Change the theme (preset, colors, fonts) or aspect ratio of a deck made with create_presentation.',
    { filename: fileParam, theme: themeSchema, aspect_ratio: z.enum(ASPECTS).optional() },
    async ({ filename, theme, aspect_ratio }) =>
      editDeck(filename, (spec) => {
        spec.theme = theme.name ? theme : { ...spec.theme, ...theme };
        if (aspect_ratio) spec.aspect = aspect_ratio;
        return 'Restyled';
      })
  );

  // ---- read_presentation ----
  server.tool(
    'read_presentation',
    'Read a PowerPoint deck: every slide\'s content and speaker notes. Works for any .pptx; decks made with ' +
      'create_presentation are shown with their layouts, so they can be changed with the other tools.',
    { filename: fileParam },
    async ({ filename }) => {
      const filepath = resolveFile(scope, filename, '.pptx');
      if (!fs.existsSync(filepath)) return errorResult(`Presentation not found: ${filepath}`);
      const zip = await openPackage(await fs.promises.readFile(filepath), path.basename(filepath));
      const spec = await readSpec(zip);
      if (spec) {
        const head = `${filepath}: ${spec.slides.length} slides, ${spec.aspect}, theme ${spec.theme.name ?? 'light'}${spec.title ? `, "${spec.title}"` : ''}`;
        return { content: [{ type: 'text' as const, text: `${head}\n\n${spec.slides.map(slideSummary).join('\n')}` }] };
      }
      const slides = await extractText(zip);
      const body = slides
        .map((s, i) => `${i + 1}. ${s.text.join('\n   ') || '(no text)'}${s.notes ? `\n   notes: ${s.notes}` : ''}`)
        .join('\n');
      return { content: [{ type: 'text' as const, text: `${filepath}: ${slides.length} slides (not made by Claudia; read only)\n\n${body}` }] };
    }
  );

  return server;
}
