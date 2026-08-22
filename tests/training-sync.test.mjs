import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  canonicalSkillFolder,
  normalizeSkillPackageInput,
  resolveEmployeeSkillFolderReservations,
  safeSkillFolderPattern,
  skillFolderFromPackageRef,
} from "../lib/training-contract.ts";
import { readBoundedJsonObject } from "../lib/server/bounded-json.ts";

const [reconciler, companyLoop, entrypoint, bridgeRuntime, containerSync, trainingRoute, trainingUi, workforce, companyRoute, employeeRoute, executorRoute, ensureSource, migration9, migration10, migration11] = await Promise.all([
  readFile(new URL("../runtime/hrm/reconcile.sh", import.meta.url), "utf8"),
  readFile(new URL("../runtime/hrm/company-loop.sh", import.meta.url), "utf8"),
  readFile(new URL("../runtime/agent/entrypoint.sh", import.meta.url), "utf8"),
  readFile(new URL("../runtime/bridge.ps1", import.meta.url), "utf8"),
  readFile(new URL("../runtime/agent/sync-skills.sh", import.meta.url), "utf8"),
  readFile(new URL("../app/api/training/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/components/TrainingCenter.tsx", import.meta.url), "utf8"),
  readFile(new URL("../lib/server/workforce.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/company/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/employees/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/executor/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../db/ensure.ts", import.meta.url), "utf8"),
  readFile(new URL("../drizzle/0009_panoramic_strong_guy.sql", import.meta.url), "utf8"),
  readFile(new URL("../drizzle/0010_smooth_grandmaster.sql", import.meta.url), "utf8"),
  readFile(new URL("../drizzle/0011_glossy_morg.sql", import.meta.url), "utf8"),
]);

test("skill package and folder contracts reject traversal and reserved basenames", () => {
  assert.equal(skillFolderFromPackageRef("microsoft/skills@azure-tools"), "azure-tools");
  assert.equal(skillFolderFromPackageRef("microsoft/skills@Azure-Tools"), "azure-tools");
  assert.equal(canonicalSkillFolder("Foo.Bar"), "foo.bar");
  assert.equal(normalizeSkillPackageInput("npx skills add microsoft/skills@azure-tools -y"), "microsoft/skills@azure-tools");
  for (const unsafe of [".", "..", ".omc-state", ".hidden", "../escape", "nested/path", "alpha\\beta", "-switch", "alpha.", "alpha-", "alpha_", "CON", "con.txt", "PRN", "AUX", "NUL", "COM1", "lpt9.log"]) {
    assert.equal(safeSkillFolderPattern.test(unsafe), false, unsafe);
  }
  for (const unsafe of ["../repo@skill", "owner/../skill", "owner/repo@..", "owner/repo@.omc-state", "owner/repo@nested/path"]) {
    assert.equal(normalizeSkillPackageInput(unsafe), null, unsafe);
  }
});

test("legacy folder backfill keeps one canonical folder and reserves every collision deterministically", () => {
  const resolved = resolveEmployeeSkillFolderReservations([
    { employeeId: "e", skillId: "c", folderKey: null, packageRef: "third/repo@legacy-reservation-2-1" },
    { employeeId: "e", skillId: "b", folderKey: null, packageRef: "other/repo@alpha" },
    { employeeId: "e", skillId: "a", folderKey: null, packageRef: "owner/repo@alpha" },
  ]);
  assert.deepEqual(resolved.map(({ skillId, folderKey }) => ({ skillId, folderKey })), [
    { skillId: "a", folderKey: "alpha" },
    { skillId: "b", folderKey: "legacy-reservation-2-2" },
    { skillId: "c", folderKey: "legacy-reservation-2-1" },
  ]);
  assert.equal(new Set(resolved.map((row) => row.folderKey)).size, resolved.length);
  assert.ok(resolved.every((row) => safeSkillFolderPattern.test(row.folderKey)));
});

test("owner authentication guards every desired training and onboarding mutation", () => {
  assert.match(trainingRoute, /const ownerIsAuthorized = await ownerAuthorized\(request\)/);
  assert.match(trainingRoute, /action === "reportSkillSync"[\s\S]*!bridgeIsAuthorized/);
  assert.match(trainingRoute, /action === "reportCacheObservation"[\s\S]*!bridgeIsAuthorized/);
  assert.match(employeeRoute, /body\.action === "reportRuntime" \? !bridgeIsAuthorized[\s\S]*!ownerIsAuthorized/);
  assert.doesNotMatch(trainingRoute, /Origin|Referer|x-owner-token/i);
  for (const source of [trainingRoute, employeeRoute]) {
    const authorization = source.indexOf("if (!bridgeIsAuthorized && !ownerIsAuthorized)");
    const bodyRead = source.indexOf("readBoundedJsonObject(request");
    assert.ok(authorization > 0 && bodyRead > authorization, "authorization must precede body consumption");
    assert.doesNotMatch(source, /request\.json\(\)/);
  }
});

test("bounded JSON rejects declared and streamed oversized bodies", async () => {
  const declared = new Request("http://localhost/api", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": "1000" },
    body: "{}",
  });
  assert.deepEqual(await readBoundedJsonObject(declared, 32), { ok: false, status: 413, error: "Request body is too large" });
  const streamed = new Request("http://localhost/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: "x".repeat(100) }),
  });
  assert.deepEqual(await readBoundedJsonObject(streamed, 32), { ok: false, status: 413, error: "Request body is too large" });
});

