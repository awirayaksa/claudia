// @vitest-environment jsdom
/**
 * Math (KaTeX) and diagrams (Mermaid) in the shared markdown renderer.
 * jsdom can't lay out SVG, so mermaid itself is replaced by a stub that
 * records how it was set up.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { createAppStore } from '../../store';
import { MarkdownRenderer } from './MarkdownRenderer';

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  parse: vi.fn(async (code: string) => code.trim().startsWith('graph')),
  render: vi.fn(async (_id: string, code: string) => ({ svg: `<svg data-src="${code.length}"><g><text>diagram</text></g></svg>` })),
}));
vi.mock('mermaid', () => ({ default: mermaid }));

beforeAll(() => {
  window.matchMedia ??= ((query: string) =>
    ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
});

function renderMarkdown(content: string) {
  return render(
    <Provider store={createAppStore({})}>
      <MarkdownRenderer content={content} />
    </Provider>
  );
}

describe('MarkdownRenderer math', () => {
  it('renders inline and display math with KaTeX', () => {
    const { container } = renderMarkdown('Energy: $E=mc^2$\n\n\\[\n\\frac{a}{b}\n\\]');
    const inline = container.querySelectorAll('.katex');
    expect(inline.length).toBe(2);
    expect(container.querySelector('.katex-display')).not.toBeNull();
    // MathML copy for screen readers
    expect(container.querySelector('math annotation')?.textContent).toBe('E=mc^2');
    expect(container.querySelector('.katex-display annotation')?.textContent).toBe('\\frac{a}{b}');
  });

  it('keeps prices as text', () => {
    const { container } = renderMarkdown('It costs $5 and $10.');
    expect(container.querySelector('.katex')).toBeNull();
    expect(container.textContent).toBe('It costs $5 and $10.');
  });

  it('leaves math in code alone', () => {
    const { container } = renderMarkdown('Use `$x$` literally');
    expect(container.querySelector('.katex')).toBeNull();
    expect(container.querySelector('code')?.textContent).toBe('$x$');
  });

  it('does not allow \\href links or HTML from math', () => {
    const { container } = renderMarkdown('$\\href{javascript:alert(1)}{click}$ and $\\htmlId{x}{y}$');
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('#x')).toBeNull();
  });

  it('matches the snapshot of a formula', () => {
    const { container } = renderMarkdown('$$\na^2+b^2=c^2\n$$');
    expect(container.querySelector('.katex-display')?.outerHTML).toMatchSnapshot();
  });
});

describe('MarkdownRenderer mermaid', () => {
  it('loads mermaid lazily in strict mode and shows the diagram', async () => {
    renderMarkdown('```mermaid\ngraph TD; A-->B\n```');
    expect(await screen.findByTestId('mermaid-diagram', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: 'strict', startOnLoad: false }));
    expect(mermaid.render).toHaveBeenCalledWith(expect.stringMatching(/^mermaid-/), 'graph TD; A-->B');
  });

  it('shows the source while the diagram does not parse (still streaming)', async () => {
    mermaid.render.mockClear();
    const { container } = renderMarkdown('```mermaid\nflowchart oops\n```');
    await waitFor(() => expect(mermaid.parse).toHaveBeenCalledWith('flowchart oops', { suppressErrors: true }));
    expect(container.querySelector('[data-testid="mermaid-diagram"]')).toBeNull();
    expect(container.textContent).toContain('flowchart oops');
    expect(mermaid.render).not.toHaveBeenCalled();
  });
});

describe('MarkdownRenderer svg', () => {
  it('shows an svg block as an image, adding the namespace models leave out', () => {
    const { container } = renderMarkdown('```svg\n<svg viewBox="0 0 680 240"><title>Merge</title><circle r="5"/></svg>\n```');
    const img = container.querySelector('[data-testid="svg-diagram"] img') as HTMLImageElement;
    expect(img.alt).toBe('Merge');
    expect(img.style.maxWidth).toBe('680px');
    expect(decodeURIComponent(img.src)).toContain('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 680 240">');
  });

  it('recognizes svg in an xml block', () => {
    const { container } = renderMarkdown('```xml\n<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>\n```');
    expect(container.querySelector('[data-testid="svg-diagram"]')).not.toBeNull();
  });

  it('keeps the space for the image while the svg is incomplete (still streaming), with the source on request', () => {
    const { container } = renderMarkdown('```svg\n<svg viewBox="0 0 680 200"><circle r="5"/>\n```');
    const pending = container.querySelector('[data-testid="svg-diagram-pending"]') as HTMLElement;
    expect(pending.style.aspectRatio).toBe('680 / 200');
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).not.toContain('<circle r="5"/>');

    fireEvent.click(within(container).getByText('Show source'));
    expect(container.textContent).toContain('<circle r="5"/>');
  });

  it('shows the source when the svg is whole but not an image', () => {
    const { container } = renderMarkdown('```svg\n<svg viewBox="0 0 10 10"><oops</svg>\n```');
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('[data-testid="svg-diagram"]')).toBeNull();
    expect(container.textContent).toContain('<oops</svg>');
  });
});

describe('MarkdownRenderer citations', () => {
  it('turns [n] of known sources into buttons that report the number', async () => {
    const picked: number[] = [];
    const { container } = render(
      <Provider store={createAppStore({})}>
        <MarkdownRenderer content="Twenty-five days [1][2], see `a[1]`." citations={new Set([1, 2])} onCitation={(n) => picked.push(n)} />
      </Provider>
    );
    const links = container.querySelectorAll('[data-testid="citation-link"]');
    expect([...links].map((l) => l.textContent)).toEqual(['1', '2']);
    (links[1] as HTMLButtonElement).click();
    expect(picked).toEqual([2]);
    expect(container.querySelector('code')?.textContent).toBe('a[1]');
  });
});
