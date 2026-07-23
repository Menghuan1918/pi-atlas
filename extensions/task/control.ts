/**
 * Control tools for the Task extension: AwaitTask, CancelTask, ListTask,
 * WatchTask.
 *
 * These operate on tasks created by CreateBash and CreateAgent.
 * Each tool resolves the current session from the ExtensionContext.
 */

import { Type, type Static } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import {
  truncateTail,
  formatSize,
  type ToolDefinition,
  type ExtensionContext,
  type AgentToolUpdateCallback,
} from "@earendil-works/pi-coding-agent";

import { taskManager } from "./task-manager.js";
import type { Task, TaskResult, TaskStatus } from "./types.js";

const DEFAULT_AWAIT_TIMEOUT_S = 3600;

/** Interval between live status updates during AwaitTask (ms). */
const LIVE_UPDATE_INTERVAL_MS = 1000;

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

/** Unicode status icon for a task status. */
function statusIcon(status: TaskStatus): string {
  switch (status) {
    case "completed": return "✓";
    case "failed": return "✗";
    case "cancelled":
    case "orphaned": return "⊘";
    default: return "⏳";
  }
}

/** Convert a Task to a TaskResult (mirrors TaskManager.toResult). */
function taskToResult(task: Task): TaskResult {
  return {
    id: task.id,
    status: task.status,
    exitCode: task.exitCode,
    output: task.output,
    outputPath: task.outputPath,
    command: task.command,
    prompt: task.prompt,
    type: task.type,
  };
}

/** Format live status text for streaming display (unicode icons, no ANSI colors). */
function formatLiveStatus(tasks: Task[]): string {
  const running = tasks.filter((t) => t.status === "running").length;
  const done = tasks.length - running;
  const header = `Waiting: ${done}/${tasks.length} done, ${running} running`;

  const lines = tasks.map((t) => {
    const elapsed = ((Date.now() - t.startedAt) / 1000).toFixed(1);
    const icon = statusIcon(t.status);
    let line = `${icon} ${t.id}  [${t.type}]  ${t.status}  ${elapsed}s`;
    if (t.exitCode !== undefined && t.status !== "running") {
      line += `  exit=${t.exitCode}`;
    }
    return line;
  });

  return `${header}\n\n${lines.join("\n")}`;
}

export const awaitTaskTool: ToolDefinition<typeof awaitTaskParameters, AwaitTaskDetails> = {
  name: "AwaitTask",
  label: "Await Task",
  description:
    "Wait for one or more background tasks to finish. Returns each task's status, exit code, and output. If no taskIds are given, waits for all running tasks.",
  parameters: awaitTaskParameters,

  renderCall(args, theme, _context) {
    const ids = args.taskIds;
    if (ids && ids.length > 0) {
      return new Text(
        theme.fg("toolTitle", theme.bold("AwaitTask ")) + theme.fg("dim", `[${ids.join(", ")}]`),
        0,
        0,
      );
    }
    return new Text(
      theme.fg("toolTitle", theme.bold("AwaitTask ")) + theme.fg("dim", "(all running tasks)"),
      0,
      0,
    );
  },

  renderResult(result, { isPartial }, theme, _context) {
    const text = result.content[0]?.type === "text" ? result.content[0].text : "(no output)";

    // During streaming, the content text already has unicode icons + elapsed time.
    if (isPartial) {
      return new Text(theme.fg("toolOutput", text), 0, 0);
    }

    // Final result — rebuild from details with colored status icons.
    const details = result.details;
    if (!details || details.results.length === 0) {
      return new Text(theme.fg("toolOutput", text), 0, 0);
    }

    const lines: string[] = [];
    if (details.timedOut) {
      lines.push(theme.fg("warning", "⏱ Timed out — some tasks may still be running."));
      lines.push("");
    }
    for (const r of details.results) {
      const icon =
        r.status === "completed" ? theme.fg("success", "✓")
        : r.status === "failed" ? theme.fg("error", "✗")
        : r.status === "cancelled" || r.status === "orphaned" ? theme.fg("muted", "⊘")
        : theme.fg("warning", "⏳");
      let line = `${icon} ${r.id}  ${theme.fg("dim", `[${r.type}]`)}  ${r.status}`;
      if (r.exitCode !== undefined) line += `  exit=${r.exitCode}`;
      lines.push(line);
      if (r.output) {
        lines.push(theme.fg("toolOutput", r.output));
      }
      if (r.outputPath) {
        lines.push(theme.fg("dim", `Full output: ${r.outputPath}`));
      }
      lines.push("");
    }
    return new Text(lines.join("\n").trimEnd(), 0, 0);
  },

  async execute(
    _toolCallId: string,
    params: AwaitTaskParams,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<AwaitTaskDetails> | undefined,
    ctx: ExtensionContext,
  ) {
    const sessionId = ctx.sessionManager.getSessionId();
    const timeoutS = params.timeout ?? DEFAULT_AWAIT_TIMEOUT_S;
    const timeoutMs = timeoutS * 1000;

    // Determine which task IDs we are waiting for (for live status display).
    const taskIds: string[] =
      params.taskIds && params.taskIds.length > 0
        ? params.taskIds
        : taskManager.getActiveTasks(sessionId).map((t) => t.id);

    // Emit live status while waiting.
    const emitLiveStatus = (): void => {
      if (!onUpdate) return;
      const tasks = taskIds
        .map((id) => taskManager.getTask(sessionId, id))
        .filter((t): t is Task => t !== undefined);
      if (tasks.length === 0) return;
      const results = tasks.map(taskToResult);
      onUpdate({
        content: [{ type: "text" as const, text: formatLiveStatus(tasks) }],
        details: { results, timedOut: false },
      });
    };

    // Emit initial status immediately.
    emitLiveStatus();

    // Set up periodic updates.
    const interval = setInterval(emitLiveStatus, LIVE_UPDATE_INTERVAL_MS);
    if (signal) {
      signal.addEventListener("abort", () => clearInterval(interval), { once: true });
    }

    let results: TaskResult[];
    let timedOut: boolean;

    try {
      const r = await taskManager.awaitTasks(
        sessionId,
        params.taskIds,
        timeoutMs,
        signal,
      );
      results = r.results;
      timedOut = r.timedOut;
    } finally {
      clearInterval(interval);
    }

    // Emit one final status update showing all tasks' terminal state.
    if (onUpdate) {
      const tasks = taskIds
        .map((id) => taskManager.getTask(sessionId, id))
        .filter((t): t is Task => t !== undefined);
      if (tasks.length > 0) {
        onUpdate({
          content: [{ type: "text" as const, text: formatLiveStatus(tasks) }],
          details: { results: tasks.map(taskToResult), timedOut },
        });
      }
    }

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
