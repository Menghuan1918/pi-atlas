/**
 * Guard abort-awareness — drives the real createGuardHandler through the real
 * event flow (turn_end → agent_settled) using the real taskManager. No LLM /
 * SDK / TUI required.
 *
 * Scenarios:
 *   A. Normal turn + running task → guard injects.
 *   B. User interrupt (aborted) + running task → guard must NOT inject.
 *   C. After B, a normal turn resumes → guard injects again (flag consumed).
 *   D. toolUse completion → inject (not an abort).
 *   E. error completion → inject (not an abort).
 *   F. No running tasks → never inject, even after abort.
 *
 * Run: npx tsx scripts/test-guard-abort.ts
 */
import { taskManager } from "../extensions/task/index.js";
import { createGuardHandler } from "../extensions/task/guard.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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

console.log("Guard abort-awareness (real taskManager + real guard)\n");

const sessionId = "abort-guard-unit";
const ctx = { sessionManager: { getSessionId: () => sessionId }, mode: "tui" } as unknown as ExtensionContext;

let injected = false;
const pi = {
  sendUserMessage: () => { injected = true; },
  on: () => {},
} as unknown as ExtensionAPI;

const guard = createGuardHandler(pi);

function turnEnd(role: string, stopReason: string): void {
  guard.onTurnEnd({ type: "turn_end", turnIndex: 0, timestamp: Date.now(), message: { role, stopReason } } as any);
}
function settle(): void {
  injected = false;
  guard.onSettle({ type: "agent_settled" }, ctx);
}

const task = taskManager.createBashTask(sessionId, "sleep 30", process.cwd());

// A. Normal completion → inject
turnEnd("assistant", "stop");
settle();
assert(injected, "A: guard injects after normal completion");

// B. User interrupt → must NOT inject
turnEnd("assistant", "aborted");
settle();
assert(!injected, "B: guard does NOT inject after user abort");

// C. After abort, normal turn resumes injection (flag consumed, not sticky)
turnEnd("assistant", "stop");
settle();
assert(injected, "C: guard resumes injection after a normal turn");

// D. toolUse completion → inject
turnEnd("assistant", "toolUse");
settle();
assert(injected, "D: guard injects after toolUse completion");

// E. error completion → inject
turnEnd("assistant", "error");
settle();
assert(injected, "E: guard injects after error completion");

// F. No running tasks → never inject regardless of abort
await taskManager.cancel(sessionId, task.id);
turnEnd("assistant", "aborted");
settle();
assert(!injected, "F: no injection when no running tasks (even after abort)");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
