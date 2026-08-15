#!/bin/sh
set -eu

if [ -f /run/secrets/github_token ]; then
  GH_TOKEN="$(cat /run/secrets/github_token)"
  export GH_TOKEN
fi

job="$(cat)"
run_id="$(printf '%s' "$job" | jq -r '.runId')"
sandbox="$(printf '%s' "$job" | jq -r '.sandbox')"
repository_url="$(printf '%s' "$job" | jq -r '.repositoryUrl // ""')"
workspace_run_id="$(printf '%s' "$job" | jq -r '.workspaceRunId // .runId')"
prompt="$(printf '%s' "$job" | jq -r '.prompt')"
safe_run="$(printf '%s' "$run_id" | tr -c 'A-Za-z0-9_.-' '-')"
safe_workspace_run="$(printf '%s' "$workspace_run_id" | tr -c 'A-Za-z0-9_.-' '-')"

case "$run_id" in *[!A-Za-z0-9_.-]*|'') echo "Unsafe run id." >&2; exit 64 ;; esac
case "$workspace_run_id" in *[!A-Za-z0-9_.-]*|'') echo "Unsafe workspace run id." >&2; exit 64 ;; esac
case "$sandbox" in read-only|workspace-write) ;; *) echo "Unsupported sandbox policy." >&2; exit 64 ;; esac
if [ -n "$repository_url" ]; then
  case "$repository_url" in
    https://github.com/VincentL01/*.git|https://github.com/VincentL01/*) ;;
    *) echo "Repository is outside the approved VincentL01 boundary." >&2; exit 64 ;;
  esac
fi

jobs_root="/workspace/jobs"
run_root="$jobs_root/$safe_workspace_run"
result_root="/workspace/.company/runs"
result_file="$result_root/$safe_run.json"
mkdir -p "$jobs_root" "$result_root"

if [ ! -d "$run_root" ]; then
  if [ -n "$repository_url" ]; then
    if [ -n "${GH_TOKEN:-}" ]; then gh auth setup-git >/dev/null 2>&1 || true; fi
    git clone "$repository_url" "$run_root"
  else
    mkdir -p "$run_root"
  fi
fi

if [ -f /workspace/AGENTS.md ]; then cp /workspace/AGENTS.md "$run_root/AGENTS.md"; fi
if [ -d /workspace/.agents ]; then
  rm -rf "$run_root/.agents"
  cp -R /workspace/.agents "$run_root/.agents"
fi

set -- codex exec \
  --json \
  --color never \
  --sandbox "$sandbox" \
  --ephemeral \
  --skip-git-repo-check \
  --cd "$run_root" \
  --output-schema /opt/one-man-company/run-result.schema.json \
  --output-last-message "$result_file"

if [ "${OMC_REPOSITORY_WRITE:-false}" = "true" ]; then
  set -- "$@" --config 'sandbox_workspace_write.network_access=true'
fi

printf '%s' "$prompt" | "$@" -
