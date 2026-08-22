import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { readBoundedBinary } from "../lib/server/bounded-binary.ts";
import { readBoundedJsonObject } from "../lib/server/bounded-json.ts";
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
  READ_CHARACTER_UPLOAD_SESSION_SQL,
  READ_EXPIRED_CHARACTER_UPLOADS_SQL,
  RECORD_CHARACTER_UPLOAD_FINAL_KEYS_SQL,
  characterFinalObjectKeys,
  characterRootPathPrefix,
} from "../lib/server/character-upload-sql.ts";
import { ownerAuthorized } from "../lib/server/owner-auth.ts";

const [routeSource, onboardingSource, ensureSource, schemaSource, uploadMigration] = await Promise.all([
  readFile(new URL("../app/api/characters/import/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/components/EmployeeOnboarding.tsx", import.meta.url), "utf8"),
  readFile(new URL("../db/ensure.ts", import.meta.url), "utf8"),
  readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
  readFile(new URL("../drizzle/0012_common_gideon.sql", import.meta.url), "utf8"),
]);

const testArchiveDigest = "a".repeat(64);
const testKeyRoot = `characters/durable-pet/${testArchiveDigest}`;
const testSpriteKey = `${testKeyRoot}/spritesheet.png`;

function uploadDatabase() {
  const d1 = new DatabaseSync(":memory:");
  d1.exec(`CREATE TABLE character_packs (
    id TEXT PRIMARY KEY, display_name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    source_url TEXT, install_command TEXT, spritesheet_path TEXT,
    sprite_version INTEGER NOT NULL DEFAULT 1, cache_status TEXT NOT NULL DEFAULT 'requested',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, cached_at TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT NOT NULL,
    tone TEXT NOT NULL DEFAULT 'neutral', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  ${uploadMigration}
  ALTER TABLE character_upload_sessions ADD COLUMN pending_key_root TEXT;
  ALTER TABLE character_upload_sessions ADD COLUMN pending_archive_digest TEXT;
  ALTER TABLE character_upload_sessions ADD COLUMN pending_sprite_key TEXT;
  ALTER TABLE character_upload_sessions ADD COLUMN cleanup_claimed_at TEXT;`);
  return d1;
}

function createUpload(d1, sessionId) {
  return d1.prepare(CREATE_OR_REFRESH_CHARACTER_UPLOAD_SQL).get(sessionId, CHARACTER_UPLOAD_TTL);
}

function recordFinalKeys(d1, sessionId) {
  return d1.prepare(RECORD_CHARACTER_UPLOAD_FINAL_KEYS_SQL).get(
    testKeyRoot, testArchiveDigest, testSpriteKey, CHARACTER_UPLOAD_FINALIZING_TTL,
    sessionId, "durable-pet.zip", 1, 128,
    testKeyRoot, testArchiveDigest, testSpriteKey, testKeyRoot,
  );
}

function commitUpload(d1, sessionId, characterId = "durable-pet") {
  const claimed = d1.prepare(CLAIM_CHARACTER_UPLOAD_COMPLETION_SQL)
    .get("durable-pet.zip", 1, 128, CHARACTER_UPLOAD_FINALIZING_TTL, sessionId, "durable-pet.zip", 1, 128);
  if (claimed) recordFinalKeys(d1, sessionId);
  d1.exec("BEGIN");
  try {
    const session = d1.prepare(COMPLETE_CHARACTER_UPLOAD_SESSION_SQL)
      .run(characterId, CHARACTER_UPLOAD_COMPLETED_TTL, sessionId, "durable-pet.zip", 1, 128,
        testKeyRoot, testArchiveDigest, testSpriteKey);
    const character = d1.prepare(COMPLETE_CHARACTER_PACK_SQL)
      .run(characterId, "Durable Pet", "", "upload://durable-pet.zip", "/api/characters/asset?key=durable", 1);
    const activity = d1.prepare(COMPLETE_CHARACTER_ACTIVITY_SQL)
      .run("Durable Pet was imported from a character ZIP.");
    d1.exec("COMMIT");
    return { session: session.changes, character: character.changes, activity: activity.changes };
  } catch (error) {
    d1.exec("ROLLBACK");
    throw error;
  }
}

