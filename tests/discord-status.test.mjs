import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  discordCommandDefinitions,
  formatCompanyReport,
  formatEmployeeReport,
  isAuthorizedDiscordOwner,
  isDiscordStatusSnapshot,
} from "../runtime/discord/status.mjs";

function snapshot(overrides = {}) {
  return {
    schemaVersion: "1",
    generatedAt: "2026-08-22T03:00:00.000Z",
    integrationEmployee: {
      id: "employee-aurora",
      name: "Aurora",
      role: "Communications Liaison",
      status: "idle",
      runtimeStatus: "running",
    },
    tasks: { queued: 2, working: 1, review: 1, done: 4 },
    employees: [
      {
        id: "employee-aurora",
        name: "Aurora",
        role: "Communications Liaison",
        status: "idle",
        runtimeStatus: "running",
        currentTask: null,
        latestRun: null,
        systemPrompt: "must never appear",
        emailAddress: "must-never-appear@example.test",
      },
      {
        id: "employee-beatrice",
        name: "Beatrice",
        role: "Project Manager",
        status: "working",
        runtimeStatus: "running",
        currentTask: { id: "task-1", title: "Repair @everyone portal", status: "working" },
        latestRun: {
          id: "run-1",
          status: "running",
          lastEvent: "Executing `npm test` for @everyone",
          heartbeatAt: "2026-08-21 23:00:00",
          error: "Notify @everyone",
        },
      },
      {
        id: "employee-aurelia",
        name: "Aurelia",
        role: "Human Resources Manager",
        status: "idle",
        runtimeStatus: "running",
        currentTask: null,
        latestRun: null,
      },
    ],
    ...overrides,
  };
}

test("formats a bounded company report without Discord mentions or private employee fields", () => {
  const reply = formatCompanyReport(snapshot());

  assert.match(reply.content, /Company status/);
  assert.match(reply.content, /inbox \*\*2\*\*/);
  assert.match(reply.content, /Beatrice/);
  assert.doesNotMatch(reply.content, /@everyone/);
  assert.doesNotMatch(reply.content, /must never appear|must-never-appear/);
  assert.deepEqual(reply.allowedMentions, { parse: [] });
  assert.ok(reply.content.length <= 2_000);
});

test("reports one employee's current work, evidence, stale heartbeat, and blocker", () => {
  const reply = formatEmployeeReport(snapshot(), "employee-beatrice");

  assert.match(reply.content, /Beatrice — Project Manager/);
  assert.match(reply.content, /Repair @\u200beveryone portal/);
  assert.match(reply.content, /heartbeat .*\(stale\)/);
  assert.match(reply.content, /Latest evidence/);
  assert.match(reply.content, /Blocker/);
  assert.doesNotMatch(reply.content, /@everyone/);
  assert.deepEqual(reply.allowedMentions, { parse: [] });
});

test("does not guess when an employee query is ambiguous", () => {
  const reply = formatEmployeeReport(snapshot(), "au");

  assert.match(reply.content, /More than one employee matched/);
  assert.match(reply.content, /Aurora/);
  assert.match(reply.content, /Aurelia/);
});

test("caps large reports at Discord's message limit", () => {
  const employees = Array.from({ length: 80 }, (_, index) => ({
    id: `employee-${index}`,
    name: `Employee ${index}`,
    role: "Engineer",
    status: "working",
    runtimeStatus: "running",
    currentTask: { id: `task-${index}`, title: "A very detailed active delivery ".repeat(8), status: "working" },
    latestRun: { id: `run-${index}`, status: "running", lastEvent: "A detailed event ".repeat(20), heartbeatAt: "2026-08-22T02:59:30Z", error: null },
  }));
  const reply = formatCompanyReport(snapshot({ employees }));

  assert.ok(reply.content.length <= 2_000);
  assert.match(reply.content, /more employees|more employee/);
});

test("validates only the narrow status response shape", () => {
  assert.equal(isDiscordStatusSnapshot(snapshot()), true);
  assert.equal(isDiscordStatusSnapshot({ schemaVersion: "2" }), false);
  assert.equal(isDiscordStatusSnapshot(null), false);
});

