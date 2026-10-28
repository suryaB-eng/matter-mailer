FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS runtime
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
# The locked Playwright version installs its own exact browser revision + system libraries.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates util-linux \
    && node node_modules/playwright/cli.js install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* /root/.npm \
    && mkdir -p /data && chown node:node /data
COPY --from=build --chown=node:node /app/dist ./dist
USER node
STOPSIGNAL SIGTERM
ENTRYPOINT ["flock", "--nonblock", "/data/runtime.lock"]
CMD ["node", "dist/cli.js", "doctor"]
