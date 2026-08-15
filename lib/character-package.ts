import { unzipSync } from "fflate";

const MAX_ARCHIVE_BYTES = 12 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 14 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 32 * 1024;
const MAX_SPRITESHEET_BYTES = 12 * 1024 * 1024;
const petIdPattern = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

export interface ImportedCharacterPackage {
  id: string;
  displayName: string;
  description: string;
  spriteVersion: 1 | 2;
  spriteFilename: "spritesheet.webp" | "spritesheet.png";
  spriteContentType: "image/webp" | "image/png";
  manifestBytes: Uint8Array;
  spriteBytes: Uint8Array;
  archiveBytes: Uint8Array;
}

function readUint24LE(data: Uint8Array, offset: number) {
  return data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16);
}

function bytesEqual(data: Uint8Array, offset: number, expected: number[]) {
  return expected.every((value, index) => data[offset + index] === value);
}

function readPngSize(data: Uint8Array) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (data.length < 24 || !bytesEqual(data, 0, signature) || !bytesEqual(data, 12, [73, 72, 68, 82])) {
    throw new Error("The PNG spritesheet header is invalid");
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function readWebpSize(data: Uint8Array) {
  if (data.length < 30 || !bytesEqual(data, 0, [82, 73, 70, 70]) || !bytesEqual(data, 8, [87, 69, 66, 80])) {
    throw new Error("The WebP spritesheet header is invalid");
  }

  let offset = 12;
  while (offset + 8 <= data.length) {
    const type = String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
    const view = new DataView(data.buffer, data.byteOffset + offset + 4, 4);
    const chunkSize = view.getUint32(0, true);
    const body = offset + 8;
    if (body + chunkSize > data.length) throw new Error("The WebP spritesheet is truncated");

    if (type === "VP8X" && chunkSize >= 10) {
      return { width: readUint24LE(data, body + 4) + 1, height: readUint24LE(data, body + 7) + 1 };
    }
    if (type === "VP8 " && chunkSize >= 10 && bytesEqual(data, body + 3, [157, 1, 42])) {
      return {
        width: (data[body + 6] | (data[body + 7] << 8)) & 0x3fff,
        height: (data[body + 8] | (data[body + 9] << 8)) & 0x3fff,
      };
    }
    if (type === "VP8L" && chunkSize >= 5 && data[body] === 47) {
      return {
        width: 1 + data[body + 1] + ((data[body + 2] & 0x3f) << 8),
        height: 1 + ((data[body + 2] & 0xc0) >> 6) + (data[body + 3] << 2) + ((data[body + 4] & 0x0f) << 10),
      };
    }
    offset = body + chunkSize + (chunkSize % 2);
  }
  throw new Error("The WebP spritesheet dimensions could not be read");
}

function parseManifest(bytes: Uint8Array) {
  if (bytes.length > MAX_MANIFEST_BYTES) throw new Error("pet.json is too large");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("pet.json must be valid UTF-8 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("pet.json must contain an object");
  return value as Record<string, unknown>;
}

export function unpackCharacterZip(archiveBytes: Uint8Array): ImportedCharacterPackage {
  if (!archiveBytes.length || archiveBytes.length > MAX_ARCHIVE_BYTES) {
    throw new Error("Character ZIP files must be smaller than 12 MB");
  }

  const entryNames = new Set<string>();
  let expandedBytes = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(archiveBytes, {
      filter(entry) {
        if (entry.name.includes("\\") || entry.name.includes("/") || entry.name.includes("..")) {
          throw new Error("Character files must be at the ZIP root");
        }
        if (!new Set(["pet.json", "spritesheet.webp", "spritesheet.png"]).has(entry.name)) {
          throw new Error(`Unexpected file in character ZIP: ${entry.name}`);
        }
        if (entryNames.has(entry.name)) throw new Error(`Duplicate file in character ZIP: ${entry.name}`);
        entryNames.add(entry.name);
        expandedBytes += entry.originalSize;
        if (expandedBytes > MAX_EXPANDED_BYTES || entry.originalSize > MAX_SPRITESHEET_BYTES) {
          throw new Error("The expanded character package is too large");
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message) throw error;
    throw new Error("The selected file is not a readable ZIP package");
  }

  const manifestBytes = files["pet.json"];
  const webp = files["spritesheet.webp"];
  const png = files["spritesheet.png"];
  if (!manifestBytes || (!webp && !png) || (webp && png)) {
    throw new Error("The ZIP must contain pet.json and exactly one spritesheet.webp or spritesheet.png");
  }

  const manifest = parseManifest(manifestBytes);
  const id = typeof manifest.id === "string" ? manifest.id.trim() : "";
  const displayName = typeof manifest.displayName === "string" ? manifest.displayName.trim() : "";
  const description = typeof manifest.description === "string" ? manifest.description.trim().slice(0, 500) : "";
  const spriteVersion = manifest.spriteVersionNumber === 2 ? 2 : 1;
  const spriteFilename = webp ? "spritesheet.webp" : "spritesheet.png";
  const spriteBytes = (webp ?? png)!;

  if (!petIdPattern.test(id)) throw new Error("pet.json needs a lowercase hyphenated id");
  if (!displayName || displayName.length > 80) throw new Error("pet.json needs a displayName of 80 characters or fewer");
  if (manifest.spritesheetPath !== spriteFilename) throw new Error(`pet.json spritesheetPath must be ${spriteFilename}`);
  if (manifest.spriteVersionNumber !== undefined && ![1, 2].includes(Number(manifest.spriteVersionNumber))) {
    throw new Error("spriteVersionNumber must be 1 or 2");
  }

  const dimensions = webp ? readWebpSize(spriteBytes) : readPngSize(spriteBytes);
  const expectedHeight = spriteVersion === 2 ? 2288 : 1872;
  if (dimensions.width !== 1536 || dimensions.height !== expectedHeight) {
    throw new Error(`Codex Pet v${spriteVersion} spritesheets must be 1536 x ${expectedHeight} pixels`);
  }

  return {
    id,
    displayName,
    description,
    spriteVersion,
    spriteFilename,
    spriteContentType: webp ? "image/webp" : "image/png",
    manifestBytes,
    spriteBytes,
    archiveBytes,
  };
}

export async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
