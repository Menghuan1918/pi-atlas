/**
 * E2E test: CreateAgent → save → ResumeTask with REAL pi.
 *
 * Verifies that ResumeTask restores the sub-agent's session history
 * (the sub-agent "remembers" the secret from the first turn).
 *
 * Run: npx tsx scripts/e2e-resume.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { taskManager } from "../extensions/task/index.js";
import { resumeTaskTool } from "../extensions/task/agent-task.js";
import { getAgentSessionDir } from "../extensions/shared/atlas-paths.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

let pass = 0;
let fail = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}`); }
}

// Use a clean atlas dir so we don't collide with real sessions.
const atlasDir = mkdtempSync(join(tmpdir(), "pi-atlas-e2e-"));
process.env.PI_ATLAS_DIR = atlasDir;

const sessionId = "e2e-session";
const subSessionDir = getAgentSessionDir(sessionId);
taskManager.setSessionDepth(sessionId, 0);

// Force getPiInvocation to use the real `pi` command (not this script).
const savedArgv1 = process.argv[1];
process.argv[1] = "/nonexistent/path/to/pi";

const ctx = {
  sessionManager: {
    getSessionId: () => sessionId,
    getSessionDir: () => subSessionDir,
  },
  cwd: process.cwd(),
} as unknown as ExtensionContext;

console.log("\nE2E: CreateAgent → save → ResumeTask (real pi)\n");

try {
  // Step 1: Create an agent that remembers a secret word.
  console.log("Step 1: CreateAgent — tell sub-agent a secret...");
  const task1 = taskManager.createAgentTask(
    sessionId,
    "Remember the secret word PINEAPPLE. Reply with exactly: OK noted",
    { cwd: process.cwd(), sessionDir: subSessionDir, depth: 0 },
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
  console.log("\nStep 2: ResumeTask — ask the sub-agent for the secret...");
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

  // Verify the new prompt was NOT injected with previous output.
  const childTask = taskManager.getTask(sessionId, childId)!;
  assert(!childTask.prompt?.includes("Previous task output"), "no output injection in prompt");

  // Step 3: Verify session isolation — sub-session file is under atlas, not ~/.pi/agent/sessions
  assert(
    savedTask.sessionFile!.includes("atlas"),
    "sub-session stored under atlas dir (isolated from pi /resume)",
  );
} finally {
  process.argv[1] = savedArgv1;
  rmSync(atlasDir, { recursive: true, force: true });
}

console.log(`\nE2E: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
