/**
 * Server data for the web client (RTK Query). Live run events are handled
 * separately (chat/run-slice.ts); this layer is plain request/response.
 */
import { createApi, type BaseQueryFn } from '@reduxjs/toolkit/query/react';
import { apiFetchRaw, toApiError, ApiRequestError } from './http';
import type { AdminUser, PublicUser, SessionInfo, SessionResponse } from '@shared/auth';
import type {
  ChatDetail,
  ChatParams,
  ChatSummary,
  CompletionRequest,
  CompletionResponse,
  ExportedChat,
  Folder,
  ImportResponse,
  SharedChat,
  ShareListItem,
  ShareView,
} from '@shared/chats';
import type { ConnectionInput, ConnectionView, ModelsResponse, UserConnectionsResponse } from '@shared/models';
import type { AdminMcpServerView, McpServerInput, McpServerView } from '@shared/mcp';
import type { LdapLookupResult, LdapSettingsResponse, LdapSettingsUpdate, LdapTestResult } from '@shared/ldap';
import type { FileView } from '@shared/files';
import type { AppSettingsResponse, UserSettingsInput } from '@shared/settings';
import type { PublicConfig } from '@shared/api';
import type { KnowledgeDetail, KnowledgeInput, KnowledgeView, RagSettingsResponse, RagSettingsUpdate, SearchHit } from '@shared/knowledge';
import type {
  GrantInput,
  GrantView,
  GroupInput,
  GroupMemberView,
  GroupRef,
  GroupView,
  Permissions,
  UsageSummary,
  UserCaps,
} from '@shared/access';
import type {
  ApiKeyView,
  CreatedApiKey,
  CustomModelInput,
  CustomModelView,
  MemoryView,
  PromptInput,
  PromptView,
  UserMcpServerInput,
  UserMcpServerView,
} from '@shared/workspace';

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
    'Tags',
    'Shares',
    'WorkspaceModels',
    'Prompts',
    'Grants',
    'Memories',
    'ApiKeys',
    'Usage',
    'OwnMcp',
    'AdminGroups',
    'GroupMembers',
    'UserAccess',
    'MyGroups',
    'Knowledge',
    'Rag',
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
    chats: b.query<{ chats: ChatSummary[] }, { search?: string; archived?: boolean; tag?: string } | void>({
      query: (q) => {
        const p = new URLSearchParams();
        if (q?.search) p.set('search', q.search);
        if (q?.archived) p.set('archived', 'true');
        if (q?.tag) p.set('tag', q.tag);
        const qs = p.toString();
        return `/chats${qs ? `?${qs}` : ''}`;
      },
      providesTags: ['Chats'],
    }),
    chat: b.query<{ chat: ChatDetail }, string>({
      query: (id) => `/chats/${id}`,
      providesTags: (_r, _e, id) => [{ type: 'Chat', id }],
    }),
    tags: b.query<{ tags: Array<{ tag: string; count: number }> }, void>({ query: () => '/chats/tags', providesTags: ['Tags'] }),
    createChat: b.mutation<
      { chat: ChatSummary },
      { folderId?: string | null; modelIds?: string[]; title?: string; temporary?: boolean }
    >({
      query: (body) => ({ url: '/chats', method: 'POST', body }),
      invalidatesTags: ['Chats'],
    }),
    updateChat: b.mutation<
      { chat: ChatSummary },
      {
        id: string;
        title?: string;
        folderId?: string | null;
        pinned?: boolean;
        archived?: boolean;
        temporary?: false;
        tags?: string[];
        currentLeafId?: string;
        modelIds?: string[];
        params?: { [K in keyof ChatParams]?: ChatParams[K] | null };
      }
    >({
      query: ({ id, ...body }) => ({ url: `/chats/${id}`, method: 'PATCH', body }),
      invalidatesTags: (_r, _e, { id, tags }) => ['Chats', { type: 'Chat', id }, ...(tags ? (['Tags'] as const) : [])],
      // Switching versions shows at once
      async onQueryStarted({ id, currentLeafId }, { dispatch, queryFulfilled }) {
        if (!currentLeafId) return;
        const patch = dispatch(
          api.util.updateQueryData('chat', id, (draft) => {
            draft.chat.currentLeafId = currentLeafId;
          })
        );
        queryFulfilled.catch(patch.undo);
      },
    }),
    forkChat: b.mutation<{ chat: ChatSummary }, { id: string; messageId: string }>({
      query: ({ id, messageId }) => ({ url: `/chats/${id}/fork`, method: 'POST', body: { messageId } }),
      invalidatesTags: ['Chats'],
    }),
    rateMessage: b.mutation<
      { ok: true },
      { chatId: string; messageId: string; rating: 1 | -1 | null; comment?: string; reasons?: string[] }
    >({
      query: ({ chatId, messageId, ...body }) => ({ url: `/chats/${chatId}/messages/${messageId}/feedback`, method: 'PUT', body }),
      async onQueryStarted({ chatId, messageId, rating }, { dispatch, queryFulfilled }) {
        const patch = dispatch(
          api.util.updateQueryData('chat', chatId, (draft) => {
            const node = draft.chat.messages.find((m) => m.id === messageId);
            if (node) {
              if (rating === null) delete node.rating;
              else node.rating = rating;
            }
          })
        );
        queryFulfilled.catch(patch.undo);
      },
    }),
    shareChat: b.mutation<{ share: ShareView }, string>({
      query: (id) => ({ url: `/chats/${id}/share`, method: 'POST' }),
      invalidatesTags: (_r, _e, id) => [{ type: 'Chat', id }, 'Shares'],
    }),
    unshareChat: b.mutation<{ ok: true }, string>({
      query: (id) => ({ url: `/chats/${id}/share`, method: 'DELETE' }),
      invalidatesTags: (_r, _e, id) => [{ type: 'Chat', id }, 'Shares'],
    }),
    myShares: b.query<{ shares: ShareListItem[] }, void>({ query: () => '/shares', providesTags: ['Shares'] }),
    revokeShare: b.mutation<{ ok: true }, string>({
      query: (token) => ({ url: `/shares/${token}`, method: 'DELETE' }),
      invalidatesTags: ['Shares', 'Chat'],
    }),
    sharedChat: b.query<{ chat: SharedChat }, string>({ query: (token) => `/shared/${encodeURIComponent(token)}` }),
    importChats: b.mutation<ImportResponse, { chats: ExportedChat[] }>({
      query: (body) => ({ url: '/chats/import', method: 'POST', body }),
      invalidatesTags: ['Chats', 'Folders', 'Tags'],
    }),
    deleteChat: b.mutation<{ ok: true }, string>({
      query: (id) => ({ url: `/chats/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Chats', 'Tags', 'Shares'],
    }),
    sendCompletion: b.mutation<
      CompletionResponse,
      { chatId: string } & Omit<CompletionRequest, 'fileIds' | 'toolIds' | 'features' | 'regenerate' | 'content' | 'refs'> &
        Partial<Pick<CompletionRequest, 'fileIds' | 'toolIds' | 'regenerate' | 'content' | 'refs' | 'features'>>
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

    // ─── Workspace ──────────────────────────────────────────────────────────
    workspaceModels: b.query<{ models: CustomModelView[] }, void>({
      query: () => '/workspace/models',
      providesTags: ['WorkspaceModels'],
    }),
    createWorkspaceModel: b.mutation<{ model: CustomModelView }, Partial<CustomModelInput>>({
      query: (body) => ({ url: '/workspace/models', method: 'POST', body }),
      invalidatesTags: ['WorkspaceModels', 'Models'],
    }),
    updateWorkspaceModel: b.mutation<{ model: CustomModelView }, { id: string } & Partial<CustomModelInput>>({
      query: ({ id, ...body }) => ({ url: `/workspace/models/${id}`, method: 'PATCH', body }),
      invalidatesTags: ['WorkspaceModels', 'Models'],
    }),
    deleteWorkspaceModel: b.mutation<{ ok: true }, string>({
      query: (id) => ({ url: `/workspace/models/${id}`, method: 'DELETE' }),
      invalidatesTags: ['WorkspaceModels', 'Models'],
    }),
    prompts: b.query<{ prompts: PromptView[] }, { scope: 'usable' | 'all' }>({
      query: ({ scope }) => `/workspace/prompts?scope=${scope}`,
      providesTags: ['Prompts'],
    }),
    createPrompt: b.mutation<{ prompt: PromptView }, Partial<PromptInput>>({
      query: (body) => ({ url: '/workspace/prompts', method: 'POST', body }),
      invalidatesTags: ['Prompts'],
    }),
    updatePrompt: b.mutation<{ prompt: PromptView }, { id: string } & Partial<PromptInput>>({
      query: ({ id, ...body }) => ({ url: `/workspace/prompts/${id}`, method: 'PATCH', body }),
      invalidatesTags: ['Prompts'],
    }),
    deletePrompt: b.mutation<{ ok: true }, string>({
      query: (id) => ({ url: `/workspace/prompts/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Prompts'],
    }),
    grants: b.query<{ grants: GrantView[] }, { kind: 'models' | 'prompts' | 'knowledge'; id: string }>({
      query: ({ kind, id }) => `${kind === 'knowledge' ? '' : '/workspace'}/${kind}/${id}/access`,
      providesTags: (_r, _e, { id }) => [{ type: 'Grants', id }],
    }),
    setGrants: b.mutation<{ grants: GrantView[] }, { kind: 'models' | 'prompts' | 'knowledge'; id: string; grants: GrantInput[] }>({
      query: ({ kind, id, grants }) => ({
        url: `${kind === 'knowledge' ? '' : '/workspace'}/${kind}/${id}/access`,
        method: 'PUT',
        body: { grants },
      }),
      invalidatesTags: (_r, _e, { id }) => [{ type: 'Grants', id }, 'Models'],
    }),
    myGroups: b.query<{ groups: GroupRef[] }, void>({ query: () => '/directory/groups', providesTags: ['MyGroups'] }),
    findUsers: b.query<{ users: Array<{ id: string; name: string; email: string }> }, string>({
      query: (q) => `/directory/users?q=${encodeURIComponent(q)}`,
    }),

    // ─── Knowledge ──────────────────────────────────────────────────────────
    knowledgeList: b.query<{ knowledge: KnowledgeView[] }, void>({ query: () => '/knowledge', providesTags: ['Knowledge'] }),
    knowledge: b.query<{ knowledge: KnowledgeDetail }, string>({
      query: (id) => `/knowledge/${id}`,
      providesTags: (_r, _e, id) => [{ type: 'Knowledge', id }],
    }),
    createKnowledge: b.mutation<{ knowledge: KnowledgeView }, Partial<KnowledgeInput>>({
      query: (body) => ({ url: '/knowledge', method: 'POST', body }),
      invalidatesTags: ['Knowledge'],
    }),
    updateKnowledge: b.mutation<{ knowledge: KnowledgeView }, { id: string } & Partial<KnowledgeInput>>({
      query: ({ id, ...body }) => ({ url: `/knowledge/${id}`, method: 'PATCH', body }),
      invalidatesTags: ['Knowledge'],
    }),
    deleteKnowledge: b.mutation<{ ok: true }, string>({
      query: (id) => ({ url: `/knowledge/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Knowledge'],
    }),
    addKnowledgeFile: b.mutation<{ ok: true }, { id: string; fileId: string }>({
      query: ({ id, fileId }) => ({ url: `/knowledge/${id}/files`, method: 'POST', body: { fileId } }),
      invalidatesTags: ['Knowledge'],
    }),
    removeKnowledgeFile: b.mutation<{ ok: true }, { id: string; fileId: string }>({
      query: ({ id, fileId }) => ({ url: `/knowledge/${id}/files/${fileId}`, method: 'DELETE' }),
      invalidatesTags: ['Knowledge'],
    }),
    reindexKnowledge: b.mutation<{ ok: true }, string>({
      query: (id) => ({ url: `/knowledge/${id}/reindex`, method: 'POST' }),
      invalidatesTags: ['Knowledge'],
    }),
    searchKnowledge: b.mutation<{ hits: SearchHit[] }, { id: string; query: string }>({
      query: ({ id, query }) => ({ url: `/knowledge/${id}/search`, method: 'POST', body: { query } }),
    }),
    ragSettings: b.query<RagSettingsResponse, void>({ query: () => '/admin/rag', providesTags: ['Rag'] }),
    updateRagSettings: b.mutation<RagSettingsResponse & { reindexing: boolean }, RagSettingsUpdate>({
      query: (body) => ({ url: '/admin/rag', method: 'PUT', body }),
      invalidatesTags: ['Rag', 'Knowledge', 'Session'],
    }),
    testEmbeddings: b.mutation<{ ok: boolean; error: string | null; dims: number | null }, void>({
      query: () => ({ url: '/admin/rag/test-embeddings', method: 'POST' }),
    }),

    // ─── Memory, API keys, usage, own tool servers ──────────────────────────
    memories: b.query<{ memories: MemoryView[] }, void>({ query: () => '/me/memories', providesTags: ['Memories'] }),
    addMemory: b.mutation<{ memory: MemoryView }, string>({
      query: (content) => ({ url: '/me/memories', method: 'POST', body: { content } }),
      invalidatesTags: ['Memories'],
    }),
    updateMemory: b.mutation<{ memory: MemoryView }, { id: string; content: string }>({
      query: ({ id, content }) => ({ url: `/me/memories/${id}`, method: 'PATCH', body: { content } }),
      invalidatesTags: ['Memories'],
    }),
    deleteMemory: b.mutation<{ ok: true }, string>({
      query: (id) => ({ url: `/me/memories/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Memories'],
    }),
    clearMemories: b.mutation<{ ok: true }, void>({
      query: () => ({ url: '/me/memories', method: 'DELETE' }),
      invalidatesTags: ['Memories'],
    }),
    apiKeys: b.query<{ keys: ApiKeyView[]; allowed: boolean }, void>({ query: () => '/me/api-keys', providesTags: ['ApiKeys'] }),
    createApiKey: b.mutation<CreatedApiKey, { name: string; expiresInDays: number | null }>({
      query: (body) => ({ url: '/me/api-keys', method: 'POST', body }),
      invalidatesTags: ['ApiKeys'],
    }),
    deleteApiKey: b.mutation<{ ok: true }, string>({
      query: (id) => ({ url: `/me/api-keys/${id}`, method: 'DELETE' }),
      invalidatesTags: ['ApiKeys'],
    }),
    myUsage: b.query<{ usage: UsageSummary }, void>({ query: () => '/me/usage', providesTags: ['Usage'] }),
    ownMcpServers: b.query<{ servers: UserMcpServerView[]; allowed: boolean }, void>({
      query: () => '/mcp/own',
      providesTags: ['OwnMcp'],
    }),
    createOwnMcpServer: b.mutation<{ server: UserMcpServerView }, Partial<UserMcpServerInput>>({
      query: (body) => ({ url: '/mcp/own', method: 'POST', body }),
      invalidatesTags: ['OwnMcp', 'McpServers'],
    }),
    updateOwnMcpServer: b.mutation<{ server: UserMcpServerView }, { id: string } & Partial<UserMcpServerInput>>({
      query: ({ id, ...body }) => ({ url: `/mcp/own/${id}`, method: 'PATCH', body }),
      invalidatesTags: ['OwnMcp', 'McpServers'],
    }),
    deleteOwnMcpServer: b.mutation<{ ok: true }, string>({
      query: (id) => ({ url: `/mcp/own/${id}`, method: 'DELETE' }),
      invalidatesTags: ['OwnMcp', 'McpServers'],
    }),

    // ─── Folders ────────────────────────────────────────────────────────────
    folders: b.query<{ folders: Folder[] }, void>({ query: () => '/folders', providesTags: ['Folders'] }),
    createFolder: b.mutation<{ folder: Folder }, { name: string; parentId?: string | null }>({
      query: (body) => ({ url: '/folders', method: 'POST', body }),
      invalidatesTags: ['Folders'],
    }),
    updateFolder: b.mutation<
      { folder: Folder },
      { id: string; name?: string; parentId?: string | null; systemPrompt?: string | null; knowledgeIds?: string[] }
    >({
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
    adminUpdateUser: b.mutation<
      { user: AdminUser },
      { id: string; role?: AdminUser['role']; name?: string; password?: string; caps?: UserCaps | null }
    >({
      query: ({ id, ...body }) => ({ url: `/admin/users/${id}`, method: 'PATCH', body }),
      invalidatesTags: ['AdminUsers', 'UserAccess'],
    }),
    adminUserAccess: b.query<
      {
        groups: Array<GroupRef & { source: 'manual' | 'ldap' }>;
        caps: UserCaps | null;
        permissions: Permissions;
        usage: UsageSummary;
      },
      string
    >({
      query: (id) => `/admin/users/${id}/access`,
      providesTags: (_r, _e, id) => [{ type: 'UserAccess', id }],
    }),
    adminSetUserGroups: b.mutation<{ ok: true }, { id: string; groupIds: string[] }>({
      query: ({ id, groupIds }) => ({ url: `/admin/users/${id}/groups`, method: 'PUT', body: { groupIds } }),
      invalidatesTags: ['UserAccess', 'AdminGroups', 'GroupMembers'],
    }),
    adminGroups: b.query<{ groups: GroupView[] }, void>({ query: () => '/admin/groups', providesTags: ['AdminGroups'] }),
    createGroup: b.mutation<{ group: GroupView }, Partial<GroupInput>>({
      query: (body) => ({ url: '/admin/groups', method: 'POST', body }),
      invalidatesTags: ['AdminGroups', 'MyGroups'],
    }),
    updateGroup: b.mutation<{ group: GroupView }, { id: string } & Partial<GroupInput>>({
      query: ({ id, ...body }) => ({ url: `/admin/groups/${id}`, method: 'PATCH', body }),
      invalidatesTags: ['AdminGroups', 'MyGroups', 'UserAccess', 'Session', 'Models'],
    }),
    deleteGroup: b.mutation<{ ok: true }, string>({
      query: (id) => ({ url: `/admin/groups/${id}`, method: 'DELETE' }),
      invalidatesTags: ['AdminGroups', 'MyGroups', 'UserAccess', 'Session', 'Models'],
    }),
    groupMembers: b.query<{ members: GroupMemberView[] }, string>({
      query: (id) => `/admin/groups/${id}/members`,
      providesTags: (_r, _e, id) => [{ type: 'GroupMembers', id }],
    }),
    addGroupMember: b.mutation<{ ok: true }, { id: string; userId: string }>({
      query: ({ id, userId }) => ({ url: `/admin/groups/${id}/members`, method: 'POST', body: { userId } }),
      invalidatesTags: ['GroupMembers', 'AdminGroups', 'UserAccess'],
    }),
    removeGroupMember: b.mutation<{ ok: true }, { id: string; userId: string }>({
      query: ({ id, userId }) => ({ url: `/admin/groups/${id}/members/${userId}`, method: 'DELETE' }),
      invalidatesTags: ['GroupMembers', 'AdminGroups', 'UserAccess'],
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
      invalidatesTags: ['AppSettings', 'Models', 'Session', 'McpServers', 'MyConnections', 'Usage', 'ApiKeys', 'OwnMcp'],
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
  useMySettingsQuery,
  useModelsQuery,
  useChatsQuery,
  useChatQuery,
  useCreateChatMutation,
  useTagsQuery,
  useForkChatMutation,
  useRateMessageMutation,
  useShareChatMutation,
  useUnshareChatMutation,
  useMySharesQuery,
  useRevokeShareMutation,
  useSharedChatQuery,
  useImportChatsMutation,
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
  useWorkspaceModelsQuery,
  useCreateWorkspaceModelMutation,
  useUpdateWorkspaceModelMutation,
  useDeleteWorkspaceModelMutation,
  usePromptsQuery,
  useCreatePromptMutation,
  useUpdatePromptMutation,
  useDeletePromptMutation,
  useGrantsQuery,
  useSetGrantsMutation,
  useMyGroupsQuery,
  useFindUsersQuery,
  useMemoriesQuery,
  useAddMemoryMutation,
  useUpdateMemoryMutation,
  useDeleteMemoryMutation,
  useClearMemoriesMutation,
  useApiKeysQuery,
  useCreateApiKeyMutation,
  useDeleteApiKeyMutation,
  useMyUsageQuery,
  useOwnMcpServersQuery,
  useCreateOwnMcpServerMutation,
  useUpdateOwnMcpServerMutation,
  useDeleteOwnMcpServerMutation,
  useAdminUserAccessQuery,
  useAdminSetUserGroupsMutation,
  useAdminGroupsQuery,
  useCreateGroupMutation,
  useUpdateGroupMutation,
  useDeleteGroupMutation,
  useGroupMembersQuery,
  useAddGroupMemberMutation,
  useRemoveGroupMemberMutation,
  useKnowledgeListQuery,
  useKnowledgeQuery,
  useCreateKnowledgeMutation,
  useUpdateKnowledgeMutation,
  useDeleteKnowledgeMutation,
  useAddKnowledgeFileMutation,
  useRemoveKnowledgeFileMutation,
  useReindexKnowledgeMutation,
  useSearchKnowledgeMutation,
  useRagSettingsQuery,
  useUpdateRagSettingsMutation,
  useTestEmbeddingsMutation,
} = api;

/** The signed-in user's permissions (all false until known). */
export function usePermissions(): Permissions | null {
  const { data } = api.useSessionQuery();
  return data?.permissions ?? null;
}

/** A human message for an RTK Query error. */
export function errorMessage(error: unknown): string | null {
  if (!error) return null;
  const e = error as Partial<ApiErrorShape>;
  return e.message ?? 'Something went wrong.';
}
