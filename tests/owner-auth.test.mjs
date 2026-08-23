import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  OWNER_CREDENTIAL_BODY_MAX_BYTES,
  OWNER_SESSION_COOKIE_NAME,
  clearOwnerSession,
  deriveOwnerSessionTokenHash,
  deriveOwnerVerifier,
  ownerAuthorizationStatus,
  ownerAuthorized,
  readOwnerCredential,
  setOwnerSession,
  verifyOwnerCredential,
} from "../lib/server/owner-auth.ts";

const ownerCredential = "owner-session-credential-independent-1234567890_A";
const runtimeToken = "runtime-bridge-token-is-different-1234567890_B";
const otherOwnerCredential = "other-owner-credential-independent-123456789012_B";

function ownerDatabase(createSchema = true) {
  const sqlite = new DatabaseSync(":memory:");
  if (createSchema) {
    sqlite.exec(`CREATE TABLE owner_sessions (
      token_hash TEXT PRIMARY KEY,
      owner_verifier TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ); CREATE INDEX idx_owner_sessions_expiry ON owner_sessions(expires_at);`);
  }
  function statement(query, values = []) {
    return {
      bind(...nextValues) { return statement(query, nextValues); },
      async first() { return sqlite.prepare(query).get(...values) ?? null; },
      async run() {
        const result = sqlite.prepare(query).run(...values);
        return { meta: { changes: Number(result.changes) } };
      },
    };
  }
  const d1 = {
    prepare(query) { return statement(query); },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const prepared of statements) results.push(await prepared.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { sqlite, d1 };
}

function cookieToken(response) {
  const cookie = response.headers.get("set-cookie") ?? "";
  return cookie.match(new RegExp(`^${OWNER_SESSION_COOKIE_NAME}=([^;]+)`))?.[1] ?? "";
}

test("owner verifier is domain-separated, exact, and independent from the runtime bridge", async () => {
  const verifier = await deriveOwnerVerifier(ownerCredential);
  const expected = createHash("sha256").update(`laazienda:owner-credential:v1\0${ownerCredential}`).digest("hex");
  assert.equal(verifier, expected);
  assert.equal(verifier?.length, 64);
  assert.notEqual(verifier, ownerCredential);
  assert.notEqual(ownerCredential, runtimeToken);
  assert.equal(await verifyOwnerCredential(ownerCredential, verifier), true);
  assert.equal(await verifyOwnerCredential(runtimeToken, verifier), false);
  assert.equal(await verifyOwnerCredential(ownerCredential.toUpperCase(), verifier), false);
  assert.equal(await verifyOwnerCredential(`${ownerCredential}0`, verifier), false);
  assert.equal(await verifyOwnerCredential(ownerCredential.slice(1), verifier), false);
});

test("the host bootstrap and Worker derive the same owner verifier", async (context) => {
  const startSource = await readFile(new URL("../runtime/Start-Company.ps1", import.meta.url), "utf8");
  const functionSource = startSource.match(/function Get-OwnerSessionVerifier\(\[string\]\$Credential\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(functionSource);
  const executable = process.platform === "win32" ? "powershell.exe" : "pwsh";
  const probe = spawnSync(executable, ["-NoProfile", "-NonInteractive", "-Command",
    `${functionSource}\nGet-OwnerSessionVerifier '${ownerCredential}'`], { encoding: "utf8" });
  if (probe.error?.code === "ENOENT") {
    context.skip("PowerShell is unavailable on this test host");
    return;
  }
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout.trim(), await deriveOwnerVerifier(ownerCredential));
});

test("unlock stores only a token hash and authorizes only the opaque unexpired session", async () => {
  const verifier = await deriveOwnerVerifier(ownerCredential);
  const { sqlite, d1 } = ownerDatabase();
  const response = Response.json({ authorized: true });
  assert.equal(await setOwnerSession(response, new Request("http://localhost:3002/training"), ownerCredential, verifier, d1), true);
  const token = cookieToken(response);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(token, ownerCredential);
  assert.notEqual(token, verifier);

  const row = sqlite.prepare("SELECT token_hash AS tokenHash, owner_verifier AS verifier, expires_at AS expiresAt FROM owner_sessions").get();
  assert.equal(row.tokenHash, await deriveOwnerSessionTokenHash(token));
  assert.equal(row.verifier, verifier);
  assert.notEqual(row.tokenHash, token);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM owner_sessions WHERE expires_at > CURRENT_TIMESTAMP").get().count, 1);

  const request = new Request("http://localhost:3002/training", {
    headers: { cookie: `${OWNER_SESSION_COOKIE_NAME}=${token}` },
  });
  assert.equal(await ownerAuthorizationStatus(request, verifier, d1), "authorized");
  assert.equal(await ownerAuthorized(request, verifier, d1), true);
  assert.equal(await ownerAuthorized(request, null, d1), false);
  assert.equal(await ownerAuthorized(new Request("http://localhost:3002/training"), verifier, d1), false);
  assert.equal(await ownerAuthorized(new Request("http://localhost:3002/training", {
    headers: { cookie: `${OWNER_SESSION_COOKIE_NAME}=${"x".repeat(43)}` },
  }), verifier, d1), false);
});

test("expiry, verifier rotation, and logout revoke durable sessions", async () => {
  const verifier = await deriveOwnerVerifier(ownerCredential);
  const rotatedVerifier = await deriveOwnerVerifier(otherOwnerCredential);
  const { sqlite, d1 } = ownerDatabase();

  const firstResponse = Response.json({ authorized: true });
  await setOwnerSession(firstResponse, new Request("http://localhost:3002/training"), ownerCredential, verifier, d1);
  const firstToken = cookieToken(firstResponse);
  const firstRequest = new Request("http://localhost:3002/training", {
    headers: { cookie: `${OWNER_SESSION_COOKIE_NAME}=${firstToken}` },
  });
  sqlite.prepare("UPDATE owner_sessions SET expires_at = datetime(CURRENT_TIMESTAMP, '-1 second')").run();
  assert.equal(await ownerAuthorized(firstRequest, verifier, d1), false, "server time, not cookie Max-Age, enforces expiry");

  const secondResponse = Response.json({ authorized: true });
  await setOwnerSession(secondResponse, new Request("http://localhost:3002/training"), ownerCredential, verifier, d1);
  const secondToken = cookieToken(secondResponse);
  const secondRequest = new Request("http://localhost:3002/training", {
    headers: { cookie: `${OWNER_SESSION_COOKIE_NAME}=${secondToken}` },
  });
  assert.equal(await ownerAuthorized(secondRequest, rotatedVerifier, d1), false, "credential rotation invalidates prior sessions");

  const clearedResponse = Response.json({ authorized: false });
  assert.equal(await clearOwnerSession(clearedResponse, secondRequest, d1), true);
  assert.match(clearedResponse.headers.get("set-cookie") ?? "", new RegExp(`^${OWNER_SESSION_COOKIE_NAME}=;`));
  assert.match(clearedResponse.headers.get("set-cookie") ?? "", /Max-Age=0/);
  assert.equal(await ownerAuthorized(secondRequest, verifier, d1), false, "a copied cookie cannot replay after logout");
});

test("logout keeps the cookie when durable revocation cannot be proven", async () => {
  const request = new Request("http://localhost:3002/training", {
    headers: { cookie: `${OWNER_SESSION_COOKIE_NAME}=${"x".repeat(43)}` },
  });
  const unavailableDatabase = {
    prepare() { throw new Error("D1 unavailable"); },
    async batch() { throw new Error("D1 unavailable"); },
  };
  const response = Response.json({ authorized: false });
  assert.equal(await clearOwnerSession(response, request, unavailableDatabase), false);
  assert.equal(response.headers.has("set-cookie"), false);
});

test("missing session schema fails closed and rejected credentials never touch D1", async () => {
  const verifier = await deriveOwnerVerifier(ownerCredential);
  const missing = ownerDatabase(false).d1;
  const fakeTokenRequest = new Request("http://localhost:3002/training", {
    headers: { cookie: `${OWNER_SESSION_COOKIE_NAME}=${"x".repeat(43)}` },
  });
  assert.equal(await ownerAuthorizationStatus(fakeTokenRequest, verifier, missing), "unavailable");
  assert.equal(await ownerAuthorized(fakeTokenRequest, verifier, missing), false);

  let databaseTouched = false;
  const throwingDatabase = {
    prepare() { databaseTouched = true; throw new Error("must not touch D1"); },
    async batch() { databaseTouched = true; throw new Error("must not touch D1"); },
  };
  const response = Response.json({ authorized: false });
  assert.equal(await setOwnerSession(response, new Request("http://localhost:3002/training"), runtimeToken, verifier, throwingDatabase), false);
  assert.equal(databaseTouched, false);
  assert.equal(response.headers.has("set-cookie"), false);
});

test("owner session status distinguishes confirmed rejection from verification failure", async () => {
  const verifier = await deriveOwnerVerifier(ownerCredential);
  const { d1 } = ownerDatabase();
  const unknownSession = new Request("http://localhost:3002/training", {
    headers: { cookie: `${OWNER_SESSION_COOKIE_NAME}=${"x".repeat(43)}` },
  });
  assert.equal(await ownerAuthorizationStatus(new Request("http://localhost:3002/training"), verifier, d1), "unauthorized");
  assert.equal(await ownerAuthorizationStatus(unknownSession, verifier, d1), "unauthorized");
  assert.equal(await ownerAuthorizationStatus(unknownSession, null, d1), "unavailable");

  const unavailableDatabase = {
    prepare() { throw new Error("D1 unavailable"); },
    async batch() { throw new Error("D1 unavailable"); },
  };
  assert.equal(await ownerAuthorizationStatus(unknownSession, verifier, unavailableDatabase), "unavailable");
  assert.equal(await ownerAuthorized(unknownSession, verifier, unavailableDatabase), false);
});

test("session cookie is strict, HttpOnly, and carries only the opaque token", async () => {
  const verifier = await deriveOwnerVerifier(ownerCredential);
  const { d1 } = ownerDatabase();
  const localResponse = Response.json({ authorized: true });
  assert.equal(await setOwnerSession(localResponse, new Request("http://localhost:3002/training"), ownerCredential, verifier, d1), true);
  const localCookie = localResponse.headers.get("set-cookie") ?? "";
  assert.doesNotMatch(localCookie, new RegExp(ownerCredential));
  assert.doesNotMatch(localCookie, new RegExp(verifier));
  assert.match(localCookie, /HttpOnly/);
  assert.match(localCookie, /SameSite=Strict/);
  assert.match(localCookie, /Path=\//);
  assert.match(localCookie, /Max-Age=28800/);
  assert.doesNotMatch(localCookie, /; Secure/);

  const secureResponse = Response.json({ authorized: true });
  assert.equal(await setOwnerSession(secureResponse, new Request("https://company.example/training"), ownerCredential, verifier, d1), true);
  assert.match(secureResponse.headers.get("set-cookie") ?? "", /; Secure/);
});

test("credential JSON is bounded and has one exact field", async () => {
  const valid = await readOwnerCredential(new Request("http://localhost:3002/api/owner-session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential: ownerCredential }),
  }));
  assert.deepEqual(valid, { ok: true, credential: ownerCredential });

  const oversized = await readOwnerCredential(new Request("http://localhost:3002/api/owner-session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential: "x".repeat(OWNER_CREDENTIAL_BODY_MAX_BYTES) }),
  }));
  assert.deepEqual(oversized, { ok: false, status: 413 });

  const extraField = await readOwnerCredential(new Request("http://localhost:3002/api/owner-session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential: ownerCredential, token: runtimeToken }),
  }));
  assert.deepEqual(extraField, { ok: false, status: 400 });
});

