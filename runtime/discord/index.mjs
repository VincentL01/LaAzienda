import { readFile } from "node:fs/promises";
import { createServer, get } from "node:http";
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
  isAdapterRuntimeHealthy,
  isAuthorizedDiscordOwner,
  isDiscordStatusSnapshot,
} from "./status.mjs";

const BOT_TOKEN_PATH = "/run/secrets/discord_bot_token";
const GATEWAY_CLIENT_TOKEN_PATH = "/run/secrets/gateway_client_token";
const STATUS_GATEWAY_URL = "http://omc-discord-status-gateway:8080/v1/status";
const EXPECTED_EMPLOYEE_ID = "employee-hrm";
const EXPECTED_EMPLOYEE_NAME = "Aurelia";
const MAX_STATUS_BYTES = 256 * 1024;
const HEALTH_PORT = 8081;
const STATUS_REFRESH_INTERVAL_MS = 5_000;
const MAX_STATUS_AGE_MS = 15_000;

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

async function requestStatusSnapshot(clientToken) {
  return new Promise((resolve, reject) => {
    const request = get(STATUS_GATEWAY_URL, {
      agent: false,
      headers: { accept: "application/json", authorization: `Bearer ${clientToken}` },
    }, (response) => {
      const chunks = [];
      let total = 0;
      response.on("data", (chunk) => {
        total += chunk.length;
        if (total > MAX_STATUS_BYTES) response.destroy(new Error("Company status response exceeded its bound."));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        if (response.statusCode !== 200 || !response.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
          reject(new Error(`Company status gateway returned ${response.statusCode ?? "unknown"}.`));
          return;
        }
        try { resolve(JSON.parse(Buffer.concat(chunks, total).toString("utf8"))); }
        catch { reject(new Error("Company status gateway returned invalid JSON.")); }
      });
    });
    request.setTimeout(5_000, () => request.destroy(new Error("Company status gateway timed out.")));
    request.on("error", reject);
  });
}

function healthServer(isHealthy) {
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/healthz") {
      response.writeHead(request.method === "GET" ? 404 : 405, {
        "cache-control": "no-store",
        "content-length": "0",
      });
      response.end();
      return;
    }
    response.writeHead(isHealthy() ? 204 : 503, {
      "cache-control": "no-store",
      "content-length": "0",
    });
    response.end();
  });
  server.requestTimeout = 1_000;
  server.headersTimeout = 1_000;
  server.keepAliveTimeout = 500;
  return server;
}

function listenOnLoopback(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(HEALTH_PORT, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
}

async function start() {
  const applicationId = validateSnowflake("applicationId", requiredEnvironment("OMC_DISCORD_APPLICATION_ID"));
  const ceoUserId = validateSnowflake("ceoUserId", requiredEnvironment("OMC_DISCORD_CEO_USER_ID"));
  const [botToken, gatewayClientToken] = await Promise.all([
    readSecret(BOT_TOKEN_PATH, "Discord bot token"),
    readSecret(GATEWAY_CLIENT_TOKEN_PATH, "Gateway client token"),
  ]);

  let lastStatusSuccessAt = 0;
  async function fetchSnapshot() {
    const snapshot = await requestStatusSnapshot(gatewayClientToken);
    if (!isDiscordStatusSnapshot(snapshot)) throw new Error("Company status response did not match schema version 1.");
    if (snapshot.integrationEmployee.id !== EXPECTED_EMPLOYEE_ID || snapshot.integrationEmployee.name !== EXPECTED_EMPLOYEE_NAME) {
      throw new Error("The configured Discord employee must resolve exactly to Aurelia.");
    }
    lastStatusSuccessAt = Date.now();
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
      content: "Aurelia could not read a verified company snapshot. Check the local Discord adapter logs.",
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
          content: "This Aurelia bridge is reserved for its authorizing CEO.",
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
      console.error(`Aurelia interaction failed (${interaction.id}, ${error instanceof Error ? error.name : "unknown"}).`);
      try { await replyWithFailure(interaction); } catch { console.error(`Aurelia could not close interaction ${interaction.id}.`); }
    }
  }

  await fetchSnapshot();
  const rest = new REST({ version: "10" }).setToken(botToken);
  await rest.put(Routes.applicationCommands(applicationId), { body: discordCommandDefinitions() });

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.on(Events.InteractionCreate, (interaction) => { void handleInteraction(interaction); });
  client.once(Events.ClientReady, (readyClient) => {
    console.log(`Aurelia Discord adapter connected as ${readyClient.user.id}.`);
    void refreshStatusHealth();
  });
  const server = healthServer(() => isAdapterRuntimeHealthy({
    discordReady: client.isReady(),
    lastStatusSuccessAt,
    maxStatusAgeMs: MAX_STATUS_AGE_MS,
  }));
  await listenOnLoopback(server);
  let statusRefreshRunning = false;
  async function refreshStatusHealth() {
    if (!client.isReady() || statusRefreshRunning) return;
    statusRefreshRunning = true;
    try { await fetchSnapshot(); } catch { /* Health expires without logging response or credential data. */ }
    finally { statusRefreshRunning = false; }
  }
  const statusRefresh = setInterval(() => { void refreshStatusHealth(); }, STATUS_REFRESH_INTERVAL_MS);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      clearInterval(statusRefresh);
      server.close();
      client.destroy();
      process.exit(0);
    });
  }
  try {
    await client.login(botToken);
    await refreshStatusHealth();
  } catch (error) {
    clearInterval(statusRefresh);
    server.close();
    throw error;
  }
}

try {
  await start();
} catch (error) {
  console.error(`Aurelia startup failed (${error instanceof Error ? error.name : "unknown"}).`);
  process.exitCode = 1;
}
