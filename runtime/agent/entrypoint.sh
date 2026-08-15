#!/bin/sh
set -eu

if [ ! -f /run/secrets/codex_auth ]; then
  echo "Codex credential secret is missing." >&2
  exit 78
fi

mkdir -p "$CODEX_HOME" /workspace/.agents/skills
cp /run/secrets/codex_auth "$CODEX_HOME/auth.json"
chmod 600 "$CODEX_HOME/auth.json"

if [ -f /run/secrets/github_token ]; then
  GH_TOKEN="$(cat /run/secrets/github_token)"
  export GH_TOKEN
fi

if [ -f /run/company-secrets/mail_password ]; then
  OMC_MAIL_PASSWORD="$(cat /run/company-secrets/mail_password)"
  export OMC_MAIL_PASSWORD
fi

if [ -d /opt/assigned-skills ]; then
  for skill_dir in /opt/assigned-skills/*; do
    [ -d "$skill_dir" ] || continue
    skill_name="$(basename "$skill_dir")"
    rm -rf "/workspace/.agents/skills/$skill_name"
    cp -R "$skill_dir" "/workspace/.agents/skills/$skill_name"
  done
fi

exec "$@"
