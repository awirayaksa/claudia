import { useAppSelector, useAppDispatch } from '../../store';
import { setSettingsOpen } from '../../store/slices/uiSlice';
import { clearMessages } from '../../store/slices/chatSlice';
import { SettingsPanel } from '../settings/SettingsPanel';
import { ChatWindow } from '../chat/ChatWindow';
import { ConversationList } from '../sidebar/ConversationList';
import { Button } from '../common/Button';

export function MainLayout() {
  const dispatch = useAppDispatch();
  const { sidebarOpen } = useAppSelector((state) => state.ui);
  const { messages } = useAppSelector((state) => state.chat);
  const { api } = useAppSelector((state) => state.settings);

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
    <div className="flex h-full w-full overflow-hidden">
      {/* Sidebar with conversation list */}
      {sidebarOpen && <ConversationList />}

      {/* Main content area */}
      <main className="flex flex-1 flex-col overflow-hidden">
        {/* Header */}
        <header className="flex h-14 items-center justify-between border-b border-border bg-surface px-4">
          <div className="flex items-center gap-2">
            {hasMessages ? (
              <div>
                <h1 className="text-base font-semibold text-text-primary">Chat</h1>
                <p className="text-xs text-text-secondary">Model: {selectedModel || 'Not selected'}</p>
              </div>
            ) : (
              <>
                <h1 className="text-lg font-semibold text-text-primary">Claudia</h1>
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
  );
}
