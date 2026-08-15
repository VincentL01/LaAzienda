# One Man Company

One Man Company is a control room for a company operated by isolated Codex employees. The human is the CEO: you set objectives, onboard employees, approve reusable skills, request containers, inspect real runtime state, and review results.

This is an original implementation inspired by the operating-system ideas in [1mancompany/OneManCompany](https://github.com/1mancompany/OneManCompany). It does not copy that project's application code.

## Working milestone

- Cloudflare D1 is the source of truth for employees, system prompts, policies, skill assignments, projects, tasks, contractor handoffs, company knowledge, animation mappings, requested runtime state, observed Docker state, mail, and the activity feed.
- Aurelia is the founding HR Manager and sole Docker provisioner, using the owner-provided Aurelia Executive character. Dorothy is the Crimson Executive secretary and has company-wide read-only access.
- The control room has a six-zone live office. Employees move between the main office, planning room, review lab, support bay, pantry, and lobby from durable employee/run state; selecting a sprite opens the same evidence drawer Dorothy uses.
- `/company` shows the common Codex base image as character stats, defines Executive/Expert/Contractor roles, records planned public projects, retains company knowledge, and provides the Stalwart-backed coordination outbox.
- `/employees` enforces role policies during onboarding. Experts receive a persistent workspace and random unreserved character; Contractors receive Solaire, a generated Medieval name, task-scoped authority, and a mandatory closeout handoff. A Codex Pet ZIP can be validated and imported without leaving the desk.
- `/training` accepts an approved package reference or constrained `npx skills add ...` command and records reviewed skill/character cache state. Official Microsoft skill requests seed the Microsoft Expert curriculum.
- `training-center/` provides trusted local discovery/import scripts. Imported skills are cached once, then copied into each assigned employee workspace.
- `runtime/` provides a shared Codex base image plus an HRM extension. The loopback-only portal container starts Aurelia; Aurelia alone holds the Docker socket, reconciles every other employee container, claims durable jobs, records safe Codex JSONL events, retries transient failures, and requires structured handoffs.
- `infrastructure/mail/` runs a pinned Stalwart service on the machine. D1 stores company addresses and delivery evidence; mailbox passwords remain in ignored local runtime state.
- Docker observations map to employee status through replay-safe runtime event IDs. A start request never masquerades as an observed running container.
- `/animations` maps every employee status to a Codex Pet track and frame speed.

A queued task is not shown as active until Aurelia claims it and invokes `codex exec` inside the assigned employee container. Completion requires the declared output schema and moves work to CEO review; no scripted output is accepted as execution evidence. A queued company message is likewise not shown as sent until the local mail bridge reports that Stalwart accepted it.

## Run locally

Prerequisite: Docker Desktop. Start the complete loopback-only company with:

```powershell
.\runtime\Start-Company.ps1 -BuildImages
```

Open `http://localhost:3000`. The portal, D1 state, Aurelia dispatcher, and approved employee containers use Docker restart policies and remain available after the script exits.

For portal-only development, use Node.js 22.13 or newer:

```bash
npm install
npm run dev
```

Local development uses a project-local D1 database.

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
3. Confirm the cache in the UI. Only cached skills appear in onboarding.
4. In `/employees`, create the employee brain and assign cached skills and a cached character. You can also choose a ZIP containing root-level `pet.json` and `spritesheet.webp` or `spritesheet.png`; a successful import is selected immediately.
5. Request a container start, then run `runtime/Start-Company.ps1 -BuildImages` on the trusted Docker host.
6. The host bootstraps Aurelia. HRM materializes each approved employee's `AGENTS.md`, copies only assigned skill folders, starts or stops the container, reports observed Docker state, and dispatches approved jobs.

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

Codex officially loads repository skills from `.agents/skills`; employee containers use that location after copying assignments from the Training Center cache. See [Codex skills](https://learn.chatgpt.com/docs/build-skills) and [AGENTS.md guidance](https://learn.chatgpt.com/docs/agent-configuration/agents-md).

## Character packs

Use the onboarding ZIP picker for a package already on your computer, or `training-center/Import-Character.ps1 -Slug <slug>` for approved [Codex Pets](https://codex-pets.net/) packages. Browser uploads store the original ZIP, manifest, and spritesheet bytes in R2; the spritesheet is served through a content-addressed URL without cropping or recompression.

The owner-supplied Dorothy pack remains unchanged. Confirm each pack's creator license before public redistribution.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the state and trust contracts and [docs/REFERENCE_RESEARCH.md](docs/REFERENCE_RESEARCH.md) for the upstream onboarding and harness comparison.
