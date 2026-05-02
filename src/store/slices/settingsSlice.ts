import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { ProviderType, OpenWebUIConfig, OpenRouterConfig, CustomProviderConfig, OpencodeGoConfig } from '../../types/api.types';
import { ProfileMeta } from '../../types/profile.types';

interface SettingsState {
  api: {
    provider: ProviderType;
    openwebui?: OpenWebUIConfig;
    openrouter?: OpenRouterConfig;
    custom?: CustomProviderConfig;
    opencodeGo?: OpencodeGoConfig;
    availableModels: string[];
    // Legacy fields for backward compatibility (deprecated)
    baseUrl?: string;
    apiKey?: string;
    selectedModel?: string;
  };
  appearance: {
    theme: 'light' | 'dark' | 'system';
    fontSize: 'small' | 'medium' | 'large';
    sidebarWidth: number;
    customization?: {
      accentColor?: string;
      appTitle?: string;
      iconPath?: string;
    };
  };
  preferences: {
    saveHistory: boolean;
    streamingEnabled: boolean;
    maxTokens: number;
    temperature: number;
    logLevel: 'debug' | 'info' | 'warn' | 'error';
    enableFileLogging: boolean;
    showReasoning: boolean;
    showStatistics: boolean;
    systemPrompt: string;
    systemPromptFileName: string;
    updateCheckUrl: string;
  };
  profiles: ProfileMeta[];
  currentProfileId: string | null;
}

const initialState: SettingsState = {
  api: {
    provider: 'openwebui', // Default provider
    availableModels: [],
  },
  appearance: {
    theme: 'system',
    fontSize: 'medium',
    sidebarWidth: 280,
  },
  preferences: {
    saveHistory: true,
    streamingEnabled: true,
    maxTokens: 2048,
    temperature: 0.7,
    logLevel: 'info',
    enableFileLogging: true,
    showReasoning: false,
    showStatistics: false,
    systemPrompt: '',
    systemPromptFileName: '',
    updateCheckUrl: '',
  },
  profiles: [],
  currentProfileId: null,
};

const settingsSlice = createSlice({
  name: 'settings',
  initialState,
  reducers: {
    setApiConfig: (state, action: PayloadAction<Partial<SettingsState['api']>>) => {
      state.api = { ...state.api, ...action.payload };
    },
    setAppearance: (state, action: PayloadAction<Partial<SettingsState['appearance']>>) => {
      state.appearance = { ...state.appearance, ...action.payload };
    },
    setPreferences: (state, action: PayloadAction<Partial<SettingsState['preferences']>>) => {
      state.preferences = { ...state.preferences, ...action.payload };
    },
    setAvailableModels: (state, action: PayloadAction<string[]>) => {
      state.api.availableModels = action.payload;
    },
    loadSettings: (state, action: PayloadAction<Partial<SettingsState>>) => {
      return { ...state, ...action.payload };
    },
    setProfiles: (state, action: PayloadAction<ProfileMeta[]>) => {
      state.profiles = action.payload;
    },
    setCurrentProfileId: (state, action: PayloadAction<string | null>) => {
      state.currentProfileId = action.payload;
    },
  },
});

export const {
  setApiConfig,
  setAppearance,
  setPreferences,
  setAvailableModels,
  loadSettings,
  setProfiles,
  setCurrentProfileId,
} = settingsSlice.actions;

export default settingsSlice.reducer;
