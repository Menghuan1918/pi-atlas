/**
 * Control tools for the Task extension: AwaitTask, CancelTask, ListTask,
 * WatchTask.
 *
 * These operate on tasks created by CreateBash and CreateAgent.
 * Each tool resolves the current session from the ExtensionContext.
 */

import { Type, type Static } from "@earendil-works/pi-ai";
import {
  truncateTail,
  formatSize,
  type ToolDefinition,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { taskManager } from "./task-manager.js";
import type { Task, TaskResult } from "./types.js";

const DEFAULT_AWAIT_TIMEOUT_S = 3600;

// ---------------------------------------------------------------------------
// AwaitTask
// ---------------------------------------------------------------------------

const awaitTaskParameters = Type.Object({
  taskIds: Type.Optional(
    Type.Array(Type.String(), {
      description: "Specific task IDs to wait for. If omitted, waits for all running tasks.",
    }),
  ),
  timeout: Type.Optional(
    Type.Number({
      description: `Maximum time to wait in seconds (default ${DEFAULT_AWAIT_TIMEOUT_S}).`,
    }),
  ),
});

type AwaitTaskParams = Static<typeof awaitTaskParameters>;

interface AwaitTaskDetails {
  results: TaskResult[];
  timedOut: boolean;
}

function formatTaskResult(r: TaskResult): string {
  const parts = [`Task ${r.id}: ${r.status}`];
  if (r.exitCode !== undefined) parts.push(`exit=${r.exitCode}`);
  if (r.command) parts.push(`cmd=${r.command}`);
  const lines: string[] = [parts.join("  ")];
  if (r.output) {
    lines.push(r.output);
  }
  if (r.outputPath) {
    lines.push(`Full output: ${r.outputPath}`);
  }
  return lines.join("\n");
}

export const awaitTaskTool: ToolDefinition<typeof awaitTaskParameters, AwaitTaskDetails> = {
  name: "AwaitTask",
  label: "Await Task",
  description:
    "Wait for one or more background tasks to finish. Returns each task's status, exit code, and output. If no taskIds are given, waits for all running tasks.",
  parameters: awaitTaskParameters,
  async execute(
    _toolCallId: string,
    params: AwaitTaskParams,
    signal: AbortSignal | undefined,
    _onUpdate: unknown,
    ctx: ExtensionContext,
  ) {
    const sessionId = ctx.sessionManager.getSessionId();
    const timeoutS = params.timeout ?? DEFAULT_AWAIT_TIMEOUT_S;
    const timeoutMs = timeoutS * 1000;

    const { results, timedOut } = await taskManager.awaitTasks(
      sessionId,
      params.taskIds,
      timeoutMs,
      signal,
    );

    const summary = results.length
      ? results.map(formatTaskResult).join("\n\n")
      : "(no tasks to await)";

    const text = timedOut
      ? `Timed out after ${timeoutS}s. Some tasks may still be running.\n\n${summary}`
      : `All awaited tasks finished.\n\n${summary}`;

    return {
      content: [{ type: "text" as const, text }],
      details: { results, timedOut },
    };
  },
};

// ---------------------------------------------------------------------------
// CancelTask
// ---------------------------------------------------------------------------

const cancelTaskParameters = Type.Object({
  taskId: Type.String({ description: "The ID of the task to cancel." }),
});

type CancelTaskParams = Static<typeof cancelTaskParameters>;

export const cancelTaskTool: ToolDefinition<typeof cancelTaskParameters> = {
  name: "CancelTask",
  label: "Cancel Task",
  description: "Cancel a running background task by killing its process tree.",
  parameters: cancelTaskParameters,
  async execute(
    _toolCallId: string,
    params: CancelTaskParams,
    _signal: AbortSignal | undefined,
    _onUpdate: unknown,
    ctx: ExtensionContext,
  ) {
    const sessionId = ctx.sessionManager.getSessionId();
    try {
      const task = await taskManager.cancel(sessionId, params.taskId);
      return {
        content: [
          {
            type: "text" as const,
            text: `Task ${task.id} cancelled. (exit code ${task.exitCode ?? "N/A"})`,
          },
        ],
        details: undefined,
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error cancelling task ${params.taskId}: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        details: undefined,
      };
    }
  },
};

// ---------------------------------------------------------------------------
// ListTask
// ---------------------------------------------------------------------------

const listTaskParameters = Type.Object({});

type ListTaskParams = Static<typeof listTaskParameters>;

function formatTaskSummary(task: Task): string {
  const age = ((Date.now() - task.startedAt) / 1000).toFixed(1);
  const cmd = task.command ?? task.prompt ?? "(no command)";
  const preview = cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd;
  return `${task.id}  [${task.type}]  ${task.status}  ${age}s  ${preview}`;
}

export const listTaskTool: ToolDefinition<typeof listTaskParameters> = {
  name: "ListTask",
  label: "List Tasks",
  description: "List all tasks (running and finished) in the current session.",
  parameters: listTaskParameters,
  async execute(
    _toolCallId: string,
    _params: ListTaskParams,
    _signal: AbortSignal | undefined,
    _onUpdate: unknown,
    ctx: ExtensionContext,
  ) {
    const sessionId = ctx.sessionManager.getSessionId();
    const tasks = taskManager.listTasks(sessionId);

    if (tasks.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No tasks in this session." }],
        details: undefined,
      };
    }

    const lines = tasks.map(formatTaskSummary);
    const header = `${tasks.length} task(s):\n${"ID".padEnd(10)} TYPE    STATUS     AGE    COMMAND`;
    return {
      content: [{ type: "text" as const, text: `${header}\n${lines.join("\n")}` }],
      details: undefined,
    };
  },
};

// ---------------------------------------------------------------------------
// WatchTask
// ---------------------------------------------------------------------------

const watchTaskParameters = Type.Object({
  taskId: Type.String({ description: "The ID of the task to watch." }),
  tail: Type.Optional(
    Type.Number({ description: "Maximum number of tail lines to show (default: show all available)." }),
  ),
});

type WatchTaskParams = Static<typeof watchTaskParameters>;

export const watchTaskTool: ToolDefinition<typeof watchTaskParameters> = {
  name: "WatchTask",
  label: "Watch Task",
  description:
    "View the current output and status of a background task. For running tasks, returns a live snapshot of accumulated output.",
  parameters: watchTaskParameters,
  async execute(
    _toolCallId: string,
    params: WatchTaskParams,
    _signal: AbortSignal | undefined,
    _onUpdate: unknown,
    ctx: ExtensionContext,
  ) {
    const sessionId = ctx.sessionManager.getSessionId();
    try {
      const watch = taskManager.watchTask(sessionId, params.taskId);

      let output = watch.output;
      if (params.tail !== undefined && params.tail > 0) {
        const trunc = truncateTail(output, { maxLines: params.tail });
        output = trunc.content;
      }

      const parts = [`Task ${params.taskId}: ${watch.status}`];
      if (watch.exitCode !== undefined) {
        parts.push(`exit=${watch.exitCode}`);
      }
      parts.push(`output=${formatSize(Buffer.byteLength(output, "utf-8"))}`);

      const lines = [parts.join("  ")];
      if (output) {
        lines.push("", output);
      } else {
        lines.push("", "(no output yet)");
      }
      if (watch.outputPath) {
        lines.push("", `Full output: ${watch.outputPath}`);
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: undefined,
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error watching task ${params.taskId}: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        details: undefined,
      };
    }
  },
};
