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
  const publicPayload = watcher.slice(watcher.indexOf("function Get-IncidentIssueDocument"), watcher.indexOf("function Get-VerifiedIssue"));

  assert.doesNotMatch(publicPayload, /Incident\.(?:summary|evidence|employeeName|taskTitle|firstSeenAt)/);
  assert.match(publicPayload, /Get-PublicRoute/);
  assert.match(publicPayload, /public issue contains only allowlisted operational metadata/i);
});

test("accepts only owner-authored incident issues with the allowlisted document shape", { skip: process.platform !== "win32" }, async () => {
  const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const watcher = await readFile(new URL("../runtime/Watch-SystemIncidents.ps1", import.meta.url), "utf8");
  const validator = watcher.slice(watcher.indexOf("function Test-IncidentIssue"), watcher.indexOf("function Find-ExistingIssue"));
  const search = watcher.slice(watcher.indexOf("function Find-ExistingIssue"), watcher.indexOf("function Get-IncidentIssueDocument"));
  const create = watcher.slice(watcher.indexOf("function New-IncidentIssue"), watcher.indexOf("function Get-VerifiedIssue"));
  const readBack = watcher.slice(watcher.indexOf("function Get-VerifiedIssue"), watcher.indexOf("function Get-ResponseHeaderValue"));
  const command = [
    "$githubOwner = 'VincentL01'",
    validator,
    "$marker = '<!-- laazienda-system-incident:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->'",
    "$title = '[Portal bug aaaaaaaa] GET /api/company'",
    "$body = @($marker, '', '## Automated Company Portal incident', '', 'A deterministic portal failure was observed while a Codex employee run was active.', '', '- Category: ``api_5xx``', '- Request: ``GET /api/company``', '- HTTP status: ``500``', '- Employee record: ``employee-codex-1``', '- Run: ``run-12345678``', '- Task: ``task-123``', '- Portal commit: ``abcdef0``', '- Occurrences before filing: ``1``', '', '## Diagnostic boundary', '', 'The public issue contains only allowlisted operational metadata. Diagnostic text remains in the machine-local D1 run timeline for CEO review.') -join \"`n\"",
    "$spoofed = [pscustomobject]@{ title = $title; body = $body; user = [pscustomobject]@{ login = 'marker-spoofer' } }",
    "$owned = [pscustomobject]@{ title = $title; body = $body; user = [pscustomobject]@{ login = 'VincentL01' } }",
    "Write-Output (Test-IncidentIssue $spoofed $title $marker)",
    "Write-Output (Test-IncidentIssue $owned $title $marker)",
  ].join("\n");
  const results = execFileSync(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], { encoding: "utf8" })
    .trim().split(/\r?\n/);

  assert.deepEqual(results, ["False", "True"]);
  assert.match(watcher, /\$githubOwner = "VincentL01"/);
  assert.match(search, /Test-IncidentIssue \$item/);
  assert.match(create, /Test-IncidentIssue \$created/);
  assert.match(readBack, /Test-IncidentIssue \$verified/g);
});

test("blocks deterministic GitHub failures atomically while transient failures retain backoff", async () => {
  const route = await readFile(new URL("../app/api/system-incidents/route.ts", import.meta.url), "utf8");
  const failureHandler = route.slice(route.indexOf("async function failIncident"), route.indexOf("async function requeueBlockedIncidents"));
  const terminalBranch = failureHandler.slice(failureHandler.indexOf("const terminalFailure"), failureHandler.indexOf("const incident ="));
  const transientBranch = failureHandler.slice(failureHandler.indexOf("const incident ="));

  assert.match(terminalBranch, /failureCode === "permission_denied" \|\| failureCode === "issues_disabled"/);
  assert.match(terminalBranch, /UPDATE system_incidents SET status = 'blocked', next_attempt_at = NULL/);
  assert.match(terminalBranch, /WHERE id = \? AND status = 'filing' AND lease_owner = \? AND lease_token = \?/);
  assert.match(terminalBranch, /Response\.json\(\{ ok: true, retry: false \}\)/);
  assert.doesNotMatch(terminalBranch, /status = 'pending'|Date\.now/);

  assert.match(transientBranch, /UPDATE system_incidents SET status = 'pending', next_attempt_at = \?/);
  assert.match(transientBranch, /Date\.now\(\)/);
  assert.match(transientBranch, /Response\.json\(\{ ok: true, retry: true \}\)/);
  assert.match(route, /requeueBlockedIncidents[\s\S]*WHERE status = 'blocked'/);
});

test("live incident watcher requeues blocked rows only after a changed credential is validated", async () => {
  const watcher = await readFile(new URL("../runtime/Watch-SystemIncidents.ps1", import.meta.url), "utf8");
  const credentialRefresh = watcher.slice(watcher.indexOf("function Update-GitHubCredential"), watcher.indexOf("function Write-WatcherLog"));
  const delivery = watcher.slice(watcher.indexOf("function Invoke-IncidentDelivery"), watcher.indexOf("$createdNew ="));

  assert.match(credentialRefresh, /SHA256.*ComputeHash/s);
  assert.match(credentialRefresh, /\$githubApi\/user/);
  assert.match(credentialRefresh, /identity\.login -cne "VincentL01"/);
  assert.match(credentialRefresh, /fingerprint -eq \$script:githubCredentialFingerprint/);
  assert.match(watcher, /system-incident-github-credential\.sha256/);
  assert.match(watcher, /acknowledgedGithubCredentialFingerprint = if \(Test-Path[\s\S]*\^\[a-f0-9\]\{64\}\$/);
  assert.match(watcher, /function Save-AcknowledgedGitHubCredentialFingerprint[\s\S]*File\]::Replace/);
  assert.match(delivery, /acknowledgedGithubCredentialFingerprint -ne \$script:githubCredentialFingerprint[\s\S]*requeueBlocked[\s\S]*Save-AcknowledgedGitHubCredentialFingerprint[\s\S]*acknowledgedGithubCredentialFingerprint = \$script:githubCredentialFingerprint/);
  assert.ok(delivery.indexOf("requeueBlocked") < delivery.indexOf("Save-AcknowledgedGitHubCredentialFingerprint"));
  assert.doesNotMatch(watcher, /Write-WatcherLog[^\r\n]*(?:token|fingerprint)/i);
});
