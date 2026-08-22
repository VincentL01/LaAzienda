[CmdletBinding()]
param([switch]$DispatcherOnly)

$ErrorActionPreference = "Stop"
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$suffix = [Guid]::NewGuid().ToString("N").Substring(0, 12)
$image = "omc-test-skill-sync:$suffix"
$skillsVolume = "omc-test-skill-sync-$suffix-skills"
$workspaceVolume = "omc-test-skill-sync-$suffix-workspace"
$installedSkillsVolume = "omc-test-skill-sync-$suffix-installed"
$dispatcherVolume = "omc-test-skill-sync-$suffix-dispatcher"
$liveContainer = "omc-test-skill-sync-$suffix-live"

if ($image -notmatch '^omc-test-skill-sync:[a-f0-9]{12}$' -or
    $skillsVolume -notmatch '^omc-test-skill-sync-[a-f0-9]{12}-skills$' -or
    $workspaceVolume -notmatch '^omc-test-skill-sync-[a-f0-9]{12}-workspace$' -or
    $installedSkillsVolume -notmatch '^omc-test-skill-sync-[a-f0-9]{12}-installed$' -or
    $dispatcherVolume -notmatch '^omc-test-skill-sync-[a-f0-9]{12}-dispatcher$' -or
    $liveContainer -notmatch '^omc-test-skill-sync-[a-f0-9]{12}-live$') {
  throw "Refusing unsafe disposable Docker artifact names."
}

function Invoke-Docker([string[]]$Arguments) {
  & docker @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Docker command failed: docker $($Arguments -join ' ')" }
}

function Invoke-Setup([string]$Script) {
  Invoke-Docker @(
    "run", "--rm", "--user", "0",
    "--volume", "${skillsVolume}:/opt/assigned-skills",
    "--volume", "${workspaceVolume}:/workspace",
    "--volume", "${installedSkillsVolume}:/workspace/.agents/skills",
    "--entrypoint", "bash", $image, "-c", $Script
  )
}

function Invoke-Sync([string[]]$ExtraEnvironment = @()) {
  $arguments = @(
    "run", "--rm", "--user", "1001:1001",
    "--env", "OMC_EMPLOYEE_ID=employee-integration-test"
  )
  foreach ($entry in $ExtraEnvironment) { $arguments += @("--env", $entry) }
  $arguments += @(
    # The employee container receives this volume read-only. The HRM-owned,
    # stopped-container helper is the sole writer for transaction journals.
    "--volume", "${skillsVolume}:/opt/assigned-skills",
    "--volume", "${workspaceVolume}:/workspace",
    "--volume", "${installedSkillsVolume}:/workspace/.agents/skills",
    "--entrypoint", "/usr/local/bin/sync-company-skills", $image
  )
  Invoke-Docker $arguments
}

function Invoke-SyncFailure([string[]]$ExtraEnvironment = @()) {
  $arguments = @(
    "run", "--rm", "--user", "1001:1001",
    "--env", "OMC_EMPLOYEE_ID=employee-integration-test"
  )
  foreach ($entry in $ExtraEnvironment) { $arguments += @("--env", $entry) }
  $arguments += @(
    "--volume", "${skillsVolume}:/opt/assigned-skills",
    "--volume", "${workspaceVolume}:/workspace",
    "--volume", "${installedSkillsVolume}:/workspace/.agents/skills",
    "--entrypoint", "/usr/local/bin/sync-company-skills", $image
  )
  & docker @arguments | Out-Null
  if ($LASTEXITCODE -eq 0) { throw "An unsafe or injected sync unexpectedly succeeded." }
}

function Invoke-UncatchableSyncFailure([string[]]$ExtraEnvironment) {
  $arguments = @(
    "run", "--rm", "--user", "1001:1001",
    "--env", "OMC_EMPLOYEE_ID=employee-integration-test"
  )
  foreach ($entry in $ExtraEnvironment) { $arguments += @("--env", $entry) }
  $arguments += @(
    "--volume", "${skillsVolume}:/opt/assigned-skills",
    "--volume", "${workspaceVolume}:/workspace",
    "--volume", "${installedSkillsVolume}:/workspace/.agents/skills",
    # A container's namespace-init PID cannot self-SIGKILL. Keep Bash as PID 1
    # so sync runs as a killable child, matching a daemon-killed worker crash.
    "--entrypoint", "bash", $image, "-c",
    '/usr/local/bin/sync-company-skills; status=$?; exit "$status"'
  )
  & docker @arguments | Out-Null
  if ($LASTEXITCODE -eq 0) { throw "The uncatchable worker crash unexpectedly returned success." }
}

function Invoke-Recover() {
  Invoke-Docker @(
    "run", "--rm", "--user", "1001:1001",
    "--env", "OMC_EMPLOYEE_ID=employee-integration-test",
    "--volume", "${skillsVolume}:/opt/assigned-skills",
    "--volume", "${workspaceVolume}:/workspace",
    "--volume", "${installedSkillsVolume}:/workspace/.agents/skills",
    "--entrypoint", "/usr/local/bin/sync-company-skills", $image,
    "--recover"
  )
}

