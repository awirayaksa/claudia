# Claudia Web

The multi-user, self-hostable web version of Claudia. It reuses the desktop
app's code in `../src` (components, providers, stream parser) and
`../electron/services` (MCP, built-in tools) through aliases and the platform
adapter in `src/platform`. See [PLAN.md](PLAN.md) for the design and roadmap.

Status: **Phase 3** (workspace). Phase 3 adds:

- **Groups and permissions** (Admin → Groups, Admin → Settings): every user
  gets the default permissions (sharing chats, exporting, temporary chats,
  creating models and prompts, own tool servers, own LLM connections, API
  keys); groups add permissions, extra models and higher usage caps. Groups
  can be linked to directory groups and synced at each LDAP sign-in, and an
  LDAP admin group can make admins.
- **Model builder** (Workspace → Models): a custom model is a base model with
  its own system prompt (`{{USER_NAME}}`, `{{CURRENT_DATE}}` …), parameters,
  tools and starter prompts. It is private until shared with groups, people or
  everyone, and runs with its owner's model access, so a group can get an
  assistant without the raw model.
- **Prompt library** (Workspace → Prompts): `/command` texts with
  `{{variables}}` (and `{{name:default}}`) that the composer asks for before
  putting the text in the message box. Shared the same way as models.
- **Memory** (Settings → Memory): things every chat should know about you,
  sent with each message (can be switched off).
- **Your own tool servers** (Settings → Tools): remote MCP servers (HTTP or
  SSE) through the SSRF guard, with the `mcp.user_servers` permission.
- **API keys and an OpenAI-compatible API** (Settings → API keys): `ck-…`
  keys for `https://<host>/api/v1` (`/models`, `/chat/completions`, streaming
  and tool calls). The OpenAI SDKs and Claudia desktop (as a custom OpenAI
  provider) work against it. Keys work only there, only while their owner
  has the permission, and count against the caps.
- **Usage caps** (Admin → Settings, groups, and per user under Admin → Users
  → Access): tokens and known cost per UTC day and month. A request is refused
  once a cap is reached; admins are not capped.

Phase 2 (rich chat UX):

