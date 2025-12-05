import React from 'react';
import { useAppSelector, useAppDispatch } from '../../store';
import { setSettingsOpen } from '../../store/slices/uiSlice';
import { SettingsPanel } from '../settings/SettingsPanel';
import { ChatWindow } from '../chat/ChatWindow';
import { ConversationList } from '../sidebar/ConversationList';

export function MainLayout() {
  const dispatch = useAppDispatch();
  const { sidebarOpen } = useAppSelector((state) => state.ui);

  return (
    <div className="flex h-full w-full overflow-hidden">
      {/* Sidebar with conversation list */}
      {sidebarOpen && <ConversationList />}

      {/* Main content area */}
      <main className="flex flex-1 flex-col overflow-hidden">
        {/* Header */}
        <header className="flex h-14 items-center justify-between border-b border-border bg-surface px-4">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold text-text-primary">Claudia</h1>
            <span className="rounded bg-accent px-2 py-1 text-xs text-white">Alpha</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              className="rounded px-3 py-1.5 text-sm text-text-primary hover:bg-background"
              onClick={() => dispatch(setSettingsOpen(true))}
            >
              Settings
            </button>
          </div>
        </header>

        {/* Settings Panel */}
        <SettingsPanel />

        {/* Chat area */}
        <ChatWindow />
      </main>
    </div>
  );
}
