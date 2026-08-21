FROM node:24-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
  && npm cache clean --force

COPY index.mjs status.mjs ./

USER node
HEALTHCHECK --interval=2s --timeout=2s --start-period=2s --retries=15 \
  CMD ["node", "-e", "require('node:fs').accessSync('/tmp/aurora-ready')"]
CMD ["node", "index.mjs"]
