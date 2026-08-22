# Quackat integration boundary

Quackat and LaAzienda are complementary when they own different control loops:

| Concern | System of record |
| --- | --- |
| Skill source, authoring, provenance, and reusable package identity | Quackat |
| Searchable memory, routines, and durable cross-project artifacts | Quackat |
| Employees, roles, tasks, runs, reviews, mail, and containers | LaAzienda |
| Skill approval, employee assignment, installation, and verification evidence | LaAzienda |
| Company handoff approval | LaAzienda, then published to Quackat |

Quackat is the knowledge substrate. LaAzienda is the workforce control plane. Quackat must not receive the Docker socket or decide which employee executes a task. LaAzienda must not silently edit Quackat's source tree or build a second general-purpose memory graph.

## Smallest integration contract

Quackat should export an immutable `skill-package/v1` bundle with:

- a stable skill ID that survives source-file moves;
- an entrypoint such as `SKILL.md`;
- a complete relative file manifest and per-file SHA-256 hashes;
- a whole-package SHA-256 digest;
- source repository, path, and commit provenance.

LaAzienda should import that bundle into the reviewed Training Center cache. D1 records the desired employee assignment; Aurelia copies the approved package into the employee's named skill volume; the employee container applies it; and Aurelia independently reads the workspace back before D1 records the version as verified. Quackat remains read-only throughout this installation loop.

Approved contractor and expert handoffs can later flow in the other direction as provenance-linked Quackat artifacts. Employees may eventually query Quackat through a read-only MCP or HTTP adapter, but search access must not imply permission to modify Quackat or install arbitrary skills.

## First pilot

After the standalone Training Center loop is stable:

1. Add a Quackat exporter for one skill, such as `forge-technical-skill`.
2. Import and review that immutable bundle in LaAzienda.
3. Assign it to Aurora as the first ordinary employee pilot.
4. Verify source digest, cache digest, named-volume digest, and workspace digest.
5. Display assigned, attempted, verified, revoked, and failed timestamps in the Training Room.

Quackat currently indexes a `SKILL.md` by filesystem path. Cross-system packages therefore need the full-directory digest and stable ID described above before automatic import is trustworthy.
