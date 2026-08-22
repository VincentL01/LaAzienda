#!/bin/sh
set -eu

control_url="${OMC_CONTROL_URL:-http://host.docker.internal:3002}"
worker_id="${OMC_WORKER_ID:-omc-hrm}"
idle_seconds="${OMC_LOOP_SECONDS:-5}"
heartbeat_seconds="${OMC_HEARTBEAT_SECONDS:-10}"
dispatcher_state_root="${OMC_DISPATCHER_STATE_ROOT:-/workspace/.company/dispatcher}"
claim_generation_file="${OMC_RECONCILE_STATE_ROOT:-/workspace/.company/reconcile}/claim-training-generation"
active_marker="$dispatcher_state_root/active-run.json"
terminal_outbox="$dispatcher_state_root/terminal-outbox"
active_container=""

headers=""
if [ -n "${OMC_RUNTIME_BRIDGE_TOKEN:-}" ]; then
  headers="x-runtime-bridge-token: ${OMC_RUNTIME_BRIDGE_TOKEN}"
fi

api_post_json() {
  if [ -n "$headers" ]; then
    curl --fail --silent --show-error -H "$headers" -H "content-type: application/json" --data "$2" "$1"
  else
    curl --fail --silent --show-error -H "content-type: application/json" --data "$2" "$1"
  fi
}

post_run_action() {
  api_post_json "$control_url/api/executor" "$1" >/dev/null
}

atomic_write_json() {
  target="$1"
  payload="$2"
  if parent="$(dirname "$target")"; then :; else return 74; fi
  [ -d "$parent" ] && [ ! -L "$parent" ] || return 65
  if temporary="$(mktemp "$parent/.omc-publish-XXXXXXXX")"; then :; else return 74; fi
  if ! printf '%s' "$payload" > "$temporary"; then rm -f -- "$temporary" >/dev/null 2>&1 || return 74; return 74; fi
  if ! chmod 0600 "$temporary"; then rm -f -- "$temporary" >/dev/null 2>&1 || return 74; return 74; fi
  if ! sync -f "$temporary"; then rm -f -- "$temporary" >/dev/null 2>&1 || return 74; return 74; fi
  if ! mv -f -- "$temporary" "$target"; then rm -f -- "$temporary" >/dev/null 2>&1 || return 74; return 74; fi
  # A failed directory sync leaves the caller's preceding state intact. The
  # renamed file may be replayed, but may never authorize clearing a marker.
  sync -f "$parent" || return 74
  return 0
}

validate_result_json() {
  printf '%s' "$1" | jq -e '
    type == "object" and
    (keys | sort) == (["status","summary","current_state","deliverables","decisions","follow_up","knowledge"] | sort) and
    (.status == "completed" or .status == "needs_input") and
    (.summary | type == "string" and (gsub("^\\s+|\\s+$"; "") | length >= 20)) and
    (.current_state | type == "string" and (gsub("^\\s+|\\s+$"; "") | length >= 5)) and
    (.deliverables | type == "array" and all(.[]; type == "string")) and
    (.decisions | type == "array" and all(.[]; type == "string")) and
    (.follow_up | type == "array" and all(.[]; type == "string")) and
    (.knowledge | type == "string" and (gsub("^\\s+|\\s+$"; "") | length >= 20))
  ' >/dev/null 2>&1
}

validate_terminal_payload() {
  terminal_candidate="$1"
  if ! printf '%s' "$terminal_candidate" | jq -e --arg worker "$worker_id" '
    type == "object" and .workerId == $worker and
    (.runId | type == "string" and test("^[A-Za-z0-9_.-]{1,120}$")) and
    ((.action == "complete" and (.result | type == "object")) or
     (.action == "fail" and (.failureCode | type == "string" and length > 0 and length <= 80)))
  ' >/dev/null 2>&1; then return 65; fi
  if terminal_action="$(printf '%s' "$terminal_candidate" | jq -r '.action')"; then :; else return 65; fi
  if [ "$terminal_action" = "complete" ]; then
    if terminal_result="$(printf '%s' "$terminal_candidate" | jq -c '.result')"; then :; else return 65; fi
    validate_result_json "$terminal_result" || return 65
  fi
  return 0
}

queue_terminal_action() {
  safe_run_id="$1"
  payload="$2"
  case "$safe_run_id" in *[!A-Za-z0-9_.-]*|'') return 64 ;; esac
  validate_terminal_payload "$payload" || return 65
  if atomic_write_json "$terminal_outbox/$safe_run_id.json" "$payload"; then return 0; else queue_status=$?; return "$queue_status"; fi
}

