ARG BASE_IMAGE=one-man-company/codex-employee:local
FROM ${BASE_IMAGE}

USER root
COPY --from=docker:28-cli /usr/local/bin/docker /usr/local/bin/docker
COPY reconcile.sh /opt/one-man-company/reconcile
COPY company-loop.sh /opt/one-man-company/company-loop
RUN chmod 0755 /opt/one-man-company/reconcile /opt/one-man-company/company-loop

USER codex
ENTRYPOINT ["/usr/local/bin/agent-entrypoint"]
CMD ["/opt/one-man-company/company-loop"]