test("character chunks accept only bounded octet-stream bodies", async () => {
  const wrongType = new Request("http://localhost/api/characters/import?phase=chunk", {
    method: "POST",
    headers: { "content-type": "application/zip" },
    body: new Uint8Array([1, 2, 3]),
  });
  assert.deepEqual(await readBoundedBinary(wrongType, 3, "application/octet-stream"), {
    ok: false,
    status: 415,
    error: "Expected application/octet-stream",
  });

  const declaredOversize = new Request("http://localhost/api/characters/import?phase=chunk", {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "content-length": "4" },
    body: new Uint8Array([1, 2, 3]),
  });
  assert.deepEqual(await readBoundedBinary(declaredOversize, 3, "application/octet-stream"), {
    ok: false,
    status: 413,
    error: "Request body is too large",
  });

  const streamedOversize = new Request("http://localhost/api/characters/import?phase=chunk", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: new Uint8Array([1, 2, 3, 4]),
  });
  assert.deepEqual(await readBoundedBinary(streamedOversize, 3, "application/octet-stream"), {
    ok: false,
    status: 413,
    error: "Request body is too large",
  });

  const accepted = new Request("http://localhost/api/characters/import?phase=chunk", {
    method: "POST",
    headers: { "content-type": "application/octet-stream; charset=binary" },
    body: new Uint8Array([1, 2, 3]),
  });
  const result = await readBoundedBinary(accepted, 3, "application/octet-stream");
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual([...result.bytes], [1, 2, 3]);
});

test("character completion JSON is media-type and stream bounded", async () => {
  const wrongType = new Request("http://localhost/api/characters/import?phase=complete", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "{}",
  });
  assert.deepEqual(await readBoundedJsonObject(wrongType, 32), {
    ok: false,
    status: 415,
    error: "Expected application/json",
  });

  const oversized = new Request("http://localhost/api/characters/import?phase=complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: "x".repeat(64) }),
  });
  assert.deepEqual(await readBoundedJsonObject(oversized, 32), {
    ok: false,
    status: 413,
    error: "Request body is too large",
  });
});

test("a rejected owner check does not consume an upload body", async () => {
  const request = new Request("http://localhost/api/characters/import?phase=chunk", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: new Uint8Array([1, 2, 3]),
  });
  assert.equal(request.bodyUsed, false);
  assert.equal(await ownerAuthorized(request, "independent-owner-credential-long-enough-123456789"), false);
  assert.equal(request.bodyUsed, false);
});

test("owner authorization precedes every character import read and write boundary", () => {
  const post = routeSource.slice(routeSource.indexOf("export async function POST"));
  const authorization = post.indexOf("await ownerAuthorized(request)");
  const urlRead = post.indexOf("new URL(request.url)");
  const chunkDispatch = post.indexOf("receiveChunk(request, url)");
  const completionDispatch = post.indexOf("completeUpload(request)");
  assert.ok(authorization >= 0, "owner authorization must be checked");
  assert.ok(urlRead > authorization, "phase parsing must follow owner authorization");
  assert.ok(chunkDispatch > authorization, "chunk storage must follow owner authorization");
  assert.ok(completionDispatch > authorization, "completion reads and writes must follow owner authorization");
  assert.match(post, /if \(!\(await ownerAuthorized\(request\)\)\) return ownerUnlockRequired\(\)/);
  assert.match(routeSource, /Unlock the Training Room[\s\S]*status: 403/);
  assert.doesNotMatch(routeSource, /request\.json\(\)|request\.arrayBuffer\(\)/);
});

