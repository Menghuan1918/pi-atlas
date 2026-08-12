/**
 * E2E: Basic subagent test — real pi, real RPC mode.
 * Run: npx tsx scripts/e2e-basic.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { taskManager } from "../packages/base/extensions/task/index.js";
import { getAtlasSessionDir } from "pi-atlas-shared/atlas-paths.js";

let pass = 0, fail = 0;
function assert(c: unknown, m: string) { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.error(`  ✗ ${m}`); } }

const atlasDir = mkdtempSync(join(tmpdir(), "pi-atlas-e2e-"));
process.env.PI_ATLAS_DIR = atlasDir;
const sessionId = "e2e-basic";
const sessionDir = getAtlasSessionDir(sessionId);
taskManager.setSessionDepth(sessionId, 0);

const savedArgv1 = process.argv[1];
process.argv[1] = "/nonexistent/path/to/pi";

try {
  console.log("E2E: Basic subagent (real pi RPC mode)\n");
  const task = taskManager.createAgentTask(
    sessionId,
    "Reply with exactly: HELLO_FROM_SUBAGENT",
    { cwd: process.cwd(), sessionDir, depth: 0 },
  );
  console.log(`  task ${task.id} started`);

  const { results, timedOut } = await taskManager.awaitTasks(sessionId, [task.id], 120_000);
  assert(!timedOut, "did not time out");
  assert(results[0]?.status === "completed", `task completed (got ${results[0]?.status})`);
  console.log(`  output: ${JSON.stringify(results[0]?.output)}`);
  assert(results[0]?.output?.includes("HELLO_FROM_SUBAGENT"), "output contains expected text");

  const finalTask = taskManager.getTask(sessionId, task.id);
  assert(finalTask?.sessionFile !== undefined, "sessionFile is set");
  console.log(`  sessionFile: ${finalTask?.sessionFile}`);
  assert(finalTask?.usage?.turns !== undefined && finalTask.usage.turns >= 1, "usage.turns >= 1");
} finally {
  process.argv[1] = savedArgv1;
  rmSync(atlasDir, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
