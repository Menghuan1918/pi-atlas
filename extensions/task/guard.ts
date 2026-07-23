/**
 * agent_settled guard.
 *
 * When the agent finishes a turn (settles) while background tasks are still
 * running, inject a user message reminding the LLM to await or cancel them.
 *
 * Anti-re-entry: a flag ensures we inject at most once per settle event.
 * Cross-cycle: each new `agent_settled` is a fresh opportunity — if the LLM
 * ignored the previous reminder and tasks are still running, we remind again.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { taskManager } from "./task-manager.js";
import type { Task } from "./types.js";

/**
 * Build the injection message listing active tasks.
 */
function buildGuardMessage(tasks: Task[]): string {
  const lines = tasks.map((t) => {
    const label = t.command ?? t.prompt ?? t.agent ?? "(unknown)";
    return `  - ${t.id} [${t.type}] ${label}`;
  });
  return [
    "⚠️ You have background tasks still running:",
    ...lines,
    "",
    "You must use AwaitTask to wait for their completion or CancelTask to cancel them before proceeding.",
  ].join("\n");
}

/**
 * Create the agent_settled handler.
 *
 * Returns a function suitable for `pi.on("agent_settled", handler)`.
 */
export function createGuardHandler(pi: ExtensionAPI): (event: { type: "agent_settled" }, ctx: ExtensionContext) => void {
  // Prevents double-injection within the same synchronous settle event.
  let injecting = false;

  return (_event, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const active = taskManager.getActiveTasks(sessionId);

    if (active.length === 0) {
      injecting = false;
      return;
    }

    if (injecting) {
      // Already injecting for this settle cycle — skip.
      return;
    }

    // In non-interactive modes (print/json), injecting a user message would
    // fail or be meaningless — skip the guard in those modes.
    if (ctx.mode === "print" || ctx.mode === "json") {
      return;
    }

    injecting = true;
    const message = buildGuardMessage(active);
    try {
      pi.sendUserMessage(message, { deliverAs: "followUp" });
    } catch (err) {
      console.error(`[pi-atlas] Guard injection failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      // Reset after the injected message is queued so the next settle cycle
      // (after the LLM processes it) can remind again if needed.
      injecting = false;
    }
  };
}
