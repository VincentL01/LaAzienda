#!/usr/bin/env bash
set -Eeuo pipefail

employee_id="${1:?employee identity required}"
control_volume="${2:?control volume required}"
installed_volume="${3:?installed volume required}"
sed '/^auth_version=/,$d' /opt/one-man-company/reconcile > /tmp/reconcile-functions.sh
. /tmp/reconcile-functions.sh

docker run --rm --user 0 --entrypoint bash --volume "$installed_volume:/target" "$base_image_id" -c '
  set -Eeuo pipefail
  mkdir -p /target/trusted
  printf "%s\n" "trusted installed bytes" > /target/trusted/SKILL.md
  chmod 0644 /target/trusted/SKILL.md
  chown -R 1001:1001 /target
'
source_hash="$(docker run --rm --user 1001:1001 --entrypoint /usr/local/bin/sync-company-skills \
  --volume "$installed_volume:/workspace/.agents/skills:ro" "$base_image_id" --hash-workspace trusted)"
valid_digest "$source_hash"

manifest_v1="$(printf authority-v1 | sha256sum)"; manifest_v1="${manifest_v1%% *}"
authority="$(jq -nc --arg employeeId "$employee_id" --arg manifestVersion "$manifest_v1" --arg sourceHash "$source_hash" \
  '{schemaVersion:2,employeeId:$employeeId,manifestVersion:$manifestVersion,skills:[
    {id:"trusted-skill",folder:"trusted",assignmentVersion:1,sourceHash:$sourceHash}],removals:[]}')"
valid_managed_manifest "$employee_id" "$authority"
publish_manifest_file "$control_volume" ".omc-training-managed.json" "$employee_id" "$authority"
if volume_file_exists "$control_volume" ".omc-training-managed.last-good.json"; then
  echo "The partial-publication fixture requires a sole managed authority." >&2
  exit 90
fi
before="$(read_volume_file "$control_volume" ".omc-training-managed.json")"
before_hash="$(printf '%s' "$before" | sha256sum)"; before_hash="${before_hash%% *}"
before_size="$(printf '%s' "$before" | wc -c)"

manifest_v2="$(printf authority-v2 | sha256sum)"; manifest_v2="${manifest_v2%% *}"
replacement="$(jq -nc --arg employeeId "$employee_id" --arg manifestVersion "$manifest_v2" --arg sourceHash "$source_hash" \
  '{schemaVersion:2,employeeId:$employeeId,manifestVersion:$manifestVersion,skills:[
    {id:"trusted-skill",folder:"trusted",assignmentVersion:2,sourceHash:$sourceHash}],removals:[]}')"
replacement_hash="$(printf '%s' "$replacement" | sha256sum)"; replacement_hash="${replacement_hash%% *}"
replacement_size="$(printf '%s' "$replacement" | wc -c)"
truncated="${replacement%?}"
[[ -n "$truncated" && "$truncated" != "$replacement" ]]
if printf '%s' "$truncated" | write_volume_file "$control_volume" ".omc-training-managed.json" 0644 \
  "$replacement_hash" "$replacement_size"; then
  echo "A truncated authority publication unexpectedly succeeded." >&2
  exit 91
else
  partial_status=$?
fi
[[ "$partial_status" -eq 65 ]]

after="$(read_volume_file "$control_volume" ".omc-training-managed.json")"
after_hash="$(printf '%s' "$after" | sha256sum)"; after_hash="${after_hash%% *}"
after_size="$(printf '%s' "$after" | wc -c)"
[[ "$after" == "$before" && "$after_hash" == "$before_hash" && "$after_size" == "$before_size" ]]
valid_managed_manifest "$employee_id" "$after"
verified_installed_hash="$(docker run --rm --user 1001:1001 --entrypoint /usr/local/bin/sync-company-skills \
  --volume "$installed_volume:/workspace/.agents/skills:ro" "$base_image_id" --hash-workspace trusted)"
[[ "$verified_installed_hash" == "$source_hash" ]]
if volume_file_exists "$control_volume" ".omc-training-managed.last-good.json"; then exit 92; fi
echo "PASS: truncated nonempty publication exited 65 and preserved the sole valid nonempty installed-volume authority ($before_size bytes, $before_hash)."
