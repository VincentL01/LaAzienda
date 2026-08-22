const OWNER_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const OWNER_SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const OWNER_VERIFIER_PATTERN = /^[a-f0-9]{64}$/;
const OWNER_VERIFIER_DOMAIN = "laazienda:owner-credential:v1\0";
const OWNER_SESSION_TOKEN_DOMAIN = "laazienda:owner-session-token:v1\0";

export const OWNER_SESSION_COOKIE_NAME = "omc_ceo_training";
export const OWNER_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
export const OWNER_CREDENTIAL_BODY_MAX_BYTES = 256;
export const OWNER_CREDENTIAL_MAX_CHARACTERS = 128;

export const READ_OWNER_SESSION_SQL = `SELECT 1 AS authorized FROM owner_sessions
WHERE token_hash = ? AND owner_verifier = ? AND expires_at > CURRENT_TIMESTAMP LIMIT 1`;
export const INSERT_OWNER_SESSION_SQL = `INSERT INTO owner_sessions (
  token_hash, owner_verifier, expires_at, created_at
) VALUES (?, ?, datetime(CURRENT_TIMESTAMP, '+8 hours'), CURRENT_TIMESTAMP)`;
export const CLEAN_OWNER_SESSIONS_SQL = `DELETE FROM owner_sessions WHERE token_hash IN (
  SELECT token_hash FROM owner_sessions
  WHERE expires_at <= CURRENT_TIMESTAMP OR owner_verifier <> ?
  ORDER BY expires_at, token_hash LIMIT 32
)`;
export const DELETE_OWNER_SESSION_SQL = "DELETE FROM owner_sessions WHERE token_hash = ?";

type OwnerCredentialReadResult =
  | { ok: true; credential: string }
  | { ok: false; status: 400 | 413 };

interface OwnerSessionStatement {
  bind(...values: unknown[]): OwnerSessionStatement;
  first<T>(): Promise<T | null>;
  run(): Promise<{ meta: { changes?: number } }>;
}

export interface OwnerSessionDatabase {
  prepare(query: string): OwnerSessionStatement;
  batch(statements: OwnerSessionStatement[]): Promise<Array<{ meta: { changes?: number } }>>;
}

function verifierIsUsable(verifier: unknown): verifier is string {
  return typeof verifier === "string" && OWNER_VERIFIER_PATTERN.test(verifier);
}

async function configuredOwnerVerifier(explicitVerifier?: string | null) {
  if (explicitVerifier !== undefined) return verifierIsUsable(explicitVerifier) ? explicitVerifier : null;
  try {
    const workers = await import("cloudflare:workers");
    const verifier = (workers.env as unknown as { OWNER_SESSION_VERIFIER?: string }).OWNER_SESSION_VERIFIER;
    return verifierIsUsable(verifier) ? verifier : null;
  } catch {
    return null;
  }
}

async function configuredOwnerDatabase(explicitDatabase?: OwnerSessionDatabase | null) {
  if (explicitDatabase !== undefined) return explicitDatabase;
  try {
    const workers = await import("cloudflare:workers");
    return workers.env.DB as unknown as OwnerSessionDatabase;
  } catch {
    return null;
  }
}

function constantTimeMatch(supplied: string, expected: string) {
  let difference = supplied.length ^ expected.length;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= (supplied.charCodeAt(index) || 0) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

async function domainSeparatedHash(domain: string, value: string) {
  const bytes = new TextEncoder().encode(`${domain}${value}`);
  try {
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  } finally {
    bytes.fill(0);
  }
}

export async function deriveOwnerVerifier(credential: unknown) {
  return typeof credential === "string" && OWNER_CREDENTIAL_PATTERN.test(credential)
    ? domainSeparatedHash(OWNER_VERIFIER_DOMAIN, credential)
    : null;
}

export async function deriveOwnerSessionTokenHash(token: unknown) {
  return typeof token === "string" && OWNER_SESSION_TOKEN_PATTERN.test(token)
    ? domainSeparatedHash(OWNER_SESSION_TOKEN_DOMAIN, token)
    : null;
}

function cookieValue(request: Request) {
  const header = request.headers.get("cookie") ?? "";
  if (header.length > 4096) return "";
  for (const segment of header.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 0) continue;
    if (segment.slice(0, separator).trim() === OWNER_SESSION_COOKIE_NAME) {
      return segment.slice(separator + 1).trim();
    }
  }
  return "";
}

function cookieOriginIsAllowed(request: Request) {
  const url = new URL(request.url);
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
}

