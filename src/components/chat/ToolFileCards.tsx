import { useState } from 'react';
import type { ToolFile } from '../../types/message.types';
import { getPlatform } from '../../platform';
import { useT } from '../../i18n';

/** Badge text and color per file type. */
const KINDS: Record<string, { label: string; color: string }> = {
  xlsx: { label: 'XLSX', color: '#1D6F42' },
  pptx: { label: 'PPTX', color: '#C43E1C' },
  docx: { label: 'DOCX', color: '#2B579A' },
  dotx: { label: 'DOTX', color: '#2B579A' },
  pdf: { label: 'PDF', color: '#B30B00' },
  png: { label: 'PNG', color: '#6B7280' },
  svg: { label: 'SVG', color: '#6B7280' },
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FileCard({ file }: { file: ToolFile }) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const files = getPlatform().files;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const kind = KINDS[ext] ?? { label: ext.toUpperCase().slice(0, 4) || 'FILE', color: '#6B7280' };

  const act = async (fn?: (path: string) => Promise<void>) => {
    if (!fn) return;
    setError(null);
    try {
      await fn(file.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2">
      <span
        className="flex h-9 w-11 flex-shrink-0 items-center justify-center rounded text-[10px] font-bold tracking-wide text-white"
        style={{ backgroundColor: kind.color }}
        aria-hidden="true"
      >
        {kind.label}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-text-primary" title={file.path}>
          {file.name}
        </p>
        <p className="truncate text-xs text-text-secondary" title={file.path}>
          {error ?? `${formatSize(file.size)} · ${file.path}`}
        </p>
      </div>
      <button
        onClick={() => act(files.openLocal)}
        className="rounded px-2 py-1 text-xs font-medium text-accent hover:bg-background transition-colors"
      >
        {t('files.open', 'Open')}
      </button>
      <button
        onClick={() => act(files.revealLocal)}
        className="rounded px-2 py-1 text-xs text-text-secondary hover:bg-background hover:text-text-primary transition-colors"
      >
        {t('files.showInFolder', 'Show in folder')}
      </button>
    </div>
  );
}

/** Files built-in tools wrote on this computer, as cards under the reply (desktop). */
export function ToolFileCards({ files }: { files: ToolFile[] }) {
  const platform = getPlatform().files;
  if (files.length === 0 || !platform.openLocal) return null;
  return (
    <div className="mt-2 space-y-2">
      {files.map((f) => (
        <FileCard key={f.path} file={f} />
      ))}
    </div>
  );
}

/** The files of a reply's tool results, once each (a workbook edited five times is one card). */
export function filesOfResults(results: Array<{ files?: ToolFile[]; isError?: boolean }> | undefined): ToolFile[] {
  const byPath = new Map<string, ToolFile>();
  for (const r of results ?? []) {
    if (r.isError) continue;
    for (const f of r.files ?? []) {
      byPath.delete(f.path);
      byPath.set(f.path, f); // the latest size, in the order of the last write
    }
  }
  return [...byPath.values()];
}
