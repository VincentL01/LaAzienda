import { env } from "cloudflare:workers";
import { ensureDatabase } from "@/db/ensure";

const TOKEN_DOMAIN = "one-man-company:discord-status:v1\u0000";

type IntegrationEnvironment = {
  DB: D1Database;
  DISCORD_STATUS_TOKEN?: string;
  RUNTIME_BRIDGE_TOKEN?: string;
};

type StatusEmployeeRow = {
  id: string;
  name: string;
  role: string;
  status: string;
  runtimeStatus: string;
  currentTaskId: string | null;
  currentTaskTitle: string | null;
  currentTaskStatus: string | null;
  latestRunId: string | null;
  latestRunStatus: string | null;
  latestRunEvent: string | null;
  latestRunHeartbeatAt: string | null;
  latestRunError: string | null;
};

async function digest(value: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function derivedStatusToken(source: string) {
  const bytes = await digest(`${TOKEN_DOMAIN}${source}`);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function configuredStatusToken() {
  const bindings = env as unknown as IntegrationEnvironment;
  const dedicated = bindings.DISCORD_STATUS_TOKEN?.trim();
  if (dedicated && dedicated.length >= 32) return dedicated;
  const runtimeSource = bindings.RUNTIME_BRIDGE_TOKEN?.trim();
  return runtimeSource && runtimeSource.length >= 32 ? derivedStatusToken(runtimeSource) : null;
}

async function constantTimeEqual(left: string, right: string) {
  const [leftDigest, rightDigest] = await Promise.all([digest(left), digest(right)]);
  let difference = leftDigest.length ^ rightDigest.length;
  for (let index = 0; index < Math.max(leftDigest.length, rightDigest.length); index += 1) {
    difference |= (leftDigest[index] ?? 0) ^ (rightDigest[index] ?? 0);
  }
  return difference === 0;
}

async function authorized(request: Request) {
  const expected = await configuredStatusToken();
  if (!expected) return null;
  const header = request.headers.get("authorization") ?? "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  return supplied.length >= 32 && await constantTimeEqual(supplied, expected);
}

function noStoreJson(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", vary: "authorization" },
  });
}

export async function GET(request: Request) {
  try {
    const authorization = await authorized(request);
    if (authorization === null) return noStoreJson({ error: "Discord status integration is not configured." }, 503);
    if (!authorization) return noStoreJson({ error: "Discord status authorization failed." }, 403);

    const employeeId = new URL(request.url).searchParams.get("employeeId")?.trim() ?? "";
    if (!/^employee-[A-Za-z0-9-]{1,100}$/.test(employeeId)) {
      return noStoreJson({ error: "A valid integration employee ID is required." }, 400);
    }

    await ensureDatabase();
    const bindings = env as unknown as IntegrationEnvironment;
    const [employees, taskCounts] = await Promise.all([
      bindings.DB.prepare(`SELECT employees.id, employees.name, employees.role, employees.status,
        employees.runtime_status AS runtimeStatus,
        current_task.id AS currentTaskId, current_task.title AS currentTaskTitle,
        current_task.status AS currentTaskStatus,
        latest_run.id AS latestRunId, latest_run.status AS latestRunStatus,
        latest_run.last_event AS latestRunEvent,
        latest_run.heartbeat_at AS latestRunHeartbeatAt,
        latest_run.error AS latestRunError
        FROM employees
        LEFT JOIN tasks current_task ON current_task.id = employees.current_task_id
        LEFT JOIN agent_runs latest_run ON latest_run.id = (
          SELECT candidate.id FROM agent_runs candidate
          WHERE candidate.employee_id = employees.id
          ORDER BY candidate.created_at DESC, candidate.id DESC LIMIT 1
        )
        ORDER BY employees.name`).all<StatusEmployeeRow>(),
      bindings.DB.prepare(`SELECT
        SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
        SUM(CASE WHEN status = 'working' THEN 1 ELSE 0 END) AS working,
        SUM(CASE WHEN status = 'review' THEN 1 ELSE 0 END) AS review,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
        FROM tasks`).first<{ queued: number | null; working: number | null; review: number | null; done: number | null }>(),
    ]);

    const rows = employees.results;
    const integrationEmployee = rows.find((employee) => employee.id === employeeId);
    if (!integrationEmployee) return noStoreJson({ error: "The configured integration employee was not found." }, 404);

    return noStoreJson({
      schemaVersion: "1",
      generatedAt: new Date().toISOString(),
      integrationEmployee: {
        id: integrationEmployee.id,
        name: integrationEmployee.name,
        role: integrationEmployee.role,
        status: integrationEmployee.status,
        runtimeStatus: integrationEmployee.runtimeStatus,
      },
      tasks: {
        queued: Number(taskCounts?.queued ?? 0),
        working: Number(taskCounts?.working ?? 0),
        review: Number(taskCounts?.review ?? 0),
        done: Number(taskCounts?.done ?? 0),
      },
      employees: rows.map((employee) => ({
        id: employee.id,
        name: employee.name,
        role: employee.role,
        status: employee.status,
        runtimeStatus: employee.runtimeStatus,
        currentTask: employee.currentTaskId ? {
          id: employee.currentTaskId,
          title: employee.currentTaskTitle ?? "Untitled task",
          status: employee.currentTaskStatus ?? "unknown",
        } : null,
        latestRun: employee.latestRunId ? {
          id: employee.latestRunId,
          status: employee.latestRunStatus ?? "unknown",
          lastEvent: employee.latestRunEvent ?? "",
          heartbeatAt: employee.latestRunHeartbeatAt,
          error: employee.latestRunError,
        } : null,
      })),
    });
  } catch {
    return noStoreJson({ error: "Discord status snapshot is unavailable." }, 500);
  }
}
