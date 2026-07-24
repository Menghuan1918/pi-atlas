/**
 * CreateBash tool — spawn a bash command as a background task.
 *
 * Unlike the native `bash` tool, CreateBash returns immediately with a task ID.
 * The command runs independently; use AwaitTask / WatchTask to check progress.
 */

import { Type, type Static } from "@earendil-works/pi-ai";
import type { ToolDefinition, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { taskManager } from "./task-manager.js";

/** Parameter schema for CreateBash. */
export const createBashParameters = Type.Object({
  command: Type.String({
    description: "The bash command to execute.",
  }),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory for the command. Defaults to the current cwd.",
    }),
  ),
  env: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: "Additional environment variables for the command.",
    }),
  ),
  timeout: Type.Optional(
    Type.Number({
      description: "Timeout in seconds. The task is killed (exit code 124) if it exceeds this.",
    }),
  ),
});

export type CreateBashParams = Static<typeof createBashParameters>;

/** Details returned by CreateBash (and surfaced in the tool result UI). */
export interface CreateBashDetails {
  taskId: string;
  command: string;
  status: string;
}

export const createBashTool: ToolDefinition<typeof createBashParameters, CreateBashDetails> = {
  name: "CreateBash",
  label: "Create Bash Task",
  description:
    "Run a bash command in the background. Returns immediately with a task ID. Use AwaitTask to wait for completion, WatchTask to check output, or CancelTask to stop it.",
  promptSnippet: "Run a bash command in the background (returns task ID immediately)",
  promptGuidelines: [
    "Use CreateBash for long-running commands (builds, tests, servers) so you can continue working while they run.",
    "After creating a task, always call AwaitTask before relying on its output — the task runs asynchronously.",
  ],
  parameters: createBashParameters,
  async execute(
    _toolCallId: string,
    params: CreateBashParams,
    _signal: AbortSignal | undefined,
    _onUpdate: unknown,
    ctx: ExtensionContext,
  ): Promise<{ content: { type: "text"; text: string }[]; details: CreateBashDetails }> {
    const sessionId = ctx.sessionManager.getSessionId();
    const cwd = params.cwd ?? ctx.cwd;

    if (!params.command.trim()) {
      return {
        content: [{ type: "text", text: "Error: command must not be empty." }],
        details: { taskId: "", command: params.command, status: "failed" },
      };
    }

    const task = taskManager.createBashTask(
      sessionId,
      params.command,
      cwd,
      params.env,
      params.timeout,
    );

    return {
      content: [
        {
          type: "text",
          text: `Started bash task ${task.id} (running in background).`,
        },
      ],
      details: {
        taskId: task.id,
        command: params.command,
        status: task.status,
      },
    };
  },
};
