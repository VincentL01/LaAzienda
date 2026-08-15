FROM one-man-company/codex-employee:local

USER root
COPY --from=docker:28-cli /usr/local/bin/docker /usr/local/bin/docker
COPY reconcile.sh /opt/one-man-company/reconcile
RUN chmod 0755 /opt/one-man-company/reconcile

USER codex
ENTRYPOINT ["/usr/local/bin/agent-entrypoint"]
CMD ["sleep", "infinity"]
