import { env } from "cloudflare:workers";
import { ensureDatabase } from "@/db/ensure";
import { sha256Hex, unpackCharacterZip } from "@/lib/character-package";
import { readBoundedBinary } from "@/lib/server/bounded-binary";
import { readBoundedJsonObject } from "@/lib/server/bounded-json";
import {
  CHARACTER_UPLOAD_FINALIZING_TTL,
  CHARACTER_UPLOAD_COMPLETED_TTL,
  CHARACTER_UPLOAD_GC_LIMIT,
  CHARACTER_UPLOAD_TTL,
  CLAIM_CHARACTER_UPLOAD_CLEANUP_SQL,
  CLAIM_CHARACTER_UPLOAD_COMPLETION_SQL,
  CLAIM_EXPIRED_CHARACTER_UPLOAD_CLEANUP_SQL,
  cleanupCharacterFinalObjects,
  COMPLETE_CHARACTER_ACTIVITY_SQL,
  COMPLETE_CHARACTER_PACK_SQL,
  COMPLETE_CHARACTER_UPLOAD_SESSION_SQL,
  CREATE_OR_REFRESH_CHARACTER_UPLOAD_SQL,
  DELETE_EXPIRED_CHARACTER_UPLOAD_SQL,
  READ_ACTIVE_CHARACTER_ROOT_UPLOAD_SQL,
  READ_CHARACTER_PACK_ROOT_REFERENCE_SQL,
  READ_CHARACTER_UPLOAD_SESSION_SQL,
  READ_EXPIRED_CHARACTER_UPLOADS_SQL,
  RECORD_CHARACTER_UPLOAD_FINAL_KEYS_SQL,
  characterRootPathPrefix,
} from "@/lib/server/character-upload-sql";
import { ownerAuthorized } from "@/lib/server/owner-auth";
import { readWorkforce } from "@/lib/server/workforce";

const CHUNK_BYTES = 384 * 1024;
const MAX_CHUNKS = 32;
const MAX_ARCHIVE_BYTES = 12 * 1024 * 1024;
const MAX_COMPLETION_BODY_BYTES = 1024;
const sessionPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const completionFields = new Set(["sessionId", "originalFilename", "totalChunks", "expectedSize"]);

