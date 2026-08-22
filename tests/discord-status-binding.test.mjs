import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildLocalBindingVars } from "../lib/local-binding-vars.ts";

test("forwards a validated Discord status token into the local Worker bindings", () => {
  const discordStatusToken = "A".repeat(43);
  const ownerSessionVerifier = "a".repeat(64);
  assert.deepEqual(buildLocalBindingVars({
    RUNTIME_BRIDGE_TOKEN: "runtime-bridge",
    OWNER_SESSION_VERIFIER: ` ${ownerSessionVerifier} `,
    SOURCE_COMMIT: "abc1234",
    DISCORD_STATUS_TOKEN: `  ${discordStatusToken}  `,
  }), {
    RUNTIME_BRIDGE_TOKEN: "runtime-bridge",
    OWNER_SESSION_VERIFIER: ownerSessionVerifier,
    SOURCE_COMMIT: "abc1234",
    DISCORD_STATUS_TOKEN: discordStatusToken,
  });
});

test("forwards only a validated one-way owner verifier", () => {
  const ownerSessionVerifier = "a".repeat(64);
  assert.equal(buildLocalBindingVars({ OWNER_SESSION_VERIFIER: ownerSessionVerifier }).OWNER_SESSION_VERIFIER, ownerSessionVerifier);
  for (const value of [undefined, "", "short", "a".repeat(63), "a".repeat(65), "A".repeat(64), `${"a".repeat(63)}!`]) {
    assert.equal(Object.hasOwn(buildLocalBindingVars({ OWNER_SESSION_VERIFIER: value }), "OWNER_SESSION_VERIFIER"), false);
  }
  const rawCredential = "O".repeat(43);
  const bindings = buildLocalBindingVars({ OWNER_SESSION_CREDENTIAL: rawCredential });
  assert.equal(Object.hasOwn(bindings, "OWNER_SESSION_CREDENTIAL"), false);
  assert.equal(Object.values(bindings).includes(rawCredential), false);
});

test("omits absent or malformed Discord status credentials so the route fails closed", () => {
  for (const value of [
    undefined,
    "",
    "short",
    "A".repeat(42),
    "A".repeat(129),
    `${"A".repeat(42)}!`,
  ]) {
    const bindings = buildLocalBindingVars({
      RUNTIME_BRIDGE_TOKEN: "runtime-bridge",
      SOURCE_COMMIT: "abc1234",
      DISCORD_STATUS_TOKEN: value,
    });
    assert.equal(Object.hasOwn(bindings, "DISCORD_STATUS_TOKEN"), false);
    assert.equal(bindings.RUNTIME_BRIDGE_TOKEN, "runtime-bridge");
    assert.equal(bindings.SOURCE_COMMIT, "abc1234");
  }
});

test("the live Vite binding and status route share the fail-closed contract", async () => {
  const [viteConfig, statusRoute] = await Promise.all([
    readFile(new URL("../vite.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/integrations/discord/status/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(viteConfig, /vars: buildLocalBindingVars\(process\.env\)/);
  assert.match(statusRoute, /bindings\.DISCORD_STATUS_TOKEN\?\.trim\(\)/);
  assert.match(statusRoute, /\^\[A-Za-z0-9_-\]\{43,128\}\$/);
  assert.match(statusRoute, /authorization === null[\s\S]*503/);
  assert.doesNotMatch(statusRoute, /RUNTIME_BRIDGE_TOKEN/);
});
