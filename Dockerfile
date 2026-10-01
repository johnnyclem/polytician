# Polytician MCP server over Streamable HTTP (MCP on /mcp, health on /health).
# Images are pinned by digest; bump the tag and digest together.
FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS build

WORKDIR /app
# Toolchain for native modules without a prebuilt binary for this platform
# (better-sqlite3 falls back to node-gyp).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
# CPU inference only: skip onnxruntime-node's CUDA provider download.
ENV ONNXRUNTIME_NODE_INSTALL=skip
COPY package.json package-lock.json ./
# Install scripts must run: they fetch or build the native binaries of
# better-sqlite3, sharp and onnxruntime-node, which npm does not ship.
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

WORKDIR /app
ENV NODE_ENV=production \
    POLYTICIAN_DATA_DIR=/data \
    POLYTICIAN_TRANSPORT=http \
    POLYTICIAN_HTTP_HOST=0.0.0.0 \
    POLYTICIAN_HTTP_PORT=8788 \
    POLYTICIAN_HTTP_ALLOWED_HOSTS=localhost,127.0.0.1
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules/
COPY --from=build /app/dist dist/
# /data holds the SQLite database, the downloaded embedding model and, unless
# POLYTICIAN_HTTP_TOKEN is set, the generated bearer token.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.POLYTICIAN_HTTP_PORT||8788)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/index.js"]
