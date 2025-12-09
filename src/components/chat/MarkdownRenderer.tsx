import React, { useMemo, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useAppSelector } from '../../store';
import { getPluginRenderConfig } from '../../services/plugins/plugin-renderer.service';
import { RenderContext } from '../../types/plugin.types';
import { Message } from '../../types/message.types';

interface MarkdownRendererProps {
  content: string;
  isUser?: boolean;
  message?: Message;
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = React.memo(({ content, isUser = false, message }) => {
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
  const processedContent = pluginConfig.preProcess(content, renderContext);

  // Merge remark plugins
  const remarkPlugins = [remarkGfm, ...pluginConfig.remarkPlugins];

  // Default components
  const defaultComponents = {
        // Code blocks
        code({ node, inline, className, children, ...props }: { node?: unknown; inline?: boolean; className?: string; children?: ReactNode; [key: string]: unknown }) {
          const match = /language-(\w+)/.exec(className || '');
          const language = match ? match[1] : '';

          return !inline && language ? (
            <div className="my-2 overflow-hidden rounded-md">
              <div className="flex items-center justify-between bg-surface-hover px-3 py-1.5">
                <span className="text-xs font-medium text-text-secondary">{language}</span>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(String(children).replace(/\n$/, ''));
                  }}
                  className="text-xs text-text-secondary hover:text-text-primary transition-colors"
                >
                  Copy
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
                {String(children).replace(/\n$/, '')}
              </SyntaxHighlighter>
            </div>
          ) : (
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
          return (
            <h2 className={`mb-2 mt-3 text-lg font-bold first:mt-0 ${isUser ? 'text-white' : 'text-text-primary'}`}>
              {children}
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
      rehypePlugins={pluginConfig.rehypePlugins}
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
