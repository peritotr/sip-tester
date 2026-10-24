# SIP Tester — web server edition
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data
WORKDIR /app

COPY package.json ./
# Only runtime dependencies (Electron and other desktop build tools are devDependencies)
RUN apk add --no-cache su-exec && npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY server.js sip-core.js sip-client.js rtp.js load-engine.js load-worker.js ipc-child.js hist.js reports.js uas.js ./
COPY ui ./ui
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /data && chown -R node:node /data /app && chmod +x /usr/local/bin/docker-entrypoint.sh
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1

LABEL org.opencontainers.image.title="SIP Tester" \
      org.opencontainers.image.description="SIP load tester (calls, registrations, OPTIONS) with light RTP and performance reports" \
      org.opencontainers.image.source="https://github.com/peritotr/sip-tester" \
      org.opencontainers.image.licenses="MIT"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
