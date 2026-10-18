import React, { useMemo, ReactNode } from 'react';
import ReactMarkdown, { type Options as MarkdownOptions } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useAppSelector } from '../../store';
import { getPluginRenderConfig } from '../../services/plugins/plugin-renderer.service';
import { RenderContext } from '../../types/plugin.types';
import { Message } from '../../types/message.types';
import { normalizeMath } from '../../utils/math-delimiters';
import { citationIndex, linkCitations } from '../../utils/citations';
import { MermaidDiagram } from './MermaidDiagram';
import { useT } from '../../i18n';

// Single-dollar math is off so prices stay text; normalizeMath turns $x$, \(x\) and \[x\] into $$
const MATH_OPTIONS = { singleDollarTextMath: false };
// No \href, \url, \htmlClass etc. (trust: false); bad input renders as an error instead of throwing
const KATEX_OPTIONS = { trust: false, strict: 'ignore', throwOnError: false, output: 'htmlAndMathml' } as const;

interface MarkdownRendererProps {
  content: string;
  isUser?: boolean;
  message?: Message;
  /** Source numbers that exist: "[n]" for them becomes a citation chip. */
  citations?: ReadonlySet<number>;
  onCitation?: (index: number) => void;
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = React.memo(({ content, isUser = false, message, citations, onCitation }) => {
  const t = useT();
  const { theme } = useAppSelector((state) => state.settings.appearance);
  const { activeExtensions, activeReplacement } = useAppSelector((state) => state.plugins);

  // Determine if we should use dark or light theme for code blocks
  const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const codeTheme = isDark ? oneDark : oneLight;

  // Build render context for plugins
  const renderContext: RenderContext = useMemo(() => ({
    theme,
    isDark,
    message,
    pluginSettings: {},
  }), [theme, isDark, message]);

  // Get plugin configuration
  const pluginConfig = useMemo(() => getPluginRenderConfig(), [activeExtensions, activeReplacement]);

  // Check if we should use a replacement renderer
  if (pluginConfig.ReplacementRenderer && message) {
    if (pluginConfig.canUseReplacement(message, renderContext)) {
      const ReplacementRenderer = pluginConfig.ReplacementRenderer;
      return (
        <ReplacementRenderer
          content={content}
          isUser={isUser}
          message={message}
          context={renderContext}
        />
      );
    }
  }

  // Apply pre-processing from plugins
  const preprocessed = normalizeMath(pluginConfig.preProcess(content, renderContext));
  const processedContent = citations?.size ? linkCitations(preprocessed, citations) : preprocessed;

  // Merge remark plugins
  const remarkPlugins: MarkdownOptions['remarkPlugins'] = [remarkGfm, [remarkMath, MATH_OPTIONS], ...pluginConfig.remarkPlugins];
  const rehypePlugins: MarkdownOptions['rehypePlugins'] = [[rehypeKatex, KATEX_OPTIONS], ...pluginConfig.rehypePlugins];

  // Auto-incrementing counter for h2 headings (accent numeral prefix)
  let h2Counter = 0;

  // Default components
  const defaultComponents = {
        // Code blocks
        code({ node, inline, className, children, ...props }: { node?: unknown; inline?: boolean; className?: string; children?: ReactNode; [key: string]: unknown }) {
          const match = /language-(\w+)/.exec(className || '');
          const language = match ? match[1] : '';

          const source = String(children).replace(/\n$/, '');
          const codeBlock = !inline && language ? (
            <div className="my-2 overflow-hidden rounded-md">
              <div className="flex items-center justify-between bg-surface-hover px-3 py-1.5">
                <span className="text-xs font-medium text-text-secondary">{language}</span>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(source);
                  }}
                  className="text-xs text-text-secondary hover:text-text-primary transition-colors"
                >
                  {t('common.copy', 'Copy')}
                </button>
              </div>
              <SyntaxHighlighter
                style={codeTheme}
                language={language}
                PreTag="div"
                customStyle={{
                  margin: 0,
                  borderRadius: 0,
                  fontSize: '0.875rem',
                  background: isDark ? '#282c34' : '#fafafa',
                }}
                {...props}
              >
                {source}
              </SyntaxHighlighter>
            </div>
          ) : null;

          if (codeBlock && language === 'mermaid') {
            return <MermaidDiagram code={source} isDark={isDark} fallback={codeBlock} />;
          }
          return codeBlock ?? (
            <code
              className={`rounded px-1.5 py-0.5 text-xs font-mono ${
                isUser
                  ? 'bg-white bg-opacity-20'
                  : 'bg-surface text-accent'
              }`}
              {...props}
            >
              {children}
            </code>
          );
        },
        // Paragraphs
        p({ children }: { children?: ReactNode }) {
          return <p className="mb-2 last:mb-0">{children}</p>;
        },
        // Lists
        ul({ children }: { children?: ReactNode }) {
          return <ul className="mb-2 ml-4 list-disc space-y-1">{children}</ul>;
        },
        ol({ children }: { children?: ReactNode }) {
          return <ol className="mb-2 ml-4 list-decimal space-y-1">{children}</ol>;
        },
        li({ children }: { children?: ReactNode }) {
          return <li className="text-sm">{children}</li>;
        },
        // Headings
        h1({ children }: { children?: ReactNode }) {
          return (
            <h1 className={`mb-2 mt-4 text-xl font-bold first:mt-0 ${isUser ? 'text-white' : 'text-text-primary'}`}>
              {children}
            </h1>
          );
        },
        h2({ children }: { children?: ReactNode }) {
          if (isUser) {
            return (
              <h2 className="mb-2 mt-3 text-lg font-bold first:mt-0 text-white">
                {children}
              </h2>
            );
          }
          h2Counter += 1;
          const num = String(h2Counter).padStart(2, '0');
          return (
            <h2 className="mb-2 mt-8 text-base font-semibold first:mt-0 text-text-primary flex items-baseline gap-2.5">
              <span className="text-xs font-bold text-accent flex-shrink-0">{num}</span>
              <span>{children}</span>
            </h2>
          );
        },
        h3({ children }: { children?: ReactNode }) {
          return (
            <h3 className={`mb-2 mt-3 text-base font-bold first:mt-0 ${isUser ? 'text-white' : 'text-text-primary'}`}>
              {children}
            </h3>
          );
        },
        h4({ children }: { children?: ReactNode }) {
          return (
            <h4 className={`mb-2 mt-2 text-sm font-bold first:mt-0 ${isUser ? 'text-white' : 'text-text-primary'}`}>
              {children}
            </h4>
          );
        },
        // Links
        a({ href, children }: { href?: string; children?: ReactNode }) {
          const cite = citationIndex(href);
          if (cite !== null) {
            return (
              <button
                type="button"
                className="mx-0.5 inline-flex h-4 min-w-4 -translate-y-0.5 items-center justify-center rounded-full bg-accent/15 px-1 align-baseline text-[10px] font-semibold leading-none text-accent hover:bg-accent hover:text-white"
                onClick={() => onCitation?.(cite)}
                aria-label={t('citations.source', 'Source {{n}}', { n: cite })}
                data-testid="citation-link"
              >
                {cite}
              </button>
            );
          }
          return (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className={`underline hover:no-underline ${
                isUser ? 'text-white' : 'text-accent'
              }`}
            >
              {children}
            </a>
          );
        },
        // Blockquotes
        blockquote({ children }: { children?: ReactNode }) {
          return (
            <blockquote
              className={`my-2 border-l-4 pl-4 italic ${
                isUser
                  ? 'border-white border-opacity-40 text-white text-opacity-90'
                  : 'border-border text-text-secondary'
              }`}
            >
              {children}
            </blockquote>
          );
        },
        // Tables
        table({ children }: { children?: ReactNode }) {
          return (
            <div className="my-2 overflow-x-auto">
              <table className="min-w-full divide-y divide-border">
                {children}
              </table>
            </div>
          );
        },
        thead({ children }: { children?: ReactNode }) {
          return (
            <thead className={isUser ? 'bg-white bg-opacity-10' : 'bg-surface'}>
              {children}
            </thead>
          );
        },
        tbody({ children }: { children?: ReactNode }) {
          return <tbody className="divide-y divide-border">{children}</tbody>;
        },
        tr({ children }: { children?: ReactNode }) {
          return <tr>{children}</tr>;
        },
        th({ children }: { children?: ReactNode }) {
          return (
            <th
              className={`px-3 py-2 text-left text-xs font-semibold ${
                isUser ? 'text-white' : 'text-text-primary'
              }`}
            >
              {children}
            </th>
          );
        },
        td({ children }: { children?: ReactNode }) {
          return (
            <td
              className={`px-3 py-2 text-sm ${
                isUser ? 'text-white' : 'text-text-primary'
              }`}
            >
              {children}
            </td>
          );
        },
        // Horizontal rule
        hr() {
          return (
            <hr
              className={`my-4 ${
                isUser ? 'border-white border-opacity-30' : 'border-border'
              }`}
            />
          );
        },
        // Strong (bold)
        strong({ children }: { children?: ReactNode }) {
          return <strong className="font-bold">{children}</strong>;
        },
        // Emphasis (italic)
        em({ children }: { children?: ReactNode }) {
          return <em className="italic">{children}</em>;
        },
  };

  // Merge default components with plugin components
  // Plugin components override defaults
  const mergedComponents = {
    ...defaultComponents,
    ...pluginConfig.components,
  };

  // Render markdown
  const rendered = (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={mergedComponents as any}
    >
      {processedContent}
    </ReactMarkdown>
  );

  // Apply post-processing from plugins
  return <>{pluginConfig.postProcess(rendered, renderContext)}</>;
}, (prevProps, nextProps) => {
  // Custom comparison: only re-render if content, isUser, or message.id changes
  return prevProps.content === nextProps.content &&
         prevProps.isUser === nextProps.isUser &&
         prevProps.message?.id === nextProps.message?.id;
});

MarkdownRenderer.displayName = 'MarkdownRenderer';
