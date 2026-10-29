# Claudia Web

The multi-user, self-hostable web version of Claudia. It reuses the desktop
app's code in `../src` (components, providers, stream parser) and
`../electron/services` (MCP, built-in tools) through aliases and the platform
adapter in `src/platform`. See [PLAN.md](PLAN.md) for the design and roadmap.

Status: **Phase 7** (optional extras), the last phase of [PLAN.md](PLAN.md),
plus feature-parity work with Claude (issue #15):

- **Long chats keep going** (Admin → Settings → Long chats): near the
  model's context limit, the oldest exchanges are summarized and the summary
  is sent in their place (the last few stay word for word). The summary is
  kept on the chat and reused; a divider in the chat opens to show it.
- **Memory that learns** (Settings → Memory): once a chat has been quiet for
  a while, a model reads it for lasting facts (work, preferences, projects,
  people) and merges them with what is remembered, grouped by topic. Admins
  can also give the model memory tools to save, change and forget memories
  during a chat. Every change shows as a chip under the reply, where it can
  be undone. Temporary chats are never read; sensitive topics (health,
  finances…) are skipped unless the user allows them. Memories can belong to
  one folder (a project), and another assistant's memories can be imported.
- **Remote MCP servers with OAuth sign-in** (Settings → Tools for your own
  servers, Admin → Tools for shared ones): paste the server's URL, tick
  "Sign in with OAuth" and press Connect. Claudia follows the MCP
  authorization spec (protected-resource and authorization-server discovery,
  dynamic client registration or a pre-registered client, PKCE), keeps the
  tokens encrypted and refreshes them when they expire; Disconnect revokes
  them. An admin's sign-in to a shared server is used by everyone. The
  authorization server sends the browser back to `/api/mcp/oauth/callback`,
  so set `CLAUDIA_PUBLIC_URL` behind a proxy.
- **Shared folders (projects)** (a folder's menu → Share…): share a folder
  with people or groups as viewers or editors. They see it, with its
  subfolders, and their own chats in it use its instructions and knowledge
  (searched with the owner's access); nobody sees anyone else's chats in it.
  Editors can change its name, instructions and knowledge; only the owner
  shares, moves or deletes it.
- **GitHub repositories as knowledge** (Workspace → Knowledge → a knowledge
  base → Add a GitHub repository): the chosen folders and files of a
  branch or tag (documents, text and code, up to 500 files) come in as the
  knowledge base's files. Sync now pulls the latest commit: changed files
  are replaced, removed ones leave, and an unchanged commit downloads
  nothing. Private repositories and GitHub Enterprise take an access token,
  stored encrypted; requests go through the SSRF guard.
- **Code runs on the server** (Admin → Settings → Code interpreter): instead
  of Pyodide in the browser, the model's `run_code` tool (Python or Node.js)
  runs in a fresh Docker container per run: no network (unless allowed), an
  unprivileged user without capabilities, memory, CPU, process and time
  limits, optionally gVisor (`runsc`). The chat's attachments are copied into
  `/workspace`; files the code writes (charts, spreadsheets…) come back under
  the reply, and what it prints streams into the reply as it runs. See
  [Code runs on the server](#code-runs-on-the-server).
- **Continue** a reply cut off at the output limit: it says so, and Continue
  carries on in the same message (usage adds up both parts).
- **Long pastes become attachments** (Preferences → Attach long pastes): a
  paste of 2,000 characters or 40 lines becomes a "Pasted text" chip that is
  sent whole; click it to read it or put it back in the message box.
- **Writing styles** (the pen button by the message box; Settings → Styles):
  Normal, Concise, Explanatory, Formal, and styles of your own, written by
  hand or drafted by the model from a sample of writing. Shared like prompts;
  admins can make styles for everyone. The chat keeps the last one used.
- **Export a chat as Markdown or PDF** (the chat menu), besides Claudia JSON:
  the branch that is shown, tool calls folded, images embedded in the PDF.
- **Past chats** (the clock button above the message box; Settings → Memory
  to have it on by default): the model can search your earlier chats and
  list recent ones, and cites the ones it used. Only your own, never
  temporary ones, and inside a folder only that folder's.

Phase 7 adds:

- **Single sign-on** (Admin → Sign-in): any OpenID Connect provider (Entra
  ID, Google, Okta, Keycloak, Authentik…) as "Continue with …" buttons, with
  allowed domains, linking rules, admin groups and group sync from a claim.
- **Two-factor sign-in:** authenticator-app codes (TOTP) with recovery codes,
  after a password, directory or SSO sign-in; admins can require it for
  admins or everyone, and reset it for someone who lost their phone.
- **SCIM 2.0 provisioning** at `/scim/v2`: an identity provider creates,
  updates, deactivates and deletes accounts and groups. Accounts can also be
  deactivated by hand (sessions and API keys stop at once).
- **Blind comparisons and a leaderboard** (Admin → Evaluations): "Arena
  (blind)" answers with two unnamed models; users vote, then see which was
  which; votes give Elo ratings.
- **Notes** (sidebar): Markdown notes, private until shared, that a chat can
  refer to with `#`.
- **Channels** (sidebar): rooms where people talk, live, and ask a model by
  mentioning it (`@openai/gpt-4o …`); admins create them and choose members.
- **Scheduled prompts** (sidebar, permission "Scheduled prompts"): a prompt
  sent on a cron schedule in your time zone, its reply in a chat.
- **Google Drive and OneDrive** (Admin → Integrations): users connect their
  own account and add files to a chat from the composer's cloud button.

Phase 6 (admin and operations):

- **Several instances** behind a load balancer: with `REDIS_URL` set, a reply
  started on one instance can be followed, stopped and answered (browser
  tools) from any other; WebSocket events, rate limits, the sign-in backoff
  and settings changes are shared, and new jobs wake every instance's workers
  (PostgreSQL LISTEN/NOTIFY). No sticky sessions needed.
- **S3 storage** (`S3_BUCKET`, AWS or any S3-compatible server) instead of
  `DATA_DIR`, so every instance sees every file.
- **Usage analytics** (Admin → Analytics): tokens, cost, requests and active
  users per day, by model, user and use, with CSV export.
- **Webhooks** (Admin → Webhooks): user, reply, knowledge and audit events
  POSTed as JSON and signed with HMAC-SHA256 (see [Webhooks](#webhooks)).
- **Audit log** (Admin → Audit log): sign-ins (and failures), sign-outs,
  sign-ups, API keys and every change made through the admin pages, with
  secrets removed; kept for a set number of days, exportable as CSV.
- **Banners** and **defaults for users** (Admin → Settings): notices at the
  top of every page (optionally dismissible, optionally timed), and the
  theme, text size, display options and system prompt users have until they
  change them.
- **Installable app (PWA):** a manifest, icons and a service worker that
  caches the app's own files (never the API or user data).
- **Translatable shared components:** the desktop components the web app
  reuses take their text from the web app's language files (see
  [Translating](#translating)). English only so far.
- **OpenTelemetry** traces (`OTEL_EXPORTER_OTLP_ENDPOINT`): requests, model
  calls (GenAI conventions, token counts, never message text), tool calls,
  jobs and outgoing HTTP, with W3C trace context in and out.

Phase 5 (advanced tools):

- **Code interpreter** (the Code button above the message box): the model
  runs Python with Pyodide in your browser, in a hidden frame on the sandbox
  origin, and gets what it printed. Files the code writes in its working
  folder (`/home/pyodide`) are kept as your files and shown under the reply
  to download (up to 10 per run, 25 MB each). If no tab answers (it was
  closed), the model is told so after two minutes and the reply carries on.
- **Artifacts:** HTML pages, SVG images and React components in a reply get
  a Preview button; they run on the sandbox origin in a script-only frame
  with no network, cookies, storage or access to the app.
- **Image generation** (the Image button; Admin → Media): OpenAI-compatible,
  AUTOMATIC1111, ComfyUI (your workflow) or Gemini. Pictures are kept as the
  user's files and shown in the reply.
- **Voice** (Admin → Media): dictation and read-aloud with the browser's own
  speech (the default) or an OpenAI-compatible Whisper / TTS endpoint.
- **Anthropic and Ollama connections**, native (tools, thinking, images).
- **OpenAPI tool servers** (Admin → Tools): each operation of a spec becomes
  a tool, next to the MCP servers.
- **Plugins** (Admin → Plugins): renderer plugins as ES modules (the
  desktop's plugin API), importing `react`, `react/jsx-runtime` and `unified`
  from the app. They run with the page's privileges, so only admins install
  them.

The code interpreter and previews need a sandbox origin
(`CLAUDIA_SANDBOX_ORIGIN`, or `CLAUDIA_SANDBOX_PORT` for single-host trials).
Pyodide is served from it; packages like numpy load from the Pyodide CDN when
code imports them.

Phase 4 (knowledge and search):

- **Knowledge bases** (Workspace → Knowledge): PDF, Word, Excel, PowerPoint,
  HTML, Markdown and text files are split into passages (keeping pages,
  slides, sheets and headings) by a background job, with live progress. They
  are private until shared, like models and prompts.
- **Search and citations:** chats get the most relevant passages — keyword
  search (PostgreSQL full-text) fused with vector search (pgvector) when an
  embedding engine is set up, optionally reranked — or whole documents in
  full-context mode. Replies cite them as `[1]`, `[2]`; clicking a number shows
  the passage.
- **References with `#`:** type `#` in a message for a knowledge base, a web
  page (or YouTube video, by its transcript) or another of your chats; or
  write `#https://…` in the text. Pages are read through the SSRF guard.
- **Knowledge for folders and custom models:** every chat in a folder, or
  every answer of a custom model, searches the knowledge bases attached to it.
- **Web search** (the globe above the message box): SearXNG, Brave, Tavily,
  Google Programmable Search or DuckDuckGo, with the result pages read and
  cited. A SearXNG container is included (`docker compose --profile search`).
- **Memory by relevance:** with embeddings on and many memories, only the
  ones closest to the message are sent.
- **Admin → Knowledge:** the embedding engine (OpenAI-compatible, Ollama, or
  local transformers.js when `@huggingface/transformers` is installed),
  passage size, passages per message, reranker (Cohere-style or TEI) and web
  search. Without an embedding engine, knowledge works on keyword search.

Phase 3 (workspace):

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
  sent with each message (can be switched off). Since the feature-parity
  work, memories are sorted into topics, can belong to one folder, are
  learned from chats and can be imported (see the top of this file).
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
  built-ins (files, Word documents, Excel spreadsheets, PowerPoint decks, PDF,
  diagrams, web fetch), each user's copy confined to a private workspace in
  `DATA_DIR/workspaces/<user>`. Users switch tools on under Settings → Tools;
  on servers whose admin saved the built-in list before an upgrade, new
  built-ins start off there until the admin ticks them under Admin → Settings. MCP-UI renders only from the sandbox
  origin, may only call tools of the server that produced it, and asks before
  tools marked destructive.
- **Workspace files:** to save in a particular place, the user says so in the
  message ("save it as reports/q3.md"); paths are relative to the workspace and
  missing folders are created. Every file a Files, Word, Spreadsheets,
  Presentations, PDF or Diagrams tool creates or changes is linked under the reply (once per reply, downloading the
  current file). Settings → Files → Workspace browses the workspace: download,
  upload, new folder, delete. Paths are checked like the tools' (no `..`, no
  links out); shared chats keep only the file names.
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
| `npm test` | Server tests (PGlite; on PostgreSQL when `TEST_DATABASE_URL` is set, one throwaway database per test; two-instance tests with `TEST_REDIS_URL`; S3 tests with `TEST_S3_ENDPOINT`) and client tests |
| `npm run test:e2e` | Browser tests of the Phase 1a–7 flows against the production build (run `npm run build` first; `npx playwright install chromium` once) |
| `npm run type-check` | Client and server, including the shared `../src` code |
| `npm run build` | Client (`dist/client`) and server bundle (`dist/server/index.cjs`) |
| `npm start` | Run the production build |
| `npm run db:generate` | New migration from the Drizzle schema (`server/db/schema`) |
| `npm run db:migrate` | Apply migrations and exit (the server also migrates on start) |
| `npm run check:shared-deps` | Every package shared code imports is in `web/package.json` with a version compatible with the root |
| `npm run check:bundle` | The client bundle holds one copy of React and Redux |
| `node scripts/shared-strings.mjs` | Regenerate `client/i18n/locales/en.shared.json` from the shared components (`--check` in CI) |
| `node scripts/scale-smoke.mjs` | The cross-instance test against `docker/compose.scale.yml` (two instances, Redis, PostgreSQL, S3) |
| `node scripts/make-pwa-icons.mjs` | Regenerate the app icons in `public/icons` from `../build/icon.png` |
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
dependencies. `CLAUDIA_LIBREOFFICE=1 docker compose up -d --build` also
installs LibreOffice in it (about 600 MB more) and sets `LIBREOFFICE_PATH`,
so Word, Excel and PowerPoint files convert to PDF exactly.

For an air-gapped Ubuntu 24.04 host, `deploy/airgap/prepare-bundle.ps1`
builds one offline bundle (images, Docker Engine packages, installer) on a
connected Windows machine; see [deploy/airgap/README.md](deploy/airgap/README.md).

### Several instances

```bash
cd web/docker
export CLAUDIA_SECRET_KEY=$(openssl rand -base64 48)
docker compose -f compose.scale.yml up -d --build --wait
```

starts two instances behind nginx (round robin, :8080; each instance on
:8081 and :8082) with PostgreSQL, Redis and an S3 test server. Every
instance needs the same `CLAUDIA_SECRET_KEY`, `DATABASE_URL`, `REDIS_URL` and
`S3_*`. Instances starting together take turns migrating the database. The
built-in file tools keep per-user workspaces in `DATA_DIR`, which instances
on different hosts must share (e.g. NFS). A reply runs on the instance that
received it; if that instance stops, its followers are told the reply failed
within about a minute and the branch can be answered again.

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
| `CLAUDIA_CODE_DOCKER` | — | Docker Engine API for server-side code runs: `unix:///var/run/docker.sock`, `tcp://host:2375` or `https://host:2376` (see [Code runs on the server](#code-runs-on-the-server)) |
| `CLAUDIA_MEMORY_IDLE_SECONDS` | `120` | How long a chat stays quiet before it is read for memories to learn |
| `ENABLE_LDAP` | — | Directory sign-in on/off; overrides the admin setting |
| `LDAP_URL`, `LDAP_START_TLS` | — | `ldap://host:389` or `ldaps://host:636`; StartTLS for `ldap://` |
| `LDAP_BIND_MODE` | `search` | `search`: a service account looks the user up, then the user binds. `direct` (Active Directory): users bind as `username@domain`, the domain being `LDAP_SIGN_IN_DOMAIN`, else the `dc=` parts of `LDAP_USER_SEARCH_BASE` (the base DN); no service account or search |
| `LDAP_SIGN_IN_DOMAIN` | | Direct bind: the domain added when a user types only their username, i.e. their UPN suffix (`app.example.com` lets `john` and `john@app.example.com` sign in to the same account). Empty: the base DN's `dc=` parts |
| `LDAP_BIND_DN`, `LDAP_BIND_PASSWORD` | — | Service account that looks users up |
| `LDAP_USER_SEARCH_BASE`, `LDAP_USER_FILTER` | — | e.g. `ou=people,dc=example,dc=com` and `(uid={{username}})` (AD: `(sAMAccountName={{username}})`) |
| `LDAP_CA_CERT_FILE` | — | PEM of the CA that signed the directory's certificate |
| `REDIS_URL` | — | `redis://…` or `rediss://…`. Needed for more than one instance |
| `REDIS_PREFIX` | `claudia:` | Prefix of every Redis key and channel |
| `S3_BUCKET` | — | Keep files in this bucket instead of `DATA_DIR` |
| `S3_REGION` | `us-east-1` | |
| `S3_ENDPOINT` | — | S3-compatible server, e.g. `http://minio:9000`; omit for AWS |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | — | Both or neither; neither uses the AWS credential chain (instance role, env, profile) |
| `S3_FORCE_PATH_STYLE` | `false` | Bucket in the path (most S3-compatible servers) |
| `S3_PREFIX` | — | Prefix of every object key, e.g. `claudia/` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | OTLP/HTTP collector for traces, e.g. `http://otel-collector:4318`; `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_HEADERS` and the sampler variables are read too |
| `LOG_LEVEL` | `info` | |
| `LIBREOFFICE_PATH` | — (`/usr/bin/soffice` in an image built with LibreOffice) | `soffice` used to convert Word, Excel and PowerPoint files to PDF exactly. Unset or empty: an approximate conversion of the content. LibreOffice may fetch resources a document links to while converting, so use it only where that is acceptable; `LIBREOFFICE_PATH=` turns it off in an image that has it |

Streaming behind a reverse proxy needs buffering off for `/api` (nginx:
`proxy_buffering off;` and a read timeout longer than the longest run).
Live updates use a WebSocket at `/api/ws`; the proxy must pass the upgrade
(nginx: `proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";`) and keep the `Host` header.
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

## Code runs on the server

With **Admin → Settings → Code interpreter → In a sandbox on the server**,
code the model writes runs in Docker containers that Claudia creates through
the Engine API (`CLAUDIA_CODE_DOCKER`). Nothing is mounted from the host:
attachments go in and output files come out through the API's archive
endpoints, so the Docker host can be another machine. Each run gets a new
container (removed afterwards) with `--network none`, user `65534`, all
capabilities dropped, `no-new-privileges`, a process limit and the memory,
CPU and time limits you set; a run that hits one is stopped and the model is
told why.

Access to a Docker API is powerful: whoever controls the app could start
any container on that host. So:

- **Safest:** a separate small VM that only runs code, with
  [gVisor](https://gvisor.dev/docs/user_guide/install/) installed (set the
  runtime to `runsc`), its API reachable only from the app (firewall, or TLS
  with `https://`).
- **Same host:** `docker compose -f docker-compose.yml -f compose.code.yml up -d`
  puts a socket proxy in front of the local Docker socket that only allows
  the endpoints code runs use.

The default images (`python:3.12-slim`, `node:22-slim`) only have the
standard libraries; build `web/docker/sandbox` (`docker build -t
claudia-sandbox web/docker/sandbox`) for numpy, pandas, matplotlib,
scikit-learn and more, plus Node.js, and set both images to
`claudia-sandbox`. **Test the sandbox** pulls missing images and runs a test
program. To run the real-Docker tests: `CLAUDIA_TEST_DOCKER=unix:///var/run/docker.sock npm test -- server/code`.

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

## Webhooks

Each delivery is a JSON `POST` (`{ id, event, createdAt, data }`) with the
headers `X-Claudia-Event`, `X-Claudia-Delivery` (the id),
`X-Claudia-Timestamp` (Unix seconds) and
`X-Claudia-Signature: v1=<hex HMAC-SHA256 of "<timestamp>.<raw body>">`
under the webhook's secret (shown once, when it is created or replaced).
Check it like this, and refuse timestamps more than five minutes away:

```js
const expected = 'v1=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
```

A delivery that fails with a network error, a timeout (10 s) or a 5xx, 408 or
429 answer is retried twice (after about 2 and 8 seconds); other 4xx answers
are not. Events: `user.created`, `user.updated`, `run.completed` (ids, models,
status, token counts; never message text), `knowledge.file_processed`,
`knowledge.file_failed` and `audit.recorded`. Webhooks are admin-only and may
point at internal addresses.

## Single sign-on, two-factor and provisioning

**OpenID Connect.** Under Admin → Sign-in → Add provider, enter the issuer
(e.g. `https://login.microsoftonline.com/<tenant>/v2.0`,
`https://accounts.google.com`, `https://<keycloak>/realms/<realm>`), the client
ID and secret, and register the redirect URI shown there
(`<CLAUDIA_PUBLIC_URL>/api/auth/oidc/<id>/callback`) with the provider. The
flow is the authorization code flow with PKCE; the ID token is checked
against the provider's keys. A first sign-in links to an existing account
only if "link by verified email" is on, or the account has no password and no
other sign-in (made by SCIM or an admin for SSO). With a groups claim, Claudia
groups of the same names follow the provider's groups.

**Two-factor sign-in** works with any authenticator app. "Required" holds
people without it on a set-up screen until they turn it on; an admin can reset
it under Admin → Users.

**SCIM.** Under Admin → Sign-in → Provisioning, create a token and give your
identity provider the base URL (`<CLAUDIA_PUBLIC_URL>/scim/v2`) and the token.
Users (userName = email) and groups are supported, with `eq` filters and
PATCH as Entra ID and Okta send it. `active: false` deactivates an account;
deleting one deletes it with its chats.

## Google Drive and OneDrive

Under Admin → Integrations, enter an OAuth client for each (the page shows the
redirect URI to register):

- **Google:** in the Cloud console enable the Drive API and create an OAuth
  client of type "Web application". Claudia asks for `drive.readonly`.
- **Microsoft:** an Entra ID app registration with a Web redirect URI, the
  delegated Graph permissions `Files.Read.All` and `User.Read`, and a client
  secret. The tenant is `common`, `organizations` or yours.

Each user connects their own account in a pop-up; tokens are stored
encrypted and refreshed as needed. Picked files are copied into Claudia
(Google Docs, Sheets and Slides as Word, Excel and PowerPoint).

## Azure DevOps Server / TFS

The Azure DevOps built-in tools find, read, create and update work items on an
on-premises Azure DevOps Server or TFS 2018 and later: queries (filters or
WIQL), details with links and comments, new tasks and bugs, state changes,
resolving, comments and links.

1. Under Admin → Integrations, add each collection by its URL
   (`https://tfs.example.com/tfs/DefaultCollection`) and the server version,
   which sets the REST API version. Claudia may reach these hosts even when
   they are private, but only these: the tools name paths under a
   collection, never URLs, and redirects are refused.
2. Under Admin → Settings → Built-in tools, offer **Azure DevOps**.
3. Each user switches the tool on under Settings → Tools and connects with a
   personal access token (scopes: *Work Items* read & write, *Project and
   Team* read), optionally with a default project. The token is checked,
   stored encrypted (re-encrypted by `rotate-keys`) and never shown again.

Tools that change work items wait for the user: the reply shows what the
tool will do, with Approve and Reject. Without an answer within 10 minutes
the change is skipped, and the model is told it wasn't made. Reads run at
once.

Use https: over http the token travels unencrypted. For a server with a
certificate from a corporate CA, point `NODE_EXTRA_CA_CERTS` at the CA's PEM
file.

## Translating

The web app's own text is in `client/i18n/locales/en.json`; the text of the
shared desktop components is in `en.shared.json`, generated from their
`t('key', 'English')` calls by `node scripts/shared-strings.mjs`. To add a
language, copy both to `<lang>.json` and `<lang>.shared.json` (e.g. `de`)
and translate the values; keep `{{placeholders}}`. The browser's preferred
languages pick it, and anything not yet translated shows in English.
Languages: English, Arabic (`ar`).

Right-to-left languages such as Arabic mirror the whole page (`dir="rtl"`),
so layout classes are logical: `ms-`/`me-`, `ps-`/`pe-`, `start-`/`end-`,
`border-s`/`border-e`, `text-start`/`text-end` rather than left and right.
Code stays left-to-right, and message text follows its own direction. In a
right-to-left translation, wrap left-to-right snippets such as
`<prefix>/<model>` in `⁦…⁩` so they keep their order. Languages
with more plural forms than English (Arabic has `_zero`, `_one`, `_two`,
`_few`, `_many`, `_other`) give each form.

## Note for Windows developers

If `npm install` fails building `sharp` from source, check for
`npm_config_build_from_source=false` in your environment: sharp reads any
value as "true". Unset it for the install.
