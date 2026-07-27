/**
 * E2E: verify AskUser is excluded from sub-agents (real pi).
 * Run: npx tsx scripts/e2e-exclude-askuser.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { taskManager } from "../extensions/task/index.js";
import { getAgentSessionDir } from "../extensions/shared/atlas-paths.js";

let pass = 0, fail = 0;
function assert(c: unknown, m: string) { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.error(`  ✗ ${m}`); } }

const atlasDir = mkdtempSync(join(tmpdir(), "pi-atlas-excl-"));
process.env.PI_ATLAS_DIR = atlasDir;
const sessionId = "excl-session";
const subSessionDir = getAgentSessionDir(sessionId);
taskManager.setSessionDepth(sessionId, 0);
const savedArgv1 = process.argv[1];
process.argv[1] = "/nonexistent/path/to/pi";

try {
  // general agent = no tools allowlist, so AskUser WOULD be visible
  // unless --exclude-tools AskUser works.
  const task = taskManager.createAgentTask(
    sessionId,
    "Do you have a tool called AskUser available to you? Reply with exactly YES_ASKUSER or NO_ASKUSER.",
    { cwd: process.cwd(), sessionDir: subSessionDir, depth: 0, agent: undefined, tools: undefined },
  );
  const { results } = await taskManager.awaitTasks(sessionId, [task.id], 120_000);
  assert(results[0].status === "completed", "task completed");
  const answer = results[0].output.toUpperCase();
  console.log(`  sub-agent answer: "${results[0].output}"`);
  assert(answer.includes("NO_ASKUSER"), "sub-agent does NOT see AskUser (excluded)");
} finally {
  process.argv[1] = savedArgv1;
  rmSync(atlasDir, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
