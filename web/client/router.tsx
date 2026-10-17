import { createBrowserRouter, type RouteObject } from 'react-router-dom';
import { PreviewPage } from './pages/PreviewPage';
import { NotFoundPage } from './pages/NotFoundPage';

/**
 * Routes. Phase 1a adds /login, /c/:id, /workspace/*, /admin/*; Phase 2 adds /s/:token.
 */
export const routes: RouteObject[] = [
  { path: '/', element: <PreviewPage /> },
  { path: '*', element: <NotFoundPage /> },
];

export function createRouter() {
  return createBrowserRouter(routes);
}
