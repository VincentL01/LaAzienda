export const CHARACTER_UPLOAD_TTL = "+30 minutes";
export const CHARACTER_UPLOAD_FINALIZING_TTL = "+5 minutes";
export const CHARACTER_UPLOAD_COMPLETED_TTL = "+7 days";
export const CHARACTER_UPLOAD_GC_LIMIT = 4;

export const CREATE_OR_REFRESH_CHARACTER_UPLOAD_SQL = `INSERT INTO character_upload_sessions (
  session_id, status, expires_at, created_at, updated_at
) VALUES (?, 'uploading', datetime(CURRENT_TIMESTAMP, ?), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT(session_id) DO UPDATE SET
  expires_at = excluded.expires_at,
  updated_at = CURRENT_TIMESTAMP
WHERE character_upload_sessions.status = 'uploading'
  AND character_upload_sessions.expires_at > CURRENT_TIMESTAMP
  AND character_upload_sessions.cleanup_claimed_at IS NULL
  AND character_upload_sessions.original_filename IS NULL
RETURNING session_id AS sessionId, status, original_filename AS originalFilename, total_chunks AS totalChunks,
  expected_size AS expectedSize, imported_character_id AS importedCharacterId,
  pending_key_root AS pendingKeyRoot, pending_archive_digest AS pendingArchiveDigest,
  pending_sprite_key AS pendingSpriteKey, cleanup_claimed_at AS cleanupClaimedAt,
  expires_at AS expiresAt, 1 AS active`;

export const READ_CHARACTER_UPLOAD_SESSION_SQL = `SELECT session_id AS sessionId, status, original_filename AS originalFilename,
  total_chunks AS totalChunks, expected_size AS expectedSize,
  imported_character_id AS importedCharacterId,
  pending_key_root AS pendingKeyRoot, pending_archive_digest AS pendingArchiveDigest,
  pending_sprite_key AS pendingSpriteKey, cleanup_claimed_at AS cleanupClaimedAt,
  expires_at AS expiresAt,
  CASE WHEN status = 'uploading' AND expires_at > CURRENT_TIMESTAMP
    AND cleanup_claimed_at IS NULL THEN 1 ELSE 0 END AS active
FROM character_upload_sessions WHERE session_id = ?`;

export const CLAIM_CHARACTER_UPLOAD_COMPLETION_SQL = `UPDATE character_upload_sessions SET
  original_filename = ?, total_chunks = ?, expected_size = ?,
  expires_at = datetime(CURRENT_TIMESTAMP, ?), updated_at = CURRENT_TIMESTAMP
WHERE session_id = ? AND status = 'uploading' AND expires_at > CURRENT_TIMESTAMP
  AND cleanup_claimed_at IS NULL
  AND (original_filename IS NULL OR (
    original_filename = ? AND total_chunks = ? AND expected_size = ?
  ))
RETURNING session_id AS sessionId, status, original_filename AS originalFilename, total_chunks AS totalChunks,
  expected_size AS expectedSize, imported_character_id AS importedCharacterId,
  pending_key_root AS pendingKeyRoot, pending_archive_digest AS pendingArchiveDigest,
  pending_sprite_key AS pendingSpriteKey, cleanup_claimed_at AS cleanupClaimedAt,
  expires_at AS expiresAt, 1 AS active`;

export const RECORD_CHARACTER_UPLOAD_FINAL_KEYS_SQL = `UPDATE character_upload_sessions SET
  pending_key_root = ?, pending_archive_digest = ?, pending_sprite_key = ?,
  expires_at = datetime(CURRENT_TIMESTAMP, ?), updated_at = CURRENT_TIMESTAMP
WHERE session_id = ? AND status = 'uploading' AND expires_at > CURRENT_TIMESTAMP
  AND cleanup_claimed_at IS NULL
  AND original_filename = ? AND total_chunks = ? AND expected_size = ?
  AND ((pending_key_root IS NULL AND pending_archive_digest IS NULL AND pending_sprite_key IS NULL) OR (
    pending_key_root = ? AND pending_archive_digest = ? AND pending_sprite_key = ?
  ))
  AND NOT EXISTS (
    SELECT 1 FROM character_upload_sessions cleanup
    WHERE cleanup.session_id != character_upload_sessions.session_id
      AND cleanup.pending_key_root = ? AND cleanup.cleanup_claimed_at IS NOT NULL
  )
RETURNING session_id AS sessionId, status, original_filename AS originalFilename, total_chunks AS totalChunks,
  expected_size AS expectedSize, imported_character_id AS importedCharacterId,
  pending_key_root AS pendingKeyRoot, pending_archive_digest AS pendingArchiveDigest,
  pending_sprite_key AS pendingSpriteKey, cleanup_claimed_at AS cleanupClaimedAt,
  expires_at AS expiresAt, 1 AS active`;

