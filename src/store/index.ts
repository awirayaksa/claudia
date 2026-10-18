import { TypedUseSelectorHook, useDispatch, useSelector } from 'react-redux';
// Type-only: importing this module never creates the desktop store
import type { DesktopStore } from './desktop';

export { createAppStore, sharedReducers } from './create-store';
export type { SharedRootState } from './create-store';

// Infer the `RootState` and `AppDispatch` types from the desktop store
export type RootState = ReturnType<DesktopStore['getState']>;
export type AppDispatch = DesktopStore['dispatch'];

// Export typed hooks for use throughout the app
export const useAppDispatch: () => AppDispatch = useDispatch;
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;
