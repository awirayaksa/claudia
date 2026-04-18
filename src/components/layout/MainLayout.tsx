import { useAppSelector, useAppDispatch } from '../../store';
import { setSettingsOpen, toggleSidebar } from '../../store/slices/uiSlice';
import { SettingsPanel } from '../settings/SettingsPanel';
import { ChatWindow } from '../chat/ChatWindow';
import { ConversationList } from '../sidebar/ConversationList';
import { TitleBar } from './TitleBar';

export function MainLayout() {
  const dispatch = useAppDispatch();
  const { sidebarOpen } = useAppSelector((state) => state.ui);
  const { api } = useAppSelector((state) => state.settings);

  // Determine selected model based on provider
  const selectedModel = api.provider === 'openrouter'
    ? api.openrouter?.selectedModel
    : api.openwebui?.selectedModel;

  function humanizeModel(model: string): string {
    const part = model.split('/').pop() || model;
    const cleaned = part.replace(/-\d{2,4}(?:-\d{2}(?:-\d{2})?)?$/, '');
    return cleaned
      .replace(/-/g, ' ')
      .replace(/([a-zA-Z])(\d)/g, '$1 $2')
      .replace(/(\d)([a-zA-Z])/g, '$1 $2')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      {/* Custom title bar */}
      <TitleBar />

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar with conversation list */}
        {sidebarOpen && <ConversationList />}

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
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>

            <div className="flex items-center gap-2 text-sm">
              <div className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 font-medium text-text-primary">
                {selectedModel ? humanizeModel(selectedModel) : 'Not selected'}
              </div>
              <span className="rounded border border-border bg-background px-1.5 py-0.5 text-xs text-text-secondary">
                Alpha
              </span>
            </div>
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
