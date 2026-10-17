import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { ReasoningEffort } from '../../utils/effort-utils';

/**
 * Per-session state of the message composer. Shared by desktop and web, so
 * ChatInput doesn't depend on the desktop chat slice. Volatile: not persisted.
 */
export interface ComposerState {
  /** Session-wide reasoning effort set via `/effort <level>`; null = Preferences default. */
  effortLevel: ReasoningEffort | null;
  /** Working directory for the filesystem tools (desktop). */
  filesystemDirectory: string | null;
}

const initialState: ComposerState = {
  effortLevel: null,
  filesystemDirectory: null,
};

const composerSlice = createSlice({
  name: 'composer',
  initialState,
  reducers: {
    setEffortLevel: (state, action: PayloadAction<ReasoningEffort | null>) => {
      state.effortLevel = action.payload;
    },
    setFilesystemDirectory: (state, action: PayloadAction<string | null>) => {
      state.filesystemDirectory = action.payload;
    },
  },
});

export const { setEffortLevel, setFilesystemDirectory } = composerSlice.actions;

export default composerSlice.reducer;
