# Claudia Web

The multi-user, self-hostable web version of Claudia. It reuses the desktop
app's code in `../src` (components, providers, stream parser) and
`../electron/services` (MCP, built-in tools) through aliases and the platform
adapter in `src/platform`. See [PLAN.md](PLAN.md) for the design and roadmap.

Status: **Phase 1a** (multi-user chat core): local accounts with admin
approval, admin-managed LLM connections and model allowlists, server-side
streaming chats that survive reloads and can be resumed in another tab,
folders, per-user settings, rate limits, and a responsive UI.

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
| `npm run test:e2e` | Browser tests of the Phase 1a flow against the production build (run `npm run build` first; `npx playwright install chromium` once) |
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
| `CLAUDIA_ALLOW_STDIO_MCP` | `false` | Allow admins to configure stdio MCP servers |
| `LOG_LEVEL` | `info` | |

Streaming behind a reverse proxy needs buffering off for `/api` (nginx:
`proxy_buffering off;` and a read timeout longer than the longest run).
Session cookies get `Secure` when `CLAUDIA_PUBLIC_URL` is https.

On a managed PostgreSQL where the app's role can't create extensions, run
`CREATE EXTENSION vector;` once as an administrator before the first start.

## Note for Windows developers

If `npm install` fails building `sharp` from source, check for
`npm_config_build_from_source=false` in your environment: sharp reads any
value as "true". Unset it for the install.
