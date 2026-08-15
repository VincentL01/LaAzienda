# Repository guidance for Codex employees

## Mission

Build the smallest trustworthy system that lets one human direct a company of Codex employees. Favor working company loops over simulated complexity or decorative scope.

## Current rules

- Treat D1 as the source of truth for company records; browser storage is only for disposable UI preferences.
- Keep task state, employee state, and character animation mappings separate.
- Do not present placeholder or scripted output as real agent execution.
- Keep container and authentication details behind an executor boundary until their security contract is explicit.
- Preserve user-provided character packs and their manifests. Do not crop or recompress spritesheets.
- Make every write action visible in the activity feed and safe to retry where practical.
- Prefer one complete vertical slice over several disconnected features.

## Before handing off

- Generate a migration after database schema changes.
- Run `npm run build` and the relevant tests.
- Keep README and architecture notes aligned with what actually works.
- After validated portal changes, deploy the private Sites version unless the user explicitly requests local-only work.
