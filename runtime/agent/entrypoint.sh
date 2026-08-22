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

exec "$@"
