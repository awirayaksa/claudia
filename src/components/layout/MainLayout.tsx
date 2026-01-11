import { useAppSelector, useAppDispatch } from '../../store';
import { setSettingsOpen, toggleSidebar } from '../../store/slices/uiSlice';
import { clearMessages } from '../../store/slices/chatSlice';
import { SettingsPanel } from '../settings/SettingsPanel';
import { ChatWindow } from '../chat/ChatWindow';
import { ConversationList } from '../sidebar/ConversationList';
import { Button } from '../common/Button';
import { TitleBar } from './TitleBar';

export function MainLayout() {
  const dispatch = useAppDispatch();
  const { sidebarOpen } = useAppSelector((state) => state.ui);
  const { messages } = useAppSelector((state) => state.chat);
  const { api, appearance } = useAppSelector((state) => state.settings);
  const appTitle = appearance.customization?.appTitle || 'Claudia';

  // Determine selected model based on provider
  const selectedModel = api.provider === 'openrouter'
    ? api.openrouter?.selectedModel
    : api.openwebui?.selectedModel;

  const hasMessages = messages.length > 0;

  const handleClearChat = () => {
    if (window.confirm('Are you sure you want to clear this chat? This action cannot be undone.')) {
      dispatch(clearMessages());
    }
  };

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
        <header className="flex h-14 items-center justify-between border-b border-border bg-surface px-4">
          <div className="flex items-center gap-2">
            {/* Sidebar toggle button */}
            <button
              onClick={() => dispatch(toggleSidebar())}
              className="rounded p-2 text-text-primary hover:bg-background transition-colors"
              aria-label="Toggle sidebar"
              title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
            >
              <svg
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 6h16M4 12h16M4 18h16"
                />
              </svg>
            </button>

            {hasMessages ? (
              <div>
                <h1 className="text-base font-semibold text-text-primary">Chat</h1>
                <p className="text-xs text-text-secondary">Model: {selectedModel || 'Not selected'}</p>
              </div>
            ) : (
              <>
                <h1 className="text-lg font-semibold text-text-primary">{appTitle}</h1>
                <span className="rounded bg-accent px-2 py-1 text-xs text-white">Alpha</span>
              </>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              className="rounded px-3 py-1.5 text-sm text-text-primary hover:bg-background"
              onClick={() => dispatch(setSettingsOpen(true))}
            >
              Settings
            </button>
            {hasMessages && (
              <Button variant="ghost" size="sm" onClick={handleClearChat}>
                Clear Chat
              </Button>
            )}
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
