import { createBrowserRouter, Navigate, type RouteObject } from 'react-router-dom';
import { AuthGate } from './auth/AuthGate';
import { AppShell } from './layout/AppShell';
import { ChatPage } from './pages/ChatPage';
import { SettingsPage } from './pages/SettingsPage';
import { AdminLayout } from './pages/admin/AdminLayout';
import { UsersPage } from './pages/admin/UsersPage';
import { ConnectionsPage } from './pages/admin/ConnectionsPage';
import { AdminSettingsPage } from './pages/admin/AdminSettingsPage';
import { ToolServersPage } from './pages/admin/ToolServersPage';
import { DirectoryPage } from './pages/admin/DirectoryPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { SharePage } from './pages/SharePage';

/**
 * Routes. Share links (/s/:token) are outside the sign-in gate; Phase 3
 * adds /workspace/*.
 */
export const routes: RouteObject[] = [
  { path: '/s/:token', element: <SharePage /> },
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
          { path: 'tools', element: <ToolServersPage /> },
          { path: 'directory', element: <DirectoryPage /> },
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
