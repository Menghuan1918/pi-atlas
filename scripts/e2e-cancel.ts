/**
 * E2E: cancel_task — start a long-running subagent, cancel it mid-stream.
 * Run: npx tsx scripts/e2e-cancel.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { taskManager } from "../packages/base/extensions/task/index.js";
import { getAgentSessionDir } from "pi-atlas-shared/atlas-paths.js";

let pass = 0, fail = 0;
function assert(c: unknown, m: string) { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.error(`  ✗ ${m}`); } }

const atlasDir = mkdtempSync(join(tmpdir(), "pi-atlas-cancel-"));
process.env.PI_ATLAS_DIR = atlasDir;
const sessionId = "e2e-cancel";
const sessionDir = getAgentSessionDir(sessionId);
taskManager.setSessionDepth(sessionId, 0);

const savedArgv1 = process.argv[1];
process.argv[1] = "/nonexistent/path/to/pi";

try {
  console.log("E2E: cancel_task (real pi RPC mode)\n");

  // Start a long-running agent task (will take a while to complete)
  const task = taskManager.createAgentTask(
    sessionId,
    "Count from 1 to 1000, one number per line. Take your time.",
    { cwd: process.cwd(), sessionDir, depth: 0 },
  );
  console.log(`  task ${task.id} started`);

  // Wait a bit for the agent to start streaming
  await new Promise((r) => setTimeout(r, 5000));
  assert(taskManager.getTask(sessionId, task.id)!.status === "running", "task is running before cancel");

  // Cancel it
  console.log("  cancelling...");
  const cancelled = await taskManager.cancel(sessionId, task.id);
  assert(cancelled.status === "cancelled", `task cancelled (got ${cancelled.status})`);

  // Verify no orphaned process
  const proc = (taskManager as any).processes.get(task.id);
  assert(!proc, "process removed from processes map");

  // Verify awaitTasks returns immediately with cancelled status
  const { results } = await taskManager.awaitTasks(sessionId, [task.id], 5000);
  assert(results[0]?.status === "cancelled", `awaitTasks returns cancelled (got ${results[0]?.status})`);
} finally {
  process.argv[1] = savedArgv1;
  rmSync(atlasDir, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
