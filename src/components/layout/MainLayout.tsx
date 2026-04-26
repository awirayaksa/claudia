import { useRef, useState, useCallback, useEffect } from 'react';
import { useAppSelector, useAppDispatch } from '../../store';
import { setSettingsOpen, toggleSidebar } from '../../store/slices/uiSlice';
import { SettingsPanel } from '../settings/SettingsPanel';
import { ChatWindow } from '../chat/ChatWindow';
import { ConversationList } from '../sidebar/ConversationList';
import { TitleBar } from './TitleBar';

const SIDEBAR_WIDTH_KEY = 'claudia_sidebar_width';
const SIDEBAR_DEFAULT_WIDTH = 288;
const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 520;

function getSavedSidebarWidth(): number {
  const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
  if (saved) {
    const parsed = parseInt(saved, 10);
    if (!isNaN(parsed) && parsed >= SIDEBAR_MIN_WIDTH && parsed <= SIDEBAR_MAX_WIDTH) {
      return parsed;
    }
  }
  return SIDEBAR_DEFAULT_WIDTH;
}

export function MainLayout() {
  const dispatch = useAppDispatch();
  const { sidebarOpen } = useAppSelector((state) => state.ui);
  const [sidebarWidth, setSidebarWidth] = useState(getSavedSidebarWidth);
  const isDragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    isDragging.current = true;
    dragStartX.current = e.clientX;
    dragStartWidth.current = sidebarWidth;
    e.preventDefault();
  }, [sidebarWidth]);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      const delta = e.clientX - dragStartX.current;
      const newWidth = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, dragStartWidth.current + delta));
      setSidebarWidth(newWidth);
    };
    const onMouseUp = () => {
      if (!isDragging.current) return;
      isDragging.current = false;
      setSidebarWidth((w) => {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(w));
        return w;
      });
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);
  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      {/* Custom title bar */}
      <TitleBar />

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar with conversation list */}
        {sidebarOpen && (
          <>
            <ConversationList width={sidebarWidth} />
            {/* Resize handle */}
            <div
              onMouseDown={onMouseDown}
              className="w-1 flex-shrink-0 cursor-col-resize hover:bg-accent/30 active:bg-accent/50 transition-colors"
              title="Drag to resize sidebar"
            />
          </>
        )}

        {/* Main content area */}
        <main className="flex flex-1 flex-col overflow-hidden">
        {/* Header */}
        <header className="flex h-11 items-center justify-between border-b border-border bg-surface px-3">
          <div className="flex items-center gap-2">
            {/* Sidebar toggle button */}
            <button
              onClick={() => dispatch(toggleSidebar())}
              className="rounded p-1.5 text-text-secondary hover:bg-surface-hover transition-colors"
              aria-label="Toggle sidebar"
              title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" strokeWidth={2} />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v18" />
              </svg>
            </button>
          </div>

          <div className="flex items-center gap-1">
            <button
              className="rounded p-1.5 text-text-secondary hover:bg-surface-hover transition-colors"
              onClick={() => dispatch(setSettingsOpen(true))}
              title="Settings"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
          </div>
        </header>

        {/* Settings Panel */}
        <SettingsPanel />

        {/* Chat area */}
        <ChatWindow />
      </main>
      </div>
    </div>
  );
}
