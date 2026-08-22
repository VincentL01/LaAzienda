import { readFile } from "node:fs/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const STATUS_TOKEN_PATH = "/run/secrets/company_status_token";
const CLIENT_TOKEN_PATH = "/run/secrets/gateway_client_token";
const UPSTREAM_STATUS_URL = "http://omc-portal:3000/api/integrations/discord/status?employeeId=employee-hrm";
const LISTEN_PORT = 8080;
const MAX_UPSTREAM_BYTES = 256 * 1024;
const ALLOWED_REQUEST_HEADERS = new Set(["host", "accept", "connection", "authorization"]);

export function constantTimeTokenEqual(supplied, expected) {
  const suppliedDigest = createHash("sha256").update(String(supplied ?? ""), "utf8").digest();
  const expectedDigest = createHash("sha256").update(String(expected ?? ""), "utf8").digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
}

export function classifyGatewayRequest({ method, url, headers, bodyBytes = 0 }) {
  if (method !== "GET") return { accepted: false, status: 405 };
  if (url !== "/v1/status") return { accepted: false, status: 404 };
  if (!headers || typeof headers !== "object") return { accepted: false, status: 400 };
  const names = Object.keys(headers).map((name) => name.toLowerCase());
  if (!names.includes("host") || names.some((name) => !ALLOWED_REQUEST_HEADERS.has(name))) {
    return { accepted: false, status: 400 };
  }
  const accept = headers.accept;
  if (accept !== undefined && accept !== "application/json") return { accepted: false, status: 406 };
  const connection = headers.connection;
  if (connection !== undefined && !["close", "keep-alive"].includes(String(connection).toLowerCase())) {
    return { accepted: false, status: 400 };
  }
  const authorization = headers.authorization;
  if (typeof authorization !== "string" || !/^Bearer [A-Za-z0-9_-]{32,128}$/.test(authorization)) {
    return { accepted: false, status: 401 };
  }
  if (!Number.isSafeInteger(bodyBytes) || bodyBytes !== 0) return { accepted: false, status: 400 };
  return { accepted: true, status: 200 };
}

function sendJson(response, status, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(encoded),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(encoded);
}

async function readBoundedResponse(response) {
  if (!response.body) throw new Error("The portal status response had no body.");
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > MAX_UPSTREAM_BYTES) throw new Error("The portal status response exceeded its bound.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

export async function startGateway() {
  const [statusToken, clientToken] = await Promise.all([
    readFile(STATUS_TOKEN_PATH, "utf8").then((value) => value.trim()),
    readFile(CLIENT_TOKEN_PATH, "utf8").then((value) => value.trim()),
  ]);
  if (statusToken.length < 32) throw new Error("The scoped company status token is invalid.");
  if (clientToken.length < 32) throw new Error("The gateway client token is invalid.");

  const server = createServer(async (request, response) => {
    try {
      let bodyBytes = 0;
      for await (const chunk of request) {
        bodyBytes += chunk.length;
        if (bodyBytes > 0) break;
      }
      const policy = classifyGatewayRequest({
        method: request.method,
        url: request.url,
        headers: request.headers,
        bodyBytes,
      });
      if (!policy.accepted) {
        sendJson(response, policy.status, { error: "Status gateway request rejected." });
        return;
      }
      const suppliedToken = String(request.headers.authorization).slice(7);
      if (!constantTimeTokenEqual(suppliedToken, clientToken)) {
        sendJson(response, 403, { error: "Status gateway authorization failed." });
        return;
      }

      const upstream = await fetch(UPSTREAM_STATUS_URL, {
        method: "GET",
        headers: { authorization: `Bearer ${statusToken}`, accept: "application/json" },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      if (!upstream.ok || !upstream.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
        sendJson(response, 502, { error: "Company status is unavailable." });
        return;
      }
      const encoded = await readBoundedResponse(upstream);
      JSON.parse(encoded);
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(encoded),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(encoded);
    } catch {
      if (!response.headersSent) sendJson(response, 502, { error: "Company status is unavailable." });
      else response.destroy();
    }
  });
  server.requestTimeout = 7_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  server.maxRequestsPerSocket = 10;
  server.listen(LISTEN_PORT, "0.0.0.0", () => {
    console.log(`Discord status gateway listening on ${LISTEN_PORT}.`);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => server.close(() => process.exit(0)));
  }
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startGateway().catch((error) => {
    console.error(`Discord status gateway startup failed (${error instanceof Error ? error.name : "unknown"}).`);
    process.exitCode = 1;
  });
}