drain_terminal_outbox() {
  for terminal_file in "$terminal_outbox"/*.json; do
    [ -e "$terminal_file" ] || [ -L "$terminal_file" ] || continue
    [ -f "$terminal_file" ] && [ ! -L "$terminal_file" ] || return 65
    if terminal_name="$(basename "$terminal_file")"; then :; else return 65; fi
    case "$terminal_name" in *[!A-Za-z0-9_.-]*|'') return 65 ;; esac
    if terminal_payload="$(cat "$terminal_file")"; then :; else return 65; fi
    validate_terminal_payload "$terminal_payload" || return 65
    post_run_action "$terminal_payload" || return 1
    rm -f -- "$terminal_file" || return 74
    sync -f "$terminal_outbox" || return 74
  done
  return 0
}

inspect_container_identity() {
  inspect_target="$1"
  case "$inspect_target" in *[!A-Za-z0-9_.-]*|'') return 64 ;; esac
  if inspect_observation="$(docker container inspect --format '{{.Id}}|{{.State.Status}}|{{.State.Restarting}}' "$inspect_target" 2>&1)"; then
    inspect_id="${inspect_observation%%|*}"
    inspect_rest="${inspect_observation#*|}"
    inspect_state="${inspect_rest%%|*}"
    inspect_restarting="${inspect_rest#*|}"
    [ "$inspect_rest" != "$inspect_observation" ] && [ "$inspect_restarting" != "$inspect_rest" ] || return 75
    [ "${#inspect_id}" -eq 64 ] || return 75
    case "$inspect_id" in *[!a-f0-9]*) return 75 ;; esac
    case "$inspect_state" in created|running|paused|restarting|removing|exited|dead) ;; *) return 75 ;; esac
    case "$inspect_restarting" in true|false) ;; *) return 75 ;; esac
    printf '%s' "$inspect_observation"
    return 0
  fi
  case "$inspect_observation" in
    "Error: No such object: $inspect_target"|"Error: No such container: $inspect_target"|"Error response from daemon: No such container: $inspect_target") return 44 ;;
    *) printf '%s\n' "$inspect_observation" >&2; return 75 ;;
  esac
}

quiesce_container() {
  quiesce_target="$1"
  if quiesce_before="$(inspect_container_identity "$quiesce_target")"; then :; else
    quiesce_inspect_status=$?
    [ "$quiesce_inspect_status" -eq 44 ] && return 0
    return 75
  fi
  quiesce_id="${quiesce_before%%|*}"
  if docker restart "$quiesce_id" >/dev/null 2>&1; then
    if quiesce_after="$(inspect_container_identity "$quiesce_id")"; then
      quiesce_after_id="${quiesce_after%%|*}"
      quiesce_after_rest="${quiesce_after#*|}"
      quiesce_after_state="${quiesce_after_rest%%|*}"
      quiesce_after_restarting="${quiesce_after_rest#*|}"
      if [ "$quiesce_after_id" = "$quiesce_id" ] && [ "$quiesce_after_state" = running ] && [ "$quiesce_after_restarting" = false ]; then return 0; fi
    else
      quiesce_after_status=$?
      [ "$quiesce_after_status" -eq 44 ] && return 0
    fi
  fi
  echo "Aurelia could not verify a stable restart for $quiesce_target; forcing a verified stop before any later claim." >&2
  if ! docker stop "$quiesce_id" >/dev/null 2>&1; then
    if quiesce_missing="$(inspect_container_identity "$quiesce_id")"; then return 75; else
      quiesce_missing_status=$?
      [ "$quiesce_missing_status" -eq 44 ] && return 0
      return 75
    fi
  fi
  if quiesce_stopped="$(inspect_container_identity "$quiesce_id")"; then :; else
    quiesce_stopped_status=$?
    [ "$quiesce_stopped_status" -eq 44 ] && return 0
    return 75
  fi
  quiesce_stopped_id="${quiesce_stopped%%|*}"
  quiesce_stopped_rest="${quiesce_stopped#*|}"
  quiesce_stopped_state="${quiesce_stopped_rest%%|*}"
  [ "$quiesce_stopped_id" = "$quiesce_id" ] || return 75
  case "$quiesce_stopped_state" in exited|created) return 0 ;; *) return 75 ;; esac
}

read_result_json() {
  result_container="$1"
  result_safe_run="$2"
  case "$result_container:$result_safe_run" in *[!A-Za-z0-9_.:-]*|*:*:*) return 64 ;; esac
  docker exec "$result_container" sh -c '
    path="$1"
    [ -f "$path" ] && [ ! -L "$path" ] || exit 65
    bytes="$(wc -c < "$path")"
    [ "$bytes" -le 24576 ] || exit 65
    cat "$path"
  ' _ "/workspace/.company/runs/$result_safe_run.json"
}

clear_active_marker() {
  rm -f -- "$active_marker" || return 74
  sync -f "$dispatcher_state_root" || return 74
  active_container=""
  return 0
}

recover_interrupted_run() {
  [ -e "$active_marker" ] || return 0
  [ -f "$active_marker" ] && [ ! -L "$active_marker" ] || return 65
  if marker_payload="$(cat "$active_marker")"; then :; else return 65; fi
  if ! printf '%s' "$marker_payload" | jq -e '
    type == "object" and
    (.runId | type == "string" and test("^[A-Za-z0-9_.-]{1,120}$")) and
    (.safeRun | type == "string" and test("^[A-Za-z0-9_.-]{1,120}$")) and
    .safeRun == .runId and
    (.containerName | type == "string" and test("^[A-Za-z0-9_.-]{1,120}$")) and
    (.containerId | type == "string" and test("^[a-f0-9]{64}$")) and
    ((.phase == "executing" and .executionStatus == null) or
     (.phase == "post-exec" and (.executionStatus | type == "number" and floor == . and . >= 0 and . <= 255)))
  ' >/dev/null; then return 65; fi
  if recovered_run_id="$(printf '%s' "$marker_payload" | jq -r '.runId')"; then :; else return 65; fi
  if recovered_safe_run="$(printf '%s' "$marker_payload" | jq -r '.safeRun')"; then :; else return 65; fi
  if recovered_container_id="$(printf '%s' "$marker_payload" | jq -r '.containerId')"; then :; else return 65; fi
  if recovered_phase="$(printf '%s' "$marker_payload" | jq -r '.phase')"; then :; else return 65; fi
  if recovered_execution_status="$(printf '%s' "$marker_payload" | jq -r '.executionStatus // -1')"; then :; else return 65; fi
  active_container="$recovered_container_id"
  quiesce_container "$recovered_container_id" || return 75
  if [ ! -f "$terminal_outbox/$recovered_safe_run.json" ]; then
    if [ "$recovered_phase" = post-exec ] && [ "$recovered_execution_status" -eq 0 ] \
      && recovered_result="$(read_result_json "$recovered_container_id" "$recovered_safe_run" 2>/dev/null)" \
      && validate_result_json "$recovered_result"; then
      if recovered_terminal="$(jq -nc --arg action complete --arg workerId "$worker_id" --arg runId "$recovered_run_id" \
        --argjson result "$recovered_result" '{action:$action,workerId:$workerId,runId:$runId,result:$result}')"; then :; else return 65; fi
    else
      if recovered_terminal="$(jq -nc --arg action fail --arg workerId "$worker_id" --arg runId "$recovered_run_id" \
        --arg failureCode execution_failed '{action:$action,workerId:$workerId,runId:$runId,failureCode:$failureCode}')"; then :; else return 65; fi
    fi
    queue_terminal_action "$recovered_safe_run" "$recovered_terminal" || return $?
  fi
  clear_active_marker || return $?
  return 0
}

quiesce_active_on_exit() {
  if [ -n "$active_container" ]; then
    quiesce_container "$active_container" >/dev/null 2>&1 || true
  fi
}

report_event() {
  run_id="$1"
  sequence="$2"
  event_type="$3"
  thread_id="$4"
  payload="$(jq -nc --arg action event --arg workerId "$worker_id" --arg runId "$run_id" \
    --arg eventKey "$run_id:$sequence:$event_type" --arg eventType "$event_type" --arg threadId "$thread_id" \
    '{action:$action,workerId:$workerId,runId:$runId,eventKey:$eventKey,eventType:$eventType,threadId:$threadId}')"
  post_run_action "$payload"
}

consume_events() {
  run_id="$1"
  sequence=0
  while IFS= read -r event_line; do
    sequence=$((sequence + 1))
    raw_type="$(printf '%s' "$event_line" | jq -r '.type // empty' 2>/dev/null || true)"
    thread_id=""
    event_type=""
    case "$raw_type" in
      thread.started)
        event_type="thread.started"
        thread_id="$(printf '%s' "$event_line" | jq -r '.thread_id // empty' 2>/dev/null || true)"
        ;;
      turn.started|turn.completed|error) event_type="$raw_type" ;;
      item.started|item.completed)
        item_type="$(printf '%s' "$event_line" | jq -r '.item.type // empty' 2>/dev/null || true)"
        case "$item_type" in
          command_execution) event_type="command" ;;
          file_change) event_type="file_change" ;;
          web_search) event_type="web_search" ;;
          agent_message) event_type="agent_message" ;;
        esac
        ;;
    esac
    if [ -n "$event_type" ]; then report_event "$run_id" "$sequence" "$event_type" "$thread_id" || true; fi
  done
}

case "$dispatcher_state_root" in /workspace/.company/dispatcher) ;; *) echo "Unsafe dispatcher state root." >&2; exit 64 ;; esac
[ -d /workspace ] && [ ! -L /workspace ] || { echo "Unsafe HRM workspace root." >&2; exit 65; }
for state_path in /workspace/.company "$dispatcher_state_root" "$terminal_outbox"; do
  [ ! -L "$state_path" ] || { echo "Unsafe dispatcher state path." >&2; exit 65; }
  if [ ! -e "$state_path" ]; then mkdir -- "$state_path"; sync -f "$(dirname "$state_path")"; fi
  [ -d "$state_path" ] && [ ! -L "$state_path" ] || { echo "Unsafe dispatcher state path." >&2; exit 65; }
done
chmod 0700 "$dispatcher_state_root" "$terminal_outbox"
trap quiesce_active_on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
recover_interrupted_run || { echo "Aurelia could not safely recover the interrupted employee boundary." >&2; exit 75; }

echo "Aurelia company dispatcher started."
while true; do
  if ! drain_terminal_outbox; then
    echo "Aurelia could not acknowledge a durable terminal run; refusing to claim more work." >&2
    sleep "$idle_seconds"
    continue
  fi
  if ! /opt/one-man-company/reconcile; then
    echo "Aurelia could not reconcile the workforce; retrying." >&2
    sleep "$idle_seconds"
    continue
  fi

  if [ ! -f "$claim_generation_file" ] || [ -L "$claim_generation_file" ]; then
    echo "Aurelia has no trusted reconciled training generation; refusing to claim work." >&2
    sleep "$idle_seconds"
    continue
  fi
  if claim_training_generation="$(cat "$claim_generation_file")"; then :; else
    echo "Aurelia could not read the reconciled training generation; refusing to claim work." >&2
    sleep "$idle_seconds"
    continue
  fi
  case "$claim_training_generation" in ''|*[!0-9]*|0) echo "Aurelia rejected an invalid reconciled training generation." >&2; sleep "$idle_seconds"; continue ;; esac
  claim_payload="$(jq -nc --arg action claim --arg workerId "$worker_id" \
    --argjson trainingGeneration "$claim_training_generation" \
    '{action:$action,workerId:$workerId,trainingGeneration:$trainingGeneration}')"
  if ! claim_response="$(api_post_json "$control_url/api/executor" "$claim_payload")"; then
    echo "Aurelia could not reach the executor control plane; retrying." >&2
    sleep "$idle_seconds"
    continue
  fi
  job="$(printf '%s' "$claim_response" | jq -c '.job // empty')"
  if [ -z "$job" ]; then
    sleep "$idle_seconds"
    continue
  fi

  run_id="$(printf '%s' "$job" | jq -r '.runId')"
  container_name="$(printf '%s' "$job" | jq -r '.containerName')"
  case "$run_id" in *[!A-Za-z0-9_.-]*|'') echo "Unsafe employee run id." >&2; exit 64 ;; esac
  safe_run="$run_id"
  case "$container_name" in *[!A-Za-z0-9_.-]*|'') echo "Unsafe employee container name." >&2; exit 64 ;; esac
  if container_observation="$(inspect_container_identity "$container_name")"; then
    container_id="${container_observation%%|*}"
    container_rest="${container_observation#*|}"
    container_state="${container_rest%%|*}"
    container_restarting="${container_rest#*|}"
  else
    container_observation_status=$?
    if [ "$container_observation_status" -ne 44 ]; then
      echo "Aurelia could not establish the claimed employee container identity; refusing execution." >&2
      exit 75
    fi
    terminal_payload="$(jq -nc --arg action fail --arg workerId "$worker_id" --arg runId "$run_id" \
      --arg failureCode execution_failed '{action:$action,workerId:$workerId,runId:$runId,failureCode:$failureCode}')"
    queue_terminal_action "$safe_run" "$terminal_payload" || { echo "Aurelia could not durably record the missing employee failure." >&2; exit 75; }
    drain_terminal_outbox || true
    continue
  fi
  if [ "$container_state" != running ] || [ "$container_restarting" != false ]; then
    terminal_payload="$(jq -nc --arg action fail --arg workerId "$worker_id" --arg runId "$run_id" \
      --arg failureCode execution_failed '{action:$action,workerId:$workerId,runId:$runId,failureCode:$failureCode}')"
    queue_terminal_action "$safe_run" "$terminal_payload" || { echo "Aurelia could not durably record the unstable employee failure." >&2; exit 75; }
    drain_terminal_outbox || true
    continue
  fi
  active_payload="$(jq -nc --arg runId "$run_id" --arg safeRun "$safe_run" --arg containerName "$container_name" \
    --arg containerId "$container_id" \
    '{runId:$runId,safeRun:$safeRun,containerName:$containerName,containerId:$containerId,phase:"executing",executionStatus:null}')"
  atomic_write_json "$active_marker" "$active_payload" || { echo "Aurelia could not persist the active employee boundary." >&2; exit 75; }
  active_container="$container_id"

  run_dir="$(mktemp -d)"
  event_pipe="$run_dir/events"
  error_file="$run_dir/error.log"
  job_file="$run_dir/job.json"
  mkfifo "$event_pipe"
  printf '%s' "$job" > "$job_file"
  consume_events "$run_id" < "$event_pipe" &
  reader_pid=$!
  docker exec -i "$container_id" /usr/local/bin/run-company-task < "$job_file" > "$event_pipe" 2> "$error_file" &
  execution_pid=$!

  while kill -0 "$execution_pid" 2>/dev/null; do
    heartbeat_payload="$(jq -nc --arg action heartbeat --arg workerId "$worker_id" --arg runId "$run_id" '{action:$action,workerId:$workerId,runId:$runId}')"
    post_run_action "$heartbeat_payload" || true
    sleep "$heartbeat_seconds"
  done

  if wait "$execution_pid"; then execution_status=0; else execution_status=$?; fi
  post_exec_payload="$(jq -nc --arg runId "$run_id" --arg safeRun "$safe_run" --arg containerName "$container_name" \
    --arg containerId "$container_id" --argjson executionStatus "$execution_status" \
    '{runId:$runId,safeRun:$safeRun,containerName:$containerName,containerId:$containerId,phase:"post-exec",executionStatus:$executionStatus}')"
  atomic_write_json "$active_marker" "$post_exec_payload" || { echo "Aurelia could not persist the employee exit phase." >&2; exit 75; }
  wait "$reader_pid" || true

  terminal_payload=""
  if [ "$execution_status" -eq 0 ]; then
    if result_json="$(read_result_json "$container_id" "$safe_run" 2>/dev/null)" \
      && validate_result_json "$result_json"; then
      terminal_payload="$(jq -nc --arg action complete --arg workerId "$worker_id" --arg runId "$run_id" \
        --argjson result "$result_json" '{action:$action,workerId:$workerId,runId:$runId,result:$result}')"
    else
      execution_status=65
    fi
  fi

  if [ "$execution_status" -ne 0 ]; then
    failure_code="execution_failed"
    if [ "$execution_status" -eq 65 ]; then
      failure_code="result_invalid"
    elif grep -Eqi 'access token could not be refreshed|log in again|authentication required' "$error_file"; then
      failure_code="authentication_required"
    elif grep -Eqi 'GitHub credential is not configured|could not read Username.*github|authentication failed for.*github|gh auth login' "$error_file"; then
      failure_code="github_authentication_required"
    elif grep -Eqi 'repository not found|could not resolve host|failed to clone' "$error_file"; then
      failure_code="repository_unavailable"
    fi
    terminal_payload="$(jq -nc --arg action fail --arg workerId "$worker_id" --arg runId "$run_id" --arg failureCode "$failure_code" '{action:$action,workerId:$workerId,runId:$runId,failureCode:$failureCode}')"
  fi

  # Persist the terminal acknowledgement before ending the process boundary,
  # but never send it until restart (or a verified stop) proves that no
  # task-spawned process can survive into the next claim.
  queue_terminal_action "$safe_run" "$terminal_payload" || { echo "Aurelia could not persist the terminal acknowledgement." >&2; exit 75; }
  quiesce_container "$container_id" || { echo "Aurelia could not prove the employee process was quiesced; stopping the dispatcher." >&2; exit 75; }
  clear_active_marker || { echo "Aurelia could not durably clear the employee process marker." >&2; exit 75; }

  rm -rf "$run_dir"
  if drain_terminal_outbox; then
    if [ "$execution_status" -eq 0 ]; then
      echo "Aurelia completed run $run_id."
    else
      echo "Aurelia recorded a failed employee run ($run_id, exit $execution_status)." >&2
    fi
  else
    echo "Aurelia retained run $run_id in the durable terminal outbox; no later work will be claimed until acknowledgement succeeds." >&2
  fi
done
