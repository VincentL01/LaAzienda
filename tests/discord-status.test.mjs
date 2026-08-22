import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  discordCommandDefinitions,
  formatCompanyReport,
  formatEmployeeReport,
  isAdapterRuntimeHealthy,
  isAuthorizedDiscordOwner,
  isDiscordStatusSnapshot,
} from "../runtime/discord/status.mjs";
import { classifyGatewayRequest, constantTimeTokenEqual } from "../runtime/discord/gateway.mjs";

function snapshot(overrides = {}) {
  return {
    schemaVersion: "1",
    generatedAt: "2026-08-22T03:00:00.000Z",
    integrationEmployee: {
      id: "employee-hrm",
      name: "Aurelia",
      role: "Human Resources Manager",
      status: "idle",
      runtimeStatus: "running",
    },
    tasks: { queued: 2, working: 1, review: 1, done: 4 },
    employees: [
      {
        id: "employee-aurora",
        name: "Aurora",
        role: "Company Employee",
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
        id: "employee-hrm",
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

test("adapter runtime health requires live Discord readiness and a recent status read", () => {
  const now = 100_000;
  assert.equal(isAdapterRuntimeHealthy({ discordReady: true, lastStatusSuccessAt: 95_000, now }), true);
  assert.equal(isAdapterRuntimeHealthy({ discordReady: false, lastStatusSuccessAt: 95_000, now }), false);
  assert.equal(isAdapterRuntimeHealthy({ discordReady: true, lastStatusSuccessAt: 84_999, now }), false);
  assert.equal(isAdapterRuntimeHealthy({ discordReady: true, lastStatusSuccessAt: 100_001, now }), false);
  assert.equal(isAdapterRuntimeHealthy({ discordReady: true, lastStatusSuccessAt: Number.NaN, now }), false);
});

test("status gateway requires an exact bodyless request and a bearer client capability", () => {
  const clientToken = "a".repeat(64);
  const exact = {
    method: "GET",
    url: "/v1/status",
    headers: {
      host: "omc-discord-status-gateway:8080",
      accept: "application/json",
      connection: "close",
      authorization: `Bearer ${clientToken}`,
    },
    bodyBytes: 0,
  };
  assert.deepEqual(classifyGatewayRequest(exact), { accepted: true, status: 200 });
  assert.equal(constantTimeTokenEqual(clientToken, clientToken), true);
  assert.equal(constantTimeTokenEqual("b".repeat(64), clientToken), false);
  assert.equal(classifyGatewayRequest({ ...exact, method: "POST" }).accepted, false);
  assert.equal(classifyGatewayRequest({ ...exact, url: "/v1/status?employeeId=employee-aurora" }).accepted, false);
  assert.equal(classifyGatewayRequest({ ...exact, url: "/api/integrations/discord/status" }).accepted, false);
  assert.equal(classifyGatewayRequest({ ...exact, bodyBytes: 1 }).accepted, false);
  const missingAuthorization = { ...exact.headers };
  delete missingAuthorization.authorization;
  assert.equal(classifyGatewayRequest({ ...exact, headers: missingAuthorization }).accepted, false);
  assert.equal(classifyGatewayRequest({ ...exact, headers: { ...exact.headers, authorization: "Bearer malformed" } }).accepted, false);
  assert.equal(classifyGatewayRequest({ ...exact, headers: { ...exact.headers, "x-forwarded-for": "127.0.0.1" } }).accepted, false);
});

test("keeps the Aurelia adapter on its least-privilege runtime boundary", async () => {
  const [adapter, dockerfile, gateway, gatewayDockerfile, startScript, startCompany, runtimeBridge, importer, statusRoute, packageJson, packageLock, readme, ensureDatabase] = await Promise.all([
    readFile(new URL("../runtime/discord/index.mjs", import.meta.url), "utf8"),
    readFile(new URL("../runtime/discord/Dockerfile", import.meta.url), "utf8"),
    readFile(new URL("../runtime/discord/gateway.mjs", import.meta.url), "utf8"),
    readFile(new URL("../runtime/discord/Gateway.Dockerfile", import.meta.url), "utf8"),
    readFile(new URL("../runtime/discord/Start-Discord.ps1", import.meta.url), "utf8"),
    readFile(new URL("../runtime/Start-Company.ps1", import.meta.url), "utf8"),
    readFile(new URL("../runtime/bridge.ps1", import.meta.url), "utf8"),
    readFile(new URL("../runtime/discord/Import-DiscordCredential.ps1", import.meta.url), "utf8"),
    readFile(new URL("../app/api/integrations/discord/status/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../runtime/discord/package.json", import.meta.url), "utf8"),
    readFile(new URL("../runtime/discord/package-lock.json", import.meta.url), "utf8"),
    readFile(new URL("../runtime/discord/README.md", import.meta.url), "utf8"),
    readFile(new URL("../db/ensure.ts", import.meta.url), "utf8"),
  ]);

  assert.match(adapter, /intents: \[GatewayIntentBits\.Guilds\]/);
  assert.doesNotMatch(adapter, /GuildMembers|MessageContent|GuildMessages|GuildPresences/);
  assert.match(adapter, /discordCommandDefinitions\(\)/);
  assert.match(adapter, /Routes\.applicationCommands\(applicationId\)/);
  assert.match(adapter, /authorizingIntegrationOwners\?\.userId/);
  assert.doesNotMatch(adapter, /applicationGuildCommands|OMC_DISCORD_GUILD_ID/);
  assert.match(adapter, /MessageFlags\.Ephemeral/);
  assert.match(adapter, /EXPECTED_EMPLOYEE_NAME = "Aurelia"/);
  assert.match(adapter, /EXPECTED_EMPLOYEE_ID = "employee-hrm"/);
  assert.match(adapter, /STATUS_GATEWAY_URL = "http:\/\/omc-discord-status-gateway:8080\/v1\/status"/);
  assert.match(adapter, /GATEWAY_CLIENT_TOKEN_PATH = "\/run\/secrets\/gateway_client_token"/);
  assert.match(adapter, /authorization: `Bearer \$\{clientToken\}`/);
  assert.doesNotMatch(adapter, /omc-portal|company_status_token|OMC_CONTROL_URL|OMC_DISCORD_EMPLOYEE_ID/i);
  assert.doesNotMatch(adapter, /process\.env\.[A-Z_]*(?:TOKEN|SECRET)/);
  assert.doesNotMatch(dockerfile, /EXPOSE|docker\.sock|codex|github/i);
  assert.match(dockerfile, /HEALTHCHECK[\s\S]*127\.0\.0\.1:8081\/healthz[\s\S]*statusCode===204/);
  assert.match(dockerfile, /--start-period=30s --retries=3/);
  assert.doesNotMatch(dockerfile, /aurelia-ready|accessSync/);
  assert.match(adapter, /client\.isReady\(\)/);
  assert.match(adapter, /lastStatusSuccessAt = Date\.now\(\)/);
  assert.match(adapter, /setInterval\([\s\S]*refreshStatusHealth[\s\S]*STATUS_REFRESH_INTERVAL_MS/);
  assert.match(adapter, /server\.listen\(HEALTH_PORT, "127\.0\.0\.1"/);
  assert.match(adapter, /isAdapterRuntimeHealthy\([\s\S]*maxStatusAgeMs: MAX_STATUS_AGE_MS/);
  assert.doesNotMatch(gatewayDockerfile, /EXPOSE|docker\.sock|codex|github/i);
  assert.match(gateway, /UPSTREAM_STATUS_URL = "http:\/\/omc-portal:3000\/api\/integrations\/discord\/status\?employeeId=employee-hrm"/);
  assert.match(gateway, /method !== "GET"[\s\S]*url !== "\/v1\/status"/);
  assert.match(gateway, /ALLOWED_REQUEST_HEADERS = new Set\(\["host", "accept", "connection", "authorization"\]\)/);
  assert.match(gateway, /STATUS_TOKEN_PATH = "\/run\/secrets\/company_status_token"/);
  assert.match(gateway, /CLIENT_TOKEN_PATH = "\/run\/secrets\/gateway_client_token"/);
  assert.match(gateway, /constantTimeTokenEqual\(suppliedToken, clientToken\)/);
  assert.match(gatewayDockerfile, /\/run\/secrets\/gateway_client_token[\s\S]*authorization:'Bearer '\+token/);
  assert.match(startScript, /--read-only/);
  assert.match(startScript, /--cap-drop", "ALL"/);
  assert.match(startScript, /no-new-privileges:true/);
  assert.match(startScript, /\.State\.Health[\s\S]*running\|healthy/);
  assert.doesNotMatch(startScript, /--publish|docker\.sock|codex_auth|github_token/i);
  const adapterCreateBlock = startScript.match(/\$adapterCreateArgs = @\(([\s\S]*?)\)\r?\n& docker @adapterCreateArgs/)?.[1] ?? "";
  const gatewayCreateBlock = startScript.match(/\$gatewayCreateArgs = @\(([\s\S]*?)\)\r?\n& docker @gatewayCreateArgs/)?.[1] ?? "";
  assert.match(adapterCreateBlock, /"--network", \$discordNetwork/);
  assert.doesNotMatch(adapterCreateBlock, /\$companyNetwork|company_status_token|OMC_CONTROL_URL|OMC_DISCORD_EMPLOYEE_ID/);
  assert.match(adapterCreateBlock, /gateway_client_token/);
  assert.match(gatewayCreateBlock, /"--network", \$companyNetwork/);
  assert.match(gatewayCreateBlock, /company_status_token/);
  assert.match(gatewayCreateBlock, /gateway_client_token/);
  assert.match(startScript, /docker network connect \$discordNetwork \$gatewayCandidate/);
  assert.doesNotMatch(startScript, /docker network connect \$companyNetwork \$adapter/);
  assert.match(startScript, /Wait-HealthyContainer \$gatewayCandidate[\s\S]*Promote-GatewayCandidate/);
  assert.match(startScript, /Wait-HealthyContainer \$adapterCandidate[\s\S]*Promote-AdapterCandidate/);
  assert.match(startScript, /if \(-not \$hasBackup\)[\s\S]*Get-ContainerStatus \$Stable[\s\S]*Start-AndVerifyOwnedContainer \$Stable/);
  assert.match(startScript, /Recover-InterruptedSwap \$adapterContainer[\s\S]*oauth2\/applications\/@me/);
  assert.match(startScript, /\[switch\]\$CleanupOnly/);
  assert.match(startScript, /Remove-OwnedContainer \$adapterCandidate[\s\S]*Remove-OwnedContainer \$gatewayCandidate[\s\S]*if \(\$CleanupOnly\) \{ return \}[\s\S]*Missing assets\/discord\/config\.json/);
  assert.match(startScript, /function Restore-BackupContainer[\s\S]*docker container rename \$Backup \$Stable[\s\S]*Start-AndVerifyOwnedContainer \$Stable/);
  assert.match(startScript, /function Stage-StableContainer[\s\S]*docker container stop \$Stable[\s\S]*docker container rename \$Stable \$Backup[\s\S]*restarted and verified/);
  assert.match(startScript, /Rollback also failed/);
  assert.match(startScript, /promotion failed; the previous container was restored and verified/);
  assert.match(startScript, /oauth2\/applications\/@me/);
  assert.match(importer, /oauth2\/applications\/@me/);
  assert.match(startScript, /\$application\.owner\.id/);
  assert.doesNotMatch(startScript, /guildId|config\.ceoUserId/);
  assert.match(startScript, /employee-hrm/);
  assert.match(startScript, /application\.name -cne "Aurelia"/);
  assert.match(startScript, /Join-Path \$repoRoot "assets\\discord\\runtime"/);
  assert.match(startScript, /Join-Path \$discordRuntimeRoot "portal-status-token"/);
  assert.match(startScript, /Join-Path \$discordRuntimeRoot "gateway-client-token"/);
  assert.doesNotMatch(startScript, /runtimeBridgeToken|Get-DomainSeparatedToken/);
  assert.match(startScript, /custom portal-status token must stay inside the ignored Discord-only runtime directory/);
  assert.match(startScript, /gatewayClientTokenPath, \$scopedTokenPath[\s\S]*StringComparison\]::OrdinalIgnoreCase/);
  assert.match(startScript, /gatewayClientTokenPath[\s\S]*git -C \$repoRoot check-ignore --quiet/);
  assert.match(startScript, /\$statusToken -ceq \$gatewayClientToken/);
  assert.match(startCompany, /\$portalVersion = "10"/);
  assert.match(startCompany, /Join-Path \$repoRoot "assets\\discord\\runtime"/);
  assert.match(startCompany, /Discord credentials must remain outside the HR Manager state mount/);
  assert.match(startCompany, /Get-OrCreateRandomToken \$discordStatusTokenPath[\s\S]*Get-OrCreateRandomToken \$discordGatewayClientTokenPath/);
  assert.match(startCompany, /New-Object byte\[\] 32[\s\S]*RandomNumberGenerator\]::Create\(\)/);
  assert.match(startCompany, /\$discordStatusToken -ceq \$discordGatewayClientToken/);
  assert.match(startCompany, /--env "DISCORD_STATUS_TOKEN=\$discordStatusToken"/);
  assert.match(startCompany, /one-man-company\.discord-status-version=\$discordStatusVersion/);
  assert.match(startCompany, /Remove-Item -LiteralPath \$legacyDiscordTokenPath -Force/);
  assert.match(startCompany, /& \$discordStartPath -CleanupOnly[\s\S]*\$discordConfigurationIssue = \$null/);
  assert.match(startCompany, /Discord reporting may be unavailable or duplicated/);
  assert.match(startCompany, /Discord reporting may be unavailable/);
  assert.doesNotMatch(startCompany, /already verified Aurelia adapter is left unchanged/);
  const portalCreateBlock = startCompany.match(/docker create --name \$portalContainer([\s\S]*?)\$portalImage \| Out-Null/)?.[1] ?? "";
  const hrmBootstrapBlock = startCompany.match(/& \(Join-Path \$PSScriptRoot "bridge\.ps1"\)([\s\S]*?)if \(\$LASTEXITCODE/)?.[1] ?? "";
  assert.match(portalCreateBlock, /DISCORD_STATUS_TOKEN=\$discordStatusToken/);
  assert.doesNotMatch(portalCreateBlock, /discordGatewayClientToken|gateway-client-token/);
  assert.match(hrmBootstrapBlock, /-BridgeToken \$bridgeToken/);
  assert.doesNotMatch(hrmBootstrapBlock, /discordStatusToken|discordGatewayClientToken|portal-status-token|gateway-client-token/);
  assert.match(runtimeBridge, /"--volume", "\$stateRoot`:\/company\/state:ro"/);
  assert.doesNotMatch(runtimeBridge, /assets[\\/]discord|portal-status-token|gateway-client-token|DISCORD_STATUS_TOKEN/);
  assert.doesNotMatch(startCompany, /Write-(?:Output|Host|Warning|Error)[^\r\n]*\$(?:discordStatusToken|discordGatewayClientToken)/i);
  assert.doesNotMatch(startScript, /Write-(?:Output|Host|Warning|Error)[^\r\n]*\$(?:statusToken|gatewayClientToken)/i);
  assert.match(importer, /Read-Host "Paste the Aurelia bot token" -AsSecureString/);
  assert.match(importer, /\$EmployeeId -cne "employee-hrm"/);
  assert.match(importer, /Get-Clipboard -Raw/);
  assert.match(importer, /Set-Clipboard -Value ""/);
  assert.match(importer, /ZeroFreeBSTR/);
  assert.match(importer, /check-ignore --quiet/);
  assert.doesNotMatch(importer, /Write-(?:Output|Host).*token/i);
  assert.match(statusRoute, /DISCORD_STATUS_TOKEN/);
  assert.match(statusRoute, /constantTimeEqual/);
  assert.doesNotMatch(statusRoute, /RUNTIME_BRIDGE_TOKEN|TOKEN_DOMAIN|derivedStatusToken/);
  assert.match(statusRoute, /dedicated && \/\^\[A-Za-z0-9_-\]\{43,128\}\$\//);
  assert.match(statusRoute, /cache-control.*no-store/);
  assert.doesNotMatch(statusRoute, /system_prompt|email_address|employee_skills|mail_messages/i);
  assert.equal(JSON.parse(packageJson).dependencies["discord.js"], "14.27.0");
  assert.equal(JSON.parse(packageLock).packages["node_modules/discord.js"].version, "14.27.0");
  assert.match(readme, /private user-install slash commands/);
  assert.match(readme, /Privileged and message-content intents remain disabled/);
  assert.match(readme, /does not grant the adapter HRM authority/);
  assert.match(readme, /stale Aurora token[\s\S]*core company running/);
  assert.match(readme, /remove\/uninstall the former \*\*Aurora\*\*/);
  assert.match(readme, /reset its token[\s\S]*Delete App/);
  assert.match(ensureDatabase, /'employee-aurora', 'Aurora', 'Company Employee', 'Operations'/);
  assert.match(ensureDatabase, /role_profile_id = 'company-employee'[\s\S]*resource_access = 'task-scoped'/);
  assert.match(ensureDatabase, /docker_socket_access = 0/);
  assert.doesNotMatch(ensureDatabase, /auroraNeedsRoleMigration/);
  assert.match(ensureDatabase, /INSERT INTO activity \(message, tone\)[\s\S]*role_profile_id = 'company-reporter'[\s\S]*UPDATE employees SET role = 'Company Employee'/);
});
