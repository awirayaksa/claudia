import { useCallback } from 'react';
import { useAppDispatch } from '../store';
import {
  setApiConfig,
  setAppearance,
  setPreferences,
  setProfiles,
  setCurrentProfileId,
} from '../store/slices/settingsSlice';

export function useLoadSettingsFromStore() {
  const dispatch = useAppDispatch();

  const reload = useCallback(async () => {
    try {
      const [configResult, profileResult] = await Promise.all([
        window.electron.config.get(),
        window.electron.profile.list(),
      ]);

      const config = configResult;
      const { profiles, currentProfileId } = profileResult;

      dispatch(setProfiles(profiles));
      dispatch(setCurrentProfileId(currentProfileId));

      if (config) {
        // Load API settings with new provider structure
        if (config.api && typeof config.api === 'object') {
          const rawModels = config.api.availableModels || [];
          const availableModels = rawModels.map((m: any) =>
            typeof m === 'string' ? m : m?.id || String(m)
          );

          const apiConfig: any = {
            provider: config.api.provider || 'openwebui',
            availableModels,
          };

          if (config.api.openwebui) {
            apiConfig.openwebui = config.api.openwebui;
          }
          if (config.api.openrouter) {
            apiConfig.openrouter = config.api.openrouter;
          }
          if (config.api.custom) {
            apiConfig.custom = config.api.custom;
          }
          if (config.api.opencodeGo) {
            apiConfig.opencodeGo = config.api.opencodeGo;
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
          } else if (provider === 'opencode-go' && config.api.opencodeGo?.selectedModel) {
            selectedModel = config.api.opencodeGo.selectedModel;
          }
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
  }, [dispatch]);

  return { reload };
}
