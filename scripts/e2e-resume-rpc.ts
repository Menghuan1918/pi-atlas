/**
 * E2E: Resume subagent — create, then resume with new instruction.
 * Run: npx tsx scripts/e2e-resume-rpc.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { taskManager } from "../extensions/task/index.js";
import { resumeTaskTool } from "../extensions/task/agent-task.js";
import { getAgentSessionDir } from "../extensions/shared/atlas-paths.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

let pass = 0, fail = 0;
function assert(c: unknown, m: string) { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.error(`  ✗ ${m}`); } }

const atlasDir = mkdtempSync(join(tmpdir(), "pi-atlas-resume-"));
process.env.PI_ATLAS_DIR = atlasDir;
const sessionId = "e2e-resume";
const sessionDir = getAgentSessionDir(sessionId);
taskManager.setSessionDepth(sessionId, 0);

const savedArgv1 = process.argv[1];
process.argv[1] = "/nonexistent/path/to/pi";

const ctx = {
  sessionManager: { getSessionId: () => sessionId, getSessionDir: () => sessionDir },
  cwd: process.cwd(),
} as unknown as ExtensionContext;

try {
  console.log("E2E: Resume subagent (real pi RPC mode)\n");

  // Step 1: Create an agent that remembers a secret word.
  console.log("Step 1: create_agent — tell sub-agent a secret...");
  const task1 = taskManager.createAgentTask(
    sessionId,
    "Remember the secret word PINEAPPLE. Reply with exactly: OK noted",
    { cwd: process.cwd(), sessionDir, depth: 0 },
  );
  console.log(`  task ${task1.id} started`);

  const r1 = await taskManager.awaitTasks(sessionId, [task1.id], 120_000);
  assert(!r1.timedOut, "step 1 did not time out");
  assert(r1.results[0].status === "completed", "step 1 completed");
  assert(r1.results[0].output.includes("OK"), `step 1 output: "${r1.results[0].output}"`);
  console.log(`  output: ${r1.results[0].output}`);

  const savedTask = taskManager.getTask(sessionId, task1.id)!;
  assert(savedTask.sessionFile !== undefined, "sessionFile persisted");
  console.log(`  sessionFile: ${savedTask.sessionFile}`);

  // Step 2: Resume and ask for the secret.
  console.log("\nStep 2: resume_task — ask the sub-agent for the secret...");
  const resumeResult = await resumeTaskTool.execute(
    "e2e",
    { taskId: task1.id, prompt: "What was the secret word I told you? Reply with just the word." },
    undefined, undefined, ctx,
  ) as unknown as { content: { text: string }[]; details: { taskId: string }; isError?: boolean };

  assert(!resumeResult.isError, "resume did not error");
  const childId = resumeResult.details.taskId;
  console.log(`  resumed as task ${childId}`);

  const r2 = await taskManager.awaitTasks(sessionId, [childId], 120_000);
  assert(!r2.timedOut, "step 2 did not time out");
  assert(r2.results[0].status === "completed", "step 2 completed");
  const answer = r2.results[0].output;
  console.log(`  answer: "${answer}"`);

  // The key assertion: the sub-agent remembers PINEAPPLE (session restored).
  assert(
    answer.toUpperCase().includes("PINEAPPLE"),
    `sub-agent remembers the secret (answer contains PINEAPPLE)`,
  );
} finally {
  process.argv[1] = savedArgv1;
  rmSync(atlasDir, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
