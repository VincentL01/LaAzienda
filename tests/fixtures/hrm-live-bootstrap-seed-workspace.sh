#!/usr/bin/env bash
set -Eeuo pipefail

employee_id="${1:?employee identity required}"
mkdir -p /workspace/.company /workspace/.agents/skills
chown 1001:1001 /workspace
chown -R 1001:1001 /workspace/.agents
system_prompt='You are Aurora, a permanent Company Employee in this disposable reconciliation test.'
jq -nr --arg email "${employee_id}@one-man-company.test" --arg systemPrompt "$system_prompt" '
  "# Aurora - Company Employee\n\n" +
  "Policy template: 3\n" +
  "Department: Operations\nEmployment type: expert\n" +
  "Workspace policy: persistent\nResource access: task-scoped\n" +
  "Handoff required: false\nMailbox: \($email) (requested)\n\n" +
  $systemPrompt + "\n\n## Company execution rules\n\n" +
  "- Use only company evidence supplied in the approved task prompt; broad portal APIs are not employee tools.\n" +
  "- Never read, print, return, or commit credentials.\n" +
  "- Repository changes must use a codex/* branch and a pull request. Never commit or push directly to main.\n" +
  "- Treat the structured executor result as the durable handoff.\n"
' > /workspace/AGENTS.md
policy_version="$({ printf 'template=%s\0' 3; cat /workspace/AGENTS.md; } | sha256sum)"
policy_version="${policy_version%% *}"
printf '%s\n' "$policy_version" > /workspace/.company/policy-version
chmod 0644 /workspace/AGENTS.md /workspace/.company/policy-version
chown 1001:1001 /workspace/AGENTS.md /workspace/.company/policy-version
chown 0:0 /workspace/.company
chmod 0755 /workspace/.company
