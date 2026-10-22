# System requirements

Requirements for Claudia Desktop (Electron) and Claudia Web (self-hosted).

Values marked **(documented)** come from the project's own files. Everything
else is an estimate based on the stack (Electron 28, Vite 5, Node 22,
PostgreSQL 16) and on build output, so check it against a real deployment
(`docker stats`, Task Manager) before sizing hardware.

## Desktop

| | Minimum | Recommended |
|---|---|---|
| **OS** | Windows 10 x64. Electron 28 also runs on macOS 10.15+ and Ubuntu 18.04+ / Debian 10+, but only Windows and Linux builds are shipped | Windows 11 x64 |
| **CPU** | Any 64-bit dual-core | Quad-core |
| **RAM** | 4 GB | 8 GB or more. The app uses about 200–400 MB, more with long chats and diagram rendering |
| **Disk** | About 450 MB installed (the installer is about 100 MB) | 1 GB or more for chats, attachments and updates |
| **GPU** | Not needed. Models run on the connected server (Open WebUI, OpenRouter, …) | — |
| **Network** | Access to your AI endpoint | — |

### Optional software

| | Used for |
|---|---|
| **Microsoft Office** (Windows) | Exact PDF copies of Word, Excel and PowerPoint files (the PDF and Word tools use it first) |
| **LibreOffice** (any OS) | The same, where Office is missing. Without either, PDFs of Office files are approximate (content without the original layout) |

Neither is needed to create Word, Excel, PowerPoint or PDF files.

### Building from source

| | Minimum | Recommended |
|---|---|---|
| **Node.js** | 18 **(documented, README.md)** | 20 or 22 LTS |

## Web: server

| | Minimum | Recommended |
|---|---|---|
| **Runtime** | Node.js 22 **(documented, `web/package.json`)** or Docker (image `node:22-bookworm-slim`, amd64; build your own image for ARM) | Docker Compose (`web/docker/docker-compose.yml`) |
| **Database** | None: with `DATABASE_URL` unset the app uses embedded PGlite, fine for a trial or a single user | PostgreSQL 16+ with pgvector **(documented)** |
| **CPU** | 2 vCPU | 4 vCPU |
| **RAM** | 2 GB (app and PostgreSQL, small team) | 8 GB. Add 0.5–1 GB for the optional SearXNG container |
| **Disk** | 10 GB | 20 GB or more on SSD. Uploads, workspaces and the database grow with use |
| **Ports** | 8080 (app) and 8081 (sandbox origin) **(documented)** | Behind a reverse proxy with TLS and WebSocket upgrade for `/api/ws` |
| **Scale-out** | — | Several app instances with Redis and S3 (`web/docker/compose.scale.yml`) |

### Air-gapped install

| | Requirement |
|---|---|
| **Target host** | Ubuntu 24.04, amd64 **(documented)** |
| **Bundle build machine** | Windows with internet access, Git, Docker Desktop running Linux containers, about 5 GB free disk **(documented)** |

See [`web/deploy/airgap/README.md`](../web/deploy/airgap/README.md).

## Web: users' browsers

| | Minimum | Recommended |
|---|---|---|
| **Browser** | Chrome / Edge 87+, Firefox 78+, Safari 14+ (Vite 5 default build target) | Latest Chrome, Edge, Firefox or Safari |
| **Device RAM** | 4 GB | 8 GB when using in-browser Python (Pyodide), which runs on the user's machine and downloads packages such as numpy on demand |

## What drives the numbers

Server sizing depends mostly on usage, not on the app:

- number of concurrent users and open WebSocket connections
- uploads, workspaces and knowledge documents (disk and database size)
- embeddings and RAG (pgvector indexes; the embedding engine itself runs elsewhere)
- optional containers such as SearXNG

Language models run on the configured provider (OpenAI-compatible, Anthropic,
Ollama, …), so neither the desktop app nor the web server needs a GPU. A
local Ollama has its own, much larger, requirements.
