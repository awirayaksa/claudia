import React, { useEffect } from 'react';
import { MainLayout } from './components/layout/MainLayout';
import { useTheme } from './hooks/useTheme';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useConversations } from './hooks/useConversations';
import { useAppDispatch } from './store';
import { setApiConfig, setAppearance, setPreferences } from './store/slices/settingsSlice';
import { setSettingsOpen, toggleSidebar } from './store/slices/uiSlice';

function App() {
  const dispatch = useAppDispatch();
  const { create: createConversation } = useConversations();

  // Load settings from electron store on app start
  useEffect(() => {
    const initializeSettings = async () => {
      try {
        const config = await window.electron.config.get();
        console.log('Loaded config from electron store:', config);

        if (config) {
          // Load API settings
          if (config.api && typeof config.api === 'object') {
            dispatch(setApiConfig({
              baseUrl: config.api.baseUrl || '',
              apiKey: config.api.apiKey || '',
              selectedModel: config.api.selectedModel || '',
              availableModels: config.api.availableModels || [],
            }));
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
      alert('Claudia - Open WebUI Desktop Client\nVersion 1.0.0');
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
