FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates curl gh git jq openssh-client python3 ripgrep unzip \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global @openai/codex \
  && useradd --create-home --shell /bin/bash codex \
  && mkdir -p /workspace /opt/assigned-skills /home/codex/.codex \
  && chown -R codex:codex /workspace /opt/assigned-skills /home/codex/.codex

COPY entrypoint.sh /usr/local/bin/agent-entrypoint
COPY run-task.sh /usr/local/bin/run-company-task
COPY company-status.sh /usr/local/bin/company-status
COPY sync-skills.sh /usr/local/bin/sync-company-skills
COPY run-result.schema.json /opt/one-man-company/run-result.schema.json
RUN chmod 0755 /usr/local/bin/agent-entrypoint /usr/local/bin/run-company-task /usr/local/bin/company-status /usr/local/bin/sync-company-skills

USER codex
ENV HOME=/home/codex
ENV CODEX_HOME=/home/codex/.codex
WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/agent-entrypoint"]
CMD ["sleep", "infinity"]