test("observations are append-only, predecessor-ordered, and atomically conditional on desired state", () => {
  assert.match(trainingRoute, /INSERT OR IGNORE INTO training_sync_observations/);
  assert.match(trainingRoute, /previous_observation_id/);
  assert.match(trainingRoute, /COALESCE\(\(SELECT MAX\(current\.id\)/);
  assert.match(trainingRoute, /JOIN employee_skills es[\s\S]*es\.desired_state = \?[\s\S]*es\.assignment_version = \?/);
  assert.match(trainingRoute, /INSERT INTO activity \(message, tone\) SELECT \?, \? WHERE changes\(\) > 0/);
  assert.match(trainingRoute, /DELETE FROM employee_skills[\s\S]*desired_state = 'revoked'[\s\S]*previous_observation_id = \?/);
  assert.match(trainingRoute, /latest\.manifestVersion === manifestVersion/);
});

test("the predecessor uniqueness invariant resolves concurrent-ish reports without hiding re-observation", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee TEXT NOT NULL, skill TEXT NOT NULL, operation TEXT NOT NULL,
    version INTEGER NOT NULL, previous INTEGER NOT NULL,
    status TEXT NOT NULL,
    UNIQUE(employee, skill, operation, version, previous)
  )`);
  const insert = db.prepare("INSERT OR IGNORE INTO observations (employee,skill,operation,version,previous,status) VALUES (?,?,?,?,?,?)");
  insert.run("e", "s", "install", 1, 0, "verified");
  insert.run("e", "s", "install", 1, 0, "failed");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM observations").get().count, 1);
  const first = db.prepare("SELECT id FROM observations").get().id;
  insert.run("e", "s", "install", 1, first, "failed");
  const failed = db.prepare("SELECT MAX(id) AS id FROM observations").get().id;
  insert.run("e", "s", "install", 1, failed, "verified");
  assert.deepEqual(db.prepare("SELECT status FROM observations ORDER BY id").all().map((row) => row.status), ["verified", "failed", "verified"]);
  db.close();
});

test("approved immutable cache revisions and three-way evidence gate verified capability", () => {
  assert.match(trainingRoute, /approvedDigest !== assignment\.observedDigest/);
  assert.match(trainingRoute, /sourceHash !== stagedHash \|\| sourceHash !== verifiedHash/);
  assert.match(trainingRoute, /approveSkillCache/);
  assert.match(trainingRoute, /expectedObservedDigest/);
  assert.match(trainingRoute, /approved_digest = observed_digest/);
  assert.match(trainingRoute, /current_skill\.approved_digest = current_skill\.observed_digest[\s\S]*current_skill\.approved_digest = \?/);
  assert.match(trainingRoute, /observationStatus !== "observed" && observedDigest !== null/);
  assert.match(trainingRoute, /assignment_version = assignment_version \+ 1/);
  assert.match(trainingRoute, /INSERT INTO training_center_skills \([\s\S]*folder_key/);
  assert.match(trainingRoute, /WHERE NOT EXISTS \(SELECT 1 FROM training_center_skills WHERE package_ref = \?\)/);
  assert.doesNotMatch(trainingRoute, /INSERT OR IGNORE INTO training_center_skills/);
  assert.match(trainingRoute, /idx_training_skills_package_ref[\s\S]*readTraining\(request\)/);
  for (const source of [workforce, companyRoute]) {
    assert.match(source, /o\.status = 'verified'/);
    assert.match(source, /o\.source_hash = s\.approved_digest/);
    assert.match(source, /o\.staged_hash = s\.approved_digest/);
    assert.match(source, /o\.verified_hash = s\.approved_digest/);
    assert.match(source, /COUNT\(DISTINCT o\.manifest_version\) = 1/);
  }
  assert.match(reconciler, /\.desiredSkills/);
  assert.match(workforce, /employee\.skills = verifiedRows\.filter/);
  assert.match(workforce, /employee\.desiredSkills = desiredRows\.filter/);
});

test("skill import retries by package identity but rejects a different package with the same cache folder", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE training_center_skills (
    id TEXT PRIMARY KEY, package_ref TEXT NOT NULL UNIQUE, folder_key TEXT COLLATE NOCASE
  );
  CREATE UNIQUE INDEX idx_training_skills_folder ON training_center_skills(folder_key COLLATE NOCASE)
    WHERE folder_key IS NOT NULL;`);
  const insert = db.prepare(`INSERT INTO training_center_skills
    SELECT ?,?,? WHERE NOT EXISTS (SELECT 1 FROM training_center_skills WHERE package_ref=?)`);
  insert.run("a", "owner/repo@Alpha", "alpha", "owner/repo@Alpha");
  assert.equal(insert.run("b", "owner/repo@Alpha", "alpha", "owner/repo@Alpha").changes, 0);
  assert.throws(() => insert.run("c", "other/repo@alpha", "ALPHA", "other/repo@alpha"), /folder_key|idx_training_skills_folder/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM training_center_skills").get().count, 1);
  db.close();
});

