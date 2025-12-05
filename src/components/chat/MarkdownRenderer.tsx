import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useAppSelector } from '../../store';

interface MarkdownRendererProps {
  content: string;
  isUser?: boolean;
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ content, isUser = false }) => {
  const { theme } = useAppSelector((state) => state.settings.appearance);

  // Determine if we should use dark or light theme for code blocks
  const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const codeTheme = isDark ? oneDark : oneLight;

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        // Code blocks
        code({ node, inline, className, children, ...props }) {
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
        p({ children }) {
          return <p className="mb-2 last:mb-0">{children}</p>;
        },
        // Lists
        ul({ children }) {
          return <ul className="mb-2 ml-4 list-disc space-y-1">{children}</ul>;
        },
        ol({ children }) {
          return <ol className="mb-2 ml-4 list-decimal space-y-1">{children}</ol>;
        },
        li({ children }) {
          return <li className="text-sm">{children}</li>;
        },
        // Headings
        h1({ children }) {
          return (
            <h1 className={`mb-2 mt-4 text-xl font-bold first:mt-0 ${isUser ? 'text-white' : 'text-text-primary'}`}>
              {children}
            </h1>
          );
        },
        h2({ children }) {
          return (
            <h2 className={`mb-2 mt-3 text-lg font-bold first:mt-0 ${isUser ? 'text-white' : 'text-text-primary'}`}>
              {children}
            </h2>
          );
        },
        h3({ children }) {
          return (
            <h3 className={`mb-2 mt-3 text-base font-bold first:mt-0 ${isUser ? 'text-white' : 'text-text-primary'}`}>
              {children}
            </h3>
          );
        },
        h4({ children }) {
          return (
            <h4 className={`mb-2 mt-2 text-sm font-bold first:mt-0 ${isUser ? 'text-white' : 'text-text-primary'}`}>
              {children}
            </h4>
          );
        },
        // Links
        a({ href, children }) {
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
        blockquote({ children }) {
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
        table({ children }) {
          return (
            <div className="my-2 overflow-x-auto">
              <table className="min-w-full divide-y divide-border">
                {children}
              </table>
            </div>
          );
        },
        thead({ children }) {
          return (
            <thead className={isUser ? 'bg-white bg-opacity-10' : 'bg-surface'}>
              {children}
            </thead>
          );
        },
        tbody({ children }) {
          return <tbody className="divide-y divide-border">{children}</tbody>;
        },
        tr({ children }) {
          return <tr>{children}</tr>;
        },
        th({ children }) {
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
        td({ children }) {
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
        strong({ children }) {
          return <strong className="font-bold">{children}</strong>;
        },
        // Emphasis (italic)
        em({ children }) {
          return <em className="italic">{children}</em>;
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
};
