/** The user's workspace: the private folder the built-in Files, Word and Diagrams tools work in. */

export interface WorkspaceEntry {
  name: string;
  /** Relative to the workspace, with forward slashes ("reports/q3.md"). */
  path: string;
  type: 'file' | 'directory';
  /** Files only. */
  size?: number;
  modifiedAt: string;
}

const TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  xml: 'application/xml',
  zip: 'application/zip',
};

/** A file's type from its name (application/octet-stream when unknown). */
export function workspaceMime(name: string): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
  return TYPES[ext] ?? 'application/octet-stream';
}

/** Download address of a workspace file (relative path). */
export function workspaceFileUrl(path: string): string {
  return `/api/workspace-files/content?path=${encodeURIComponent(path)}`;
}
