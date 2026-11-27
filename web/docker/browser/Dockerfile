# The browser service for the Web browser built-in (see compose.browser.yml).
# The Playwright version must match web/package.json's playwright-core exactly.
ARG PLAYWRIGHT_VERSION=1.64.1
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble
ARG PLAYWRIGHT_VERSION
WORKDIR /srv
RUN npm init -y >/dev/null \
  && npm install --omit=dev --no-audit --no-fund playwright-core@${PLAYWRIGHT_VERSION} \
  && npm cache clean --force
COPY web/docker/browser/server.mjs ./server.mjs
USER pwuser
EXPOSE 3000
CMD ["node", "server.mjs"]
