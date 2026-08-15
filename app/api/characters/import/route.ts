import { env } from "cloudflare:workers";
import { ensureDatabase } from "@/db/ensure";
import { sha256Hex, unpackCharacterZip } from "@/lib/character-package";
import { readWorkforce } from "@/lib/server/workforce";

const CHUNK_BYTES = 384 * 1024;
const MAX_CHUNKS = 32;
const MAX_ARCHIVE_BYTES = 12 * 1024 * 1024;
const sessionPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface CharacterObject {
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface CharacterBucket {
  put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
  get(key: string): Promise<CharacterObject | null>;
  delete(keys: string | string[]): Promise<void>;
}

function getCharacterBucket() {
  const bucket = (env as unknown as { CHARACTERS?: CharacterBucket }).CHARACTERS;
  if (!bucket) throw new Error("Character storage is unavailable");
  return bucket;
}

function chunkKey(sessionId: string, index: number) {
  return `character-uploads/${sessionId}/chunks/${index.toString().padStart(2, "0")}`;
}

async function receiveChunk(request: Request, url: URL) {
  const sessionId = url.searchParams.get("session") ?? "";
  const index = Number(url.searchParams.get("index"));
  if (!sessionPattern.test(sessionId) || !Number.isInteger(index) || index < 0 || index >= MAX_CHUNKS) {
    return Response.json({ error: "Invalid upload chunk" }, { status: 400 });
  }
  const declaredSize = Number(request.headers.get("content-length") ?? 0);
  if (declaredSize > CHUNK_BYTES) return Response.json({ error: "Upload chunk is too large" }, { status: 413 });
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length || bytes.length > CHUNK_BYTES) return Response.json({ error: "Upload chunk is empty or too large" }, { status: 413 });
  await getCharacterBucket().put(chunkKey(sessionId, index), bytes, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { sessionId, index: String(index) },
  });
  return Response.json({ received: index });
}

async function completeUpload(request: Request) {
  const body = (await request.json()) as Record<string, unknown>;
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  const originalFilename = typeof body.originalFilename === "string" ? body.originalFilename.trim().slice(0, 180) : "";
  const totalChunks = Number(body.totalChunks);
  const expectedSize = Number(body.expectedSize);
  if (!sessionPattern.test(sessionId) || !originalFilename.toLowerCase().endsWith(".zip")) {
    return Response.json({ error: "Invalid character upload" }, { status: 400 });
  }
  if (!Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > MAX_CHUNKS || !Number.isInteger(expectedSize) || expectedSize < 1 || expectedSize > MAX_ARCHIVE_BYTES) {
    return Response.json({ error: "Invalid character upload size" }, { status: 400 });
  }

  const bucket = getCharacterBucket();
  const receiptKey = `character-uploads/${sessionId}/complete.json`;
  const receipt = await bucket.get(receiptKey);
  if (receipt) {
    const saved = JSON.parse(new TextDecoder().decode(await receipt.arrayBuffer())) as { importedCharacterId: string };
    return Response.json({ ...(await readWorkforce()), importedCharacterId: saved.importedCharacterId });
  }

  const keys = Array.from({ length: totalChunks }, (_, index) => chunkKey(sessionId, index));
  const chunks = await Promise.all(keys.map((key) => bucket.get(key)));
  if (chunks.some((chunk) => !chunk)) return Response.json({ error: "One or more upload chunks are missing; try the import again" }, { status: 409 });
  const actualSize = chunks.reduce((sum, chunk) => sum + (chunk?.size ?? 0), 0);
  if (actualSize !== expectedSize || actualSize > MAX_ARCHIVE_BYTES) return Response.json({ error: "The uploaded ZIP size did not match" }, { status: 400 });

  const archiveBytes = new Uint8Array(actualSize);
  let offset = 0;
  for (const chunk of chunks) {
    const bytes = new Uint8Array(await chunk!.arrayBuffer());
    archiveBytes.set(bytes, offset);
    offset += bytes.length;
  }

  const character = unpackCharacterZip(archiveBytes);
  const d1 = env.DB;
  const existing = await d1.prepare("SELECT spritesheet_path AS spritesheetPath FROM character_packs WHERE id = ?")
    .bind(character.id).first<{ spritesheetPath: string | null }>();
  if (existing?.spritesheetPath && !existing.spritesheetPath.startsWith("/api/characters/asset?")) {
    return Response.json({ error: "A built-in character already uses this id and cannot be overwritten" }, { status: 409 });
  }

  const digest = await sha256Hex(character.spriteBytes);
  const keyRoot = `characters/${character.id}/${digest}`;
  const spriteKey = `${keyRoot}/${character.spriteFilename}`;
  const spritesheetPath = `/api/characters/asset?key=${encodeURIComponent(spriteKey)}`;
  const metadata = { characterId: character.id, originalFilename };

  await Promise.all([
    bucket.put(`${keyRoot}/pet.json`, character.manifestBytes, { httpMetadata: { contentType: "application/json" }, customMetadata: metadata }),
    bucket.put(spriteKey, character.spriteBytes, { httpMetadata: { contentType: character.spriteContentType }, customMetadata: metadata }),
    bucket.put(`${keyRoot}/package.zip`, character.archiveBytes, { httpMetadata: { contentType: "application/zip" }, customMetadata: metadata }),
  ]);

  await d1.batch([
    d1.prepare(`INSERT INTO character_packs (
      id, display_name, description, source_url, install_command, spritesheet_path,
      sprite_version, cache_status, cached_at, updated_at
    ) VALUES (?, ?, ?, ?, NULL, ?, ?, 'cached', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      display_name = excluded.display_name,
      description = excluded.description,
      source_url = excluded.source_url,
      spritesheet_path = excluded.spritesheet_path,
      sprite_version = excluded.sprite_version,
      cache_status = 'cached',
      cached_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP`)
      .bind(character.id, character.displayName, character.description, `upload://${originalFilename}`, spritesheetPath, character.spriteVersion),
    d1.prepare("INSERT INTO activity (message, tone) VALUES (?, 'success')")
      .bind(`${character.displayName} was imported from a character ZIP.`),
  ]);

  const receiptBytes = new TextEncoder().encode(JSON.stringify({ importedCharacterId: character.id }));
  await bucket.put(receiptKey, receiptBytes, { httpMetadata: { contentType: "application/json" } });
  await bucket.delete(keys).catch(() => undefined);
  return Response.json({ ...(await readWorkforce()), importedCharacterId: character.id });
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const url = new URL(request.url);
    const phase = url.searchParams.get("phase");
    if (phase === "chunk") return await receiveChunk(request, url);
    if (phase === "complete") return await completeUpload(request);
    return Response.json({ error: "Unknown character upload phase" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Character import failed";
    const status = /unavailable/i.test(message) ? 503 : 400;
    return Response.json({ error: message }, { status });
  }
}
