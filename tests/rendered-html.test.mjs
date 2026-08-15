import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${pathname}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the company control room shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>One Man Company/);
  assert.match(html, /ONE MAN/);
  assert.match(html, /COMPANY/);
  assert.match(html, /Waking the company/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("server-renders company, employee, and Training Center shells", async () => {
  const [companyResponse, employeesResponse, trainingResponse] = await Promise.all([
    render("/company"), render("/employees"), render("/training"),
  ]);
  assert.equal(companyResponse.status, 200);
  assert.equal(employeesResponse.status, 200);
  assert.equal(trainingResponse.status, 200);
  assert.match(await companyResponse.text(), /Opening the company mailroom/);
  assert.match(await employeesResponse.text(), /Opening personnel files/);
  assert.match(await trainingResponse.text(), /Unlocking the Training Center/);
});

test("keeps runtime, credential, and mail boundaries explicit", async () => {
  const [page, layout, packageJson, hosting, gitignore, dockerfile, hrmDockerfile, hrmReconcile, runtimeBridge, mailCompose, mailBridge] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
    readFile(new URL("../.gitignore", import.meta.url), "utf8"),
    readFile(new URL("../runtime/agent/Dockerfile", import.meta.url), "utf8"),
    readFile(new URL("../runtime/hrm/Dockerfile", import.meta.url), "utf8"),
    readFile(new URL("../runtime/hrm/reconcile.sh", import.meta.url), "utf8"),
    readFile(new URL("../runtime/bridge.ps1", import.meta.url), "utf8"),
    readFile(new URL("../infrastructure/mail/compose.yml", import.meta.url), "utf8"),
    readFile(new URL("../infrastructure/mail/bridge.ps1", import.meta.url), "utf8"),
  ]);

  assert.match(page, /CompanyDashboard/);
  assert.match(layout, /One Man Company/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.match(hosting, /"d1": "DB"/);
  assert.match(hosting, /"r2": "CHARACTERS"/);
  assert.match(gitignore, /assets\/agent_auth\/auth\.json/);
  assert.match(gitignore, /assets\/github_auth\/token/);
  assert.doesNotMatch(dockerfile, /auth\.json|agent_auth/i);
  assert.doesNotMatch(dockerfile, /docker.sock|\/usr\/local\/bin\/docker/);
  assert.match(dockerfile, /@openai\/codex/);
  assert.match(hrmDockerfile, /FROM one-man-company\/codex-employee:local/);
  assert.match(hrmDockerfile, /docker:28-cli/);
  assert.match(hrmReconcile, /dockerSocketAccess == true/);
  assert.match(hrmReconcile, /Docker state observed and reported by the HR Manager/);
  assert.match(runtimeBridge, /employee-hrm/);
  assert.doesNotMatch(runtimeBridge, /foreach \(\$employee in \$workforce\.employees\)/);
  assert.match(mailCompose, /stalwartlabs\/stalwart:v0\.16/);
  assert.match(mailCompose, /127\.0\.0\.1:2525:25/);
  assert.match(mailBridge, /reportDelivery/);
  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
});