function ownerCookie(request: Request, value: string, maxAge: number) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${OWNER_SESSION_COOKIE_NAME}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}

function randomSessionToken() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  try {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  } finally {
    bytes.fill(0);
  }
}

export async function verifyOwnerCredential(credential: unknown, configuredVerifier?: string | null) {
  const expected = await configuredOwnerVerifier(configuredVerifier);
  const candidate = await deriveOwnerVerifier(credential);
  return Boolean(expected && candidate && constantTimeMatch(candidate, expected));
}

export async function ownerAuthorized(
  request: Request,
  configuredVerifier?: string | null,
  database?: OwnerSessionDatabase | null,
) {
  const verifier = await configuredOwnerVerifier(configuredVerifier);
  const tokenHash = await deriveOwnerSessionTokenHash(cookieValue(request));
  const d1 = await configuredOwnerDatabase(database);
  if (!verifier || !tokenHash || !d1) return false;
  try {
    return Boolean(await d1.prepare(READ_OWNER_SESSION_SQL).bind(tokenHash, verifier).first<{ authorized: number }>());
  } catch {
    // The first unlock creates the schema. Missing or unavailable state is not authority.
    return false;
  }
}

export async function setOwnerSession(
  response: Response,
  request: Request,
  credential: unknown,
  configuredVerifier?: string | null,
  database?: OwnerSessionDatabase | null,
) {
  const verifier = await configuredOwnerVerifier(configuredVerifier);
  if (!verifier || !cookieOriginIsAllowed(request) || !(await verifyOwnerCredential(credential, verifier))) return false;
  const d1 = await configuredOwnerDatabase(database);
  if (!d1) return false;
  const token = randomSessionToken();
  const tokenHash = await deriveOwnerSessionTokenHash(token);
  if (!tokenHash) return false;
  try {
    const results = await d1.batch([
      d1.prepare(CLEAN_OWNER_SESSIONS_SQL).bind(verifier),
      d1.prepare(INSERT_OWNER_SESSION_SQL).bind(tokenHash, verifier),
    ]);
    if (Number(results[1]?.meta.changes ?? 0) !== 1) return false;
    response.headers.append("Set-Cookie", ownerCookie(request, token, OWNER_SESSION_MAX_AGE_SECONDS));
    return true;
  } catch {
    return false;
  }
}

export async function clearOwnerSession(
  response: Response,
  request: Request,
  database?: OwnerSessionDatabase | null,
) {
  const tokenHash = await deriveOwnerSessionTokenHash(cookieValue(request));
  const d1 = await configuredOwnerDatabase(database);
  if (tokenHash) {
    if (!d1) return false;
    try {
      await d1.prepare(DELETE_OWNER_SESSION_SQL).bind(tokenHash).run();
    } catch {
      // Keep the cookie so logout can be retried; clearing it first would leave
      // a replayable durable session with no browser handle to revoke it.
      return false;
    }
  }
  if (cookieOriginIsAllowed(request)) response.headers.append("Set-Cookie", ownerCookie(request, "", 0));
  return true;
}

export async function readOwnerCredential(request: Request): Promise<OwnerCredentialReadResult> {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") return { ok: false, status: 400 };

  const statedLength = request.headers.get("content-length");
  if (statedLength) {
    const length = Number(statedLength);
    if (!Number.isSafeInteger(length) || length < 0) return { ok: false, status: 400 };
    if (length > OWNER_CREDENTIAL_BODY_MAX_BYTES) return { ok: false, status: 413 };
  }

  if (!request.body) return { ok: false, status: 400 };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > OWNER_CREDENTIAL_BODY_MAX_BYTES) {
        value.fill(0);
        for (const chunk of chunks) chunk.fill(0);
        await reader.cancel();
        return { ok: false, status: 413 };
      }
      chunks.push(value);
    }
  } catch {
    for (const chunk of chunks) chunk.fill(0);
    return { ok: false, status: 400 };
  }

  const bodyBytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes);
    const body = JSON.parse(decoded) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, status: 400 };
    const record = body as Record<string, unknown>;
    if (Object.keys(record).length !== 1 || typeof record.credential !== "string") return { ok: false, status: 400 };
    if (record.credential.length > OWNER_CREDENTIAL_MAX_CHARACTERS) return { ok: false, status: 400 };
    return { ok: true, credential: record.credential };
  } catch {
    return { ok: false, status: 400 };
  } finally {
    bodyBytes.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}
