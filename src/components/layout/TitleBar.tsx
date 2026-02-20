import { useState, useEffect } from 'react';
import { useAppSelector } from '../../store';
import jacLogo from '../../assets/jac_logo.ico';

export function TitleBar() {
  const appearance = useAppSelector((state) => state.settings.appearance);
  const appTitle = appearance.customization?.appTitle || 'ASKMAI Desktop';
  const [isMaximized, setIsMaximized] = useState(false);
  const [iconPreview, setIconPreview] = useState<string | null>(null);

  useEffect(() => {
    // Check initial maximized state
    window.electron.window.isMaximized().then(setIsMaximized);
  }, []);

  // Load icon preview
  useEffect(() => {
    if (appearance.customization?.iconPath) {
      window.electron.icon.getPreview(appearance.customization.iconPath).then((preview) => {
        if (preview) {
          setIconPreview(preview);
        }
      });
    } else {
      setIconPreview(null);
    }
  }, [appearance.customization?.iconPath]);

  const handleMinimize = () => {
    window.electron.window.minimize();
  };

  const handleMaximize = () => {
    window.electron.window.maximize();
    setIsMaximized(!isMaximized);
  };

  const handleClose = () => {
    window.electron.window.close();
  };

  const handleShowMenu = (e: React.MouseEvent) => {
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    window.electron.window.showMenu(Math.round(rect.left), Math.round(rect.bottom));
  };

  return (
    <div
      className="flex items-center justify-between h-8 bg-accent text-white select-none"
      style={{ WebkitAppRegion: 'drag' } as any}
    >
      {/* App title and icon */}
      <div className="flex items-center gap-2 pl-1">
        {/* Menu button */}
        <button
          onClick={handleShowMenu}
          className="h-8 px-3 hover:bg-black hover:bg-opacity-20 transition-colors flex items-center"
          style={{ WebkitAppRegion: 'no-drag' } as any}
          title="Menu"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 12h18M3 6h18M3 18h18" />
          </svg>
        </button>
        <img src={iconPreview || jacLogo} alt="App icon" className="w-4 h-4" />
        <span className="text-sm font-medium">{appTitle}</span>
      </div>

      {/* Window controls */}
      <div className="flex h-full" style={{ WebkitAppRegion: 'no-drag' } as any}>
        <button
          onClick={handleMinimize}
          className="h-full px-4 hover:bg-black hover:bg-opacity-20 transition-colors"
          title="Minimize"
        >
          <svg width="10" height="1" viewBox="0 0 10 1" fill="currentColor">
            <rect width="10" height="1" />
          </svg>
        </button>
        <button
          onClick={handleMaximize}
          className="h-full px-4 hover:bg-black hover:bg-opacity-20 transition-colors"
          title={isMaximized ? 'Restore' : 'Maximize'}
        >
          {isMaximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor">
              <rect x="2" y="0" width="8" height="8" strokeWidth="1" />
              <rect x="0" y="2" width="8" height="8" strokeWidth="1" fill="var(--color-accent)" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor">
              <rect x="0" y="0" width="10" height="10" strokeWidth="1" />
            </svg>
          )}
        </button>
        <button
          onClick={handleClose}
          className="h-full px-4 hover:bg-red-600 transition-colors"
          title="Close"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
            <path d="M0,0 L10,10 M10,0 L0,10" />
          </svg>
        </button>
      </div>
    </div>
  );
}
