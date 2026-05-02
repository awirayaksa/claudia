# Settings Profiles

## Context

The Settings panel today owns a single, monolithic `config` (api / appearance / preferences) persisted in `electron-store`. Users who context-switch between work and personal accounts, or test multiple API providers/keys, currently have to edit individual fields one at a time — losing the previous configuration in the process.

The goal is to let a user define **multiple named settings profiles**, each carrying its own copy of the full `config` (including encrypted API keys), and switch between them in one click. A profile switcher lives inside the Settings panel header, and a new "Profiles" tab manages CRUD.

User-confirmed scope:
- A profile contains the **full `config`** (api + appearance + preferences). MCP servers, plugins, and skills remain **shared/global**.
- Switcher UI: header dropdown in `SettingsPanel.tsx` + a new "Profiles" tab. No main-app chrome changes.
- Each profile owns its **own encrypted API keys per provider**.
- Switching with unsaved Settings edits reuses the existing "discard?" confirm dialog.

---

## Architecture

### Storage shape (single source of truth: main process)

In `electron/services/store.service.ts`, add to `StoreSchema`:

```ts
profiles: Record<string, {
  id: string;
  name: string;
  createdAt: string;   // ISO
  updatedAt: string;   // ISO
  config: ConfigShape; // existing top-level config shape, lifted here
}>
currentProfileId: string;
encryptedApiKeysByProfile: Record<string, Record<ProviderKey, string>>; // base64 safeStorage blobs
```

Keep the legacy `config` and `encryptedApiKeys` keys present for one version as a **fallback**, but have all reads/writes go through the profile-resolved path.

**Important**: encrypted blobs from `safeStorage` are bound to the OS user. Add a one-line schema comment so future export/import work doesn't assume the raw JSON is portable.

### Migration (in `checkVersionAndMigrate` / `migrateSettings`)

Idempotent: gate on `currentProfileId` being unset, **not** on `profiles` being empty.

1. If `currentProfileId` is unset:
   - Generate id `default-<uuid>` (UUIDs only — never derive from name; collisions matter for `duplicate`).
   - Create `profiles[id] = { id, name: "Default", createdAt: now, updatedAt: now, config: <existing top-level config> }`.
   - Move existing `encryptedApiKeys` → `encryptedApiKeysByProfile[id]`.
   - Set `currentProfileId = id`.
2. **Do not** delete the legacy `config` / `encryptedApiKeys` keys yet; leave them as a one-version fallback.

### Main-process services

Split off a new file `electron/services/profile.service.ts` (rather than growing the already-444-line `store.service.ts`):
- `listProfiles(): ProfileMeta[]` (returns id/name/timestamps only — no config payload)
- `getActiveProfileId(): string`
- `switchProfile(id): void` — validates id exists; updates `currentProfileId`
- `createProfile({ name, cloneCurrent }): ProfileMeta` — UUID id; if `cloneCurrent`, deep-clone current `config` + copy current encrypted-key blobs into the new profile bucket
- `renameProfile(id, name)` — trim/reject empty/whitespace-only; reject if duplicate name
- `duplicateProfile(id, newName): ProfileMeta`
- `deleteProfile(id)` — guard: reject if `id === currentProfileId` **OR** `Object.keys(profiles).length === 1`

Refactor `getConfig()` and `setConfig()` in `store.service.ts` so they:
- Always resolve "active profile" **at call time** from `getActiveProfileId()` — never accept a `profileId` argument from the renderer.
- Read/write `profiles[currentProfileId].config` instead of top-level `config`.
- Encrypt/decrypt API keys via `encryptedApiKeysByProfile[currentProfileId]`.
- Move URL normalization (the `replace(/\/+$/, '')` / `/api`-trim logic currently duplicated in `App.tsx` and `ApiSettings.tsx`) into `getConfig()` so the renderer becomes a thin "fetch + dispatch."
- Bump `updatedAt` on the active profile whenever `setConfig` writes.

### IPC handlers

Add to `electron/handlers/config.handler.ts` (use the existing `<domain>:<resource>:<verb>` convention — but as a sibling `profile:` domain since profiles *contain* configs, not the reverse):