test("route and browser client agree on the two exact import media types", () => {
  assert.match(routeSource, /readBoundedBinary\(request, CHUNK_BYTES, "application\/octet-stream"\)/);
  assert.match(routeSource, /readBoundedJsonObject\(request, MAX_COMPLETION_BODY_BYTES\)/);
  assert.match(onboardingSource, /"content-type": "application\/octet-stream"/);
  assert.match(onboardingSource, /"content-type": "application\/json"/);
});

test("only a claimed finalization discards bounded session chunks", () => {
  assert.match(routeSource, /Array\.from\(\{ length: MAX_CHUNKS \}[\s\S]*chunkKey\(sessionId, index\)/);
  const unclaimedValidation = routeSource.slice(routeSource.indexOf("const exactShape"), routeSource.indexOf("await ensureDatabase()", routeSource.indexOf("const exactShape")));
  assert.doesNotMatch(unclaimedValidation, /discardSessionChunks/,
    "malformed concurrent completions must not delete chunks from an active upload");
  assert.match(routeSource, /const abortFinalization = async \(\)[\s\S]*CLAIM_CHARACTER_UPLOAD_CLEANUP_SQL[\s\S]*cleanupClaimedUploadSession/);
  assert.match(routeSource, /if \(!chunkSizesAreValid\)[\s\S]*await abortFinalization\(\)/);
  assert.match(routeSource, /character = unpackCharacterZip\(archiveBytes\)[\s\S]*catch \(error\)[\s\S]*await abortFinalization\(\)/);
  assert.match(routeSource, /A built-in character already uses this id[\s\S]*status: 409/);
  assert.match(routeSource, /await discardSessionChunks\(sessionId, bucket\)[\s\S]*return Response\.json\(\{ \.\.\.\(await readWorkforce\(\)\), importedCharacterId: character\.id \}\)/);

  const missingChunkBranch = routeSource.match(/if \(chunks\.some\([\s\S]*?status: 409 \}\);/)?.[0] ?? "";
  assert.doesNotMatch(missingChunkBranch, /discardSessionChunks/, "a retryable missing-chunk response must preserve received chunks");
});

test("D1 upload sessions are bounded, expiring, and cannot refresh after completion", () => {
  const d1 = uploadDatabase();
  const sessionId = "11111111-1111-4111-8111-111111111111";
  assert.equal(createUpload(d1, sessionId).status, "uploading");
  assert.equal(createUpload(d1, sessionId).status, "uploading", "an active chunk retry refreshes its lease");

  assert.deepEqual(commitUpload(d1, sessionId), { session: 1, character: 1, activity: 1 });
  assert.equal(createUpload(d1, sessionId), undefined, "a completed session cannot return to uploading");
  assert.equal(d1.prepare("SELECT status FROM character_upload_sessions WHERE session_id = ?").get(sessionId).status, "completed");

  d1.prepare(`INSERT INTO character_upload_sessions (session_id, status, expires_at)
    VALUES (?, 'uploading', datetime(CURRENT_TIMESTAMP, '-1 minute'))`)
    .run("22222222-2222-4222-8222-222222222222");
  assert.equal(createUpload(d1, "22222222-2222-4222-8222-222222222222"), undefined, "an expired row cannot be refreshed before cleanup");
});

test("completion is one atomic, idempotent D1 transition across failure windows", () => {
  const d1 = uploadDatabase();
  const sessionId = "33333333-3333-4333-8333-333333333333";
  createUpload(d1, sessionId);
  const claim = d1.prepare(CLAIM_CHARACTER_UPLOAD_COMPLETION_SQL)
    .get("durable-pet.zip", 1, 128, CHARACTER_UPLOAD_FINALIZING_TTL, sessionId, "durable-pet.zip", 1, 128);
  assert.equal(claim.originalFilename, "durable-pet.zip");
  assert.ok(recordFinalKeys(d1, sessionId));

  d1.exec("BEGIN");
  d1.prepare(COMPLETE_CHARACTER_UPLOAD_SESSION_SQL)
    .run("durable-pet", CHARACTER_UPLOAD_COMPLETED_TTL, sessionId, "durable-pet.zip", 1, 128,
      testKeyRoot, testArchiveDigest, testSpriteKey);
  d1.prepare(COMPLETE_CHARACTER_PACK_SQL)
    .run("durable-pet", "Durable Pet", "", "upload://durable-pet.zip", "/asset", 1);
  d1.exec("ROLLBACK");
  assert.equal(d1.prepare("SELECT status FROM character_upload_sessions WHERE session_id = ?").get(sessionId).status, "uploading");
  assert.equal(d1.prepare("SELECT COUNT(*) AS count FROM character_packs").get().count, 0);
  assert.equal(d1.prepare("SELECT COUNT(*) AS count FROM activity").get().count, 0);

  assert.deepEqual(commitUpload(d1, sessionId), { session: 1, character: 1, activity: 1 });
  assert.deepEqual(commitUpload(d1, sessionId, "different-pet"), { session: 0, character: 0, activity: 0 },
    "a retry after D1 commit but before cleanup or response must not replay derived writes");
  assert.equal(d1.prepare("SELECT id FROM character_packs").get().id, "durable-pet");
  assert.equal(d1.prepare("SELECT COUNT(*) AS count FROM activity").get().count, 1);
  assert.equal(d1.prepare("SELECT imported_character_id AS id FROM character_upload_sessions WHERE session_id = ?").get(sessionId).id, "durable-pet");
});

test("completion lease freezes file identity and blocks chunk refreshes", () => {
  const d1 = uploadDatabase();
  const sessionId = "66666666-6666-4666-8666-666666666666";
  createUpload(d1, sessionId);
  assert.ok(d1.prepare(CLAIM_CHARACTER_UPLOAD_COMPLETION_SQL)
    .get("first.zip", 2, 512, CHARACTER_UPLOAD_FINALIZING_TTL, sessionId, "first.zip", 2, 512));
  assert.equal(createUpload(d1, sessionId), undefined, "chunks cannot race an owned finalization");
  assert.equal(d1.prepare(CLAIM_CHARACTER_UPLOAD_COMPLETION_SQL)
    .get("other.zip", 2, 512, CHARACTER_UPLOAD_FINALIZING_TTL, sessionId, "other.zip", 2, 512), undefined,
  "the same session cannot be relabeled as another file");
  assert.ok(d1.prepare(CLAIM_CHARACTER_UPLOAD_COMPLETION_SQL)
    .get("first.zip", 2, 512, CHARACTER_UPLOAD_FINALIZING_TTL, sessionId, "first.zip", 2, 512),
  "an exact completion retry may renew its bounded lease");
  assert.equal(d1.prepare(CLAIM_CHARACTER_UPLOAD_CLEANUP_SQL).get(sessionId, "other.zip", 2, 512), undefined);
  assert.ok(d1.prepare(CLAIM_CHARACTER_UPLOAD_CLEANUP_SQL).get(sessionId, "first.zip", 2, 512));
  assert.equal(createUpload(d1, sessionId), undefined, "a cleanup claim cannot return to uploading");
});

test("expired-session garbage collection is capped and deletes only after bounded object cleanup", () => {
  const d1 = uploadDatabase();
  for (let index = 0; index < CHARACTER_UPLOAD_GC_LIMIT + 2; index += 1) {
    d1.prepare(`INSERT INTO character_upload_sessions (session_id, status, expires_at)
      VALUES (?, 'uploading', datetime(CURRENT_TIMESTAMP, '-1 minute'))`)
      .run(`44444444-4444-4444-8444-${String(index).padStart(12, "0")}`);
  }
  createUpload(d1, "55555555-5555-4555-8555-555555555555");

  const expired = d1.prepare(READ_EXPIRED_CHARACTER_UPLOADS_SQL).all(CHARACTER_UPLOAD_GC_LIMIT);
  assert.equal(expired.length, CHARACTER_UPLOAD_GC_LIMIT);
  const cleanedObjectKeys = [];
  for (const row of expired) {
    cleanedObjectKeys.push(...Array.from({ length: 32 }, (_, index) => `${row.sessionId}/${index}`));
    assert.ok(d1.prepare(CLAIM_EXPIRED_CHARACTER_UPLOAD_CLEANUP_SQL).get(row.sessionId));
    d1.prepare(DELETE_EXPIRED_CHARACTER_UPLOAD_SQL).run(row.sessionId);
  }
  assert.equal(cleanedObjectKeys.length, CHARACTER_UPLOAD_GC_LIMIT * 32);
  assert.equal(d1.prepare("SELECT COUNT(*) AS count FROM character_upload_sessions WHERE expires_at <= CURRENT_TIMESTAMP").get().count, 2);
  assert.equal(d1.prepare("SELECT COUNT(*) AS count FROM character_upload_sessions WHERE expires_at > CURRENT_TIMESTAMP").get().count, 1);
  assert.match(routeSource, /\.bind\(CHARACTER_UPLOAD_GC_LIMIT\)/);
  assert.match(routeSource, /CLAIM_EXPIRED_CHARACTER_UPLOAD_CLEANUP_SQL[\s\S]*cleanupClaimedUploadSession/);
});

test("partial final puts are compensated from the exact pending D1 key ledger", async () => {
  const d1 = uploadDatabase();
  const sessionId = "77777777-7777-4777-8777-777777777777";
  createUpload(d1, sessionId);
  d1.prepare(CLAIM_CHARACTER_UPLOAD_COMPLETION_SQL)
    .get("durable-pet.zip", 1, 128, CHARACTER_UPLOAD_FINALIZING_TTL,
      sessionId, "durable-pet.zip", 1, 128);
  const pending = recordFinalKeys(d1, sessionId);
  assert.deepEqual(characterFinalObjectKeys(pending), [
    `${testKeyRoot}/pet.json`,
    testSpriteKey,
    `${testKeyRoot}/package.zip`,
  ]);

  const claimed = d1.prepare(CLAIM_CHARACTER_UPLOAD_CLEANUP_SQL)
    .get(sessionId, "durable-pet.zip", 1, 128);
  const objects = new Set([`${testKeyRoot}/pet.json`, testSpriteKey]);
  const deletedKeys = [];
  const result = await cleanupCharacterFinalObjects(claimed, {
    async rootIsReferenced() { return false; },
    async rootHasActiveUpload() { return false; },
    async deleteExactKeys(keys) {
      deletedKeys.push(...keys);
      for (const key of keys) objects.delete(key);
    },
  });
  assert.equal(result, "deleted");
  assert.deepEqual(deletedKeys, characterFinalObjectKeys(claimed));
  assert.equal(objects.size, 0, "all successfully written members of a partial put are removed");

  const persist = routeSource.indexOf("d1.prepare(RECORD_CHARACTER_UPLOAD_FINAL_KEYS_SQL)");
  const puts = routeSource.indexOf("await Promise.allSettled(");
  assert.ok(persist > 0 && puts > persist, "the exact final object ledger must commit before any put starts");
  assert.doesNotMatch(routeSource, /\.list\s*\(/, "cleanup must never enumerate R2");
});

test("a pack-root reference always preserves immutable final objects", async () => {
  let deletionAttempted = false;
  const session = {
    sessionId: "88888888-8888-4888-8888-888888888888",
    pendingKeyRoot: testKeyRoot,
    pendingArchiveDigest: testArchiveDigest,
    pendingSpriteKey: testSpriteKey,
  };
  assert.equal(await cleanupCharacterFinalObjects(session, {
    async rootIsReferenced(root) {
      assert.equal(characterRootPathPrefix(root), `/api/characters/asset?key=${encodeURIComponent(`${testKeyRoot}/`)}`);
      return true;
    },
    async rootHasActiveUpload() { throw new Error("reference check must stop cleanup"); },
    async deleteExactKeys() { deletionAttempted = true; },
  }), "preserved");
  assert.equal(deletionAttempted, false);
  assert.match(routeSource, /READ_CHARACTER_PACK_ROOT_REFERENCE_SQL/);
});

test("D1 failure compensation remains durable for the next bounded GC pass", async () => {
  const d1 = uploadDatabase();
  const sessionId = "99999999-9999-4999-8999-999999999999";
  createUpload(d1, sessionId);
  d1.prepare(CLAIM_CHARACTER_UPLOAD_COMPLETION_SQL)
    .get("durable-pet.zip", 1, 128, CHARACTER_UPLOAD_FINALIZING_TTL,
      sessionId, "durable-pet.zip", 1, 128);
  recordFinalKeys(d1, sessionId);

  d1.exec("BEGIN");
  d1.prepare(COMPLETE_CHARACTER_UPLOAD_SESSION_SQL)
    .run("durable-pet", CHARACTER_UPLOAD_COMPLETED_TTL, sessionId, "durable-pet.zip", 1, 128,
      testKeyRoot, testArchiveDigest, testSpriteKey);
  d1.prepare(COMPLETE_CHARACTER_PACK_SQL)
    .run("durable-pet", "Durable Pet", "", "upload://durable-pet.zip", "/asset", 1);
  d1.exec("ROLLBACK");

  const claimed = d1.prepare(CLAIM_CHARACTER_UPLOAD_CLEANUP_SQL)
    .get(sessionId, "durable-pet.zip", 1, 128);
  assert.ok(claimed.cleanupClaimedAt, "compensation blocks any later D1 completion before R2 deletion");
  assert.equal(await cleanupCharacterFinalObjects(claimed, {
    async rootIsReferenced() { return false; },
    async rootHasActiveUpload() { return false; },
    async deleteExactKeys() { throw new Error("simulated transient R2 delete failure"); },
  }), "failed");
  assert.ok(d1.prepare(READ_CHARACTER_UPLOAD_SESSION_SQL).get(sessionId),
    "a failed compensation keeps the exact key ledger for GC");

  const objects = new Set(characterFinalObjectKeys(claimed));
  const [expired] = d1.prepare(READ_EXPIRED_CHARACTER_UPLOADS_SQL).all(CHARACTER_UPLOAD_GC_LIMIT);
  assert.equal(expired.sessionId, sessionId);
  assert.equal(await cleanupCharacterFinalObjects(expired, {
    async rootIsReferenced() { return false; },
    async rootHasActiveUpload() { return false; },
    async deleteExactKeys(keys) { for (const key of keys) objects.delete(key); },
  }), "deleted");
  assert.equal(objects.size, 0);
  assert.equal(d1.prepare(DELETE_EXPIRED_CHARACTER_UPLOAD_SQL).run(sessionId).changes, 1);
  assert.equal(d1.prepare(READ_CHARACTER_UPLOAD_SESSION_SQL).get(sessionId), undefined);
});

test("an active sibling sharing a root atomically prevents cleanup claim", () => {
  const d1 = uploadDatabase();
  const expiredSessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const activeSessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  for (const sessionId of [expiredSessionId, activeSessionId]) {
    createUpload(d1, sessionId);
    d1.prepare(CLAIM_CHARACTER_UPLOAD_COMPLETION_SQL)
      .get("durable-pet.zip", 1, 128, CHARACTER_UPLOAD_FINALIZING_TTL,
        sessionId, "durable-pet.zip", 1, 128);
    assert.ok(recordFinalKeys(d1, sessionId));
  }
  d1.prepare("UPDATE character_upload_sessions SET expires_at = datetime(CURRENT_TIMESTAMP, '-1 minute') WHERE session_id = ?")
    .run(expiredSessionId);

  assert.equal(d1.prepare(CLAIM_EXPIRED_CHARACTER_UPLOAD_CLEANUP_SQL).get(expiredSessionId), undefined,
    "the sibling must be sensed in the same D1 statement that would claim cleanup");
  assert.equal(d1.prepare(READ_CHARACTER_UPLOAD_SESSION_SQL).get(expiredSessionId).cleanupClaimedAt, null);

  d1.prepare("UPDATE character_upload_sessions SET expires_at = datetime(CURRENT_TIMESTAMP, '-1 minute') WHERE session_id = ?")
    .run(activeSessionId);
  assert.ok(d1.prepare(CLAIM_EXPIRED_CHARACTER_UPLOAD_CLEANUP_SQL).get(expiredSessionId),
    "cleanup may proceed only after no sibling can still commit this root");
});

test("D1, not an R2 receipt, is the completion and retry authority", () => {
  const sessionUpdate = routeSource.indexOf("d1.prepare(COMPLETE_CHARACTER_UPLOAD_SESSION_SQL)");
  const characterUpsert = routeSource.indexOf("d1.prepare(COMPLETE_CHARACTER_PACK_SQL)");
  const firstActivity = routeSource.indexOf("d1.prepare(COMPLETE_CHARACTER_ACTIVITY_SQL)");
  assert.ok(sessionUpdate > 0 && characterUpsert > sessionUpdate && firstActivity > characterUpsert);
  assert.match(routeSource, /completionResults\[0\]\?\.meta\.changes/);
  assert.match(routeSource, /const concurrentSession = await readUploadSession/);
  assert.doesNotMatch(routeSource, /complete\.json|receiptKey|receiptBytes/);
  assert.match(schemaSource, /characterUploadSessions = sqliteTable/);
  assert.match(schemaSource, /pendingKeyRoot: text\("pending_key_root"\)/);
  assert.match(schemaSource, /pendingArchiveDigest: text\("pending_archive_digest"\)/);
  assert.match(schemaSource, /pendingSpriteKey: text\("pending_sprite_key"\)/);
  assert.match(schemaSource, /cleanupClaimedAt: text\("cleanup_claimed_at"\)/);
  assert.match(ensureSource, /CREATE TABLE IF NOT EXISTS character_upload_sessions/);
  assert.match(ensureSource, /ALTER TABLE character_upload_sessions ADD COLUMN cleanup_claimed_at TEXT/);
  assert.match(uploadMigration, /character_upload_sessions_completion_check/);
  assert.match(uploadMigration, /idx_character_upload_sessions_expiry/);
});

test("final character objects are addressed by the whole preserved pack", () => {
  assert.match(routeSource, /sha256Hex\(character\.archiveBytes\)[\s\S]*characters\/\$\{character\.id\}\/\$\{digest\}/);
  assert.doesNotMatch(routeSource, /sha256Hex\(character\.spriteBytes\)/,
    "same-sprite manifest revisions must never overwrite one another's preserved package objects");
});

test("unexpected character import exceptions are opaque 500s", () => {
  const post = routeSource.slice(routeSource.indexOf("export async function POST"));
  assert.match(post, /error instanceof CharacterBindingUnavailableError[\s\S]*status: 503/);
  assert.match(post, /error: "Character import failed"[\s\S]*status: 500/);
  assert.doesNotMatch(post, /error\.message/,
    "the outer boundary must not echo internal exception messages");
  assert.doesNotMatch(post, /\/unavailable\//,
    "the outer boundary must not infer availability from exception text");
  assert.equal((post.match(/status: 503/g) ?? []).length, 1, "only the explicit missing binding maps to 503");
});