interface CharacterObject {
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface CharacterBucket {
  put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
  get(key: string): Promise<CharacterObject | null>;
  delete(keys: string | string[]): Promise<void>;
}

interface UploadSessionRecord {
  sessionId: string;
  status: string;
  originalFilename: string | null;
  totalChunks: number | null;
  expectedSize: number | null;
  importedCharacterId: string | null;
  pendingKeyRoot: string | null;
  pendingArchiveDigest: string | null;
  pendingSpriteKey: string | null;
  cleanupClaimedAt: string | null;
  expiresAt: string;
  active: number;
}

type CharacterDatabase = typeof env.DB;

class CharacterBindingUnavailableError extends Error {}

function getCharacterBucket() {
  const bucket = (env as unknown as { CHARACTERS?: CharacterBucket }).CHARACTERS;
  if (!bucket) throw new CharacterBindingUnavailableError("Character storage binding is unavailable");
  return bucket;
}

function chunkKey(sessionId: string, index: number) {
  return `character-uploads/${sessionId}/chunks/${index.toString().padStart(2, "0")}`;
}

function sessionChunkKeys(sessionId: string) {
  return Array.from({ length: MAX_CHUNKS }, (_, index) => chunkKey(sessionId, index));
}

async function discardSessionChunks(sessionId: string, bucket = getCharacterBucket()) {
  if (!sessionPattern.test(sessionId)) return false;
  try {
    await bucket.delete(sessionChunkKeys(sessionId));
    return true;
  } catch {
    // Cleanup is best-effort; the original validation response remains authoritative.
    return false;
  }
}

async function readUploadSession(d1: CharacterDatabase, sessionId: string) {
  return d1.prepare(READ_CHARACTER_UPLOAD_SESSION_SQL).bind(sessionId).first<UploadSessionRecord>();
}

async function cleanupFinalObjects(d1: CharacterDatabase, bucket: CharacterBucket, session: UploadSessionRecord) {
  return cleanupCharacterFinalObjects(session, {
    async rootIsReferenced(keyRoot) {
      const pathPrefix = characterRootPathPrefix(keyRoot);
      return Boolean(await d1.prepare(READ_CHARACTER_PACK_ROOT_REFERENCE_SQL).bind(pathPrefix, pathPrefix).first());
    },
    async rootHasActiveUpload(keyRoot, sessionId) {
      return Boolean(await d1.prepare(READ_ACTIVE_CHARACTER_ROOT_UPLOAD_SQL).bind(sessionId, keyRoot).first());
    },
    async deleteExactKeys(keys) {
      await bucket.delete([...keys]);
    },
  });
}

async function cleanupClaimedUploadSession(d1: CharacterDatabase, bucket: CharacterBucket, session: UploadSessionRecord) {
  const finalCleanup = await cleanupFinalObjects(d1, bucket, session);
  if (finalCleanup === "failed" || !(await discardSessionChunks(session.sessionId, bucket))) return false;
  const deleted = await d1.prepare(DELETE_EXPIRED_CHARACTER_UPLOAD_SQL).bind(session.sessionId).run();
  return Number(deleted.meta.changes ?? 0) > 0;
}

async function collectExpiredUploadSessions(d1: CharacterDatabase, bucket: CharacterBucket) {
  const expired = await d1.prepare(READ_EXPIRED_CHARACTER_UPLOADS_SQL)
    .bind(CHARACTER_UPLOAD_GC_LIMIT).all<UploadSessionRecord>();
  for (const row of expired.results) {
    if (!sessionPattern.test(row.sessionId)) continue;
    if (row.status === "completed") {
      if (!(await discardSessionChunks(row.sessionId, bucket))) continue;
      await d1.prepare(DELETE_EXPIRED_CHARACTER_UPLOAD_SQL).bind(row.sessionId).run();
      continue;
    }
    let cleanupSession = row.cleanupClaimedAt ? row : await d1.prepare(CLAIM_EXPIRED_CHARACTER_UPLOAD_CLEANUP_SQL)
      .bind(row.sessionId).first<UploadSessionRecord>();
    cleanupSession ??= await readUploadSession(d1, row.sessionId);
    if (!cleanupSession?.cleanupClaimedAt) continue;
    await cleanupClaimedUploadSession(d1, bucket, cleanupSession);
  }
}

function completedCharacterId(session: UploadSessionRecord | null) {
  if (session?.status !== "completed" || typeof session.importedCharacterId !== "string") return null;
  return /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(session.importedCharacterId)
    ? session.importedCharacterId
    : null;
}

function uploadMetadataMatches(
  session: UploadSessionRecord | null,
  originalFilename: string,
  totalChunks: number,
  expectedSize: number,
) {
  return session?.originalFilename === originalFilename
    && session.totalChunks === totalChunks
    && session.expectedSize === expectedSize;
}

function ownerUnlockRequired() {
  return Response.json(
    { error: "CEO authorization is required. Unlock the Training Room, then try the character import again." },
    { status: 403 },
  );
}

function filenameHasForbiddenCharacters(value: string) {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return character === "/" || character === "\\" || codePoint < 32 || codePoint === 127;
  });
}

