import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const fakeCredential = "A".repeat(43);

async function createCredentialFixture({ ignored = true } = {}) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "laazienda-owner-copy-"));
  const runtimeRoot = path.join(fixtureRoot, "runtime");
  const credentialRoot = path.join(fixtureRoot, "assets", "owner", "runtime");
  const fixtureScript = path.join(runtimeRoot, "Copy-CeoTrainingCredential.ps1");
  const fixturePathSafety = path.join(runtimeRoot, "Path-Safety.ps1");

  await mkdir(runtimeRoot, { recursive: true });
  await mkdir(credentialRoot, { recursive: true });
  await Promise.all([
    copyFile(new URL("../runtime/Copy-CeoTrainingCredential.ps1", import.meta.url), fixtureScript),
    copyFile(new URL("../runtime/Path-Safety.ps1", import.meta.url), fixturePathSafety),
    writeFile(path.join(credentialRoot, "credential"), fakeCredential, "utf8"),
  ]);
  if (ignored) await writeFile(path.join(fixtureRoot, ".gitignore"), "/assets/owner/runtime/\n", "utf8");
  const git = spawnSync("git", ["init", "--quiet", fixtureRoot], { encoding: "utf8" });
  assert.equal(git.status, 0, git.stderr);

  return { fixtureRoot, fixtureScript, fixturePathSafety };
}

function runWindowsPowerShell(command) {
  const powershell = path.join(
    process.env.SystemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return spawnSync(powershell, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    command,
  ], { encoding: "utf8" });
}

function quotePowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

test("runtime path checks do not depend on APIs missing from Windows PowerShell 5.1", async () => {
  const [copySource, startSource, discordSource, pathSource, bridgeSource, incidentWatcherSource] = await Promise.all([
    readFile(new URL("../runtime/Copy-CeoTrainingCredential.ps1", import.meta.url), "utf8"),
    readFile(new URL("../runtime/Start-Company.ps1", import.meta.url), "utf8"),
    readFile(new URL("../runtime/discord/Start-Discord.ps1", import.meta.url), "utf8"),
    readFile(new URL("../runtime/Path-Safety.ps1", import.meta.url), "utf8"),
    readFile(new URL("../runtime/bridge.ps1", import.meta.url), "utf8"),
    readFile(new URL("../runtime/Watch-SystemIncidents.ps1", import.meta.url), "utf8"),
  ]);

  for (const source of [copySource, startSource, discordSource, pathSource, bridgeSource, incidentWatcherSource]) {
    assert.doesNotMatch(source, /Path\]::GetRelativePath/);
  }
  assert.match(pathSource, /StartsWith\(\$rootPrefix, \$comparison\)/);
  assert.match(pathSource, /Substring\(\$rootPrefix\.Length\)/);
  assert.match(startSource, /\$portalEnvironment = @\(\$portalEnvironmentJson \| ConvertFrom-Json \| ForEach-Object \{ \$_ \}\)/);
  assert.equal(bridgeSource.match(/ConvertFrom-Json \| ForEach-Object \{ \$_ \}/g)?.length, 3);
  assert.match(incidentWatcherSource, /\$items = @\(Invoke-RestMethod[\s\S]*?-TimeoutSec 20 \| ForEach-Object \{ \$_ \}\)/);
});

test("Windows PowerShell 5.1 flattens Docker JSON arrays before identity checks", {
  skip: process.platform !== "win32",
}, () => {
  const result = runWindowsPowerShell([
    "$json = '[{\"Name\":\"portal\"}]'",
    "$rows = @($json | ConvertFrom-Json | ForEach-Object { $_ })",
    "if ($rows.Count -ne 1) { throw 'JSON array did not flatten to one row.' }",
    "if ($rows[0].GetType().FullName -ne 'System.Management.Automation.PSCustomObject') { throw 'JSON row remained nested.' }",
    "if ($rows[0].Name -cne 'portal') { throw 'JSON row identity was not readable.' }",
    "Write-Output 'json-array-compatible'",
  ].join("\n"));

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "json-array-compatible");
});