- **Math and diagrams:** LaTeX (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`, with prices
  like "$5" left alone) and Mermaid diagrams (loaded on first use, strict
  mode). The desktop app renders them too.
- **Versions:** regenerate a reply or edit a message to get a new version
  next to the old one (`‹ 2/3 ›`), fork a chat from any message, and rate
  replies (👎 asks what was wrong).
- **Several models at once:** "Compare models" sends a message to up to four
  models, whose answers show side by side; the chat continues from the one
  you pick.
- **Per chat:** system prompt and parameters (temperature, top P, max tokens,
  penalties) under the chat's settings button, follow-up question
  suggestions under each reply (Admin → Settings can turn them off), and a
  queue for messages typed while a reply is still being written.
- **Temporary chats** (the ghost button on a new chat): not listed, not
  titled, deleted after a day without activity unless you keep them.
- **Finding and organising:** search finds words inside messages (with a
  snippet), plus tags, archived chats and folders inside folders.
- **Export and import** (Settings → Data): Claudia JSON with every version,
  and imports of Claudia desktop conversation folders, Open WebUI exports and
  ChatGPT's `conversations.json` (converted in the browser).
- **Share links:** a read-only snapshot of the chat as it is now, for anyone
  with the link, deleted at once when you delete the link. Tool screens and
  attachment contents aren't shared, and the chat's text can't run script for
  the people who open it.

Earlier phases: the Phase 1a chat core (local accounts with admin approval,
admin-managed LLM connections and model allowlists, server-side streaming
chats that survive reloads and resume in another tab, folders, per-user
settings, rate limits, a responsive UI) and Phase 1b:

- **LDAP / Active Directory sign-in** (Admin → Directory), hardened: empty
  passwords never reach the directory, usernames are escaped in filters,
  accounts link by entryUUID/objectGUID (never by email), and users removed
  from the directory lose their sessions at the next token refresh.
- **Tools (MCP):** admin-managed shared servers (Admin → Tools) and the
  built-ins (files, Word documents, diagrams, web fetch), each user's copy
  confined to a private workspace in `DATA_DIR/workspaces/<user>`. Users
  switch tools on under Settings → Tools. MCP-UI renders only from the sandbox
  origin, may only call tools of the server that produced it, and asks before
  tools marked destructive.
- **Attachments:** uploads are stored in `DATA_DIR/storage`; PDF, Word,
  Excel, PowerPoint, HTML and text are parsed in a worker pool with size, time
  and zip-bomb limits, and their text reaches the model. Images are sent as
  images.
- **Skills** stored in the database (built-ins plus each user's own;
  `/skill args` in the composer).
- **Personal connections** (the `connections.own` permission, off by
  default): users add their own API keys, and every request they cause goes
  through the SSRF guard.

The first account to sign up becomes the admin (or set
`CLAUDIA_ADMIN_EMAIL` / `CLAUDIA_ADMIN_PASSWORD`). Add a connection under
**Admin → Connections** to start chatting.

## Development

```bash
cd web
npm install
npm run dev          # API on :8080 (tsx watch) + Vite on :5180 (proxies /api)
```

Without `DATABASE_URL` the server uses an embedded PGlite database in
`./data/pglite`. That is for development and trials only.

| Command | What it does |
|---|---|
| `npm test` | Server tests (PGlite; on PostgreSQL when `TEST_DATABASE_URL` is set, one throwaway database per test) and client tests |
| `npm run test:e2e` | Browser tests of the Phase 1a–3 flows against the production build (run `npm run build` first; `npx playwright install chromium` once) |
| `npm run type-check` | Client and server, including the shared `../src` code |
| `npm run build` | Client (`dist/client`) and server bundle (`dist/server/index.cjs`) |
| `npm start` | Run the production build |
| `npm run db:generate` | New migration from the Drizzle schema (`server/db/schema`) |
| `npm run db:migrate` | Apply migrations and exit (the server also migrates on start) |
| `npm run check:shared-deps` | Every package shared code imports is in `web/package.json` with a version compatible with the root |
| `npm run check:bundle` | The client bundle holds one copy of React and Redux |
| `npm run cli -- admin create --email … --password …` | Create or promote an admin (LDAP-only installs) |
| `npm run cli -- rotate-keys` | Re-encrypt stored secrets after changing `CLAUDIA_SECRET_KEY` (old key in `CLAUDIA_SECRET_KEY_PREVIOUS`) |

In the image the CLI is `node dist/server/cli.cjs …`.

## Docker

```bash
cd web/docker
export CLAUDIA_SECRET_KEY=$(openssl rand -base64 48)
docker compose up -d --build     # app + pgvector/pgvector:pg16
```

The image is built from the repository root and installs only `web/`'s
dependencies.

## Configuration

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | — | `postgres://…` (PostgreSQL 16+ with pgvector). Unset: embedded PGlite |
| `DATA_DIR` | `./data` | Uploads, workspaces, embedded database |
| `PORT`, `HOST` | `8080`, `0.0.0.0` | |
| `CLAUDIA_SECRET_KEY` | — | Root secret (≥ 32 characters); keys for sessions and encrypted secrets derive from it. Without it a key file is generated in `DATA_DIR` (trials only) |
| `CLAUDIA_SECRET_KEY_PREVIOUS` | — | Old root secrets (comma-separated), still accepted while rotating |
| `CLAUDIA_PUBLIC_URL` | — | Public URL of the app |
| `CLAUDIA_SANDBOX_ORIGIN` | — | Separate origin for MCP-UI, artifacts and file previews (a host routed to this server) |
| `CLAUDIA_SANDBOX_PORT` | — | Single-host trials: serve the sandbox on this port instead (needs `CLAUDIA_PUBLIC_URL`) |
| `ENABLE_PASSWORD_AUTH` | `true` | Local email + password sign-in |
| `CLAUDIA_ADMIN_EMAIL`, `CLAUDIA_ADMIN_PASSWORD` | — | Create the first admin on first boot |
| `CLAUDIA_ALLOW_STDIO_MCP` | `false` | Allow admins to configure stdio MCP servers (they run commands on the host, with only their own environment variables) |
| `ENABLE_LDAP` | — | Directory sign-in on/off; overrides the admin setting |
| `LDAP_URL`, `LDAP_START_TLS` | — | `ldap://host:389` or `ldaps://host:636`; StartTLS for `ldap://` |
| `LDAP_BIND_DN`, `LDAP_BIND_PASSWORD` | — | Service account that looks users up |
| `LDAP_USER_SEARCH_BASE`, `LDAP_USER_FILTER` | — | e.g. `ou=people,dc=example,dc=com` and `(uid={{username}})` (AD: `(sAMAccountName={{username}})`) |
| `LDAP_CA_CERT_FILE` | — | PEM of the CA that signed the directory's certificate |
| `LOG_LEVEL` | `info` | |

Streaming behind a reverse proxy needs buffering off for `/api` (nginx:
`proxy_buffering off;` and a read timeout longer than the longest run).
Session cookies get `Secure` when `CLAUDIA_PUBLIC_URL` is https.

Every `LDAP_*` variable that is set wins over the admin page and shows there
as read-only; the rest (attribute names, allowed group, role of new accounts,
re-check interval) are set under **Admin → Directory**. On a directory-only
install (`ENABLE_PASSWORD_AUTH=false`) nobody can sign in with a password, so
make the first admin with the CLI after their first directory sign-in:
`node dist/server/cli.cjs admin promote --email <email>`.

To try LDAP locally, `docker compose -f docker/compose.ldap.yml up -d` starts
an OpenLDAP with test users (see the file); CI runs the LDAP integration tests
against it.

`rotate-keys` re-encrypts every stored secret (connection keys, tool server
headers and environment variables, the LDAP bind password) with the new key.

On a managed PostgreSQL where the app's role can't create extensions, run
`CREATE EXTENSION vector;` once as an administrator before the first start.

## OpenAI-compatible API

Create a key under Settings → API keys (needs the `api.keys` permission,
off by default), then:

```bash
curl https://claudia.example.com/api/v1/chat/completions \
  -H "Authorization: Bearer ck-…" -H "Content-Type: application/json" \
  -d '{"model": "openai/gpt-4o", "messages": [{"role": "user", "content": "Hi"}]}'
```

Model ids are the ones in `GET /api/v1/models` (`<connection prefix>/<model>`,
`custom/<id>` for custom models). Tools in the request go to the model and
its tool calls come back to you; the server's own tools (MCP) are for chats in
the app only. Claudia desktop can use it as an OpenAI-compatible custom
provider with the base URL `https://claudia.example.com/api/v1`.

## Note for Windows developers

If `npm install` fails building `sharp` from source, check for
`npm_config_build_from_source=false` in your environment: sharp reads any
value as "true". Unset it for the install.