async function receiveChunk(request: Request, url: URL) {
  const sessionId = url.searchParams.get("session") ?? "";
  const indexValue = url.searchParams.get("index") ?? "";
  const index = /^(?:0|[1-9]\d?)$/.test(indexValue) ? Number(indexValue) : Number.NaN;
  if (!sessionPattern.test(sessionId) || !Number.isInteger(index) || index < 0 || index >= MAX_CHUNKS) {
    return Response.json({ error: "Invalid upload chunk" }, { status: 400 });
  }
  const parsed = await readBoundedBinary(request, CHUNK_BYTES, "application/octet-stream");
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
  try {
    await ensureDatabase();
    const d1 = env.DB;
    const bucket = getCharacterBucket();
    await collectExpiredUploadSessions(d1, bucket);
    let uploadSession = await d1.prepare(CREATE_OR_REFRESH_CHARACTER_UPLOAD_SQL)
      .bind(sessionId, CHARACTER_UPLOAD_TTL).first<UploadSessionRecord>();
    uploadSession ??= await readUploadSession(d1, sessionId);
    const alreadyImported = completedCharacterId(uploadSession);
    if (alreadyImported) {
      await discardSessionChunks(sessionId, bucket);
      return Response.json({ received: index, completed: true, importedCharacterId: alreadyImported });
    }
    if (uploadSession?.status !== "uploading" || uploadSession.active !== 1 || uploadSession.originalFilename !== null) {
      return Response.json({ error: "This character upload session expired; start the import again" }, { status: 409 });
    }

    await bucket.put(chunkKey(sessionId, index), parsed.bytes, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: { sessionId, index: String(index) },
    });
    const verifiedSession = await readUploadSession(d1, sessionId);
    const completedAfterWrite = completedCharacterId(verifiedSession);
    if (completedAfterWrite) {
      await bucket.delete(chunkKey(sessionId, index)).catch(() => undefined);
      return Response.json({ received: index, completed: true, importedCharacterId: completedAfterWrite });
    }
    if (verifiedSession?.status !== "uploading" || verifiedSession.active !== 1 || verifiedSession.originalFilename !== null) {
      await bucket.delete(chunkKey(sessionId, index)).catch(() => undefined);
      return Response.json({ error: "This character upload session expired; start the import again" }, { status: 409 });
    }
    return Response.json({ received: index });
  } finally {
    parsed.bytes.fill(0);
  }
}

