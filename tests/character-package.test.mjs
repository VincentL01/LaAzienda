import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import { unpackCharacterZip } from "../lib/character-package.ts";
import { mapDockerStatus } from "../lib/company.ts";

function pngHeader(width, height) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function manifest(patch = {}) {
  return strToU8(JSON.stringify({
    id: "test-character",
    displayName: "Test Character",
    description: "A test Codex Pet package.",
    spritesheetPath: "spritesheet.png",
    ...patch,
  }));
}

test("accepts a root-level Codex Pet v1 package", () => {
  const archive = zipSync({ "pet.json": manifest(), "spritesheet.png": pngHeader(1536, 1872) });
  const character = unpackCharacterZip(archive);
  assert.equal(character.id, "test-character");
  assert.equal(character.spriteVersion, 1);
  assert.equal(character.spriteContentType, "image/png");
});

test("rejects traversal paths and incorrect atlas dimensions", () => {
  const traversal = zipSync({ "../pet.json": manifest(), "spritesheet.png": pngHeader(1536, 1872) });
  assert.throws(() => unpackCharacterZip(traversal), /ZIP root/);

  const wrongSize = zipSync({ "pet.json": manifest(), "spritesheet.png": pngHeader(512, 512) });
  assert.throws(() => unpackCharacterZip(wrongSize), /1536 x 1872/);
});

test("ships the fixed HRM, secretary, and contractor sprites as public runtime assets", async () => {
  await Promise.all(["aurelia-executive-04", "crimson-executive", "solaire"].map((id) =>
    access(new URL(`../public/characters/${id}/spritesheet.webp`, import.meta.url)),
  ));
});

test("keeps a running container's job blocker visible", () => {
  assert.equal(mapDockerStatus("running", "failed"), "failed");
  assert.equal(mapDockerStatus("running", "working"), "working");
});
