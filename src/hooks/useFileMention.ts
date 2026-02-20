import { useState, useCallback, useRef } from 'react';

export interface DirectoryEntry {
  name: string;
  isDirectory: boolean;
}

interface ParsedQuery {
  browsingDir: string;
  fileFilter: string;
}

function parseQuery(query: string, baseDir: string): ParsedQuery {
  const slashIdx = query.lastIndexOf('/');
  if (slashIdx === -1) {
    return { browsingDir: baseDir, fileFilter: query };
  }
  const dirPart = query.slice(0, slashIdx);
  const fileFilter = query.slice(slashIdx + 1);
  // Join base dir with the directory part using forward slashes
  const browsingDir = `${baseDir}/${dirPart}`.replace(/\\/g, '/');
  return { browsingDir, fileFilter };
}

export interface FileMentionResult {
  isOpen: boolean;
  query: string;
  filteredEntries: DirectoryEntry[];
  activeIndex: number;
  handleChange: (value: string, cursorPos: number) => void;
  handleKeyDown: (
    e: React.KeyboardEvent<HTMLTextAreaElement>
  ) => { consumed: boolean; newValue?: string; newCursorPos?: number; keepOpen?: boolean };
  selectEntry: (
    entry: DirectoryEntry,
    value: string,
    cursorPos: number
  ) => { newValue: string; newCursorPos: number; keepOpen: boolean };
  close: () => void;
}

export function useFileMention(
  filesystemDirectory: string | null,
  isFilesystemReady: boolean
): FileMentionResult {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [filteredEntries, setFilteredEntries] = useState<DirectoryEntry[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerIndexRef = useRef<number | null>(null);
  const entriesCacheRef = useRef<Map<string, DirectoryEntry[]>>(new Map());

  const close = useCallback(() => {
    setIsOpen(false);
    setQuery('');
    setActiveIndex(0);
    setFilteredEntries([]);
    triggerIndexRef.current = null;
    entriesCacheRef.current.clear();
  }, []);

  const handleChange = useCallback(
    async (value: string, cursorPos: number) => {
      if (!isFilesystemReady || !filesystemDirectory) {
        if (isOpen) close();
        return;
      }

      // Find last @ before cursor
      const textBeforeCursor = value.slice(0, cursorPos);
      const atIdx = textBeforeCursor.lastIndexOf('@');

      if (atIdx === -1) {
        if (isOpen) close();
        return;
      }

      // Check word boundary: char before @ must be space, newline, or start of string
      if (atIdx > 0) {
        const charBefore = value[atIdx - 1];
        if (charBefore !== ' ' && charBefore !== '\n') {
          if (isOpen) close();
          return;
        }
      }

      const rawQuery = value.slice(atIdx + 1, cursorPos);

      // If query contains a space, it's no longer a mention
      if (rawQuery.includes(' ')) {
        if (isOpen) close();
        return;
      }

      const { browsingDir, fileFilter } = parseQuery(rawQuery, filesystemDirectory);

      // Fetch directory entries if not cached
      if (!entriesCacheRef.current.has(browsingDir)) {
        try {
          const result = await window.electron.file.listDirectory(browsingDir);
          if (result.success) {
            // Sort: directories first (alphabetical), then files (alphabetical)
            const sorted = [...result.entries].sort((a, b) => {
              if (a.isDirectory !== b.isDirectory) {
                return a.isDirectory ? -1 : 1;
              }
              return a.name.localeCompare(b.name);
            });
            entriesCacheRef.current.set(browsingDir, sorted);
          } else {
            entriesCacheRef.current.set(browsingDir, []);
          }
        } catch {
          entriesCacheRef.current.set(browsingDir, []);
        }
      }

      const cached = entriesCacheRef.current.get(browsingDir) ?? [];
      const filtered = fileFilter
        ? cached.filter((e) => e.name.toLowerCase().includes(fileFilter.toLowerCase()))
        : cached;

      setQuery(rawQuery);
      setFilteredEntries(filtered);
      setActiveIndex(0);
      setIsOpen(true);
      if (triggerIndexRef.current === null) {
        triggerIndexRef.current = atIdx;
      } else {
        // Update trigger index in case the @ moved (shouldn't normally happen)
        triggerIndexRef.current = atIdx;
      }
    },
    [isFilesystemReady, filesystemDirectory, isOpen, close]
  );

  const buildReplacement = useCallback(
    (
      entry: DirectoryEntry,
      value: string,
      cursorPos: number
    ): { newValue: string; newCursorPos: number } => {
      const atIdx = triggerIndexRef.current ?? 0;
      const before = value.slice(0, atIdx);
      const currentQuery = value.slice(atIdx + 1, cursorPos);
      const pathPrefix = currentQuery.includes('/')
        ? currentQuery.slice(0, currentQuery.lastIndexOf('/') + 1)
        : '';
      const token = entry.isDirectory
        ? `${pathPrefix}${entry.name}/`
        : `${pathPrefix}${entry.name}`;
      const after = value.slice(cursorPos);
      const newValue = `${before}@${token}${after}`;
      const newCursorPos = atIdx + 1 + token.length;
      return { newValue, newCursorPos };
    },
    []
  );

  const selectEntry = useCallback(
    (
      entry: DirectoryEntry,
      value: string,
      cursorPos: number
    ): { newValue: string; newCursorPos: number; keepOpen: boolean } => {
      const { newValue, newCursorPos } = buildReplacement(entry, value, cursorPos);
      if (entry.isDirectory) {
        // Keep open for directory drill-down; caller will re-trigger handleChange
        return { newValue, newCursorPos, keepOpen: true };
      }
      close();
      return { newValue, newCursorPos, keepOpen: false };
    },
    [buildReplacement, close]
  );

  const handleKeyDown = useCallback(
    (
      e: React.KeyboardEvent<HTMLTextAreaElement>
    ): { consumed: boolean; newValue?: string; newCursorPos?: number; keepOpen?: boolean } => {
      if (!isOpen) return { consumed: false };

      if (e.key === 'ArrowDown') {
        setActiveIndex((prev) => (prev + 1) % Math.max(filteredEntries.length, 1));
        return { consumed: true };
      }

      if (e.key === 'ArrowUp') {
        setActiveIndex((prev) =>
          prev === 0 ? Math.max(filteredEntries.length - 1, 0) : prev - 1
        );
        return { consumed: true };
      }

      if (e.key === 'Enter') {
        const entry = filteredEntries[activeIndex];
        if (!entry) return { consumed: true };
        const textarea = e.currentTarget;
        const cursorPos = textarea.selectionStart ?? textarea.value.length;
        const { newValue, newCursorPos } = buildReplacement(entry, textarea.value, cursorPos);
        const keepOpen = entry.isDirectory;
        if (!entry.isDirectory) {
          close();
        }
        return { consumed: true, newValue, newCursorPos, keepOpen };
      }

      if (e.key === 'Escape') {
        close();
        return { consumed: true };
      }

      return { consumed: false };
    },
    [isOpen, filteredEntries, activeIndex, buildReplacement, close]
  );

  return {
    isOpen,
    query,
    filteredEntries,
    activeIndex,
    handleChange,
    handleKeyDown,
    selectEntry,
    close,
  };
}
