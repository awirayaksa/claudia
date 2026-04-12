import { configureStore } from '@reduxjs/toolkit';
import { TypedUseSelectorHook, useDispatch, useSelector } from 'react-redux';
import settingsReducer from './slices/settingsSlice';
import uiReducer from './slices/uiSlice';
import chatReducer from './slices/chatSlice';
import conversationReducer from './slices/conversationSlice';
import projectReducer from './slices/projectSlice';
import mcpReducer from './slices/mcpSlice';
import pluginReducer from './slices/pluginSlice';
import skillReducer from './slices/skillSlice';

export const store = configureStore({
  reducer: {
    settings: settingsReducer,
    ui: uiReducer,
    chat: chatReducer,
    conversation: conversationReducer,
    project: projectReducer,
    mcp: mcpReducer,
    plugins: pluginReducer,
    skills: skillReducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: {
        // Ignore these action types for AbortController
        ignoredActions: ['chat/setAbortController'],
        // Ignore these paths in the state
        ignoredPaths: ['chat.abortController'],
      },
    }),
});

// Infer the `RootState` and `AppDispatch` types from the store itself
export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

// Export typed hooks for use throughout the app
export const useAppDispatch: () => AppDispatch = useDispatch;
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;