export const CLAIM_CHARACTER_UPLOAD_CLEANUP_SQL = `UPDATE character_upload_sessions SET
  cleanup_claimed_at = CURRENT_TIMESTAMP, expires_at = CURRENT_TIMESTAMP,
  updated_at = CURRENT_TIMESTAMP
WHERE session_id = ? AND status = 'uploading' AND cleanup_claimed_at IS NULL
  AND original_filename = ? AND total_chunks = ? AND expected_size = ?
  AND (pending_key_root IS NULL OR NOT EXISTS (
    SELECT 1 FROM character_upload_sessions active
    WHERE active.session_id != character_upload_sessions.session_id
      AND active.pending_key_root = character_upload_sessions.pending_key_root
      AND active.status = 'uploading' AND active.cleanup_claimed_at IS NULL
      AND active.expires_at > CURRENT_TIMESTAMP
  ))
RETURNING session_id AS sessionId, status, original_filename AS originalFilename, total_chunks AS totalChunks,
  expected_size AS expectedSize, imported_character_id AS importedCharacterId,
  pending_key_root AS pendingKeyRoot, pending_archive_digest AS pendingArchiveDigest,
  pending_sprite_key AS pendingSpriteKey, cleanup_claimed_at AS cleanupClaimedAt,
  expires_at AS expiresAt, 0 AS active`;

export const CLAIM_EXPIRED_CHARACTER_UPLOAD_CLEANUP_SQL = `UPDATE character_upload_sessions SET
  cleanup_claimed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
WHERE session_id = ? AND status = 'uploading' AND expires_at <= CURRENT_TIMESTAMP
  AND cleanup_claimed_at IS NULL
  AND (pending_key_root IS NULL OR NOT EXISTS (
    SELECT 1 FROM character_upload_sessions active
    WHERE active.session_id != character_upload_sessions.session_id
      AND active.pending_key_root = character_upload_sessions.pending_key_root
      AND active.status = 'uploading' AND active.cleanup_claimed_at IS NULL
      AND active.expires_at > CURRENT_TIMESTAMP
  ))
RETURNING session_id AS sessionId, status, original_filename AS originalFilename, total_chunks AS totalChunks,
  expected_size AS expectedSize, imported_character_id AS importedCharacterId,
  pending_key_root AS pendingKeyRoot, pending_archive_digest AS pendingArchiveDigest,
  pending_sprite_key AS pendingSpriteKey, cleanup_claimed_at AS cleanupClaimedAt,
  expires_at AS expiresAt, 0 AS active`;

export const READ_EXPIRED_CHARACTER_UPLOADS_SQL = `SELECT session_id AS sessionId, status,
  original_filename AS originalFilename, total_chunks AS totalChunks, expected_size AS expectedSize,
  imported_character_id AS importedCharacterId,
  pending_key_root AS pendingKeyRoot, pending_archive_digest AS pendingArchiveDigest,
  pending_sprite_key AS pendingSpriteKey, cleanup_claimed_at AS cleanupClaimedAt,
  expires_at AS expiresAt, 0 AS active
FROM character_upload_sessions
WHERE expires_at <= CURRENT_TIMESTAMP
ORDER BY expires_at, session_id
LIMIT ?`;

export const DELETE_EXPIRED_CHARACTER_UPLOAD_SQL = `DELETE FROM character_upload_sessions
WHERE session_id = ? AND expires_at <= CURRENT_TIMESTAMP
  AND (status = 'completed' OR cleanup_claimed_at IS NOT NULL)`;

export const READ_CHARACTER_PACK_ROOT_REFERENCE_SQL = `SELECT id FROM character_packs
WHERE substr(spritesheet_path, 1, length(?)) = ? LIMIT 1`;