test("locked Training Room exposes a visible keyboard-usable credential control", async () => {
  const [trainingUi, trainingStyles, globalStyles] = await Promise.all([
    readFile(new URL("../app/components/TrainingCenter.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/training-records.css", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(trainingUi, /htmlFor="owner-credential"/);
  assert.match(trainingUi, /id="owner-credential"[\s\S]*type="password"[\s\S]*placeholder="Paste the copied credential"/);
  assert.match(trainingUi, /aria-describedby="owner-credential-help"/);
  assert.match(trainingUi, /type="submit"[\s\S]*disabled=\{busy === "unlock-owner" \|\| !credential\}/);
  const errorBranch = trainingUi.indexOf("if (!training && error)");
  const lockedBranch = trainingUi.indexOf("if (!training && locked)");
  assert.notEqual(errorBranch, -1);
  assert.notEqual(lockedBranch, -1);
  assert.ok(errorBranch < lockedBranch);
  assert.match(trainingUi, /setTraining\(null\);[\s\S]*setLocked\(false\);[\s\S]*setError/);
  assert.match(trainingUi, /The Training Center is unavailable\./);
  assert.match(trainingStyles, /\.owner-unlock label \{[\s\S]*display: grid;[\s\S]*gap: \.45rem;/);
  assert.match(trainingStyles, /\.owner-unlock input \{[\s\S]*width: 100%;[\s\S]*min-height: 44px;[\s\S]*border: 2px solid #766d60;[\s\S]*background: #1c1814;/);
  assert.match(trainingStyles, /\.owner-unlock input::placeholder \{ color: #8d8372; \}/);
  assert.match(trainingStyles, /@media \(max-width: 850px\) \{[\s\S]*\.owner-unlock button \{ width: 100%; \}/);
  assert.match(globalStyles, /@import "\.\/training-records\.css"/);
});

test("portal receives only the verifier and owner login verifies before schema initialization", async () => {
  const [routeSource, scriptSource, startSource, bridgeSource, reconcileSource, ownerAuthSource, schemaSource, ensureSource, migrationSource, priorMigration] = await Promise.all([
    readFile(new URL("../app/api/owner-session/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../runtime/Copy-CompanyOwnerCredential.ps1", import.meta.url), "utf8"),
    readFile(new URL("../runtime/Start-Company.ps1", import.meta.url), "utf8"),
    readFile(new URL("../runtime/bridge.ps1", import.meta.url), "utf8"),
    readFile(new URL("../runtime/hrm/reconcile.sh", import.meta.url), "utf8"),
    readFile(new URL("../lib/server/owner-auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/ensure.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0013_silly_cloak.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0012_common_gideon.sql", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(routeSource, /console\.|searchParams|[?&](?:credential|token)=/i);
  const get = routeSource.slice(routeSource.indexOf("export async function GET"), routeSource.indexOf("export async function POST"));
  assert.match(get, /ownerAuthorizationStatus\(request\)/);
  assert.match(get, /status === "unavailable"[\s\S]*authorized: null[\s\S]*status: 503/);
  assert.match(get, /authorized: status === "authorized"/);
  const post = routeSource.slice(routeSource.indexOf("export async function POST"), routeSource.indexOf("export async function DELETE"));
  assert.ok(post.indexOf("verifyOwnerCredential") < post.indexOf("ensureDatabase"));
  assert.match(post, /if \(!\(await verifyOwnerCredential\(input\.credential\)\)\)[\s\S]*status: 403/);
  assert.match(schemaSource, /ownerSessions = sqliteTable/);
  assert.match(ensureSource, /CREATE TABLE IF NOT EXISTS owner_sessions/);
  assert.match(migrationSource, /CREATE TABLE `owner_sessions`/);
  const upgraded = new DatabaseSync(":memory:");
  upgraded.exec(priorMigration);
  upgraded.exec(migrationSource);
  assert.equal(upgraded.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('owner_sessions')").get().count, 4);
  assert.equal(upgraded.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('character_upload_sessions') WHERE name LIKE 'pending_%' OR name = 'cleanup_claimed_at'").get().count, 4);

  assert.match(scriptSource, /assets\/owner\/runtime\/credential/);
  assert.match(scriptSource, /Set-Clipboard -Value \$credential/);
  assert.doesNotMatch(scriptSource, /runtime-bridge-token|bridgeToken|ceo-training:v1/i);
  assert.doesNotMatch(scriptSource, /Write-(?:Output|Host)[^\r\n]*\$(?:credential|bridgeToken)/i);

  const portalCreate = startSource.match(/docker create --name \$portalContainer([\s\S]*?)\$portalImage \| Out-Null/)?.[1] ?? "";
  const hrmBootstrap = startSource.match(/& \(Join-Path \$PSScriptRoot "bridge\.ps1"\)([\s\S]*?)if \(\$LASTEXITCODE/)?.[1] ?? "";
  assert.match(startSource, /Get-OwnerSessionVerifier/);
  assert.match(portalCreate, /OWNER_SESSION_VERIFIER=\$ownerCredentialVerifier/);
  assert.doesNotMatch(portalCreate, /OWNER_SESSION_CREDENTIAL|=\$ownerCredential(?:\s|"|`)/);
  assert.doesNotMatch(ownerAuthSource, /OWNER_SESSION_CREDENTIAL|RUNTIME_BRIDGE_TOKEN/);
  assert.match(ownerAuthSource, /OWNER_SESSION_VERIFIER/);
  assert.match(ownerAuthSource, /owner_sessions[\s\S]*expires_at > CURRENT_TIMESTAMP/);
  assert.doesNotMatch(hrmBootstrap, /ownerCredential|ownerCredentialVerifier|OWNER_SESSION_VERIFIER|assets\\owner/);
  for (const source of [bridgeSource, reconcileSource]) {
    assert.doesNotMatch(source, /OWNER_SESSION_(?:CREDENTIAL|VERIFIER)|assets[\\/]owner[\\/]runtime|owner credential/i);
  }
});
