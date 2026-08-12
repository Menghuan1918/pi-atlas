/**
 * E2E: Nested subagent — a subagent that creates its own subagent.
 * Run: npx tsx scripts/e2e-nested.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { taskManager } from "../packages/base/extensions/task/index.js";
import { getAtlasSessionDir } from "pi-atlas-shared/atlas-paths.js";

let pass = 0, fail = 0;
function assert(c: unknown, m: string) { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.error(`  ✗ ${m}`); } }

const atlasDir = mkdtempSync(join(tmpdir(), "pi-atlas-nested-"));
process.env.PI_ATLAS_DIR = atlasDir;
const sessionId = "e2e-nested";
const sessionDir = getAtlasSessionDir(sessionId);
taskManager.setSessionDepth(sessionId, 0);

const savedArgv1 = process.argv[1];
process.argv[1] = "/nonexistent/path/to/pi";

try {
  console.log("E2E: Nested subagent (depth 0 → 1)\n");

  // The prompt instructs the subagent to use create_agent to spawn a nested subagent.
  const task = taskManager.createAgentTask(
    sessionId,
    "Use the create_agent tool to create a nested agent with the prompt: " +
    "'Reply with exactly: NESTED_DEEP_RESULT'. " +
    "Then use await_task to wait for it. " +
    "Finally, reply with the nested agent's output prefixed with PARENT_GOT_: " +
    "for example, if the nested agent said FOO, reply with PARENT_GOT_FOO.",
    { cwd: process.cwd(), sessionDir, depth: 0 },
  );
  console.log(`  parent task ${task.id} started (depth 0)`);

  const { results, timedOut } = await taskManager.awaitTasks(sessionId, [task.id], 300_000);
  assert(!timedOut, "parent did not time out");
  assert(results[0]?.status === "completed", `parent completed (got ${results[0]?.status})`);

  console.log(`  parent output: ${JSON.stringify(results[0]?.output)}`);
  assert(
    results[0]?.output?.includes("PARENT_GOT_NESTED_DEEP_RESULT"),
    "parent output includes nested result",
  );

  // Note: nested tasks live in the sub-agent's own process (separate
  // taskManager instance), so the parent can't see them. We verify success
  // solely via the parent's output, which includes the nested result.
  console.log("  (nested tasks are in the sub-agent's own process — verified via parent output)");
} finally {
  process.argv[1] = savedArgv1;
  rmSync(atlasDir, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
