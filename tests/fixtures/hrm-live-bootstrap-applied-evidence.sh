#!/usr/bin/env bash
set -Eeuo pipefail

employee_id="${1:?employee identity required}"
sed '/^auth_version=/,$d' /opt/one-man-company/reconcile > /tmp/reconcile-functions.sh
. /tmp/reconcile-functions.sh

manifest_version="$(printf applied-evidence | sha256sum)"; manifest_version="${manifest_version%% *}"
expected_skills='[]'
valid_evidence="$(jq -nc --arg employeeId "$employee_id" --arg manifestVersion "$manifest_version" \
  '{schemaVersion:2,employeeId:$employeeId,manifestVersion:$manifestVersion,
    appliedAt:"2026-08-22T12:00:00Z",skills:[]}')"
valid_applied_evidence "$employee_id" "$manifest_version" "$expected_skills" "$valid_evidence"

if valid_applied_evidence "$employee_id" "$manifest_version" "$expected_skills" ""; then
  echo "Empty applied evidence unexpectedly validated." >&2
  exit 90
fi
if valid_applied_evidence "$employee_id" "$manifest_version" "$expected_skills" $'  \n\t'; then
  echo "Whitespace-only applied evidence unexpectedly validated." >&2
  exit 91
fi
concatenated_evidence="${valid_evidence}"$'\n'"${valid_evidence}"
if valid_applied_evidence "$employee_id" "$manifest_version" "$expected_skills" "$concatenated_evidence"; then
  echo "Concatenated applied evidence unexpectedly validated." >&2
  exit 92
fi
echo "PASS: production applied-evidence validation accepts one exact object and rejects empty, whitespace-only, and concatenated documents."
