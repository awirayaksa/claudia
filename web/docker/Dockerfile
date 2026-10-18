# syntax=docker/dockerfile:1.7
#
# Claudia Web. Build from the repository root:
#   docker build -f web/docker/Dockerfile -t claudia-web .
#
# Only the code the web app shares is copied (src/, electron/services/, the
# root Tailwind config) plus web/. Dependencies come from web/package.json
# alone; the desktop's node_modules are never installed.

ARG NODE_VERSION=22

# ─── Build ────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app

COPY web/package.json web/package-lock.json ./web/
RUN --mount=type=cache,target=/root/.npm cd web && npm ci

COPY src ./src
COPY electron/services ./electron/services
COPY tailwind.config.js ./tailwind.config.js
COPY web ./web

RUN cd web \
  && npm run check:shared-deps \
  && npm run build \
  && npm run check:bundle \
  && npm prune --omit=dev

# ─── Runtime ──────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data
WORKDIR /app

COPY --from=build --chown=node:node /app/web/package.json ./package.json
COPY --from=build --chown=node:node /app/web/node_modules ./node_modules
COPY --from=build --chown=node:node /app/web/dist ./dist

RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "dist/server/index.cjs"]
