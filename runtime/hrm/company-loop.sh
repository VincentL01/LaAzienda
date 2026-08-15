#!/bin/sh
set -eu

control_url="${OMC_CONTROL_URL:-http://host.docker.internal:3000}"
worker_id="${OMC_WORKER_ID:-omc-hrm}"
idle_seconds="${OMC_LOOP_SECONDS:-5}"
heartbeat_seconds="${OMC_HEARTBEAT_SECONDS:-10}"

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

echo "Aurelia company dispatcher started."
while true; do
  if ! /opt/one-man-company/reconcile; then
    echo "Aurelia could not reconcile the workforce; retrying." >&2
    sleep "$idle_seconds"
    continue
  fi

  claim_payload="$(jq -nc --arg action claim --arg workerId "$worker_id" '{action:$action,workerId:$workerId}')"
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
  safe_run="$(printf '%s' "$run_id" | tr -c 'A-Za-z0-9_.-' '-')"
  case "$container_name" in *[!A-Za-z0-9_.-]*|'') echo "Unsafe employee container name." >&2; exit 64 ;; esac

  if ! docker container inspect "$container_name" >/dev/null 2>&1; then
    fail_payload="$(jq -nc --arg action fail --arg workerId "$worker_id" --arg runId "$run_id" '{action:$action,workerId:$workerId,runId:$runId}')"
    post_run_action "$fail_payload" || true
    continue
  fi

  run_dir="$(mktemp -d)"
  event_pipe="$run_dir/events"
  error_file="$run_dir/error.log"
  job_file="$run_dir/job.json"
  mkfifo "$event_pipe"
  printf '%s' "$job" > "$job_file"
  consume_events "$run_id" < "$event_pipe" &
  reader_pid=$!
  docker exec -i "$container_name" /usr/local/bin/run-company-task < "$job_file" > "$event_pipe" 2> "$error_file" &
  execution_pid=$!

  while kill -0 "$execution_pid" 2>/dev/null; do
    heartbeat_payload="$(jq -nc --arg action heartbeat --arg workerId "$worker_id" --arg runId "$run_id" '{action:$action,workerId:$workerId,runId:$runId}')"
    post_run_action "$heartbeat_payload" || true
    sleep "$heartbeat_seconds"
  done

  if wait "$execution_pid"; then execution_status=0; else execution_status=$?; fi
  wait "$reader_pid" || true

  if [ "$execution_status" -eq 0 ]; then
    if result_json="$(docker exec "$container_name" cat "/workspace/.company/runs/$safe_run.json" 2>/dev/null)" \
      && printf '%s' "$result_json" | jq -e 'type == "object"' >/dev/null 2>&1; then
      complete_payload="$(jq -nc --arg action complete --arg workerId "$worker_id" --arg runId "$run_id" \
        --argjson result "$result_json" '{action:$action,workerId:$workerId,runId:$runId,result:$result}')"
      post_run_action "$complete_payload"
      echo "Aurelia completed run $run_id."
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
    elif grep -Eqi 'repository not found|could not resolve host|failed to clone|authentication failed for.*github' "$error_file"; then
      failure_code="repository_unavailable"
    fi
    fail_payload="$(jq -nc --arg action fail --arg workerId "$worker_id" --arg runId "$run_id" --arg failureCode "$failure_code" '{action:$action,workerId:$workerId,runId:$runId,failureCode:$failureCode}')"
    post_run_action "$fail_payload" || true
    echo "Aurelia recorded a failed employee run ($run_id, exit $execution_status)." >&2
  fi

  rm -rf "$run_dir"
done
