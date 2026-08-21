export const systemIncidentCategories = ["api_5xx", "worker_exception"] as const;

export type SystemIncidentCategory = (typeof systemIncidentCategories)[number];

const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const COMPANY_ID_PATTERN = /\b(?:run|task|inquiry|employee)-[A-Za-z0-9._-]{6,}\b/gi;
const GITHUB_TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9_-]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/gi;
const OPENAI_TOKEN_PATTERN = /\bsk-[A-Za-z0-9_-]{10,}\b/gi;
const BEARER_PATTERN = /\bBearer\s+\S+/gi;
const NAMED_SECRET_PATTERN = /\b(password|token|access[_ -]?token|refresh[_ -]?token|secret|client[_ -]?secret|authorization|api[_ -]?key)\b["']?\s*[:=]\s*["']?[^\s,;}"']+/gi;

export function sanitizeIncidentText(value: unknown, limit = 1200) {
  if (typeof value !== "string") return "";
  const sanitized = value
    .replace(GITHUB_TOKEN_PATTERN, "[redacted]")
    .replace(OPENAI_TOKEN_PATTERN, "[redacted]")
    .replace(BEARER_PATTERN, "Bearer [redacted]")
    .replace(NAMED_SECRET_PATTERN, "$1=[redacted]")
    .replace(/\b[A-Za-z]:\\[^\s)]+/g, "<local-path>")
    .replace(/\/(?:workspace|home|Users)\/[^\s)]+/g, "<local-path>")
    .replace(/\/app\//g, "repo:/");
  return Array.from(sanitized, (character) => {
    const code = character.charCodeAt(0);
    return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127) ? character : " ";
  }).join("")
    .trim()
    .slice(0, limit);
}

export function normalizeIncidentRoute(value: string) {
  try {
    const parsed = new URL(value, "https://company.invalid");
    return parsed.pathname.replace(/\/{2,}/g, "/").slice(0, 240) || "/";
  } catch {
    return "/unknown";
  }
}

export function normalizeIncidentMessage(value: unknown) {
  return sanitizeIncidentText(value, 1200)
    .toLowerCase()
    .replace(UUID_PATTERN, "<uuid>")
    .replace(COMPANY_ID_PATTERN, "<company-id>")
    .replace(/:\d+:\d+\b/g, ":<line>:<column>")
    .replace(/\bline\s+\d+\b/g, "line <number>")
    .replace(/\b\d{4}-\d{2}-\d{2}[t ][0-9:.+-]+z?\b/g, "<timestamp>")
    .replace(/\s+/g, " ")
    .trim();
}

export function incidentFingerprintMaterial(input: {
  category: SystemIncidentCategory;
  method: string;
  route: string;
  summary: unknown;
}) {
  return [
    "laazienda-system-incident:v1",
    input.category,
    input.method.trim().toUpperCase().slice(0, 12),
    normalizeIncidentRoute(input.route),
    normalizeIncidentMessage(input.summary),
  ].join("\n");
}

export async function fingerprintIncident(input: {
  category: SystemIncidentCategory;
  method: string;
  route: string;
  summary: unknown;
}) {
  const bytes = new TextEncoder().encode(incidentFingerprintMaterial(input));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function systemIncidentMarker(fingerprint: string) {
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("Invalid system incident fingerprint");
  return `<!-- laazienda-system-incident:v1:${fingerprint} -->`;
}

export function isReportablePortalResponse(pathname: string, status: number) {
  const route = normalizeIncidentRoute(pathname);
  return route.startsWith("/api/")
    && route !== "/api/system-incidents"
    && status >= 500
    && status <= 599;
}
