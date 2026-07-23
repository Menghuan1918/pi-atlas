/**
 * Quick runtime smoke test for the Task extension.
 * Run with: npx tsx scripts/test-smoke.ts
 */

import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { taskManager, TaskManager } from "../extensions/task/index.js";
import * as persistence from "../extensions/task/persistence.js";
import { createGuardHandler } from "../extensions/task/guard.js";

let pass = 0;
let fail = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.error(`  ✗ ${msg}`);
  }
}

async function main(): Promise<void> {
  // Use a temp PI_CODING_AGENT_DIR so we don't touch the real ~/.pi
  const tempDir = mkdtempSync(join(tmpdir(), "pi-atlas-test-"));
  process.env.PI_CODING_AGENT_DIR = tempDir;

  const sessionId = "test-session-1";
  const tm = new TaskManager();

  // ---- Test 1: createBashTask + await (success) ----
  console.log("\nTest 1: createBashTask + await (exit 0)");
  {
    const task = tm.createBashTask(sessionId, "echo 'hello world'", process.cwd());
    assert(task.status === "running", "task starts as running");
    assert(task.type === "bash", "task type is bash");
    assert(task.id.length === 8, "task id is 8 chars");
    assert(task.depth === 0, "task depth is 0");

    const { results, timedOut } = await tm.awaitTasks(sessionId, [task.id], 10000);
    assert(!timedOut, "did not time out");
    assert(results.length === 1, "one result");
    assert(results[0].status === "completed", "task completed");
    assert(results[0].exitCode === 0, "exit code 0");
    assert(results[0].output.includes("hello world"), "output contains 'hello world'");
  }

  // ---- Test 2: failed task (non-zero exit) ----
  console.log("\nTest 2: failed task (exit 1)");
  {
    const task = tm.createBashTask(sessionId, "echo 'error output' >&2 && exit 1", process.cwd());
    const { results } = await tm.awaitTasks(sessionId, [task.id], 10000);
    assert(results[0].status === "failed", "task failed");
    assert(results[0].exitCode === 1, "exit code 1");
    assert(results[0].output.includes("error output"), "stderr captured");
  }

  // ---- Test 3: watchTask on running task ----
  console.log("\nTest 3: watchTask live snapshot");
  {
    const task = tm.createBashTask(sessionId, "sleep 0.3 && echo 'done watching'", process.cwd());
    // Give it a moment to start
    await new Promise((r) => setTimeout(r, 50));
    const watch = tm.watchTask(sessionId, task.id);
    assert(watch.status === "running", "watch shows running");
    await tm.awaitTasks(sessionId, [task.id], 10000);
    const watch2 = tm.watchTask(sessionId, task.id);
    assert(watch2.status === "completed", "watch shows completed after await");
    assert(watch2.output.includes("done watching"), "watch output correct");
  }

  // ---- Test 4: cancel a running task ----
  console.log("\nTest 4: cancel running task");
  {
    const task = tm.createBashTask(sessionId, "sleep 30", process.cwd());
    await new Promise((r) => setTimeout(r, 100));
    const cancelled = await tm.cancel(sessionId, task.id);
    assert(cancelled.status === "cancelled", "task is cancelled");
    assert(cancelled.exitCode !== undefined, "exit code is set");
  }

  // ---- Test 5: timeout ----
  console.log("\nTest 5: task timeout");
  {
    const task = tm.createBashTask(sessionId, "sleep 30", process.cwd(), undefined, 1); // 1s timeout
    const { results } = await tm.awaitTasks(sessionId, [task.id], 10000);
    assert(results[0].status === "failed", "timed-out task is failed");
    assert(results[0].exitCode === 124, "timeout exit code 124");
  }

  // ---- Test 6: await all running ----
  console.log("\nTest 6: await all running tasks");
  {
    tm.createBashTask(sessionId, "echo 'task1'", process.cwd());
    tm.createBashTask(sessionId, "echo 'task2'", process.cwd());
    const { results } = await tm.awaitTasks(sessionId, undefined, 10000);
    assert(results.length === 2, "two results");
    assert(results.every((r) => r.status === "completed"), "all completed");
  }

  // ---- Test 7: persistence ----
  console.log("\nTest 7: persistence");
  {
    const task = tm.createBashTask(sessionId, "echo 'persist me'", process.cwd());
    await tm.awaitTasks(sessionId, [task.id], 10000);

    // Verify tasks.json exists and contains the task
    const tasksDir = persistence.getTasksDir(sessionId);
    const tasksFile = join(tasksDir, "tasks.json");
    assert(existsSync(tasksFile), "tasks.json exists");

    const outputDir = join(tasksDir, `output-${task.id}.log`);
    assert(existsSync(outputDir), "output file exists");

    const saved = JSON.parse(readFileSync(tasksFile, "utf-8"));
    assert(Array.isArray(saved.tasks), "tasks.json has tasks array");
    assert(saved.tasks.some((t: { id: string }) => t.id === task.id), "task is persisted");
    assert(saved.tasks.some((t: { id: string; status: string }) => t.id === task.id && t.status === "completed"), "persisted task is completed");

    const fullOutput = readFileSync(outputDir, "utf-8");
    assert(fullOutput.includes("persist me"), "full output persisted");
  }

  // ---- Test 8: restoreSession (orphaned) ----
  console.log("\nTest 8: restoreSession marks running as orphaned");
  {
    const restoreSession = "restore-test";
    const task = tm.createBashTask(restoreSession, "sleep 30", process.cwd());
    assert(task.status === "running", "task is running before restore");

    // Wait for the fire-and-forget persistence save to complete
    await new Promise((r) => setTimeout(r, 150));

    // Simulate restart: create a fresh manager and restore
    const tm2 = new TaskManager();
    const restored = await tm2.restoreSession(restoreSession);
    const restoredTask = restored.find((t) => t.id === task.id);
    assert(restoredTask !== undefined, "task restored from disk");
    assert(restoredTask!.status === "orphaned", "running task marked as orphaned");

    // Clean up: cancel the still-running process
    await tm.cancel(restoreSession, task.id);
  }

  // ---- Test 8b: restoreSession with corrupt JSON (data preservation) ----
  console.log("\nTest 8b: restoreSession preserves corrupt tasks.json");
  {
    const corruptSession = "corrupt-test";
    const tasksDir = persistence.getTasksDir(corruptSession);
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(tasksDir, { recursive: true });
    const tasksFile = join(tasksDir, "tasks.json");
    const corruptContent = '{"tasks": [broken json';
    writeFileSync(tasksFile, corruptContent);

    // restoreSession should return [] without overwriting the file
    const tm3 = new TaskManager();
    const restored = await tm3.restoreSession(corruptSession);
    assert(restored.length === 0, "corrupt JSON returns empty list");
    // File content must be preserved (not overwritten)
    const afterContent = readFileSync(tasksFile, "utf-8");
    assert(afterContent === corruptContent, "corrupt file preserved (not overwritten)");
  }

  // ---- Test 8c: restoreSession with invalid schema (tasks not array) ----
  console.log("\nTest 8c: restoreSession preserves invalid-schema tasks.json");
  {
    const schemaSession = "schema-test";
    const tasksDir = persistence.getTasksDir(schemaSession);
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(tasksDir, { recursive: true });
    const tasksFile = join(tasksDir, "tasks.json");
    const invalidContent = '{"sessionId": "schema-test", "tasks": null}';
    writeFileSync(tasksFile, invalidContent);

    const tm4 = new TaskManager();
    const restored = await tm4.restoreSession(schemaSession);
    assert(restored.length === 0, "invalid schema returns empty list");
    const afterContent = readFileSync(tasksFile, "utf-8");
    assert(afterContent === invalidContent, "invalid-schema file preserved (not overwritten)");
  }

  // ---- Test 8d: restoreSession ENOENT (new session) ----
  console.log("\nTest 8d: loadTasks returns [] for ENOENT, restoreSession returns []");
  {
    const newSession = "enoent-test";
    // Directly test loadTasks ENOENT path (not through restoreSession which catches all)
    const direct = await persistence.loadTasks(newSession);
    assert(Array.isArray(direct) && direct.length === 0, "loadTasks ENOENT returns empty array directly");
    // Also verify restoreSession returns [] without error
    const tm5 = new TaskManager();
    const restored = await tm5.restoreSession(newSession);
    assert(restored.length === 0, "restoreSession ENOENT returns empty list (no error)");
  }

  // ---- Test 9: guard handler ----
  console.log("\nTest 9: guard handler");
  {
    const guardSession = "guard-test";
    let injectedMessage: string | null = null;
    const fakePi = {
      sendUserMessage: (msg: string) => {
        injectedMessage = msg;
      },
    } as any;

    const handler = createGuardHandler(fakePi);

    // No running tasks → no injection
    handler({ type: "agent_settled" }, { sessionManager: { getSessionId: () => guardSession } } as any);
    assert(injectedMessage === null, "no injection when no running tasks");

    // Create a running task using the singleton (the guard handler uses it)
    const task = taskManager.createBashTask(guardSession, "sleep 5", process.cwd());
    handler({ type: "agent_settled" }, { sessionManager: { getSessionId: () => guardSession } } as any);
    assert(injectedMessage !== null, "injected message when tasks running");
    assert(injectedMessage!.includes(task.id), "injected message contains task id");
    assert(injectedMessage!.includes("AwaitTask"), "injected message mentions AwaitTask");

    await taskManager.cancel(guardSession, task.id);
  }

  // ---- Test 10: listTasks ----
  console.log("\nTest 10: listTasks");
  {
    const listSession = "list-test";
    tm.createBashTask(listSession, "echo 'a'", process.cwd());
    tm.createBashTask(listSession, "echo 'b'", process.cwd());
    const tasks = tm.listTasks(listSession);
    assert(tasks.length === 2, "listTasks returns 2 tasks");
    await tm.cancelAll(listSession);
  }

  // ---- Cleanup ----
  rmSync(tempDir, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test error:", err);
  process.exit(1);
});
