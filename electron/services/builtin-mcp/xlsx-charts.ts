/**
 * Native Excel charts for the Spreadsheet server.
 *
 * ExcelJS reads and writes cells but not charts. So the charts a workbook
 * should have are kept as definitions (ChartSpec) in a custom XML part of the
 * package, and after every save they are written into the package as real
 * DrawingML charts that point at the sheet's cells. Excel and LibreOffice
 * draw them from the cells, so they follow every later edit of the data.
 */
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';

// ============================================================================
// Chart definitions
// ============================================================================

export const CHART_TYPES = ['column', 'bar', 'line', 'area', 'pie', 'doughnut', 'scatter'] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export const LEGEND_POSITIONS = ['right', 'bottom', 'top', 'left', 'none'] as const;
export type LegendPosition = (typeof LEGEND_POSITIONS)[number];

export interface ChartSeriesSpec {
  /** Literal series name, or a single cell ("B1") holding it. */
  name?: string;
  /** Cells with the values, e.g. "B2:B13" or "'Q1 Sales'!B2:B13". */
  values: string;
}

export interface ChartSpec {
  id: string;
  /** Sheet the chart is drawn on. */
  sheet: string;
  type: ChartType;
  title?: string;
  /** Category labels (x values for scatter), e.g. "A2:A13". */
  categories?: string;
  series: ChartSeriesSpec[];
  /** Top-left cell of the chart, e.g. "E2". */
  anchor: string;
  /** Size in columns and rows. */
  widthCols: number;
  heightRows: number;
  xAxisTitle?: string;
  yAxisTitle?: string;
  legend: LegendPosition;
  stacked?: boolean;
  dataLabels?: boolean;
}

const SPEC_NS = 'urn:claudia:xlsx-charts';
const SPEC_PART = 'customXml/claudiaCharts.xml';

// ============================================================================
// References
// ============================================================================

/** "A1" → { col: 0, row: 0 } (zero-based). */
export function parseCell(ref: string): { col: number; row: number } {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(ref.trim());
  if (!m) throw new Error(`Invalid cell reference "${ref}" (expected something like "B2")`);
  let col = 0;
  for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: parseInt(m[2], 10) - 1 };
}

