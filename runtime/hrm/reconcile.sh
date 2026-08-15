#!/bin/sh
set -eu

control_url="${OMC_CONTROL_URL:-http://host.docker.internal:3000}"
hrm_id="${OMC_EMPLOYEE_ID:-employee-hrm}"
base_image="${OMC_BASE_IMAGE:-one-man-company/codex-employee:local}"
company_network="${OMC_DOCKER_NETWORK:-one-man-company}"
training_root="${OMC_TRAINING_ROOT:-/company/training-cache}"
state_root="${OMC_STATE_ROOT:-/company/state}"

if [ ! -S /var/run/docker.sock ]; then
  echo "HRM cannot reconcile employees because the Docker socket is unavailable." >&2
  exit 78
fi

headers=""
if [ -n "${OMC_RUNTIME_BRIDGE_TOKEN:-}" ]; then
  headers="x-runtime-bridge-token: ${OMC_RUNTIME_BRIDGE_TOKEN}"
fi

api_get() {
  if [ -n "$headers" ]; then curl --fail --silent --show-error -H "$headers" "$1"; else curl --fail --silent --show-error "$1"; fi
}

api_post() {
  if [ -n "$headers" ]; then
    curl --fail --silent --show-error -H "$headers" -H "content-type: application/json" --data "$2" "$1" >/dev/null
  else
    curl --fail --silent --show-error -H "content-type: application/json" --data "$2" "$1" >/dev/null
  fi
}

safe_id() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9_.-' '-'
}

skill_folder() {
  package_ref="$1"
  suffix="${package_ref##*@}"
  if [ "$suffix" = "$package_ref" ]; then suffix="${package_ref##*/}"; fi
  case "$suffix" in *[!A-Za-z0-9_.-]*|'') return 1 ;; esac
  printf '%s' "$suffix"
}

write_volume_file() {
  volume="$1"
  target="$2"
  mode="$3"
  docker run --rm -i --user 0 --entrypoint sh --volume "$volume:/target" "$base_image" -c "umask 077; mkdir -p \"\$(dirname '/target/$target')\"; cat > '/target/$target'; chmod '$mode' '/target/$target'; chown -R 1001:1001 /target"
}

report_runtime() {
  employee_id="$1"
  runtime_status="$2"
  detail="$3"
  identity="$4"
  event_key="$(safe_id "$employee_id:$runtime_status:$identity")"
  payload="$(jq -nc --arg employeeId "$employee_id" --arg eventKey "$event_key" --arg runtimeStatus "$runtime_status" --arg detail "$detail" '{action:"reportRuntime",employeeId:$employeeId,eventKey:$eventKey,runtimeStatus:$runtimeStatus,detail:$detail}')"
  api_post "$control_url/api/employees" "$payload"
}

workforce="$(api_get "$control_url/api/employees")"
violations="$(printf '%s' "$workforce" | jq -r --arg hrm "$hrm_id" '.employees[] | select(.dockerSocketAccess == true and .id != $hrm) | .id')"
if [ -n "$violations" ]; then
  echo "Docker socket policy violation: $violations" >&2
  exit 77
fi

