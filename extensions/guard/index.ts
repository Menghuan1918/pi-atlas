/**
 * Guard extension — coordinates auto-continue guards.
 *
 * This extension owns the `agent_settled` event and coordinates two guard
 * sources in priority order:
 *
 *   1. Escape detection (aborted turn) → disable auto-continue, stop.
 *   2. Background tasks (task extension) → task guard takes priority.
 *   3. Target auto-continue → inject continuation message.
 *
 * The task guard logic is imported from `extensions/task/guard.js` (the
 * `createGuardHandler` function). The target guard logic lives in
 * `extensions/target/guard.js`.
 *
 * Priority: if background tasks are running, the task guard injects its
 * reminder and the target guard is skipped (the agent should deal with
 * running tasks first). Only when no tasks are running does the target
 * guard fire.
 *
 * Escape (aborted) is checked first and takes the highest priority — it
 * disables auto-continue regardless of task state.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createGuardHandler as createTaskGuard } from "../task/guard.js";
import { taskManager } from "../task/task-manager.js";
import { createTargetGuardHandler, wasLastTurnAborted } from "../target/guard.js";

export default function guardExtension(pi: ExtensionAPI): void {
  // Task guard handlers (onSettle + onTurnEnd).
  const taskGuard = createTaskGuard(pi);

  // Target guard handler.
  const targetGuard = createTargetGuardHandler(pi);

  // ── turn_end: delegate to task guard's onTurnEnd ────────────────────
  pi.on("turn_end", (event) => {
    taskGuard.onTurnEnd(event);
  });

  // ── agent_settled: coordinate both guards ──────────────────────────
  pi.on("agent_settled", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();

    // 1. Escape (aborted) — highest priority.
    //    Disable auto-continue and stop. The target guard handler checks
    //    this internally, so we just call it. But we also need to prevent
    //    the task guard from injecting if the turn was aborted.
    if (wasLastTurnAborted(ctx)) {
      targetGuard(event, ctx);
      return;
    }

    // 2. Background tasks running → task guard takes priority.
    const activeTasks = taskManager.getActiveTasks(sessionId);
    if (activeTasks.length > 0) {
      taskGuard.onSettle(event, ctx);
      // Skip target guard — agent should handle running tasks first.
      return;
    }

    // 3. No tasks running → check target auto-continue.
    targetGuard(event, ctx);
  });
}
