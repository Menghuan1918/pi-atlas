/**
 * Task extension entry point.
 *
 * Registers seven tools (CreateBash, CreateAgent, ResumeTask, AwaitTask,
 * CancelTask, ListTask, WatchTask) and three lifecycle event handlers:
 *   - session_start    → restore persisted tasks, set nesting depth
 *   - agent_settled    → guard: remind the LLM about still-running tasks
 *   - session_shutdown → cancel all running tasks, persist final state
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { taskManager } from "./task-manager.js";
import { createBashTool } from "./bash-task.js";
import { createAgentTool, resumeTaskTool } from "./agent-task.js";
import {
  awaitTaskTool,
  cancelTaskTool,
  listTaskTool,
  watchTaskTool,
} from "./control.js";
import { createGuardHandler } from "./guard.js";

export default function taskExtension(pi: ExtensionAPI): void {
  // ---- Tools ----
  pi.registerTool(createBashTool);
  pi.registerTool(createAgentTool);
  pi.registerTool(resumeTaskTool);
  pi.registerTool(awaitTaskTool);
  pi.registerTool(cancelTaskTool);
  pi.registerTool(listTaskTool);
  pi.registerTool(watchTaskTool);

  // ---- Events ----

  // session_start: restore persisted tasks and set nesting depth.
  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();

    // Determine nesting depth from PI_ATLAS_TASK_DEPTH (set by the parent
    // agent when spawning a sub-session). Default 0 for the top-level session.
    const depthStr = process.env.PI_ATLAS_TASK_DEPTH;
    const depth = depthStr ? Math.max(0, parseInt(depthStr, 10) || 0) : 0;
    taskManager.setSessionDepth(sessionId, depth);

    // Restore tasks from disk; any left in "running" are marked "orphaned"
    // (their processes no longer exist after a restart).
    await taskManager.restoreSession(sessionId);
  });

  // agent_settled: if background tasks are still running, inject a reminder.
  pi.on("agent_settled", createGuardHandler(pi));

  // session_shutdown: cancel all running tasks and persist final state.
  pi.on("session_shutdown", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    await taskManager.cancelAll(sessionId);
  });
}

// Re-export public API for consumers and testing.
export { taskManager } from "./task-manager.js";
export { createBashTool } from "./bash-task.js";
export { createAgentTool, resumeTaskTool } from "./agent-task.js";
export { awaitTaskTool, cancelTaskTool, listTaskTool, watchTaskTool } from "./control.js";
export { createGuardHandler } from "./guard.js";
export { TaskManager } from "./task-manager.js";
export { OutputAccumulator } from "./output-accumulator.js";
export * as persistence from "./persistence.js";
export type {
  Task,
  TaskType,
  TaskStatus,
  TaskResult,
} from "./types.js";
