# Claudia Web — Implementation Plan

> **Revision 2 — 2026-10-17.** Updated after a review checked against the code: PostgreSQL-only data layer, security hardening (sandbox origin, SSRF guard, document parsing, LDAP), a turn-based message model, browser-executed tools, Phases 0 and 1 split with exit criteria, and explicit non-goals. The desktop MCP-UI sandbox issue is recorded under [Known issues](#known-issues-in-the-desktop-app) and deliberately not scheduled.

## Context
Claudia is a single-user Electron chat client (React 18 + Redux Toolkit + Tailwind + Vite 5). It has strong MCP support (stdio, HTTP and SSE servers, plus built-in filesystem, msoffice, diagram and fetch servers), skills, an effort selector, MCP-UI and profiles. The goal is a **multi-user, self-hostable web version** comparable to Open WebUI (FastAPI + SvelteKit; RBAC, RAG, model builder, multi-model chat, sharing, admin). It lives in this **separate `web/` folder** and reuses as much of the desktop `src/` as is practical.

Verified facts the design rests on:
- The renderer calls LLM providers directly. That only works because CORS checks are off (`webSecurity: false`, `electron/main.ts:321`). The web app must call providers from the server, which also keeps API keys out of the browser.
- The provider classes (`src/services/api/providers/*`, `src/services/api/streaming.service.ts`) use only `fetch`, axios and `eventsource-parser`, so they run on Node unchanged. Only `src/services/api/provider.service.ts` is client-only, because it imports the store singleton.
- `electron/services/mcp.service.ts` has no Electron imports and can run on the server. `skill.service.ts`, `store.service.ts` and the plugin services import Electron and cannot.
- `src/` calls `window.electron` about 115 times across 26 files.
- There is no test runner and no pull-request CI; the only workflow is `.github/workflows/release.yml`.

## Decisions
| Area | Decision |
|---|---|
| Backend | Node/TypeScript with Fastify 5 |
| Code sharing | `web/` reuses `../src` through aliases and a platform adapter. No monorepo restructure |
| Users | Multi-user with RBAC: admin, user and pending roles, plus groups. Login with local accounts or LDAP/AD |
| Database | **PostgreSQL only** (pgvector, tsvector, jsonb). PGlite runs the same Postgres dialect, used only for development, unit tests and single-container trials |
| Scope | RAG/knowledge, model builder & prompts, rich chat UX, admin & sharing |
| What is shared | Rendering features (LaTeX, Mermaid, citations, artifact rendering) go into shared `src/` and ship to desktop too. Data-model features (message tree, multi-model, sharing, RBAC) are web-only unless the desktop later migrates its conversation format |
| Web state | Server data lives in RTK Query (part of `@reduxjs/toolkit`) plus a run-event reducer. Desktop slices are reused only where they fit: `settings` (preferences and appearance), `ui`, `mcp`, `plugins` and `skills` |
| Message model | One assistant node per turn, holding ordered parts (see [Message model](#message-model)) |
| Desktop MCP-UI sandbox issue | Noted only, not fixed now. The web app must not inherit it |

## Known issues in the desktop app
**MCP-UI iframes can reach the app (sandbox escape).** Status: noted, not scheduled (decision 2026-10-17).
- `src/components/chat/UIResourceDisplay.tsx:93` passes `sandboxPermissions: 'allow-scripts allow-forms allow-same-origin allow-popups'`. `@mcp-ui/client` 5.17.1 adds these to its own `allow-scripts` default for inline (`srcDoc`) rendering (`node_modules/@mcp-ui/client/dist/index.mjs:218`, `:323`).
- An inline iframe that has both scripts and same-origin can script its parent page. HTML from any MCP server could then do either of these:
  - call `parent.electron.config.get()`, which returns decrypted API keys (`electron/handlers/config.handler.ts:15`);
  - call `mcp.saveConfig` and then `mcp.startServer`, which runs any stdio command.
- This has not been confirmed with a proof of concept.
- Likely fix when scheduled: drop `allow-same-origin`, which may break UI resources that use browser storage. Alternatively, use mcp-ui's proxy mode with a separate origin.
- **Web impact:** none, provided two things hold:
  - the web app gets its iframe settings from `platform.uiSandbox` (Phase 0b);
  - it renders MCP-UI from the sandbox origin (Phase 1b).

  The web app must never reuse the desktop value.

## Feature gap: desktop vs Open WebUI → Claudia Web phase
| Feature | Desktop | Open WebUI | Web phase |
|---|---|---|---|
| Streaming, markdown, code, reasoning, effort, token/cost stats | ✅ | ✅ | 1a |
| Projects → folders, pin/star, rename, AI titles | ✅ | ✅ | 1a |
| Multi-user auth, roles (admin/user/pending), admin user management | ❌ | ✅ | 1a |
| Per-user rate limits, model allowlists | ❌ | ✅ | 1a (usage caps in 3) |
| Mobile/responsive layout | ❌ | ✅ | 1a |
| MCP (stdio/HTTP/built-in), MCP-UI, skills/slash commands | ✅ | HTTP only (stdio via mcpo) | 1b |
| LDAP / Active Directory login | ❌ | ✅ | 1b (group sync in 3) |
| Non-image attachments reach the model | ❌ (bug) | ✅ | 0a (desktop) / 1b (web) |
| Full-text search | titles only | ✅ | 2 |
| LaTeX, Mermaid | ❌ | ✅ | 2 (shared, ships to desktop) |
| Message versions / branch tree, regenerate as sibling, ratings | branch → new chat | ✅ | 2 |
| Multi-model compare, follow-up suggestions, temporary chats, message queue | ❌ | ✅ | 2 |
| Tags, archive, nested folders, export/import, share links | ❌ | ✅ | 2 |
| Per-chat parameters and system prompt | global only | ✅ | 2 |
| Model builder, prompt library with variables, memory | ❌ | ✅ | 3 (knowledge binding and memory retrieval in 4) |
| Groups, access grants, API keys, OpenAI-compatible API, usage caps | ❌ | ✅ | 3 |
| Knowledge bases, hybrid search, rerank, citations, full-context mode | ❌ | ✅ | 4 |
| Web search, `#url`, `#chat` references, YouTube transcripts | fetch tool only | ✅ | 4 |
| External extraction / OCR engines (Tika, Docling) | ❌ | ✅ | 4 (optional loaders) |
| Artifacts, code interpreter | ❌ | ✅ | 5 |
| Image generation, speech-to-text, text-to-speech | ❌ | ✅ | 5 |
| Native Anthropic and Ollama providers, OpenAPI tool servers, web plugins | Anthropic via opencode-go | ✅ | 5 |
| Usage analytics, webhooks, banners, audit log | ❌ | ✅ | 6 |
| Redis multi-instance, S3 storage, PWA, translated shared UI | ❌ | ✅ | 6 (i18n set up in 1a) |
| OIDC/OAuth SSO, TOTP MFA, SCIM | ❌ | ✅ | 7 (optional) |
| Arena/ELO, notes, channels, scheduled prompts, Google Drive/OneDrive pickers | ❌ | ✅ | 7 (optional) |
| Python Tools/Functions, Pipelines, community hub, sub-agents | ❌ | ✅ | Non-goal |

Claudia-only features to keep: MCP-UI rendering, inline effort syntax, skills, built-in Office and diagram tools (sandboxed per user), text-selection Explain/Ask, and profiles (which become per-user settings).

## Non-goals
- **Running user-written code inside the server.** This rules out Open WebUI's Python Tools and Functions (filters, pipes, actions) and Pipelines. Extensibility comes instead from MCP servers, OpenAPI tool servers and admin-installed ESM render plugins.
- A community hub for tools and functions.
- Sub-agents. Revisit after Phase 5.
- Per-user isolated terminals or containers, which are an Open WebUI enterprise feature.
- SQLite support.

## Architecture

### Folder layout
```
web/
  PLAN.md
  package.json            # server + client deps, incl. every bare import/require used by shared ../src and ../electron/services code
  tsconfig.base.json  tsconfig.client.json  tsconfig.server.json
  vite.config.ts  tailwind.config.js  postcss.config.cjs  index.html  drizzle.config.ts
  scripts/check-shared-deps.mjs     # CI: shared code's imports/require() exist in web/package.json with compatible versions
  shared/                 # API contract: zod DTOs + run-event union (built on ../src/types)
  client/
    main.tsx  App.web.tsx  router.tsx     # /login /c/:id /workspace/* /admin/* /s/:token
    platform/web.platform.ts
    api/{http.ts, ws.ts, rtk-api.ts}      # RTK Query endpoints for server data
    chat/{run-stream.ts, run-reducer.ts, client-tools.ts}
    i18n/                                 # react-i18next, English from day one
    layout/ pages/ components/            # responsive shell and web-only screens
  server/
    index.ts  app.ts  config.ts           # zod-validated env
    db/{client.ts, schema/*.ts, migrations/}   # PostgreSQL (postgres.js) or PGlite (embedded mode)
    auth/{providers/{local,ldap}.ts, tokens.ts, csrf.ts, rbac.ts, rate-limit.ts, bootstrap.ts}
    crypto/{keys.ts, secrets.ts}          # HKDF-derived keys, AES-256-GCM
    net/safe-fetch.ts                     # SSRF guard for every user-controlled outbound URL
    modules/<name>/{routes,service,repo}.ts  # users groups connections models chats folders tags files
                                             # knowledge prompts memories mcp shares admin analytics webhooks audio images search
    llm/{provider-registry.ts, chat-orchestrator.ts, run-hub.ts, client-tools.ts, tasks.ts}
    mcp/{mcp-pool.ts, builtin.ts}
    extract/{pool.ts, workers/*}          # document parsing in worker threads with limits
    rag/{chunk.ts, embed/*, vector.ts, lexical.ts, retrieve.ts, rerank.ts, websearch/*}
    storage/{local.ts, s3.ts}  jobs/queue.ts  ws/gateway.ts
  sandbox/                # static pages served from CLAUDIA_SANDBOX_ORIGIN (MCP-UI proxy, artifact host, file previews)
  e2e/                    # Playwright
  docker/{Dockerfile, docker-compose.yml (app + pgvector/pgvector:pg16 + SearXNG), compose.ldap.yml (OpenLDAP + seed LDIF)}
```

### Reusing `../src` safely
- **Vite** (`web/vite.config.ts`):
  - Aliases: `@` → `../src`, `@web` → `client`, `@shared` → `shared`.
  - `resolve.dedupe` for react, react-dom, react-redux, @reduxjs/toolkit, react-markdown, @mcp-ui/client, framer-motion and the @radix-ui packages.
  - `server.fs.allow: ['..']`.
  - A small `resolveSharedFromWeb()` plugin that resolves bare imports from files under `../src` against `web/`. This stops a second React/Redux copy being pulled from the root `node_modules`, and lets Docker build without the desktop dependencies.
- **TypeScript** (`tsconfig.client.json`):
  - include `client`, `shared` and `../src`, excluding `../src/main.tsx`;
  - `paths`: `{"@/*": ["../src/*"], "*": ["./node_modules/*", "./node_modules/@types/*"]}`, so shared files pick up `web/`'s type packages.
- **Tailwind:**
  - write `import base from '../tailwind.config.js'`, then `presets: [base]`. The root config uses `export default`, so `require` would return `{ default }`;
  - content includes `../src/**/*.{ts,tsx}`;
  - the client imports `@/styles/globals.css`.
- **Server build:**
  - `tsx` in development, `tsup` in production with `format: 'cjs'`. CommonJS is needed because the built-in MCP servers call `require()` (e.g. `electron/services/builtin-mcp/filesystem.server.ts:7-13`).
  - Bundle only first-party code: `server/`, `shared/`, `../src`, `../electron/services`.
  - Keep every `node_modules` package external so it loads from `web/node_modules` at runtime. Bundling `pdf-parse`, for example, triggers its debug code path and crashes.
- **Dependencies:**
  - `sharp` is a root devDependency, but `electron/services/builtin-mcp/diagram.server.ts:25` needs it at runtime, so it becomes a `web/` dependency.
  - `check-shared-deps.mjs` scans `../src` and `../electron/services` for `import` and `require()`. It fails when a package is missing from `web/package.json` or when its version range doesn't overlap the root's. Matching versions matter because in development `tsx` resolves shared files' imports from the root `node_modules`.
- **Docker:** copy `src/`, `electron/services/`, the root `tailwind.config.js` and `web/`, then run `npm ci` in `web/` only.

### What the web app shares
| Layer | Shared with web | Desktop-only | Web-only |
|---|---|---|---|
| Types, utils | `src/types/*`, `src/utils/*` | — | `web/shared/*` contract |
| LLM providers | `src/services/api/providers/*` and the consolidated stream parser (used server-side) | `provider.service.ts`, `ProviderFactory` use in `ApiSettings` | `server/llm/provider-registry.ts` |
| Pure modules | `sse-parser.ts`, `message-builder.ts`, `tool-format.ts`, `context-budget.ts`, `skill-core.ts` | — | — |
| State | `settings` (preferences, appearance), `ui`, `mcp`, `plugins`, `skills` slices, new `composer` slice | `chat`, `conversation`, `project` slices, `settings.api` | `auth`, RTK Query API, run reducer |
| Chat components | `MarkdownRenderer`, `ChatMessage`, `StreamingMessage`, `ToolCallMessage`, `ReasoningMessage`, `MessageStatistics`, `TokenUsageIndicator`, `EffortSelector`, `CompactModelSelector`, `MessageAttachment`, `SkillMentionDropdown`, `SuggestedPrompts`, `TextSelectionMenu`, `UIResourceDisplay`, `ChatInput`, `MCPServerBadge(s)`, `ClaudiaAvatar` | `ChatWindow` (autosave, titles), `FilesystemDirectoryBar`, `FileMentionDropdown` | `WebChatWindow`, version switcher, multi-model columns |
| Sidebar, layout | `ConversationItem`, `common/*` | `MainLayout`, `TitleBar`, `ProjectSelector`, `ConversationList`, `UpdateNotification` | responsive shell, folder tree |
| Settings | `ThemeSettings` (minus icon section), `PreferencesSettings`, `SkillSettings`, `MCPSettings`, `MCPServerModal`, `BuiltinMCPSection`, `PluginSettings` | `ApiSettings` and the `*ConfigForm` components (they edit plaintext keys, e.g. `OpenWebUIConfigForm.tsx:83`), `ModelSelector`, `ProfilesSettings`, `ProfileSwitcher` | connections admin, users/groups admin, LDAP settings |

### Platform adapter (Phase 0b)
New files `src/platform/{types.ts, index.ts, electron.ts}` provide `setPlatform()` and `getPlatform()`. `electron.ts` is a thin pass-through over `window.electron` that keeps today's `{ success, data, error }` return shape, so the edits are mechanical.

Only code the web app reuses goes through the adapter (the "Shared with web" column above). Desktop-only files may keep calling `window.electron`. An ESLint `no-restricted-properties` rule bans it everywhere else.

```ts
interface ClaudiaPlatform {
  capabilities: { kind: 'electron' | 'web'; windowControls; nativeMenu; autoUpdate; appIcon;
                  localFilesystem; stdioMcp; diskPlugins; auth; profiles };
  config; mcp; plugins; skills;                    // same method names as the preload today
  tools: { uiAction(req): Promise<ToolResult> };   // MCP-UI actions (desktop: current executeUIAction logic)
  llm: { complete(req): Promise<string> };         // titles, suggested prompts, text-selection Explain/Ask
  files: { upload(file, onProgress): Promise<Attachment>; pick?(): Promise<File[]> };
  events: { on(event, cb): () => void };           // mcp.*, plugin.*, skill.changed, menu.*
  uiSandbox: { sandboxPermissions: string; proxyUrl?: string };  // iframe settings for MCP-UI
  window?; updater?; icon?; systemPrompt?;
}
```

Changes in `src/`:
- **Route the shared code through `getPlatform()`:**
  - slices: `mcpSlice`, `pluginSlice`, `skillSlice`;
  - hooks: `usePlugins`, `useAccentColor`, `useTheme`, `useAppTitle`, `useLoadSettingsFromStore`;
  - components: `ThemeSettings`, `PreferencesSettings`, `MCPSettings`, `SkillSettings`, `PluginSettings`;
  - types: `src/types/plugin.types.ts` (`electron?` becomes `platform?`).
- **LLM calls outside the chat go through `platform.llm.complete`:**
  - `SuggestedPrompts.tsx:108`;
  - `TextSelectionMenu.tsx:165`, which also stops reading the model from `settings.api` (`:54`) and receives it as a prop instead.
- **Uploads go through `platform.files.upload`.** `src/hooks/useFileUpload.ts` currently always uploads to Open WebUI using `settings.api`. `ChatInput` shows the `@file` mention only when `capabilities.localFilesystem` is set.
- **`UIResourceDisplay`** takes its sandbox settings from `platform.uiSandbox` and sends actions through `platform.tools.uiAction`. On desktop, `uiSandbox` returns today's value unchanged (see Known issues).
- **New `composer` slice:** move `effortLevel` and `filesystemDirectory` out of `chatSlice` so `ChatInput` no longer depends on the desktop chat slice (`ChatInput.tsx:75-80`).
- **`MCPServerBadge`** stops dispatching `chat/clearMessages` itself; its parent decides.
- **Store factory:** `src/store/index.ts` becomes `createAppStore(extraReducers)` using RTK 2 `combineSlices`. Desktop keeps exporting `store`. This also removes the circular import in `provider.service.ts`.
- **Dropped from revision 1:** extracting the desktop tool loop into a `LocalChatEngine`. The desktop keeps its loop in `chatSlice` and switches to the shared pure modules below.

Pure modules, used by both desktop and server:
- **`src/services/api/sse-parser.ts`:** one OpenAI-compatible stream parser replacing the four copies (`streaming.service.ts` and the `custom`, `openrouter` and `opencode-go` providers).
  - Completion fires exactly once and reports why the stream ended: `stop`, `tool_calls`, `length`, `aborted` or `error`.
  - Today `onComplete` fires on `[DONE]`, again when the stream ends (`streaming.service.ts:82`, `:178`), and also on abort.
- **`src/services/chat/message-builder.ts`:** `buildAPIMessage` and `buildMessageContent`, plus `toOpenAIMessages(turns)` for the turn model. It keeps the existing Kimi and DeepSeek normalization rules (`chatSlice.ts:56-114`).
- **`src/services/mcp/tool-format.ts`:**
  - `mcpToolsToOpenAI` and `cleanJsonSchema`;
  - result normalization;
  - an inline `ui://` check, with no `@mcp-ui/client` import;
  - the tool alias builder (created in Phase 0a, see [MCP](#mcp)).
- **`src/services/chat/context-budget.ts`:** fits the system prompt, history, documents and memory into the model's context window using `src/utils/modelContextLimits.ts`.
- **`electron/services/skill-core.ts`:** built-in skills, frontmatter parse/serialize and `resolveSkillInvocation`. It is split out of `skill.service.ts` and has no Electron import.

### Message model
The desktop stores a tool-using reply as several flat records:
- an assistant message with `toolCalls`;
- one `role: 'tool'` message per result;
- then the final assistant message (`chatSlice.ts:717-813`).

The web app stores one node per turn instead:

```ts
type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'file'; fileId: string; name: string; mime: string }      // user attachments, incl. images
  | { type: 'tool_call'; callId: string; alias: string; serverId: string; tool: string; args: string }
  | { type: 'tool_result'; callId: string; content: string; isError?: boolean; uiResource?: UIResourceContent }
  | { type: 'citation'; index: number; source: CitationSource };

interface MessageNode {
  id: string; chatId: string; parentId: string | null;
  role: 'user' | 'assistant' | 'system';
  parts: MessagePart[];
  modelId?: string; usage?: MessageUsage; effort?: ReasoningEffort;
  status: 'streaming' | 'completed' | 'stopped' | 'error';
  rating?: 1 | -1; createdAt: string;
}
```
- **Siblings are alternatives.** A user node's children are alternative replies: regenerations and multi-model answers. Editing a user message creates a sibling user node.
- **Visible path.** `chats.current_leaf_id` selects the path shown; the version switcher moves it.
- **Wire format.** `toOpenAIMessages` expands an assistant node into assistant `tool_calls` → `tool` messages → final assistant. Providers therefore see exactly what the desktop sends today.
- **Desktop import.** Each run of assistant and tool records between two user messages becomes one assistant node.

### Server

#### Database
- **Schema:** one Drizzle schema (`pgTable`) and one drizzle-kit migration set. `uuid` ids (UUIDv7 generated in the app), `timestamptz`, `jsonb`.
- **Production:** PostgreSQL 16+ with the pgvector extension (`pgvector/pgvector:pg16` in compose), using the `postgres` driver (postgres.js).
- **Embedded mode:** PGlite with its pgvector extension (`drizzle-orm/pglite`), using the same schema and migrations. It is for development, unit tests and single-container trials only. PGlite runs one query at a time, so it is not for multi-user production.
- **Vectors:** pgvector with HNSW indexes and one embeddings table per dimension. Use `halfvec` for models over 2,000 dimensions, which is the HNSW limit for `vector` (e.g. 3,072-dimension embeddings).
- **Full-text search:** generated `tsvector` columns with GIN indexes, for messages from Phase 2 and for chunks from Phase 4.
- **Jobs:** a `jobs` table processed with `SELECT … FOR UPDATE SKIP LOCKED`. Workers are woken by `LISTEN/NOTIFY` on real Postgres; with PGlite they poll.
- **Backups:** documented `pg_dump`, plus the file-storage volume.

Tables:
- **Identity:**
  - `users`(id, email unique, name, password_hash (null for LDAP users), role admin/user/pending, settings jsonb, last_active_at)
  - `sessions`(id, user_id, refresh_hash, ua, ip, expires_at, revoked_at, last_verified_at)
  - `api_keys`(id, user_id, prefix, key_hash, scopes, expires_at)
  - `auth_identities`(user_id, provider local/ldap/oidc, subject, unique(provider, subject))
- **RBAC:**
  - `groups`(id, name, permissions jsonb, ldap_dn)
  - `group_members`(group_id, user_id, source manual/ldap)
  - `access_grants`(resource_type, resource_id, principal_type user/group/public, principal_id, perm read/write). This is the only access mechanism; no table has its own `access` column.
- **LLM:**
  - `provider_connections`(id, owner_id (null = global), type, base_url, key_cipher, key_version, quirks jsonb, model_filter)
  - `models`(id, base_model_id, connection_id, owner_id, name, avatar, system_prompt, params jsonb, tool_ids, knowledge_ids, capabilities, suggestions, active)
- **Chats:**
  - `folders`(id, user_id, parent_id, name, system_prompt, knowledge_ids). Desktop projects import as top-level folders.
  - `chats`(id, user_id, folder_id, title, model_ids, current_leaf_id, params jsonb, pinned, archived, temporary, tsv)
  - `messages`(id, chat_id, parent_id, role, parts jsonb, model_id, usage jsonb, effort, status, rating, feedback, created_at, tsv)
  - `tags`, `chat_tags`
  - `shared_chats`(token, chat_id, snapshot jsonb, expires_at, revoked_at)
- **Files and RAG:**
  - `files`(id, user_id, name, mime, size, sha256, storage_key, status, extracted_text_key)
  - `knowledge_bases`(id, owner_id, embed_model, dims, chunk_cfg)
  - `kb_files`
  - `chunks`(id, file_id, kb_id, ord, text, tokens, meta jsonb, tsv)
  - `chunk_embeddings_<dims>`(chunk_id, embedding)
  - `jobs`(type, payload, status, attempts, run_after, error)
- **Library:**
  - `prompts`(id, owner_id, command, title, body, variables jsonb, mode insert/system). Skills are rows with mode `system`, seeded from `skill-core.ts`.
  - `memories`(id, user_id, content, created_at), with embeddings added in Phase 4.
- **Tools:**
  - `mcp_servers`(id, owner_id (null = global), transport, builtin_id, config_cipher, enabled)
  - `tool_servers` (OpenAPI)
  - `plugins`(id, version, manifest, bundle_key, enabled, settings)
- **Operations:**
  - `usage_events`(user_id, chat_id, model_id, connection_id, prompt_tokens, completion_tokens, cost, latency_ms, created_at)
  - `webhooks`(url, events, secret_cipher)
  - `audit_log`
  - `app_config`(key, value jsonb)

#### Auth and sessions
- **Providers:** a pluggable `AuthProvider` (`server/auth/providers/{local,ldap}.ts`, later `oidc`). All of them issue the same session.
- **Local passwords:** argon2id (`@node-rs/argon2`).
- **Access token:** a 15-minute JWT (`jose`) in an `httpOnly`, `SameSite=Lax`, host-only cookie. Host-only means no `Domain` attribute, so the sandbox origin never receives it.
- **Refresh token:** random, stored hashed in `sessions` and rotated on every use. 30-day lifetime, cookie path `/api/auth`.
- **CSRF:** a double-submit `X-Claudia-CSRF` header is required on every state-changing route.
- **Login protection:** rate limit plus backoff after repeated failures.
- **Admin bootstrap** (`server/auth/bootstrap.ts`):
  - `CLAUDIA_ADMIN_EMAIL` and `CLAUDIA_ADMIN_PASSWORD` create the first admin on first boot. Without them, the first local sign-up becomes admin.
  - LDAP-only installs (password login disabled) require the env bootstrap or the `claudia admin create` CLI.
  - The first LDAP login never becomes admin unless an LDAP group is mapped to admin.
- **New sign-ups** default to `pending`; this is an admin setting.
- **API keys** (`Bearer ck-…`) arrive in Phase 3.

#### LDAP / Active Directory (Phase 1b)
Library: `ldapts`.
- **Config:** set in the admin UI or by env, stored in `app_config`, bind password encrypted.
  - `url` (`ldap://` or `ldaps://`), a StartTLS toggle, a custom CA certificate, and TLS verification on by default.
  - `bindDn` / `bindPassword` for the service account.
  - `userSearchBase` and `userFilter`, e.g. `(uid={{username}})` or, for AD, `(sAMAccountName={{username}})`.
  - Attribute mapping (`mail`, `cn`/`displayName`), an optional `allowedGroupDn`, and timeouts.
- **Login flow:**
  1. Reject an empty password before any bind. A simple bind with an empty password is an "unauthenticated bind" that some servers accept as an anonymous success.
  2. Normalize the username: trim, case-fold, and strip `DOMAIN\` or `@domain` per config.
  3. Bind as the service account.
  4. Search, building filters with ldapts filter classes so values are escaped per RFC 4515. Require exactly one match.
  5. Bind as the found DN with the supplied password.
  6. Create or update the user.
- **Account linking:** by `auth_identities(provider='ldap', subject=objectGUID or entryUUID)`, falling back to the DN. Never link by email. An LDAP login whose email matches an existing local account is refused until an admin links them.
- **Provisioning:** new LDAP users get role `user` or `pending` (admin setting).
- **Deprovisioning:** when a refresh token rotates and `last_verified_at` is older than a configurable interval (default 1 hour), re-check the user in the directory. If the user is missing or disabled, revoke all their sessions.
- **Group sync (Phase 3, once groups exist):**
  - `groupSearchBase` plus `groupFilter`: `(member={{dn}})`, or for AD `memberOf` or nested `LDAP_MATCHING_RULE_IN_CHAIN`.
  - Paged searches.
  - Map LDAP groups to Claudia groups, and optionally to admin. Sync at each login.
- **Login page:**
  - a username field for LDAP;
  - admin toggles `ENABLE_PASSWORD_AUTH` and `ENABLE_LDAP`;
  - LDAP users have no local password, so password change is hidden;
  - admin settings offer "Test connection" and "Test user lookup".

#### RBAC, rate limits and cost control
- **Effective permissions** = default user permissions plus the permissions of every group the user belongs to. Admins bypass checks.
- **Permission keys** include:
  - `chat.share`, `chat.export`, `chat.temporary`;
  - `workspace.models`, `workspace.knowledge`, `workspace.prompts`, `workspace.tools`;
  - `mcp.user_servers`, `connections.own`;
  - `features.web_search`, `features.image_gen`, `features.code`, `features.voice`.
- **Resources are private by default.** Access means the user is the owner or has a matching `access_grants` row. Every repository query goes through `rbac.scope(user)`.
- **Pending users** see only a "waiting for approval" screen.
- **Phase 1a limits:** users spend shared API keys, so from the start there are:
  - per-user rate limits on completions (`@fastify/rate-limit`, keyed by user id);
  - a cap on concurrent runs per user;
  - model allowlists per role, and per group from Phase 3.
- **Phase 3:** token and cost caps per user and group per day/month, based on `usage_events`.

#### Secrets and configuration
- **Key derivation:** `server/crypto/keys.ts` derives separate keys from `CLAUDIA_SECRET_KEY` with HKDF: one for JWT signing, one for encrypting secrets.
- **Secrets:**
  - AES-256-GCM, stored as `v1:iv:tag:ct` with a `key_version`.
  - A `rotate-keys` CLI re-encrypts everything.
  - The API returns only `hasKey` and the last 4 characters, never the key.
- **Where the key comes from:** provide `CLAUDIA_SECRET_KEY` from the environment or a secret mount. The auto-generated key file in `DATA_DIR` is only for trials and logs a warning: every backup of that folder contains the key next to the data it protects.
- **Precedence:** a setting given by an environment variable wins and is shown read-only ("set by environment") in the admin UI. Everything else lives in `app_config` and is edited in the UI. There is no "persistent config" switch.

#### Chat orchestration (server side)
- **Endpoint:** `POST /api/chats/:id/completions` with `{ parentId, content, fileIds, modelIds[], params, toolIds, features }`.
- **Steps:**
  1. Check access and rate limits.
  2. Resolve the model. A custom model is a base model plus a connection, a system prompt with `{{USER_NAME}}` and `{{CURRENT_DATE}}`, and its bound tools and knowledge.
  3. Load the path up to `parentId`.
  4. Inject memory, documents (with `[n]` citation markers) and the skill prompt.
  5. Fit everything with `context-budget.ts`: the oldest turns are dropped or summarized first, and the user is told when history was trimmed.
  6. Call the provider through `provider-registry.ts`, which wraps the `../src` provider classes.
  7. Run the tool loop.
  8. Persist the reply, throttled to every 500 ms and once at the end.
  9. Write `usage_events` and fire webhooks.
- **Tool loop:** tools are resent on every iteration unless the connection has the `toolsFirstTurnOnly` quirk, which keeps the Kimi/opencode-go workaround. Max iterations is configurable (default 10).
- **One active run per branch:** a second send to the same leaf while a run is active gets a 409. Other branches can run in parallel.
- **Multi-model:** each model produces a sibling assistant node under the same user node.
- **Events:** an SSE stream of the run-event union defined in `web/shared/run-events.ts`:
  - `run.started`, `message.created`;
  - `message.delta`, `message.reasoning`, `message.tool_call`;
  - `tool.started`, `tool.result`, `tool.client_request`;
  - `message.usage`, `message.citations`;
  - `message.completed`, with status `completed`, `stopped` or `error`;
  - `run.completed`.
- **Resume and stop:** `run-hub.ts` buffers events with sequence numbers.
  - `GET /api/runs/:id/events?after=` resumes a stream or lets another tab watch it.
  - `POST /api/runs/:id/stop` aborts the run.
  - A disconnected client does not stop the run.
- **MCP-UI actions:** `POST /api/tools/ui-action` (see [MCP](#mcp)).

#### Client-executed tools (event reserved in Phase 1a, first used in Phase 5)
- Some tools must run in the browser: the Pyodide code interpreter, and anything needing browser-only APIs.
- The server emits `tool.client_request { runId, callId, name, args }`. The client runs the tool and posts `POST /api/runs/:id/tool-results { callId, result }`.
- The server waits up to a timeout (default 120 s). If no client answers, for example because the tab was closed, it records an error result and continues.

#### MCP
- **Pools:** one `MCPClientManager` per scope:
  - `global`, configured by admins;
  - `user:<id>`, started lazily and stopped after 10 idle minutes.
- **stdio servers:** admin only, and only when `CLAUDIA_ALLOW_STDIO_MCP=true`.
  - Make env inheritance an option of `createStdioTransport` (`electron/services/mcp.service.ts:195`).
  - The desktop keeps inheriting `process.env`, unchanged.
  - The server passes only the MCP SDK's `getDefaultEnvironment()` plus the server's configured variables. It never passes the database URL or the secret key.
  - Long term, run stdio servers in a sidecar container.
- **Remote servers** (streamable HTTP / SSE): users may add them with the `mcp.user_servers` permission. URLs go through `safe-fetch`; headers and tokens are encrypted.
- **Tool names:** OpenAI requires `^[a-zA-Z0-9_-]{1,64}$`.
  - Use the sanitized bare tool name when it is unique across the user's enabled servers.
  - On a collision, prefix a short server alias. Hash-truncate anything over 64 characters.
  - Store the alias → (serverId, tool) map in each `tool_call` part, so history replays and UI actions resolve the same way.
  - The desktop uses the same builder, which fixes the collision bug in `findServerForTool`.
- **MCP-UI actions:**
  - they may run only tools on the server that produced the UI resource. Today any tool can be named (`chatSlice.ts:881`);
  - tools annotated `destructiveHint` need user confirmation.
- **Built-ins** (from `electron/services/builtin-mcp/registry.ts`):
  - **Filesystem:** one instance per user, rooted at `DATA_DIR/workspaces/<userId>`, with quotas and a download route.
    - Text extraction is injected: `createFilesystemServer({ allowedDirectories, extractText })`. The server uses the worker pool; the desktop keeps its in-process parsers.
    - Path checks are fixed in Phase 0a.
  - **Fetch:** uses `safe-fetch` on the server.
  - **msoffice:** `convert_to_pdf` is hidden when not running on Windows.
  - **Diagram:** unchanged, plus a render timeout.

#### Sandbox origin and file serving (infrastructure in Phase 1a)
- **What it serves:** `CLAUDIA_SANDBOX_ORIGIN` serves the static pages in `web/sandbox/`:
  - the MCP-UI proxy page (mcp-ui proxy mode);
  - the artifact host page (Phase 5);
  - inline previews of uploaded files.
- **Choice of origin:**
  - Prefer a separate registrable domain.
  - A subdomain is safe only because session cookies are host-only and every state-changing route requires the CSRF header.
  - Single-host trials can use a second port.
- **Iframes** never get `allow-same-origin` for inline content. The app's CSP limits `frame-src` to the sandbox origin.
- **Uploaded files** are served from the app origin only as downloads, with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`. Inline previews go through the sandbox origin.
- **Share links** (Phase 2) follow the same rules, so a shared chat cannot run script on the app origin for the people who view it.

#### Outbound requests — SSRF guard (`server/net/safe-fetch.ts`, Phase 1a)
SSRF (server-side request forgery) means tricking the server into calling internal addresses.
- **Where it applies:** every request to a user-controlled URL:
  - user-owned connections and user MCP servers;
  - the fetch tool, `#url` ingestion and web-search result fetching;
  - embedding, rerank and image endpoints set by users;
  - webhooks and OpenAPI tool servers.
- **Rules:**
  - http(s) only;
  - resolve DNS and reject the request if any address is loopback, private, link-local, CGNAT, multicast or unspecified. This includes IPv4-mapped IPv6 (`::ffff:a.b.c.d`);
  - connect to the address that was checked (custom `lookup`), so DNS rebinding can't swap it;
  - follow redirects manually (max 5), re-checking every hop;
  - cap response size and time.
- **Exceptions:**
  - admin-configured global connections may target internal hosts, such as an internal Ollama;
  - for user-owned URLs, the only exception is an admin-managed allowlist.
- **Replaces the fetch tool's current guard** on the server. That guard checks the hostname with a regex (`fetch.server.ts:59`) and then follows up to 5 redirects without checking them (`:103`, `:313`).

#### Document parsing (`server/extract/`, Phase 1b)
- **Isolation:** all parsing runs in a worker-thread pool (e.g. `piscina`) with:
  - a per-job timeout;
  - a heap limit (`resourceLimits`);
  - a maximum input size;
  - maximum decompressed size and entry count for zip-based formats (docx, xlsx, pptx), to stop zip bombs.
- **Spreadsheets:** SheetJS from its official CDN tarball (≥ 0.20.3), or `exceljs`. Not npm `xlsx` 0.18.5, which has CVE-2023-30533 (prototype pollution) and CVE-2024-22363 (ReDoS), fixed only in SheetJS's CDN builds.
- **PDF:** a maintained pdf.js build (`pdfjs-dist` or `unpdf`) with `isEvalSupported: false`. Not `pdf-parse` 1.1.1, which is unmaintained, bundles a 2018 pdf.js and crashes when bundled.
- **Other formats:**
  - docx: mammoth;
  - pptx: jszip, with the limits above;
  - HTML and URLs: readability + jsdom (scripts off) + turndown;
  - text and code: read directly.
- **Phasing:** Phase 1b uses extraction for chat attachments, injecting the whole text capped by `context-budget.ts`. Phase 4 adds chunking, embeddings and retrieval on top.

#### Plugins and skills
- **Plugins (Phase 5):**
  - admins upload an ESM bundle, served immutably from `/plugins/:id/:ver/index.mjs` and loaded with `import()`;
  - an import map points `react`, `react/jsx-runtime` and `unified` at host shims;
  - plugins run with full page privilege, so installation is admin-only and covered by the CSP;
  - desktop plugins are CommonJS loaded with `require()` in the main process (`electron/services/plugin-loader.service.ts:58`), so plugin authors need an ESM build for the web.
- **Skills:** stored in the `prompts` table via `skill-core.ts`, with `.md` import and export.

#### Operations
- **Streaming behind reverse proxies:**
  - run streams send `Cache-Control: no-cache` and `X-Accel-Buffering: no`, and are excluded from `@fastify/compress`;
  - the docs cover nginx and Traefik settings: `proxy_buffering off`, and a read timeout longer than the longest run.
- **Logs:** pino JSON with request ids and run ids. OpenTelemetry traces (Phase 6) when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
- **Health:** `/healthz` checks the process; `/readyz` checks the database and migrations.

### RAG (Phase 4)
- **Extraction:** the Phase 1b worker pool, plus optional external engines (Tika, Docling) for OCR and complex layouts.
- **Chunking:**
  - a token-aware recursive splitter (`gpt-tokenizer`): markdown headings, then paragraphs, then sentences;
  - default 800 tokens with 100 overlap, configurable per knowledge base;
  - each chunk keeps source, page and heading metadata.
- **Embeddings:**
  - any OpenAI-compatible `/v1/embeddings`, Ollama `/api/embed`, or local `@huggingface/transformers` as a zero-config default;
  - batched with retries;
  - model and dimensions are recorded per knowledge base, and changing the model queues a re-index job.
- **Retrieval:**
  - pgvector similarity and `tsvector` keyword ranking, merged with Reciprocal Rank Fusion (k = 60) and filtered by access grants;
  - optional reranking via a Cohere-, Jina- or TEI-compatible `/rerank`;
  - full-context mode when a document fits the budget.
- **Citations:** numbered `[n]` sources produce a `message.citations` event, are stored as `citation` parts, and are rendered by a shared `src/components/chat/Citations.tsx`, which ships to desktop too.
- **Web search:**
  - providers: SearXNG, Brave, Tavily, Google PSE, DuckDuckGo;
  - results are fetched through `safe-fetch`, chunked, embedded into a temporary store and returned as URL citations;
  - also exposed to the model as a native `web_search` tool.
- **Also in Phase 4:**
  - `#chat` references (attach another conversation as context);
  - YouTube transcripts;
  - knowledge binding for custom models and folders;
  - memory retrieval by embedding. Phase 3 memory injects saved memories directly.

## Roadmap

### Phase 0a — Safety net and desktop fixes
Ships in a desktop 0.10.x release and doesn't depend on the web work.
- **Test runner and CI:** add Vitest (with React Testing Library and jsdom) and a `test` script. Add `.github/workflows/ci.yml` running type-check, lint, build and tests on every pull request.
- **Characterization tests, before any refactor:**
  - the tool loop in `chatSlice.ts` (`sendStreamingMessageWithTools`);
  - stream parsing for each provider;
  - the `buildAPIMessage` normalization.
- **Fixes:**
  - **Preload listener leak:** the `on*` methods remove the raw `callback` instead of the wrapper they registered (`electron/preload.ts:135-255`, covering the mcp, plugins, logger and updater listeners).
  - **Multi-round tools:** resend tools on every iteration, unless the provider reports a `toolsFirstTurnOnly` capability. It is on for opencode-go (`chatSlice.ts:663-667`).
  - **Tool-name collisions:** create `src/services/mcp/tool-format.ts` with the alias builder, and use it instead of the bare-name lookup in `findServerForTool`.
  - **Non-image attachments never reach the model:**
    - add a main-process `file:extractText` IPC, because the parsers live in the main process, and inline the text;
    - for the Open WebUI provider, send the uploaded file ids in the request's `files` field instead. `src/hooks/useFileUpload.ts:31-41` already uploads them.
  - **Title race:** a main-process `conversation:updateMeta` IPC patches title, model and starred in one step, replacing the renderer's load-then-save (`conversationSlice.ts:111-172`).
  - **Filesystem server path checks:** call `fs.realpath` before comparing, and case-fold only on Windows (`filesystem.server.ts:23-31`).
- **Not included:** the MCP-UI sandbox issue, which is noted only (see [Known issues](#known-issues-in-the-desktop-app)).
- **Exit:** CI green on every pull request; the desktop smoke checklist passes; the release is published.

### Phase 0b — Platform adapter and shared modules
Changes no desktop behaviour.
- Platform adapter for the shared files only, the `composer` slice, `createAppStore` and the ESLint rule.
- Pure modules: `sse-parser.ts`, `message-builder.ts` (with `toOpenAIMessages`), `tool-format.ts` (completed), `context-budget.ts`, `skill-core.ts`.
- **Exit:**
  - characterization tests still green;
  - unit tests for every pure module;
  - the desktop smoke checklist passes;
  - `window.electron` appears only in `src/platform/electron.ts` and the desktop-only allowlist.

### Phase 0c — `web/` scaffold
- Configs and aliases, `resolveSharedFromWeb()`, the Tailwind preset and `check-shared-deps.mjs`.
- A Fastify app with `/healthz`.
- Drizzle with a first migration on both PGlite and Postgres.
- Dockerfile and compose (app + Postgres); a CI job that builds `web/`.
- **Exit:**
  - `web/` builds with the root `node_modules` deleted;
  - the bundle contains one copy of React;
  - a page renders shared components (`MarkdownRenderer`, `ChatMessage`) from `../src`;
  - migrations run on both PGlite and Postgres in CI.

### Phase 1a — Multi-user chat core
- **Auth:** local sign-up, login, refresh and logout; pending approval; admin bootstrap; an admin users page.
- **Models:** admin-managed global connections and an aggregated model list with per-role allowlists.
- **Server orchestrator:**
  - SSE streaming, resume and stop;
  - the run lock and context budget;
  - `tool.client_request` reserved in the event union;
  - turn-based message storage, shown in a linear UI for now.
- **Conversations:** folders (desktop projects), pin, rename, title search, and AI titles as a server task using a configurable "task model".
- **UI:**
  - per-user settings and themes, and the router;
  - a responsive layout in which the sidebar becomes a drawer on phones;
  - the i18n scaffold: every new web string goes through `react-i18next`.
- **Shortcuts:** browsers reserve Ctrl+N (and Ctrl+T, Ctrl+W), so "new chat" needs a different binding on the web (`src/hooks/useKeyboardShortcuts.ts:26`).
- **Infrastructure:** `safe-fetch`, the sandbox origin, rate limits, and Docker compose (app + Postgres).
- **Exit (Playwright):**
  - admin bootstrap → a second user signs up → shows as pending → is approved → gets a streamed chat → reload keeps the history → stop works → a second tab resumes a live run;
  - the rate limit is enforced;
  - the app is usable at phone width;
  - the compose stack is healthy.

### Phase 1b — Directory login, tools and files
- **LDAP/AD login** with the hardening above, and an LDAP settings page.
- **MCP pool:** global servers, per-user sandboxed built-ins, MCP-UI rendered from the sandbox origin, and the UI-action restrictions.
- **Uploads** (local storage) with worker-pool text extraction, so attachments reach the model.
- **Skills** stored in the database.
- **User-owned connections** (`connections.own`) through `safe-fetch`.
- **Exit:**
  - the LDAP test suite is green (see [Verification](#verification));
  - user A cannot see or call user B's servers, files or workspace;
  - MCP-UI renders only from the sandbox origin;
  - PDF, DOCX and XLSX attachments reach the model;
  - parser limits are enforced.
- **Decisions made while building it:**
  - Directory-only installs get their first admin with `claudia admin promote --email …` after that person's first directory sign-in; password sign-in stays fully off.
  - `allowedGroupDn` is checked with `memberOf` (OpenLDAP needs the memberof overlay).
  - LDAP tests run against an in-process fake directory (ldapjs) on every run, and against OpenLDAP (`docker/compose.ldap.yml`, ldaps and StartTLS with a test CA) in a CI job, instead of testcontainers.
  - Personal connections' models are named `@<prefix>/<model>`, so they never shadow global ones.
  - Built-in tool results show paths relative to the user's workspace; HTML→markdown (fetch) and SVG→PNG (diagrams) run in the worker pool too.
  - Shared code's `console.*` output goes through the logger, with `log`/`info`/`debug` only at debug level (some of it contains request bodies).

### Phase 2 — Rich chat UX
- **Rendering:** LaTeX (`remark-math` + `rehype-katex`) and lazy-loaded Mermaid (`securityLevel: 'strict'`) in the shared `MarkdownRenderer`. Desktop gets them too.
- **Messages:**
  - version switcher (`< 2/3 >`), regenerate as a sibling, fork, ratings and feedback;
  - per-chat parameters and system prompt;
  - multi-model side by side and follow-up suggestions;
  - temporary chats and a message queue.
- **Conversations:**
  - full-text search (`tsvector`); tags, archive and nested folders;
  - export and import: Claudia JSON, desktop conversation folders, and Open WebUI and ChatGPT exports;
  - share links: a snapshot, revocable, rendered under the sandbox rules.
- **Exit:**
  - Playwright tests pass for version switching, multi-model, opening a share link while logged out, and an export → import round trip;
  - search finds text inside messages.
- **Decisions made while building it:**
  - Single-dollar math is off in remark-math; `normalizeMath` rewrites `$x$` (pandoc's rule, so "$5 and $10" stay text), `\(x\)` and `\[x\]` to `$$`, leaving code alone. KaTeX runs with `trust: false`.
  - Message search is a generated `tsvector` column (`'simple'` config, so any language) over the text parts, via an immutable `claudia_parts_text()` SQL function; queries match every word as a prefix, and titles still match by substring.
  - A user node records the models asked (`meta.models`) and the skill invoked (`meta.skill`); regenerating answers the same node again with the same skill and effort. Columns are shown when a turn asked several models; the chat continues from the column on the current path.
  - Title first, then follow-up suggestions, in the same run (task model if set); `tasks.generateFollowUps` turns them off.
  - The message queue lives in the browser and sends the next message once the run ends and the chat is refetched.
  - Temporary chats are stored (so runs, resume and attachments work as usual) but never listed, searched, exported or titled, and are swept after 24 h without activity.
  - Share links are one per chat, a snapshot renumbered `n1…` without internal ids, file ids, ratings or MCP-UI resources, served from `/api/shared/:token` with `Cache-Control: no-store`; re-sharing refreshes the snapshot and keeps the token; deleting the row revokes it. The viewer renders on the app origin with the same no-raw-HTML markdown (no MCP-UI, so nothing needs the sandbox origin).
  - Imports are converted in the browser (desktop folders, Open WebUI, ChatGPT → Claudia JSON) and posted in batches; the server reads only the validated Claudia format, gives every node a new id and drops nodes whose parent is missing.

### Phase 3 — Workspace
- **Model builder:** system prompt, tools and parameters. Knowledge binding arrives in Phase 4.
- **Prompt library:** `/command` with a `{{variables}}` form.
- **Memory:** saved memories injected directly.
- **Access:** groups, permissions and an access-grants UI; LDAP group sync.
- **User-owned remote MCP servers.**
- **API keys** with the OpenAI-compatible `/api/v1/chat/completions`. This also lets the desktop app use Claudia Web as a custom provider.
- **Token and cost caps.**
- **Exit:**
  - a table-driven permission matrix (role × group × resource) is green;
  - the OpenAI SDK client works against `/api/v1`;
  - caps are enforced.
- **Decisions made while building it:**
  - Permissions are additive: the defaults (`permissions.default`, editable in Admin → Settings) plus every group's; a group can't take a default away. Admins have all of them, pending users none. Keys: `chat.share`, `chat.export`, `chat.temporary`, `workspace.models`, `workspace.prompts`, `workspace.share_public`, `mcp.user_servers`, `connections.own`, `api.keys`. The Phase 1b `connections.user` switch became `connections.own` (migrated). The `features.*` keys arrive with their features.
  - Groups add models to the role allowlist (`groups.model_ids`) and can raise caps; per cap the most generous of the default and the user's groups wins, and an admin override on the user (`users.caps`) wins over both.
  - Caps count `usage_events` per UTC day and month (tokens, and cost where the provider reports it) and are checked before a chat, `/api/llm/complete` or `/api/v1` request starts, so one reply can go past a cap. Admins aren't capped.
  - Custom models are `models` rows keyed `custom/<uuid>` (the `custom` connection prefix is reserved). They must sit on a global model, not a personal or another custom one, and run with their owner's model access, which is what lets a group use an assistant without the raw model; a model whose owner loses the base model disappears for everyone. Their system prompt comes after the user's own and before memories, the skill, folders and the chat's; their parameters sit under the chat's and the request's; their tools are on whenever they answer, even if the user switched the server off.
  - Workspace items (models, prompts) are private until shared through `access_grants` (a user, a group, or everyone; read = use, write = edit). Only the owner and admins change access or delete. Sharing with everyone needs `workspace.share_public`. Grants are removed with the item, group or user (in code: the reference is polymorphic). Admins see every item in the workspace views, but the composer's prompt menu shows only their own and shared ones.
  - Prompts are `prompts` rows with mode `insert`, next to skills (mode `system`), so a user's commands are unique across both. `{{name}}` and `{{name:default}}` are asked for in a form; `{{CURRENT_DATE}}`, `{{CURRENT_TIME}}`, `{{CURRENT_DATETIME}}`, `{{CURRENT_WEEKDAY}}`, `{{USER_NAME}}` and `{{USER_LANGUAGE}}` fill themselves (in custom models' and the other system prompts too). Picking one in the "/" menu or sending "/command" alone opens it; a skill with the same command wins when sent.
  - Memories are injected as one system message, newest first, up to 6,000 characters (200 per user); the user can switch them off. Retrieval by relevance waits for embeddings (Phase 4).
  - LDAP group sync runs at each sign-in: `memberOf` on the user entry, or a paged group search with `{{dn}}` / `{{username}}` escaped into the filter. Only memberships with source `ldap` are added and removed; manual ones stay. With an admin group set, its members become admins and other directory users lose admin at sign-in, never the last admin. If the directory can't answer, memberships stay as they were.
  - API keys are `ck-` + 32 random bytes, stored as sha256, with an optional expiry. They are accepted only on `/api/v1` and only as `Authorization: Bearer` (cookies are ignored there, so it needs no CSRF check), and only while the owner has `api.keys`. `/api/v1/chat/completions` passes the request through (tools included; the caller runs them), streams OpenAI chunks with `reasoning_content`, and aggregates the same stream for non-streaming calls so every provider behaves the same.
  - Users' own MCP servers are `mcp_servers` rows with an owner, HTTP or SSE only, run in the user's pool with the SSRF-guarded fetch and encrypted headers, at most 10 per user; they vanish (but stay deletable) when the permission goes.
  - Found while building it: zod 4's `.partial()` still applies `.default()`s, so the Phase 1b connection PATCH reset omitted fields (base URL, quirks, model filter) to their defaults. PATCH bodies now go through `parsePatch`, which keeps only the fields sent. The shared `Modal` had no height limit, so tall dialogs ran off screen; it now scrolls inside the window (desktop too).

### Phase 4 — Knowledge and search
- **Knowledge bases:** ingestion jobs with WebSocket progress.
- **Retrieval:** hybrid search, rerank, full-context mode and citations.
- **Mentions:** `#kb`, `#url` and `#chat`.
- **Sources:** YouTube transcripts and web search providers.
- **Binding:** knowledge for custom models and folders; memory retrieval by embedding.
- **Admin RAG settings.**
- **Exit:**
  - the golden retrieval set meets its recall@k threshold;
  - ingestion tests pass for each format;
  - the citation end-to-end test passes.
- **Decisions made while building it:**
  - Embeddings are optional. With no engine set (the default), knowledge bases work on keyword search alone (tsvector with an OR-of-prefixes query, stopwords dropped); setting an engine re-embeds everything. Engines: any OpenAI-compatible `/embeddings`, Ollama `/api/embed`, or local transformers.js. The local engine is not installed by default — `@huggingface/transformers` pulls in onnxruntime (well over 100 MB) and downloads a model on first use — so it is loaded only if the package is present. This replaces the "zero-config local default" of the plan above.
  - Vectors live in `embeddings_<dims>` tables created on first use (HNSW, cosine; `halfvec` above 2,000 dimensions). Every chunk records the `<engine>:<model>` it was embedded with and only chunks of the current model are compared; changing the model queues `rag.reindex-all`. pgvector 0.8 in PGlite supports all of this, so tests run the same SQL as production.
  - Hybrid search: up to max(4×k, 20) candidates from each of keyword and vector search, fused with RRF (k = 60), optionally reranked (Cohere-style `/rerank` or TEI), then the top k. Reranking failures keep the fused order.
  - Chunking: markdown sections first (each chunk keeps its heading path, code fences respected), then paragraphs, lines, sentences, words; 800 tokens with 100 overlap by default, per knowledge base if set. PDF pages and slides become pages, sheets become headings. Chunks are embedded with their file name and heading in front.
  - Ingestion runs in the `jobs` queue (FOR UPDATE SKIP LOCKED; woken on enqueue in this instance, else polled every 2 s; three attempts with backoff; jobs stuck "running" for 15 min are retried). Unsupported files and parser limits fail at once. Phase 6 adds LISTEN/NOTIFY so new jobs wake every instance.
  - Progress goes over a WebSocket (`/api/ws`, `@fastify/websocket`): topics like `kb:<id>`, access checked on subscribe, cookie-authenticated, and only accepted from the app's own origin (the CSRF defence for WebSockets). Fanned out across instances through Redis since Phase 6.
  - Sources per turn: #kb references and folder knowledge (the user's access), custom-model knowledge (its owner's), referenced chats (the user's own; their end matters most), #url pages (whole when short, else the most relevant passages), and web search results. Everything shares one budget (`maxContextTokens`, default 8,000; one document at most 40 %) and is numbered in one `<sources>` system message placed last; the reply's `citation` parts carry the same numbers and a `message.citations` event shows them while streaming. A regeneration uses the turn's own references.
  - Full-context mode sends a knowledge base's extracted file text when it fits the remaining budget, else falls back to retrieval with a notice.
  - `#url` and result pages go through `safeFetch` (the admin allowlist applies); the search and embedding endpoints are the admin's and are not. YouTube links are read from the watch page's caption tracks (json3); videos without captions fail with a message.
  - Memories are embedded as `chunks` (source `memory`). Up to 2,000 characters they are all sent as before; beyond that, with embeddings, the eight closest to the message.
  - Citations render in the shared `ChatMessage` (desktop too): `[n]` becomes a chip that opens the source, with a source list under the reply. Share snapshots keep a citation's title, page, section, link and snippet, but not file or chat ids.
  - The golden set (16 documents, 32 questions) reaches recall@5 = 1.0 with keyword search and with hybrid search, using a deterministic hash embedder; it guards the pipeline against regressions rather than measuring a real embedding model.

### Phase 5 — Advanced tools
- **Artifacts** (HTML/SVG/React) rendered on the sandbox origin.
- **Code interpreter:** Pyodide in the browser via client-executed tools; container execution later.
- **Image generation:** OpenAI, ComfyUI, A1111, Gemini.
- **Voice:** speech-to-text via the Whisper API or Web Speech; text-to-speech via OpenAI or the browser.
- **Providers and tools:** native Anthropic and Ollama providers, OpenAPI tool servers and ESM plugins.
- **Exit:** the code-interpreter round trip works, including the timeout when the tab is closed; artifact sandbox and CSP tests are green.
- **Decisions made while building it:**
  - Browser tools: the code interpreter's `run_python` is offered when the message asks for it (the Code button, `features.code`, permission `features.code`) and a sandbox origin exists. The server emits `tool.client_request` and waits up to 120 s for `POST /api/runs/:id/tool-results` (first answer wins; later ones get 404); with no answer the model gets "No browser answered in time…" and the run continues. A stop ends the wait.
  - Python runs in a Web Worker inside a hidden frame on the sandbox origin (`sandbox/code-runner.html`, `allow-scripts allow-same-origin`, so it can start the worker and load Pyodide from its own origin), never on the app origin: the code comes from the model. Pyodide 0.28 is served from the sandbox (`/vendor/pyodide/*`, a fixed allowlist); extra packages come from the Pyodide CDN on import. Each run has a fresh namespace and a 90 s limit (the worker is ended).
  - Artifacts are complete HTML, SVG and React (jsx/tsx, or js/ts importing react with a default export) code blocks. They render through `sandbox/artifact.html` (itself framed with `allow-scripts` only) into a nested srcdoc frame with `allow-scripts` only and a CSP of `default-src 'none'` plus inline scripts, React/Babel from the sandbox, and images, media and fonts — so no fetch, XHR, WebSocket or form posts, no storage and no cookies. React is the app's React 18 UMD build; JSX/TypeScript is compiled in the frame with Babel standalone; only `react` can be imported.
  - Image generation is a server tool (`generate_image`, the Image button, `features.image_gen`): OpenAI-compatible `/images/generations`, AUTOMATIC1111 `/sdapi/v1/txt2img`, ComfyUI (the admin's API-format workflow with `%prompt%`-style placeholders, then `/history` and `/view`) and Gemini `generateContent` with image output. Images become the user's files and `file` parts of the reply (a `message.part` event while streaming); the model is told they were shown.
  - Voice defaults to the browser's own speech (Web Speech recognition and synthesis); an admin can switch either to an OpenAI-compatible endpoint (`/api/audio/transcriptions`, `/api/audio/speech`), permission `features.voice`.
  - Native Anthropic (Messages API: tool use, extended thinking from the reasoning effort with a budget per level, images, system prompts merged) and Ollama (`/api/chat` NDJSON with tools, images and `think`) providers live in the shared `src/services/api/providers`.
  - OpenAPI tool servers are admin-managed (`tool_servers`); every operation of an OpenAPI 3 spec (JSON or YAML, local `$ref`s inlined, depth-limited) becomes a tool whose arguments are its path/query/header parameters and a JSON `body`. They appear to users as shared tool servers (same aliasing, toggles and tool loop as MCP). Swagger 2 is refused.
  - Plugins: an admin uploads `plugin.json` and an ES module (≤ 5 MB); it is served from `/plugins/:id/:version/index.mjs` (signed-in users, enabled only, cached immutably) and imported at startup into the shared renderer registry. The import map is the page's one inline script, allowed in the CSP by its sha256 (a test checks the page and the hash agree); the shims in `public/plugin-shims` hand out the app's React, JSX runtime and unified.
  - Container code execution is left for later, as planned.

### Phase 6 — Admin and operations
- **Admin:** usage analytics dashboards, HMAC-signed webhooks, banners, default settings and an audit log.
- **Scaling:** Redis for multiple instances (pub/sub run hub, WebSocket fan-out, shared rate limits) and S3 storage.
- **Other:** PWA, translation of the shared `src/` strings, OpenTelemetry.
- **Exit:** two app replicas plus Redis and Postgres pass a cross-instance streaming test; webhook signature tests are green.
- **Decisions made while building it:**
  - Running the whole suite on real PostgreSQL (CI already does) found three bugs PGlite hid: an untyped `Date` parameter in the usage-cap query (postgres.js can't send one), two jobs racing to create the same `embeddings_<dims>` table (now one promise per size plus a transaction-scoped advisory lock), and a test that assumed PGlite.
  - `server/cluster`: without `REDIS_URL` everything stays in process (a local bus), so one instance needs nothing new. With it, one command connection and one subscriber connection per instance; keys and channels start with `REDIS_PREFIX`. Other instances hear "this changed" signals and drop their caches: app settings, RAG and media config, model lists; a changed global MCP server is restarted on every instance.
  - Runs: a run executes where it started. Redis holds its owner, events (a list, plus a pub/sub channel written in the same MULTI so a follower never misses or repeats one), the branch lock (`SET NX`, released only by its run) and the user's running count (a sorted set by expiry), taken atomically by one Lua script. Followers on other instances subscribe first, then read the list, then de-duplicate by `seq`. Stops and browser-tool answers go to the owner over a control channel; the first answer wins with an atomic `SREM` on the run's pending calls. The owner refreshes TTLs every 20 s (60 s lifetime); a follower whose run's keys vanish reports `run.completed` with `error`.
  - WebSocket events, the login backoff (`login:<key>` counters and lock keys) and `@fastify/rate-limit` (its Redis store, failing open if Redis is down) are shared. Jobs wake every instance's worker with PostgreSQL `LISTEN/NOTIFY` (`claudia_jobs`); polling stays as the fallback. Migrations take a session advisory lock, and the env admin's creation tolerates another instance winning, so replicas can start together.
  - S3 storage (`@aws-sdk/client-s3`) behind the existing `Storage` interface; a missing object surfaces as `ENOENT` like the local disk. Per-user built-in tool workspaces stay on `DATA_DIR`, which instances share as a volume. MinIO no longer publishes images on Docker Hub, so tests and `compose.scale.yml` use Adobe's S3Mock (path-style).
  - The exit test is `scripts/scale-smoke.mjs` against `docker/compose.scale.yml` (two instances behind nginx, Redis, PostgreSQL, S3Mock), run by the `web-scale` CI job: a reply started on one instance streams complete and in order from the other, a stop and a branch lock cross instances, a file crosses through S3, and a webhook fired by the other instance verifies. `server/cluster/cluster.test.ts` covers the same in process, plus settings, WebSocket fan-out, shared login/rate limits and a dead owner.
  - Webhooks (`webhooks` table; the secret `whsec_…` is encrypted, shown once, rotatable) are delivered by the jobs queue: three attempts, a 4xx other than 408/429 is final, 10 s timeout, no redirects. Signature: `v1=` hex HMAC-SHA256 of `<timestamp>.<raw body>`, Stripe-style, so replays can be refused by timestamp; the receiver accepts any of several comma-separated signatures. Events: `user.created`, `user.updated`, `run.completed` (ids, models, status, token counts — never text), `knowledge.file_processed/failed`, `audit.recorded`. Admin-only, and allowed to reach internal hosts.
  - Audit log (`audit_log`): explicit entries for sign-in (and failures, without an actor), sign-out, sign-up and API keys; an `onResponse` hook records every successful mutating `/api/admin/*` request by route pattern with its params and body, keys that look secret replaced by `[redacted]`. Recording never fails a request; retention (`audit.retentionDays`, default 365) is swept daily; CSV export neutralises formulas.
  - Analytics read `usage_events` (now indexed by time) per UTC day, model, user (top 25) and kind, plus new chats and messages; the dashboard is plain SVG with a table for screen readers, and CSV export.
  - Banners (`ui.banners`, ≤ 20, plain text with links, optional time window) poll every five minutes; dismissals are remembered per browser. User defaults (`users.defaults`: appearance and preferences) are merged under the user's own settings in `GET /api/me/settings` and in runs (so a default system prompt applies).
  - PWA: manifest, icons generated from the desktop icon, and a hand-written service worker: hashed `/assets` cache-first, pages network-first with the cached shell offline, icons/manifest stale-while-revalidate; never `/api`, `/plugins` or anything per-user. Registered in production builds only.
  - Shared strings: `src/i18n` is dependency-free — `t(key, english, vars)` returns English unless a translator is set, and `useT()` re-renders on language changes — so the desktop app is unchanged. The web app sets i18next (namespace `shared`) as the translator. 197 strings in the 20 shared components the web app renders are converted; `scripts/shared-strings.mjs` generates `en.shared.json` and CI fails when it is stale. Languages appear when their `<lang>.json` exists; none besides English ship yet.
  - OpenTelemetry without require hooks (the server is one CJS bundle, so `http`/`pg`-style instrumentation would load too late): a Fastify hook makes server spans and honours `traceparent`; undici's diagnostics channel traces every `fetch` (providers, MCP over HTTP, webhooks) and propagates context; manual spans for runs, model calls (GenAI conventions, token counts, never text), tool calls and jobs. Off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set; the SDK loads lazily.
  - Fixed on the way: the first message after opening the page could go out without tools or its `/skill` (the client hadn't loaded them yet; it now waits), and the Docker build had been failing in `check-shared-deps` since Phase 0 (the image has no root `package.json`; it now checks presence only there).

### Phase 7 — Optional extras
- OIDC/OAuth SSO, TOTP MFA and SCIM.
- Arena/ELO evaluation, notes, channels, scheduled prompts, and Google Drive/OneDrive pickers.

## Critical files
- **Desktop state and chat:**
  - `src/store/index.ts`, `src/store/slices/{chat,conversation,mcp,plugin,skill,settings}Slice.ts`
  - `src/components/chat/{ChatWindow,ChatInput,MarkdownRenderer,UIResourceDisplay,SuggestedPrompts,TextSelectionMenu}.tsx`
- **Bridge:** `electron/preload.ts`, `src/global.d.ts`, `electron/handlers/{config,conversation}.handler.ts`
- **Providers and tools:** `src/services/api/{provider.service,streaming.service}.ts`, `src/services/api/providers/*`, `src/services/mcp/tool-integration.service.ts`
- **Main-process services the server reuses:** `electron/services/mcp.service.ts`, `electron/services/builtin-mcp/{registry,filesystem.server,fetch.server,diagram.server}.ts`, `electron/services/skill.service.ts`
- **Other:** `src/hooks/{useFileUpload,useKeyboardShortcuts}.ts`, `tailwind.config.js`, `vite.config.ts`

## Verification
- **Every phase:** CI runs the desktop `npm run type-check`, `npm run lint`, `npm run build` and tests. It also runs `web/` type-check, build and tests, and `check-shared-deps.mjs`.
- **Database tests:** unit and repository tests run on PGlite (in process, fast). Integration tests run on real Postgres with pgvector, via testcontainers (`pgvector/pgvector:pg16`).
- **Phases 0a–0b:** the characterization and unit tests above, plus a manual desktop smoke checklist via `npm run dev`: chat, multi-round tools, MCP start/stop, skills, plugins, profiles and attachments.
- **Phase 0c:** build with the root `node_modules` removed; confirm the bundle has one React copy (`rollup-plugin-visualizer` or a grep).
- **Phase 1a:**
  - Fastify `inject` tests for:
    - auth flows, bootstrap, CSRF and rate limits;
    - RBAC isolation;
    - the secret round trip, checking that no key appears in any response;
    - resume and the run lock.
  - Orchestrator tests against a mock OpenAI server with scripted SSE: tool loop, abort ending as `stopped`, and reasoning.
  - `safe-fetch` tests: private IPs, IPv4-mapped IPv6, DNS rebinding, and a redirect to a private address.
  - The Playwright exit flow, and `docker compose up` with a scripted curl smoke test.
- **Phase 1b:**
  - **LDAP integration tests** against OpenLDAP (testcontainers, seeded LDIF):
    - success, wrong password, **empty password** and unknown user;
    - filter injection (`*)(uid=*`);
    - ldaps and StartTLS;
    - auto-provisioning, and an email collision with a local account (refused);
    - a deprovisioned user losing sessions on refresh;
    - LDAP-only bootstrap.
  - **Filesystem sandbox escape tests:** `../`, symlinks and case tricks.
  - **Parser limit tests:** zip bomb, oversized file, timeout.
  - **MCP-UI** loads only from the sandbox origin (CSP test), and a UI action calling another server's tool is refused.
- **Phases 2–3:** the Playwright flows above, KaTeX and Mermaid snapshot tests, the permission matrix, the OpenAI SDK against `/api/v1`, and a test that a share-link viewer cannot run script on the app origin.
- **Phase 4:** the golden retrieval set (recall@k), ingestion tests per format, and the citation end-to-end test.
- **Phases 5–6:** artifact CSP tests, the client-tool timeout, webhook signatures and two-replica fan-out.
