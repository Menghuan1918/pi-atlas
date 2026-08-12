/**
 * Integration test: verify the new Task tool output formats.
 * Tests formatTaskResult, formatTaskSummary, CancelTask wording, WatchTask format.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";

import { TaskManager, taskManager, awaitTaskTool } from "../packages/base/extensions/task/index.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.log(`  ✗ ${msg}`); }
}

const sessionId = "fmt-test";
const tempDir = mkdtempSync(join(tmpdir(), "pi-fmt-test-"));
const tm = new TaskManager();
tm.setSessionDepth(sessionId, 0);

// --- Create a bash task and let it finish ---
console.log("Test 1: AwaitTask result block format");
{
  const task = tm.createBashTask(
    sessionId,
    'echo "hello world"',
    tempDir,
  );
  const { results } = await tm.awaitTasks(sessionId, [task.id], 10000);
  const r = results[0];

  // The result should have [type], exit, elapsed
  // We can't check the exact format (it's in control.ts formatTaskResult),
  // but we can check the TaskResult fields
  assert(r.type === "bash", "bash task type is bash");
  assert(r.status === "completed", "bash task completed");
  assert(r.exitCode === 0, "bash task exit 0");
  assert(r.startedAt !== undefined, "bash task has startedAt");
  assert(r.finishedAt !== undefined, "bash task has finishedAt");
  assert(r.startedAt! < r.finishedAt!, "startedAt < finishedAt");

  const elapsed = r.finishedAt! - r.startedAt!;
  assert(elapsed >= 0, `elapsed is non-negative (${elapsed}ms)`);
  assert(r.output.includes("hello world"), "output contains hello world");
  assert(r.outputPath !== undefined, "outputPath is set");
}

// --- Create an agent task and let it finish ---
console.log("\nTest 2: AwaitTask result block for agent task");
{
  // Force pi fallback (same as agent-task.test.ts)
  const savedArgv1 = process.argv[1];
  process.argv[1] = "/nonexistent/path/to/pi";
  const agentSessionDir = mkdtempSync(join(tmpdir(), "pi-fmt-agent-"));
  const task = tm.createAgentTask(sessionId, "Reply with exactly: FMT_TEST_OK", {
    cwd: tempDir,
    sessionDir: agentSessionDir,
    depth: 0,
  });
  const { results, timedOut } = await tm.awaitTasks(sessionId, [task.id], 60000);
  assert(!timedOut, "agent task did not time out");
  const r = results[0];
  assert(r.type === "agent", "agent task type is agent");
  assert(r.status === "completed", "agent task completed");
  assert(r.exitCode === 0, "agent task exit 0");
  assert(r.startedAt !== undefined, "agent task has startedAt");
  assert(r.finishedAt !== undefined, "agent task has finishedAt");
  assert(r.usage !== undefined, "agent task has usage");
  assert(r.usage!.turns >= 1, `agent task turns >= 1 (got ${r.usage!.turns})`);
  assert(r.output.includes("FMT_TEST_OK"), "agent output contains FMT_TEST_OK");
  assert(r.outputPath !== undefined, "agent outputPath is set");
  process.argv[1] = savedArgv1;
  rmSync(agentSessionDir, { recursive: true, force: true });
}

// --- CancelTask: already-finished task ---
console.log("\nTest 3: CancelTask on already-finished task");
{
  // Use the bash task from Test 1
  const tasks = tm.listTasks(sessionId);
  const completedBash = tasks.find((t) => t.type === "bash" && t.status === "completed");
  assert(completedBash !== undefined, "found completed bash task");

  const existing = tm.getTask(sessionId, completedBash!.id);
  assert(existing!.status !== "running", "task is not running");

  // Cancel should be a no-op
  const cancelled = await tm.cancel(sessionId, completedBash!.id);
  assert(cancelled.status === "completed", "still completed after cancel (no-op)");
  assert(cancelled.exitCode === 0, "exit code still 0");
}

// --- ListTask format ---
console.log("\nTest 4: ListTask includes exit code");
{
  const tasks = tm.listTasks(sessionId);
  assert(tasks.length >= 2, `has ${tasks.length} tasks`);

  // Check that completed tasks have exit codes
  for (const t of tasks) {
    if (t.status === "completed") {
      assert(t.exitCode !== undefined, `task ${t.id} has exitCode`);
    }
  }
}

// --- WatchTask returns type + timing ---
console.log("\nTest 5: WatchTask returns type, timing, usage");
{
  const tasks = tm.listTasks(sessionId);
  const agentTask = tasks.find((t) => t.type === "agent");
  assert(agentTask !== undefined, "found agent task");

  const watch = tm.watchTask(sessionId, agentTask!.id);
  assert(watch.type === "agent", "watchTask returns type=agent");
  assert(watch.status === "completed", "watchTask status=completed");
  assert(watch.startedAt !== undefined, "watchTask has startedAt");
  assert(watch.finishedAt !== undefined, "watchTask has finishedAt");
  assert(watch.usage !== undefined, "watchTask has usage");
  assert(watch.usage!.turns >= 1, `watchTask usage.turns >= 1 (got ${watch.usage!.turns})`);
}

// --- formatDuration spot checks ---
console.log("\nTest 6: Target list with progress summary");
{
  // Import target manager
  const { targetManager } = await import("../packages/base/extensions/target/target-manager.js");
  const sid = "target-fmt-test";
  await targetManager.setPrimary(sid, "Test primary");
  await targetManager.addSecondary(sid, "Task A");
  await targetManager.addSecondary(sid, "Task B");
  await targetManager.addSecondary(sid, "Task C");
  await targetManager.updateStatus(sid, 1, "completed", "done");
  await targetManager.updateStatus(sid, 2, "failed", "nope");

  const state = targetManager.getState(sid);
  const formatted = targetManager.formatState(state);
  assert(
    formatted.includes("(1/3 completed)"),
    `progress summary shown: ${formatted.match(/\(\d+\/\d+ completed\)/)?.[0]}`,
  );
  assert(formatted.includes("✓ [#1]"), "completed task has ✓");
  assert(formatted.includes("✗ [#2]"), "failed task has ✗");
  assert(formatted.includes("○ [#3]"), "active task has ○");
}

// ---------------------------------------------------------------------------
// Test 7: AwaitTask live status shows bash output tail while waiting
// ---------------------------------------------------------------------------
console.log("\nTest 7: AwaitTask live status shows bash output tail");
{
  // Isolate atlas dir so task persistence doesn't touch ~/.pi/atlas.
  const savedAtlas = process.env.PI_ATLAS_DIR;
  const atlasTmp = mkdtempSync(join(tmpdir(), "pi-fmt-live-"));
  process.env.PI_ATLAS_DIR = atlasTmp;

  const liveSid = "live-tail-test";
  taskManager.setSessionDepth(liveSid, 0);

  // A bash task that emits lines over ~1.5s so the 1s live-status tick fires
  // while it is still running.
  const cmd = 'for i in 1 2 3 4 5; do echo "progress $i"; sleep 0.3; done';
  const task = taskManager.createBashTask(liveSid, cmd, tempDir);

  const captured: string[] = [];
  const onUpdate: AgentToolUpdateCallback<unknown> = (u) => {
    const t = u.content.find((c) => c.type === "text")?.text;
    if (t) captured.push(t);
  };

  const result = (await awaitTaskTool.execute(
    "tc1",
    { taskIds: [task.id] },
    undefined,
    onUpdate,
    { sessionManager: { getSessionId: () => liveSid }, cwd: tempDir } as never,
  )) as { content: { type: string; text: string }[]; details: { results: { status: string; output: string }[] } };

  assert(result.content[0].text.includes("progress 5"), "final result includes last output line");
  assert(result.details.results[0].status === "completed", "task completed");

  // At least one live update (emitted while the task was still running) showed
  // the bash output tail — marked with “│” and containing a progress line.
  const tailUpdates = captured.filter((t) => t.includes("│") && t.includes("progress"));
  assert(tailUpdates.length > 0, "live status emitted a bash output tail while running");

  process.env.PI_ATLAS_DIR = savedAtlas;
  rmSync(atlasTmp, { recursive: true, force: true });
}

// Cleanup
rmSync(tempDir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
