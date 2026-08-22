# Aurelia Discord adapter

Aurelia is the CEO-facing identity for a read-only Discord adapter bound to the existing `employee-hrm` record. The adapter is not Aurelia's employee brain and does not run Codex. It opens an outbound Discord Gateway connection, registers two private user-install slash commands, and reads a deliberately narrow Company Portal status endpoint.

Aurelia's enforced company role remains Human Resources Manager and sole Docker provisioner. Calling her the CEO's secretary describes this reporting channel; it does not grant the adapter HRM authority or replace Dorothy's modeled Secretary role. The Discord bot token, gateway-client token, and scoped portal-status token never enter Aurelia's socket-holding container or any employee container.

## Authority

- Discord intent: `Guilds` only. Privileged and message-content intents remain disabled.
- Commands: `/company` and `/employee employee:<name-or-id>`.
- Audience: only the Discord application owner who authorized the user installation. Commands are limited to bot DMs and private channels; every response is ephemeral and suppresses mentions.
- Company access: the adapter can call only authenticated `GET http://omc-discord-status-gateway:8080/v1/status` on its dedicated bridge. The gateway requires a separate bearer client capability, compares it in constant time, rejects every other method, path, query, body, and non-allowlisted header, then performs one fixed authenticated portal request. The response omits system prompts, mail, skills, repositories, and credentials.
- Containers: the adapter joins only `one-man-company-discord`; it has no route or DNS visibility to `omc-portal` or other employees and receives no company URL or portal-status credential. `omc-discord-status-gateway` alone joins both the Discord and company bridges and is the only caller that mounts the scoped portal-status token. The distinct gateway-client token is mounted read-only into only the adapter and gateway; employees receive neither token. Even disclosure of that client token does not let the adapter address the portal or authenticate to it. Neither container publishes a host port, Docker socket, Codex authentication, GitHub authentication, or employee workspace. Both root filesystems are read-only and Linux capabilities are dropped.

`Start-Company.ps1` independently generates both Discord credentials from separate 256-bit cryptographic random draws and stores them under ignored `assets/discord/runtime/`. It injects `portal-status-token` only into the portal verifier and mounts it into the narrow gateway; it mounts the unrelated `gateway-client-token` only into the adapter and gateway. Neither value is derived from the runtime bridge token or mounted into an employee, and HRM's read-only `runtime/state` mount cannot include this Discord-only directory. The status route fails closed when `DISCORD_STATUS_TOKEN` is missing or malformed and has no runtime-bridge fallback. The portal container is replaced automatically when the portal-status credential changes. For an independently launched portal, `-StatusTokenPath` remains available only for an ignored file inside `assets/discord/runtime/`; the portal's `DISCORD_STATUS_TOKEN` must contain that same value.

## Discord setup

In the Discord Developer Portal:

1. Create an application and bot named **Aurelia**. Disable Public Bot and leave every privileged Gateway intent off.
2. Enable **User Install** with the `applications.commands` scope, then authorize the app for your own Discord account. No server or channel permission is required.
3. Copy the application ID. Reveal and copy the bot token only when ready to import it. Treat token reveal, MFA, and CAPTCHA as human-only stop points.

With the bot token still on the clipboard, run this from an interactive PowerShell window:

```powershell
.\runtime\discord\Import-DiscordCredential.ps1 `
  -ApplicationId "123456789012345678" `
  -FromClipboard
```

The importer validates the token through Discord, verifies that the application is named exactly Aurelia and belongs to the configured application ID, binds it only to `employee-hrm`, writes only to Git-ignored files, and clears both its sensitive variables and the clipboard. Omitting `-FromClipboard` uses a masked interactive prompt. Never pass the bot token as a shell argument.

The resulting ignored config has this shape:

`assets/discord/config.json`

```json
{
  "applicationId": "123456789012345678",
  "employeeId": "employee-hrm"
}
```

`assets/discord/bot-token` contains only the bot token, with no variable name or quotes. The repository-wide `/assets/*/` ignore rule excludes both files; the importer and startup script refuse to continue unless Git confirms all runtime material is ignored.

The configured employee ID must be `employee-hrm`, already exist in D1, and have the exact name `Aurelia`. This identity check affects presentation only: the status API exposes no HRM write action, the adapter receives no runtime bridge token, and the adapter cannot provision or control employee containers.

## Migration from the former Aurora adapter

Every company start retires `omc-discord-aurora` before looking for Discord credentials, but only after independently verifying its `one-man-company.discord-adapter=aurora` label. An unrelated container using that reserved legacy name is never removed.

Before importing Aurelia, retire the former cloud application manually:

1. In your Discord user settings, remove/uninstall the former **Aurora** user-installed or authorized application.
2. In Discord Developer Portal, open **Aurora → Bot** and reset its token so every copied Aurora token is revoked. Do not paste the replacement token into LaAzienda.
3. If Aurora has no remaining purpose, use **General Information → Delete App**. Deleting the application also retires its global commands. This is destructive cloud cleanup and must remain a human action; LaAzienda never performs it automatically.
4. Create or open the separate **Aurelia** application, complete the setup above, and import only Aurelia's token.

Before inspecting config or contacting Discord, the company bootstrap invokes label-gated cleanup for orphan adapter and gateway candidates and repairs an interrupted stable/backup swap. A legacy `employee-aurora` config, invalid or missing config, or missing token then skips replacement and produces a non-secret recovery warning without stopping the portal or employees. With Aurelia's `employee-hrm` config present, application-name and token validation stays inside `Start-Discord.ps1`; a stale Aurora token or a transient Discord validation failure likewise leaves the core company running and does not print the token or remote response. A failed cleanup or rollback is reported as potentially unavailable or duplicated Discord reporting; startup never claims the prior adapter is unchanged unless recovery actually verified it.

To replace any legacy or stale credential, copy the bot token from the Discord application named **Aurelia**, then run:

```powershell
.\runtime\discord\Import-DiscordCredential.ps1 -ApplicationId "<AURELIA_APPLICATION_ID>" -FromClipboard
```

## Start

Start the Company Portal first, then run:

```powershell
.\runtime\discord\Start-Discord.ps1 -BuildImage
```

Startup first stages and health-checks a status-gateway candidate, then stages an adapter candidate that must register commands, log into Discord Gateway, authenticate to the gateway with its narrow client capability, and read a valid status snapshot. Adapter health remains current only while the Discord client reports ready and a separately validated status read is no more than 15 seconds old; a loopback-only health endpoint exposes only that boolean. A previously verified container is retained for rollback until its candidate is healthy and promoted. Interrupted replacement recovers a stopped stable container, and rollback is not accepted until the prior container is renamed, restarted, and healthy. The adapter's only company-facing address is `http://omc-discord-status-gateway:8080/v1/status`; only the gateway knows the fixed portal address and holds its separate portal credential. Run the script again after changing Discord configuration or credentials.

Successful startup asks Discord which application and owner the token belongs to, derives the CEO allowlist from that verified owner ID, independently verifies the scoped portal credential and Aurelia employee identity, and waits for command registration plus Discord Gateway readiness before reporting success. Credential values and response bodies are never logged; command failures return a generic private reply.
