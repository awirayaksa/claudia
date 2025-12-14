import { useEffect } from 'react';
import { MainLayout } from './components/layout/MainLayout';
import { useTheme } from './hooks/useTheme';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useConversations } from './hooks/useConversations';
import { useAppDispatch } from './store';
import { setApiConfig, setAppearance, setPreferences } from './store/slices/settingsSlice';
import { setSettingsOpen, toggleSidebar } from './store/slices/uiSlice';
import { discoverPlugins, loadPluginConfigs, refreshActivePlugins } from './store/slices/pluginSlice';

function App() {
  const dispatch = useAppDispatch();
  const { create: createConversation } = useConversations();

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

  // Load settings from electron store on app start
  useEffect(() => {
    const initializeSettings = async () => {
      try {
        const config = await window.electron.config.get();
        console.log('Loaded config from electron store:', config);

        if (config) {
          // Load API settings with new provider structure
          if (config.api && typeof config.api === 'object') {
            const apiConfig: any = {
              provider: config.api.provider || 'openwebui',
              availableModels: config.api.availableModels || [],
            };

            // Include provider-specific configs
            if (config.api.openwebui) {
              apiConfig.openwebui = config.api.openwebui;
            }
            if (config.api.openrouter) {
              apiConfig.openrouter = config.api.openrouter;
            }

            // Extract selectedModel from the active provider for backward compatibility
            const provider = config.api.provider || 'openwebui';
            let selectedModel = '';
            if (provider === 'openwebui' && config.api.openwebui?.selectedModel) {
              selectedModel = config.api.openwebui.selectedModel;
            } else if (provider === 'openrouter' && config.api.openrouter?.selectedModel) {
              selectedModel = config.api.openrouter.selectedModel;
            }
            // Set selectedModel at the top level for backward compatibility
            apiConfig.selectedModel = selectedModel;

            dispatch(setApiConfig(apiConfig));
          }

          // Load appearance settings
          if (config.appearance && typeof config.appearance === 'object') {
            dispatch(setAppearance(config.appearance));
          }

          // Load preferences
          if (config.preferences && typeof config.preferences === 'object') {
            dispatch(setPreferences(config.preferences));
          }
        }
      } catch (error) {
        console.error('Failed to load settings:', error);
      }
    };

    initializeSettings();
  }, [dispatch]);

  // Listen for menu events from Electron
  useEffect(() => {
    const cleanupSettings = window.electron.onMenuEvent('menu:open-settings', () => {
      dispatch(setSettingsOpen(true));
    });

    const cleanupSidebar = window.electron.onMenuEvent('menu:toggle-sidebar', () => {
      dispatch(toggleSidebar());
    });

    const cleanupNewChat = window.electron.onMenuEvent('menu:new-conversation', () => {
      createConversation().catch((error) => {
        console.error('Failed to create conversation from menu:', error);
      });
    });

    const cleanupAbout = window.electron.onMenuEvent('menu:about', () => {
      // TODO: Show about dialog
      alert('Claudia - Open WebUI/Open Router Desktop Client\nVersion 0.1.0');
    });

    // Cleanup listeners on unmount
    return () => {
      cleanupSettings?.();
      cleanupSidebar?.();
      cleanupNewChat?.();
      cleanupAbout?.();
    };
  }, [dispatch, createConversation]);

  // Initialize theme on app load
  useTheme();

  // Enable keyboard shortcuts
  useKeyboardShortcuts();

  return (
    <div className="app">
      <MainLayout />
    </div>
  );
}

export default App;
