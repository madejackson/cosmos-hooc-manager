# cosmos-hooc-manager — HOOC Connect manager for Cosmos
# Multi-arch (amd64 + arm64), zero-dependency Node.js server.
FROM node:22-alpine

RUN apk add --no-cache curl tini

ENV NODE_ENV=production \
    PORT=8095 \
    HOST=0.0.0.0 \
    HOOC_API_PORT=1323 \
    HOOC_DATA_DIR=/data

WORKDIR /app

COPY server /app/server
COPY package.json /app/package.json

# data dir for downloaded images + state
RUN mkdir -p /data

VOLUME ["/data"]
EXPOSE 8095

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8095/api/status >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/index.js"]
