# Training Center

The Training Center is the trusted global cache for reusable employee skills and character packs.

1. Discover skills with `Find-Skill.ps1` or `npx skills find <query>`.
2. Review the source and `SKILL.md` before importing.
3. Import with `Import-Skill.ps1 -PackageRef owner/repository@skill-name`.
4. Confirm the cached item in `/training`; only confirmed skills can be assigned during onboarding.

Skills are installed under `training-center/cache/.agents/skills` and copied into an employee's isolated workspace when its container is first provisioned. The cache and staging folders are ignored by Git.

Characters use `Import-Character.ps1 -Slug <catalog-slug>`. The script uses the Codex Pets CLI, then copies the original `pet.json` and `spritesheet.webp` into `assets/characters` and `public/characters` without cropping or recompression.