- `profile:list` → `{ profiles: ProfileMeta[], currentProfileId }`
- `profile:switch` (id) → returns the new active decrypted+normalized config (so renderer can dispatch in one round-trip)
- `profile:create` ({ name, cloneCurrent }) → `ProfileMeta`
- `profile:rename` (id, name)
- `profile:duplicate` (id, newName) → `ProfileMeta`
- `profile:delete` (id)

In `electron/preload.ts`, expose `window.electron.profile.{list, switch, create, rename, duplicate, delete}` and add the matching `ElectronAPI.profile` types.

### Renderer

**Types** — new file `src/types/profile.types.ts`:
```ts
export interface ProfileMeta { id: string; name: string; createdAt: string; updatedAt: string; }
```

**Redux** — extend `src/store/slices/settingsSlice.ts`:
- Add `profiles: ProfileMeta[]` and `currentProfileId: string | null` to state.
- Add reducers: `setProfiles`, `setCurrentProfileId`.
- Keep existing `loadSettings` / `setApiConfig` / etc. unchanged — they continue to mirror the active profile's config in Redux.

**Settings loader hook** — extract `App.tsx:52-138` into `src/hooks/useLoadSettingsFromStore.ts`:
- Returns a `reload()` function that fetches `config.get()` + `profile.list()` and dispatches everything.
- Called once on mount (replacing the inline effect in `App.tsx`).
- Called again after every profile switch.
- Now thin, since URL normalization moved to main process.

**Profile switcher (`src/components/settings/ProfileSwitcher.tsx`, new)**:
- Small dropdown rendered in `SettingsPanel.tsx` header (next to the "Settings" title, above the close button row).
- Lists profiles by name, shows a check on the active one, "+ New profile…" at the bottom.
- On select: if `isDirty`, run the existing `window.confirm("You have unsaved changes...")` from `SettingsPanel.tsx:50-53`; if accepted, call `profile:switch`, then `reload()`, then `setIsDirty(false)`.

**Profiles tab (`src/components/settings/ProfilesSettings.tsx`, new)**:
- Mirrors the `SkillSettings.tsx` CRUD pattern (list view + inline form).
- Per-row: name, "current" badge, Rename / Duplicate / Delete buttons. Delete disabled when `id === currentProfileId` or only one profile exists.
- "+ Create profile" button: name input + "Clone current settings" checkbox (default on).
- Validate names: trim, reject empty, reject duplicates.

**SettingsPanel.tsx changes**:
- Add `'profiles'` to `TabId` and the `tabs` array (place at top).
- Render `<ProfileSwitcher />` inside the existing header row.
- Force per-tab forms to resync after a profile switch by adding `key={currentProfileId}` to the **active tab's content wrapper** (not the whole panel — the dropdown shouldn't blink). Each per-tab form's existing "sync from Redux on mount" effect (e.g. `ApiSettings.tsx:40-57`) then naturally re-runs.

**Auto-write-back gotcha — `useTheme.ts`**:
After a profile switch, Redux `theme` value changes, the existing effect at `useTheme.ts:13-29` fires (because `isInitialMount.current` is already `false`), and writes back to the now-active profile. The write is a self-no-op (writing the value just loaded), so no data corruption — but it's a wasted round-trip and a confusing log line. Fix: subscribe to `currentProfileId` and reset `isInitialMount` on change, OR introduce a short-lived `isSwitchingProfile` ref guarded by the loader. Apply the same pattern to any other component that auto-writes on a Redux change (audit `PreferencesSettings.tsx` and `ThemeSettings.tsx` — they all `dispatch` then `config.set` together, so they're driven by user interaction not Redux changes, and are safe).

### Cross-cutting safety

