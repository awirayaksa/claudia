# Claudia Web: remaining tasks

All phases of [PLAN.md](PLAN.md) are built (branch `web-phase-0`, not yet
merged into `main`). What is left:

## Security

- [ ] **Desktop MCP-UI sandbox escape.** `src/components/chat/UIResourceDisplay.tsx`
      renders MCP-UI HTML with `allow-same-origin` + `allow-scripts`, so a
      malicious MCP server could read the decrypted API keys or start stdio
      commands. Not confirmed with a proof of concept. The web app is not affected.
- [ ] **`npm audit --omit=dev`:** 11 findings (2 high, 4 moderate, 5 low).
      Check whether each is reachable, then upgrade:
  - [ ] `adm-zip` <= 0.6.0 (high)
  - [ ] `sharp` <= 0.35.5-rc.1 (high)
  - [ ] `katex` 0.11.0–0.18.1
  - [ ] `uuid` < 11.1.1 (moderate)
  - [ ] `sprintf-js` (moderate)

## Limitations

- [ ] **Shared workspace volume.** Built-in file tools keep per-user workspaces
      in `DATA_DIR`, so instances on several hosts need a shared filesystem (NFS
      etc.). S3 only covers uploaded files.
- [ ] **Runs are tied to one instance.** If it dies, followers are told the run
      failed within about a minute, but the partial reply can stay `streaming`
      in the database. Add a sweep for stale replies.
- [ ] **SSO is OpenID Connect only.** Plain OAuth 2 providers (e.g. GitHub) are
      not supported.
- [ ] **SSO admin groups only promote.** Leaving the admin group never demotes.
- [ ] **Translations:** only English ships.
- [ ] **SCIM DELETE is a hard delete** (removes the user's chats). Consider
      deactivate-then-purge, as Entra ID does.
- [ ] **Rate limits fail open when Redis is down.** The per-account sign-in
      backoff still applies.
- [ ] **OpenTelemetry gaps:** no spans for PostgreSQL queries or for axios calls.

## Tested only against fakes

- [ ] Real OIDC providers (Entra ID, Google, Okta, Keycloak).
- [ ] Real SCIM clients (Entra ID, Okta).
- [ ] Real Google Drive and OneDrive.
- [ ] Real S3 / MinIO (tests use Adobe S3Mock).
- [ ] Rerun the two-replica Docker smoke test (`compose.scale.yml`), last run in
      Phase 6.
- [ ] Push the branch so CI runs: the `web-scale` job (Redis/S3Mock services)
      and the Docker build fix (`check-shared-deps`) have never run on GitHub.

## Deferred in the plan

- [ ] Server-side (container) code execution.
- [ ] Sub-agents ("revisit after Phase 5", no decision yet).
- [ ] Move the desktop app to the web's conversation format (message tree,
      sharing, multi-model).

## Housekeeping

- [ ] Commit the Linux-build work: `.github/workflows/release.yml`, root
      `README.md` and `package.json`, `electron-builder.json`, `electron/`,
      `build/icons/`, `scripts/after-pack.js`, `scripts/check-linux-build-host.js`,
      `scripts/create-linux-icons.js`.
- [ ] Add `"type"` to the root `package.json` (fixes the `tailwind.config.js`
      `MODULE_TYPELESS_PACKAGE_JSON` warning in `npm run dev`).
- [ ] Desktop lint: 443 warnings, 0 errors.
- [ ] Pin `searxng:latest` in the compose files.
- [ ] Translate the `MCPSettings` alert strings.
- [ ] Stop the local test containers: `claudia-test-pg`, `claudia-test-redis`,
      `claudia-test-s3`.

## Suggested order

1. MCP-UI sandbox fix and the high-severity dependency upgrades.
2. Push the branch and let CI run everything, including the two-replica test.
3. Try SSO, SCIM and the cloud pickers against real providers.
