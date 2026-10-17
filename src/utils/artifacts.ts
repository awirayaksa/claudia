/**
 * Artifacts: complete code blocks in a reply that can be shown live — HTML
 * pages, SVG images and React components. A block still being written (no
 * closing fence yet) is not one.
 */

export type ArtifactKind = 'html' | 'svg' | 'react';

export interface Artifact {
  kind: ArtifactKind;
  /** The block's language tag as written. */
  language: string;
  code: string;
  title: string;
}

const FENCE = /^(```|~~~)[ \t]*([\w+-]*)[^\n]*\n([\s\S]*?)\n\1[ \t]*$/gm;

function kindOf(language: string, code: string): ArtifactKind | null {
  const lang = language.toLowerCase();
  if (lang === 'html' || lang === 'htm') return 'html';
  if (lang === 'svg' || ((lang === 'xml' || lang === '') && /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(code))) return 'svg';
  if (lang === 'jsx' || lang === 'tsx' || lang === 'react') return 'react';
  // A JavaScript/TypeScript block that is a React component
  if ((lang === 'javascript' || lang === 'js' || lang === 'typescript' || lang === 'ts') && /from\s+['"]react['"]/.test(code) && /export\s+default/.test(code)) {
    return 'react';
  }
  return null;
}

function titleOf(kind: ArtifactKind, code: string): string {
  if (kind === 'html') {
    const t = /<title[^>]*>([^<]{1,100})<\/title>/i.exec(code)?.[1] ?? /<h1[^>]*>([^<]{1,100})<\/h1>/i.exec(code)?.[1];
    return t?.trim() || 'HTML page';
  }
  if (kind === 'svg') return /<title[^>]*>([^<]{1,100})<\/title>/i.exec(code)?.[1]?.trim() || 'SVG image';
  const name = /export\s+default\s+(?:function\s+|class\s+)?([A-Z]\w*)/.exec(code)?.[1] ?? /function\s+([A-Z]\w*)\s*\(/.exec(code)?.[1];
  return name ? name.replace(/([a-z])([A-Z])/g, '$1 $2') : 'React component';
}

export function findArtifacts(markdown: string): Artifact[] {
  const out: Artifact[] = [];
  for (const m of markdown.matchAll(FENCE)) {
    const language = m[2] ?? '';
    const code = m[3];
    const kind = kindOf(language, code);
    // Tiny snippets (one tag, one line) aren't worth a preview
    if (!kind || code.trim().length < 20) continue;
    out.push({ kind, language, code, title: titleOf(kind, code) });
  }
  return out;
}

export const ARTIFACT_EXTENSIONS: Record<ArtifactKind, string> = { html: 'html', svg: 'svg', react: 'jsx' };
