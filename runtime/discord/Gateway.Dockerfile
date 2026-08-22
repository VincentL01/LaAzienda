FROM node:22.22.0-bookworm-slim

WORKDIR /app
COPY gateway.mjs ./

USER node
HEALTHCHECK --interval=2s --timeout=6s --start-period=2s --retries=15 \
  CMD ["node", "-e", "const fs=require('node:fs');const http=require('node:http');const token=fs.readFileSync('/run/secrets/gateway_client_token','utf8').trim();const request=http.get('http://127.0.0.1:8080/v1/status',{headers:{accept:'application/json',authorization:'Bearer '+token},agent:false},response=>{response.resume();process.exit(response.statusCode===200?0:1)});request.setTimeout(5500,()=>request.destroy());request.on('error',()=>process.exit(1))"]
CMD ["node", "gateway.mjs"]
