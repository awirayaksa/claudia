import { useEffect, useId, useState } from 'react';
import { useT } from '../../i18n';

type MermaidApi = typeof import('mermaid').default;

let loader: Promise<MermaidApi> | null = null;

/** Mermaid is large, so it loads the first time a diagram is shown. */
function loadMermaid(): Promise<MermaidApi> {
  loader ??= import('mermaid').then((m) => m.default);
  return loader;
}

/** Renders one at a time: mermaid keeps global state while it lays out a diagram. */
let queue: Promise<unknown> = Promise.resolve();

async function renderDiagram(id: string, code: string, dark: boolean): Promise<string | null> {
  const run = queue.then(async () => {
    const mermaid = await loadMermaid();
    mermaid.initialize({
      startOnLoad: false,
      // Labels are sanitized and click handlers and scripts are disabled
      securityLevel: 'strict',
      theme: dark ? 'dark' : 'default',
    });
    // Partial diagrams (still streaming) and mistakes: show the source instead
    if (!(await mermaid.parse(code, { suppressErrors: true }))) return null;
    const { svg } = await mermaid.render(id, code);
    return svg;
  });
  queue = run.catch(() => undefined);
  return run;
}

interface MermaidDiagramProps {
  code: string;
  isDark: boolean;
  /** Shown instead while the diagram can't be drawn (still streaming, or invalid). */
  fallback: React.ReactNode;
}

export function MermaidDiagram({ code, isDark, fallback }: MermaidDiagramProps) {
  const t = useT();
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Wait for the text to settle while a reply streams in
    const timer = setTimeout(() => {
      renderDiagram(id, code, isDark)
        .then((out) => {
          if (!cancelled) setSvg(out);
        })
        .catch(() => {
          if (!cancelled) setSvg(null);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [id, code, isDark]);

  if (!svg || showSource) {
    return (
      <div>
        {fallback}
        {svg && (
          <button
            className="mt-1 text-xs text-text-secondary hover:text-text-primary"
            onClick={() => setShowSource(false)}
          >
            {t('mermaid.showDiagram', 'Show diagram')}
          </button>
        )}
      </div>
    );
  }

  return (
    // Code blocks sit in a <pre>: reset its monospace and white-space for the diagram
    <figure
      className="my-2 overflow-x-auto whitespace-normal rounded-md border border-border bg-background p-3 font-sans"
      data-testid="mermaid-diagram"
    >
      {/* mermaid's own output in strict mode (sanitized labels, no scripts or click handlers) */}
      <div className="flex justify-center [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />
      <button className="mt-1 text-xs text-text-secondary hover:text-text-primary" onClick={() => setShowSource(true)}>
        {t('mermaid.showSource', 'Show source')}
      </button>
    </figure>
  );
}