test("authorizes only the application owner and emits private user-install commands", () => {
  assert.equal(isAuthorizedDiscordOwner("100000000000000001", "100000000000000001", "100000000000000001"), true);
  assert.equal(isAuthorizedDiscordOwner("100000000000000002", "100000000000000001", "100000000000000001"), false);
  assert.equal(isAuthorizedDiscordOwner("100000000000000001", undefined, "100000000000000001"), false);

  const commands = discordCommandDefinitions();
  assert.deepEqual(commands.map((command) => command.name), ["company", "employee"]);
  for (const command of commands) {
    assert.deepEqual(command.integration_types, [1]);
    assert.deepEqual(command.contexts, [1, 2]);
  }
});

test("keeps the Aurora adapter on its least-privilege runtime boundary", async () => {
  const [adapter, dockerfile, startScript, importer, statusRoute, packageJson, packageLock, readme] = await Promise.all([
    readFile(new URL("../runtime/discord/index.mjs", import.meta.url), "utf8"),
    readFile(new URL("../runtime/discord/Dockerfile", import.meta.url), "utf8"),
    readFile(new URL("../runtime/discord/Start-Discord.ps1", import.meta.url), "utf8"),
    readFile(new URL("../runtime/discord/Import-DiscordCredential.ps1", import.meta.url), "utf8"),
    readFile(new URL("../app/api/integrations/discord/status/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../runtime/discord/package.json", import.meta.url), "utf8"),
    readFile(new URL("../runtime/discord/package-lock.json", import.meta.url), "utf8"),
    readFile(new URL("../runtime/discord/README.md", import.meta.url), "utf8"),
  ]);

  assert.match(adapter, /intents: \[GatewayIntentBits\.Guilds\]/);
  assert.doesNotMatch(adapter, /GuildMembers|MessageContent|GuildMessages|GuildPresences/);
  assert.match(adapter, /discordCommandDefinitions\(\)/);
  assert.match(adapter, /Routes\.applicationCommands\(applicationId\)/);
  assert.match(adapter, /authorizingIntegrationOwners\?\.userId/);
  assert.doesNotMatch(adapter, /applicationGuildCommands|OMC_DISCORD_GUILD_ID/);
  assert.match(adapter, /MessageFlags\.Ephemeral/);
  assert.match(adapter, /EXPECTED_EMPLOYEE_NAME = "Aurora"/);
  assert.doesNotMatch(adapter, /process\.env\.[A-Z_]*(?:TOKEN|SECRET)/);
  assert.doesNotMatch(dockerfile, /EXPOSE|docker\.sock|codex|github/i);
  assert.match(dockerfile, /HEALTHCHECK[\s\S]*aurora-ready/);
  assert.match(startScript, /--read-only/);
  assert.match(startScript, /--cap-drop", "ALL"/);
  assert.match(startScript, /no-new-privileges:true/);
  assert.match(startScript, /\.State\.Health[\s\S]*running\|healthy/);
  assert.doesNotMatch(startScript, /--publish|docker\.sock|codex_auth|github_token/i);
  assert.match(startScript, /oauth2\/applications\/@me/);
  assert.match(importer, /oauth2\/applications\/@me/);
  assert.match(startScript, /\$application\.owner\.id/);
  assert.doesNotMatch(startScript, /guildId|config\.ceoUserId/);
  assert.match(startScript, /discord-status:v1`0\$runtimeBridgeToken/);
  assert.match(importer, /Read-Host "Paste the Aurora bot token" -AsSecureString/);
  assert.match(importer, /Get-Clipboard -Raw/);
  assert.match(importer, /Set-Clipboard -Value ""/);
  assert.match(importer, /ZeroFreeBSTR/);
  assert.match(importer, /check-ignore --quiet/);
  assert.doesNotMatch(importer, /Write-(?:Output|Host).*token/i);
  assert.match(statusRoute, /DISCORD_STATUS_TOKEN/);
  assert.match(statusRoute, /constantTimeEqual/);
  assert.match(statusRoute, /cache-control.*no-store/);
  assert.doesNotMatch(statusRoute, /system_prompt|email_address|employee_skills|mail_messages/i);
  assert.equal(JSON.parse(packageJson).dependencies["discord.js"], "14.27.0");
  assert.equal(JSON.parse(packageLock).packages["node_modules/discord.js"].version, "14.27.0");
  assert.match(readme, /private user-install slash commands/);
  assert.match(readme, /Privileged and message-content intents remain disabled/);
});
