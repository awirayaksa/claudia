import { useDispatch, useSelector, type TypedUseSelectorHook } from 'react-redux';
import type { WebDispatch, WebRootState } from './store';

/** Typed hooks for the web store (shared code keeps using @/store's). */
export const useWebDispatch: () => WebDispatch = useDispatch;
export const useWebSelector: TypedUseSelectorHook<WebRootState> = useSelector;
