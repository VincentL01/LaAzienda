import assert from "node:assert/strict";
import test from "node:test";
import { findActiveTaskConflict } from "../lib/task-policy.ts";

test("blocks a second active task for the same employee", () => {
  const activeTasks = [{ id: "task-current", title: "Current delivery" }];

  assert.deepEqual(findActiveTaskConflict(activeTasks, "task-next"), activeTasks[0]);
});

test("allows the requested task when it is the only matching active task", () => {
  const activeTasks = [{ id: "task-current", title: "Current delivery" }];

  assert.equal(findActiveTaskConflict(activeTasks, "task-current"), undefined);
  assert.equal(findActiveTaskConflict([], "task-next"), undefined);
});
