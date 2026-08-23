# Training Center

The Training Center is the trusted global cache for reusable employee skills and character packs.

1. Discover skills with `Find-Skill.ps1` or `npx skills find <query>`.
2. Review the source and `SKILL.md` before importing.
3. Import with `Import-Skill.ps1 -PackageRef owner/repository@skill-name`.
4. Let Aurelia observe the imported whole-tree digest, then unlock the Training Room with `runtime/Copy-CompanyOwnerCredential.ps1` and explicitly approve that exact revision. The script copies the independent ignored `assets/owner/runtime/credential`, never the runtime bridge token. Docker stores only its one-way verifier. Successful login creates a random eight-hour HttpOnly, same-site session token; D1 stores only the token hash and expiry, while the credential itself is never stored in browser JavaScript, D1, a URL, a log, or Docker configuration.
5. Assign or revoke employee training in `/training`. D1 records the desired version immediately; Aurelia's reconciliation loop supplies the verified result and evidence. Onboarding and runtime mutations use the same owner session.

Skills are installed under `training-center/cache/.agents/skills`. Aurelia hashes path bytes, regular-file modes, and file contents; symlinks, special nodes, unreadable files, and changed executable bits fail closed. D1 keeps the observed digest separate from the CEO-approved digest, so editing an approved host folder changes it to `drifted` until the new revision is explicitly approved.

Aurelia validates the complete desired set and stages it by whole-employee manifest version in the HRM-owned `omc-skills-*` control volume. Before changing active skills, Aurelia stops the employee and runs a disposable base-image helper with the separate `omc-installed-skills-*` volume mounted read/write at `/workspace/.agents/skills`; the employee container mounts that same active-skills volume read-only. Legacy or unmanaged bytes below the persistent workspace's old `.agents/skills` path remain preserved underneath the nested mount, but Codex cannot load them as active skills.

The helper stages and verifies every target before swapping anything, flushes a write-ahead entry before each move, and keeps rollback metadata in the HRM-owned control volume until all installs and revocations pass. Handled failures roll back immediately; after an uncatchable process or host crash, the next helper pass recovers the last complete set from that trusted durable journal before doing new work. Only the prior HRM-published managed manifest authorizes deletion. Workspace `applied.json` remains evidence only. Approved cache, staged-volume, and a separate active-volume read-back must match before append-only history says `verified`. A missing or corrupt desired cache entry preserves the last verified active set. A revoked folder remains reserved until its exact removal version is independently verified, after which D1 releases it for reuse. The global cache and staging folders are ignored by Git.

Authority files are published atomically only from nonempty contract-valid JSON and are read back before use. Invalid authority plus any installed folder remains blocked for CEO recovery. Invalid authority may self-bootstrap only when an independent exact-folder observation proves the dedicated installed-skills volume is empty, where there is no prior managed deletion authority to discard.

Characters use `Import-Character.ps1 -Slug <catalog-slug>`. The script uses the Codex Pets CLI, then copies the original `pet.json` and `spritesheet.webp` into `assets/characters` and `public/characters` without cropping or recompression.
