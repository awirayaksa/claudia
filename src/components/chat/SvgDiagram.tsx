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

/** The drawn size, so the image isn't blown up and its space is kept while it streams in. */
function drawnSize(code: string): { width?: number; height?: number } {
  const root = /<svg[^>]*>/i.exec(code)?.[0] ?? '';
  const box = /\sviewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(root);
  const width = Number(/\swidth="(\d+(?:\.\d+)?)(?:px)?"/i.exec(root)?.[1] ?? box?.[1]) || undefined;
  const height = Number(/\sheight="(\d+(?:\.\d+)?)(?:px)?"/i.exec(root)?.[1] ?? box?.[2]) || undefined;
  return { width, height };
}

interface SvgDiagramProps {
  code: string;
  isDark: boolean;
  /** The code block, shown on request or when the image can't be drawn. */
  fallback: React.ReactNode;
}

export function SvgDiagram({ code, isDark, fallback }: SvgDiagramProps) {
  const t = useT();
  const url = useMemo(() => svgUrl(code), [code]);
  const [failed, setFailed] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);

  if (url && failed === url) return <>{fallback}</>;
  if (showSource) {
    return (
      <div>
        {fallback}
        <button className="mt-1 text-xs text-text-secondary hover:text-text-primary" onClick={() => setShowSource(false)}>
          {t('mermaid.showDiagram', 'Show diagram')}
        </button>
      </div>
    );
  }

  const { width, height } = drawnSize(code);
  const title = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(code)?.[1]?.trim();
  return (
    // Models draw for a light page: in the dark theme the image gets a light card
    <figure
      className={`my-2 overflow-x-auto whitespace-normal rounded-md p-3 font-sans ${isDark ? 'bg-white' : 'border border-border bg-background'}`}
      data-testid="svg-diagram"
    >
      {url ? (
        <img
          src={url}
          alt={title || t('mermaid.diagram', 'Diagram')}
          className="mx-auto block h-auto w-full"
          style={{ maxWidth: width }}
          onError={() => setFailed(url)}
        />
      ) : (
        // Still streaming: the code is drawn once it's whole
        <div
          className={`mx-auto flex w-full animate-pulse items-center justify-center rounded text-xs ${isDark ? 'bg-neutral-100 text-neutral-500' : 'bg-surface text-text-secondary'}`}
          style={{ maxWidth: width, aspectRatio: width && height ? `${width} / ${height}` : '680 / 240' }}
          data-testid="svg-diagram-pending"
        >
          {t('mermaid.drawing', 'Drawing diagram…')}
        </div>
      )}
      <button
        className={`mt-1 text-xs ${isDark ? 'text-neutral-500 hover:text-neutral-800' : 'text-text-secondary hover:text-text-primary'}`}
        onClick={() => setShowSource(true)}
      >
        {t('mermaid.showSource', 'Show source')}
      </button>
    </figure>
  );
}
