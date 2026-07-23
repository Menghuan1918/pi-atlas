/**
 * Shared types for the Task extension.
 *
 * A Task represents a unit of asynchronous work — either a bash command
 * or a sub-agent invocation — that runs in the background while the main
 * LLM turn continues.
 */

import { randomBytes } from "node:crypto";

/** The kind of work a Task represents. */
export type TaskType = "bash" | "agent";

/** Lifecycle state of a Task. Terminal states are immutable. */
export type TaskStatus = "running" | "completed" | "cancelled" | "failed" | "orphaned";

/** Usage stats for agent tasks (accumulated from pi JSON events). */
export interface TaskUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens?: number;
  turns: number;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

/**
 * A single asynchronous task tracked by the task manager.
 */
export interface Task {
  /** Short ID (8-char hex). */
  id: string;
  type: TaskType;
  status: TaskStatus;
  /** bash: the shell command. */
  command?: string;
  /** agent: the prompt sent to the sub-agent. */
  prompt?: string;
  /** agent: the sub-agent name. */
  agent?: string;
  /** Working directory the task runs in. */
  cwd: string;
  /** Unix epoch milliseconds — when the task started. */
  startedAt: number;
  /** Unix epoch milliseconds — when the task reached a terminal state. */
  finishedAt?: number;
  /** Process exit code (bash) or synthetic code (agent). */
  exitCode?: number;
  /** Tail output (already truncated) for quick display. */
  output: string;
  /** Path to the full (untruncated) output file, set when output was truncated. */
  outputPath?: string;
  /** agent: path to the sub-session file. */
  sessionFile?: string;
  /** Resume: parent task ID when this task was spawned by another task. */
  parentId?: string;
  /** Nesting depth (0 = top-level task spawned directly by the main agent). */
  depth: number;
  /** agent: usage stats (token/cost) accumulated from the sub-process. */
  usage?: TaskUsage;
}

/**
 * Per-task summary returned by {@link AwaitTask} and other control tools.
 */
export interface TaskResult {
  id: string;
  status: TaskStatus;
  exitCode?: number;
  /** Tail output summary (truncated). */
  output: string;
  /** Path to full output file when available. */
  outputPath?: string;
  /** Original command or prompt for identification. */
  command?: string;
  prompt?: string;
  type: TaskType;
}

/**
 * Generate a short 8-character hex task ID.
 */
export function generateTaskId(): string {
  return randomBytes(4).toString("hex");
}
