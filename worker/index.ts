/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import {
  incidentRequestContext,
  isReportablePortalResponse,
  sanitizeIncidentText,
  type IncidentRequestContext,
} from "../lib/system-incident-policy";
import { recordSystemIncident } from "../lib/server/system-incidents";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  RUNTIME_BRIDGE_TOKEN?: string;
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

async function observeInternalResponse(context: IncidentRequestContext, status: number, env: Env) {
  try {
    if (!isReportablePortalResponse(context.pathname, status)) return;
    const responseMessage = `The Company Portal returned HTTP ${status}.`;
    await recordSystemIncident(env.DB, {
      category: "api_5xx",
      route: context.pathname,
      method: context.method,
      httpStatus: status,
      summary: responseMessage,
      evidence: `${context.method} ${context.pathname} returned HTTP ${status}.`,
      runId: context.runId,
      buildCommit: env.SOURCE_COMMIT,
    });
  } catch {
    // Incident recording must never replace or delay the original portal response.
  }
}

async function observeWorkerException(context: IncidentRequestContext, error: unknown, env: Env) {
  try {
    if (context.pathname === "/api/system-incidents") return;
    const summary = error instanceof Error ? error.message : "The Company Portal worker threw an internal exception.";
    const ownedFrame = error instanceof Error
      ? error.stack?.split("\n").find((line) => /(?:\/app\/|\/worker\/|\/lib\/)/.test(line))
      : "";
    await recordSystemIncident(env.DB, {
      category: "worker_exception",
      route: context.pathname,
      method: context.method,
      summary,
      evidence: sanitizeIncidentText(ownedFrame, 600),
      runId: context.runId,
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

    // Capture only bounded headers and URL metadata before routing. The worker
    // incident sensor must never clone, tee, or parse an untrusted request body.
    const incidentContext = incidentRequestContext(request, env.RUNTIME_BRIDGE_TOKEN);
    try {
      const response = await handler.fetch(request, env, ctx);
      if (isReportablePortalResponse(url.pathname, response.status)) {
        ctx.waitUntil(observeInternalResponse(incidentContext, response.status, env));
      }
      return response;
    } catch (error) {
      ctx.waitUntil(observeWorkerException(incidentContext, error, env));
      throw error;
    }
  },
};

export default worker;
