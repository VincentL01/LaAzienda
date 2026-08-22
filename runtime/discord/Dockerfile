FROM node:24-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
  && npm cache clean --force

COPY index.mjs status.mjs ./

USER node
HEALTHCHECK --interval=2s --timeout=2s --start-period=30s --retries=3 \
  CMD ["node", "-e", "const http=require('node:http');const request=http.get('http://127.0.0.1:8081/healthz',{agent:false},response=>{response.resume();process.exit(response.statusCode===204?0:1)});request.setTimeout(1500,()=>request.destroy());request.on('error',()=>process.exit(1))"]
CMD ["node", "index.mjs"]
