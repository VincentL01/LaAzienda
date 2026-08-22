#!/usr/bin/env bash
set -Eeuo pipefail

control_url="${OMC_CONTROL_URL:-http://host.docker.internal:3002}"
hrm_id="${OMC_EMPLOYEE_ID:-employee-hrm}"
worker_id="${OMC_WORKER_ID:-omc-hrm}"
base_image="${OMC_BASE_IMAGE:-one-man-company/codex-employee:local}"
base_image_id="${OMC_BASE_IMAGE_ID:-}"
github_auth_version="${OMC_GITHUB_AUTH_VERSION:-missing}"
company_network="${OMC_DOCKER_NETWORK:-one-man-company}"
training_root="${OMC_TRAINING_ROOT:-/company/training-cache}"
state_root="${OMC_STATE_ROOT:-/company/state}"
reconcile_state_root="${OMC_RECONCILE_STATE_ROOT:-/workspace/.company/reconcile}"
claim_generation_file="$reconcile_state_root/claim-training-generation"
auth_marker="/workspace/.company/auth-version"
github_auth_marker="/workspace/.company/github-auth-version"
skill_manifest_name=".omc-training-manifest.json"
managed_manifest_name=".omc-training-managed.json"
last_good_manifest_name=".omc-training-managed.last-good.json"
prior_manifest_name=".omc-training-prior.json"
policy_template_version="3"
skills_volume_contract_version="1"
integrity_audit_seconds="${OMC_INTEGRITY_AUDIT_SECONDS:-120}"

[[ -S /var/run/docker.sock ]] || { echo "HRM cannot reconcile employees because the Docker socket is unavailable." >&2; exit 78; }
[[ "$integrity_audit_seconds" =~ ^[0-9]+$ ]] || exit 64
[[ "$base_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "HRM requires an immutable employee base image id." >&2; exit 78; }

bridge_header=()
if [[ -n "${OMC_RUNTIME_BRIDGE_TOKEN:-}" ]]; then bridge_header=(-H "x-runtime-bridge-token: ${OMC_RUNTIME_BRIDGE_TOKEN}"); fi

api_get() { curl --fail --silent --show-error "${bridge_header[@]}" "$1"; }
api_post() {
  curl --fail --silent --show-error "${bridge_header[@]}" -H "content-type: application/json" --data "$2" "$1" >/dev/null
}

safe_id() { printf '%s' "$1" | tr -c 'A-Za-z0-9_.-' '-'; }
valid_id() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$ ]]; }
valid_folder() {
  [[ "$1" == "${1,,}" ]] || return 1
  [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9_.-]{0,78}[A-Za-z0-9])?$ ]] || return 1
  case "${1%%.*}" in [Cc][Oo][Nn]|[Pp][Rr][Nn]|[Aa][Uu][Xx]|[Nn][Uu][Ll]|[Cc][Oo][Mm][1-9]|[Ll][Pp][Tt][1-9]) return 1 ;; esac
}
valid_digest() { [[ "$1" =~ ^[0-9a-f]{64}$ ]]; }

publish_claim_generation() {
  local generation="$1" stage
  [[ "$generation" =~ ^[1-9][0-9]*$ ]] || return 64
  [[ -d "$reconcile_state_root" && ! -L "$reconcile_state_root" ]] || return 65
  stage="$(mktemp "$reconcile_state_root/.omc-generation-XXXXXXXX")" || return 74
  if ! printf '%s\n' "$generation" > "$stage" || ! chmod 0600 "$stage" || ! sync -f "$stage" \
    || ! mv -T -- "$stage" "$claim_generation_file" || ! sync -f "$reconcile_state_root"; then
    rm -f -- "$stage" >/dev/null 2>&1 || true
    return 74
  fi
}

skill_folder() {
  local package_ref="$1" suffix
  suffix="${package_ref##*@}"
  if [[ "$suffix" == "$package_ref" ]]; then suffix="${package_ref##*/}"; fi
  suffix="${suffix,,}"
  valid_folder "$suffix" || return 1
  printf '%s\n' "$suffix"
}

# Whole-tree contract: sorted path bytes, exact regular-file mode, and content
# hash. Any symlink, special node, unreadable file, or producer failure aborts.
hash_tree() {
  local root="$1" list manifest path relative path_hex mode digest
  [[ -d "$root" && ! -L "$root" ]] || return 1
  list="$(mktemp)" || return 1
  manifest="$(mktemp)" || { rm -f -- "$list"; return 1; }
  if ! find "$root" -mindepth 1 -print0 > "$list"; then rm -f -- "$list" "$manifest"; return 1; fi
  if ! LC_ALL=C sort -z "$list" -o "$list"; then rm -f -- "$list" "$manifest"; return 1; fi
  while IFS= read -r -d '' path; do
    if [[ -L "$path" ]]; then rm -f -- "$list" "$manifest"; return 2; fi
    if [[ -d "$path" ]]; then continue; fi
    if [[ ! -f "$path" || ! -r "$path" ]]; then rm -f -- "$list" "$manifest"; return 2; fi
    relative="${path#"$root"/}"
    path_hex="$(printf '%s' "$relative" | od -An -v -tx1 | tr -d ' \n')" || { rm -f -- "$list" "$manifest"; return 3; }
    mode="$(stat -c '%a' -- "$path")" || { rm -f -- "$list" "$manifest"; return 3; }
    digest="$(sha256sum -- "$path")" || { rm -f -- "$list" "$manifest"; return 3; }
    digest="${digest%% *}"
    valid_digest "$digest" || { rm -f -- "$list" "$manifest"; return 3; }
    printf '%s\0%s\0%s\0' "$path_hex" "$mode" "$digest" >> "$manifest" || { rm -f -- "$list" "$manifest"; return 3; }
  done < "$list"
  digest="$(sha256sum -- "$manifest")" || { rm -f -- "$list" "$manifest"; return 3; }
  rm -f -- "$list" "$manifest"
  printf '%s\n' "${digest%% *}"
}

