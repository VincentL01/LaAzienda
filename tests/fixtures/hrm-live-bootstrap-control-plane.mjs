import http from "node:http";

const employeeId = process.env.OMC_TEST_EMPLOYEE_ID;
const containerName = process.env.OMC_TEST_EMPLOYEE_CONTAINER;
const bridgeToken = process.env.OMC_TEST_BRIDGE_TOKEN;

if (!employeeId || !containerName || !bridgeToken) {
  throw new Error("The disposable control plane requires a complete test identity.");
}

const workforce = {
  employees: [{
    id: employeeId,
    name: "Aurora",
    role: "Company Employee",
    department: "Operations",
    status: "idle",
    petId: "d-va",
    roleProfileId: "company-employee",
    emailAddress: `${employeeId}@one-man-company.test`,
    mailboxStatus: "requested",
    employmentType: "expert",
    workspacePolicy: "persistent",
    resourceAccess: "task-scoped",
    dockerSocketAccess: false,
    handoffRequired: false,
    systemPrompt: "You are Aurora, a permanent Company Employee in this disposable reconciliation test.",
    containerName,
    desiredRuntimeStatus: "running",
    runtimeStatus: "not_provisioned",
    currentTaskId: null,
    desiredSkills: [],
    skills: [],
    assignments: [],
  }],
  skills: [],
};
const training = { desiredGeneration: 1, assignments: [] };
let requestCount = 0;

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function consumeBoundedBody(request) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 65_536) request.destroy(new Error("request body exceeded test bound"));
    });
    request.on("end", resolve);
    request.on("error", reject);
  });
}

const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/ready") {
    sendJson(response, 200, { ready: true });
    return;
  }
  requestCount += 1;
  if (requestCount > 32) {
    sendJson(response, 429, { error: "disposable request budget exhausted" });
    return;
  }
  if (request.headers["x-runtime-bridge-token"] !== bridgeToken) {
    sendJson(response, 403, { error: "forbidden" });
    return;
  }
  console.log(`${request.method} ${request.url}`);
  if (request.method === "GET" && request.url === "/api/employees") {
    sendJson(response, 200, workforce);
    return;
  }
  if (request.method === "GET" && request.url === "/api/training") {
    sendJson(response, 200, training);
    return;
  }
  if (request.method === "POST" && ["/api/employees", "/api/training", "/api/company"].includes(request.url)) {
    try {
      await consumeBoundedBody(request);
      sendJson(response, 200, { ok: true });
    } catch {
      if (!response.headersSent) sendJson(response, 413, { error: "body too large" });
    }
    return;
  }
  sendJson(response, 404, { error: "not found" });
});

server.listen(8080, "0.0.0.0");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
