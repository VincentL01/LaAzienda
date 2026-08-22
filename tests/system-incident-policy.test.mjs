import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  fingerprintIncident,
  incidentFingerprintMaterial,
  isReportablePortalResponse,
  sanitizeIncidentText,
  systemIncidentMarker,
} from "../lib/system-incident-policy.ts";
import {
  incidentRunEventMessage,
  recordSystemIncident,
  shouldRequeueIncidentForBuild,
} from "../lib/server/system-incidents.ts";

test("redacts credentials and local paths from incident evidence", () => {
  const sanitized = sanitizeIncidentText(
    "Bearer secret-value ghp_abcdefghijklmnopqrstuvwxyz sk-abcdefghijklmnop password=hunter2 {\"refresh_token\":\"private-session\"} at C:\\Users\\CEO\\source.ts",
  );

  assert.doesNotMatch(sanitized, /secret-value|ghp_|sk-|hunter2|private-session|CEO/i);
  assert.match(sanitized, /Bearer \[redacted\]|\[redacted\]/);
  assert.match(sanitized, /<local-path>/);
});

test("normalizes volatile run ids, timestamps, and source locations before fingerprinting", async () => {
  const first = {
    category: "api_5xx",
    method: "post",
    route: "https://company.test/api/executor?attempt=1",
    summary: "Run run-c273b194-11ac-4cc2-9c8b-71068481cf4d failed at worker.ts:41:9 on 2026-08-22T08:01:02Z",
  };
  const second = {
    ...first,
    route: "/api/executor?attempt=2",
    summary: "Run run-18faa536-5e2b-4c39-8167-a91148885d14 failed at worker.ts:99:3 on 2026-08-23T09:02:03Z",
  };

  assert.equal(incidentFingerprintMaterial(first), incidentFingerprintMaterial(second));
  assert.equal(await fingerprintIncident(first), await fingerprintIncident(second));
});

test("keeps one bug signature while requeuing a terminal incident on a new build", async () => {
  const observation = {
    category: "api_5xx",
    method: "GET",
    route: "/api/company",
    summary: "Database invariant failed",
  };
  const firstBuild = await fingerprintIncident({ ...observation, buildCommit: "a1b2c3d4" });
  const repeatInFirstBuild = await fingerprintIncident({ ...observation, buildCommit: "A1B2C3D4" });
  const fixedThenRegressedBuild = await fingerprintIncident({ ...observation, buildCommit: "e5f6a7b8" });

  assert.equal(firstBuild, repeatInFirstBuild);
  assert.equal(firstBuild, fixedThenRegressedBuild);
  assert.equal(shouldRequeueIncidentForBuild("filed", "a1b2c3d4", "a1b2c3d4"), false);
  assert.equal(shouldRequeueIncidentForBuild("filed", "a1b2c3d4", "e5f6a7b8"), true);
  assert.equal(shouldRequeueIncidentForBuild("pending", "a1b2c3d4", "e5f6a7b8"), false);
});

test("does not report a terminal repeat as pending delivery", () => {
  assert.match(incidentRunEventMessage("filed", 42), /issue #42 is already filed/);
  assert.doesNotMatch(incidentRunEventMessage("filed", 42), /pending/);
  assert.match(incidentRunEventMessage("pending", null), /pending/);
});

test("reports only first-party API server failures and excludes its own outbox endpoint", () => {
  assert.equal(isReportablePortalResponse("/api/executor", 500), true);
  assert.equal(isReportablePortalResponse("/api/company", 503), true);
  assert.equal(isReportablePortalResponse("/api/company", 400), false);
  assert.equal(isReportablePortalResponse("/employees", 500), false);
  assert.equal(isReportablePortalResponse("/api/system-incidents", 500), false);
});

test("builds a strict, deterministic GitHub issue marker", async () => {
  const fingerprint = await fingerprintIncident({
    category: "worker_exception",
    method: "GET",
    route: "/api/company",
    summary: "Unexpected invariant failure",
  });

  assert.equal(systemIncidentMarker(fingerprint), `<!-- laazienda-system-incident:v1:${fingerprint} -->`);
  assert.throws(() => systemIncidentMarker("not-a-fingerprint"), /Invalid system incident fingerprint/);
});

test("refuses to enqueue an incident without an active employee run", async () => {
  const statements = [];
  const d1 = {
    prepare(sql) {
      statements.push(sql);
      return {
        bind() { return this; },
        async first() { return null; },
      };
    },
  };

  const result = await recordSystemIncident(d1, {
    category: "api_5xx",
    route: "/api/company",
    method: "GET",
    httpStatus: 500,
    summary: "A deterministic failure",
    runId: "run-c273b194-11ac-4cc2-9c8b-71068481cf4d",
  });

  assert.equal(result, null);
  assert.equal(statements.length, 1);
  assert.doesNotMatch(statements.join("\n"), /INSERT|UPDATE|system_incidents/i);
});

test("distinguishes a GitHub 403 rate limit from a genuine permission denial", { skip: process.platform !== "win32" }, () => {
  const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const policy = new URL("../runtime/GitHubFailurePolicy.ps1", import.meta.url).pathname.slice(1).replaceAll("/", "\\");
  const invoke = (argumentsText) => execFileSync(
    powershell,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `. '${policy.replaceAll("'", "''")}'; Resolve-GitHubFailureCode ${argumentsText}`],
    { encoding: "utf8" },
  ).trim();

  assert.equal(invoke("-StatusCode 403 -RateLimitRemaining '0'"), "rate_limited");
  assert.equal(invoke("-StatusCode 403 -Detail 'Resource not accessible by personal access token'"), "permission_denied");
});

test("keeps public incident issues on an allowlisted metadata boundary", async () => {
  const watcher = await readFile(new URL("../runtime/Watch-SystemIncidents.ps1", import.meta.url), "utf8");
  const publicPayload = watcher.slice(watcher.indexOf("function New-IncidentIssue"), watcher.indexOf("function Get-VerifiedIssue"));

  assert.doesNotMatch(publicPayload, /Incident\.(?:summary|evidence|employeeName|taskTitle|firstSeenAt)/);
  assert.match(publicPayload, /Get-PublicRoute/);
  assert.match(publicPayload, /public issue contains only allowlisted operational metadata/i);
});