write_volume_file() {
  local volume="$1" target="$2" mode="$3"
  docker run --rm -i --user 0 --entrypoint bash --volume "$volume:/target" "$base_image_id" \
    -c 'set -Eeuo pipefail
      relative="$1"; mode="$2"; root=/target
      [[ "$relative" != /* && "$relative" != *//* && "$relative" != *"/../"* && "$relative" != ../* && "$relative" != */.. ]] || exit 65
      [[ -d "$root" && ! -L "$root" ]] || exit 65
      parent="$root"; IFS="/" read -r -a parts <<< "$relative"; ((${#parts[@]} > 0)) || exit 65
      for ((index=0; index<${#parts[@]}-1; index++)); do
        component="${parts[$index]}"; [[ -n "$component" && "$component" != . && "$component" != .. ]] || exit 65
        parent="$parent/$component"; [[ ! -L "$parent" ]] || exit 65
        if [[ ! -e "$parent" ]]; then mkdir -- "$parent"; sync -f "$(dirname "$parent")"; fi
        [[ -d "$parent" && ! -L "$parent" ]] || exit 65
      done
      base="${parts[${#parts[@]}-1]}"; [[ -n "$base" && "$base" != . && "$base" != .. ]] || exit 65
      destination="$parent/$base"; [[ ! -L "$destination" && ( ! -e "$destination" || -f "$destination" ) ]] || exit 65
      stage="$(mktemp "$parent/.omc-publish-$base-XXXXXXXX")"
      trap '\''rm -f -- "$stage"'\'' EXIT HUP INT TERM
      cat > "$stage"; chmod "$mode" "$stage"; chown 1001:1001 "$stage"; sync -f "$stage"
      mv -T -- "$stage" "$destination"; sync -f "$parent"; trap - EXIT HUP INT TERM' _ "$target" "$mode"
}
read_volume_file() {
  docker run --rm --entrypoint sh --volume "$1:/source:ro" "$base_image_id" -c "cat '/source/$2'"
}
hash_volume_file() {
  docker run --rm --user 1001:1001 --entrypoint bash --volume "$1:/source:ro" "$base_image_id" \
    -c 'set -Eeuo pipefail; path="/source/$1"; [[ -f "$path" && ! -L "$path" ]]; sha256sum -- "$path"' _ "$2"
}
volume_file_exists() {
  docker run --rm --entrypoint bash --volume "$1:/source:ro" "$base_image_id" -c '[[ -f "/source/$1" && ! -L "/source/$1" ]]' _ "$2"
}
volume_control_paths_safe() {
  docker run --rm --user 1001:1001 --entrypoint bash --volume "$1:/workspace:ro" "$base_image_id" -c '
    set -Eeuo pipefail
    [[ ! -L /workspace/.company ]]
    [[ ! -e /workspace/.company || -d /workspace/.company ]]
    for path in /workspace/.company/training /workspace/.company/runs; do
      [[ ! -L "$path" && ( ! -e "$path" || -d "$path" ) ]]
    done'
}
ensure_volume_owner() {
  docker run --rm --user 0 --entrypoint sh --volume "$1:/target" "$base_image_id" -c "chown 1001:1001 /target"
}
copy_skill_candidate() {
  local source="$1" volume="$2" version="$3" folder="$4"
  valid_digest "$version" && valid_folder "$folder" || return 1
  tar -C "$source" -cf - . | docker run --rm -i --user 0 --entrypoint bash --volume "$volume:/target" "$base_image_id" \
    -c "set -Eeuo pipefail; target='/target/.omc-candidates/$version/$folder'; stage=\"\$target.tmp.$$\"; rm -rf -- \"\$stage\"; mkdir -p -- \"\$stage\"; tar -C \"\$stage\" -xf -; chown -R 1001:1001 \"\$stage\"; rm -rf -- \"\$target\"; mv -- \"\$stage\" \"\$target\""
}
volume_candidate_hash() {
  docker run --rm --user 1001:1001 --entrypoint /usr/local/bin/sync-company-skills \
    --volume "$1:/opt/assigned-skills:ro" "$base_image_id" --hash-candidate "$2" "$3"
}
workspace_skill_hash() {
  docker run --rm --user 1001:1001 --volume "$5:/workspace:ro" --volume "$6:/workspace/.agents/skills:ro" \
    --entrypoint /usr/local/bin/sync-company-skills "$base_image_id" --hash-workspace "$4"
}
workspace_skill_folders() {
  if [[ "$3" == true ]]; then
    docker exec "$2" /usr/local/bin/sync-company-skills --list-workspace-folders
  else
    docker run --rm --user 1001:1001 --volume "$4:/workspace:ro" --volume "$5:/workspace/.agents/skills:ro" \
      --entrypoint /usr/local/bin/sync-company-skills "$base_image_id" --list-workspace-folders
  fi
}
verify_workspace_absent() {
  valid_folder "$2" || return 1
  docker run --rm --user 1001:1001 --volume "$5:/workspace:ro" --volume "$6:/workspace/.agents/skills:ro" \
    --entrypoint /usr/local/bin/sync-company-skills "$base_image_id" --verify-workspace-absent "$2"
}
run_employee_skill_sync() {
  docker run --rm --user 1001:1001 --env "OMC_EMPLOYEE_ID=$1" \
    --volume "$5:/opt/assigned-skills" --volume "$4:/workspace" --volume "$6:/workspace/.agents/skills" \
    --entrypoint /usr/local/bin/sync-company-skills "$base_image_id"
}
recover_employee_skill_sync() {
  docker run --rm --user 1001:1001 --env "OMC_EMPLOYEE_ID=$1" \
    --volume "$3:/opt/assigned-skills" --volume "$2:/workspace" --volume "$4:/workspace/.agents/skills" \
    --entrypoint /usr/local/bin/sync-company-skills "$base_image_id" --recover
}
cleanup_skill_candidates() {
  local volume="$1" keep_version="$2"
  valid_digest "$keep_version" || return 1
  docker run --rm --user 0 --entrypoint bash --volume "$volume:/target" "$base_image_id" \
    -c "set -Eeuo pipefail; root=/target/.omc-candidates; [[ -d \"\$root\" ]] || exit 0; for candidate in \"\$root\"/*; do [[ -d \"\$candidate\" ]] || continue; [[ \"\$(basename \"\$candidate\")\" == '$keep_version' ]] || rm -rf -- \"\$candidate\"; done"
}

valid_managed_manifest() {
  local employee="$1" candidate="$2"
  jq -e --arg employee "$employee" '
    .schemaVersion == 2 and .employeeId == $employee and
    (.manifestVersion | type == "string" and test("^[0-9a-f]{64}$")) and
    (.skills | type == "array") and
    (all(.skills[];
      (.id | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$")) and
      (.folder | type == "string" and test("^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,78}[A-Za-z0-9])?$")) and
      (.folder == (.folder | ascii_downcase)) and
      ((.folder | ascii_downcase | split(".")[0]) as $base |
        (["con","prn","aux","nul","com1","com2","com3","com4","com5","com6","com7","com8","com9",
          "lpt1","lpt2","lpt3","lpt4","lpt5","lpt6","lpt7","lpt8","lpt9"] | index($base) | not)) and
      (.assignmentVersion | type == "number" and floor == . and . >= 1) and
      (.sourceHash | type == "string" and test("^[0-9a-f]{64}$")))) and
    ([.skills[].id] | length == (unique | length)) and
    ([.skills[].folder | ascii_downcase] | length == (unique | length)) and
    (.removals | type == "array") and
    (all(.removals[];
      (.id | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$")) and
      (.folder | type == "string" and test("^[a-z0-9](?:[a-z0-9_.-]{0,78}[a-z0-9])?$")) and
      ((.folder | split(".")[0]) as $base |
        (["con","prn","aux","nul","com1","com2","com3","com4","com5","com6","com7","com8","com9",
          "lpt1","lpt2","lpt3","lpt4","lpt5","lpt6","lpt7","lpt8","lpt9"] | index($base) | not)) and
      (.assignmentVersion | type == "number" and floor == . and . >= 1))) and
    ([.removals[].id] | length == (unique | length)) and
    ([.removals[].folder] | length == (unique | length)) and
    ([.skills[].folder, .removals[].folder] | flatten | length == (unique | length))
  ' <<< "$candidate" >/dev/null 2>&1
}

manifest_matches_installed_volume() {
  local employee="$1" candidate="$2" workspace_volume="$3" installed_volume="$4"
  local expected_folders actual_folders entries skill folder expected actual
  valid_managed_manifest "$employee" "$candidate" || return 1
  expected_folders="$(jq -r '.skills[].folder' <<< "$candidate" | LC_ALL=C sort)" || return 1
  actual_folders="$(workspace_skill_folders "$employee" "" false "$workspace_volume" "$installed_volume" 2>/dev/null)" || return 1
  [[ "$actual_folders" == "$expected_folders" ]] || return 1
  entries="$(mktemp)" || return 1
  if ! jq -c '.skills[]' <<< "$candidate" > "$entries"; then rm -f -- "$entries"; return 1; fi
  while IFS= read -r skill; do
    folder="$(jq -r '.folder' <<< "$skill")" || { rm -f -- "$entries"; return 1; }
    expected="$(jq -r '.sourceHash' <<< "$skill")" || { rm -f -- "$entries"; return 1; }
    valid_folder "$folder" && valid_digest "$expected" || { rm -f -- "$entries"; return 1; }
    actual="$(workspace_skill_hash "$employee" "" false "$folder" "$workspace_volume" "$installed_volume" 2>/dev/null)" \
      || { rm -f -- "$entries"; return 1; }
    [[ "$actual" == "$expected" ]] || { rm -f -- "$entries"; return 1; }
  done < "$entries"
  rm -f -- "$entries"
}

report_runtime() {
  local employee_id="$1" runtime_status="$2" detail="$3" identity="$4" event_key payload
  event_key="$(safe_id "$employee_id:$runtime_status:$identity")"
  payload="$(jq -nc --arg employeeId "$employee_id" --arg eventKey "$event_key" --arg runtimeStatus "$runtime_status" --arg detail "$detail" \
    '{action:"reportRuntime",employeeId:$employeeId,eventKey:$eventKey,runtimeStatus:$runtimeStatus,detail:$detail}')"
  api_post "$control_url/api/employees" "$payload"
}
report_training() {
  local employee_id="$1" skill_id="$2" operation="$3" assignment_version="$4" status="$5"
  local manifest_version="$6" source_hash="$7" staged_hash="$8" verified_hash="$9" evidence="${10}" payload
  payload="$(jq -nc --arg employeeId "$employee_id" --arg skillId "$skill_id" --arg operation "$operation" \
    --argjson assignmentVersion "$assignment_version" --arg status "$status" --arg manifestVersion "$manifest_version" \
    --arg sourceHash "$source_hash" --arg stagedHash "$staged_hash" --arg verifiedHash "$verified_hash" \
    --arg evidence "$evidence" --arg workerId "$worker_id" \
    '{action:"reportSkillSync",employeeId:$employeeId,skillId:$skillId,operation:$operation,
      assignmentVersion:$assignmentVersion,status:$status,workerId:$workerId,evidence:$evidence,
      manifestVersion:$manifestVersion,
      sourceHash:(if $sourceHash == "" then null else $sourceHash end),
      stagedHash:(if $stagedHash == "" then null else $stagedHash end),
      verifiedHash:(if $verifiedHash == "" then null else $verifiedHash end)}')"
  if ! api_post "$control_url/api/training" "$payload"; then
    if [[ -n "${training_report_failure_marker:-}" ]]; then printf 'failed\n' >> "$training_report_failure_marker"; fi
    return 1
  fi
}
report_cache_observation() {
  local skill_id="$1" folder="$2" status="$3" digest="$4" evidence="$5" payload
  payload="$(jq -nc --arg skillId "$skill_id" --arg folderKey "$folder" --arg observationStatus "$status" --arg observedDigest "$digest" \
    --arg evidence "$evidence" \
    '{action:"reportCacheObservation",skillId:$skillId,folderKey:$folderKey,
      observationStatus:$observationStatus,evidence:$evidence,
      observedDigest:(if $observedDigest == "" then null else $observedDigest end)}')"
  api_post "$control_url/api/training" "$payload"
}

auth_version="$(sha256sum /run/secrets/codex_auth 2>/dev/null || true)"; auth_version="${auth_version%% *}"
valid_digest "$auth_version" || { echo "HRM could not fingerprint the Codex authentication source." >&2; exit 78; }
[[ "$reconcile_state_root" == /workspace/.company/reconcile ]] || { echo "Unsafe reconcile state root." >&2; exit 65; }
[[ -d /workspace && ! -L /workspace ]] || exit 65
for reconcile_path in /workspace/.company "$reconcile_state_root"; do
  [[ ! -L "$reconcile_path" ]] || exit 65
  if [[ ! -e "$reconcile_path" ]]; then mkdir -- "$reconcile_path"; sync -f "$(dirname "$reconcile_path")"; fi
  [[ -d "$reconcile_path" && ! -L "$reconcile_path" ]] || exit 65
done
rm -f -- "$claim_generation_file"
sync -f "$reconcile_state_root"
if [[ -f "$auth_marker" ]]; then
  [[ "$(cat "$auth_marker")" == "$auth_version" ]] && auth_changed=false || auth_changed=true
else
  printf '%s\n' "$auth_version" > "$auth_marker"; auth_changed=false
fi
if [[ "$github_auth_version" != missing ]]; then valid_digest "$github_auth_version" || { echo "Invalid GitHub authentication fingerprint." >&2; exit 78; }; fi
if [[ -f "$github_auth_marker" && "$(cat "$github_auth_marker")" == "$github_auth_version" ]]; then github_auth_changed=false; else github_auth_changed=true; fi

workforce="$(api_get "$control_url/api/employees")"
catalog_file="$(mktemp)"
jq -c '.skills[]' <<< "$workforce" > "$catalog_file"
while IFS= read -r catalog_skill; do
  skill_id="$(jq -r '.id' <<< "$catalog_skill")"
  folder="$(jq -r '.folderKey // ""' <<< "$catalog_skill")"
  if ! valid_id "$skill_id" || ! valid_folder "$folder"; then echo "Training catalog entry $skill_id has no safe cache folder." >&2; continue; fi
  source="$training_root/$folder"
  if [[ ! -f "$source/SKILL.md" ]]; then
    report_cache_observation "$skill_id" "$folder" missing "" "The reserved host cache folder or SKILL.md is missing. Run training-center/Import-Skill.ps1 for this exact package." || true
  elif observed_digest="$(hash_tree "$source" 2>/dev/null)"; then
    report_cache_observation "$skill_id" "$folder" observed "$observed_digest" "Aurelia hashed path bytes, file modes, and contents from the reserved host cache folder." || true
  else
    report_cache_observation "$skill_id" "$folder" failed "" "The reserved cache tree is unsafe, unreadable, symlinked, or contains a non-regular node." || true
  fi
done < "$catalog_file"
rm -f -- "$catalog_file"

# Re-sense D1 after host cache observations so desired/approved state is the
# sole manifest input for this pass. Bracket the workforce read with the same
# monotonic generation; otherwise a mutation between the two endpoints could
# be published even though the employee desiredSkills snapshot was stale.
training_state="$(api_get "$control_url/api/training")"
reconciled_training_generation="$(jq -er '.desiredGeneration | select(type == "number" and floor == . and . >= 1)' <<< "$training_state")"
workforce="$(api_get "$control_url/api/employees")"
confirmed_training_state="$(api_get "$control_url/api/training")"
confirmed_training_generation="$(jq -er '.desiredGeneration | select(type == "number" and floor == . and . >= 1)' <<< "$confirmed_training_state")"
if [[ "$confirmed_training_generation" != "$reconciled_training_generation" ]]; then
  echo "Training desired state changed while sensing the workforce; refusing a mixed snapshot." >&2
  exit 75
fi
training_state="$confirmed_training_state"
violations="$(jq -r --arg hrm "$hrm_id" '.employees[] | select(.dockerSocketAccess == true and .id != $hrm) | .id' <<< "$workforce")"
[[ -z "$violations" ]] || { echo "Docker socket policy violation: $violations" >&2; exit 77; }

employees_file="$(mktemp)"
jq -c --arg hrm "$hrm_id" '.employees[] | select(.id != $hrm and .dockerSocketAccess == false)' <<< "$workforce" > "$employees_file"
workforce_ready=true
while IFS= read -r employee; do
  employee_id="$(jq -r '.id' <<< "$employee")"
  employee_name="$(jq -r '.name' <<< "$employee")"
  container_name="$(jq -r '.containerName' <<< "$employee")"
  desired="$(jq -r '.desiredRuntimeStatus' <<< "$employee")"
  employment_type="$(jq -r '.employmentType' <<< "$employee")"
  role_profile="$(jq -r '.roleProfileId // ""' <<< "$employee")"
  resource_access="$(jq -r '.resourceAccess // "task-scoped"' <<< "$employee")"
  valid_id "$employee_id" || { echo "Skipping unsafe employee identity." >&2; continue; }
  [[ "$container_name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$ ]] || { echo "Skipping unsafe container name for $employee_name" >&2; continue; }
  repository_write=false
  if [[ "$role_profile" == project-manager && "$resource_access" == project-write ]]; then repository_write=true; fi
  safe_employee="$(safe_id "$employee_id")"
  workspace_volume="omc-workspace-$safe_employee"
  skills_volume="omc-skills-$safe_employee"
  installed_skills_volume="omc-installed-skills-$safe_employee"
  secrets_volume="omc-secrets-$safe_employee"
  runtime_detail="Docker state observed and reported by the HR Manager."
  refresh_reason=""

  policy_file="$(mktemp)"
  jq -r --arg templateVersion "$policy_template_version" '
    "# \(.name) - \(.role)\n\n" +
    "Policy template: " + $templateVersion + "\n" +
    "Department: \(.department)\nEmployment type: \(.employmentType)\n" +
    "Workspace policy: \(.workspacePolicy)\nResource access: \(.resourceAccess)\n" +
    "Handoff required: \(.handoffRequired)\nMailbox: \(.emailAddress) (\(.mailboxStatus))\n\n" +
    .systemPrompt + "\n\n## Company execution rules\n\n" +
    "- Use only company evidence supplied in the approved task prompt; broad portal APIs are not employee tools.\n" +
    "- Never read, print, return, or commit credentials.\n" +
    "- Repository changes must use a codex/* branch and a pull request. Never commit or push directly to main.\n" +
    "- Treat the structured executor result as the durable handoff.\n"
  ' <<< "$employee" > "$policy_file"
  policy_version="$( { printf 'template=%s\0' "$policy_template_version"; cat "$policy_file"; } | sha256sum )"; policy_version="${policy_version%% *}"

  skills_contract="$(jq -cS '[.desiredSkills[] | {
    id, packageRef, folder:.folderKey, assignmentVersion, sourceHash:.approvedDigest,
    observedDigest, approvalVersion
  }] | sort_by(.id)' <<< "$employee")"
  removals_contract="$(jq -cS --arg employee "$employee_id" '[.assignments[] |
    select(.employeeId == $employee and .desiredOperation == "remove") |
    {id:.skillId,packageRef,folder:.folderKey,assignmentVersion}] | sort_by(.id)' <<< "$training_state")"
  manifest_contract="$(jq -ncS --argjson skills "$skills_contract" --argjson removals "$removals_contract" '{skills:$skills,removals:$removals}')"
  manifest_version="$(printf '%s' "$manifest_contract" | sha256sum)"; manifest_version="${manifest_version%% *}"
  manifest="$(jq -nc --arg employeeId "$employee_id" --arg manifestVersion "$manifest_version" \
    --argjson skills "$skills_contract" --argjson removals "$removals_contract" \
    '{schemaVersion:2,employeeId:$employeeId,manifestVersion:$manifestVersion,skills:$skills,removals:$removals}')"

  fingerprint_payload="$(jq -ncS --arg policy "$policy_version" --arg manifest "$manifest_version" \
    --arg desired "$desired" --arg image "$base_image_id" --arg auth "$auth_version" --arg github "$github_auth_version" \
    '{policy:$policy,manifest:$manifest,desiredRuntime:$desired,image:$image,auth:$auth,github:$github}')"
  reconcile_fingerprint="$(printf '%s' "$fingerprint_payload" | sha256sum)"; reconcile_fingerprint="${reconcile_fingerprint%% *}"
  fingerprint_file="$reconcile_state_root/$safe_employee.fingerprint"
  audit_file="$reconcile_state_root/$safe_employee.audit"
  previous_fingerprint="$(cat "$fingerprint_file" 2>/dev/null || true)"
  last_audit="$(cat "$audit_file" 2>/dev/null || printf '0')"
  [[ "$last_audit" =~ ^[0-9]+$ ]] || last_audit=0
  now="$(date +%s)"
  if (( now - last_audit >= integrity_audit_seconds )); then audit_due=true; else audit_due=false; fi
  if [[ "$previous_fingerprint" != "$reconcile_fingerprint" || "$audit_due" == true ]]; then needs_reconcile=true; else needs_reconcile=false; fi

  if docker container inspect "$container_name" >/dev/null 2>&1; then exists=true; else exists=false; fi
  if [[ "$exists" == true ]]; then
    existing_employee="$(docker container inspect --format '{{index .Config.Labels "one-man-company.employee"}}' "$container_name")"
    existing_image_id="$(docker container inspect --format '{{index .Config.Labels "one-man-company.base-image-id"}}' "$container_name")"
    existing_actual_image_id="$(docker container inspect --format '{{.Image}}' "$container_name")"
    existing_auth_version="$(docker container inspect --format '{{index .Config.Labels "one-man-company.auth-version"}}' "$container_name")"
    existing_github_auth_version="$(docker container inspect --format '{{index .Config.Labels "one-man-company.github-auth-version"}}' "$container_name")"
    existing_policy_version="$(docker container inspect --format '{{index .Config.Labels "one-man-company.policy-version"}}' "$container_name")"
    existing_skills_volume_contract="$(docker container inspect --format '{{index .Config.Labels "one-man-company.skills-volume-contract"}}' "$container_name")"
    if [[ "$existing_employee" != "$employee_id" ]]; then
      echo "Refusing to replace $container_name because its employee label does not match." >&2
      workforce_ready=false
      report_runtime "$employee_id" not_found \
        "The requested employee container name is occupied by an untrusted identity; no work may be claimed." \
        "label-mismatch-$container_name"
      rm -f -- "$policy_file"
      continue
    fi
    if [[ "$existing_image_id" != "$base_image_id" || "$existing_actual_image_id" != "$base_image_id" ]]; then refresh_reason=base-image; fi
    if [[ "$existing_auth_version" != "$auth_version" ]]; then refresh_reason=authentication; fi
    if [[ "$repository_write" == true && "$existing_github_auth_version" != "$github_auth_version" ]]; then refresh_reason=github-authentication; fi
    if [[ "$existing_policy_version" != "$policy_version" ]]; then refresh_reason=employee-policy; fi
    if [[ "$existing_skills_volume_contract" != "$skills_volume_contract_version" ]]; then refresh_reason=skills-volume-contract; fi
    if [[ -n "$refresh_reason" ]]; then docker container rm --force "$container_name" >/dev/null; exists=false; needs_reconcile=true; fi
  fi
  if [[ "$desired" == running && "$exists" == false ]]; then needs_reconcile=true; fi

  reconcile_succeeded=true
  policy_ready=true
  current_container_state=missing
  if [[ "$exists" == true ]]; then current_container_state="$(docker container inspect --format '{{.State.Status}}' "$container_name")"; fi
  case "$current_container_state" in
    restarting|removing|dead)
      echo "Deferring $employee_id reconciliation while its container is $current_container_state." >&2
      reconcile_succeeded=false; policy_ready=false; workforce_ready=false
      ;;
  esac
  if [[ "$current_container_state" == running ]]; then
    expected_active_folders="$(jq -r '.[].folder' <<< "$skills_contract" | LC_ALL=C sort)"
    actual_active_folders="$(workspace_skill_folders "$employee_id" "$container_name" true "$workspace_volume" "$installed_skills_volume" 2>/dev/null || printf '__unsafe__')"
    if [[ "$actual_active_folders" != "$expected_active_folders" ]]; then
      needs_reconcile=true
      runtime_detail="An unapproved or unsafe active skill folder blocked task eligibility; workspace content was preserved for CEO review."
    fi
    integrity_entries="$(mktemp)"; jq -c '.[]' <<< "$skills_contract" > "$integrity_entries"
    while IFS= read -r desired_skill; do
      folder="$(jq -r '.folder' <<< "$desired_skill")"; expected="$(jq -r '.sourceHash' <<< "$desired_skill")"
      actual="$(docker exec "$container_name" /usr/local/bin/sync-company-skills --hash-workspace "$folder" 2>/dev/null || true)"
      if [[ "$actual" != "$expected" ]]; then
        needs_reconcile=true
        runtime_detail="A fresh pre-claim skill read-back found drift; the employee was stopped for repair."
        break
      fi
    done < "$integrity_entries"
    rm -f -- "$integrity_entries"
  fi
  docker volume create "$workspace_volume" >/dev/null
  docker volume create "$skills_volume" >/dev/null
  docker volume create "$installed_skills_volume" >/dev/null
  ensure_volume_owner "$workspace_volume"
  ensure_volume_owner "$skills_volume"
  ensure_volume_owner "$installed_skills_volume"

  expected_policy_hash="$(sha256sum "$policy_file" | awk '{print $1}')"
  if [[ "$current_container_state" == running ]]; then
    actual_policy_hash="$(docker exec "$container_name" bash -c '[[ -f /workspace/AGENTS.md && ! -L /workspace/AGENTS.md ]] && sha256sum -- /workspace/AGENTS.md' 2>/dev/null || true)"
    if docker exec "$container_name" bash -c '[[ ! -L /workspace/.company && ( ! -e /workspace/.company || -d /workspace/.company ) ]]; for path in /workspace/.company/training /workspace/.company/runs; do [[ ! -L "$path" && ( ! -e "$path" || -d "$path" ) ]] || exit 1; done' >/dev/null 2>&1; then company_paths_safe=true; else company_paths_safe=false; fi
  else
    actual_policy_hash="$(hash_volume_file "$workspace_volume" AGENTS.md 2>/dev/null || true)"
    if volume_control_paths_safe "$workspace_volume"; then company_paths_safe=true; else company_paths_safe=false; fi
  fi
  actual_policy_hash="${actual_policy_hash%% *}"
  if [[ "$company_paths_safe" == true ]]; then marker_policy_version="$(read_volume_file "$workspace_volume" .company/policy-version 2>/dev/null || true)"; else marker_policy_version=""; fi
  policy_needs_repair=false
  if [[ "$actual_policy_hash" != "$expected_policy_hash" || "$marker_policy_version" != "$policy_version" || "$company_paths_safe" != true ]]; then policy_needs_repair=true; fi
  if [[ "$policy_needs_repair" == true && "$policy_ready" == true ]]; then
    if [[ "$current_container_state" == running || "$current_container_state" == paused ]]; then
      docker stop "$container_name" >/dev/null || policy_ready=false
      current_container_state=exited
    fi
    if [[ "$policy_ready" == true ]]; then
      write_volume_file "$workspace_volume" AGENTS.md 0644 < "$policy_file" || policy_ready=false
      printf '%s\n' "$policy_version" | write_volume_file "$workspace_volume" .company/policy-version 0644 || policy_ready=false
      repaired_policy_hash="$(hash_volume_file "$workspace_volume" AGENTS.md 2>/dev/null || true)"; repaired_policy_hash="${repaired_policy_hash%% *}"
      [[ "$repaired_policy_hash" == "$expected_policy_hash" ]] || policy_ready=false
    fi
  fi
  if [[ "$policy_ready" != true ]]; then
    reconcile_succeeded=false; workforce_ready=false
    echo "Employee policy verification failed for $employee_id; no task may be claimed." >&2
  fi

  # Any workspace mutation happens only while the employee process is stopped.
  if [[ "$needs_reconcile" == true && "$policy_ready" == true && ( "$current_container_state" == running || "$current_container_state" == paused ) ]]; then
    docker stop "$container_name" >/dev/null || { reconcile_succeeded=false; workforce_ready=false; }
    current_container_state=exited
  fi

  training_report_failure_marker="$(mktemp)"
  if [[ "$needs_reconcile" == true && "$policy_ready" == true && "$reconcile_succeeded" == true ]]; then
    container_running=false
    recovery_failure=""
    if ! recover_employee_skill_sync "$employee_id" "$workspace_volume" "$skills_volume" "$installed_skills_volume"; then
      recovery_failure="A trusted interrupted training transaction could not be recovered; the employee remains stopped."
      reconcile_succeeded=false
    fi
    validation_failures="$(mktemp)"
    entries_file="$(mktemp)"
    : > "$validation_failures"; : > "$entries_file"
    jq -c '.skills[]' <<< "$manifest" > "$entries_file"
    while IFS= read -r desired_skill; do
      skill_id="$(jq -r '.id' <<< "$desired_skill")"; folder="$(jq -r '.folder' <<< "$desired_skill")"
      assignment_version="$(jq -r '.assignmentVersion' <<< "$desired_skill")"
      approved="$(jq -r '.sourceHash // ""' <<< "$desired_skill")"; observed="$(jq -r '.observedDigest // ""' <<< "$desired_skill")"
      source="$training_root/$folder"
      failure="$recovery_failure"
      if [[ -z "$failure" ]] && { ! valid_id "$skill_id" || ! valid_folder "$folder" || ! valid_digest "$approved" || [[ "$approved" != "$observed" ]]; }; then
        failure="The desired skill does not reference one currently observed and CEO-approved safe cache revision."
      elif [[ -z "$failure" && ! -f "$source/SKILL.md" ]]; then
        failure="The approved Training Center cache is missing SKILL.md."
      elif [[ -z "$failure" ]] && { ! actual_cache_hash="$(hash_tree "$source" 2>/dev/null)" || [[ "$actual_cache_hash" != "$approved" ]]; }; then
        failure="The mutable host cache drifted from its approved whole-tree digest."
      fi
      if [[ -n "$failure" ]]; then
        printf '%s\n' "$skill_id" >> "$validation_failures"
        report_training "$employee_id" "$skill_id" install "$assignment_version" failed "$manifest_version" "$approved" "" "" "$failure The last verified manifest and workspace were preserved." || true
      fi
    done < "$entries_file"
    jq -c '.removals[]' <<< "$manifest" | while IFS= read -r removal; do
      skill_id="$(jq -r '.id' <<< "$removal")"; folder="$(jq -r '.folder // ""' <<< "$removal")"; assignment_version="$(jq -r '.assignmentVersion' <<< "$removal")"
      if [[ -n "$recovery_failure" ]] || ! valid_id "$skill_id" || ! valid_folder "$folder" || ! [[ "$assignment_version" =~ ^[0-9]+$ ]]; then
        printf '%s\n' "$skill_id" >> "$validation_failures"
        report_training "$employee_id" "$skill_id" remove "$assignment_version" failed "$manifest_version" "" "" "" "${recovery_failure:-The removal reservation has an unsafe identity or folder; the last verified manifest was preserved.}" || true
      fi
    done

    if [[ -s "$validation_failures" ]]; then
      reconcile_succeeded=false
    else
      staging_failures="$(mktemp)"; : > "$staging_failures"
      while IFS= read -r desired_skill; do
        skill_id="$(jq -r '.id' <<< "$desired_skill")"; folder="$(jq -r '.folder' <<< "$desired_skill")"
        expected="$(jq -r '.sourceHash' <<< "$desired_skill")"; source="$training_root/$folder"
        staged="$(volume_candidate_hash "$skills_volume" "$manifest_version" "$folder" 2>/dev/null || true)"
        if [[ "$staged" != "$expected" ]]; then
          copy_skill_candidate "$source" "$skills_volume" "$manifest_version" "$folder" || { printf '%s\n' "$skill_id" >> "$staging_failures"; continue; }
          staged="$(volume_candidate_hash "$skills_volume" "$manifest_version" "$folder" 2>/dev/null || true)"
        fi
        [[ "$staged" == "$expected" ]] || printf '%s\n' "$skill_id" >> "$staging_failures"
      done < "$entries_file"

      if [[ -s "$staging_failures" ]]; then
        reconcile_succeeded=false
        while IFS= read -r skill_id; do
          desired_skill="$(jq -c --arg id "$skill_id" '.skills[] | select(.id == $id)' <<< "$manifest")"
          report_training "$employee_id" "$skill_id" install "$(jq -r '.assignmentVersion' <<< "$desired_skill")" failed "$manifest_version" "$(jq -r '.sourceHash' <<< "$desired_skill")" "" "" "A versioned candidate failed independent hash verification; the managed manifest and workspace were preserved." || true
        done < "$staging_failures"
      else
        managed_candidate="$(read_volume_file "$skills_volume" "$managed_manifest_name" 2>/dev/null || true)"
        last_good_candidate="$(read_volume_file "$skills_volume" "$last_good_manifest_name" 2>/dev/null || true)"
        staged_candidate="$(read_volume_file "$skills_volume" "$skill_manifest_name" 2>/dev/null || true)"
        managed_exists=false; last_good_exists=false
        volume_file_exists "$skills_volume" "$managed_manifest_name" && managed_exists=true
        volume_file_exists "$skills_volume" "$last_good_manifest_name" && last_good_exists=true
        managed_contract_valid=false; last_good_contract_valid=false
        valid_managed_manifest "$employee_id" "$managed_candidate" && managed_contract_valid=true
        valid_managed_manifest "$employee_id" "$last_good_candidate" && last_good_contract_valid=true
        managed_valid=false; last_good_valid=false; staged_valid=false
        manifest_matches_installed_volume "$employee_id" "$managed_candidate" "$workspace_volume" "$installed_skills_volume" && managed_valid=true
        manifest_matches_installed_volume "$employee_id" "$last_good_candidate" "$workspace_volume" "$installed_skills_volume" && last_good_valid=true
        manifest_matches_installed_volume "$employee_id" "$staged_candidate" "$workspace_volume" "$installed_skills_volume" && staged_valid=true
        manifest_provenance_ok=true
        managed_manifest=""
        if [[ "$managed_exists" == true || "$last_good_exists" == true ]] \
          && [[ "$managed_contract_valid" != true && "$last_good_contract_valid" != true ]]; then
          # Existing but corrupt authoritative copies are never reconstructed
          # from a merely staged desired manifest.
          manifest_provenance_ok=false
        elif [[ "$managed_valid" == true && "$last_good_valid" == true ]]; then
          # Both candidates independently prove the same exact folder/hash
          # bytes. Metadata can legitimately differ across a crash during a
          # revoke/reassign of unchanged content; the managed slot wins
          # deterministically and is republished to both authority copies.
          managed_manifest="$managed_candidate"
        elif [[ "$managed_valid" == true ]]; then
          managed_manifest="$managed_candidate"
        elif [[ "$last_good_valid" == true ]]; then
          managed_manifest="$last_good_candidate"
        elif [[ "$staged_valid" == true ]]; then
          # This is the durable crash window after installed-volume commit but
          # before either authority copy was published. Exact folder+hash
          # read-back upgrades only the already staged HRM-owned manifest.
          managed_manifest="$staged_candidate"
        else
          empty_manifest="$(jq -nc --arg employeeId "$employee_id" --arg manifestVersion "$(printf '' | sha256sum | awk '{print $1}')" '{schemaVersion:2,employeeId:$employeeId,manifestVersion:$manifestVersion,skills:[],removals:[]}')"
          if manifest_matches_installed_volume "$employee_id" "$empty_manifest" "$workspace_volume" "$installed_skills_volume"; then
            managed_manifest="$empty_manifest"
          else
            manifest_provenance_ok=false
          fi
        fi
        if [[ "$manifest_provenance_ok" != true ]]; then
          reconcile_succeeded=false
          while IFS= read -r desired_skill; do
            report_training "$employee_id" "$(jq -r '.id' <<< "$desired_skill")" install "$(jq -r '.assignmentVersion' <<< "$desired_skill")" failed "$manifest_version" "$(jq -r '.sourceHash' <<< "$desired_skill")" "" "" "No trusted manifest matched the exact installed-volume folder and hash set; deletion provenance was preserved and no workspace action ran." || true
          done < "$entries_file"
          jq -c '.removals[]' <<< "$manifest" | while IFS= read -r removal; do
            report_training "$employee_id" "$(jq -r '.id' <<< "$removal")" remove "$(jq -r '.assignmentVersion' <<< "$removal")" failed "$manifest_version" "" "" "" "No trusted manifest matched the exact installed-volume folder and hash set; no removal ran." || true
          done
        else
          # Repair authority before any new mutation. Each file publication is
          # atomic and managed is written first, so every crash window retains
          # at least one exact installed-volume-matching provenance record.
          if ! printf '%s' "$managed_manifest" | write_volume_file "$skills_volume" "$managed_manifest_name" 0644 \
            || ! printf '%s' "$managed_manifest" | write_volume_file "$skills_volume" "$last_good_manifest_name" 0644; then
            reconcile_succeeded=false
          fi
        fi
        if [[ "$reconcile_succeeded" == true && "$manifest_provenance_ok" == true ]]; then
          printf '%s' "$managed_manifest" | write_volume_file "$skills_volume" "$prior_manifest_name" 0644
          printf '%s' "$manifest" | write_volume_file "$skills_volume" "$skill_manifest_name" 0644

          if ! applied_json="$(run_employee_skill_sync "$employee_id" "$container_name" "$container_running" "$workspace_volume" "$skills_volume" "$installed_skills_volume" 2>/dev/null)" \
          || ! jq -e --arg employee "$employee_id" --arg version "$manifest_version" '.schemaVersion == 2 and .employeeId == $employee and .manifestVersion == $version' <<< "$applied_json" >/dev/null 2>&1; then
          reconcile_succeeded=false
          while IFS= read -r desired_skill; do
            report_training "$employee_id" "$(jq -r '.id' <<< "$desired_skill")" install "$(jq -r '.assignmentVersion' <<< "$desired_skill")" failed "$manifest_version" "$(jq -r '.sourceHash' <<< "$desired_skill")" "" "" "The fail-atomic container sync did not produce its expected evidence manifest; the prior managed manifest remains authoritative." || true
          done < "$entries_file"
        else
          readback_failures="$(mktemp)"; : > "$readback_failures"
          readbacks_file="$(mktemp)"; : > "$readbacks_file"
          while IFS= read -r desired_skill; do
            skill_id="$(jq -r '.id' <<< "$desired_skill")"; folder="$(jq -r '.folder' <<< "$desired_skill")"; expected="$(jq -r '.sourceHash' <<< "$desired_skill")"
            staged="$(volume_candidate_hash "$skills_volume" "$manifest_version" "$folder" 2>/dev/null || true)"
            workspace_hash="$(workspace_skill_hash "$employee_id" "$container_name" "$container_running" "$folder" "$workspace_volume" "$installed_skills_volume" 2>/dev/null || true)"
            jq -nc --arg id "$skill_id" --arg staged "$staged" --arg workspace "$workspace_hash" '{id:$id,staged:$staged,workspace:$workspace}' >> "$readbacks_file"
            [[ "$expected" == "$staged" && "$expected" == "$workspace_hash" ]] || printf '%s\n' "$skill_id" >> "$readback_failures"
          done < "$entries_file"
          removals_file="$(mktemp)"; jq -c '.removals[]' <<< "$manifest" > "$removals_file"
          while IFS= read -r removal; do
            folder="$(jq -r '.folder' <<< "$removal")"
            verify_workspace_absent "$employee_id" "$folder" "$container_name" "$container_running" "$workspace_volume" "$installed_skills_volume" || printf '%s\n' "$(jq -r '.id' <<< "$removal")" >> "$readback_failures"
          done < "$removals_file"
          expected_active_folders="$(jq -r '.[].folder' <<< "$skills_contract" | LC_ALL=C sort)"
          actual_active_folders="$(workspace_skill_folders "$employee_id" "$container_name" false "$workspace_volume" "$installed_skills_volume" 2>/dev/null || printf '__unsafe__')"
          [[ "$actual_active_folders" == "$expected_active_folders" ]] || printf '%s\n' '__active-folder-set__' >> "$readback_failures"

          if [[ -s "$readback_failures" ]]; then reconcile_succeeded=false; else
            # Proven workspace state becomes the only deletion provenance for a
            # later pass. Employee-owned applied.json is evidence only.
            if printf '%s' "$manifest" | write_volume_file "$skills_volume" "$managed_manifest_name" 0644 \
              && printf '%s' "$manifest" | write_volume_file "$skills_volume" "$last_good_manifest_name" 0644; then
              cleanup_skill_candidates "$skills_volume" "$manifest_version" || true
            else
              reconcile_succeeded=false
            fi
          fi
          while IFS= read -r desired_skill; do
            skill_id="$(jq -r '.id' <<< "$desired_skill")"; expected="$(jq -r '.sourceHash' <<< "$desired_skill")"
            readback="$(jq -c --arg id "$skill_id" 'select(.id == $id)' "$readbacks_file")"
            staged="$(jq -r '.staged' <<< "$readback")"; workspace_hash="$(jq -r '.workspace' <<< "$readback")"
            if [[ "$reconcile_succeeded" == true && "$expected" == "$staged" && "$expected" == "$workspace_hash" ]]; then
              report_training "$employee_id" "$skill_id" install "$(jq -r '.assignmentVersion' <<< "$desired_skill")" verified "$manifest_version" "$expected" "$staged" "$workspace_hash" "Approved cache, HRM-owned staged volume, and separate workspace read-back matched whole-tree digest $workspace_hash." || true
            else
              report_training "$employee_id" "$skill_id" install "$(jq -r '.assignmentVersion' <<< "$desired_skill")" failed "$manifest_version" "$expected" "$staged" "$workspace_hash" "Independent post-action read-back did not match the approved and staged whole-tree digests." || true
            fi
          done < "$entries_file"
          while IFS= read -r removal; do
            skill_id="$(jq -r '.id' <<< "$removal")"; folder="$(jq -r '.folder' <<< "$removal")"; assignment_version="$(jq -r '.assignmentVersion' <<< "$removal")"
            if [[ "$reconcile_succeeded" == true ]] && verify_workspace_absent "$employee_id" "$folder" "$container_name" "$container_running" "$workspace_volume" "$installed_skills_volume"; then
              report_training "$employee_id" "$skill_id" remove "$assignment_version" verified "$manifest_version" "" "" "" "The container removed only a prior HRM-managed folder and a separate workspace read-back proved its absence." || true
            else
              report_training "$employee_id" "$skill_id" remove "$assignment_version" failed "$manifest_version" "" "" "" "The prior managed folder remained after reconciliation." || true
            fi
          done < "$removals_file"
          rm -f -- "$readback_failures" "$readbacks_file" "$removals_file"
        fi
      fi
    fi
    rm -f -- "$staging_failures"
  fi
    rm -f -- "$validation_failures" "$entries_file"
    if [[ -s "$training_report_failure_marker" ]]; then reconcile_succeeded=false; fi
    if [[ "$reconcile_succeeded" == true ]]; then
      printf '%s\n' "$reconcile_fingerprint" > "$fingerprint_file"
      printf '%s\n' "$now" > "$audit_file"
    else
      rm -f -- "$fingerprint_file"
    fi
  fi
  rm -f -- "$training_report_failure_marker"
  training_report_failure_marker=""
  rm -f -- "$policy_file"
  if [[ "$reconcile_succeeded" != true ]]; then workforce_ready=false; fi

  if [[ "$desired" == running && "$exists" == false && "$reconcile_succeeded" == true ]]; then
    docker volume create "$workspace_volume" >/dev/null
    docker volume create "$skills_volume" >/dev/null
    docker volume create "$installed_skills_volume" >/dev/null
    docker volume create "$secrets_volume" >/dev/null
    mail_secret="$state_root/$employee_id/mail-password"
    if [[ -f "$mail_secret" ]]; then write_volume_file "$secrets_volume" mail_password 0400 < "$mail_secret"; fi
    set -- docker create --name "$container_name" \
      --label "one-man-company.employee=$employee_id" \
      --label "one-man-company.employment-type=$employment_type" \
      --label "one-man-company.base-image-id=$base_image_id" \
      --label "one-man-company.auth-version=$auth_version" \
      --label "one-man-company.github-auth-version=$github_auth_version" \
      --label "one-man-company.policy-version=$policy_version" \
      --label "one-man-company.skills-volume-contract=$skills_volume_contract_version" \
      --restart unless-stopped --network "$company_network" --add-host host.docker.internal:host-gateway \
      --env "OMC_EMPLOYEE_ID=$employee_id" --env "OMC_CONTROL_URL=$control_url" \
      --env "OMC_REPOSITORY_WRITE=$repository_write" --env "OMC_MAIL_DOMAIN=one-man-company.test" \
      --env "OMC_MAIL_ADDRESS=$(jq -r '.emailAddress // ""' <<< "$employee")" \
      --env "OMC_MAIL_SMTP_HOST=stalwart" --env "OMC_MAIL_SMTP_PORT=587" \
      --env "OMC_MAIL_IMAP_HOST=stalwart" --env "OMC_MAIL_IMAP_PORT=993" \
      --volume "$workspace_volume:/workspace" --volume "$installed_skills_volume:/workspace/.agents/skills:ro" \
      --volume "$skills_volume:/opt/assigned-skills:ro" \
      --volume "$secrets_volume:/run/company-secrets:ro" --volumes-from omc-auth-source:ro
    if [[ "$role_profile" == project-manager ]] && docker container inspect omc-github-source >/dev/null 2>&1; then set -- "$@" --volumes-from omc-github-source:ro; fi
    set -- "$@" "$base_image_id"; "$@" >/dev/null; docker start "$container_name" >/dev/null; exists=true
    case "$refresh_reason" in
      authentication) runtime_detail="Authentication source changed; employee container recreated." ;;
      github-authentication) runtime_detail="GitHub authentication source changed; Project Manager container recreated." ;;
      employee-policy) runtime_detail="Employee policy changed; container recreated with independently verified AGENTS.md." ;;
      skills-volume-contract) runtime_detail="Employee recreated with a dedicated HRM-managed read-only active-skills volume." ;;
      base-image) runtime_detail="Base image changed; employee container recreated." ;;
    esac
  elif [[ "$desired" == running && "$exists" == true && "$reconcile_succeeded" == true ]]; then
    current="$(docker container inspect --format '{{.State.Status}}' "$container_name")"
    if [[ "$current" == exited || "$current" == created ]]; then docker start "$container_name" >/dev/null; fi
  elif [[ "$desired" == stopped && "$exists" == true ]]; then
    current="$(docker container inspect --format '{{.State.Status}}' "$container_name")"
    if [[ "$current" == running || "$current" == paused || "$current" == restarting ]]; then docker stop "$container_name" >/dev/null; fi
  fi

  if docker container inspect "$container_name" >/dev/null 2>&1; then
    runtime_status="$(docker container inspect --format '{{.State.Status}}' "$container_name")"
    identity="$(docker container inspect --format '{{.State.StartedAt}}-{{.State.FinishedAt}}' "$container_name")"
    report_runtime "$employee_id" "$runtime_status" "$runtime_detail" "$identity"
  else
    report_runtime "$employee_id" not_found "The HR Manager did not find the requested employee container." missing
  fi
