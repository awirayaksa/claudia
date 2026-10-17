/**
 * Server data for the web client (RTK Query). Live run events are handled
 * separately (chat/run-slice.ts); this layer is plain request/response.
 */
import { createApi, type BaseQueryFn } from '@reduxjs/toolkit/query/react';
import { apiFetchRaw, toApiError, ApiRequestError } from './http';
import type { AdminUser, PublicUser, SessionInfo, SessionResponse } from '@shared/auth';
import type { ChatDetail, ChatSummary, CompletionRequest, CompletionResponse, Folder } from '@shared/chats';
import type { ConnectionInput, ConnectionView, ModelsResponse, UserConnectionsResponse } from '@shared/models';
import type { AdminMcpServerView, McpServerInput, McpServerView } from '@shared/mcp';
import type { LdapLookupResult, LdapSettingsResponse, LdapSettingsUpdate, LdapTestResult } from '@shared/ldap';
import type { FileView } from '@shared/files';
import type { AppSettingsResponse, UserSettingsInput } from '@shared/settings';
import type { PublicConfig } from '@shared/api';

export interface ApiErrorShape {
  status: number;
  code: string;
  message: string;
}

interface Args {
  url: string;
  method?: string;
  body?: unknown;
}

const baseQuery: BaseQueryFn<Args | string, unknown, ApiErrorShape> = async (args) => {
  const { url, method = 'GET', body } = typeof args === 'string' ? { url: args } : args;
  try {
    const res = await apiFetchRaw(`/api${url}`, { method, ...(body !== undefined ? { json: body } : {}) });
    if (!res.ok) {
      const err = await toApiError(res);
      return { error: { status: err.status, code: err.code, message: err.message } };
    }
    return { data: res.status === 204 ? undefined : await res.json() };
  } catch (err) {
    if (err instanceof ApiRequestError) return { error: { status: err.status, code: err.code, message: err.message } };
    return { error: { status: 0, code: 'network', message: err instanceof Error ? err.message : 'Network error' } };
  }
};

