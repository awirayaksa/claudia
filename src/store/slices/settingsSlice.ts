import { createSlice, PayloadAction } from '@reduxjs/toolkit';

interface SettingsState {
  api: {
    baseUrl: string;
    apiKey: string;
    selectedModel: string;
    availableModels: string[];
  };
  appearance: {
    theme: 'light' | 'dark' | 'system';
    fontSize: 'small' | 'medium' | 'large';
    sidebarWidth: number;
  };
  preferences: {
    saveHistory: boolean;
    streamingEnabled: boolean;
    maxTokens: number;
    temperature: number;
  };
}

const initialState: SettingsState = {
  api: {
    baseUrl: '',
    apiKey: '',
    selectedModel: '',
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
  },
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
  },
});

export const {
  setApiConfig,
  setAppearance,
  setPreferences,
  setAvailableModels,
  loadSettings,
} = settingsSlice.actions;

export default settingsSlice.reducer;
