import { useEffect } from 'react';
import { MainLayout } from './components/layout/MainLayout';
import { useTheme } from './hooks/useTheme';
import { useAccentColor } from './hooks/useAccentColor';
import { useAppTitle } from './hooks/useAppTitle';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useAppDispatch, useAppSelector } from './store';
import { setApiConfig, setAppearance, setPreferences } from './store/slices/settingsSlice';
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

  // Load settings from electron store on app start
  useEffect(() => {
    const initializeSettings = async () => {
      try {
        const config = await window.electron.config.get();
        console.log('Loaded config from electron store:', config);

        if (config) {
          // Load API settings with new provider structure
          if (config.api && typeof config.api === 'object') {
            // Ensure availableModels are strings (handle legacy object format)
            const rawModels = config.api.availableModels || [];
            const availableModels = rawModels.map((m: any) =>
              typeof m === 'string' ? m : m?.id || String(m)
            );

            const apiConfig: any = {
              provider: config.api.provider || 'openwebui',
              availableModels,
            };

            // Include provider-specific configs
            if (config.api.openwebui) {
              // Normalize baseUrl - remove trailing slashes and /api suffix
              const normalizedOpenWebUI = { ...config.api.openwebui };
              if (normalizedOpenWebUI.baseUrl) {
                normalizedOpenWebUI.baseUrl = normalizedOpenWebUI.baseUrl
                  .replace(/\/+$/, '') // Remove trailing slashes
                  .replace(/\/api$/i, ''); // Remove /api suffix to prevent duplication
              }
              apiConfig.openwebui = normalizedOpenWebUI;
            }
            if (config.api.openrouter) {
              apiConfig.openrouter = config.api.openrouter;
            }
            if (config.api.custom) {
              // Normalize baseUrl - remove trailing slashes and /api suffix
              const normalizedCustom = { ...config.api.custom };
              if (normalizedCustom.baseUrl) {
                normalizedCustom.baseUrl = normalizedCustom.baseUrl
                  .replace(/\/+$/, '') // Remove trailing slashes
                  .replace(/\/api$/i, ''); // Remove /api suffix to prevent duplication
              }
              apiConfig.custom = normalizedCustom;
            }
            if ((config.api as any).opencodeGo) {
              const normalizedOpencodeGo = { ...(config.api as any).opencodeGo };
              if (normalizedOpencodeGo.baseUrl) {
                normalizedOpencodeGo.baseUrl = normalizedOpencodeGo.baseUrl
                  .replace(/\/+$/, '') // Remove trailing slashes
                  .replace(/\/v1$/i, ''); // Remove /v1 suffix to prevent duplication
              }
              apiConfig.opencodeGo = normalizedOpencodeGo;
            }

            // Extract selectedModel from the active provider for backward compatibility
            const provider = config.api.provider || 'openwebui';
            let selectedModel = '';
            if (provider === 'openwebui' && config.api.openwebui?.selectedModel) {
              selectedModel = config.api.openwebui.selectedModel;
            } else if (provider === 'openrouter' && config.api.openrouter?.selectedModel) {
              selectedModel = config.api.openrouter.selectedModel;
            } else if (provider === 'custom' && config.api.custom?.selectedModel) {
              selectedModel = config.api.custom.selectedModel;
            } else if (provider === 'opencode-go' && (config.api as any).opencodeGo?.selectedModel) {
              selectedModel = (config.api as any).opencodeGo.selectedModel;
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
      if (!selectedModel) {
        alert('Please select a model in settings first');
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
  }, [dispatch, selectedModel, currentProjectId, appearance.customization?.appTitle]);

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
