/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { isReportablePortalResponse, sanitizeIncidentText } from "../lib/system-incident-policy";
import { recordSystemIncident } from "../lib/server/system-incidents";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  SOURCE_COMMIT?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

async function requestRunId(request: Request, pathname: string) {
  if (pathname !== "/api/executor" || request.method !== "POST") return null;
  try {
    const body = await request.json() as { runId?: unknown };
    return typeof body.runId === "string" ? body.runId : null;
  } catch {
    return null;
  }
}

async function observeInternalResponse(request: Request, response: Response, env: Env) {
  try {
    const url = new URL(request.url);
    if (!isReportablePortalResponse(url.pathname, response.status)) return;
    let responseMessage = `The Company Portal returned HTTP ${response.status}.`;
    try {
      const body = await response.text();
      const parsed = JSON.parse(body) as { error?: unknown };
      if (typeof parsed.error === "string") responseMessage = parsed.error;
    } catch {
      // The status, route, and active run remain sufficient deterministic evidence.
    }
    await recordSystemIncident(env.DB, {
      category: "api_5xx",
      route: url.pathname,
      method: request.method,
      httpStatus: response.status,
      summary: responseMessage,
      evidence: `${request.method} ${url.pathname} returned HTTP ${response.status}.`,
      runId: await requestRunId(request, url.pathname),
      buildCommit: env.SOURCE_COMMIT,
    });
  } catch {
    // Incident recording must never replace or delay the original portal response.
  }
}

async function observeWorkerException(request: Request, error: unknown, env: Env) {
  try {
    const url = new URL(request.url);
    if (url.pathname === "/api/system-incidents") return;
    const summary = error instanceof Error ? error.message : "The Company Portal worker threw an internal exception.";
    const ownedFrame = error instanceof Error
      ? error.stack?.split("\n").find((line) => /(?:\/app\/|\/worker\/|\/lib\/)/.test(line))
      : "";
    await recordSystemIncident(env.DB, {
      category: "worker_exception",
      route: url.pathname,
      method: request.method,
      summary,
      evidence: sanitizeIncidentText(ownedFrame, 600),
      runId: await requestRunId(request, url.pathname),
      buildCommit: env.SOURCE_COMMIT,
    });
  } catch {
    // Preserve the original exception as the authoritative failure.
  }
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    const incidentRequest = request.clone();
    try {
      const response = await handler.fetch(request, env, ctx);
      if (isReportablePortalResponse(url.pathname, response.status)) {
        ctx.waitUntil(observeInternalResponse(incidentRequest, response.clone(), env));
      }
      return response;
    } catch (error) {
      ctx.waitUntil(observeWorkerException(incidentRequest, error, env));
      throw error;
    }
  },
};

export default worker;
