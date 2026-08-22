import { readFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
} from "discord.js";
import {
  discordCommandDefinitions,
  formatCompanyReport,
  formatEmployeeReport,
  isAuthorizedDiscordOwner,
  isDiscordStatusSnapshot,
} from "./status.mjs";

const BOT_TOKEN_PATH = "/run/secrets/discord_bot_token";
const STATUS_TOKEN_PATH = "/run/secrets/company_status_token";
const EXPECTED_EMPLOYEE_NAME = "Aurora";

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required configuration: ${name}`);
  return value;
}

function validateSnowflake(name, value) {
  if (!/^\d{17,20}$/.test(value)) throw new Error(`Invalid Discord snowflake: ${name}`);
  return value;
}

async function readSecret(path, label) {
  const value = (await readFile(path, "utf8")).trim();
  if (value.length < 32) throw new Error(`${label} is missing or invalid.`);
  return value;
}

async function start() {
  const applicationId = validateSnowflake("applicationId", requiredEnvironment("OMC_DISCORD_APPLICATION_ID"));
  const ceoUserId = validateSnowflake("ceoUserId", requiredEnvironment("OMC_DISCORD_CEO_USER_ID"));
  const employeeId = requiredEnvironment("OMC_DISCORD_EMPLOYEE_ID");
  const controlUrl = new URL(requiredEnvironment("OMC_CONTROL_URL"));
  const [botToken, statusToken] = await Promise.all([
    readSecret(BOT_TOKEN_PATH, "Discord bot token"),
    readSecret(STATUS_TOKEN_PATH, "Company status token"),
  ]);

  async function fetchSnapshot() {
    const endpoint = new URL("/api/integrations/discord/status", controlUrl);
    endpoint.searchParams.set("employeeId", employeeId);
    const response = await fetch(endpoint, {
      headers: { authorization: `Bearer ${statusToken}` },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Company status endpoint returned ${response.status}.`);
    const snapshot = await response.json();
    if (!isDiscordStatusSnapshot(snapshot)) throw new Error("Company status response did not match schema version 1.");
    if (snapshot.integrationEmployee.id !== employeeId || snapshot.integrationEmployee.name !== EXPECTED_EMPLOYEE_NAME) {
      throw new Error("The configured Discord employee must resolve exactly to Aurora.");
    }
    return snapshot;
  }

  function isAuthorizedInteraction(interaction) {
    return isAuthorizedDiscordOwner(
      interaction.user.id,
      interaction.authorizingIntegrationOwners?.userId,
      ceoUserId,
    );
  }

  async function replyWithFailure(interaction) {
    const payload = {
      content: "Aurora could not read a verified company snapshot. Check the local Discord adapter logs.",
      allowedMentions: { parse: [] },
    };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
    else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  }

  async function handleInteraction(interaction) {
    if (!interaction.isChatInputCommand() || !["company", "employee"].includes(interaction.commandName)) return;
    try {
      if (!isAuthorizedInteraction(interaction)) {
        await interaction.reply({
          content: "This Aurora bridge is reserved for its authorizing CEO.",
          allowedMentions: { parse: [] },
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const snapshot = await fetchSnapshot();
      const reply = interaction.commandName === "company"
        ? formatCompanyReport(snapshot)
        : formatEmployeeReport(snapshot, interaction.options.getString("employee", true));
      await interaction.editReply(reply);
    } catch (error) {
      console.error(`Aurora interaction failed (${interaction.id}, ${error instanceof Error ? error.name : "unknown"}).`);
      try { await replyWithFailure(interaction); } catch { console.error(`Aurora could not close interaction ${interaction.id}.`); }
    }
  }

  await fetchSnapshot();
  const rest = new REST({ version: "10" }).setToken(botToken);
  await rest.put(Routes.applicationCommands(applicationId), { body: discordCommandDefinitions() });

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.on(Events.InteractionCreate, (interaction) => { void handleInteraction(interaction); });
  client.once(Events.ClientReady, (readyClient) => {
    writeFileSync("/tmp/aurora-ready", `${readyClient.user.id}\n`, { encoding: "utf8", mode: 0o600 });
    console.log(`Aurora Discord adapter connected as ${readyClient.user.id}.`);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      client.destroy();
      process.exit(0);
    });
  }
  await client.login(botToken);
}

try {
  await start();
} catch (error) {
  console.error(`Aurora startup failed (${error instanceof Error ? error.name : "unknown"}).`);
  process.exitCode = 1;
}