test("only an HRM-owned prior manifest authorizes deletion and application is fail-atomic", () => {
  assert.match(containerSync, /prior_manifest_path=.*\/opt\/assigned-skills\/\.omc-training-prior\.json/);
  assert.match(containerSync, /Delete authority comes only from the prior HRM-published/);
  assert.doesNotMatch(containerSync, /applied\.json.*previous|previous_manifest=.*applied\.json/);
  assert.match(containerSync, /transaction\/backups/);
  assert.match(containerSync, /rollback\(\)/);
  assert.match(containerSync, /OMC_SYNC_FAIL_AFTER_COMMITS/);
  assert.match(containerSync, /write_ahead\(\)/);
  assert.match(containerSync, /transaction_root=.*\/opt\/assigned-skills\/\.omc-transactions/);
  assert.match(containerSync, /flock/);
  assert.match(containerSync, /recover_abandoned_transactions/);
  assert.match(containerSync, /OMC_SYNC_KILL_AFTER_MOVES/);
  assert.match(containerSync, /sync -f "\$transaction_root"/);
  assert.match(containerSync, /sync -f "\$journal"/);
  assert.ok(containerSync.indexOf("write_ahead install") < containerSync.indexOf('mv -- "$staged" "$target"'));
  const removalJournal = containerSync.indexOf("write_ahead remove");
  assert.ok(removalJournal > 0 && removalJournal < containerSync.indexOf('mv -- "$target" "$backup"', removalJournal));
  assert.ok(containerSync.indexOf("copy_and_verify") < containerSync.indexOf("write_ahead install"));
  assert.ok(containerSync.indexOf("write_ahead install") < containerSync.indexOf("write_ahead remove"));
  assert.match(reconciler, /managed_manifest_name="\.omc-training-managed\.json"/);
  assert.match(reconciler, /last_good_manifest_name="\.omc-training-managed\.last-good\.json"/);
  assert.match(reconciler, /mktemp "\$parent\/\.omc-publish-/);
  assert.match(reconciler, /input_file="\$\(mktemp\)"[\s\S]*cat > "\$input_file"/);
  assert.match(reconciler, /actual_hash="\$\(sha256sum -- "\$input_file"\)"[\s\S]*actual_size="\$\(stat -c %s -- "\$input_file"\)"/);
  assert.match(reconciler, /actual_size="\$\(stat -c %s -- "\$stage"\)"[\s\S]*actual_hash="\$\(sha256sum -- "\$stage"\)"[\s\S]*actual_size.*expected_size.*actual_hash.*expected_hash/);
  assert.match(reconciler, /\[\[ -d "\$parent" && ! -L "\$parent" \]\][\s\S]*chmod 0755 "\$parent"; chown 1001:1001 "\$parent"/);
  assert.match(reconciler, /mv -T -- "\$stage" "\$destination"/);
  assert.match(reconciler, /publish_manifest_file "\$skills_volume" "\$prior_manifest_name"/);
  assert.match(reconciler, /publish_manifest_file[\s\S]*expected_hash=.*sha256sum[\s\S]*expected_size=.*wc -c[\s\S]*write_volume_file.*expected_hash.*expected_size[\s\S]*readback=.*read_volume_file[\s\S]*readback.*content/);
  assert.match(reconciler, /manifest_matches_installed_volume/);
  assert.match(reconciler, /staged_candidate=.*\$skill_manifest_name/);
  assert.match(reconciler, /managed_valid.*last_good_valid[\s\S]*managed_manifest="\$managed_candidate"/);
  assert.match(reconciler, /staged_valid[\s\S]*managed_manifest="\$staged_candidate"/);
  const authorityRepair = reconciler.indexOf('publish_manifest_file "$skills_volume" "$managed_manifest_name"');
  const repairedBackup = reconciler.indexOf('publish_manifest_file "$skills_volume" "$last_good_manifest_name"', authorityRepair);
  const currentMutation = reconciler.indexOf('publish_manifest_file "$skills_volume" "$prior_manifest_name"', repairedBackup);
  assert.ok(authorityRepair > 0 && authorityRepair < repairedBackup && repairedBackup < currentMutation,
    "an exact active-volume match must be republished as authority before a new mutation");
});

test("authority recovery converges every publication crash window without trusting metadata order", () => {
  const active = new Map([["alpha", "a".repeat(64)], ["beta", "b".repeat(64)]]);
  const contractValid = (candidate) => candidate?.schemaVersion === 2 && candidate.employeeId === "employee" &&
    Array.isArray(candidate.skills) && Array.isArray(candidate.removals) && candidate.skills.every((skill) =>
      typeof skill.id === "string" && Number.isInteger(skill.assignmentVersion) && skill.assignmentVersion >= 1);
  const mappingMatches = (candidate) => contractValid(candidate) && candidate.skills.length === active.size &&
    candidate.skills.every((skill) => active.get(skill.folder) === skill.sourceHash);
  const select = (managed, lastGood, staged) => {
    if (mappingMatches(managed)) return managed;
    if (mappingMatches(lastGood)) return lastGood;
    if (mappingMatches(staged)) return staged;
    return null;
  };
  const old = { schemaVersion: 2, employeeId: "employee", manifestVersion: "1".repeat(64), removals: [],
    skills: [{ id: "alpha", folder: "alpha", assignmentVersion: 1, sourceHash: "a".repeat(64) }] };
  const current = { schemaVersion: 2, employeeId: "employee", manifestVersion: "2".repeat(64), removals: [], skills: [
    { id: "alpha", folder: "alpha", assignmentVersion: 2, sourceHash: "a".repeat(64) },
    { id: "beta", folder: "beta", assignmentVersion: 1, sourceHash: "b".repeat(64) },
  ] };
  assert.equal(select(old, current, current), current, "last-good recovers a crash between authority writes");
  assert.equal(select(old, old, current), current, "staged desired manifest recovers a crash before either authority write");
  const sameBytesDifferentMetadata = { ...current, manifestVersion: "3".repeat(64),
    skills: current.skills.map((skill) => ({ ...skill, assignmentVersion: skill.assignmentVersion + 7 })) };
  assert.equal(select(current, sameBytesDifferentMetadata, sameBytesDifferentMetadata), current,
    "the managed slot wins when both candidates prove identical active bytes");
  const malformedPrimary = { ...current };
  delete malformedPrimary.removals;
  assert.equal(select(malformedPrimary, current, old), current,
    "a JSON-valid but contract-malformed primary cannot overwrite its valid backup");
  assert.match(reconciler, /valid_managed_manifest[\s\S]*assignmentVersion[\s\S]*\.removals[\s\S]*unique/);
  assert.match(reconciler, /valid_managed_manifest[\s\S]*jq -es[\s\S]*length == 1 and \(\.\[0\] \|/);
  assert.match(containerSync, /validate_ro_manifest[\s\S]*jq -es[\s\S]*length == 1 and \(\.\[0\] \|/);
  assert.match(reconciler, /valid_applied_evidence[\s\S]*jq -es[\s\S]*length == 1 and \(\.\[0\] \|[\s\S]*expectedSkills[\s\S]*verifiedHash == \.sourceHash/);
  assert.match(reconciler, /training_generation[\s\S]*jq -ers[\s\S]*length == 1[\s\S]*invalid training generation envelope/);
  assert.match(reconciler, /empty_installed_proven=false[\s\S]*manifest_matches_installed_volume[\s\S]*empty_installed_proven=true/);
  assert.match(reconciler, /managed_contract_valid.*last_good_contract_valid[\s\S]*empty_installed_proven[\s\S]*managed_manifest="\$empty_manifest"/);
  assert.ok(reconciler.indexOf('publish_manifest_file "$skills_volume" "$managed_manifest_name"') <
    reconciler.indexOf('publish_manifest_file "$skills_volume" "$last_good_manifest_name"'));
});

test("filesystem contracts reject unsafe roots and hash content plus modes without lossy pipelines", () => {
  for (const source of [containerSync, reconciler]) {
    assert.match(source, /^#!\/usr\/bin\/env bash/m);
    assert.match(source, /set -Eeuo pipefail/);
    assert.match(source, /stat -c '%a'/);
    assert.match(source, /find .* -print0/);
    assert.match(source, /\[\[ -L "\$path" \]\]/);
    assert.doesNotMatch(source, /xargs -0.*sha256sum/);
  }
  assert.match(containerSync, /realpath -m/);
  assert.match(containerSync, /resolved.*\/workspace/);
  assert.match(containerSync, /tar -C "\$source" -cf - \. \| tar -C "\$staged" -xf -/);
  assert.match(containerSync, /list_workspace_folders[\s\S]*if ! find "\$workspace_skills"[\s\S]*sort -z "\$list" -o "\$list"/);
  assert.doesNotMatch(containerSync, /done < <\(find "\$workspace_skills"/);
  const absenceProof = containerSync.slice(
    containerSync.indexOf('if [[ "${1:-}" == "--verify-workspace-absent" ]]'),
    containerSync.indexOf('if [[ "${1:-}" == "--list-workspace-folders" ]]'),
  );
  assert.match(absenceProof, /active_folders="\$\(list_workspace_folders\)" \|\| exit \$\?/);
  assert.doesNotMatch(absenceProof, /! -e "\$workspace_skills\/\$folder"/);
});

test("active skills and claim eligibility stay behind HRM-controlled process and volume boundaries", () => {
  assert.match(reconciler, /installed_skills_volume="omc-installed-skills-/);
  assert.match(reconciler, /--volume "\$installed_skills_volume:\/workspace\/\.agents\/skills:ro"/);
  assert.match(reconciler, /--volume "\$6:\/workspace\/\.agents\/skills"/);
  assert.match(reconciler, /one-man-company\.skills-volume-contract/);
  assert.match(reconciler, /actual_active_folders.*expected_active_folders/);
  assert.match(reconciler, /actual_policy_hash/);
  assert.match(reconciler, /company_paths_safe/);
  assert.match(reconciler, /volume_control_paths_safe[\s\S]*control_dir_ready[\s\S]*stat -c %u[\s\S]*owner_mode[\s\S]*owner_mode.*3.*owner_mode.*7/);
  assert.match(reconciler, /docker exec "\$container_name"[\s\S]*-O \/workspace\/\.company[\s\S]*-w \/workspace\/\.company[\s\S]*-x \/workspace\/\.company/);
  assert.match(reconciler, /normalize_volume_control_paths[\s\S]*chmod 0755 "\$path"; chown 1001:1001 "\$path"/);
  const policyRepair = reconciler.slice(
    reconciler.indexOf('if [[ "$policy_needs_repair" == true'),
    reconciler.indexOf('if [[ "$policy_ready" != true'),
  );
  assert.ok(policyRepair.indexOf('docker stop "$container_name"') < policyRepair.indexOf('normalize_volume_control_paths "$workspace_volume"'));
  assert.match(policyRepair, /volume_control_paths_safe "\$workspace_volume" \|\| policy_ready=false/);
  assert.match(reconciler, /workforce_ready.*false/);
  assert.match(reconciler, /existing_employee[\s\S]*workforce_ready=false[\s\S]*report_runtime "\$employee_id" not_found/);
  assert.match(reconciler, /exit 75/);
  assert.ok(companyLoop.indexOf("/opt/one-man-company/reconcile") < companyLoop.indexOf("action claim"));
  assert.match(companyLoop, /terminal_outbox=.*terminal-outbox/);
  assert.match(companyLoop, /trap quiesce_active_on_exit EXIT/);
  assert.ok(companyLoop.indexOf('recover_interrupted_run ||') < companyLoop.indexOf('while true; do'));
  assert.ok(companyLoop.indexOf('atomic_write_json "$active_marker"') < companyLoop.indexOf('docker exec -i "$container_id"'));
  const terminalQueue = companyLoop.lastIndexOf('queue_terminal_action "$safe_run" "$terminal_payload"');
  const terminalQuiesce = companyLoop.lastIndexOf('quiesce_container "$container_id"');
  const terminalDrain = companyLoop.lastIndexOf('if drain_terminal_outbox');
  assert.ok(terminalQueue > 0 && terminalQueue < terminalQuiesce && terminalQuiesce < terminalDrain);
  assert.match(companyLoop, /inspect_container_identity[\s\S]*No such container[\s\S]*return 75/);
  assert.match(companyLoop, /docker restart "\$quiesce_id"/);
  assert.match(companyLoop, /quiesce_after_id[\s\S]*quiesce_after_state[\s\S]*quiesce_after_restarting/);
  assert.match(companyLoop, /docker stop "\$quiesce_id"/);
  assert.match(companyLoop, /quiesce_stopped_id[\s\S]*exited\|created/);
  assert.match(companyLoop, /phase:"executing",executionStatus:null/);
  assert.match(companyLoop, /phase:"post-exec",executionStatus:\$executionStatus/);
  assert.match(companyLoop, /recovered_phase.*post-exec[\s\S]*recovered_execution_status.*-eq 0[\s\S]*validate_result_json/);
  assert.match(companyLoop, /validate_result_json[\s\S]*jq -es[\s\S]*length == 1 and \(\.\[0\] \|/);
  assert.match(companyLoop, /validate_terminal_payload[\s\S]*jq -es[\s\S]*length == 1 and \(\.\[0\] \|/);
  assert.match(companyLoop, /recover_interrupted_run[\s\S]*marker_payload[\s\S]*jq -es[\s\S]*length == 1 and \(\.\[0\] \|/);
  assert.match(companyLoop, /knowledge[\s\S]*gsub\("\^\\\\s\+\|\\\\s\+\$"; ""\)[\s\S]*length >= 20/);
  assert.match(companyLoop, /sync -f "\$temporary"[\s\S]*mv -f -- "\$temporary" "\$target"[\s\S]*sync -f "\$parent" \|\| return 74/);
  assert.doesNotMatch(companyLoop, /post_run_action "\$(?:complete|fail)_payload"/);
  assert.doesNotMatch(entrypoint, /sync-company-skills/);
  assert.match(bridgeRuntime, /\/company\/state:ro/);
  for (const directory of [
    ".company\\training",
    ".company\\runs",
    ".company\\reconcile",
    ".company\\dispatcher",
    ".company\\dispatcher\\terminal-outbox",
  ]) {
    assert.ok(bridgeRuntime.includes(`"${directory}"`), `host bootstrap precreates ${directory}`);
  }
  assert.match(bridgeRuntime, /Assert-SafeRuntimeDirectory/);
  assert.match(bridgeRuntime, /FileAttributes\]::ReparsePoint/);
  assert.match(bridgeRuntime, /Test-ContainedRuntimePath/);
  assert.doesNotMatch(reconciler, /reconcile_state_root="\$state_root/);
});

test("host bootstrap precreates only contained non-reparse HRM control directories", { skip: process.platform !== "win32" }, () => {
  const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const bridgePath = new URL("../runtime/bridge.ps1", import.meta.url).pathname.slice(1).replaceAll("/", "\\");
  const command = `
    $source = [IO.File]::ReadAllText('${bridgePath.replaceAll("'", "''")}')
    $start = $source.IndexOf('function Test-ContainedRuntimePath')
    $end = $source.IndexOf('if (-not (Test-ContainedRuntimePath $stateRoot', $start)
    if ($start -lt 0 -or $end -le $start) { exit 41 }
    Invoke-Expression $source.Substring($start, $end - $start)
    $root = Join-Path ([IO.Path]::GetTempPath()) ('omc-test-runtime-' + [Guid]::NewGuid().ToString('N'))
    $outside = $root + '-outside'
    try {
      New-Item -ItemType Directory -Path $root, $outside | Out-Null
      foreach ($relative in @('.company\\training','.company\\runs','.company\\reconcile','.company\\dispatcher','.company\\dispatcher\\terminal-outbox')) {
        Assert-SafeRuntimeDirectory $root $relative | Out-Null
        if (-not (Test-Path -LiteralPath (Join-Path $root $relative) -PathType Container)) { exit 42 }
      }
      if (Test-ContainedRuntimePath $root ($root + '-escape')) { exit 43 }
      $junction = Join-Path $root '.company\\redirect'
      New-Item -ItemType Junction -Path $junction -Target $outside | Out-Null
      $blocked = $false
      try { Assert-SafeRuntimeDirectory $root '.company\\redirect\\child' | Out-Null } catch { $blocked = $true }
      if (-not $blocked) { exit 44 }
      Remove-Item -LiteralPath $junction -Force
    } finally {
      if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
      if (Test-Path -LiteralPath $outside) { Remove-Item -LiteralPath $outside -Recurse -Force }
    }
  `;
  execFileSync(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], { stdio: "pipe" });
});

test("claims are atomically bound to the exact reconciled training generation", () => {
  assert.match(migration11, /CREATE TABLE `control_generations`/);
  assert.match(migration11, /VALUES \('training', 1, CURRENT_TIMESTAMP\)/);
  assert.match(ensureSource, /INSERT INTO control_generations[\s\S]*'training', 1/);
  assert.match(trainingRoute, /desiredGeneration: generationRow\?\.generation \?\? 1/);
  assert.equal((trainingRoute.match(/UPDATE control_generations SET generation = generation \+ 1/g) ?? []).length, 5);
  assert.match(employeeRoute, /effectiveSkills\.length > 0[\s\S]*UPDATE control_generations SET generation = generation \+ 1/);
  assert.match(reconciler, /final_training_state=.*\/api\/training/);
  assert.match(reconciler, /reconciled_training_generation=.*training_generation/);
  assert.match(reconciler, /reconciled_training_generation[\s\S]*workforce=.*\/api\/employees[\s\S]*confirmed_training_generation[\s\S]*mixed snapshot/);
  assert.match(reconciler, /claim_training_generation" != "\$reconciled_training_generation"[\s\S]*exit 75/);
  assert.match(reconciler, /publish_claim_generation "\$claim_training_generation"/);
  assert.ok(companyLoop.indexOf("/opt/one-man-company/reconcile") < companyLoop.indexOf('if [ ! -f "$claim_generation_file" ]'));
  assert.match(companyLoop, /trainingGeneration:\$trainingGeneration/);
  const claimBlock = executorRoute.slice(executorRoute.indexOf("async function claimSecretaryInquiry"), executorRoute.indexOf("export async function POST"));
  assert.equal((claimBlock.match(/WHERE control_key = 'training' AND generation = \?/g) ?? []).length, 2);
  assert.match(claimBlock, /FROM secretary_inquiries current_inquiry[\s\S]*JOIN employees current_employee/);
  assert.match(claimBlock, /current_inquiry\.status = 'queued'[\s\S]*current_employee\.runtime_status = 'running'[\s\S]*MAX\(current_run\.attempt\)/);
  assert.match(claimBlock, /FROM tasks current_task JOIN employees current_employee/);
  assert.match(claimBlock, /current_task\.assignee_id = \?[\s\S]*current_task\.execution_cycle = \?[\s\S]*current_employee\.runtime_status = 'running'/);
  assert.equal((claimBlock.match(/const claimResults = await d1\.batch/g) ?? []).length, 2);
  assert.equal((claimBlock.match(/activeClaimExists/g) ?? []).length >= 8, true);

  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE control_generations (control_key TEXT PRIMARY KEY, generation INTEGER NOT NULL);
    INSERT INTO control_generations VALUES ('training', 1);
    CREATE TABLE desired (id TEXT PRIMARY KEY, state TEXT NOT NULL);
    INSERT INTO desired VALUES ('skill', 'assigned');
    CREATE TABLE claims (id TEXT PRIMARY KEY);`);
  const desiredMutation = db.prepare("UPDATE desired SET state = ? WHERE id = 'skill' AND state != ?");
  const bumpAfterChange = db.prepare("UPDATE control_generations SET generation = generation + 1 WHERE control_key = 'training' AND changes() > 0");
  desiredMutation.run("assigned", "assigned");
  assert.equal(bumpAfterChange.run().changes, 0, "an idempotent desired replay must not bump");
  desiredMutation.run("revoked", "revoked");
  assert.equal(bumpAfterChange.run().changes, 1);
  assert.equal(db.prepare("SELECT generation FROM control_generations").get().generation, 2);
  const claim = db.prepare(`INSERT OR IGNORE INTO claims SELECT ? WHERE EXISTS
    (SELECT 1 FROM control_generations WHERE control_key='training' AND generation=?)`);
  assert.equal(claim.run("stale", 1).changes, 0);
  assert.equal(claim.run("current", 2).changes, 1);
  db.close();
});

test("stale task snapshots and Inbox assignment races lose their compare-and-swap", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE control_generations (control_key TEXT PRIMARY KEY, generation INTEGER NOT NULL);
    INSERT INTO control_generations VALUES ('training',1);
    CREATE TABLE employees (id TEXT PRIMARY KEY, container_name TEXT, resource_access TEXT,
      desired_runtime_status TEXT, runtime_status TEXT);
    INSERT INTO employees VALUES ('e1','omc-e1','task-scoped','running','running');
    INSERT INTO employees VALUES ('e2','omc-e2','task-scoped','running','running');
    CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT, assignee_id TEXT, execution_cycle INTEGER, handoff_required INTEGER);
    INSERT INTO tasks VALUES ('t','queued','e1',1,0);
    CREATE TABLE runs (id TEXT PRIMARY KEY, job_id TEXT, employee_id TEXT, attempt INTEGER, execution_cycle INTEGER);`);
  const claim = db.prepare(`INSERT OR IGNORE INTO runs
    SELECT ?, current_task.id, current_employee.id, ?, current_task.execution_cycle
    FROM tasks current_task JOIN employees current_employee ON current_employee.id=current_task.assignee_id
    WHERE current_task.id='t' AND current_task.status='queued' AND current_task.assignee_id='e1'
      AND current_task.execution_cycle=1 AND current_task.handoff_required=0
      AND current_employee.container_name='omc-e1' AND current_employee.runtime_status='running'
      AND ?=(SELECT COALESCE(MAX(attempt),0)+1 FROM runs WHERE job_id=current_task.id AND execution_cycle=current_task.execution_cycle)
      AND EXISTS (SELECT 1 FROM control_generations WHERE control_key='training' AND generation=1)`);
  const reset = () => {
    db.exec("DELETE FROM runs; UPDATE tasks SET status='queued',assignee_id='e1',execution_cycle=1; UPDATE employees SET runtime_status='running'; UPDATE control_generations SET generation=1;");
  };
  db.prepare("UPDATE tasks SET status='working'").run();
  assert.equal(claim.run("status-race", 1, 1).changes, 0);
  reset(); db.prepare("UPDATE tasks SET assignee_id='e2'").run();
  assert.equal(claim.run("assignee-race", 1, 1).changes, 0);
  reset(); db.prepare("UPDATE tasks SET execution_cycle=2").run();
  assert.equal(claim.run("cycle-race", 1, 1).changes, 0);
  reset(); db.prepare("UPDATE employees SET runtime_status='exited' WHERE id='e1'").run();
  assert.equal(claim.run("runtime-race", 1, 1).changes, 0);
  reset(); db.prepare("INSERT INTO runs VALUES ('prior','t','e1',1,1)").run();
  assert.equal(claim.run("attempt-race", 1, 1).changes, 0);
  reset(); db.prepare("UPDATE control_generations SET generation=2").run();
  assert.equal(claim.run("generation-race", 1, 1).changes, 0);
  reset();
  assert.equal(claim.run("current", 1, 1).changes, 1);
  db.close();

  const assignBlock = companyRoute.slice(companyRoute.indexOf('action === "assignTask"'), companyRoute.indexOf('action === "askSecretary"'));
  assert.match(assignBlock, /WHERE id = \? AND status = 'queued'/);
  assert.match(assignBlock, /UPDATE employees[\s\S]*changes\(\) > 0/);
  assert.match(assignBlock, /INSERT INTO activity[\s\S]*WHERE changes\(\) > 0/);
  assert.match(assignBlock, /assignmentResults\[0\][\s\S]*status: 409/);
});

test("employee and helper containers use only the pinned immutable base image identity", () => {
  assert.match(reconciler, /base_image_id.*\^sha256:\[0-9a-f\]\{64\}/);
  assert.doesNotMatch(reconciler, /"\$base_image"(?!_id)/);
  assert.match(reconciler, /existing_actual_image_id=.*\{\{\.Image\}\}/);
  assert.match(reconciler, /existing_image_id.*base_image_id.*existing_actual_image_id.*base_image_id/);
  assert.match(reconciler, /set -- "\$@" "\$base_image_id"/);
  assert.match(bridgeRuntime, /OMC_BASE_IMAGE_ID/);
  assert.match(bridgeRuntime, /hrmImageIdentity.*sha256:\[0-9a-f\]\{64\}/s);
  assert.match(bridgeRuntime, /Ensure-SecretSource[\s\S]*\$ImageIdentity -c "exit 0"/);
  assert.match(bridgeRuntime, /one-man-company\.managed-kind=secret-source/);
  assert.match(bridgeRuntime, /actualImageIdentity -eq \$ImageIdentity[\s\S]*expectedMount/);
  assert.match(bridgeRuntime, /one-man-company\.managed-kind=hrm/);
  assert.match(bridgeRuntime, /actualHrmImageIdentity -ne \$hrmImageIdentity/);
  assert.match(bridgeRuntime, /hrmSocketMount/);
  assert.match(bridgeRuntime, /Refusing to replace \$hrmContainer because the name is occupied by an unrelated container/);
});

test("cache observations derive readiness from the current approved digest inside D1", () => {
  const observationBlock = trainingRoute.slice(trainingRoute.indexOf('action === "reportCacheObservation"'), trainingRoute.indexOf('action === "assignSkill"'));
  assert.doesNotMatch(observationBlock, /const cacheStatus/);
  assert.match(observationBlock, /cache_status = CASE[\s\S]*approved_digest = \?[\s\S]*THEN 'cached'/);
  assert.match(observationBlock, /FROM training_center_skills WHERE id = \? AND changes\(\) > 0/);

  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE skill (approved_digest TEXT, observed_digest TEXT, cache_status TEXT);
    INSERT INTO skill VALUES ('new','old','drifted');`);
  const observe = db.prepare(`UPDATE skill SET observed_digest=?, cache_status=CASE
    WHEN ?!='observed' THEN 'failed' WHEN approved_digest=? THEN 'cached'
    WHEN approved_digest IS NOT NULL THEN 'drifted' ELSE 'observed' END`);
  observe.run("new", "observed", "new");
  assert.deepEqual({ ...db.prepare("SELECT * FROM skill").get() }, { approved_digest: "new", observed_digest: "new", cache_status: "cached" });
  db.exec("UPDATE skill SET approved_digest='old',observed_digest='old',cache_status='cached'");
  observe.run("new", "observed", "new");
  assert.equal(db.prepare("SELECT cache_status FROM skill").get().cache_status, "drifted");
  db.exec("UPDATE skill SET approved_digest=observed_digest,cache_status='cached'");
  assert.equal(db.prepare("SELECT cache_status FROM skill").get().cache_status, "cached");
  db.close();
});

test("executor progress, failure, and expiry effects cannot resurrect a terminal run", () => {
  const heartbeatBlock = executorRoute.slice(executorRoute.indexOf('if (action === "heartbeat")'), executorRoute.indexOf('if (action === "event")'));
  assert.match(heartbeatBlock, /worker_id = \? AND status IN \$\{ACTIVE_RUNS\}/);
  const eventBlock = executorRoute.slice(executorRoute.indexOf('if (action === "event")'), executorRoute.indexOf('if (action === "complete")'));
  assert.match(eventBlock, /activeRunExists[\s\S]*event_gate[\s\S]*worker_id = \?/);
  assert.ok(eventBlock.indexOf("UPDATE employees") < eventBlock.lastIndexOf("UPDATE agent_runs"));
  assert.match(eventBlock, /eventResults\.at\(-1\)\?\.meta\.changes/);
  const failBlock = executorRoute.slice(executorRoute.indexOf('if (action === "fail")'), executorRoute.indexOf('return Response.json({ error: "Unknown executor action"'));
  assert.match(failBlock, /failure_gate[\s\S]*worker_id = \?[\s\S]*status IN \$\{ACTIVE_RUNS\}/);
  assert.ok(failBlock.indexOf("UPDATE employees") < failBlock.lastIndexOf("UPDATE agent_runs"));
  assert.match(failBlock, /failureResults\.at\(-1\)\?\.meta\.changes/);
  const expiryBlock = executorRoute.slice(executorRoute.indexOf("async function recoverExpiredRuns"), executorRoute.indexOf("async function claimSecretaryInquiry"));
  assert.match(expiryBlock, /expiredRunExists[\s\S]*lease_expires_at < CURRENT_TIMESTAMP/);
  assert.ok(expiryBlock.indexOf("UPDATE employees") < expiryBlock.lastIndexOf("UPDATE agent_runs"));
  assert.match(expiryBlock, /UPDATE tasks[\s\S]*expiredRunExists/);
  assert.match(expiryBlock, /UPDATE secretary_inquiries[\s\S]*expiredRunExists/);
});

test("executor completion commits deterministic handoff knowledge before one terminal CAS", () => {
  const completeStart = executorRoute.indexOf('if (action === "complete")');
  const failStart = executorRoute.indexOf('if (action === "fail")');
  const completeBlock = executorRoute.slice(completeStart, failStart);
  assert.ok(completeStart > 0 && failStart > completeStart);
  assert.equal((completeBlock.match(/await d1\.batch/g) ?? []).length, 1);
  assert.doesNotMatch(completeBlock, /crypto\.randomUUID/);
  assert.match(completeBlock, /activeRunExists[\s\S]*status IN \('claimed', 'running'\)/);
  assert.match(completeBlock, /handoffId = `handoff-\$\{runId\}`/);
  assert.match(completeBlock, /knowledgeId = `knowledge-\$\{runId\}`/);
  const knowledgeInsert = completeBlock.indexOf("INSERT OR IGNORE INTO knowledge_entries");
  const handoffInsert = completeBlock.indexOf("INSERT OR IGNORE INTO contractor_handoffs");
  const terminalCas = completeBlock.lastIndexOf("statements.push(d1.prepare(`UPDATE agent_runs");
  const terminalBatch = completeBlock.indexOf("await d1.batch(statements)");
  assert.ok(knowledgeInsert > 0 && knowledgeInsert < handoffInsert && handoffInsert < terminalCas && terminalCas < terminalBatch);
  assert.match(completeBlock, /terminalResults\.at\(-1\)\?\.meta\.changes/);
  assert.match(completeBlock, /rejectedContractorHandoff[\s\S]*resultStatus = "needs_input"/);
  assert.doesNotMatch(completeBlock, /contractor completion requires reusable handoff knowledge[\s\S]*status: 400/i);
});

test("folder reservation survives revoke and is released only by exact verified removal", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE employee_skills (
    employee_id TEXT NOT NULL, skill_id TEXT NOT NULL, folder_key TEXT COLLATE NOCASE NOT NULL,
    desired_state TEXT NOT NULL, assignment_version INTEGER NOT NULL,
    PRIMARY KEY(employee_id, skill_id), UNIQUE(employee_id, folder_key COLLATE NOCASE)
  )`);
  db.prepare("INSERT INTO employee_skills VALUES (?,?,?,?,?)").run("e", "a", "Shared", "revoked", 2);
  assert.throws(() => db.prepare("INSERT INTO employee_skills VALUES (?,?,?,?,?)").run("e", "b", "shared", "assigned", 1));
  db.prepare("DELETE FROM employee_skills WHERE employee_id=? AND skill_id=? AND desired_state='revoked' AND assignment_version=?").run("e", "a", 2);
  db.prepare("INSERT INTO employee_skills VALUES (?,?,?,?,?)").run("e", "b", "shared", "assigned", 1);
  assert.deepEqual({ ...db.prepare("SELECT skill_id, desired_state FROM employee_skills").get() }, { skill_id: "b", desired_state: "assigned" });
  db.close();
});

test("verified removal releases a folder without reusing an old assignment generation", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE employee_skills (
    employee_id TEXT NOT NULL, skill_id TEXT NOT NULL, folder_key TEXT NOT NULL,
    desired_state TEXT NOT NULL, assignment_version INTEGER NOT NULL,
    PRIMARY KEY(employee_id, skill_id)
  );
  CREATE TABLE training_sync_history (
    id INTEGER PRIMARY KEY, employee_id TEXT NOT NULL, skill_id TEXT NOT NULL,
    operation TEXT NOT NULL, assignment_version INTEGER NOT NULL
  );`);
  const assign = db.prepare(`INSERT INTO employee_skills
      (employee_id,skill_id,folder_key,desired_state,assignment_version)
    SELECT ?,?,?,'assigned',COALESCE((SELECT MAX(assignment_version)+1 FROM training_sync_history
      WHERE employee_id=? AND skill_id=?),1)
    ON CONFLICT(employee_id,skill_id) DO UPDATE SET desired_state='assigned',
      assignment_version=MAX(employee_skills.assignment_version+1,excluded.assignment_version)`);
  assign.run("e", "s", "alpha", "e", "s");
  assert.equal(db.prepare("SELECT assignment_version AS version FROM employee_skills").get().version, 1);
  db.prepare("INSERT INTO training_sync_history VALUES (1,'e','s','install',1)").run();
  db.prepare("UPDATE employee_skills SET desired_state='revoked',assignment_version=assignment_version+1").run();
  db.prepare("INSERT INTO training_sync_history VALUES (2,'e','s','remove',2)").run();
  db.prepare("DELETE FROM employee_skills WHERE employee_id='e' AND skill_id='s' AND desired_state='revoked' AND assignment_version=2").run();
  assign.run("e", "s", "alpha", "e", "s");
  assert.equal(db.prepare("SELECT assignment_version AS version FROM employee_skills").get().version, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM training_sync_history WHERE assignment_version=3").get().count, 0);
  assert.match(trainingRoute, /MAX\(h\.assignment_version\) \+ 1/);
  db.close();
});

test("existing D1 employee-skill rows upgrade to non-null timestamp and folder invariants", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE training_center_skills (
    id TEXT PRIMARY KEY, package_ref TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '', source_url TEXT, install_command TEXT NOT NULL,
    cache_status TEXT NOT NULL DEFAULT 'requested', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    cached_at TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE employee_skills (
    employee_id TEXT NOT NULL, skill_id TEXT NOT NULL,
    desired_state TEXT NOT NULL DEFAULT 'assigned', assignment_version INTEGER NOT NULL DEFAULT 1,
    assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT,
    PRIMARY KEY(employee_id, skill_id)
  );
  CREATE TABLE training_sync_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL UNIQUE,
    employee_id TEXT NOT NULL, skill_id TEXT NOT NULL, operation TEXT NOT NULL,
    assignment_version INTEGER NOT NULL, status TEXT NOT NULL, manifest_version TEXT,
    source_hash TEXT, verified_hash TEXT, evidence TEXT NOT NULL, worker_id TEXT NOT NULL,
    attempts INTEGER NOT NULL, verified_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  INSERT INTO training_center_skills (id,package_ref,name,install_command) VALUES
    ('s','owner/repo@alpha','Alpha','npx skills add owner/repo@alpha -y'),
    ('t','other/repo@ALPHA','Also Alpha','npx skills add other/repo@ALPHA -y');
  INSERT INTO employee_skills (employee_id,skill_id,updated_at) VALUES ('e','s',NULL), ('e','t',NULL);`);
  for (const migration of [migration9, migration10]) {
    for (const statement of migration.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) db.exec(statement);
  }
  const columns = Object.fromEntries(db.prepare("PRAGMA table_info(employee_skills)").all().map((row) => [row.name, row]));
  assert.equal(columns.folder_key.notnull, 1);
  assert.equal(columns.updated_at.notnull, 1);
  assert.deepEqual(db.prepare("SELECT skill_id, folder_key, updated_at IS NOT NULL AS has_updated FROM employee_skills ORDER BY skill_id").all().map((row) => ({ ...row })), [
    { skill_id: "s", folder_key: "alpha", has_updated: 1 },
    { skill_id: "t", folder_key: "legacy-reservation-2-1", has_updated: 1 },
  ]);
  assert.deepEqual(db.prepare("SELECT id, folder_key, cache_status, observation_status FROM training_center_skills ORDER BY id").all().map((row) => ({ ...row })), [
    { id: "s", folder_key: "alpha", cache_status: "requested", observation_status: null },
    { id: "t", folder_key: null, cache_status: "failed", observation_status: "failed" },
  ]);
  assert.throws(() => db.prepare("INSERT INTO employee_skills (employee_id,skill_id,folder_key) VALUES ('e','other','ALPHA')").run());
  assert.throws(() => db.prepare(`INSERT INTO training_center_skills
    (id,package_ref,name,install_command,folder_key) VALUES ('u','third/repo@Alpha','Alias','npx','ALPHA')`).run());
  const employeeIndex = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_employee_skills_employee_folder'").get().sql;
  const catalogIndex = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_training_skills_folder'").get().sql;
  assert.match(employeeIndex, /COLLATE NOCASE/i);
  assert.match(catalogIndex, /COLLATE NOCASE/i);
  db.close();
});

test("runtime database ensure canonicalizes legacy aliases before recreating global indexes", () => {
  const dropCatalog = ensureSource.indexOf('DROP INDEX idx_training_skills_folder');
  const catalogBackfill = ensureSource.indexOf('const catalogBackfill');
  const dropEmployee = ensureSource.indexOf('DROP INDEX idx_employee_skills_employee_folder');
  const assignmentBackfill = ensureSource.indexOf('const assignmentBackfill');
  assert.ok(dropCatalog > 0 && dropCatalog < catalogBackfill);
  assert.ok(dropEmployee > 0 && dropEmployee < assignmentBackfill);
  assert.match(ensureSource, /catalogFolderIndex\?\.sql && !\/COLLATE\\s\+NOCASE\/i/);
  assert.match(ensureSource, /employeeFolderIndex\?\.sql && !\/COLLATE\\s\+NOCASE\/i/);
  assert.match(ensureSource, /idx_training_skills_folder ON training_center_skills\(folder_key COLLATE NOCASE\)/);
  assert.match(ensureSource, /idx_employee_skills_employee_folder ON employee_skills\(employee_id, folder_key COLLATE NOCASE\)/);
  assert.match(ensureSource, /WHERE NOT EXISTS \(SELECT 1 FROM training_center_skills existing[\s\S]*existing\.folder_key = \? COLLATE NOCASE/);
});

test("policy integrity, no-op fingerprinting, and whole-manifest evidence are explicit", () => {
  assert.match(reconciler, /policy_template_version="3"/);
  assert.match(reconciler, /actual_policy_hash/);
  assert.match(reconciler, /existing_policy_version.*policy_version/);
  assert.match(reconciler, /previous_fingerprint.*reconcile_fingerprint/);
  assert.match(reconciler, /integrity_audit_seconds/);
  assert.match(reconciler, /current_container_state" == running[\s\S]*actual_active_folders/);
  assert.match(reconciler, /current_container_state" == running[\s\S]*actual_policy_hash/);
  assert.match(reconciler, /rm -f -- "\$fingerprint_file"/);
  assert.match(reconciler, /training_report_failure_marker/);
  assert.match(reconciler, /manifest_contract=.*skills.*removals/);
  assert.match(trainingRoute, /eventKey = `training:.*:m\$\{manifestVersion\}/);
});

test("Training Room shows locked controls, live observations, accurate failure time, and retry", () => {
  assert.match(trainingUi, /\/api\/owner-session/);
  assert.match(trainingUi, /type="password"/);
  assert.match(trainingUi, /setCredential\(""\)/);
  assert.match(trainingUi, /setInterval\(load, 5000\)/);
  assert.match(trainingUi, /CEO controls unlocked \(8h\)/);
  assert.match(trainingUi, /method: "DELETE"/);
  assert.match(trainingUi, /if \(!training && error\)/);
  assert.match(trainingUi, />Retry</);
  assert.match(trainingUi, /assignment\.desiredUpdatedAt/);
  assert.match(trainingUi, /event\.status === "verified" \? event\.verifiedAt.*: event\.updatedAt/);
  assert.match(trainingUi, /Recorded observations/);
  assert.match(trainingUi, /Latest 100/);
  assert.match(trainingUi, /Assignment \{event\.assignmentVersion\}/);
  assert.match(trainingUi, /Manifest <code title=\{event\.manifestVersion/);
  assert.match(trainingUi, /Queue character import/);
  assert.match(trainingUi, /Import-Character\.ps1 -Slug/);
});
