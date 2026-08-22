# Local employee runtime

The portal is the durable control plane. Docker is the local data plane. The only employee with `/var/run/docker.sock` is Aurelia, the HR Manager.

## Continuous bootstrap and dispatch

1. `runtime/Start-Company.ps1` builds and runs the portal on `127.0.0.1:3002`, persists its local D1 state, creates a private bridge token, and calls the minimal HRM bootstrap.
2. `runtime/bridge.ps1` verifies the D1 socket policy, builds the base and HRM images when requested, creates credential source mounts, starts `omc-hrm`, and reports Aurelia's observed state.
3. Aurelia continuously reconciles approved employees, claims one durable task or Secretary inquiry at a time, invokes `codex exec --json` inside the assigned container, renews its lease, records allowlisted event summaries, and accepts only schema-valid results. A durable phase marker pins the exact container ID, and a terminal outbox is acknowledged only after that same identity is stably restarted or verifiably stopped; startup recovery blocks all later claims until both boundaries converge.
4. `runtime/Watch-GitHubMerges.ps1` runs hidden on the host. It verifies owner-merged `codex/*` pull requests, switches a clean merged checkout to `main`, pulls with `--ff-only`, rebuilds the company, and records idempotent synchronization evidence in D1.
5. `runtime/Watch-SystemIncidents.ps1` runs hidden on the host. It claims active-run portal incidents from D1, publishes only allowlisted operational metadata, finds or creates the fingerprinted GitHub issue, reopens it after a recurrence in a newer build, reads it back independently, and only then records the verified link. Transient failures use capped backoff, and the GitHub credential is re-read on every attempt.
6. `runtime/Start-Company.ps1` creates independent 256-bit Discord portal-status and gateway-client credentials under ignored `assets/discord/runtime/`. When Aurelia's imported Discord credential exists, `runtime/discord/Start-Discord.ps1` stages her adapter on a Discord-only bridge and a narrow status gateway on both the Discord and company bridges. The adapter and gateway share only the client capability; the gateway is the only caller holding the unrelated portal-status token or knowing the portal address. Employees receive neither. Both candidates must become healthy before their verified predecessors are released.

The host bootstrap never creates ordinary employee containers. No ordinary employee receives the Docker socket. A task remains queued until the dispatcher has both an assigned employee and an observed running container.

## Images

`runtime/agent/Dockerfile` is the shared character base. It contains Codex CLI, Node/npm, Git/GitHub CLI, curl, jq, ripgrep, Python, unzip, SSH, and certificates. It has no Docker client or socket.

`runtime/hrm/Dockerfile` extends that same base with a Docker CLI and the reviewed reconciliation program. Socket access is supplied only when the host creates Aurelia.

Skills flow from D1 desired assignments and pinned CEO-approved digests through Aurelia into a whole-employee versioned manifest on an HRM-owned control volume. Before changing an employee's effective skills, Aurelia stops the employee and runs a disposable helper that mounts a separate `omc-installed-skills-*` volume read-write. The employee mounts that same volume read-only at `/workspace/.agents/skills`, so neither Codex nor a task-spawned process can install an unapproved active skill. The helper stages and commits the complete approved set with a durable write-ahead journal, recovers interrupted transactions from the control volume, and performs an independent active-volume read-back before Aurelia records append-only evidence. Missing or drifted cache content preserves the last verified set, and removal authority comes only from the prior HRM-owned managed manifest—never employee-writable workspace state. Manifest fingerprints skip needless mutation helpers, while policy, exact active-folder, and active-skill hash checks still run before every claim. Permanent Experts retain their workspace, control, and installed-skill volumes while stopped. Contractors use task-scoped policy and cannot close their task until the portal accepts a handoff and knowledge contribution.

