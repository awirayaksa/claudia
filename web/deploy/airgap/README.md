# Claudia Web on an air-gapped Ubuntu 24.04 host

You make a bundle on a Windows machine that has internet access, copy it to
the target, and run one script there. The target never touches the network:
Docker Engine, the images and the configuration all come from the bundle.

| Step | Where | What |
|---|---|---|
| 1 | Windows (online) | Download `claudia-web-<version>-airgap-amd64.tar` from a GitHub release, or build it with `prepare-bundle.ps1` |
| 2 | — | Copy the `.tar` and its `.tar.sha256` to the target (USB, file transfer) |
| 3 | Ubuntu 24.04 (offline) | `sudo bash install.sh` installs Docker if needed and starts the app |

## 1. Get the bundle

Every release (`npm run release`, see [Releasing](#releasing)) has the amd64
bundle and its `.tar.sha256` attached on its GitHub releases page, so for a
released version just download both. Build it yourself for a branch, an ARM
target or other options.

### Build it (Windows)

You need Git, Docker Desktop running Linux containers, and about 5 GB of
free disk. From the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File web\deploy\airgap\prepare-bundle.ps1
```

This builds the newest `v*` release tag that contains Claudia Web. To build
something else, such as a branch that hasn't been released yet:

```powershell
powershell -ExecutionPolicy Bypass -File web\deploy\airgap\prepare-bundle.ps1 -Ref main
```

A branch is built as it is on `origin`, after fetching, so a local `main`
that you haven't pulled doesn't matter. The script warns if your local copy
differs. The image is built from a clean export of that commit, so
uncommitted changes are not included. The output goes to `web\deploy\airgap\out\`:

```
claudia-web-<version>-airgap-amd64.tar          the bundle
claudia-web-<version>-airgap-amd64.tar.sha256   its checksum
```

| Option | |
|---|---|
| `-Ref <tag/branch/commit>` | What to build (default: the newest release tag with `web/`; a branch is taken from `origin`) |
| `-Arch arm64` | For an ARM target (default `amd64`; built with emulation, slower) |
| `-PgvectorImage <image>` | Database image (default `pgvector/pgvector:pg16`) |
| `-NoLibreOffice` | Leave LibreOffice out of the image (about 600 MB smaller; Office files then convert to PDF approximately) |
| `-SkipDockerPackages` | The target already has Docker and the compose plugin |
| `-OutDir <dir>` | Where to write the bundle |
| `-NoArchive` | Leave the bundle as a folder |
| `-NoFetch` | Don't fetch tags from `origin` first |

Inside the bundle:

```
install.sh             installer and upgrader
compose.yml            app + PostgreSQL (pgvector)
compose.sandbox.yml    publishes the sandbox port
images/                claudia-web.tar, pgvector.tar (docker save)
debs/                  Docker Engine, containerd, compose and buildx plugins
                       for Ubuntu 24.04 (noble), with their dependencies
bundle.env             version, commit and image names
SHA256SUMS
```

## 2. Install (Ubuntu 24.04)

```bash
sha256sum -c claudia-web-<version>-airgap-amd64.tar.sha256
tar -xf claudia-web-<version>-airgap-amd64.tar
cd claudia-web-<version>-airgap-amd64
sudo bash install.sh --public-url http://claudia.corp.internal:8080
```

The installer:

1. checks every file against `SHA256SUMS`;
2. installs Docker Engine and the compose plugin from `debs/` if they are
   missing (packages the host already has at the same or a newer version are
   skipped);
3. loads the images;
4. writes `/opt/claudia/.env` with a generated `CLAUDIA_SECRET_KEY`, database
   password and first-admin password;
5. starts the stack with `docker compose up --wait` and prints the URL and
   the admin sign-in.

`--public-url` should be the address users type in their browser. It sets
the session cookies and the sandbox origin. Without it, the installer uses
`http://<this host's IP>:8080`.

| Option | |
|---|---|
| `--public-url URL` | What users open, e.g. `https://claudia.corp.internal` behind a proxy |
| `--port N` | Host port of the app (default 8080) |
| `--sandbox-port N` | Second port for the code interpreter, artifact and file previews (default 8081; `0` = off) |
| `--sandbox-origin URL` | Instead of a second port: a separate host name your reverse proxy routes to the app |
| `--admin-email`, `--admin-password` | First admin (first install only) |
| `--dir DIR` | Install directory (default `/opt/claudia`) |
| `--skip-docker` | Never install Docker from the bundle |
| `--no-backup` | Upgrade without dumping the database first |
| `--postgres-password P` | Reuse an existing `claudia_pgdata` volume without its old `.env` |

Allow inbound traffic to both ports (8080 and 8081) from your users. Docker
publishes ports through iptables directly, so `ufw` rules don't limit them;
use `--port`/`--sandbox-port`, or put a reverse proxy in front of the app.

After you sign in, change the admin password and delete
`CLAUDIA_ADMIN_PASSWORD` from `/opt/claudia/.env`. Then go to
**Admin → Connections** and add your model server by its LAN address, for
example `http://10.0.0.20:8000/v1` for vLLM. Inside the container,
`localhost` means the container itself, not the host.

### Behind a reverse proxy (TLS)

Point the proxy at port 8080 and run the installer with
`--public-url https://claudia.corp.internal`. For previews, either keep
`--sandbox-port` or give the sandbox its own host name:
`--sandbox-origin https://claudia-sandbox.corp.internal`, routed to the same
port 8080. The proxy needs `proxy_buffering off`, a long `proxy_read_timeout`,
and WebSocket upgrade for `/api/ws`. `web/docker/nginx.scale.conf` in the
repository is a working example.

## Day to day

```bash
cd /opt/claudia
sudo docker compose ps
sudo docker compose logs -f app
sudo docker compose restart app
sudo docker compose up -d                       # after editing .env
sudo docker compose exec app node dist/server/cli.cjs   # admin CLI: prints its commands
```

`.env` is passed to the app as-is, so any variable from the
[Configuration table](../../README.md#configuration) can go there:
`LDAP_*`, `ENABLE_PASSWORD_AUTH`, `OTEL_*` and the rest. Put a directory's CA
certificate in `/opt/claudia/certs/` and set
`LDAP_CA_CERT_FILE=/certs/<file>`. If a value contains `$` or spaces, wrap it
in single quotes.

The image includes LibreOffice (unless the bundle was built with
`-NoLibreOffice`), so the PDF and Word tools convert Word, Excel and
PowerPoint files to PDF exactly, with Arabic, CJK and the metrics of Calibri
and Cambria covered by the fonts it ships. While converting, LibreOffice may
fetch images and other resources a document links to, from wherever the
container can reach. To turn it off, add `LIBREOFFICE_PATH=` to `.env`
and run `sudo docker compose up -d`; conversions are then approximate.

**Back up** `/opt/claudia/.env`, because the secret key decrypts stored API
keys, plus the database and the data volume:

```bash
cd /opt/claudia
sudo docker compose exec -T db pg_dump -U claudia -d claudia -Fc | sudo tee backups/claudia-$(date +%F).dump > /dev/null
sudo docker run --rm --user root -v claudia_claudia-data:/data -v "$PWD/backups:/out" \
  "$(sudo docker compose config --images | grep claudia-web)" \
  tar -czf /out/data-$(date +%F).tgz -C /data .
```

## Upgrade

Get the new release's bundle (or make one) and run `install.sh` from it, just as for a first install.
Your existing `.env` is kept, and any options you pass replace its values. The
database is dumped to `/opt/claudia/backups/` before the new version starts.
The previous image stays on the host, so you can roll back.

### Roll back

New versions can migrate the database, so restore the dump that was taken
before the upgrade:

```bash
cd /opt/claudia
sudo sed -i 's|^CLAUDIA_IMAGE=.*|CLAUDIA_IMAGE=claudia-web:<previous version>|' .env
sudo docker compose stop app
sudo cat backups/<dump> | sudo docker compose exec -T db pg_restore -U claudia -d claudia --clean --if-exists
sudo docker compose up -d
```

## Releasing

Claudia Desktop and Claudia Web are released together under one version. On
an up-to-date, clean `main`:

```powershell
npm run release                      # asks patch / minor / major / custom
npm run release -- -Version minor    # or say it up front
```

The script sets the version in `package.json` and `web/package.json`,
commits it, tags `vX.Y.Z` and pushes both. The tag starts the **Build and
Release** workflow, which:

1. creates a draft GitHub release with generated notes,
2. builds the Windows installer, portable exe and `latest.yml` (what the
   desktop auto-updater reads), and this bundle for amd64, in parallel,
3. attaches them, publishes the release and sends the Telegram notice.

If a build fails, the release stays a draft. Re-run the failed jobs from
the Actions page; the draft is reused.

## Uninstall

```bash
cd /opt/claudia
sudo docker compose down        # stops the app, keeps the data
sudo docker compose down -v     # also deletes the database and uploads
```

## What doesn't work without internet

These features reach outside the network. They fail, or stay off, on an
air-gapped host unless you have an internal equivalent:

- **Code interpreter packages.** Pure Python runs, because Pyodide is served
  from the sandbox. Packages such as numpy are loaded from the Pyodide CDN
  by the user's browser, so they fail to import.
- **Web search and `#https://…` references** to internet pages. Pages on
  your intranet work.
- **Google Drive, OneDrive**, and sign-in through cloud identity providers.
  An internal OIDC provider or LDAP works.
- **Hosted model APIs** (OpenAI, Anthropic, Gemini). Use an internal
  OpenAI-compatible server or Ollama.
- **stdio MCP servers that install with `npx`/`uvx` at start.** Remote MCP
  servers on your network work.

## Troubleshooting

- **`apt-get` reports unmet dependencies while installing Docker.** The host
  lacks a package that the clean `ubuntu:24.04` image used for the download
  already had. On the Windows machine, run
  `docker run --rm -v "${PWD}:/out" ubuntu:24.04 sh -c "apt-get update && cd /out && apt-get download <package>"`,
  copy the `.deb` into the bundle's `debs/` folder, and run the installer
  again. Files that aren't listed in `SHA256SUMS` are not checked.
- **The app doesn't become healthy.** Run `sudo docker compose logs app`.
  An invalid `.env` value is reported by name, and so is a database password
  that doesn't match an existing `claudia_pgdata` volume.
- **Previews say "no sandbox origin".** Check that `CLAUDIA_PUBLIC_URL` is the
  host name users actually open, and that users can reach the sandbox port.