export const api = createApi({
  reducerPath: 'api',
  baseQuery,
  tagTypes: [
    'Session',
    'Chats',
    'Chat',
    'Folders',
    'Models',
    'AdminUsers',
    'Connections',
    'MyConnections',
    'AppSettings',
    'MySettings',
    'Sessions',
    'McpServers',
    'AdminMcpServers',
    'Ldap',
    'Files',
  ],
  endpoints: (b) => ({
    // ─── Session ────────────────────────────────────────────────────────────
    publicConfig: b.query<PublicConfig, void>({ query: () => '/public-config' }),
    session: b.query<SessionResponse, void>({ query: () => '/auth/session', providesTags: ['Session'] }),
    login: b.mutation<{ user: PublicUser }, { email: string; password: string }>({
      query: (body) => ({ url: '/auth/login', method: 'POST', body }),
      invalidatesTags: ['Session'],
    }),
    signup: b.mutation<{ user: PublicUser }, { name: string; email: string; password: string }>({
      query: (body) => ({ url: '/auth/signup', method: 'POST', body }),
      invalidatesTags: ['Session'],
    }),
    ldapLogin: b.mutation<{ user: PublicUser }, { username: string; password: string }>({
      query: (body) => ({ url: '/auth/ldap', method: 'POST', body }),
      invalidatesTags: ['Session'],
    }),
    logout: b.mutation<{ ok: true }, void>({ query: () => ({ url: '/auth/logout', method: 'POST' }) }),

    // ─── Me ─────────────────────────────────────────────────────────────────
    updateMe: b.mutation<{ user: PublicUser }, { name: string }>({
      query: (body) => ({ url: '/me', method: 'PATCH', body }),
      invalidatesTags: ['Session'],
    }),
    changePassword: b.mutation<{ ok: true }, { currentPassword: string; newPassword: string }>({
      query: (body) => ({ url: '/me/password', method: 'PUT', body }),
      invalidatesTags: ['Sessions'],
    }),
    mySettings: b.query<{ settings: UserSettingsInput }, void>({ query: () => '/me/settings', providesTags: ['MySettings'] }),
    updateMySettings: b.mutation<{ settings: UserSettingsInput }, Partial<UserSettingsInput>>({
      query: (body) => ({ url: '/me/settings', method: 'PATCH', body }),
      invalidatesTags: ['MySettings'],
    }),
    mySessions: b.query<{ sessions: SessionInfo[] }, void>({ query: () => '/me/sessions', providesTags: ['Sessions'] }),
    revokeSession: b.mutation<{ ok: true }, string>({
      query: (id) => ({ url: `/me/sessions/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Sessions'],
    }),

    // ─── Models ─────────────────────────────────────────────────────────────
    models: b.query<ModelsResponse, void>({ query: () => '/models', providesTags: ['Models'] }),

    // ─── Chats ──────────────────────────────────────────────────────────────
    chats: b.query<{ chats: ChatSummary[] }, { search?: string; archived?: boolean } | void>({
      query: (q) => {
        const p = new URLSearchParams();
        if (q?.search) p.set('search', q.search);
        if (q?.archived) p.set('archived', 'true');
        const qs = p.toString();
        return `/chats${qs ? `?${qs}` : ''}`;
      },
      providesTags: ['Chats'],
    }),
    chat: b.query<{ chat: ChatDetail }, string>({
      query: (id) => `/chats/${id}`,
      providesTags: (_r, _e, id) => [{ type: 'Chat', id }],
    }),
    createChat: b.mutation<{ chat: ChatSummary }, { folderId?: string | null; modelIds?: string[]; title?: string }>({
      query: (body) => ({ url: '/chats', method: 'POST', body }),
      invalidatesTags: ['Chats'],
    }),
    updateChat: b.mutation<
      { chat: ChatSummary },
      { id: string; title?: string; folderId?: string | null; pinned?: boolean; archived?: boolean; modelIds?: string[] }
    >({
      query: ({ id, ...body }) => ({ url: `/chats/${id}`, method: 'PATCH', body }),
      invalidatesTags: (_r, _e, { id }) => ['Chats', { type: 'Chat', id }],
    }),
    deleteChat: b.mutation<{ ok: true }, string>({
      query: (id) => ({ url: `/chats/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Chats'],
    }),
    sendCompletion: b.mutation<
      CompletionResponse,
      { chatId: string } & Omit<CompletionRequest, 'fileIds' | 'toolIds' | 'features'> &
        Partial<Pick<CompletionRequest, 'fileIds' | 'toolIds'>>
    >({
      query: ({ chatId, ...body }) => ({ url: `/chats/${chatId}/completions`, method: 'POST', body }),
    }),
    stopRun: b.mutation<{ ok: true }, string>({ query: (runId) => ({ url: `/runs/${runId}/stop`, method: 'POST' }) }),

    // ─── Tools, files and own connections ───────────────────────────────────
    mcpServers: b.query<{ servers: McpServerView[] }, void>({ query: () => '/mcp/servers', providesTags: ['McpServers'] }),
    setMcpServerEnabled: b.mutation<{ server: McpServerView }, { id: string; enabled: boolean }>({
      query: ({ id, enabled }) => ({ url: `/mcp/servers/${encodeURIComponent(id)}/${enabled ? 'enable' : 'disable'}`, method: 'POST' }),
      invalidatesTags: ['McpServers'],
    }),
    files: b.query<{ files: FileView[] }, void>({ query: () => '/files', providesTags: ['Files'] }),
    deleteFile: b.mutation<{ ok: true }, string>({
      query: (id) => ({ url: `/files/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Files'],
    }),
    myConnections: b.query<UserConnectionsResponse, void>({ query: () => '/connections', providesTags: ['MyConnections'] }),
    createMyConnection: b.mutation<{ connection: ConnectionView }, Partial<ConnectionInput>>({
      query: (body) => ({ url: '/connections', method: 'POST', body }),
      invalidatesTags: ['MyConnections', 'Models'],
    }),
    updateMyConnection: b.mutation<{ connection: ConnectionView }, { id: string } & Partial<ConnectionInput>>({
      query: ({ id, ...body }) => ({ url: `/connections/${id}`, method: 'PATCH', body }),
      invalidatesTags: ['MyConnections', 'Models'],
    }),
    deleteMyConnection: b.mutation<{ ok: true }, string>({
      query: (id) => ({ url: `/connections/${id}`, method: 'DELETE' }),
      invalidatesTags: ['MyConnections', 'Models'],
    }),
    testMyConnection: b.mutation<{ ok: boolean; error: string | null; models: string[] }, string>({
      query: (id) => ({ url: `/connections/${id}/test`, method: 'POST' }),
      invalidatesTags: ['MyConnections', 'Models'],
    }),

    // ─── Folders ────────────────────────────────────────────────────────────
    folders: b.query<{ folders: Folder[] }, void>({ query: () => '/folders', providesTags: ['Folders'] }),
    createFolder: b.mutation<{ folder: Folder }, { name: string; parentId?: string | null }>({
      query: (body) => ({ url: '/folders', method: 'POST', body }),
      invalidatesTags: ['Folders'],
    }),
    updateFolder: b.mutation<{ folder: Folder }, { id: string; name?: string; systemPrompt?: string | null }>({
      query: ({ id, ...body }) => ({ url: `/folders/${id}`, method: 'PATCH', body }),
      invalidatesTags: ['Folders'],
    }),
    deleteFolder: b.mutation<{ ok: true }, string>({
      query: (id) => ({ url: `/folders/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Folders', 'Chats'],
    }),

    // ─── Admin ──────────────────────────────────────────────────────────────
    adminUsers: b.query<{ users: AdminUser[]; total: number }, { search?: string } | void>({
      query: (q) => `/admin/users${q?.search ? `?search=${encodeURIComponent(q.search)}` : ''}`,
      providesTags: ['AdminUsers'],
    }),
    adminCreateUser: b.mutation<{ user: AdminUser }, { name: string; email: string; password: string; role: AdminUser['role'] }>({
      query: (body) => ({ url: '/admin/users', method: 'POST', body }),
      invalidatesTags: ['AdminUsers'],
    }),
    adminUpdateUser: b.mutation<{ user: AdminUser }, { id: string; role?: AdminUser['role']; name?: string; password?: string }>({
      query: ({ id, ...body }) => ({ url: `/admin/users/${id}`, method: 'PATCH', body }),
      invalidatesTags: ['AdminUsers'],
    }),
    adminDeleteUser: b.mutation<{ ok: true }, string>({
      query: (id) => ({ url: `/admin/users/${id}`, method: 'DELETE' }),
      invalidatesTags: ['AdminUsers'],
    }),
    connections: b.query<{ connections: ConnectionView[] }, void>({
      query: () => '/admin/connections',
      providesTags: ['Connections'],
    }),
    createConnection: b.mutation<{ connection: ConnectionView }, Partial<ConnectionInput>>({
      query: (body) => ({ url: '/admin/connections', method: 'POST', body }),
      invalidatesTags: ['Connections', 'Models'],
    }),
    updateConnection: b.mutation<{ connection: ConnectionView }, { id: string } & Partial<ConnectionInput>>({
      query: ({ id, ...body }) => ({ url: `/admin/connections/${id}`, method: 'PATCH', body }),
      invalidatesTags: ['Connections', 'Models'],
    }),
    deleteConnection: b.mutation<{ ok: true }, string>({
      query: (id) => ({ url: `/admin/connections/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Connections', 'Models'],
    }),
    testConnection: b.mutation<{ ok: boolean; error: string | null; models: string[] }, string>({
      query: (id) => ({ url: `/admin/connections/${id}/test`, method: 'POST' }),
      invalidatesTags: ['Connections', 'Models'],
    }),
    adminMcpServers: b.query<{ servers: AdminMcpServerView[] }, void>({
      query: () => '/admin/mcp-servers',
      providesTags: ['AdminMcpServers'],
    }),
    createMcpServer: b.mutation<{ server: AdminMcpServerView }, Partial<McpServerInput>>({
      query: (body) => ({ url: '/admin/mcp-servers', method: 'POST', body }),
      invalidatesTags: ['AdminMcpServers', 'McpServers'],
    }),
    updateMcpServer: b.mutation<{ server: AdminMcpServerView }, { id: string } & Partial<McpServerInput>>({
      query: ({ id, ...body }) => ({ url: `/admin/mcp-servers/${id}`, method: 'PATCH', body }),
      invalidatesTags: ['AdminMcpServers', 'McpServers'],
    }),
    restartMcpServer: b.mutation<{ server: AdminMcpServerView }, string>({
      query: (id) => ({ url: `/admin/mcp-servers/${id}/restart`, method: 'POST' }),
      invalidatesTags: ['AdminMcpServers', 'McpServers'],
    }),
    deleteMcpServer: b.mutation<{ ok: true }, string>({
      query: (id) => ({ url: `/admin/mcp-servers/${id}`, method: 'DELETE' }),
      invalidatesTags: ['AdminMcpServers', 'McpServers'],
    }),
    ldapSettings: b.query<LdapSettingsResponse, void>({ query: () => '/admin/ldap', providesTags: ['Ldap'] }),
    updateLdapSettings: b.mutation<LdapSettingsResponse, LdapSettingsUpdate>({
      query: (body) => ({ url: '/admin/ldap', method: 'PUT', body }),
      invalidatesTags: ['Ldap', 'Session'],
    }),
    testLdap: b.mutation<LdapTestResult, void>({ query: () => ({ url: '/admin/ldap/test', method: 'POST' }) }),
    lookupLdapUser: b.mutation<LdapLookupResult, string>({
      query: (username) => ({ url: '/admin/ldap/lookup', method: 'POST', body: { username } }),
    }),
    appSettings: b.query<{ settings: AppSettingsResponse }, void>({
      query: () => '/admin/settings',
      providesTags: ['AppSettings'],
    }),
    updateAppSetting: b.mutation<unknown, { key: keyof AppSettingsResponse; value: unknown }>({
      query: ({ key, value }) => ({ url: `/admin/settings/${key}`, method: 'PATCH', body: value }),
      invalidatesTags: ['AppSettings', 'Models', 'Session', 'McpServers', 'MyConnections'],
    }),
  }),
});

export const {
  usePublicConfigQuery,
  useSessionQuery,
  useLoginMutation,
  useLdapLoginMutation,
  useSignupMutation,
  useLogoutMutation,
  useUpdateMeMutation,
  useChangePasswordMutation,
  useMySessionsQuery,
  useRevokeSessionMutation,
  useUpdateMySettingsMutation,
  useModelsQuery,
  useChatsQuery,
  useChatQuery,
  useCreateChatMutation,
  useUpdateChatMutation,
  useDeleteChatMutation,
  useSendCompletionMutation,
  useStopRunMutation,
  useMcpServersQuery,
  useSetMcpServerEnabledMutation,
  useFilesQuery,
  useDeleteFileMutation,
  useMyConnectionsQuery,
  useCreateMyConnectionMutation,
  useUpdateMyConnectionMutation,
  useDeleteMyConnectionMutation,
  useTestMyConnectionMutation,
  useFoldersQuery,
  useCreateFolderMutation,
  useUpdateFolderMutation,
  useDeleteFolderMutation,
  useAdminUsersQuery,
  useAdminCreateUserMutation,
  useAdminUpdateUserMutation,
  useAdminDeleteUserMutation,
  useConnectionsQuery,
  useCreateConnectionMutation,
  useUpdateConnectionMutation,
  useDeleteConnectionMutation,
  useTestConnectionMutation,
  useAdminMcpServersQuery,
  useCreateMcpServerMutation,
  useUpdateMcpServerMutation,
  useRestartMcpServerMutation,
  useDeleteMcpServerMutation,
  useLdapSettingsQuery,
  useUpdateLdapSettingsMutation,
  useTestLdapMutation,
  useLookupLdapUserMutation,
  useAppSettingsQuery,
  useUpdateAppSettingMutation,
} = api;

/** A human message for an RTK Query error. */
export function errorMessage(error: unknown): string | null {
  if (!error) return null;
  const e = error as Partial<ApiErrorShape>;
  return e.message ?? 'Something went wrong.';
}