export function colLetter(col: number): string {
  let s = '';
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export interface RangeRef {
  sheet: string;
  start: { col: number; row: number };
  end: { col: number; row: number };
}

/** "B2:B9", "Sheet1!B2:B9" or "'My sheet'!B2" → a range on a sheet (defaultSheet when none is named). */
export function parseRange(ref: string, defaultSheet: string): RangeRef {
  const text = ref.trim();
  let sheet = defaultSheet;
  let cells = text;
  const bang = text.lastIndexOf('!');
  if (bang > 0) {
    sheet = text.slice(0, bang);
    if (sheet.startsWith("'") && sheet.endsWith("'")) sheet = sheet.slice(1, -1).replace(/''/g, "'");
    cells = text.slice(bang + 1);
  }
  const [a, b] = cells.split(':');
  const start = parseCell(a);
  const end = b ? parseCell(b) : start;
  return {
    sheet,
    start: { col: Math.min(start.col, end.col), row: Math.min(start.row, end.row) },
    end: { col: Math.max(start.col, end.col), row: Math.max(start.row, end.row) },
  };
}

function quoteSheet(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

/** Absolute formula reference: 'My sheet'!$B$2:$B$9 */
export function formulaRef(r: RangeRef): string {
  const cell = (c: { col: number; row: number }) => `$${colLetter(c.col)}$${c.row + 1}`;
  const same = r.start.col === r.end.col && r.start.row === r.end.row;
  return `${quoteSheet(r.sheet)}!${cell(r.start)}${same ? '' : `:${cell(r.end)}`}`;
}

/** Point a spec's references at a renamed sheet. */
export function renameSheetInSpec(spec: ChartSpec, from: string, to: string): ChartSpec {
  const fix = (ref: string | undefined) => {
    if (!ref) return ref;
    const r = parseRange(ref, spec.sheet);
    return r.sheet === from ? formulaRef({ ...r, sheet: to }) : ref;
  };
  return {
    ...spec,
    sheet: spec.sheet === from ? to : spec.sheet,
    categories: fix(spec.categories),
    series: spec.series.map((s) => ({ ...s, values: fix(s.values)!, name: s.name && /^\$?[A-Za-z]{1,3}\$?\d+$|!/.test(s.name) ? fix(s.name) : s.name })),
  };
}

// ============================================================================
// Reading and writing the definitions
// ============================================================================

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Chart definitions stored in a workbook package (none when it has no Claudia charts). */
export async function readChartSpecs(zip: JSZip): Promise<ChartSpec[]> {
  for (const name of Object.keys(zip.files)) {
    if (!/^customXml\/[^/]+\.xml$/i.test(name)) continue;
    const xml = await zip.file(name)!.async('string');
    if (!xml.includes(SPEC_NS)) continue;
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const json = doc.documentElement?.textContent ?? '';
    try {
      const parsed = JSON.parse(json);
      return Array.isArray(parsed?.charts) ? parsed.charts : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Package content an ExcelJS round trip would drop, described for the user. */
export async function unsupportedContent(zip: JSZip, specs: ChartSpec[]): Promise<string[]> {
  const names = Object.keys(zip.files);
  const found: string[] = [];
  const charts = names.filter((n) => /^xl\/charts\/chart\d*\.xml$/i.test(n)).length;
  if (charts > specs.length) found.push('charts');
  if (names.some((n) => n.startsWith('xl/pivotTables/'))) found.push('pivot tables');
  if (names.some((n) => /^xl\/vbaProject\.bin$/i.test(n))) found.push('macros');
  if (names.some((n) => n.startsWith('xl/slicers/'))) found.push('slicers');
  return found;
}

// ============================================================================
// Chart XML
// ============================================================================

/** Values of a range, for the chart's cached data (undefined when they aren't known yet). */
export type RangeValues = (ref: RangeRef) => Array<string | number | null> | undefined;

const C_NS = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function richText(text: string, size?: number): string {
  const sz = size ? ` sz="${size * 100}"` : '';
  return `<c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr${sz} b="1"/></a:pPr><a:r><a:rPr lang="en-US"${sz} b="1"/><a:t>${escapeXml(text)}</a:t></a:r></a:p></c:rich></c:tx>`;
}

function titleXml(text: string | undefined, size: number): string {
  return text ? `<c:title>${richText(text, size)}<c:overlay val="0"/></c:title>` : '';
}

function strCache(values: Array<string | number | null>): string {
  const pts = values.map((v, i) => (v === null || v === '' ? '' : `<c:pt idx="${i}"><c:v>${escapeXml(String(v))}</c:v></c:pt>`)).join('');
  return `<c:strCache><c:ptCount val="${values.length}"/>${pts}</c:strCache>`;
}

function numCache(values: Array<string | number | null>): string {
  const pts = values.map((v, i) => (typeof v === 'number' ? `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>` : '')).join('');
  return `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>${pts}</c:numCache>`;
}

function strRef(ref: RangeRef, values: RangeValues): string {
  const v = values(ref);
  return `<c:strRef><c:f>${escapeXml(formulaRef(ref))}</c:f>${v ? strCache(v) : ''}</c:strRef>`;
}

function numRef(ref: RangeRef, values: RangeValues): string {
  const v = values(ref);
  const numeric = v && v.every((x) => x === null || typeof x === 'number');
  return `<c:numRef><c:f>${escapeXml(formulaRef(ref))}</c:f>${numeric ? numCache(v!) : ''}</c:numRef>`;
}

/** Category axis data: text labels as strings, numbers (years, x values) as numbers. */
function catRef(ref: RangeRef, values: RangeValues): string {
  const v = values(ref);
  if (v && v.length && v.every((x) => x === null || typeof x === 'number')) return numRef(ref, values);
  return strRef(ref, values);
}

function seriesName(name: string | undefined, sheet: string, values: RangeValues, index: number): string {
  if (!name) return `<c:tx><c:v>${escapeXml(`Series ${index + 1}`)}</c:v></c:tx>`;
  if (/^(?:'[^']+'|[^!]+)!\$?[A-Za-z]{1,3}\$?\d+$|^\$?[A-Za-z]{1,3}\$?\d+$/.test(name)) {
    return `<c:tx>${strRef(parseRange(name, sheet), values)}</c:tx>`;
  }
  return `<c:tx><c:v>${escapeXml(name)}</c:v></c:tx>`;
}

function dataLabelsXml(type: ChartType): string {
  const pie = type === 'pie' || type === 'doughnut';
  return (
    '<c:dLbls><c:showLegendKey val="0"/>' +
    `<c:showVal val="${pie ? 0 : 1}"/><c:showCatName val="0"/><c:showSerName val="0"/>` +
    `<c:showPercent val="${pie ? 1 : 0}"/><c:showBubbleSize val="0"/></c:dLbls>`
  );
}

const LEGEND_POS: Record<LegendPosition, string> = { right: 'r', bottom: 'b', top: 't', left: 'l', none: '' };

function axisXml(kind: 'cat' | 'val', id: number, cross: number, pos: string, title?: string, gridlines = false): string {
  const head =
    `<c:axId val="${id}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/>` +
    `<c:axPos val="${pos}"/>${gridlines ? '<c:majorGridlines/>' : ''}${titleXml(title, 10)}` +
    `<c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/>` +
    `<c:tickLblPos val="nextTo"/><c:crossAx val="${cross}"/><c:crosses val="autoZero"/>`;
  return kind === 'cat'
    ? `<c:catAx>${head}<c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`
    : `<c:valAx>${head}<c:crossBetween val="between"/></c:valAx>`;
}

/** The chart part (xl/charts/chartN.xml) for one definition. */
export function chartXml(spec: ChartSpec, values: RangeValues): string {
  const cat = spec.categories ? parseRange(spec.categories, spec.sheet) : undefined;
  const pie = spec.type === 'pie' || spec.type === 'doughnut';
  const series = (pie ? spec.series.slice(0, 1) : spec.series).map((s, i) => {
    const head = `<c:idx val="${i}"/><c:order val="${i}"/>${seriesName(s.name, spec.sheet, values, i)}`;
    const val = parseRange(s.values, spec.sheet);
    switch (spec.type) {
      case 'column':
      case 'bar':
        return `<c:ser>${head}<c:invertIfNegative val="0"/>${cat ? `<c:cat>${catRef(cat, values)}</c:cat>` : ''}<c:val>${numRef(val, values)}</c:val></c:ser>`;
      case 'line':
        return `<c:ser>${head}<c:marker><c:symbol val="circle"/><c:size val="5"/></c:marker>${cat ? `<c:cat>${catRef(cat, values)}</c:cat>` : ''}<c:val>${numRef(val, values)}</c:val><c:smooth val="0"/></c:ser>`;
      case 'area':
        return `<c:ser>${head}${cat ? `<c:cat>${catRef(cat, values)}</c:cat>` : ''}<c:val>${numRef(val, values)}</c:val></c:ser>`;
      case 'pie':
      case 'doughnut':
        return `<c:ser>${head}${cat ? `<c:cat>${catRef(cat, values)}</c:cat>` : ''}<c:val>${numRef(val, values)}</c:val></c:ser>`;
      case 'scatter':
        return `<c:ser>${head}<c:spPr><a:ln w="19050"><a:noFill/></a:ln></c:spPr><c:marker><c:symbol val="circle"/><c:size val="6"/></c:marker>${cat ? `<c:xVal>${numRef(cat, values)}</c:xVal>` : ''}<c:yVal>${numRef(val, values)}</c:yVal><c:smooth val="0"/></c:ser>`;
    }
  });
  const labels = spec.dataLabels ? dataLabelsXml(spec.type) : '';
  const ax = '<c:axId val="500000001"/><c:axId val="500000002"/>';
  const grouping = spec.stacked ? 'stacked' : spec.type === 'column' || spec.type === 'bar' ? 'clustered' : 'standard';

  let plot: string;
  switch (spec.type) {
    case 'column':
    case 'bar': {
      const horizontal = spec.type === 'bar';
      plot =
        `<c:barChart><c:barDir val="${horizontal ? 'bar' : 'col'}"/><c:grouping val="${grouping}"/><c:varyColors val="0"/>` +
        `${series.join('')}${labels}<c:gapWidth val="150"/>${spec.stacked ? '<c:overlap val="100"/>' : ''}${ax}</c:barChart>` +
        axisXml('cat', 500000001, 500000002, horizontal ? 'l' : 'b', horizontal ? spec.yAxisTitle : spec.xAxisTitle) +
        axisXml('val', 500000002, 500000001, horizontal ? 'b' : 'l', horizontal ? spec.xAxisTitle : spec.yAxisTitle, true);
      break;
    }
    case 'line':
      plot =
        `<c:lineChart><c:grouping val="${grouping}"/><c:varyColors val="0"/>${series.join('')}${labels}<c:marker val="1"/>${ax}</c:lineChart>` +
        axisXml('cat', 500000001, 500000002, 'b', spec.xAxisTitle) +
        axisXml('val', 500000002, 500000001, 'l', spec.yAxisTitle, true);
      break;
    case 'area':
      plot =
        `<c:areaChart><c:grouping val="${grouping}"/><c:varyColors val="0"/>${series.join('')}${labels}${ax}</c:areaChart>` +
        axisXml('cat', 500000001, 500000002, 'b', spec.xAxisTitle) +
        axisXml('val', 500000002, 500000001, 'l', spec.yAxisTitle, true);
      break;
    case 'pie':
      plot = `<c:pieChart><c:varyColors val="1"/>${series.join('')}${labels}<c:firstSliceAng val="0"/></c:pieChart>`;
      break;
    case 'doughnut':
      plot = `<c:doughnutChart><c:varyColors val="1"/>${series.join('')}${labels}<c:firstSliceAng val="0"/><c:holeSize val="50"/></c:doughnutChart>`;
      break;
    case 'scatter':
      plot =
        `<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>${series.join('')}${labels}${ax}</c:scatterChart>` +
        `<c:valAx><c:axId val="500000001"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/>${titleXml(spec.xAxisTitle, 10)}` +
        `<c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>` +
        `<c:crossAx val="500000002"/><c:crosses val="autoZero"/><c:crossBetween val="midCat"/></c:valAx>` +
        axisXml('val', 500000002, 500000001, 'l', spec.yAxisTitle, true);
      break;
  }

  const legend =
    spec.legend === 'none' ? '' : `<c:legend><c:legendPos val="${LEGEND_POS[spec.legend]}"/><c:overlay val="0"/></c:legend>`;
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<c:chartSpace xmlns:c="${C_NS}" xmlns:a="${A_NS}" xmlns:r="${R_NS}">` +
    `<c:roundedCorners val="0"/><c:chart>${titleXml(spec.title, 14)}<c:autoTitleDeleted val="${spec.title ? 0 : 1}"/>` +
    `<c:plotArea><c:layout/>${plot}</c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>` +
    `</c:chartSpace>`
  );
}

function anchorXml(spec: ChartSpec, relId: string, shapeId: number): string {
  const from = parseCell(spec.anchor);
  const to = { col: from.col + spec.widthCols, row: from.row + spec.heightRows };
  const point = (tag: string, p: { col: number; row: number }) =>
    `<xdr:${tag}><xdr:col>${p.col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${p.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:${tag}>`;
  return (
    `<xdr:twoCellAnchor editAs="oneCell">${point('from', from)}${point('to', to)}` +
    `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${shapeId}" name="${escapeXml(spec.title || `Chart ${shapeId}`)}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>` +
    `<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>` +
    `<a:graphic><a:graphicData uri="${C_NS}"><c:chart xmlns:c="${C_NS}" xmlns:r="${R_NS}" r:id="${relId}"/></a:graphicData></a:graphic>` +
    `</xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`
  );
}

// ============================================================================
// Package surgery
// ============================================================================

const REL_DRAWING = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing';
const REL_CHART = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart';
const REL_CUSTOM_XML = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml';
const CT_CHART = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';
const CT_DRAWING = 'application/vnd.openxmlformats-officedocument.drawing+xml';
const EMPTY_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';

function relsPath(part: string): string {
  const slash = part.lastIndexOf('/');
  return `${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`;
}

/** Resolve a relationship target against the part that holds it. */
function resolveTarget(fromPart: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = fromPart.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

function addRelationship(rels: string, id: string, type: string, target: string): string {
  return rels.replace('</Relationships>', `<Relationship Id="${id}" Type="${type}" Target="${target}"/></Relationships>`);
}

function addOverride(types: string, partName: string, contentType: string): string {
  if (types.includes(`PartName="/${partName}"`)) return types;
  return types.replace('</Types>', `<Override PartName="/${partName}" ContentType="${contentType}"/></Types>`);
}

function freeName(zip: JSZip, dir: string, base: string): string {
  for (let i = 1; ; i++) {
    const name = `${dir}/${base}${i}.xml`;
    if (!zip.file(name)) return name;
  }
}

/** Sheet name → its part ("xl/worksheets/sheet2.xml"). */
async function sheetParts(zip: JSZip): Promise<Map<string, string>> {
  const parser = new DOMParser();
  const wb = parser.parseFromString(await zip.file('xl/workbook.xml')!.async('string'), 'text/xml');
  const rels = parser.parseFromString(await zip.file('xl/_rels/workbook.xml.rels')!.async('string'), 'text/xml');
  const targets = new Map<string, string>();
  const relEls = rels.getElementsByTagName('Relationship');
  for (let i = 0; i < relEls.length; i++) {
    const r = relEls[i];
    targets.set(r.getAttribute('Id') ?? '', resolveTarget('xl/workbook.xml', r.getAttribute('Target') ?? ''));
  }
  const out = new Map<string, string>();
  const sheets = wb.getElementsByTagName('sheet');
  for (let i = 0; i < sheets.length; i++) {
    const s = sheets[i];
    const rid = s.getAttribute('r:id') ?? s.getAttributeNS(R_NS, 'id') ?? '';
    const target = targets.get(rid);
    if (target) out.set(s.getAttribute('name') ?? '', target);
  }
  return out;
}

/** Worksheet children that must come after <drawing> (CT_Worksheet order). */
const AFTER_DRAWING = ['legacyDrawing', 'legacyDrawingHF', 'drawingHF', 'picture', 'oleObjects', 'controls', 'webPublishItems', 'tableParts', 'extLst'];

function insertDrawingElement(sheetXml: string, relId: string): string {
  const el = `<drawing r:id="${relId}"/>`;
  let at = -1;
  for (const tag of AFTER_DRAWING) {
    const i = sheetXml.search(new RegExp(`<${tag}[\\s/>]`));
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) at = sheetXml.lastIndexOf('</worksheet>');
  let xml = sheetXml.slice(0, at) + el + sheetXml.slice(at);
  // The r: prefix must be declared on the worksheet element
  if (!/<worksheet[^>]*xmlns:r=/.test(xml)) xml = xml.replace(/<worksheet\b/, `<worksheet xmlns:r="${R_NS}"`);
  return xml;
}

/**
 * Write the charts into a package ExcelJS just produced (which has none), and
 * store their definitions so the next edit can write them again.
 */
export async function writeCharts(xlsx: Buffer, specs: ChartSpec[], values: RangeValues): Promise<Buffer> {
  const zip = await JSZip.loadAsync(xlsx);
  let types = await zip.file('[Content_Types].xml')!.async('string');
  const sheets = await sheetParts(zip);
  const live = specs.filter((s) => sheets.has(s.sheet));

  const bySheet = new Map<string, ChartSpec[]>();
  for (const spec of live) bySheet.set(spec.sheet, [...(bySheet.get(spec.sheet) ?? []), spec]);

  let shapeId = 1000;
  for (const [sheetName, charts] of bySheet) {
    const sheetPart = sheets.get(sheetName)!;
    const sheetRelsPath = relsPath(sheetPart);
    let sheetRels = (await zip.file(sheetRelsPath)?.async('string')) ?? EMPTY_RELS;
    let sheetXml = await zip.file(sheetPart)!.async('string');

    // Reuse the sheet's drawing (ExcelJS writes one for images), or start one
    let drawingPart: string;
    let drawingXml: string;
    const existing = /<drawing r:id="([^"]+)"/.exec(sheetXml);
    const existingTarget = existing && new RegExp(`Id="${existing[1]}"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Id="${existing[1]}"`).exec(sheetRels);
    if (existing && existingTarget) {
      drawingPart = resolveTarget(sheetPart, existingTarget[1] ?? existingTarget[2]);
      drawingXml = await zip.file(drawingPart)!.async('string');
    } else {
      drawingPart = freeName(zip, 'xl/drawings', 'drawing');
      drawingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="${A_NS}"></xdr:wsDr>`;
      const relId = 'rIdClaudiaDrawing';
      sheetRels = addRelationship(sheetRels, relId, REL_DRAWING, `../drawings/${drawingPart.split('/').pop()}`);
      sheetXml = insertDrawingElement(sheetXml, relId);
      types = addOverride(types, drawingPart, CT_DRAWING);
    }
    const drawingRelsPath = relsPath(drawingPart);
    let drawingRels = (await zip.file(drawingRelsPath)?.async('string')) ?? EMPTY_RELS;

    const anchors: string[] = [];
    charts.forEach((spec, i) => {
      const chartPart = freeName(zip, 'xl/charts', 'chart');
      zip.file(chartPart, chartXml(spec, values));
      types = addOverride(types, chartPart, CT_CHART);
      const relId = `rIdClaudiaChart${i + 1}`;
      drawingRels = addRelationship(drawingRels, relId, REL_CHART, `../charts/${chartPart.split('/').pop()}`);
      anchors.push(anchorXml(spec, relId, ++shapeId));
    });
    if (!drawingXml.includes('xmlns:a=')) drawingXml = drawingXml.replace(/<xdr:wsDr\b/, `<xdr:wsDr xmlns:a="${A_NS}"`);
    drawingXml = drawingXml.replace('</xdr:wsDr>', `${anchors.join('')}</xdr:wsDr>`);

    zip.file(drawingPart, drawingXml);
    zip.file(drawingRelsPath, drawingRels);
    zip.file(sheetPart, sheetXml);
    zip.file(sheetRelsPath, sheetRels);
  }

  // The definitions, for the next edit
  zip.file(
    SPEC_PART,
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<claudiaCharts xmlns="${SPEC_NS}">${escapeXml(JSON.stringify({ version: 1, charts: live }))}</claudiaCharts>`
  );
  types = addOverride(types, SPEC_PART, 'application/xml');
  const wbRels = await zip.file('xl/_rels/workbook.xml.rels')!.async('string');
  if (!wbRels.includes(SPEC_PART)) zip.file('xl/_rels/workbook.xml.rels', addRelationship(wbRels, 'rIdClaudiaCharts', REL_CUSTOM_XML, `../${SPEC_PART}`));
  zip.file('[Content_Types].xml', types);

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