export const READ_ACTIVE_CHARACTER_ROOT_UPLOAD_SQL = `SELECT session_id AS sessionId
FROM character_upload_sessions
WHERE session_id != ? AND status = 'uploading' AND cleanup_claimed_at IS NULL
  AND expires_at > CURRENT_TIMESTAMP AND pending_key_root = ? LIMIT 1`;

export const COMPLETE_CHARACTER_PACK_SQL = `INSERT INTO character_packs (
  id, display_name, description, source_url, install_command, spritesheet_path,
  sprite_version, cache_status, cached_at, updated_at
)
SELECT ?, ?, ?, ?, NULL, ?, ?, 'cached', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE changes() > 0
ON CONFLICT(id) DO UPDATE SET
  display_name = excluded.display_name,
  description = excluded.description,
  source_url = excluded.source_url,
  spritesheet_path = excluded.spritesheet_path,
  sprite_version = excluded.sprite_version,
  cache_status = 'cached',
  cached_at = CURRENT_TIMESTAMP,
  updated_at = CURRENT_TIMESTAMP`;

export const COMPLETE_CHARACTER_ACTIVITY_SQL = `INSERT INTO activity (message, tone)
SELECT ?, 'success'
WHERE changes() > 0`;

export const COMPLETE_CHARACTER_UPLOAD_SESSION_SQL = `UPDATE character_upload_sessions SET
  status = 'completed',
  imported_character_id = ?,
  pending_key_root = NULL,
  pending_archive_digest = NULL,
  pending_sprite_key = NULL,
  expires_at = datetime(CURRENT_TIMESTAMP, ?),
  completed_at = CURRENT_TIMESTAMP,
  updated_at = CURRENT_TIMESTAMP
WHERE session_id = ? AND status = 'uploading' AND expires_at > CURRENT_TIMESTAMP
  AND cleanup_claimed_at IS NULL
  AND original_filename = ? AND total_chunks = ? AND expected_size = ?
  AND pending_key_root = ? AND pending_archive_digest = ? AND pending_sprite_key = ?`;

export interface PendingCharacterFinalObjects {
  sessionId: string;
  pendingKeyRoot: string | null;
  pendingArchiveDigest: string | null;
  pendingSpriteKey: string | null;
}

export type CharacterFinalObjectCleanupResult = "deleted" | "preserved" | "none" | "failed";

const finalKeyRootPattern = /^characters\/[a-z0-9][a-z0-9-]{1,62}[a-z0-9]\/[a-f0-9]{64}$/;
const archiveDigestPattern = /^[a-f0-9]{64}$/;

export function characterFinalObjectKeys(session: PendingCharacterFinalObjects) {
  const keyRoot = session.pendingKeyRoot;
  const digest = session.pendingArchiveDigest;
  const spriteKey = session.pendingSpriteKey;
  if (!keyRoot || !digest || !spriteKey || !finalKeyRootPattern.test(keyRoot)
      || !archiveDigestPattern.test(digest) || !keyRoot.endsWith(`/${digest}`)
      || !new RegExp(`^${keyRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\/spritesheet\\.(?:webp|png)$`).test(spriteKey)) {
    return null;
  }
  return [`${keyRoot}/pet.json`, spriteKey, `${keyRoot}/package.zip`] as const;
}

export function characterRootPathPrefix(keyRoot: string) {
  return `/api/characters/asset?key=${encodeURIComponent(`${keyRoot}/`)}`;
}

export async function cleanupCharacterFinalObjects(
  session: PendingCharacterFinalObjects,
  dependencies: {
    rootIsReferenced(keyRoot: string): Promise<boolean>;
    rootHasActiveUpload(keyRoot: string, sessionId: string): Promise<boolean>;
    deleteExactKeys(keys: readonly string[]): Promise<void>;
  },
): Promise<CharacterFinalObjectCleanupResult> {
  const keys = characterFinalObjectKeys(session);
  if (!keys) return session.pendingKeyRoot || session.pendingArchiveDigest || session.pendingSpriteKey ? "failed" : "none";
  if (await dependencies.rootIsReferenced(session.pendingKeyRoot!)) return "preserved";
  if (await dependencies.rootHasActiveUpload(session.pendingKeyRoot!, session.sessionId)) return "preserved";
  try {
    await dependencies.deleteExactKeys(keys);
    return "deleted";
  } catch {
    return "failed";
  }
}
