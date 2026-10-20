import { useMemo, useState } from 'react';
import { useT } from '../../i18n';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** An ```svg block, or an ```xml one that holds an SVG image. */
export function isSvgBlock(language: string, code: string): boolean {
  const lang = language.toLowerCase();
  return lang === 'svg' || (lang === 'xml' && /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(code));
}

/**
 * The image's URL, or null while the code isn't a whole SVG yet (still
 * streaming). Loaded as an image, the SVG can't run scripts or fetch anything.
 */
function svgUrl(code: string): string | null {
  if (!/<svg[\s>]/i.test(code) || !/<\/svg>\s*$/i.test(code)) return null;
  // Images need the namespace, which models often leave out
  const source = /<svg[^>]*\sxmlns=/i.test(code) ? code : code.replace(/<svg(?=[\s>])/i, `<svg xmlns="${SVG_NS}"`);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
}

/** Not wider than drawn, so small images aren't blown up. */
function drawnWidth(code: string): number | undefined {
  const root = /<svg[^>]*>/i.exec(code)?.[0] ?? '';
  const width = /\swidth="(\d+(?:\.\d+)?)(?:px)?"/i.exec(root)?.[1] ?? /\sviewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)/i.exec(root)?.[1];
  return width ? Number(width) : undefined;
}

interface SvgDiagramProps {
  code: string;
  isDark: boolean;
  /** Shown instead while the image can't be drawn (still streaming, or invalid). */
  fallback: React.ReactNode;
}

export function SvgDiagram({ code, isDark, fallback }: SvgDiagramProps) {
  const t = useT();
  const url = useMemo(() => svgUrl(code), [code]);
  const [failed, setFailed] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);

  if (!url || failed === url || showSource) {
    return (
      <div>
        {fallback}
        {url && failed !== url && (
          <button className="mt-1 text-xs text-text-secondary hover:text-text-primary" onClick={() => setShowSource(false)}>
            {t('mermaid.showDiagram', 'Show diagram')}
          </button>
        )}
      </div>
    );
  }

  const title = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(code)?.[1]?.trim();
  return (
    // Models draw for a light page: in the dark theme the image gets a light card
    <figure
      className={`my-2 overflow-x-auto whitespace-normal rounded-md p-3 font-sans ${isDark ? 'bg-white' : 'border border-border bg-background'}`}
      data-testid="svg-diagram"
    >
      <img
        src={url}
        alt={title || t('mermaid.diagram', 'Diagram')}
        className="mx-auto block h-auto w-full"
        style={{ maxWidth: drawnWidth(code) }}
        onError={() => setFailed(url)}
      />
      <button
        className={`mt-1 text-xs ${isDark ? 'text-neutral-500 hover:text-neutral-800' : 'text-text-secondary hover:text-text-primary'}`}
        onClick={() => setShowSource(true)}
      >
        {t('mermaid.showSource', 'Show source')}
      </button>
    </figure>
  );
}