- **Renderer never sends `profileId` on `config:set`.** `setConfig()` always resolves active profile server-side. This kills a whole class of races.
- **`config:setValue` dot-path handler**: explicitly reject paths matching `api.*.apiKey` so a stray caller can't accidentally re-encrypt under the wrong profile via the round-trip.
- **`availableModels` race**: this list lives inside `config.api` and is populated by `ApiSettings.handleTestConnection`. If a model fetch is in flight and the user switches profile mid-fetch, the resolved list could write into the new profile. Safest fix: the existing tab re-mount via `key={currentProfileId}` already unmounts the in-flight `ApiSettings` and abandons the result. Note in code comment.
- **Startup robustness**: in the loader hook, if `currentProfileId` is missing or points to a deleted profile (corrupt store), fall back to the first profile in `profiles` and persist that as `currentProfileId`. Don't crash.
- **`systemPromptFileName` and `customization.iconPath`** are absolute disk paths the user picked. Profiles only own the *reference* — never delete the referenced files when a profile is deleted.
- **Plugin/MCP/skill state stays global** (per user decision). Document this in the Profiles tab subtitle so users aren't surprised that switching profile doesn't change their MCP servers.

---

## Critical files

**Modify**:
- `electron/services/store.service.ts` — schema additions, migration, refactor `getConfig`/`setConfig` to use active profile, move URL normalization here
- `electron/handlers/config.handler.ts` — register new `profile:*` handlers; harden `config:setValue` against `apiKey` paths
- `electron/preload.ts` — expose `window.electron.profile.*` and types
- `src/store/slices/settingsSlice.ts` — add `profiles` + `currentProfileId` state
- `src/components/settings/SettingsPanel.tsx` — render `<ProfileSwitcher>` in header; add `'profiles'` tab; `key={currentProfileId}` on active tab content
- `src/App.tsx` — replace inline settings-loader effect with the new hook
- `src/hooks/useTheme.ts` — reset `isInitialMount` (or add a switching guard) when `currentProfileId` changes

**Create**:
- `electron/services/profile.service.ts` — profile CRUD + active-profile resolution
- `src/types/profile.types.ts` — `ProfileMeta`
- `src/hooks/useLoadSettingsFromStore.ts` — extracted loader, returns `reload()`
- `src/components/settings/ProfileSwitcher.tsx` — header dropdown
- `src/components/settings/ProfilesSettings.tsx` — Profiles tab (CRUD, mirrors `SkillSettings.tsx` pattern)

**Reuse**:
- `SkillSettings.tsx` CRUD UI pattern (form + list + inline error display)
- `SettingsPanel.tsx:50-53` — existing unsaved-changes confirm dialog
- `safeStorage` encryption helpers `saveApiKey` / `getApiKey` in `store.service.ts:131-187` — extend signatures to accept an optional `profileId`, default to active

---

## Verification

After implementation, manually test in the running Electron app (`npm run dev`):

1. **Migration**: launch with the existing `config.json`. Settings panel still works exactly as before. Inspect `electron-store` JSON: `profiles.<uuid>` exists, `currentProfileId` set, `encryptedApiKeysByProfile.<uuid>` matches the legacy `encryptedApiKeys`. Legacy `config` key still present as fallback.
2. **Create + switch**: open Settings → Profiles tab → "Create profile" with "Clone current" checked. New profile appears. Switch via the header dropdown. Each tab (API, Appearance, Preferences) shows the same values as before. Edit something, save. Switch back to "Default" — the original values are restored.
3. **Independent API keys**: in profile A, set OpenWebUI key `sk-AAAA`. Switch to profile B, set OpenWebUI key `sk-BBBB`. Switch back to A — key is `sk-AAAA`, not `sk-BBBB`. Verify a chat message in A actually uses `sk-AAAA`.
4. **Unsaved-changes confirm**: edit a field on profile A (don't save), select profile B in the dropdown — the existing "discard?" dialog appears. Cancel → still on A with the dirty edit. Confirm → on B, edit discarded.
5. **Delete guards**: try to delete the current profile (button disabled). Try to delete the only profile (button disabled). Delete a non-current profile → it disappears, others unchanged.
6. **Rename validation**: empty name rejected; whitespace-only rejected; duplicate name rejected.
7. **Auto-write-back regression**: switch profile, then check the dev console for stray `[Store] setConfig` calls writing the just-loaded theme. Should be silent (or, at worst, one self-no-op).
8. **Theme auto-apply**: profile A is dark, profile B is light. Switching profiles should immediately repaint the UI without reopening Settings.
9. **Type check**: `npm run type-check` passes.
10. **Lint**: `npm run lint` passes for the changed files.
