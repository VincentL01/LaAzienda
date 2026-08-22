const DISCORD_MESSAGE_LIMIT = 2_000;
const SAFE_MESSAGE_LIMIT = 1_900;
const DEFAULT_STALE_AFTER_MS = 2 * 60 * 1_000;
const USER_INSTALL = 1;
const BOT_DM = 1;
const PRIVATE_CHANNEL = 2;

const statusRank = new Map([
  ["failed", 0],
  ["waiting", 1],
  ["working", 2],
  ["planning", 3],
  ["review", 4],
  ["starting", 5],
  ["idle", 6],
  ["done", 7],
  ["offline", 8],
]);

function cleanInline(value, limit = 240) {
  const withoutControls = [...String(value ?? "")]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127 ? " " : character;
    })
    .join("");
  const normalized = withoutControls
    .replace(/\s+/g, " ")
    .replace(/@/g, "@\u200b")
    .replace(/`/g, "\u02cb")
    .trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function parseCompanyTime(value) {
  if (!value) return Number.NaN;
  const normalized = /(?:Z|[+-]\d\d:\d\d)$/i.test(value) ? value : `${value}Z`;
  return Date.parse(normalized);
}

function heartbeatLabel(heartbeatAt, generatedAt, staleAfterMs = DEFAULT_STALE_AFTER_MS) {
  if (!heartbeatAt) return "no heartbeat";
  const heartbeat = parseCompanyTime(heartbeatAt);
  const generated = parseCompanyTime(generatedAt);
  if (!Number.isFinite(heartbeat) || !Number.isFinite(generated)) return "heartbeat unavailable";
  const label = new Date(heartbeat).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  return generated - heartbeat > staleAfterMs ? `${label} (stale)` : label;
}

function safeReply(content) {
  const bounded = content.length <= DISCORD_MESSAGE_LIMIT
    ? content
    : `${content.slice(0, SAFE_MESSAGE_LIMIT).trimEnd()}\n…report truncated`;
  return { content: bounded, allowedMentions: { parse: [] } };
}

function employeeLine(employee, generatedAt) {
  const task = employee.currentTask?.title ? cleanInline(employee.currentTask.title, 80) : "available";
  const run = employee.latestRun
    ? `${cleanInline(employee.latestRun.status, 24)} · ${cleanInline(employee.latestRun.lastEvent || "no executor event", 100)} · ${heartbeatLabel(employee.latestRun.heartbeatAt, generatedAt)}`
    : "no recorded run";
  return `• **${cleanInline(employee.name, 50)}** — ${cleanInline(employee.status, 24)} / ${cleanInline(employee.runtimeStatus, 24)} — ${task}\n  ${run}`;
}

export function formatCompanyReport(snapshot) {
  const taskCounts = snapshot.tasks ?? {};
  const employees = [...(snapshot.employees ?? [])].sort((left, right) => {
    const rank = (statusRank.get(left.status) ?? 99) - (statusRank.get(right.status) ?? 99);
    return rank || String(left.name).localeCompare(String(right.name));
  });
  const header = [
    "**Company status**",
    `Tasks — inbox **${Number(taskCounts.queued) || 0}** · working **${Number(taskCounts.working) || 0}** · review **${Number(taskCounts.review) || 0}** · done **${Number(taskCounts.done) || 0}**`,
    `Aurelia — ${cleanInline(snapshot.integrationEmployee?.status || "unknown", 24)} / ${cleanInline(snapshot.integrationEmployee?.runtimeStatus || "unknown", 24)}`,
  ];
  const lines = [];
  let omitted = 0;
  for (const employee of employees) {
    const candidate = employeeLine(employee, snapshot.generatedAt);
    const projected = [...header, "", ...lines, candidate].join("\n");
    if (projected.length > SAFE_MESSAGE_LIMIT) {
      omitted += 1;
      continue;
    }
    lines.push(candidate);
  }
  if (omitted) lines.push(`_And ${omitted} more ${omitted === 1 ? "employee" : "employees"}; use /employee for details._`);
  return safeReply([...header, "", ...lines].join("\n"));
}

function findEmployee(employees, query) {
  const wanted = String(query ?? "").trim().toLocaleLowerCase();
  if (!wanted) return { employee: null, ambiguous: [] };
  const exact = employees.find((employee) => employee.id.toLocaleLowerCase() === wanted || employee.name.toLocaleLowerCase() === wanted);
  if (exact) return { employee: exact, ambiguous: [] };
  const partial = employees.filter((employee) => employee.name.toLocaleLowerCase().includes(wanted));
  return partial.length === 1 ? { employee: partial[0], ambiguous: [] } : { employee: null, ambiguous: partial };
}

export function formatEmployeeReport(snapshot, query) {
  const { employee, ambiguous } = findEmployee(snapshot.employees ?? [], query);
  if (!employee) {
    const detail = ambiguous.length
      ? `More than one employee matched: ${ambiguous.map((item) => cleanInline(item.name, 40)).join(", ")}.`
      : `No employee matched “${cleanInline(query, 80)}”.`;
    return safeReply(`**Employee status unavailable**\n${detail}`);
  }

  const task = employee.currentTask;
  const run = employee.latestRun;
  const sections = [
    `**${cleanInline(employee.name, 60)} — ${cleanInline(employee.role, 80)}**`,
    `Employee **${cleanInline(employee.status, 24)}** · Docker **${cleanInline(employee.runtimeStatus, 24)}**`,
    task
      ? `Current job: **${cleanInline(task.title, 120)}** (${cleanInline(task.status, 24)})`
      : "Current job: available",
  ];
  if (run) {
    sections.push(
      `Run: **${cleanInline(run.status, 24)}** · heartbeat ${heartbeatLabel(run.heartbeatAt, snapshot.generatedAt)}`,
      `Latest evidence: ${cleanInline(run.lastEvent || "No executor event recorded.", 500)}`,
    );
    if (run.error) sections.push(`Blocker: ${cleanInline(run.error, 500)}`);
  } else {
    sections.push("Run: no recorded execution");
  }
  return safeReply(sections.join("\n"));
}

export function isDiscordStatusSnapshot(value) {
  return Boolean(
    value
    && value.schemaVersion === "1"
    && typeof value.generatedAt === "string"
    && value.integrationEmployee
    && typeof value.integrationEmployee.id === "string"
    && typeof value.integrationEmployee.name === "string"
    && value.tasks
    && Array.isArray(value.employees),
  );
}

export function isAdapterRuntimeHealthy({
  discordReady,
  lastStatusSuccessAt,
  now = Date.now(),
  maxStatusAgeMs = 15_000,
}) {
  const age = now - lastStatusSuccessAt;
  return discordReady === true
    && Number.isFinite(lastStatusSuccessAt)
    && lastStatusSuccessAt > 0
    && Number.isFinite(now)
    && Number.isFinite(maxStatusAgeMs)
    && maxStatusAgeMs > 0
    && age >= 0
    && age <= maxStatusAgeMs;
}

export function isAuthorizedDiscordOwner(userId, authorizingOwnerId, configuredOwnerId) {
  return Boolean(configuredOwnerId && userId === configuredOwnerId && authorizingOwnerId === configuredOwnerId);
}

export function discordCommandDefinitions() {
  return [
    {
      type: 1,
      name: "company",
      description: "Show the current company status from the portal record.",
      integration_types: [USER_INSTALL],
      contexts: [BOT_DM, PRIVATE_CHANNEL],
    },
    {
      type: 1,
      name: "employee",
      description: "Show current work and executor evidence for one employee.",
      integration_types: [USER_INSTALL],
      contexts: [BOT_DM, PRIVATE_CHANNEL],
      options: [{
        type: 3,
        name: "employee",
        description: "Employee name or company employee ID",
        max_length: 80,
        required: true,
      }],
    },
  ];
}
