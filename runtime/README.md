# Local employee runtime

The portal is the durable control plane. Docker is the local data plane. The only employee with `/var/run/docker.sock` is Aurelia, the HR Manager.

## Two-stage bootstrap

1. `runtime/bridge.ps1` is a minimal host bootstrap. It verifies the D1 socket policy, builds the base and HRM images, creates credential source mounts, starts or stops `omc-hrm`, and reports Aurelia's observed state.
2. The bootstrap invokes `/opt/one-man-company/reconcile` inside Aurelia. HRM reads approved employee records, creates persistent workspace/skill/secret volumes, starts or stops all other employee containers, and reports observed Docker state.

The host bootstrap never creates ordinary employee containers. No ordinary employee receives the Docker socket. An employee container is idle until a later executor invokes `codex exec` for an approved task.

## Images

`runtime/agent/Dockerfile` is the shared character base. It contains Codex CLI, Node/npm, Git/GitHub CLI, curl, jq, ripgrep, Python, unzip, SSH, and certificates. It has no Docker client or socket.

`runtime/hrm/Dockerfile` extends that same base with a Docker CLI and the reviewed reconciliation program. Socket access is supplied only when the host creates Aurelia.

Skills are copied from the reviewed Training Center cache into an employee-specific volume, then into `/workspace/.agents/skills` by the base entrypoint. Permanent Experts keep their mounted workspace even while stopped. Contractors use task-scoped policy and cannot close their task until the portal accepts a handoff and knowledge contribution; automated archive/removal follows in the executor milestone.

## Credential boundary

`assets/agent_auth/auth.json` is ignored by Git and never copied into an image. The bootstrap exposes it through an auth-only source container. The base entrypoint copies it to `$CODEX_HOME/auth.json` with mode `0600`. The file is never printed by these scripts.

An optional `assets/github_auth/token` is also ignored. Only Project Manager containers receive its source mount, and their entrypoint exports it as `GH_TOKEN`. Recording a project in the portal does not create its repository; a PM may create the approved public `VincentL01` repository only when an executor is authorized to run that side effect.

This `auth.json` transplant is a user-requested compatibility mechanism, not a documented Codex authentication API. Production automation should use a documented API-key or managed access-token flow with explicit rotation and revocation.

## Reconcile once

Start the portal and Stalwart network, then run:

```powershell
.\runtime\bridge.ps1 -BuildImage
```

Later reconciliations omit `-BuildImage`. Set `OMC_RUNTIME_BRIDGE_TOKEN` when the API is configured with the matching `RUNTIME_BRIDGE_TOKEN` secret. `-ContainerControlUrl` can name a portal service on the private Docker network when the host development server is intentionally loopback-only.
