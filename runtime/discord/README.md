# Aurora Discord adapter

Aurora is a read-only Discord adapter for an existing company employee named `Aurora`. It is not an employee brain and does not run Codex. The adapter opens an outbound Discord Gateway connection, registers two private user-install slash commands, and reads a deliberately narrow Company Portal status endpoint.

## Authority

- Discord intent: `Guilds` only. Privileged and message-content intents remain disabled.
- Commands: `/company` and `/employee employee:<name-or-id>`.
- Audience: only the Discord application owner who authorized the user installation. Commands are limited to bot DMs and private channels; every response is ephemeral and suppresses mentions.
- Company access: authenticated `GET /api/integrations/discord/status` only. The response omits system prompts, mail, skills, repositories, and credentials.
- Container: no host port, Docker socket, Codex authentication, GitHub authentication, or employee workspace. The root filesystem is read-only and Linux capabilities are dropped.

The default status credential is a domain-separated SHA-256 derivative of the local runtime bridge secret. Only the derivative is mounted into the adapter, so compromise of the adapter does not grant the broader runtime bridge authority. If the portal is configured with an independent `DISCORD_STATUS_TOKEN`, pass the file containing that same value with `-StatusTokenPath`.

## Discord setup

In the Discord Developer Portal:

1. Create an application and bot named **Aurora**. Disable Public Bot and leave every privileged Gateway intent off.
2. Enable **User Install** with the `applications.commands` scope, then authorize the app for your own Discord account. No server or channel permission is required.
3. Copy the application ID. Reveal and copy the bot token only when ready to import it. Treat token reveal, MFA, and CAPTCHA as human-only stop points.

With the bot token still on the clipboard, run this from an interactive PowerShell window:

```powershell
.\runtime\discord\Import-DiscordCredential.ps1 `
  -ApplicationId "123456789012345678" `
  -EmployeeId "employee-existing-aurora-id" `
  -FromClipboard
```

The importer validates the token through Discord, verifies that the application is named exactly Aurora and belongs to the configured application ID, writes only to Git-ignored files, and clears both its sensitive variables and the clipboard. Omitting `-FromClipboard` uses a masked interactive prompt. Never pass the bot token as a shell argument.

The resulting ignored config has this shape:

`assets/discord/config.json`

```json
{
  "applicationId": "123456789012345678",
  "employeeId": "employee-existing-aurora-id"
}
```

`assets/discord/bot-token` contains only the bot token, with no variable name or quotes. The repository-wide `/assets/*/` ignore rule excludes both files; the importer and startup script refuse to continue unless Git confirms all runtime material is ignored.

The configured employee ID must already exist in D1 and its name must be exactly `Aurora`. The adapter deliberately refuses to alias the HR Manager, Aurelia, or create a new employee implicitly.

## Start

Start the Company Portal first, then run:

```powershell
.\runtime\discord\Start-Discord.ps1 -BuildImage
```

The host status check defaults to `http://127.0.0.1:3002`; the container continues to reach the portal through the private company network at `http://omc-portal:3000`. Run the script again after changing Discord configuration or credentials.

Successful startup asks Discord which application and owner the token belongs to, derives the CEO allowlist from that verified owner ID, independently verifies the scoped portal credential and Aurora employee identity, and waits for command registration plus Discord Gateway readiness before reporting success. Command failures return a generic private reply; credentials and response bodies are never logged.