async function completeUpload(request: Request) {
  const parsed = await readBoundedJsonObject(request, MAX_COMPLETION_BODY_BYTES);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
  const body = parsed.value;
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  const originalFilename = typeof body.originalFilename === "string" ? body.originalFilename.trim() : "";
  const totalChunks = body.totalChunks;
  const expectedSize = body.expectedSize;
  const exactShape = Object.keys(body).length === completionFields.size
    && Object.keys(body).every((field) => completionFields.has(field));
  const filenameIsValid = originalFilename.length >= 5
    && originalFilename.length <= 180
    && originalFilename.toLowerCase().endsWith(".zip")
    && !filenameHasForbiddenCharacters(originalFilename);
  if (!exactShape || !sessionPattern.test(sessionId) || !filenameIsValid) {
    return Response.json({ error: "Invalid character upload" }, { status: 400 });
  }
  if (typeof totalChunks !== "number" || !Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > MAX_CHUNKS
    || typeof expectedSize !== "number" || !Number.isInteger(expectedSize) || expectedSize < 1 || expectedSize > MAX_ARCHIVE_BYTES
    || Math.ceil(expectedSize / CHUNK_BYTES) !== totalChunks) {
    return Response.json({ error: "Invalid character upload size" }, { status: 400 });
  }

  await ensureDatabase();
  const d1 = env.DB;
  const bucket = getCharacterBucket();
  await collectExpiredUploadSessions(d1, bucket);
  let uploadSession = await readUploadSession(d1, sessionId);
  const importedCharacterId = completedCharacterId(uploadSession);
  if (importedCharacterId) {
    if (!uploadMetadataMatches(uploadSession, originalFilename, totalChunks, expectedSize)) {
      return Response.json({ error: "This upload session already completed with different file metadata" }, { status: 409 });
    }
    await discardSessionChunks(sessionId, bucket);
    return Response.json({ ...(await readWorkforce()), importedCharacterId });
  }
  if (uploadSession?.status !== "uploading" || uploadSession.active !== 1) {
    return Response.json({ error: "This character upload session expired; start the import again" }, { status: 409 });
  }
  uploadSession = await d1.prepare(CLAIM_CHARACTER_UPLOAD_COMPLETION_SQL)
    .bind(originalFilename, totalChunks, expectedSize, CHARACTER_UPLOAD_FINALIZING_TTL, sessionId,
      originalFilename, totalChunks, expectedSize).first<UploadSessionRecord>();
  if (!uploadSession || !uploadMetadataMatches(uploadSession, originalFilename, totalChunks, expectedSize)) {
    const concurrentSession = await readUploadSession(d1, sessionId);
    const concurrentCharacterId = completedCharacterId(concurrentSession);
    if (concurrentCharacterId && uploadMetadataMatches(concurrentSession, originalFilename, totalChunks, expectedSize)) {
      await discardSessionChunks(sessionId, bucket);
      return Response.json({ ...(await readWorkforce()), importedCharacterId: concurrentCharacterId });
    }
    return Response.json({ error: "This upload session is finalizing different file metadata; start the import again" }, { status: 409 });
  }

  const abortFinalization = async () => {
    try {
      let cleanupSession = await d1.prepare(CLAIM_CHARACTER_UPLOAD_CLEANUP_SQL)
        .bind(sessionId, originalFilename, totalChunks, expectedSize).first<UploadSessionRecord>();
      cleanupSession ??= await readUploadSession(d1, sessionId);
      if (!cleanupSession?.cleanupClaimedAt
          || !uploadMetadataMatches(cleanupSession, originalFilename, totalChunks, expectedSize)) return false;
      return await cleanupClaimedUploadSession(d1, bucket, cleanupSession);
    } catch {
      // The claimed row retains the exact final keys and a bounded expiry so a
      // later request can retry cleanup without listing the bucket.
      return false;
    }
  };

  const keys = Array.from({ length: totalChunks }, (_, index) => chunkKey(sessionId, index));
  const chunks = await Promise.all(keys.map((key) => bucket.get(key)));
  if (chunks.some((chunk) => !chunk)) {
    await abortFinalization();
    return Response.json({ error: "One or more upload chunks are missing; start the import again" }, { status: 409 });
  }
  const chunkSizesAreValid = chunks.every((chunk, index) => {
    const expectedChunkSize = index === totalChunks - 1
      ? expectedSize - (CHUNK_BYTES * (totalChunks - 1))
      : CHUNK_BYTES;
    return Number.isSafeInteger(chunk!.size) && chunk!.size === expectedChunkSize;
  });
  if (!chunkSizesAreValid) {
    await abortFinalization();
    return Response.json({ error: "The uploaded ZIP size did not match" }, { status: 400 });
  }

  const archiveBytes = new Uint8Array(expectedSize);
  let offset = 0;
  for (const chunk of chunks) {
    const bytes = new Uint8Array(await chunk!.arrayBuffer());
    if (bytes.byteLength !== chunk!.size) {
      archiveBytes.fill(0);
      await abortFinalization();
      return Response.json({ error: "The uploaded ZIP size did not match" }, { status: 400 });
    }
    archiveBytes.set(bytes, offset);
    offset += bytes.length;
  }

  try {
    let character: ReturnType<typeof unpackCharacterZip>;
    try {
      character = unpackCharacterZip(archiveBytes);
    } catch (error) {
      await abortFinalization();
      const message = error instanceof Error ? error.message : "The selected file is not a readable ZIP package";
      return Response.json({ error: message }, { status: 400 });
    }
    const existing = await d1.prepare("SELECT spritesheet_path AS spritesheetPath FROM character_packs WHERE id = ?")
      .bind(character.id).first<{ spritesheetPath: string | null }>();
    if (existing?.spritesheetPath && !existing.spritesheetPath.startsWith("/api/characters/asset?")) {
      await abortFinalization();
      return Response.json({ error: "A built-in character already uses this id and cannot be overwritten" }, { status: 409 });
    }

    // Address the whole preserved pack, not only its sprite. Two legitimate
    // revisions can reuse identical pixels while changing the manifest; using
    // the archive digest keeps every final object immutable across retries and
    // concurrent imports.
    const digest = await sha256Hex(character.archiveBytes);
    const keyRoot = `characters/${character.id}/${digest}`;
    const spriteKey = `${keyRoot}/${character.spriteFilename}`;
    const spritesheetPath = `/api/characters/asset?key=${encodeURIComponent(spriteKey)}`;
    const metadata = { characterId: character.id, originalFilename };

    uploadSession = await d1.prepare(RECORD_CHARACTER_UPLOAD_FINAL_KEYS_SQL)
      .bind(keyRoot, digest, spriteKey, CHARACTER_UPLOAD_FINALIZING_TTL,
        sessionId, originalFilename, totalChunks, expectedSize,
        keyRoot, digest, spriteKey, keyRoot).first<UploadSessionRecord>();
    if (!uploadSession) {
      const concurrentSession = await readUploadSession(d1, sessionId);
      const concurrentCharacterId = completedCharacterId(concurrentSession);
      if (concurrentCharacterId && uploadMetadataMatches(concurrentSession, originalFilename, totalChunks, expectedSize)) {
        await discardSessionChunks(sessionId, bucket);
        return Response.json({ ...(await readWorkforce()), importedCharacterId: concurrentCharacterId });
      }
      return Response.json({ error: "This character upload could not reserve immutable storage; try again" }, { status: 409 });
    }

    try {
      const putResults = await Promise.allSettled([
        bucket.put(`${keyRoot}/pet.json`, character.manifestBytes, { httpMetadata: { contentType: "application/json" }, customMetadata: metadata }),
        bucket.put(spriteKey, character.spriteBytes, { httpMetadata: { contentType: character.spriteContentType }, customMetadata: metadata }),
        bucket.put(`${keyRoot}/package.zip`, character.archiveBytes, { httpMetadata: { contentType: "application/zip" }, customMetadata: metadata }),
      ]);
      if (putResults.some((result) => result.status === "rejected")) {
        throw new Error("One or more immutable character objects could not be written");
      }

      const completionResults = await d1.batch([
        d1.prepare(COMPLETE_CHARACTER_UPLOAD_SESSION_SQL)
          .bind(character.id, CHARACTER_UPLOAD_COMPLETED_TTL, sessionId, originalFilename, totalChunks, expectedSize,
            keyRoot, digest, spriteKey),
        d1.prepare(COMPLETE_CHARACTER_PACK_SQL)
          .bind(character.id, character.displayName, character.description, `upload://${originalFilename}`, spritesheetPath, character.spriteVersion),
        d1.prepare(COMPLETE_CHARACTER_ACTIVITY_SQL)
          .bind(`${character.displayName} was imported from a character ZIP.`),
      ]);
      if (Number(completionResults[0]?.meta.changes ?? 0) === 0) {
        const concurrentSession = await readUploadSession(d1, sessionId);
        const concurrentCharacterId = completedCharacterId(concurrentSession);
        if (concurrentCharacterId && uploadMetadataMatches(concurrentSession, originalFilename, totalChunks, expectedSize)) {
          await discardSessionChunks(sessionId, bucket);
          return Response.json({ ...(await readWorkforce()), importedCharacterId: concurrentCharacterId });
        }
        await abortFinalization();
        return Response.json({ error: "The character upload could not be committed; try the import again" }, { status: 409 });
      }

      await discardSessionChunks(sessionId, bucket);
      return Response.json({ ...(await readWorkforce()), importedCharacterId: character.id });
    } catch (error) {
      await abortFinalization();
      throw error;
    }
  } finally {
    archiveBytes.fill(0);
  }
}

export async function POST(request: Request) {
  try {
    if (!(await ownerAuthorized(request))) return ownerUnlockRequired();
    const url = new URL(request.url);
    const phase = url.searchParams.get("phase");
    if (phase === "chunk") return await receiveChunk(request, url);
    if (phase === "complete") return await completeUpload(request);
    return Response.json({ error: "Unknown character upload phase" }, { status: 400 });
  } catch (error) {
    if (error instanceof CharacterBindingUnavailableError) {
      return Response.json({ error: "Character import storage is unavailable" }, { status: 503 });
    }
    return Response.json({ error: "Character import failed" }, { status: 500 });
  }
}
