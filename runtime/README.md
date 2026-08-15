# Local employee runtime

The portal is the durable control plane. Docker is the local data plane. The only employee with `/var/run/docker.sock` is Aurelia, the HR Manager.

## Continuous bootstrap and dispatch

1. `runtime/Start-Company.ps1` builds and runs the portal on `127.0.0.1:3000`, persists its local D1 state, creates a private bridge token, and calls the minimal HRM bootstrap.
2. `runtime/bridge.ps1` verifies the D1 socket policy, builds the base and HRM images when requested, creates credential source mounts, starts `omc-hrm`, and reports Aurelia's observed state.
3. Aurelia continuously reconciles approved employees, claims one durable task or Secretary inquiry at a time, invokes `codex exec --json` inside the assigned container, renews its lease, records allowlisted event summaries, and accepts only schema-valid results.

The host bootstrap never creates ordinary employee containers. No ordinary employee receives the Docker socket. A task remains queued until the dispatcher has both an assigned employee and an observed running container.

## Images

`runtime/agent/Dockerfile` is the shared character base. It contains Codex CLI, Node/npm, Git/GitHub CLI, curl, jq, ripgrep, Python, unzip, SSH, and certificates. It has no Docker client or socket.

`runtime/hrm/Dockerfile` extends that same base with a Docker CLI and the reviewed reconciliation program. Socket access is supplied only when the host creates Aurelia.

Skills are copied from the reviewed Training Center cache into an employee-specific volume, then into `/workspace/.agents/skills` by the base entrypoint. Permanent Experts keep their mounted workspace even while stopped. Contractors use task-scoped policy and cannot close their task until the portal accepts a handoff and knowledge contribution.

## Credential boundary

`assets/agent_auth/auth.json` is ignored by Git and never copied into an image. The bootstrap exposes it through an auth-only source container. The base entrypoint copies it to `$CODEX_HOME/auth.json` with mode `0600`. The file is never printed by these scripts.

An optional `assets/github_auth/token` is also ignored. Only Project Manager containers receive its source mount; each task runner loads it directly as `GH_TOKEN` without printing it. Recording a project in the portal does not create its repository; a PM may create the approved public `VincentL01` repository only when an executor is authorized to run that side effect.

This `auth.json` transplant is a user-requested compatibility mechanism, not a documented Codex authentication API. Production automation should use a documented API-key or managed access-token flow with explicit rotation and revocation.

If Codex reports that the copied ChatGPT refresh token was already used, replace the ignored source file with a freshly authenticated owner session and restart the employee containers. The dispatcher records `authentication_required` and pauses retries rather than treating the job as completed.

## Start the company

Start the portal and Stalwart network, then run:

```powershell
.\runtime\Start-Company.ps1 -BuildImages
```

Later starts omit `-BuildImages`. The generated bridge token remains under ignored `runtime/state/`; the portal is published only on loopback and employees reach it as `omc-portal` on the private network.