function Get-WorkspaceHash([string]$Folder) {
  $value = (& docker run --rm --user 1001:1001 --volume "${workspaceVolume}:/workspace:ro" `
    --volume "${installedSkillsVolume}:/workspace/.agents/skills:ro" `
    --entrypoint /usr/local/bin/sync-company-skills $image --hash-workspace $Folder).Trim()
  if ($LASTEXITCODE -ne 0) { throw "Could not hash workspace folder $Folder." }
  return $value
}

function Get-AppliedStateHash() {
  $value = (& docker run --rm --user 1001:1001 --volume "${workspaceVolume}:/workspace:ro" `
    --entrypoint sha256sum $image /workspace/.company/training/applied.json).Trim().Split(" ")[0]
  if ($LASTEXITCODE -ne 0 -or $value -notmatch '^[a-f0-9]{64}$') {
    throw "Could not hash the independently published training state."
  }
  return $value
}

function Get-WorkspaceFolders() {
  $lines = @(& docker run --rm --user 1001:1001 --volume "${workspaceVolume}:/workspace:ro" `
    --volume "${installedSkillsVolume}:/workspace/.agents/skills:ro" `
    --entrypoint /usr/local/bin/sync-company-skills $image --list-workspace-folders)
  if ($LASTEXITCODE -ne 0) { throw "Could not enumerate active workspace skill folders." }
  return @($lines | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

function Test-ExactWorkspaceFolders([string[]]$Expected) {
  $actual = @(Get-WorkspaceFolders)
  $wanted = @($Expected | Sort-Object -Unique)
  if ($actual.Count -ne $wanted.Count) { return $false }
  return (@(Compare-Object -ReferenceObject $wanted -DifferenceObject $actual).Count -eq 0)
}

function Test-DispatcherRecoveryContract() {
  $companyLoopPath = Join-Path $repoRoot "runtime\hrm\company-loop.sh"
  $harness = @'
set -Eeuo pipefail
sed '/^case "$dispatcher_state_root"/,$d' /fixture/company-loop.sh > /tmp/company-loop-functions.sh
. /tmp/company-loop-functions.sh

mkdir -p "$terminal_outbox"
chmod 0700 "$dispatcher_state_root" "$terminal_outbox"
docker_log=/tmp/docker.log
post_log=/tmp/post.log
docker_mode=restart_ok
post_mode=success
result_mode=unavailable
known_id=1111111111111111111111111111111111111111111111111111111111111111
alternate_id=2222222222222222222222222222222222222222222222222222222222222222
docker_stopped=false
docker_restarted=false

docker() {
  printf '%s\n' "$*" >> "$docker_log"
  docker_target="${*: -1}"
  case "$1 $2" in
    "container inspect")
      case "$docker_mode" in
        absent) printf '%s\n' "Error response from daemon: No such container: $docker_target" >&2; return 1 ;;
        inspect_unavailable) printf '%s\n' 'permission denied while trying to connect to the Docker socket' >&2; return 1 ;;
      esac
      if [ "$docker_mode" = identity_swap ] && [ "$docker_restarted" = true ]; then
        printf '%s\n' "$alternate_id|running|false"
      elif [ "$docker_stopped" = true ]; then
        printf '%s\n' "$known_id|exited|false"
      else
        printf '%s\n' "$known_id|running|false"
      fi
      return 0
      ;;
    "restart $known_id")
      docker_restarted=true
      case "$docker_mode" in restart_ok|identity_swap) return 0 ;; *) return 1 ;; esac
      ;;
    "stop $known_id")
      if [ "$docker_mode" = stop_ok ]; then docker_stopped=true; return 0; fi
      return 1
      ;;
    *) return 1 ;;
  esac
}

post_run_action() {
  printf '%s\n' "$1" >> "$post_log"
  [ "$post_mode" = success ]
}

read_result_json() {
  case "$result_mode" in
    valid) printf '%s' '{"status":"completed","summary":"A complete and trustworthy result.","current_state":"Ready for review.","deliverables":[],"decisions":[],"follow_up":[],"knowledge":"Reusable company knowledge."}' ;;
    partial) printf '%s' '{"summary":"A file happened to exist."}' ;;
    whitespace) printf '%s' '{"status":"completed","summary":"A complete and trustworthy result.","current_state":"Ready for review.","deliverables":[],"decisions":[],"follow_up":[],"knowledge":"                              "}' ;;
    *) return 65 ;;
  esac
}

marker_payload() {
  marker_phase="${4:-executing}"
  marker_status="${5:--1}"
  if [ "$marker_phase" = executing ]; then
    jq -nc --arg runId "$1" --arg safeRun "$1" --arg containerName "$2" --arg containerId "$3" \
      '{runId:$runId,safeRun:$safeRun,containerName:$containerName,containerId:$containerId,phase:"executing",executionStatus:null}'
  else
    jq -nc --arg runId "$1" --arg safeRun "$1" --arg containerName "$2" --arg containerId "$3" --argjson status "$marker_status" \
      '{runId:$runId,safeRun:$safeRun,containerName:$containerName,containerId:$containerId,phase:"post-exec",executionStatus:$status}'
  fi
}

failed_payload() {
  jq -nc --arg action fail --arg workerId "$worker_id" --arg runId "$1" \
    --arg failureCode execution_failed \
    '{action:$action,workerId:$workerId,runId:$runId,failureCode:$failureCode}'
}

# Power loss with only an executing marker must fail conservatively even if a
# schema-valid result file happens to exist from an earlier/partial process.
: > "$docker_log"
result_mode=valid
docker_mode=restart_ok
docker_stopped=false
docker_restarted=false
atomic_write_json "$active_marker" "$(marker_payload run-marker-only employee-one "$known_id")"
recover_interrupted_run
[ ! -e "$active_marker" ]
[ -f "$terminal_outbox/run-marker-only.json" ]
jq -e '.action == "fail" and .runId == "run-marker-only"' "$terminal_outbox/run-marker-only.json" >/dev/null
grep -Fx "restart $known_id" "$docker_log" >/dev/null
rm -f -- "$terminal_outbox/run-marker-only.json"

# Power loss after both marker and terminal publication: never overwrite the
# already-durable terminal result, but still quiesce before clearing the marker.
: > "$docker_log"
docker_restarted=false
atomic_write_json "$active_marker" "$(marker_payload run-marker-outbox employee-two "$known_id")"
atomic_write_json "$terminal_outbox/run-marker-outbox.json" "$(failed_payload run-marker-outbox)"
terminal_before="$(sha256sum "$terminal_outbox/run-marker-outbox.json" | awk '{print $1}')"
recover_interrupted_run
[ ! -e "$active_marker" ]
[ "$terminal_before" = "$(sha256sum "$terminal_outbox/run-marker-outbox.json" | awk '{print $1}')" ]
grep -Fx "restart $known_id" "$docker_log" >/dev/null
rm -f -- "$terminal_outbox/run-marker-outbox.json"

# Only a durably recorded zero exit plus the complete result schema can recover
# as success. A partial JSON object at the same phase becomes a failure.
docker_restarted=false
result_mode=valid
atomic_write_json "$active_marker" "$(marker_payload run-post-exec employee-five "$known_id" post-exec 0)"
recover_interrupted_run
jq -e '.action == "complete" and .runId == "run-post-exec"' "$terminal_outbox/run-post-exec.json" >/dev/null
rm -f -- "$terminal_outbox/run-post-exec.json"

docker_restarted=false
result_mode=partial
atomic_write_json "$active_marker" "$(marker_payload run-partial-result employee-six "$known_id" post-exec 0)"
recover_interrupted_run
jq -e '.action == "fail" and .runId == "run-partial-result"' "$terminal_outbox/run-partial-result.json" >/dev/null
rm -f -- "$terminal_outbox/run-partial-result.json"

docker_restarted=false
result_mode=whitespace
atomic_write_json "$active_marker" "$(marker_payload run-whitespace-result employee-eight "$known_id" post-exec 0)"
recover_interrupted_run
jq -e '.action == "fail" and .runId == "run-whitespace-result"' "$terminal_outbox/run-whitespace-result.json" >/dev/null
rm -f -- "$terminal_outbox/run-whitespace-result.json"

# Power loss after marker clearance leaves only the outbox. Startup recovery is
# a no-op; successful acknowledgement removes exactly that durable record.
: > "$docker_log"
: > "$post_log"
atomic_write_json "$terminal_outbox/run-outbox-only.json" "$(failed_payload run-outbox-only)"
recover_interrupted_run
[ ! -s "$docker_log" ]
drain_terminal_outbox
[ ! -e "$terminal_outbox/run-outbox-only.json" ]
jq -e '.runId == "run-outbox-only"' "$post_log" >/dev/null

# A control-plane refusal preserves the outbox. The production loop checks this
# result before reconciliation and claiming (also source-ordered in unit tests).
post_mode=fail
atomic_write_json "$terminal_outbox/run-refused.json" "$(failed_payload run-refused)"
if drain_terminal_outbox; then exit 91; else refusal_status=$?; fi
[ "$refusal_status" -eq 1 ]
[ -f "$terminal_outbox/run-refused.json" ]
rm -f -- "$terminal_outbox/run-refused.json"

# Restart failure is acceptable only when stop plus independent inspection
# proves an exited state. If stop also fails, propagate 75 and refuse claims.
: > "$docker_log"
docker_mode=stop_ok
docker_stopped=false
docker_restarted=false
quiesce_container employee-three
grep -Fx "restart $known_id" "$docker_log" >/dev/null
grep -Fx "stop $known_id" "$docker_log" >/dev/null

: > "$docker_log"
docker_mode=fail_all
docker_stopped=false
docker_restarted=false
if quiesce_container employee-four; then exit 92; else quiesce_status=$?; fi
[ "$quiesce_status" -eq 75 ]
grep -Fx "restart $known_id" "$docker_log" >/dev/null
grep -Fx "stop $known_id" "$docker_log" >/dev/null

# A positively identified not-found result is safe. Socket/permission failures
# and a post-restart identity swap retain the boundary and fail closed.
: > "$docker_log"
docker_mode=absent
quiesce_container employee-absent
! grep -F 'restart ' "$docker_log" >/dev/null

: > "$docker_log"
docker_mode=inspect_unavailable
if quiesce_container employee-unknown; then exit 93; else inspect_status=$?; fi
[ "$inspect_status" -eq 75 ]

: > "$docker_log"
docker_mode=identity_swap
docker_stopped=false
docker_restarted=false
if quiesce_container employee-swapped; then exit 94; else identity_status=$?; fi
[ "$identity_status" -eq 75 ]
grep -Fx "restart $known_id" "$docker_log" >/dev/null

# These functions are routinely invoked through if/||, where POSIX set -e is
# suppressed. Inject persistence failures and prove explicit returns preserve
# the prior marker/outbox and remove every unpublished temporary.
docker_mode=restart_ok
post_mode=success
stable_target="$dispatcher_state_root/persistence.json"
atomic_write_json "$stable_target" '{"version":1}'
sync() { return 1; }
if atomic_write_json "$stable_target" '{"version":2}'; then exit 95; else persistence_status=$?; fi
unset -f sync
[ "$persistence_status" -eq 74 ]
jq -e '.version == 1' "$stable_target" >/dev/null
[ -z "$(find "$dispatcher_state_root" -maxdepth 1 -name '.omc-publish-*' -print -quit)" ]

atomic_write_json "$active_marker" "$(marker_payload run-sync-failure employee-nine "$known_id")"
sync_calls=0
sync() { sync_calls=$((sync_calls + 1)); [ "$sync_calls" -lt 2 ]; }
if atomic_write_json "$active_marker" "$(marker_payload run-sync-failure employee-nine "$known_id" post-exec 0)"; then exit 99; else directory_sync_status=$?; fi
unset -f sync
[ "$directory_sync_status" -eq 74 ]
[ -f "$active_marker" ]
jq -e '.phase == "post-exec" and .executionStatus == 0' "$active_marker" >/dev/null
rm -f -- "$active_marker"

mv() { return 1; }
if queue_terminal_action run-move-failure "$(failed_payload run-move-failure)"; then exit 96; else move_status=$?; fi
unset -f mv
[ "$move_status" -eq 74 ]
[ ! -e "$terminal_outbox/run-move-failure.json" ]

atomic_write_json "$terminal_outbox/run-remove-failure.json" "$(failed_payload run-remove-failure)"
rm() { return 1; }
if drain_terminal_outbox; then exit 97; else remove_status=$?; fi
unset -f rm
[ "$remove_status" -eq 74 ]
[ -f "$terminal_outbox/run-remove-failure.json" ]
rm -f -- "$terminal_outbox/run-remove-failure.json"

atomic_write_json "$active_marker" "$(marker_payload run-clear-failure employee-seven "$known_id")"
active_container="$known_id"
rm() { return 1; }
if clear_active_marker; then exit 98; else clear_status=$?; fi
unset -f rm
[ "$clear_status" -eq 74 ]
[ -f "$active_marker" ]
[ "$active_container" = "$known_id" ]
rm -f -- "$active_marker"
'@

  Invoke-Docker @(
    "run", "--rm", "--user", "0",
    "--volume", "${dispatcherVolume}:/workspace",
    "--volume", "${companyLoopPath}:/fixture/company-loop.sh:ro",
    "--entrypoint", "bash", $image, "-c", $harness
  )
}

try {
  Invoke-Docker @("build", "--tag", $image, (Join-Path $repoRoot "runtime\agent"))
  Invoke-Docker @("volume", "create", $skillsVolume)
  Invoke-Docker @("volume", "create", $workspaceVolume)
  Invoke-Docker @("volume", "create", $installedSkillsVolume)
  Invoke-Docker @("volume", "create", $dispatcherVolume)

  Test-DispatcherRecoveryContract
  if ($DispatcherOnly) {
    Write-Output "PASS: dispatcher phase, identity, outbox, and persistence-failure recovery contracts."
    return
  }

  $initial = @'
set -Eeuo pipefail
version="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
mkdir -p "/opt/assigned-skills/.omc-candidates/$version/alpha" /workspace/.agents/skills/unmanaged
printf '%s\n' 'alpha version one' > "/opt/assigned-skills/.omc-candidates/$version/alpha/SKILL.md"
printf '%s\n' 'owner content' > /workspace/.agents/skills/unmanaged/NOTE.md
hash="$(/usr/local/bin/sync-company-skills --hash-candidate "$version" alpha)"
jq -nc --arg employeeId employee-integration-test --arg manifestVersion "$version" \
  '{schemaVersion:2,employeeId:$employeeId,manifestVersion:$manifestVersion,skills:[],removals:[]}' \
  > /opt/assigned-skills/.omc-training-prior.json
jq -nc --arg employeeId employee-integration-test --arg manifestVersion "$version" --arg hash "$hash" \
  '{schemaVersion:2,employeeId:$employeeId,manifestVersion:$manifestVersion,skills:[
    {id:"skill-alpha",packageRef:"test/skills@alpha",folder:"alpha",assignmentVersion:1,sourceHash:$hash}],removals:[]}' \
  > /opt/assigned-skills/.omc-training-manifest.json
chown -R 1001:1001 /opt/assigned-skills /workspace
'@
  Invoke-Setup $initial
  Invoke-Sync

  $changed = @'
set -Eeuo pipefail
cp /opt/assigned-skills/.omc-training-manifest.json /opt/assigned-skills/.omc-training-prior.json
version="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
mkdir -p "/opt/assigned-skills/.omc-candidates/$version/alpha" "/opt/assigned-skills/.omc-candidates/$version/beta"
printf '%s\n' 'alpha version two' > "/opt/assigned-skills/.omc-candidates/$version/alpha/SKILL.md"
printf '%s\n' 'beta version one' > "/opt/assigned-skills/.omc-candidates/$version/beta/SKILL.md"
chmod 0755 "/opt/assigned-skills/.omc-candidates/$version/alpha/SKILL.md"
alpha="$(/usr/local/bin/sync-company-skills --hash-candidate "$version" alpha)"
beta="$(/usr/local/bin/sync-company-skills --hash-candidate "$version" beta)"
jq -nc --arg employeeId employee-integration-test --arg manifestVersion "$version" --arg alpha "$alpha" --arg beta "$beta" \
  '{schemaVersion:2,employeeId:$employeeId,manifestVersion:$manifestVersion,skills:[
    {id:"skill-alpha",packageRef:"test/skills@alpha",folder:"alpha",assignmentVersion:1,sourceHash:$alpha},
    {id:"skill-beta",packageRef:"test/skills@beta",folder:"beta",assignmentVersion:1,sourceHash:$beta}],removals:[]}' \
  > /opt/assigned-skills/.omc-training-manifest.json
chown -R 1001:1001 /opt/assigned-skills
'@
  Invoke-Setup $changed
  Invoke-Sync
  $verifyChanged = @'
set -Eeuo pipefail
version="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
test -f /workspace/.agents/skills/unmanaged/NOTE.md
test "$(/usr/local/bin/sync-company-skills --hash-candidate "$version" alpha)" = "$(/usr/local/bin/sync-company-skills --hash-workspace alpha)"
test "$(/usr/local/bin/sync-company-skills --hash-candidate "$version" beta)" = "$(/usr/local/bin/sync-company-skills --hash-workspace beta)"
test "$(stat -c '%a' /workspace/.agents/skills/alpha/SKILL.md)" = 755
'@
  Invoke-Docker @("run", "--rm", "--user", "1001:1001", "--volume", "${skillsVolume}:/opt/assigned-skills:ro", "--volume", "${workspaceVolume}:/workspace:ro", "--volume", "${installedSkillsVolume}:/workspace/.agents/skills:ro", "--entrypoint", "bash", $image, "-c", $verifyChanged)

  # Tamper with employee-owned evidence; it must never become delete authority.
  $revoke = @'
set -Eeuo pipefail
jq -nc '{schemaVersion:2,skills:[{folder:"unmanaged"}]}' > /workspace/.company/training/applied.json
cp /opt/assigned-skills/.omc-training-manifest.json /opt/assigned-skills/.omc-training-prior.json
version="cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
mkdir -p "/opt/assigned-skills/.omc-candidates/$version/beta"
printf '%s\n' 'beta version one' > "/opt/assigned-skills/.omc-candidates/$version/beta/SKILL.md"
beta="$(/usr/local/bin/sync-company-skills --hash-candidate "$version" beta)"
jq -nc --arg employeeId employee-integration-test --arg manifestVersion "$version" --arg beta "$beta" \
  '{schemaVersion:2,employeeId:$employeeId,manifestVersion:$manifestVersion,skills:[
    {id:"skill-beta",packageRef:"test/skills@beta",folder:"beta",assignmentVersion:1,sourceHash:$beta}],
    removals:[{id:"skill-alpha",folder:"alpha",assignmentVersion:2}]}' \
  > /opt/assigned-skills/.omc-training-manifest.json
chown -R 1001:1001 /opt/assigned-skills /workspace
'@
  Invoke-Setup $revoke
  Invoke-Sync
  Invoke-Docker @("run", "--rm", "--user", "1001:1001", "--volume", "${workspaceVolume}:/workspace:ro", "--volume", "${installedSkillsVolume}:/workspace/.agents/skills:ro", "--entrypoint", "bash", $image, "-c", "test ! -e /workspace/.agents/skills/alpha; test -f /workspace/.agents/skills/beta/SKILL.md; test -f /workspace/.agents/skills/unmanaged/NOTE.md")

  # Missing approved source fails before any live path is touched.
  $beforeLoss = Get-WorkspaceHash "beta"
  Invoke-Setup 'rm -rf /opt/assigned-skills/.omc-candidates/cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc/beta'
  Invoke-SyncFailure
  if ((Get-WorkspaceHash "beta") -ne $beforeLoss) { throw "Cache loss changed the last verified workspace state." }

  # A failure after the first commit operation rolls back the complete set.
  $transaction = @'
set -Eeuo pipefail
cp /opt/assigned-skills/.omc-training-manifest.json /opt/assigned-skills/.omc-training-prior.json
version="dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
mkdir -p "/opt/assigned-skills/.omc-candidates/$version/beta" "/opt/assigned-skills/.omc-candidates/$version/gamma"
printf '%s\n' 'beta version two' > "/opt/assigned-skills/.omc-candidates/$version/beta/SKILL.md"
printf '%s\n' 'gamma version one' > "/opt/assigned-skills/.omc-candidates/$version/gamma/SKILL.md"
beta="$(/usr/local/bin/sync-company-skills --hash-candidate "$version" beta)"
gamma="$(/usr/local/bin/sync-company-skills --hash-candidate "$version" gamma)"
jq -nc --arg employeeId employee-integration-test --arg manifestVersion "$version" --arg beta "$beta" --arg gamma "$gamma" \
  '{schemaVersion:2,employeeId:$employeeId,manifestVersion:$manifestVersion,skills:[
    {id:"skill-beta",packageRef:"test/skills@beta",folder:"beta",assignmentVersion:1,sourceHash:$beta},
    {id:"skill-gamma",packageRef:"test/skills@gamma",folder:"gamma",assignmentVersion:1,sourceHash:$gamma}],removals:[]}' \
  > /opt/assigned-skills/.omc-training-manifest.json
chown -R 1001:1001 /opt/assigned-skills
'@
  Invoke-Setup $transaction
  $beforeRollback = Get-WorkspaceHash "beta"
  Invoke-SyncFailure -ExtraEnvironment @("OMC_SYNC_FAIL_AFTER_JOURNALS=1")
  if ((Get-WorkspaceHash "beta") -ne $beforeRollback) { throw "Write-ahead interruption changed beta before its first move." }
  Invoke-Docker @("run", "--rm", "--user", "1001:1001", "--volume", "${workspaceVolume}:/workspace:ro", "--volume", "${installedSkillsVolume}:/workspace/.agents/skills:ro", "--entrypoint", "bash", $image, "-c", "test ! -e /workspace/.agents/skills/gamma")
  Invoke-SyncFailure -ExtraEnvironment @("OMC_SYNC_FAIL_AFTER_COMMITS=1")
  if ((Get-WorkspaceHash "beta") -ne $beforeRollback) { throw "Injected failure did not roll back beta." }
  Invoke-Docker @("run", "--rm", "--user", "1001:1001", "--volume", "${workspaceVolume}:/workspace:ro", "--volume", "${installedSkillsVolume}:/workspace/.agents/skills:ro", "--entrypoint", "bash", $image, "-c", "test ! -e /workspace/.agents/skills/gamma; test -f /workspace/.agents/skills/unmanaged/NOTE.md")
  Invoke-Sync

  # A SIGKILL after a durable workspace move cannot run an EXIT trap. Recovery
  # must therefore use only the HRM-owned journal snapshots, even when both the
  # mutable catalog candidate and active manifest have subsequently vanished.
  $crashTransaction = @'
set -Eeuo pipefail
cp /opt/assigned-skills/.omc-training-manifest.json /opt/assigned-skills/.omc-training-prior.json
version="ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
mkdir -p "/opt/assigned-skills/.omc-candidates/$version/beta" "/opt/assigned-skills/.omc-candidates/$version/gamma"
printf '%s\n' 'beta crash candidate' > "/opt/assigned-skills/.omc-candidates/$version/beta/SKILL.md"
printf '%s\n' 'gamma crash candidate' > "/opt/assigned-skills/.omc-candidates/$version/gamma/SKILL.md"
beta="$(/usr/local/bin/sync-company-skills --hash-candidate "$version" beta)"
gamma="$(/usr/local/bin/sync-company-skills --hash-candidate "$version" gamma)"
jq -nc --arg employeeId employee-integration-test --arg manifestVersion "$version" --arg beta "$beta" --arg gamma "$gamma" \
  '{schemaVersion:2,employeeId:$employeeId,manifestVersion:$manifestVersion,skills:[
    {id:"skill-beta",packageRef:"test/skills@beta",folder:"beta",assignmentVersion:2,sourceHash:$beta},
    {id:"skill-gamma",packageRef:"test/skills@gamma",folder:"gamma",assignmentVersion:2,sourceHash:$gamma}],removals:[]}' \
  > /opt/assigned-skills/.omc-training-manifest.json
chown -R 1001:1001 /opt/assigned-skills
'@
  Invoke-Setup $crashTransaction
  $beforeCrashBeta = Get-WorkspaceHash "beta"
  $beforeCrashGamma = Get-WorkspaceHash "gamma"
  $beforeCrashState = Get-AppliedStateHash
  Invoke-UncatchableSyncFailure -ExtraEnvironment @("OMC_SYNC_KILL_AFTER_MOVES=2")
  Invoke-Docker @("run", "--rm", "--user", "1001:1001", "--volume", "${skillsVolume}:/opt/assigned-skills:ro", "--entrypoint", "bash", $image, "-c", 'test -n "$(find /opt/assigned-skills/.omc-transactions -mindepth 1 -maxdepth 1 -name .omc-transaction-\* -print -quit)"')
  Invoke-Setup 'rm -rf /opt/assigned-skills/.omc-candidates/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff; rm -f /opt/assigned-skills/.omc-training-manifest.json'
  Invoke-Recover
  if ((Get-WorkspaceHash "beta") -ne $beforeCrashBeta) { throw "Crash recovery did not restore beta exactly." }
  if ((Get-WorkspaceHash "gamma") -ne $beforeCrashGamma) { throw "Crash recovery changed untouched gamma." }
  if ((Get-AppliedStateHash) -ne $beforeCrashState) { throw "Crash recovery rewrote independently published evidence." }
  Invoke-Docker @("run", "--rm", "--user", "1001:1001", "--volume", "${skillsVolume}:/opt/assigned-skills:ro", "--entrypoint", "bash", $image, "-c", 'test -z "$(find /opt/assigned-skills/.omc-transactions -mindepth 1 -maxdepth 1 \( -name .omc-transaction-\* -o -name .omc-preparing-\* \) -print -quit)"')
  Invoke-Setup 'cp /opt/assigned-skills/.omc-training-prior.json /opt/assigned-skills/.omc-training-manifest.json; chown 1001:1001 /opt/assigned-skills/.omc-training-manifest.json'

  # A running employee keeps the skill and state mounts read-only. The HRM
  # detects drift, stops the employee, repairs via its RW helper, then restarts.
  Invoke-Docker @("run", "--detach", "--name", $liveContainer, "--user", "1001:1001", "--env", "OMC_EMPLOYEE_ID=employee-integration-test", "--volume", "${skillsVolume}:/opt/assigned-skills:ro", "--volume", "${workspaceVolume}:/workspace", "--volume", "${installedSkillsVolume}:/workspace/.agents/skills:ro", "--entrypoint", "/bin/sleep", $image, "infinity")
  $running = (& docker inspect --format '{{.State.Running}}' $liveContainer).Trim()
  if ($LASTEXITCODE -ne 0 -or $running -ne "true") { throw "The disposable employee did not enter running state." }
  & docker exec $liveContainer touch /opt/assigned-skills/.employee-write-probe 2>$null
  if ($LASTEXITCODE -eq 0) { throw "The employee unexpectedly wrote the HRM-owned training volume." }
  & docker exec $liveContainer touch /workspace/.agents/skills/.employee-write-probe 2>$null
  if ($LASTEXITCODE -eq 0) { throw "The employee unexpectedly wrote the installed-skill volume." }
  Invoke-Setup 'printf "%s\n" live-drift >> /workspace/.agents/skills/gamma/SKILL.md; chown -R 1001:1001 /workspace/.agents/skills/gamma'
  Invoke-Docker @("stop", "--time", "1", $liveContainer)
  $running = (& docker inspect --format '{{.State.Running}}' $liveContainer).Trim()
  if ($LASTEXITCODE -ne 0 -or $running -ne "false") { throw "The employee was not quiesced before workspace mutation." }
  Invoke-Sync
  Invoke-Docker @("start", $liveContainer)
  $running = (& docker inspect --format '{{.State.Running}}' $liveContainer).Trim()
  if ($LASTEXITCODE -ne 0 -or $running -ne "true") { throw "The employee was not restarted after verified repair." }
  $candidateGammaAfterRestart = (& docker run --rm --user 1001:1001 --volume "${skillsVolume}:/opt/assigned-skills:ro" --entrypoint /usr/local/bin/sync-company-skills $image --hash-candidate dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd gamma).Trim()
  if ($LASTEXITCODE -ne 0 -or (Get-WorkspaceHash "gamma") -ne $candidateGammaAfterRestart) { throw "The restarted employee did not receive the repaired skill tree." }
  Invoke-Docker @("rm", "--force", $liveContainer)

  # Preserving an owner-created folder does not make it eligible for a task.
  # The same deterministic folder-list observation used by HRM must expose it.
  $activeFolders = @(Get-WorkspaceFolders)
  if ($activeFolders -notcontains "unmanaged") { throw "The active-folder observation hid an unmanaged skill." }
  if (Test-ExactWorkspaceFolders @("beta", "gamma")) { throw "An unmanaged active skill was accepted as the exact approved set." }

  # A separate post-action observation catches tampering.
  Invoke-Setup 'printf "%s\n" tampered >> /workspace/.agents/skills/gamma/SKILL.md; chown -R 1001:1001 /workspace'
  $candidateGamma = (& docker run --rm --user 1001:1001 --volume "${skillsVolume}:/opt/assigned-skills:ro" --entrypoint /usr/local/bin/sync-company-skills $image --hash-candidate dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd gamma).Trim()
  $workspaceGamma = Get-WorkspaceHash "gamma"
  if ($candidateGamma -eq $workspaceGamma) { throw "Forced post-action tampering was not detected by the independent read-back." }
  Invoke-Sync

  # Chmod-only drift changes the approved digest and fails closed.
  $beforeModeDrift = Get-WorkspaceHash "gamma"
  Invoke-Setup 'chmod 0755 /opt/assigned-skills/.omc-candidates/dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/gamma/SKILL.md'
  Invoke-SyncFailure
  if ((Get-WorkspaceHash "gamma") -ne $beforeModeDrift) { throw "Mode-only cache drift changed the verified workspace." }
  Invoke-Setup 'chmod 0644 /opt/assigned-skills/.omc-candidates/dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/gamma/SKILL.md'

  # Special and unreadable nodes are rejected without partial writes.
  Invoke-Setup 'mkfifo /opt/assigned-skills/.omc-candidates/dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/gamma/unsafe.fifo'
  Invoke-SyncFailure
  Invoke-Setup 'rm -f /opt/assigned-skills/.omc-candidates/dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/gamma/unsafe.fifo; printf secret > /opt/assigned-skills/.omc-candidates/dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/gamma/unreadable; chmod 000 /opt/assigned-skills/.omc-candidates/dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/gamma/unreadable'
  Invoke-SyncFailure
  Invoke-Setup 'chmod 0644 /opt/assigned-skills/.omc-candidates/dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/gamma/unreadable; rm -f /opt/assigned-skills/.omc-candidates/dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd/gamma/unreadable'

  # An archive producer failure is visible through Bash pipefail and rolls back.
  Invoke-Setup 'mkdir -p /workspace/fake-bin; printf "#!/bin/sh\nexit 7\n" > /workspace/fake-bin/tar; chmod 0755 /workspace/fake-bin/tar; chown -R 1001:1001 /workspace/fake-bin'
  Invoke-SyncFailure -ExtraEnvironment @("PATH=/workspace/fake-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
  Invoke-Docker @("run", "--rm", "--user", "1001:1001", "--volume", "${workspaceVolume}:/workspace:ro", "--volume", "${installedSkillsVolume}:/workspace/.agents/skills:ro", "--entrypoint", "bash", $image, "-c", "test -f /workspace/.agents/skills/unmanaged/NOTE.md")

  # No workspace root or ancestor may redirect operations through a symlink.
  Invoke-Setup 'mkdir -p /workspace/redirect; printf safe > /workspace/redirect/marker; ln -s /workspace/redirect /workspace/link; chown -h 1001:1001 /workspace/link; chown -R 1001:1001 /workspace/redirect'
  Invoke-SyncFailure -ExtraEnvironment @("OMC_WORKSPACE_SKILLS=/workspace/link/skills", "OMC_TRAINING_STATE=/workspace/.company/training-alt")
  Invoke-Docker @("run", "--rm", "--user", "1001:1001", "--volume", "${workspaceVolume}:/workspace:ro", "--entrypoint", "bash", $image, "-c", "test -f /workspace/redirect/marker; test ! -e /workspace/redirect/skills")

  # Canonical folders are lowercase, and Windows device aliases are rejected
  # even though this Linux engine could otherwise create either path.
  $portableNames = @'
set -Eeuo pipefail
jq -nc --arg employeeId employee-integration-test --arg manifestVersion "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" \
  '{schemaVersion:2,employeeId:$employeeId,manifestVersion:$manifestVersion,skills:[
    {id:"skill-uppercase",packageRef:"test/skills@Alpha",folder:"Alpha",assignmentVersion:1,sourceHash:"0000000000000000000000000000000000000000000000000000000000000000"}],removals:[]}' \
  > /opt/assigned-skills/.omc-uppercase-manifest.json
jq -nc --arg employeeId employee-integration-test --arg manifestVersion "9999999999999999999999999999999999999999999999999999999999999999" \
  '{schemaVersion:2,employeeId:$employeeId,manifestVersion:$manifestVersion,skills:[
    {id:"skill-device",packageRef:"test/skills@con",folder:"con",assignmentVersion:1,sourceHash:"0000000000000000000000000000000000000000000000000000000000000000"}],removals:[]}' \
  > /opt/assigned-skills/.omc-reserved-manifest.json
chown 1001:1001 /opt/assigned-skills/.omc-uppercase-manifest.json /opt/assigned-skills/.omc-reserved-manifest.json
'@
  Invoke-Setup $portableNames
  Invoke-SyncFailure -ExtraEnvironment @("OMC_SKILL_MANIFEST=/opt/assigned-skills/.omc-uppercase-manifest.json")
  Invoke-SyncFailure -ExtraEnvironment @("OMC_SKILL_MANIFEST=/opt/assigned-skills/.omc-reserved-manifest.json")
  Invoke-Docker @("run", "--rm", "--user", "1001:1001", "--volume", "${workspaceVolume}:/workspace:ro", "--volume", "${installedSkillsVolume}:/workspace/.agents/skills:ro", "--entrypoint", "bash", $image, "-c", "test ! -e /workspace/.agents/skills/Alpha; test ! -e /workspace/.agents/skills/con")

  Write-Output "PASS: live employees are quiesced before the HRM helper mutates installed skills."
  Write-Output "PASS: unmanaged content and employee-tampered evidence never authorize deletion."
  Write-Output "PASS: cache loss, chmod drift, special/unreadable nodes, and tar failure preserve verified state."
  Write-Output "PASS: write-ahead interruption, trapped failure, and SIGKILL recovery restore every prior hash."
  Write-Output "PASS: recovery survives missing mutable candidates/manifests and clears abandoned transactions."
  Write-Output "PASS: a stopped HRM helper repairs drift while employee skill mounts remain read-only."
  Write-Output "PASS: active unmanaged skills remain preserved but fail exact-set eligibility."
  Write-Output "PASS: independent read-back catches post-action mismatch and symlink roots are rejected."
  Write-Output "PASS: canonical folder rules reject uppercase names and Windows device aliases before action."
  Write-Output "PASS: dispatcher marker/outbox crash windows recover only after verified employee quiescence."
} finally {
  & docker rm --force $liveContainer 2>$null | Out-Null
  foreach ($volume in @($skillsVolume, $workspaceVolume, $installedSkillsVolume, $dispatcherVolume)) { & docker volume rm --force $volume 2>$null | Out-Null }
  & docker image rm --force $image 2>$null | Out-Null

  $cleanupLeaks = [Collections.Generic.List[string]]::new()
  & docker container inspect $liveContainer 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { $cleanupLeaks.Add("container:$liveContainer") }
  foreach ($volume in @($skillsVolume, $workspaceVolume, $installedSkillsVolume, $dispatcherVolume)) {
    & docker volume inspect $volume 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $cleanupLeaks.Add("volume:$volume") }
  }
  & docker image inspect $image 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { $cleanupLeaks.Add("image:$image") }
  if ($cleanupLeaks.Count -gt 0) {
    throw "Disposable Docker cleanup left exact test artifacts: $($cleanupLeaks -join ', ')"
  }
}
