import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ownerAuthorized } from "../lib/server/owner-auth.ts";
import { lockedTrainingEnvelope, trainingReadAuthorized } from "../lib/server/training-access.ts";

const routeSource = await readFile(new URL("../app/api/training/route.ts", import.meta.url), "utf8");
const bridgeSource = await readFile(new URL("../lib/server/bridge-auth.ts", import.meta.url), "utf8");
const uiSource = await readFile(new URL("../app/components/TrainingCenter.tsx", import.meta.url), "utf8");

function exportedHandler(source, name, nextName) {
  const start = source.indexOf(`export async function ${name}`);
  const end = nextName ? source.indexOf(`export async function ${nextName}`, start) : source.length;
  assert.notEqual(start, -1, `${name} handler must exist`);
  assert.notEqual(end, -1, `${nextName} handler must exist after ${name}`);
  return source.slice(start, end);
}

test("training read policy requires an owner or runtime bridge principal", () => {
  assert.equal(trainingReadAuthorized({ owner: false, bridge: false }), false);
  assert.equal(trainingReadAuthorized({ owner: true, bridge: false }), true);
  assert.equal(trainingReadAuthorized({ owner: false, bridge: true }), true);
  assert.equal(trainingReadAuthorized({ owner: true, bridge: true }), true);

  assert.equal(Object.isFrozen(lockedTrainingEnvelope), true);
  assert.deepEqual(lockedTrainingEnvelope, {
    locked: true,
    error: "Training Center records are locked. Unlock CEO controls to continue.",
  });
});

test("localhost and same-network addresses alone cannot authorize a training read", async () => {
  const configuredCredential = "independent-owner-credential-long-enough-123456789";
  for (const url of [
    "http://localhost:3002/api/training",
    "http://127.0.0.1:3002/api/training",
    "http://192.168.1.27:3002/api/training",
  ]) {
    const owner = await ownerAuthorized(new Request(url), configuredCredential);
    assert.equal(owner, false, `${url} must not authorize an owner without the cookie`);
    assert.equal(trainingReadAuthorized({ owner, bridge: false }), false);
  }
});

test("training GET denies before database initialization and record reads", () => {
  const get = exportedHandler(routeSource, "GET", "POST");
  const bridgeCheck = get.indexOf("bridgeAuthorized(request)");
  const ownerCheck = get.indexOf("await ownerAuthorized(request)");
  const policyCheck = get.indexOf("trainingReadAuthorized(");
  const denial = get.indexOf("return Response.json(lockedTrainingEnvelope, { status: 403 })");
  const ensure = get.indexOf("await ensureDatabase()");
  const read = get.indexOf("await readTraining(request)");

  for (const [label, index] of Object.entries({ bridgeCheck, ownerCheck, policyCheck, denial, ensure, read })) {
    assert.notEqual(index, -1, `${label} must remain explicit in GET`);
  }
  assert.ok(bridgeCheck < policyCheck, "bridge authorization must be evaluated before the policy gate");
  assert.ok(ownerCheck < policyCheck, "owner authorization must be evaluated before the policy gate");
  assert.ok(policyCheck < denial, "the denied response must be controlled by the read policy");
  assert.ok(denial < ensure, "denial must occur before D1 initialization");
  assert.ok(denial < read, "denial must occur before any training records are read");
  assert.doesNotMatch(get, /hostname|localhost|127\.0\.0\.1|192\.168\.|origin|referer/i);
});

test("runtime bridge authorization is credential-based rather than network-based", () => {
  assert.match(bridgeSource, /Boolean\(configured\s*&&\s*supplied\s*===\s*configured\)/);
  assert.doesNotMatch(bridgeSource, /hostname|localhost|127\.0\.0\.1|192\.168\.|origin|referer/i);
});

test("the Training Center replaces records with an actionable owner-session lock", () => {
  assert.match(uiSource, /response\.status === 403 && data\.locked/);
  assert.match(uiSource, /setTraining\(null\);\s*setLocked\(true\)/);
  assert.match(uiSource, /fetch\("\/api\/owner-session",\s*\{\s*method: "POST"/);
  assert.match(uiSource, /if \(!training && locked\)[\s\S]*?\{ownerUnlockPanel\}/);
  assert.match(uiSource, /Company training records remain hidden until the CEO owner session is unlocked\./);
});
