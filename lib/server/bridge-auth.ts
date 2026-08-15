import { env } from "cloudflare:workers";

export function bridgeAuthorized(request: Request) {
  const configured = (env as unknown as { RUNTIME_BRIDGE_TOKEN?: string }).RUNTIME_BRIDGE_TOKEN;
  const supplied = request.headers.get("x-runtime-bridge-token");
  if (configured) return supplied === configured;
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1";
}