printf '%s' "$workforce" | jq -c --arg hrm "$hrm_id" '.employees[] | select(.id != $hrm)' | while IFS= read -r employee; do
  employee_id="$(printf '%s' "$employee" | jq -r '.id')"
  employee_name="$(printf '%s' "$employee" | jq -r '.name')"
  container_name="$(printf '%s' "$employee" | jq -r '.containerName')"
  desired="$(printf '%s' "$employee" | jq -r '.desiredRuntimeStatus')"
  employment_type="$(printf '%s' "$employee" | jq -r '.employmentType')"
  role_profile="$(printf '%s' "$employee" | jq -r '.roleProfileId // ""')"
  safe_employee="$(safe_id "$employee_id")"

  case "$container_name" in *[!A-Za-z0-9_.-]*|'') echo "Skipping unsafe container name for $employee_name" >&2; continue ;; esac

  if docker container inspect "$container_name" >/dev/null 2>&1; then exists=true; else exists=false; fi

  if [ "$desired" = "running" ] && [ "$exists" = false ]; then
    workspace_volume="omc-workspace-$safe_employee"
    skills_volume="omc-skills-$safe_employee"
    secrets_volume="omc-secrets-$safe_employee"
    docker volume create "$workspace_volume" >/dev/null
    docker volume create "$skills_volume" >/dev/null
    docker volume create "$secrets_volume" >/dev/null

    prompt="$(printf '%s' "$employee" | jq -r '.systemPrompt')"
    role="$(printf '%s' "$employee" | jq -r '.role')"
    department="$(printf '%s' "$employee" | jq -r '.department')"
    printf '# %s - %s\n\nDepartment: %s\nEmployment type: %s\n\n%s\n\n## Company execution rules\n\n- Use company-status whenever current company evidence is required.\n- Never read, print, return, or commit credentials.\n- Repository changes must use a codex/* branch and a pull request. Never commit or push directly to main.\n- Treat the structured executor result as the durable handoff.\n' "$employee_name" "$role" "$department" "$employment_type" "$prompt" | write_volume_file "$workspace_volume" "AGENTS.md" 0644

    printf '%s' "$employee" | jq -c '.skills[] | select(.cacheStatus == "cached")' | while IFS= read -r skill; do
      package_ref="$(printf '%s' "$skill" | jq -r '.packageRef')"
      folder="$(skill_folder "$package_ref")"
      source="$training_root/$folder"
      if [ ! -f "$source/SKILL.md" ]; then
        echo "Cached skill $folder is missing from the Training Center mount." >&2
        exit 66
      fi
      tar -C "$source" -cf - . | docker run --rm -i --user 0 --entrypoint sh --volume "$skills_volume:/target" "$base_image" -c "mkdir -p '/target/$folder' && tar -C '/target/$folder' -xf - && chown -R 1001:1001 /target"
    done

    mail_secret="$state_root/$employee_id/mail-password"
    if [ -f "$mail_secret" ]; then
      write_volume_file "$secrets_volume" "mail_password" 0400 < "$mail_secret"
    fi

    set -- docker create --name "$container_name" \
      --label "one-man-company.employee=$employee_id" \
      --label "one-man-company.employment-type=$employment_type" \
      --restart unless-stopped \
      --network "$company_network" \
      --add-host host.docker.internal:host-gateway \
      --env "OMC_EMPLOYEE_ID=$employee_id" \
      --env "OMC_CONTROL_URL=$control_url" \
      --env "OMC_MAIL_DOMAIN=one-man-company.test" \
      --env "OMC_MAIL_ADDRESS=$(printf '%s' "$employee" | jq -r '.emailAddress // ""')" \
      --env "OMC_MAIL_SMTP_HOST=stalwart" --env "OMC_MAIL_SMTP_PORT=587" \
      --env "OMC_MAIL_IMAP_HOST=stalwart" --env "OMC_MAIL_IMAP_PORT=993" \
      --volume "$workspace_volume:/workspace" \
      --volume "$skills_volume:/opt/assigned-skills:ro" \
      --volume "$secrets_volume:/run/company-secrets:ro" \
      --volumes-from omc-auth-source:ro

    if [ "$role_profile" = "project-manager" ] && docker container inspect omc-github-source >/dev/null 2>&1; then
      set -- "$@" --volumes-from omc-github-source:ro
    fi

    set -- "$@" "$base_image"
    "$@" >/dev/null
    docker start "$container_name" >/dev/null
    exists=true
  elif [ "$desired" = "running" ] && [ "$exists" = true ]; then
    current="$(docker container inspect --format '{{.State.Status}}' "$container_name")"
    if [ "$current" = "exited" ] || [ "$current" = "created" ]; then docker start "$container_name" >/dev/null; fi
  elif [ "$desired" = "stopped" ] && [ "$exists" = true ]; then
    current="$(docker container inspect --format '{{.State.Status}}' "$container_name")"
    if [ "$current" = "running" ] || [ "$current" = "paused" ] || [ "$current" = "restarting" ]; then docker stop "$container_name" >/dev/null; fi
  fi

  if docker container inspect "$container_name" >/dev/null 2>&1; then
    runtime_status="$(docker container inspect --format '{{.State.Status}}' "$container_name")"
    identity="$(docker container inspect --format '{{.State.StartedAt}}-{{.State.FinishedAt}}' "$container_name")"
    report_runtime "$employee_id" "$runtime_status" "Docker state observed and reported by the HR Manager." "$identity"
  else
    report_runtime "$employee_id" "not_found" "The HR Manager did not find the requested employee container." "missing"
  fi
done
