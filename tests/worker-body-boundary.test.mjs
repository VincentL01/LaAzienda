import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { incidentRequestContext } from "../lib/system-incident-policy.ts";

test("worker incident context never consumes an oversized or slow request body", async () => {
  let controller;
  let pulls = 0;
  const body = new ReadableStream({
    start(streamController) {
      controller = streamController;
    },
    pull() {
      pulls += 1;
      return new Promise(() => {});
    },
  });
  const request = new Request("https://company.test/api/executor", {
    method: "POST",
    headers: {
      "content-length": "999999999",
      "content-type": "application/json",
      "x-company-run-id": "run-c273b194-11ac-4cc2-9c8b-71068481cf4d",
      "x-runtime-bridge-token": "trusted-bridge-token",
    },
    body,
    duplex: "half",
  });
  await new Promise((resolve) => setImmediate(resolve));
  const baselinePulls = pulls;

  const context = incidentRequestContext(request, "trusted-bridge-token");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(context, {
    method: "POST",
    pathname: "/api/executor",
    runId: "run-c273b194-11ac-4cc2-9c8b-71068481cf4d",
  });
  assert.equal(request.bodyUsed, false);
  assert.equal(pulls, baselinePulls);
  controller.close();
});

test("worker incident run linkage requires the configured bridge credential and a bounded header", () => {
  const request = new Request("https://company.test/api/executor", {
    method: "POST",
    headers: {
      "x-company-run-id": "run-c273b194-11ac-4cc2-9c8b-71068481cf4d",
      "x-runtime-bridge-token": "wrong-token",
    },
  });
  assert.equal(incidentRequestContext(request, "trusted-bridge-token").runId, null);
  assert.equal(incidentRequestContext(request).runId, null);

  const oversized = new Request("https://company.test/api/executor", {
    method: "POST",
    headers: {
      "x-company-run-id": `run-${"a".repeat(121)}`,
      "x-runtime-bridge-token": "trusted-bridge-token",
    },
  });
  assert.equal(incidentRequestContext(oversized, "trusted-bridge-token").runId, null);
});

test("worker wrapper captures bounded metadata without cloning or parsing request bodies", async () => {
  const source = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
  const capture = source.indexOf("incidentRequestContext(request, env.RUNTIME_BRIDGE_TOKEN)");
  const dispatch = source.indexOf("handler.fetch(request, env, ctx)");
  assert.ok(capture >= 0 && dispatch > capture);
  assert.doesNotMatch(source, /request\.clone\s*\(/);
  assert.doesNotMatch(source, /request\.json\s*\(/);
  assert.doesNotMatch(source, /response\.clone\s*\(/);
  assert.match(source, /observeInternalResponse\(incidentContext, response\.status, env\)/);
});
