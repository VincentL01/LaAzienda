# One Man Company

One Man Company is a control room for a company operated by isolated Codex employees. The human is the CEO: you set objectives, onboard employees, approve reusable skills, request containers, inspect real runtime state, and review results.

This is an original implementation inspired by the operating-system ideas in [1mancompany/OneManCompany](https://github.com/1mancompany/OneManCompany). It does not copy that project's application code.

## Working milestone

- Cloudflare D1 is the source of truth for employees, system prompts, policies, skill assignments, projects, tasks, contractor handoffs, company knowledge, animation mappings, requested runtime state, observed Docker state, mail, and the activity feed.
- Aurelia is the founding HR Manager and sole Docker provisioner, using the owner-provided Aurelia Executive character. She is also the CEO-facing Discord identity, while the transport remains isolated from her privileged container. Dorothy remains the Crimson Executive read-only Secretary; Aurora is retained as an ordinary persistent Company Employee.
- The control room has a six-zone live office. Employees move between the main office, planning room, review lab, support bay, pantry, and lobby from durable employee/run state; selecting a sprite opens the CEO evidence drawer, while Dorothy receives a fresh bounded operational snapshot with each approved inquiry.
- `/company` shows the common Codex base image as character stats, defines Executive/Expert/Contractor roles, records planned public projects, retains company knowledge, and provides the Stalwart-backed coordination outbox.
- `/employees` enforces role policies during onboarding. Experts receive a persistent workspace and random unreserved character; Contractors receive Solaire, a generated Medieval name, task-scoped authority, and a mandatory closeout handoff. A Codex Pet ZIP can be validated and imported without leaving the desk.
- `/training` accepts an approved package reference or constrained `npx skills add ...` command and records reviewed skill/character cache state. Official Microsoft skill requests seed the Microsoft Expert curriculum.
- `training-center/` provides trusted local discovery/import scripts. Imported skills are cached once, then installed into a dedicated HRM-managed volume mounted read-only at each assigned employee's workspace skill path.
- `runtime/` provides a shared Codex base image plus an HRM extension. The loopback-only portal container starts Aurelia; Aurelia alone holds the Docker socket, reconciles every other employee container, claims durable jobs, records safe Codex JSONL events, retries transient failures, and requires structured handoffs.
- `infrastructure/mail/` runs a pinned Stalwart service on the machine. D1 stores company addresses and delivery evidence; mailbox passwords remain in ignored local runtime state.
- Docker observations map to employee status through replay-safe runtime event IDs. A start request never masquerades as an observed running container.
- First-party worker exceptions and API 5xx responses are correlated only to an active employee run, redacted and deduplicated in D1, then filed and independently verified by a host-only GitHub issue watcher. Employee output cannot open issues.
- The optional Aurelia Discord adapter exposes on-demand `/company` and `/employee` reports from its own Docker bridge. It has no company-network route, portal address, or portal-status credential; it authenticates to a separate two-homed allowlist gateway with a distinct client capability. The gateway alone maps authenticated bodyless `GET /v1/status` to the fixed portal status request. Employees receive neither capability, neither container publishes a host port or inherits Aurelia's HRM authority, and replacements are health-checked before the verified previous container is released.
- `/animations` maps every employee status to a Codex Pet track and frame speed.

A queued task is not shown as active until Aurelia claims it and invokes `codex exec` inside the assigned employee container. Completion requires the declared output schema and moves work to CEO review; no scripted output is accepted as execution evidence. A queued company message is likewise not shown as sent until the local mail bridge reports that Stalwart accepted it.

## Run locally

Prerequisite: Docker Desktop. The host launchers support both Windows PowerShell 5.1 and PowerShell 7. Start the complete loopback-only company with:

```powershell
.\runtime\Start-Company.ps1 -BuildImages
```

Open `http://localhost:3002`, run `runtime/Copy-CompanyOwnerCredential.ps1`, and use the local company-owner credential in `/training`. The HttpOnly owner session unlocks Company, Employees, Mail, Animation, Training, and character-import controls across the same site for eight hours. The portal, D1 state, Aurelia dispatcher, and approved employee containers use Docker restart policies and remain available after the script exits.

When `assets/discord/config.json` and `assets/discord/bot-token` have been imported, the same start command also runs Aurelia's isolated Discord adapter. See [`runtime/discord/README.md`](runtime/discord/README.md) for the private user-install setup and secret boundary.

For UI-only development on the same `http://localhost:3002` address, use Node.js 22.13 or newer:

```bash
npm install
npm run dev
```

Local development uses a project-local D1 database, but a bare `npm run dev` intentionally leaves broad company data and mutation controls locked unless the domain-separated `OWNER_SESSION_VERIFIER` is bound and its owner session is unlocked. The raw owner credential is never placed in the portal container. Runtime reports separately require `RUNTIME_BRIDGE_TOKEN`. Use `Start-Company.ps1` for a complete, usable company loop; network locality alone never grants either authority.

Character import sessions expire and are reclaimed in bounded batches when another import request arrives. A scheduled maintenance trigger for cleanup during periods with no import traffic remains a future operational hardening item.

Useful checks:

```bash
npm run db:generate
npm run lint
npm run build
npm test
```

## Onboarding loop

1. In `/training`, discover a skill with `npx skills find <query>` and queue either its `owner/repository@skill-name` reference or exact safe `npx skills add ...` command.
2. Review its source and run `training-center/Import-Skill.ps1` on the trusted host.
3. Let Aurelia independently observe the imported whole-tree digest. Run `runtime/Copy-CompanyOwnerCredential.ps1`, paste the local company-owner credential into the Training Room, and approve that exact revision. This credential is an independent random secret under ignored `assets/owner/runtime/`, not the runtime bridge token or something derivable from it. The form clears it after creating an eight-hour HttpOnly session. Only a currently observed and company-owner-approved digest can become a desired assignment.
4. In `/training`, assign a cached skill to an existing employee, or select it while onboarding in `/employees`. The Training Room shows pending, verified, and failed assignment versions plus timestamps and hash evidence. You can also choose a character ZIP containing root-level `pet.json` and `spritesheet.webp` or `spritesheet.png`; a successful import is selected immediately.
5. Request a container start, then run `runtime/Start-Company.ps1 -BuildImages` on the trusted Docker host.
6. The host bootstraps Aurelia. HRM independently regenerates and repairs each employee's `AGENTS.md`, builds a whole-employee versioned manifest in an HRM-owned control volume, stops the employee, and runs a fail-atomic helper against a separate installed-skills volume. Employees mount `/workspace/.agents/skills` from that volume read-only. Success requires approved cache, staged-volume, and separate active-volume whole-tree digests to match. Revocation removes only folders named by the prior HRM-owned managed manifest; unmanaged workspace content and employee-writable evidence cannot authorize deletion or become an active Codex skill.

## Company mail loop

1. Run `./infrastructure/mail/Start-Mail.ps1` on the trusted Docker host.
2. On first use, complete Stalwart's machine-local wizard at `http://127.0.0.1:8088/admin` with hostname `mail.one-man-company.test` and domain `one-man-company.test`.
3. Run `./infrastructure/mail/Provision-Mailboxes.ps1` while the portal is running locally. The script idempotently creates requested employee accounts and records mailbox readiness.
4. HRM or a Project Manager queues a brief from `/company`; D1 remains the durable outbox. Dorothy observes mail read-only and cannot be selected as sender.
5. Run `./infrastructure/mail/bridge.ps1`. It submits queued messages to Stalwart's loopback-only SMTP listener and records the actual result.

The Stalwart container and each employee container join the external Docker network `one-man-company`. No public SMTP port is opened, and the reserved `.test` domain does not route on the public internet. See [infrastructure/mail/README.md](infrastructure/mail/README.md).

## Authentication boundary

The owner-provided `assets/agent_auth/auth.json` is ignored by Git and never copied into a Docker image. The runtime mounts it read-only and copies it to the container user's `.codex/auth.json` with mode `0600` at startup. The file's contents must never be logged or displayed.

An optional fine-grained GitHub token at `assets/github_auth/token` is also ignored and is mounted only into Project Manager containers. Run `runtime/Import-GitHubCredential.ps1` to copy the existing `VincentL01` identity from Git Credential Manager without printing it; the script refuses to write unless the destination is Git-ignored. A portal project record plans a public repository under `VincentL01`; it does not use the credential or create the repository by itself.

This session-file transplant is a user-requested compatibility mechanism, not a documented Codex authentication API. For production automation, prefer the documented [Codex non-interactive authentication](https://learn.chatgpt.com/docs/non-interactive-mode).

Copied ChatGPT session files can require a fresh owner login when their refresh token has already been consumed. The dispatcher classifies that condition as `authentication_required`, stops automatic retries, and exposes it in the employee inspector instead of claiming the task ran.

To refresh the company, replace and save the ignored `assets/agent_auth/auth.json`. Aurelia fingerprints that mounted source every five seconds, recreates only employee containers carrying the previous fingerprint, preserves their workspace and skill volumes, and automatically requeues jobs whose latest failure was `authentication_required`. No company restart is normally required; rerun `runtime/Start-Company.ps1` only if Docker Desktop does not expose the changed bind-mounted file.

Project Manager jobs receive outbound network access inside Codex's `workspace-write` sandbox so they can clone, push, and open approved `VincentL01` pull requests. Other roles remain network-disabled by default. Retried tasks reuse their prior run workspace, so a committed branch is preserved when a network or credential blocker is resolved.

`runtime/Start-Company.ps1` also starts a hidden host merge watcher. It polls only `VincentL01/LaAzienda`, verifies that the current `codex/*` pull request was merged into `main` by `VincentL01`, requires a clean working tree, then runs `git switch main` and `git pull --ff-only origin main`. After the pull it rebuilds the local company and records the synchronized PR and commit in D1 and the activity feed. Dirty, divergent, unrelated, or directly pushed branches are left untouched.

Codex officially loads repository skills from `.agents/skills`; employee containers see that location as a dedicated HRM-managed read-only volume after verified Training Center synchronization. If any currently assigned cache entry is missing, unsafe, colliding, or corrupt, HRM reports failure and preserves the last verified manifest and installed set rather than applying a reduced curriculum. See [Codex skills](https://learn.chatgpt.com/docs/build-skills) and [AGENTS.md guidance](https://learn.chatgpt.com/docs/agent-configuration/agents-md).

## Character packs

Use the onboarding ZIP picker for a package already on your computer, or `training-center/Import-Character.ps1 -Slug <slug>` for approved [Codex Pets](https://codex-pets.net/) packages. Browser uploads store the original ZIP, manifest, and spritesheet bytes in R2; the spritesheet is served through a content-addressed URL without cropping or recompression.

The owner-supplied Dorothy pack remains unchanged. Confirm each pack's creator license before public redistribution.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the state and trust contracts, [docs/REFERENCE_RESEARCH.md](docs/REFERENCE_RESEARCH.md) for the upstream onboarding and harness comparison, and [docs/QUACKAT-INTEGRATION.md](docs/QUACKAT-INTEGRATION.md) for the boundary between the knowledge OS and this workforce control plane.
