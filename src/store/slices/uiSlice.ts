import { createSlice, PayloadAction } from '@reduxjs/toolkit';

interface UIState {
  sidebarOpen: boolean;
  settingsOpen: boolean;
  currentModal: string | null;
  fileUploadProgress: Record<string, number>;
  isLoading: boolean;
  error: string | null;
}

const initialState: UIState = {
  sidebarOpen: true,
  settingsOpen: false,
  currentModal: null,
  fileUploadProgress: {},
  isLoading: false,
  error: null,
};

const uiSlice = createSlice({
  name: 'ui',
  initialState,
  reducers: {
    toggleSidebar: (state) => {
      state.sidebarOpen = !state.sidebarOpen;
    },
    setSidebarOpen: (state, action: PayloadAction<boolean>) => {
      state.sidebarOpen = action.payload;
    },
    toggleSettings: (state) => {
      state.settingsOpen = !state.settingsOpen;
    },
    setSettingsOpen: (state, action: PayloadAction<boolean>) => {
      state.settingsOpen = action.payload;
    },
    openModal: (state, action: PayloadAction<string>) => {
      state.currentModal = action.payload;
    },
    closeModal: (state) => {
      state.currentModal = null;
    },
    setFileUploadProgress: (state, action: PayloadAction<{ fileId: string; progress: number }>) => {
      state.fileUploadProgress[action.payload.fileId] = action.payload.progress;
    },
    clearFileUploadProgress: (state, action: PayloadAction<string>) => {
      delete state.fileUploadProgress[action.payload];
    },
    setLoading: (state, action: PayloadAction<boolean>) => {
      state.isLoading = action.payload;
    },
    setError: (state, action: PayloadAction<string | null>) => {
      state.error = action.payload;
    },
  },
});

export const {
  toggleSidebar,
  setSidebarOpen,
  toggleSettings,
  setSettingsOpen,
  openModal,
  closeModal,
  setFileUploadProgress,
  clearFileUploadProgress,
  setLoading,
  setError,
} = uiSlice.actions;

export default uiSlice.reducer;
