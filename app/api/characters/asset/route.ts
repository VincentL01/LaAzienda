import { env } from "cloudflare:workers";
import { ensureDatabase } from "@/db/ensure";

interface CharacterObject {
  body: ReadableStream;
  size: number;
  httpEtag?: string;
  httpMetadata?: { contentType?: string };
}

interface CharacterBucket {
  get(key: string): Promise<CharacterObject | null>;
}

const objectKeyPattern = /^characters\/[a-z0-9][a-z0-9-]{1,62}[a-z0-9]\/[a-f0-9]{64}\/spritesheet\.(webp|png)$/;

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const key = new URL(request.url).searchParams.get("key") ?? "";
    if (!objectKeyPattern.test(key)) return new Response("Character not found", { status: 404 });

    const publicPath = `/api/characters/asset?key=${encodeURIComponent(key)}`;
    const character = await env.DB.prepare("SELECT id FROM character_packs WHERE spritesheet_path = ? AND cache_status = 'cached'")
      .bind(publicPath).first();
    if (!character) return new Response("Character not found", { status: 404 });

    const bucket = (env as unknown as { CHARACTERS?: CharacterBucket }).CHARACTERS;
    if (!bucket) return new Response("Character storage is unavailable", { status: 503 });
    const object = await bucket.get(key);
    if (!object) return new Response("Character not found", { status: 404 });

    const headers = new Headers({
      "content-type": object.httpMetadata?.contentType ?? (key.endsWith(".webp") ? "image/webp" : "image/png"),
      "content-length": String(object.size),
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    });
    if (object.httpEtag) headers.set("etag", object.httpEtag);
    return new Response(object.body, { headers });
  } catch {
    return new Response("Character unavailable", { status: 500 });
  }
}
