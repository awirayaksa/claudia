import { useAppSelector, useAppDispatch } from '../../store';
import { setFilesystemDirectory } from '../../store/slices/chatSlice';

interface FilesystemDirectoryBarProps {
  disabled?: boolean;
}

export function FilesystemDirectoryBar({ disabled }: FilesystemDirectoryBarProps) {
  const dispatch = useAppDispatch();
  const serverStates = useAppSelector((state) => state.mcp.serverStates);
  const filesystemDirectory = useAppSelector((state) => state.chat.filesystemDirectory);

  // Find the filesystem builtin server
  const filesystemEntry = Object.entries(serverStates).find(
    ([, s]) => s.config.builtinId === 'builtin-filesystem-001'
  );

  if (!filesystemEntry || filesystemEntry[1].status !== 'ready') {
    return null;
  }

  const [serverId] = filesystemEntry;

  const handleSetDirectory = async () => {
    try {
      const paths = await window.electron.file.selectDirectories();
      if (!paths || paths.length === 0) return;

      const dir = paths[0];
      dispatch(setFilesystemDirectory(dir));
      await window.electron.mcp.restartWithBuiltinConfig(serverId, { allowedDirectories: [dir] });
    } catch (error) {
      console.error('[FilesystemDirectoryBar] Failed to set directory:', error);
    }
  };

  if (!filesystemDirectory) {
    return (
      <div className="mx-4 mb-2 flex items-center gap-2 rounded-lg border border-dashed border-border bg-surface px-3 py-2 text-sm text-text-secondary">
        <svg
          className="h-4 w-4 shrink-0 opacity-60"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"
          />
        </svg>
        <span className="flex-1 opacity-70">No working directory set</span>
        <button
          onClick={handleSetDirectory}
          disabled={disabled}
          className="rounded px-2 py-0.5 text-xs font-medium text-text-secondary hover:bg-background hover:text-text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Set Directory
        </button>
      </div>
    );
  }

  return (
    <div className="mx-4 mb-2 flex items-center gap-2 rounded-lg border border-accent border-opacity-40 bg-surface px-3 py-2 text-sm">
      <svg
        className="h-4 w-4 shrink-0 text-accent"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"
        />
      </svg>
      <span
        className="flex-1 truncate font-mono text-xs text-text-primary"
        title={filesystemDirectory}
      >
        {filesystemDirectory}
      </span>
      <button
        onClick={handleSetDirectory}
        disabled={disabled}
        className="shrink-0 rounded px-2 py-0.5 text-xs font-medium text-accent hover:bg-background transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Change
      </button>
    </div>
  );
}
