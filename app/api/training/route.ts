import { env } from "cloudflare:workers";
import { ensureDatabase } from "@/db/ensure";
import type { TrainingCenterState } from "@/lib/company";
import { readWorkforce } from "@/lib/server/workforce";

const packagePattern = /^[a-z0-9_.-]+\/[a-z0-9_.-]+(?:@[a-z0-9_.-]+)?$/i;
const petSlugPattern = /^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/;
const npxSkillCommandPattern = /^npx(?:\s+--yes)?\s+skills\s+add\s+([a-z0-9_.-]+\/[a-z0-9_.-]+(?:@[a-z0-9_.-]+)?)(?:\s+(?:-y|-g)){0,2}$/i;

function cleanText(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

async function readTraining(): Promise<TrainingCenterState> {
  const workforce = await readWorkforce();
  return {
    skills: workforce.skills,
    characters: workforce.characters,
    discoveryCommand: "npx skills find <query>",
    petCatalogUrl: "https://codex-pets.net/",
  };
}

export async function GET() {
  try {
    await ensureDatabase();
    return Response.json(await readTraining());
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Training Center unavailable" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const body = (await request.json()) as Record<string, unknown>;
    const d1 = env.DB;

    if (body.action === "requestSkill") {
      const submitted = cleanText(body.packageRef, 260);
      const packageRef = npxSkillCommandPattern.exec(submitted)?.[1] ?? submitted;
      const name = cleanText(body.name, 80) || packageRef.split("@").at(-1) || packageRef;
      const description = cleanText(body.description, 400);
      const sourceUrl = cleanText(body.sourceUrl, 500) || null;
      if (!packagePattern.test(packageRef)) {
        return Response.json({ error: "Use owner/repository@skill-name or a safe npx skills add command" }, { status: 400 });
      }
      const existing = await d1.prepare("SELECT id FROM training_center_skills WHERE package_ref = ?").bind(packageRef).first();
      if (!existing) {
        const id = `skill-${crypto.randomUUID()}`;
        const command = `npx skills add ${packageRef} -y`;
        await d1.batch([
          d1.prepare(`INSERT INTO training_center_skills (
            id, package_ref, name, description, source_url, install_command, cache_status
          ) VALUES (?, ?, ?, ?, ?, ?, 'requested')`).bind(id, packageRef, name, description, sourceUrl, command),
          d1.prepare("INSERT INTO activity (message, tone) VALUES (?, 'neutral')")
            .bind(`Training Center queued ${name} for import.`),
        ]);
      }
    } else if (body.action === "confirmSkillCached") {
      const skillId = cleanText(body.skillId, 90);
      const skill = await d1.prepare("SELECT name, cache_status AS cacheStatus FROM training_center_skills WHERE id = ?")
        .bind(skillId).first<{ name: string; cacheStatus: string }>();
      if (!skill) return Response.json({ error: "Skill request not found" }, { status: 404 });
      if (skill.cacheStatus !== "cached") {
        await d1.batch([
          d1.prepare("UPDATE training_center_skills SET cache_status = 'cached', cached_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(skillId),
          d1.prepare("INSERT INTO activity (message, tone) VALUES (?, 'success')").bind(`${skill.name} was confirmed in the Training Center cache.`),
        ]);
      }
    } else if (body.action === "requestCharacter") {
      const slug = cleanText(body.slug, 80).toLowerCase();
      if (!petSlugPattern.test(slug)) return Response.json({ error: "Use the pet slug shown in the Codex Pets catalog" }, { status: 400 });
      const existing = await d1.prepare("SELECT id FROM character_packs WHERE id = ?").bind(slug).first();
      if (!existing) {
        const command = `npx @astandrik/codex-pets install ${slug}`;
        await d1.batch([
          d1.prepare(`INSERT INTO character_packs (
            id, display_name, description, source_url, install_command, cache_status
          ) VALUES (?, ?, ?, ?, ?, 'requested')`)
            .bind(slug, slug.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" "), "Requested from the Codex Pets catalog.", `https://codex-pets.net/pets/${slug}`, command),
          d1.prepare("INSERT INTO activity (message, tone) VALUES (?, 'neutral')").bind(`Training Center queued the ${slug} character pack for import.`),
        ]);
      }
    } else if (body.action === "confirmCharacterCached") {
      const slug = cleanText(body.slug, 80).toLowerCase();
      const character = await d1.prepare("SELECT display_name AS displayName, cache_status AS cacheStatus FROM character_packs WHERE id = ?")
        .bind(slug).first<{ displayName: string; cacheStatus: string }>();
      if (!character) return Response.json({ error: "Character request not found" }, { status: 404 });
      if (character.cacheStatus !== "cached") {
        await d1.batch([
          d1.prepare(`UPDATE character_packs SET cache_status = 'cached',
            spritesheet_path = ?, cached_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
            .bind(`/characters/${slug}/spritesheet.webp`, slug),
          d1.prepare("INSERT INTO activity (message, tone) VALUES (?, 'success')")
            .bind(`${character.displayName} was confirmed in the character cache.`),
        ]);
      }
    } else {
      return Response.json({ error: "Unknown Training Center action" }, { status: 400 });
    }

    return Response.json(await readTraining());
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Training Center action failed" }, { status: 500 });
  }
}