done < "$employees_file"
rm -f -- "$employees_file"

if [[ "$workforce_ready" != true ]]; then
  echo "Workforce reconciliation is not verified; refusing to let the dispatcher claim work." >&2
  exit 75
fi

if [[ "$auth_changed" == true ]]; then
  api_post "$control_url/api/company" "$(jq -nc '{action:"retryAuthenticationBlocked"}')"
  printf '%s\n' "$auth_version" > "$auth_marker"
  echo "Aurelia refreshed employee authentication and requeued authentication-blocked work."
fi
if [[ "$github_auth_changed" == true ]]; then
  api_post "$control_url/api/company" "$(jq -nc '{action:"retryGithubAuthenticationBlocked"}')"
  printf '%s\n' "$github_auth_version" > "$github_auth_marker"
  echo "Aurelia refreshed Project Manager GitHub authentication and requeued GitHub-blocked work."
fi

# Publish only after the entire sense-act-verify pass succeeds. The executor
# still compares this opaque value inside the claim INSERT, so a CEO/cache
# mutation in the final read-to-claim window makes the claim a safe no-op.
final_training_state="$(api_get "$control_url/api/training")"
claim_training_generation="$(jq -er '.desiredGeneration | select(type == "number" and floor == . and . >= 1)' <<< "$final_training_state")"
if [[ "$claim_training_generation" != "$reconciled_training_generation" ]]; then
  echo "Training desired state changed during reconciliation; refusing to publish a stale claim generation." >&2
  exit 75
fi
publish_claim_generation "$claim_training_generation" || { echo "Aurelia could not publish the reconciled training generation." >&2; exit 75; }