The host bootstrap precreates and rejects reparse points in Aurelia's exact `.company` control-directory tree before mounting her Windows workspace. Managed-manifest publication rejects empty input and independently reads back the complete JSON after an atomic rename. Corrupt authority remains fail-closed whenever the installed-skills volume contains anything; only an independently enumerated empty installed volume may be initialized with canonical empty authority, because that state has no deletion provenance to lose.

## Credential boundary

`assets/agent_auth/auth.json` is ignored by Git and never copied into an image. The bootstrap exposes it through an auth-only source container. The base entrypoint copies it to `$CODEX_HOME/auth.json` with mode `0600`. The file is never printed by these scripts.

An optional `assets/github_auth/token` is also ignored. `runtime/Import-GitHubCredential.ps1` safely imports the existing `VincentL01` Git Credential Manager identity and refuses to write unless the destination is ignored. Only Project Manager containers receive its versioned source mount; each task runner loads it directly as `GH_TOKEN` without printing it. Recording a project in the portal does not create its repository; a PM may create the approved public `VincentL01` repository only when an executor is authorized to run that side effect.

This `auth.json` transplant is a user-requested compatibility mechanism, not a documented Codex authentication API. Production automation should use a documented API-key or managed access-token flow with explicit rotation and revocation.

If Codex reports that the copied ChatGPT refresh token was already used, replace and save the ignored source file with a freshly authenticated owner session. Aurelia checks its SHA-256 fingerprint every five seconds, recreates employee containers whose fingerprint changed, and automatically requeues only jobs whose latest failure was `authentication_required`. Persistent workspace, HRM control, read-only installed-skills, and secret volumes survive container replacement. No restart is normally required; rerun `runtime/Start-Company.ps1` only if Docker Desktop does not expose the changed bind-mounted file.

The runner enables `sandbox_workspace_write.network_access` only when HRM has provisioned a Project Manager with `project-write` policy. A retry carries the previous run ID as its workspace ID, preserving existing commits and delivery worktrees while a GitHub blocker is repaired.

## Start the company

The host scripts support both the built-in Windows PowerShell 5.1 and PowerShell 7.

Start the portal and Stalwart network, then run:

```powershell
.\runtime\Start-Company.ps1 -BuildImages
```

Later starts omit `-BuildImages`. The generated bridge token remains under ignored `runtime/state/`; the independent owner credential remains under ignored `assets/owner/runtime/`; and the independent Discord credentials remain under ignored `assets/discord/runtime/`. The owner and Discord roots are outside HRM's state mount. The portal is published only on loopback and employees reach it as `omc-portal` on the private network.

Training, onboarding, and human mutation controls are locked by default. `Start-Company.ps1` creates an independent 256-bit owner credential outside `runtime/state` and passes only its domain-separated SHA-256 verifier to the portal. The raw credential is never stored in Docker configuration or sent with the runtime bridge token. After the company is running, execute `runtime/Copy-CeoTrainingCredential.ps1`, paste the clipboard value into `/training`, and clear the clipboard when convenient. The form clears it immediately; after verification, D1 stores only a hash of a new random session token and the browser receives that opaque token in an eight-hour HttpOnly same-site cookie. Expiry and logout are enforced by D1, and rotating the owner credential invalidates prior sessions.

The Docker socket remains a trusted root control-plane boundary. The verifier/session design protects the owner controls from ordinary employees and from credentials exposed through normal container inspection; it does not claim to contain a malicious HR Manager with unrestricted socket use, which can create privileged mounts, instrument container traffic, or replace workloads. Keep Aurelia's HRM policy and socket access under the same trust standard as host administration.

The merge watcher never resets files, force-pulls, pushes, or switches a dirty checkout. It accepts only the exact `https://github.com/VincentL01/LaAzienda.git` origin, the `main` base, `codex/*` heads, and pull requests whose GitHub `merged_by` identity is `VincentL01`. Use `-SkipMergeWatcher` only for the watcher's own post-merge restart or controlled diagnostics. The incident watcher is a separate host credential boundary: browser or employee text is never accepted as an issue request.
