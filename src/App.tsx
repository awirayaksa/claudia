import { useEffect } from 'react';
import { MainLayout } from './components/layout/MainLayout';
import { useTheme } from './hooks/useTheme';
import { useAccentColor } from './hooks/useAccentColor';
import { useAppTitle } from './hooks/useAppTitle';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useLoadSettingsFromStore } from './hooks/useLoadSettingsFromStore';
import { useAppDispatch, useAppSelector } from './store';
import { setSettingsOpen, toggleSidebar } from './store/slices/uiSlice';
import { clearMessages } from './store/slices/chatSlice';
import { createConversation } from './store/slices/conversationSlice';
import { discoverPlugins, loadPluginConfigs, refreshActivePlugins } from './store/slices/pluginSlice';
import { loadSkills, setSkills } from './store/slices/skillSlice';
import packageJson from '../package.json';

function App() {
  const dispatch = useAppDispatch();
  const appearance = useAppSelector((state) => state.settings.appearance);
  const { selectedModel } = useAppSelector((state) => state.settings.api);
  const { currentProjectId } = useAppSelector((state) => state.project);
  const { currentConversationId } = useAppSelector((state) => state.conversation);
  const { messages } = useAppSelector((state) => state.chat);

  // Initialize skills on app start and listen for file-watcher push events
  useEffect(() => {
    dispatch(loadSkills());
    const cleanup = window.electron.skills.onChanged((skills) => {
      dispatch(setSkills(skills));
    });
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Initialize plugins on app start (runs once on mount)
  useEffect(() => {
    const initializePlugins = async () => {
      try {
        console.log('[App] Initializing plugins...');
        await dispatch(loadPluginConfigs());
        await dispatch(discoverPlugins());
        await dispatch(refreshActivePlugins());
        console.log('[App] Plugins initialized');
      } catch (error) {
        console.error('[App] Failed to initialize plugins:', error);
      }
    };

    initializePlugins();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { reload } = useLoadSettingsFromStore();

  // Load settings from electron store on app start
  useEffect(() => {
    reload();
  }, [reload]);

  // Listen for menu events from Electron
  useEffect(() => {
    const cleanupSettings = window.electron.onMenuEvent('menu:open-settings', () => {
      dispatch(setSettingsOpen(true));
    });

    const cleanupSidebar = window.electron.onMenuEvent('menu:toggle-sidebar', () => {
      dispatch(toggleSidebar());
    });

    const cleanupNewChat = window.electron.onMenuEvent('menu:new-conversation', () => {
      if (!selectedModel) {
        alert('Please select a model in settings first');
        return;
      }
      // Don't create a new conversation if the current one is still empty
      if (currentConversationId && messages.length === 0) {
        return;
      }
      dispatch(clearMessages());
      dispatch(
        createConversation({
          projectId: currentProjectId,
          title: 'New Conversation',
          model: selectedModel,
        })
      );
    });

    const cleanupAbout = window.electron.onMenuEvent('menu:about', () => {
      const appTitle = appearance.customization?.appTitle || 'Claudia';
      alert(`${appTitle} - Open WebUI/Open Router Desktop Client\nVersion ${packageJson.version}`);
    });

    // Cleanup listeners on unmount
    return () => {
      cleanupSettings?.();
      cleanupSidebar?.();
      cleanupNewChat?.();
      cleanupAbout?.();
    };
  }, [dispatch, selectedModel, currentProjectId, appearance.customization?.appTitle, currentConversationId, messages.length]);

  // Sync New Conversation menu enabled state with current conversation
  useEffect(() => {
    const isEmpty = currentConversationId && messages.length === 0;
    window.electron.setNewConversationEnabled(!isEmpty);
  }, [currentConversationId, messages.length]);

  // Initialize theme on app load
  useTheme();

  // Apply custom accent color
  useAccentColor();

  // Apply custom app title
  useAppTitle();

  // Enable keyboard shortcuts
  useKeyboardShortcuts();

  return (
    <div className="app">
      <MainLayout />
    </div>
  );
}

export default App;
