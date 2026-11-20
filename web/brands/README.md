# White-label brands

Claudia Web can be built under another name, logo and colours. A brand is a
folder here; the build picks one and nothing else in the code changes, so a
private fork that only adds its brand folder merges Claudia updates without
conflicts.

## Picking the brand (build time)

In order:

1. `BRAND=<id>` in the environment: `BRAND=acme npm run build`,
   `docker build --build-arg BRAND=acme -f web/docker/Dockerfile .`
2. `web/brands/active`, a file holding the brand id (`acme`). A private fork
   commits this file, so every build there (Docker, the air-gap bundle, dev)
   is branded with no extra flags.
3. Otherwise none: Claudia.

Tests always build Claudia unless `BRAND` is set, so their expectations hold.

## A brand folder

```
web/brands/acme/
  brand.json        name, colours, logo (required)
  theme.css         extra colour variables (optional)
  public/           files laid over web/public (optional)
    icons/favicon-32.png, apple-touch-icon.png, icon-192.png,
          icon-512.png, icon-maskable-512.png, logo.png …
```

`brand.json`:

```json
{
  "name": "Acme AI",
  "description": "Chat with AI models, your files and tools.",
  "themeColor": "#1F4E79",
  "backgroundColor": "#121212",
  "accent": { "light": "#1F4E79", "dark": "#6FA8DC" },
  "logo": "/icons/logo.png",
  "avatar": "/icons/logo.png"
}
```

| Field | Effect |
| --- | --- |
| `name` (required) | Page title, web manifest, every UI string that names the app (both languages), the authenticator-app issuer, the OAuth client name for tool servers |
| `description` | Web manifest description |
| `themeColor` | `<meta name="theme-color">` and the manifest's `theme_color` |
| `backgroundColor` | The manifest's `background_color` (install splash) |
| `accent` | Default accent colour in light and dark themes; users can still pick their own under Settings → Appearance |
| `logo` | Image above the sign-in form |
| `avatar` | The assistant's avatar in chats, in place of the "C" badge |

Paths in `logo` and `avatar` are URLs under the public folder; the file can be
in the brand's `public/` or in `web/public/`.

`theme.css` is loaded after the app's stylesheet. Override any of the colour
variables in `src/styles/globals.css`, with the same selectors
(`:root[data-theme="light"], :root`, `:root[data-theme="dark"]`, and
`:root[data-theme="system"]` inside both `prefers-color-scheme` queries).

`public/` replaces files of the same path in `web/public/`. Ship all five icons
so the favicon and installed app match. The web manifest is renamed and
recoloured from `brand.json`, unless the brand ships its own.

## What stays the same

Technical names are not branded: the `X-Claudia-*` headers, user agents,
package and image names, the export file's format id, cache names and environment
variables. Mentions of the Claudia desktop app keep its name.