test("Windows PowerShell 5.1 flattens REST arrays before issue scans and pagination", {
  skip: process.platform !== "win32",
}, () => {
  const result = runWindowsPowerShell([
    "function Get-NoEnumerateItems([int]$Count, [int]$Offset = 0) {",
    "  $items = @()",
    "  for ($index = 1; $index -le $Count; $index++) { $items += [pscustomobject]@{ id = $Offset + $index } }",
    "  Write-Output -NoEnumerate $items",
    "}",
    "foreach ($count in @(0, 1, 2)) {",
    "  $rows = @(Get-NoEnumerateItems -Count $count | ForEach-Object { $_ })",
    "  if ($rows.Count -ne $count) { throw \"REST array count $count remained nested.\" }",
    "}",
    "$found = $null",
    "$visitedPages = 0",
    "for ($page = 1; $page -le 20; $page++) {",
    "  $visitedPages++",
    "  $items = if ($page -eq 1) { @(Get-NoEnumerateItems -Count 100) } else { @(Get-NoEnumerateItems -Count 2 -Offset 100) }",
    "  $items = @($items | ForEach-Object { $_ })",
    "  foreach ($item in $items) { if ($item.id -eq 101) { $found = $item; break } }",
    "  if ($found -or $items.Count -lt 100) { break }",
    "}",
    "if ($found.id -ne 101 -or $visitedPages -ne 2) { throw 'Issue scan did not preserve itemwise pagination.' }",
    "Write-Output 'rest-array-compatible'",
  ].join("\n"));

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "rest-array-compatible");
});

test("CEO credential copy helper runs on Windows PowerShell 5.1 without touching the real clipboard", {
  skip: process.platform !== "win32",
}, async () => {
  const fixture = await createCredentialFixture();
  try {
    const scriptPath = quotePowerShell(fixture.fixtureScript);
    const result = runWindowsPowerShell([
      "$global:mockClipboard = $null",
      "function Set-Clipboard { param([string]$Value) $global:mockClipboard = $Value }",
      `& ${scriptPath} | Out-Null`,
      `if ($global:mockClipboard -cne '${fakeCredential}') { throw 'Mock clipboard did not receive the fixture credential.' }`,
      "Write-Output 'credential-copy-compatible'",
    ].join("\n"));

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "credential-copy-compatible");
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(fakeCredential));
  } finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("Windows PowerShell 5.1 path containment rejects parent and sibling-prefix escapes", {
  skip: process.platform !== "win32",
}, async () => {
  const fixture = await createCredentialFixture();
  try {
    const helperPath = quotePowerShell(fixture.fixturePathSafety);
    const rootPath = quotePowerShell(fixture.fixtureRoot);
    const result = runWindowsPowerShell([
      `. ${helperPath}`,
      `$root = ${rootPath}`,
      "$valid = Join-Path $root 'assets\\owner\\runtime\\credential'",
      "$relative = Get-LaAziendaRepositoryRelativePath -RepositoryRoot $root -CandidatePath $valid",
      "if ($relative -cne 'assets/owner/runtime/credential') { throw 'Valid child path was not normalized exactly.' }",
      "$candidates = @(\"$root-evil\\credential\", (Join-Path (Split-Path $root -Parent) 'outside\\credential'))",
      "$rejected = 0",
      "foreach ($candidate in $candidates) {",
      "  try { Get-LaAziendaRepositoryRelativePath -RepositoryRoot $root -CandidatePath $candidate | Out-Null }",
      "  catch { if ($_.Exception.Message -cne 'Resolved path left the repository boundary.') { throw }; $rejected++ }",
      "}",
      "if ($rejected -ne 2) { throw 'An escaped path was accepted.' }",
      "Write-Output 'path-boundary-compatible'",
    ].join("\n"));

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "path-boundary-compatible");
  } finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("an unignored owner credential is rejected before the clipboard boundary", {
  skip: process.platform !== "win32",
}, async () => {
  const fixture = await createCredentialFixture({ ignored: false });
  try {
    const scriptPath = quotePowerShell(fixture.fixtureScript);
    const result = runWindowsPowerShell([
      "$global:mockClipboard = $null",
      "function Set-Clipboard { param([string]$Value) $global:mockClipboard = $Value }",
      "$rejected = $false",
      `try { & ${scriptPath} | Out-Null } catch {`,
      "  if ($_.Exception.Message -notlike '*path is not ignored by Git*') { throw }",
      "  $rejected = $true",
      "}",
      "if (-not $rejected) { throw 'Unignored credential was accepted.' }",
      "if ($null -ne $global:mockClipboard) { throw 'Clipboard boundary was reached after rejection.' }",
      "Write-Output 'unignored-credential-rejected'",
    ].join("\n"));

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "unignored-credential-rejected");
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(fakeCredential));
  } finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
});
