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
import { GroupsPage } from './pages/admin/GroupsPage';
import { WorkspaceLayout } from './pages/workspace/WorkspaceLayout';
import { ModelsPage } from './pages/workspace/ModelsPage';
import { PromptsPage } from './pages/workspace/PromptsPage';
import { KnowledgePage } from './pages/workspace/KnowledgePage';
import { RagSettingsPage } from './pages/admin/RagSettingsPage';

/** Routes. Share links (/s/:token) are outside the sign-in gate. */
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
        path: '/workspace',
        element: <WorkspaceLayout />,
        children: [
          { index: true, element: <Navigate to="/workspace/models" replace /> },
          { path: 'models', element: <ModelsPage /> },
          { path: 'prompts', element: <PromptsPage /> },
          { path: 'knowledge', element: <KnowledgePage /> },
          { path: 'knowledge/:id', element: <KnowledgePage /> },
        ],
      },
      {
        path: '/admin',
        element: <AdminLayout />,
        children: [
          { index: true, element: <Navigate to="/admin/users" replace /> },
          { path: 'users', element: <UsersPage /> },
          { path: 'groups', element: <GroupsPage /> },
          { path: 'connections', element: <ConnectionsPage /> },
          { path: 'tools', element: <ToolServersPage /> },
          { path: 'directory', element: <DirectoryPage /> },
          { path: 'knowledge', element: <RagSettingsPage /> },
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
