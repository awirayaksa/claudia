import { createBrowserRouter, Navigate, type RouteObject } from 'react-router-dom';
import { AuthGate } from './auth/AuthGate';
import { AppShell } from './layout/AppShell';
import { ChatPage } from './pages/ChatPage';
import { SettingsPage } from './pages/SettingsPage';
import { AdminLayout } from './pages/admin/AdminLayout';
import { UsersPage } from './pages/admin/UsersPage';
import { ConnectionsPage } from './pages/admin/ConnectionsPage';
import { AdminSettingsPage } from './pages/admin/AdminSettingsPage';
import { NotFoundPage } from './pages/NotFoundPage';

/**
 * Routes. Later phases add /workspace/* (Phase 3) and /s/:token (Phase 2,
 * outside the sign-in gate).
 */
export const routes: RouteObject[] = [
  {
    element: (
      <AuthGate>
        <AppShell />
      </AuthGate>
    ),
    children: [
      { path: '/', element: <ChatPage /> },
      { path: '/c/:id', element: <ChatPage /> },
      { path: '/settings', element: <SettingsPage /> },
      {
        path: '/admin',
        element: <AdminLayout />,
        children: [
          { index: true, element: <Navigate to="/admin/users" replace /> },
          { path: 'users', element: <UsersPage /> },
          { path: 'connections', element: <ConnectionsPage /> },
          { path: 'settings', element: <AdminSettingsPage /> },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

export function createRouter() {
  return createBrowserRouter(routes);
}
