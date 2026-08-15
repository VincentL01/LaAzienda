FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates curl gh git jq openssh-client python3 ripgrep unzip \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global @openai/codex \
  && useradd --create-home --shell /bin/bash codex \
  && mkdir -p /workspace /opt/assigned-skills /home/codex/.codex \
  && chown -R codex:codex /workspace /opt/assigned-skills /home/codex/.codex

COPY entrypoint.sh /usr/local/bin/agent-entrypoint
RUN chmod 0755 /usr/local/bin/agent-entrypoint

USER codex
ENV HOME=/home/codex
ENV CODEX_HOME=/home/codex/.codex
WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/agent-entrypoint"]
CMD ["sleep", "infinity"]
