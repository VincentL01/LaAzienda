#!/usr/bin/env bash
set -Eeuo pipefail

manifest_path="${OMC_SKILL_MANIFEST:-/opt/assigned-skills/.omc-training-manifest.json}"
prior_manifest_path="${OMC_PRIOR_SKILL_MANIFEST:-/opt/assigned-skills/.omc-training-prior.json}"
workspace_skills="${OMC_WORKSPACE_SKILLS:-/workspace/.agents/skills}"
state_root="${OMC_TRAINING_STATE:-/workspace/.company/training}"
transaction_root="${OMC_TRAINING_TRANSACTION_ROOT:-/opt/assigned-skills/.omc-transactions}"

valid_id() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$ ]]; }
valid_folder() {
  [[ "$1" == "${1,,}" ]] || return 1
  [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9_.-]{0,78}[A-Za-z0-9])?$ ]] || return 1
  case "${1%%.*}" in [Cc][Oo][Nn]|[Pp][Rr][Nn]|[Aa][Uu][Xx]|[Nn][Uu][Ll]|[Cc][Oo][Mm][1-9]|[Ll][Pp][Tt][1-9]) return 1 ;; esac
}
valid_digest() { [[ "$1" =~ ^[0-9a-f]{64}$ ]]; }

validate_workspace_root() {
  local requested="$1" resolved component current="/workspace"
  [[ "$requested" == /workspace/* && "$requested" != *//* ]] || return 1
  [[ "$requested" != *"/../"* && "$requested" != */.. && "$requested" != *"/./"* && "$requested" != */. ]] || return 1
  [[ ! -L /workspace ]] || return 1
  resolved="$(realpath -m -- "$requested")" || return 1
  [[ "$resolved" == /workspace/* ]] || return 1
  IFS='/' read -r -a components <<< "${requested#/workspace/}"
  for component in "${components[@]}"; do
    [[ -n "$component" && "$component" != . && "$component" != .. ]] || return 1
    current="$current/$component"
    [[ ! -L "$current" ]] || return 1
  done
}

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
    if [[ ! -f "$path" ]]; then rm -f -- "$list" "$manifest"; return 2; fi
    [[ -r "$path" ]] || { rm -f -- "$list" "$manifest"; return 3; }
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

candidate_path() {
  local version="$1" folder="$2"
  valid_digest "$version" && valid_folder "$folder" || return 1
  printf '/opt/assigned-skills/.omc-candidates/%s/%s\n' "$version" "$folder"
}

validate_ro_manifest() {
  local path="$1" employee="$2" require_hashes="$3"
  [[ -f "$path" && ! -L "$path" ]] || return 1
  jq -e --arg employee "$employee" --argjson requireHashes "$require_hashes" '
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
      (if $requireHashes then
        (.sourceHash | type == "string" and test("^[0-9a-f]{64}$"))
      else true end))) and
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
  ' "$path" >/dev/null
}

validate_transaction_root() {
  [[ "$transaction_root" == /opt/assigned-skills/* && "$transaction_root" != *//* ]] || return 1
  [[ ! -L /opt/assigned-skills && ! -L "$transaction_root" ]] || return 1
  [[ -d /opt/assigned-skills ]] || return 1
}

transaction_authorizes_folder() {
  local transaction_path="$1" folder="$2"
  jq -e --arg folder "$folder" '
    any(.skills[]; .folder == $folder) or any(.removals[]; .folder == $folder)
  ' "$transaction_path/current-manifest.json" >/dev/null \
    || jq -e --arg folder "$folder" 'any(.skills[]; .folder == $folder)' "$transaction_path/prior-manifest.json" >/dev/null
}

rollback_transaction() {
  local transaction_path="$1" employee="$2" journal_path
  journal_path="$transaction_path/journal"
  local kind folder had_backup extra target backup index recovery_entry
  local -a recovery_entries=()
  [[ "$transaction_path" == "$transaction_root"/.omc-transaction-* && -d "$transaction_path" && ! -L "$transaction_path" ]] || return 1
  validate_ro_manifest "$transaction_path/current-manifest.json" "$employee" true || return 1
  validate_ro_manifest "$transaction_path/prior-manifest.json" "$employee" false || return 1
  [[ -f "$journal_path" && ! -L "$journal_path" ]] || return 1
  mapfile -t recovery_entries < "$journal_path"
  for recovery_entry in "${recovery_entries[@]}"; do
    IFS='|' read -r kind folder had_backup extra <<< "$recovery_entry"
    [[ ( "$kind" == install || "$kind" == remove ) && ( "$had_backup" == true || "$had_backup" == false ) && -z "$extra" ]] || return 1
    valid_folder "$folder" && transaction_authorizes_folder "$transaction_path" "$folder" || return 1
  done
  for ((index=${#recovery_entries[@]}-1; index>=0; index--)); do
    IFS='|' read -r kind folder had_backup extra <<< "${recovery_entries[$index]}"
    target="$workspace_skills/$folder"; backup="$transaction_path/backups/$folder"
    [[ ! -L "$target" && ! -L "$backup" ]] || return 1
    if [[ "$kind" == install ]]; then
      if [[ "$had_backup" == true ]]; then
        if [[ -d "$backup" ]]; then
          rm -rf --one-file-system -- "$target"
          mv -- "$backup" "$target"
        fi
      else
        rm -rf --one-file-system -- "$target"
      fi
    elif [[ "$had_backup" == true && -d "$backup" && ! -e "$target" ]]; then
      mv -- "$backup" "$target"
    fi
    sync -f "$workspace_skills"; sync -f "$transaction_path/backups"
  done
  rm -rf --one-file-system -- "$transaction_path"
  sync -f "$transaction_root"
}

recover_abandoned_transactions() {
  local employee="$1" abandoned
  shopt -s nullglob
  for abandoned in "$transaction_root"/.omc-preparing-*; do
    [[ -d "$abandoned" && ! -L "$abandoned" ]] || return 1
    rm -rf --one-file-system -- "$abandoned"
  done
  for abandoned in "$transaction_root"/.omc-transaction-*; do
    rollback_transaction "$abandoned" "$employee" || return 1
  done
  sync -f "$transaction_root"
}

if [[ "${1:-}" == "--hash-skill" ]]; then
  folder="${2:-}"; valid_folder "$folder" || exit 64
  hash_tree "/opt/assigned-skills/$folder"; exit $?
fi
if [[ "${1:-}" == "--hash-candidate" ]]; then
  version="${2:-}"; folder="${3:-}"
  source="$(candidate_path "$version" "$folder")" || exit 64
  hash_tree "$source"; exit $?
fi
if [[ "${1:-}" == "--hash-workspace" ]]; then
  folder="${2:-}"; valid_folder "$folder" || exit 64
  validate_workspace_root "$workspace_skills" || exit 65
  hash_tree "$workspace_skills/$folder"; exit $?
fi
if [[ "${1:-}" == "--verify-workspace-absent" ]]; then
  folder="${2:-}"; valid_folder "$folder" || exit 64
  validate_workspace_root "$workspace_skills" || exit 65
  [[ ! -e "$workspace_skills/$folder" && ! -L "$workspace_skills/$folder" ]]; exit $?
fi
if [[ "${1:-}" == "--list-workspace-folders" ]]; then
  validate_workspace_root "$workspace_skills" || exit 65
  [[ ! -e "$workspace_skills" || -d "$workspace_skills" ]] || exit 65
  if [[ -d "$workspace_skills" ]]; then
    while IFS= read -r -d '' path; do
      [[ -d "$path" && ! -L "$path" ]] || exit 65
      basename -- "$path"
    done < <(find "$workspace_skills" -mindepth 1 -maxdepth 1 -print0) | LC_ALL=C sort
  fi
  exit 0
fi

employee_id="${OMC_EMPLOYEE_ID:-}"
valid_id "$employee_id" || { echo "The employee identity is invalid." >&2; exit 64; }
validate_workspace_root "$workspace_skills" || { echo "The canonical workspace skill root is unsafe or symlinked." >&2; exit 65; }
validate_workspace_root "$state_root" || { echo "The canonical training state root is unsafe or symlinked." >&2; exit 65; }
mkdir -p -- "$workspace_skills" "$state_root"
validate_workspace_root "$workspace_skills" && validate_workspace_root "$state_root" || exit 65
mkdir -p -- "$transaction_root"
validate_transaction_root || { echo "The HRM-owned training transaction root is unsafe." >&2; exit 65; }
command -v flock >/dev/null || { echo "The training volume lock is unavailable." >&2; exit 69; }
exec 9>"$transaction_root/.omc-training.lock"
flock -x 9
recover_abandoned_transactions "$employee_id" || { echo "A trusted abandoned training transaction could not be recovered." >&2; exit 67; }
if [[ "${1:-}" == "--recover" ]]; then exit 0; fi

validate_ro_manifest "$manifest_path" "$employee_id" true || { echo "The assigned-skill manifest failed validation." >&2; exit 65; }
validate_ro_manifest "$prior_manifest_path" "$employee_id" false || { echo "The HRM-owned prior managed manifest failed validation." >&2; exit 65; }

manifest_version="$(jq -r '.manifestVersion' "$manifest_path")"
preparing="$(mktemp -d "$transaction_root/.omc-preparing-$manifest_version-XXXXXXXX")" || exit 65
[[ -d "$preparing" && ! -L "$preparing" ]] || exit 65
mkdir -p -- "$preparing/staged" "$preparing/backups"
cp -- "$manifest_path" "$preparing/current-manifest.json"
cp -- "$prior_manifest_path" "$preparing/prior-manifest.json"
journal="$preparing/journal"
: > "$journal"
current_skills_file="$preparing/current-skills.jsonl"
current_folders_file="$preparing/current-folders"
prior_folders_file="$preparing/prior-folders"
if ! jq -c '.skills | sort_by(.id)[]' "$manifest_path" > "$current_skills_file" \
  || ! jq -r '[.skills[].folder] | unique[]' "$manifest_path" > "$current_folders_file" \
  || ! jq -r '[.skills[].folder] | unique[]' "$prior_manifest_path" > "$prior_folders_file"; then
  rm -rf --one-file-system -- "$preparing"; sync -f "$transaction_root"
  exit 65
fi
sync -f "$preparing/current-manifest.json"; sync -f "$preparing/prior-manifest.json"; sync -f "$journal"
sync -f "$preparing/staged"; sync -f "$preparing/backups"; sync -f "$preparing"
transaction="${preparing/.omc-preparing-/.omc-transaction-}"
mv -- "$preparing" "$transaction"; sync -f "$transaction_root"
journal="$transaction/journal"
current_skills_file="$transaction/current-skills.jsonl"
current_folders_file="$transaction/current-folders"
prior_folders_file="$transaction/prior-folders"
commits=0
moves=0
transaction_live=true

rollback() {
  [[ "$transaction_live" == true && -d "$transaction" && ! -L "$transaction" ]] || return 0
  rollback_transaction "$transaction" "$employee_id"
}
trap rollback EXIT HUP INT TERM

copy_and_verify() {
  local skill folder expected source staged source_hash staged_hash
  skill="$1"
  folder="$(jq -r '.folder' <<< "$skill")"; valid_folder "$folder" || return 1
  expected="$(jq -r '.sourceHash' <<< "$skill")"; valid_digest "$expected" || return 1
  source="$(candidate_path "$manifest_version" "$folder")" || return 1
  staged="$transaction/staged/$folder"
  [[ -d "$source" && ! -L "$source" ]] || return 1
  source_hash="$(hash_tree "$source")" || return 1
  [[ "$source_hash" == "$expected" ]] || return 1
  mkdir -p -- "$staged"
  tar -C "$source" -cf - . | tar -C "$staged" -xf -
  staged_hash="$(hash_tree "$staged")" || return 1
  [[ "$staged_hash" == "$expected" ]]
}

# Sense and stage the entire desired set before touching a live workspace path.
while IFS= read -r skill; do
  copy_and_verify "$skill" || { echo "A desired skill failed source or staged verification; the last workspace state was preserved." >&2; exit 66; }
done < "$current_skills_file"

# Preflight every path that may be moved. The employee cannot redirect an
# operation through a symlink or a non-directory node.
while IFS= read -r folder; do
  valid_folder "$folder" || exit 65
  target="$workspace_skills/$folder"
  [[ ! -L "$target" ]] || exit 65
  [[ ! -e "$target" || -d "$target" ]] || exit 65
done < "$current_folders_file"
while IFS= read -r folder; do
  valid_folder "$folder" || exit 65
  target="$workspace_skills/$folder"
  [[ ! -L "$target" ]] || exit 65
  [[ ! -e "$target" || -d "$target" ]] || exit 65
done < "$prior_folders_file"

maybe_inject_failure() {
  local fail_after="${OMC_SYNC_FAIL_AFTER_COMMITS:-0}"
  [[ "$fail_after" =~ ^[0-9]+$ ]] || return 64
  if (( fail_after > 0 && commits >= fail_after )); then
    echo "Injected training transaction failure after $commits commit operations." >&2
    return 75
  fi
}

maybe_inject_uncatchable_crash() {
  local kill_after="${OMC_SYNC_KILL_AFTER_MOVES:-0}"
  [[ "$kill_after" =~ ^[0-9]+$ ]] || return 64
  moves=$((moves + 1))
  if (( kill_after > 0 && moves >= kill_after )); then
    echo "Injecting an uncatchable training crash after durable move $moves." >&2
    kill -KILL "$BASHPID"
  fi
}

journal_entries=0
write_ahead() {
  local kind="$1" folder="$2" had_backup="$3" fail_after="${OMC_SYNC_FAIL_AFTER_JOURNALS:-0}"
  [[ "$fail_after" =~ ^[0-9]+$ ]] || return 64
  printf '%s|%s|%s\n' "$kind" "$folder" "$had_backup" >> "$journal"
  sync -f "$journal"
  journal_entries=$((journal_entries + 1))
  if (( fail_after > 0 && journal_entries >= fail_after )); then
    echo "Injected training transaction failure after durable write-ahead journal entry $journal_entries." >&2
    return 75
  fi
}

while IFS= read -r skill; do
  folder="$(jq -r '.folder' <<< "$skill")"
  target="$workspace_skills/$folder"; staged="$transaction/staged/$folder"; backup="$transaction/backups/$folder"
  had_backup=false
  if [[ -d "$target" ]]; then had_backup=true; fi
  write_ahead install "$folder" "$had_backup" || exit $?
  if [[ "$had_backup" == true ]]; then
    mv -- "$target" "$backup"; sync -f "$workspace_skills"; sync -f "$transaction/backups"
    maybe_inject_uncatchable_crash || exit $?
  fi
  if ! mv -- "$staged" "$target"; then
    if [[ "$had_backup" == true && ! -e "$target" ]]; then mv -- "$backup" "$target"; fi
    exit 66
  fi
  sync -f "$workspace_skills"; sync -f "$transaction/staged"
  maybe_inject_uncatchable_crash || exit $?
  commits=$((commits + 1)); maybe_inject_failure || exit $?
done < "$current_skills_file"

# Delete authority comes only from the prior HRM-published, read-only manifest.
while IFS= read -r folder; do
  valid_folder "$folder" || exit 65
  if jq -e --arg folder "$folder" '.skills | any(.folder == $folder)' "$manifest_path" >/dev/null; then continue; fi
  target="$workspace_skills/$folder"; backup="$transaction/backups/$folder"
  if [[ -d "$target" ]]; then
    write_ahead remove "$folder" true || exit $?
    mv -- "$target" "$backup"; sync -f "$workspace_skills"; sync -f "$transaction/backups"
    maybe_inject_uncatchable_crash || exit $?
    commits=$((commits + 1)); maybe_inject_failure || exit $?
  fi
done < "$prior_folders_file"

applied_lines="$transaction/applied-lines"
: > "$applied_lines"
while IFS= read -r skill; do
  folder="$(jq -r '.folder' <<< "$skill")"; expected="$(jq -r '.sourceHash' <<< "$skill")"
  verified_hash="$(hash_tree "$workspace_skills/$folder")" || exit 66
  [[ "$verified_hash" == "$expected" ]] || exit 66
  jq -c --arg verifiedHash "$verified_hash" '. + {verifiedHash:$verifiedHash}' <<< "$skill" >> "$applied_lines"
done < "$current_skills_file"
while IFS= read -r folder; do
  if jq -e --arg folder "$folder" '.skills | any(.folder == $folder)' "$manifest_path" >/dev/null; then continue; fi
  [[ ! -e "$workspace_skills/$folder" && ! -L "$workspace_skills/$folder" ]] || exit 66
done < "$prior_folders_file"

skills_json="$(jq -sc 'sort_by(.id)' "$applied_lines")"
next_state="$transaction/applied.json"
jq -nc --arg employeeId "$employee_id" --arg manifestVersion "$manifest_version" \
  --arg appliedAt "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" --argjson skills "$skills_json" \
  '{schemaVersion:2,employeeId:$employeeId,manifestVersion:$manifestVersion,appliedAt:$appliedAt,skills:$skills}' > "$next_state"
chmod 0600 "$next_state"
mv -- "$next_state" "$state_root/applied.json"
sync -f "$state_root"
cat "$state_root/applied.json"
transaction_live=false
rm -rf --one-file-system -- "$transaction"
sync -f "$transaction_root"
trap - EXIT HUP INT TERM
