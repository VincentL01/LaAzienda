#!/usr/bin/env bash
set -Eeuo pipefail

employee_id="${1:?employee identity required}"
workspace_volume="${2:?workspace volume required}"
installed_volume="${3:?installed volume required}"
control_volume="${4:?control volume required}"
sed '/^auth_version=/,$d' /opt/one-man-company/reconcile > /tmp/reconcile-functions.sh
. /tmp/reconcile-functions.sh

empty_manifest="$(jq -nc --arg employeeId "$employee_id" --arg manifestVersion "$(printf '' | sha256sum | awk '{print $1}')" \
  '{schemaVersion:2,employeeId:$employeeId,manifestVersion:$manifestVersion,skills:[],removals:[]}')"
if valid_managed_manifest "$employee_id" "$empty_manifest"; then
  echo "valid-empty-manifest=0"
else
  echo "valid-empty-manifest=$?"
fi
if actual_folders="$(workspace_skill_folders "$employee_id" "" false "$workspace_volume" "$installed_volume")"; then
  printf 'folder-enumeration=0 count=%s value=%q\n' "$(grep -c . <<< "$actual_folders" || true)" "$actual_folders"
else
  echo "folder-enumeration=$?"
fi
if manifest_matches_installed_volume "$employee_id" "$empty_manifest" "$workspace_volume" "$installed_volume"; then
  echo "empty-volume-proof=0"
else
  echo "empty-volume-proof=$?"
fi
