/**
 * Task manager — core lifecycle, state machine, and session isolation.
 *
 * Each session owns an independent task table. Tasks transition through a
 * state machine whose terminal states (completed / failed / cancelled /
 * orphaned) are immutable.
 *
 * Bash tasks spawn a child process whose stdout+stderr are fed into an
 * OutputAccumulator. Completion is event-driven: each task owns a Promise
 * that resolves when the task reaches a terminal state, so AwaitTask can
 * race on Promise.all rather than polling.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { unlink } from "node:fs/promises";

import {
  truncateTail,
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_BYTES,
} from "@earendil-works/pi-coding-agent";

import type { Task, TaskResult, TaskStatus, TaskType, TaskUsage } from "./types.js";
import { generateTaskId } from "./types.js";
import { OutputAccumulator } from "./output-accumulator.js";
import * as persistence from "./persistence.js";
import { getPiInvocation, extractFinalOutput, extractLastAction, formatAgentOutput } from "./agent-task.js";

/** Milliseconds to wait after SIGTERM before escalating to SIGKILL. */
const KILL_GRACE_MS = 5000;

/** Convert a timeout in seconds to milliseconds. */
function timeoutToMs(timeout?: number): number | undefined {
  if (timeout === undefined || timeout === null) return undefined;
  return Math.max(0, Math.floor(timeout * 1000));
}

/**
 * Kill a process tree: SIGTERM to the whole group, then SIGKILL after a grace
 * period if the group is still alive.
 */
function killProcessTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const trySignal = (signal: NodeJS.Signals) => {
      try {
        process.kill(-pid, signal);
        return true;
      } catch {
        try {
          process.kill(pid, signal);
          return true;
        } catch {
          return false; // already dead
        }
      }
    };

    if (!trySignal("SIGTERM")) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      trySignal("SIGKILL");
      resolve();
    }, KILL_GRACE_MS);

    // Best-effort: check if the process is still alive and resolve early.
    const checkInterval = setInterval(() => {
      try {
        process.kill(-pid, 0);
      } catch {
        clearInterval(checkInterval);
        clearTimeout(timer);
        resolve();
      }
    }, 200);
  });
}

export class TaskManager {
  /** sessionId → (taskId → Task) */
  private tasks = new Map<string, Map<string, Task>>();
  /** taskId → running ChildProcess (bash or agent) */
  private processes = new Map<string, ChildProcess>();
  /** taskId → OutputAccumulator */
  private accumulators = new Map<string, OutputAccumulator>();
  /** taskId → completion resolvers (multiple awaiters can wait) */
  private resolvers = new Map<string, Array<(task: Task) => void>>();
  /** taskId set — synchronously marked when finalizeTask starts, to prevent double-completion */
  private finalizing = new Set<string>();
  /** taskId → accumulated messages (agent tasks only, for live WatchTask) */
  private agentMessages = new Map<string, { role: string; content: { type: string; text?: string }[] }[]>();
  /** sessionId → nesting depth (from PI_ATLAS_TASK_DEPTH env var) */
  private sessionDepths = new Map<string, number>();

  /** Set the nesting depth for a session (read from PI_ATLAS_TASK_DEPTH at session_start). */
  setSessionDepth(sessionId: string, depth: number): void {
    this.sessionDepths.set(sessionId, depth);
  }

  /** Get the nesting depth for a session (default 0). */
  getSessionDepth(sessionId: string): number {
    return this.sessionDepths.get(sessionId) ?? 0;
  }

  // ---- session / task table helpers ----

  private getTaskMap(sessionId: string): Map<string, Task> {
    let map = this.tasks.get(sessionId);
    if (!map) {
      map = new Map();
      this.tasks.set(sessionId, map);
    }
    return map;
  }

  getTask(sessionId: string, taskId: string): Task | undefined {
    return this.getTaskMap(sessionId).get(taskId);
  }

  listTasks(sessionId: string): Task[] {
    return Array.from(this.getTaskMap(sessionId).values());
  }

  /**
   * Return all tasks in the `running` state for a session.
   */
  getActiveTasks(sessionId: string): Task[] {
    return this.listTasks(sessionId).filter((t) => t.status === "running");
  }

  // ---- bash task lifecycle ----

  /**
   * Spawn a bash command as a background task.
   *
   * Returns immediately with the Task in `running` state. The process runs
   * independently; completion is tracked via an internal Promise.
   */
  createBashTask(
    sessionId: string,
    command: string,
    cwd: string,
    env?: Record<string, string>,
    timeout?: number,
    depth?: number,
    parentId?: string,
  ): Task {
    const id = generateTaskId();
    const task: Task = {
      id,
      type: "bash",
      status: "running",
      command,
      cwd,
      startedAt: Date.now(),
      output: "",
      depth: depth ?? this.getSessionDepth(sessionId),
      parentId,
    };

    this.getTaskMap(sessionId).set(id, task);

    const accumulator = new OutputAccumulator({ tempFilePrefix: "pi-atlas-bash" });
    this.accumulators.set(id, accumulator);

    // Completion promise — resolved when the task reaches a terminal state.
    const completionPromise = new Promise<Task>((resolve) => {
      const list = this.resolvers.get(id) ?? [];
      list.push(resolve);
      this.resolvers.set(id, list);
    });
    // Stash for awaitTasks (unused reference keeps the promise alive).
    taskCompletionPromises.set(id, completionPromise);

    this.spawnBash(sessionId, task, accumulator, env, timeoutToMs(timeout));

    // Persist the initial running state.
    void persistence.saveTask(sessionId, task).catch((err) => {
      console.error(`[pi-atlas] Failed to persist initial task ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
    });

    return task;
  }

  // ---- agent task lifecycle ----

  /** Options for spawning a pi sub-process as an agent task. */
  createAgentTask(
    sessionId: string,
    prompt: string,
    options: {
      cwd: string;
      agent?: string;
      model?: string;
      tools?: string[];
      sessionDir: string;
      depth?: number;
      parentId?: string;
      /** Sub-session ID to resume (restores full conversation history via --session). */
      resumeSid?: string;
    },
  ): Task {
    const id = generateTaskId();
    const depth = options.depth ?? this.getSessionDepth(sessionId);
    const task: Task = {
      id,
      type: "agent",
      status: "running",
      prompt,
      agent: options.agent,
      cwd: options.cwd,
      startedAt: Date.now(),
      output: "",
      depth,
      parentId: options.parentId,
    };

    this.getTaskMap(sessionId).set(id, task);

    // Use an OutputAccumulator to persist the raw JSON event stream for debugging.
    const accumulator = new OutputAccumulator({ tempFilePrefix: "pi-atlas-agent" });
    this.accumulators.set(id, accumulator);

    // Completion promise — resolved when the task reaches a terminal state.
    const completionPromise = new Promise<Task>((resolve) => {
      const list = this.resolvers.get(id) ?? [];
      list.push(resolve);
      this.resolvers.set(id, list);
    });
    taskCompletionPromises.set(id, completionPromise);

    this.spawnAgent(sessionId, task, accumulator, {
      prompt: prompt,
      model: options.model,
      tools: options.tools,
      sessionDir: options.sessionDir,
      resumeSid: options.resumeSid,
    });

    // Persist the initial running state.
    void persistence.saveTask(sessionId, task).catch((err) => {
      console.error(`[pi-atlas] Failed to persist initial agent task ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
    });

    return task;
  }

  /**
   * Spawn a pi sub-process in RPC mode and drive it via stdin commands.
   *
   * The child runs as a persistent RPC process (`pi --mode rpc`). The prompt is
   * sent as a `{type:"prompt"}` command on stdin; completion is detected via
   * the `agent_settled` event on stdout. Unlike the old `--mode json -p`
   * (single-turn, exit-code based), RPC mode stays alive — so the guard's
   * follow-up injection can drive additional turns, and CancelTask can cleanly
   * shut it down (SIGTERM → SIGKILL via killProcessTree).
   *
   * We spawn directly (not via RpcClient) so we control the binary path
   * (supports both `pi` bin and mock scripts) and the process lifecycle.
   * The RPC protocol is simple JSONL: write `{type:"prompt",...}
` to stdin,
   * read events from stdout line-by-line.
   *
   * Session persistence is enabled so the sub-session is saved to the isolated
   * atlas sub-sessions directory. `AskUser` is always excluded — sub-agents
   * cannot prompt the user directly. If `resumeSid` is provided, `--session
   * <sid>` restores the prior conversation.
   */
  private spawnAgent(
    sessionId: string,
    task: Task,
    accumulator: OutputAccumulator,
    options: {
      prompt: string;
      model?: string;
      tools?: string[];
      sessionDir: string;
      resumeSid?: string;
    },
  ): void {
    // Build pi CLI arguments (--mode rpc, no -p, no prompt as positional arg).
    const args: string[] = ["--mode", "rpc"];
    args.push("--session-dir", options.sessionDir);
    args.push("--exclude-tools", "ask_user");
    if (options.resumeSid) {
      args.push("--session", options.resumeSid);
    }
    if (options.model) {
      args.push("--model", options.model);
    }
    if (options.tools && options.tools.length > 0) {
      args.push("--tools", options.tools.join(","));
    }

    const invocation = getPiInvocation(args);
    const childEnv = {
      ...process.env,
      PI_ATLAS_TASK_DEPTH: String(task.depth + 1),
    };

    // Spawn with pipe stdin (RPC mode needs writable stdin for commands).
    const child = spawn(invocation.command, invocation.args, {
      cwd: task.cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.processes.set(task.id, child);

    let settled = false;
    let buffer = "";
    const messages: { role: string; content: { type: string; text?: string }[] }[] = [];
    this.agentMessages.set(task.id, messages);
    let usage: TaskUsage | undefined;
    let sessionFile: string | undefined;
    let stderrText = "";

    const processLine = (line: string): void => {
      if (!line.trim()) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      const type = event.type as string | undefined;

      // Session file from get_state response.
      if (type === "response" && event.command === "get_state") {
        const data = event.data as Record<string, unknown> | undefined;
        if (data?.sessionFile) sessionFile = data.sessionFile as string;
        return;
      }

      // message_end — accumulate the finalized message.
      if (type === "message_end" && event.message) {
        messages.push(event.message as { role: string; content: { type: string; text?: string }[] });
        const msg = event.message as Record<string, unknown>;
        if (msg.role === "assistant" && msg.usage) {
          const u = msg.usage as Record<string, number>;
          usage = usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
          usage.input += (u.input as number) || 0;
          usage.output += (u.output as number) || 0;
          usage.cacheRead += (u.cacheRead as number) || 0;
          usage.cacheWrite += (u.cacheWrite as number) || 0;
          const cost = u.cost as unknown;
          if (typeof cost === "number") {
            usage.cost += cost;
          } else if (cost && typeof cost === "object" && "total" in cost) {
            usage.cost += (cost as { total: number }).total || 0;
          }
          usage.turns += 1;
          usage.contextTokens = (u.totalTokens as number) || 0;
          usage.model = (msg.model as string) || usage.model;
          usage.stopReason = (msg.stopReason as string) || usage.stopReason;
          usage.errorMessage = (msg.errorMessage as string) || usage.errorMessage;
        }
      }

      // turn_end — capture toolResults as a fallback.
      if (type === "turn_end" && Array.isArray(event.toolResults)) {
        for (const tr of event.toolResults as { role: string; content: { type: string; text?: string }[] }[]) {
          messages.push(tr);
        }
      }

      // agent_settled — prompt (including guard-driven follow-up turns) done.
      if (type === "agent_settled" && !settled) {
        settled = true;
        task.sessionFile = sessionFile;
        const finalText = extractFinalOutput(messages);
        const outputOverride = finalText || "(no output)";
        const status: TaskStatus = usage?.stopReason === "error" ? "failed" : "completed";
        const exitCode = status === "failed" ? 1 : 0;
        // Shut down the RPC process, then finalize.
        this.shutdownRpcChild(task.id, child);
        void this.finalizeTask(sessionId, task, status, exitCode, outputOverride, usage);
      }
    };

    child.stdout?.on("data", (data: Buffer) => {
      accumulator.append(data);
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderrText += data.toString();
      accumulator.append(data);
    });

    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      this.processes.delete(task.id);
      if (buffer.trim()) processLine(buffer);
      task.sessionFile = sessionFile;
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        this.finalizeTask(sessionId, task, "cancelled", undefined, extractFinalOutput(messages), usage);
      } else {
        const finalText = extractFinalOutput(messages);
        const outputOverride = finalText || stderrText || "(no output)";
        const status: TaskStatus = code === 0 ? "completed" : "failed";
        this.finalizeTask(sessionId, task, status, code ?? 1, outputOverride, usage);
      }
    };

    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      this.processes.delete(task.id);
      accumulator.append(Buffer.from(error.message + "\n"));
      this.finalizeTask(sessionId, task, "failed", 1, `Failed to start agent: ${error.message}`, usage);
    };

    child.on("close", onExit);
    child.on("error", onError);

    // Send get_state first (to capture sessionFile), then the prompt.
    const sendCommands = (): void => {
      const stateCmd = JSON.stringify({ type: "get_state", id: "req_0" }) + "\n";
      const promptCmd = JSON.stringify({ type: "prompt", message: options.prompt, id: "req_1" }) + "\n";
      child.stdin?.write(stateCmd + promptCmd, (err) => {
        if (err && !settled) {
          settled = true;
          this.processes.delete(task.id);
          accumulator.append(Buffer.from(err.message + "\n"));
          this.finalizeTask(sessionId, task, "failed", 1, `Failed to send prompt: ${err.message}`, usage);
        }
      });
    };
    if (child.stdin?.writable) {
      sendCommands();
    } else {
      child.stdin?.on("ready", sendCommands);
    }
  }

  /**
   * Shut down an RPC child process: close stdin, SIGTERM, then SIGKILL.
   */
  private shutdownRpcChild(taskId: string, child: ChildProcess): void {
    this.processes.delete(taskId);
    try {
      child.stdin?.end();
    } catch {
      // Best-effort.
    }
    if (child.pid) {
      void killProcessTree(child.pid);
    }
  }

  private spawnBash(
    sessionId: string,
    task: Task,
    accumulator: OutputAccumulator,
    env?: Record<string, string>,
    timeoutMs?: number,
  ): void {
    const childEnv = { ...process.env, ...(env ?? {}) };
    const child = spawn("bash", ["-c", task.command!], {
      cwd: task.cwd,
      detached: true,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.processes.set(task.id, child);

    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const onData = (data: Buffer) => {
      accumulator.append(data);
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      this.processes.delete(task.id);

      if (signal === "SIGTERM" || signal === "SIGKILL") {
        // Killed by cancel() — state is already set to cancelled.
        this.finalizeTask(sessionId, task, "cancelled");
      } else {
        const status: TaskStatus = code === 0 ? "completed" : "failed";
        this.finalizeTask(sessionId, task, status, code ?? 1);
      }
    };

    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      this.processes.delete(task.id);
      accumulator.append(Buffer.from(error.message));
      this.finalizeTask(sessionId, task, "failed", 1);
    };

    child.on("close", onExit);
    child.on("error", onError);

    if (timeoutMs !== undefined && timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        if (settled || !child.pid) return;
        // Settle synchronously so onExit doesn't race us to "cancelled".
        settled = true;
        this.processes.delete(task.id);
        void killProcessTree(child.pid).then(() => {
          void this.finalizeTask(sessionId, task, "failed", 124);
        });
      }, timeoutMs);
    }
  }

  /**
   * Move a task to a terminal state, capture output, persist, and resolve
   * any awaiters. Terminal states are immutable.
   *
   * For agent tasks, `outputOverride` is the extracted final assistant message
   * — it replaces the raw accumulator snapshot as the display output
   * (`task.output`). A readable transcript (not raw JSON events) is persisted
   * to the full output file.
   */
  private async finalizeTask(
    sessionId: string,
    task: Task,
    status: TaskStatus,
    exitCode?: number,
    outputOverride?: string,
    usage?: TaskUsage,
  ): Promise<void> {
    // Synchronous guard: prevent double-completion when cancel() and onExit
    // race. Once finalization starts (or the task is already terminal), bail.
    if (this.finalizing.has(task.id)) return;
    if (
      task.status === "completed" ||
      task.status === "failed" ||
      task.status === "cancelled" ||
      task.status === "orphaned"
    ) {
      return;
    }
    this.finalizing.add(task.id);

    const accumulator = this.accumulators.get(task.id);
    if (accumulator) {
      try {
        accumulator.finish();
        const snapshot = accumulator.snapshot({ persistIfTruncated: true });

        // Assign memory output BEFORE closeTempFile so disk errors don't lose it.
        if (outputOverride !== undefined) {
          const trunc = truncateTail(outputOverride, {
            maxLines: DEFAULT_MAX_LINES,
            maxBytes: DEFAULT_MAX_BYTES,
          });
          task.output = trunc.content;
        } else {
          task.output = snapshot.content;
        }
        // Keep temp file path as fallback in case writeOutput fails.
        if (snapshot.fullOutputPath) {
          task.outputPath = snapshot.fullOutputPath;
        }

        await accumulator.closeTempFile();

        // Persist the full output to the session tasks directory.
        // For agent tasks, save a readable transcript instead of raw JSON events.
        let fullOutput: string;
        if (task.type === "agent") {
          const messages = this.agentMessages.get(task.id);
          let usageHeader = "";
          if (usage) {
            usageHeader += `--- Usage ---\n`;
            usageHeader += `model: ${usage.model ?? "unknown"}\n`;
            usageHeader += `input: ${usage.input}  output: ${usage.output}  turns: ${usage.turns}\n`;
            usageHeader += `cacheRead: ${usage.cacheRead}  cacheWrite: ${usage.cacheWrite}  cost: ${usage.cost}\n`;
            if (usage.stopReason) usageHeader += `stopReason: ${usage.stopReason}\n`;
            usageHeader += `\n`;
          }
          fullOutput = usageHeader + (messages ? formatAgentOutput(messages) : (outputOverride ?? ""));
        } else {
          fullOutput = await accumulator.getFullOutput();
        }
        const outputPath = await persistence.writeOutput(sessionId, task.id, fullOutput);
        task.outputPath = outputPath;

        // Clean up the temp file now that output is persisted to the tasks dir.
        if (snapshot.fullOutputPath && snapshot.fullOutputPath !== outputPath) {
          await unlink(snapshot.fullOutputPath).catch(() => {});
        }
      } catch (err) {
        // Output persistence failure must not leave the task stuck in `running`.
        // task.output and task.outputPath may have been set before the failure
        // (from the in-memory snapshot / temp file path), so they are preserved.
        console.error(`[pi-atlas] Failed to persist output for task ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    task.status = status;
    task.finishedAt = Date.now();
    if (exitCode !== undefined) {
      task.exitCode = exitCode;
    } else if (status === "cancelled") {
      // 128 + SIGTERM(15) — conventional exit code for terminated processes.
      task.exitCode = 143;
    } else if (status === "orphaned") {
      task.exitCode = -1;
    }

    // Persist final state — use try/catch so persistence failure doesn't
    // leave the task stuck in `running` with unresolved awaiters.
    if (usage) task.usage = usage;
    try {
      await persistence.saveTask(sessionId, task);
    } catch (err) {
      console.error(`[pi-atlas] Failed to persist task ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Resolve awaiters.
    const resolvers = this.resolvers.get(task.id);
    if (resolvers) {
      this.resolvers.delete(task.id);
      for (const resolve of resolvers) {
        resolve(task);
      }
    }

    // Clean up per-task state to prevent memory leaks in long sessions.
    this.accumulators.delete(task.id);
    this.finalizing.delete(task.id);
    this.agentMessages.delete(task.id);
    taskCompletionPromises.delete(task.id);
  }

  // ---- cancellation ----

  /**
   * Cancel a task and, if it's an agent task, recursively cancel all its
   * child tasks (tasks whose parentId === this task's id).
   *
   * Killing is best-effort with a hard timeout: SIGTERM first, then SIGKILL
   * after KILL_GRACE_MS if the process hasn't exited.
   */
  async cancel(sessionId: string, taskId: string): Promise<Task> {
    const task = this.getTask(sessionId, taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    if (task.status !== "running") {
      return task; // already terminal — no-op
    }

    // Recursively cancel child tasks first (depth-first).
    const children = this.listTasks(sessionId).filter(
      (t) => t.parentId === taskId && t.status === "running",
    );
    await Promise.all(children.map((t) => this.cancel(sessionId, t.id)));

    // Mark the task as cancelled BEFORE killing the process, so the child's
    // exit handler (onExit/onClose) sees a terminal status and becomes a no-op
    // instead of racing us to finalize as "failed".
    await this.finalizeTask(sessionId, task, "cancelled");

    const proc = this.processes.get(taskId);
    if (proc) {
      // Both bash and agent tasks use ChildProcess; kill the process tree.
      if (proc.pid) {
        await killProcessTree(proc.pid);
      }
    }
    this.processes.delete(taskId);

    return task;
  }

  // ---- awaiting (event-driven) ----

  /**
   * Wait for tasks to reach a terminal state.
   *
   * - If `taskIds` is omitted, waits for all currently-running tasks.
   * - Event-driven: each task owns a completion Promise; no polling.
   * - `signal` abort cancels the *wait* but not the tasks themselves.
   * - Returns `{ results, timedOut }`.
   */
  async awaitTasks(
    sessionId: string,
    taskIds?: string[],
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<{ results: TaskResult[]; timedOut: boolean }> {
    let ids: string[];
    if (taskIds && taskIds.length > 0) {
      ids = taskIds;
    } else {
      ids = this.getActiveTasks(sessionId).map((t) => t.id);
    }

    if (ids.length === 0) {
      return { results: [], timedOut: false };
    }

    // Build a promise per task. Terminal tasks resolve immediately.
    const taskPromises = ids.map((id) => this.taskCompletionPromise(sessionId, id));

    const promises: Promise<Task[]>[] = [Promise.all(taskPromises)];

    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    if (timeoutMs !== undefined && timeoutMs > 0) {
      const timeoutPromise = new Promise<Task[]>((resolve) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          resolve([]);
        }, timeoutMs);
      });
      promises.push(timeoutPromise);
    }

    if (signal) {
      const abortPromise = new Promise<Task[]>((resolve) => {
        if (signal.aborted) {
          resolve([]);
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            resolve([]);
          },
          { once: true },
        );
      });
      promises.push(abortPromise);
    }

    await Promise.race(promises);
    if (timeoutHandle) clearTimeout(timeoutHandle);

    // Collect current state for all requested tasks (regardless of whether
    // they finished before the timeout).
    const results = ids.map((id) => this.toResult(this.getTask(sessionId, id)));

    return { results, timedOut };
  }

  /**
   * Return a Promise that resolves when the task reaches a terminal state.
   * If already terminal, resolves immediately.
   */
  private taskCompletionPromise(sessionId: string, taskId: string): Promise<Task> {
    const task = this.getTask(sessionId, taskId);
    if (!task) {
      return Promise.reject(new Error(`Task not found: ${taskId}`));
    }
    if (task.status !== "running") {
      return Promise.resolve(task);
    }
    // Use the stashed completion promise (created in createBashTask).
    const stashed = taskCompletionPromises.get(taskId);
    if (stashed) return stashed;

    // Fallback for tasks restored from disk (orphaned) — resolve immediately.
    return Promise.resolve(task);
  }

  // ---- watch ----

  /**
   * Return a one-line summary of a running agent task's most recent action —
   * the last content block (text or tool call) of the last assistant message.
   * Returns "" for non-agent tasks or when there is nothing to show yet.
   *
   * Used by AwaitTask's live status to show what a sub-agent is currently doing.
   */
  getLastAction(sessionId: string, taskId: string): string {
    const task = this.getTask(sessionId, taskId);
    if (!task || task.type !== "agent") return "";
    const messages = this.agentMessages.get(taskId);
    if (!messages || messages.length === 0) return "";
    return extractLastAction(messages);
  }

  /**
   * Return the current output snapshot for a task.
   *
   * For running tasks, returns the live OutputAccumulator snapshot.
   * For terminal tasks, returns the stored (already-truncated) output.
   */
  watchTask(sessionId: string, taskId: string): {
    output: string;
    outputPath?: string;
    status: TaskStatus;
    exitCode?: number;
    type: TaskType;
    startedAt?: number;
    finishedAt?: number;
    usage?: TaskUsage;
  } {
    const task = this.getTask(sessionId, taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (task.status === "running") {
      // For agent tasks, return the latest assistant message text (not raw JSONL).
      if (task.type === "agent") {
        const messages = this.agentMessages.get(taskId);
        if (messages && messages.length > 0) {
          const latest = extractFinalOutput(messages);
          if (latest) {
            return { output: latest, status: task.status, type: task.type, startedAt: task.startedAt };
          }
        }
      }
      // For bash tasks (or agent with no messages yet), use the accumulator.
      const accumulator = this.accumulators.get(taskId);
      if (accumulator) {
        const snapshot = accumulator.snapshot();
        return {
          output: snapshot.content,
          outputPath: snapshot.fullOutputPath,
          status: task.status,
          type: task.type,
          startedAt: task.startedAt,
        };
      }
    }

    return {
      output: task.output,
      outputPath: task.outputPath,
      status: task.status,
      exitCode: task.exitCode,
      type: task.type,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      usage: task.usage,
    };
  }

  // ---- recovery / session lifecycle ----

  /**
   * Restore tasks from disk for a session.
   * Any tasks left in `running` state are marked `orphaned` (their processes
   * no longer exist after a restart).
   */
  async restoreSession(sessionId: string): Promise<Task[]> {
    let tasks: Task[];
    try {
      tasks = await persistence.loadTasks(sessionId);
    } catch (err) {
      // loadTasks throws on non-ENOENT errors (corrupt JSON, I/O errors).
      // Do NOT write back — preserve the original file for manual recovery.
      console.error(`[pi-atlas] Skipping session restore for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
    const map = new Map<string, Task>();
    for (const task of tasks) {
      if (task.status === "running") {
        task.status = "orphaned";
        task.finishedAt = task.finishedAt ?? Date.now();
        task.exitCode = task.exitCode ?? -1;
      }
      map.set(task.id, task);
    }
    this.tasks.set(sessionId, map);
    // Persist the orphaned state — only if we successfully loaded.
    try {
      await persistence.saveTasks(sessionId, Array.from(map.values()));
    } catch (err) {
      console.error(`[pi-atlas] Failed to persist orphaned state for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return Array.from(map.values());
  }

  /**
   * Cancel all running tasks for a session (called on session_shutdown).
   */
  async cancelAll(sessionId: string): Promise<void> {
    const active = this.getActiveTasks(sessionId);
    await Promise.all(active.map((t) => this.cancel(sessionId, t.id)));
  }

  // ---- helpers ----

  private toResult(task: Task | undefined): TaskResult {
    if (!task) {
      return { id: "", status: "orphaned", output: "", type: "bash" };
    }
    return {
      id: task.id,
      status: task.status,
      exitCode: task.exitCode,
      output: task.output,
      outputPath: task.outputPath,
      command: task.command,
      prompt: task.prompt,
      type: task.type,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      usage: task.usage,
    };
  }
}

// Module-level map stashing the completion promise created in createBashTask.
// This keeps the promise alive until awaiters attach to it.
const taskCompletionPromises = new Map<string, Promise<Task>>();

/**
 * Shared singleton task manager instance.
 *
 * Pinned to globalThis because pi's extension loader uses jiti with
 * `moduleCache: false`, which re-evaluates this module on every cross-extension
 * import. A plain `new TaskManager()` would hand the guard extension a
 * *different* instance than the task extension — so the guard's
 * `getActiveTasks` could never see the tasks CreateBash registered, and the
 * "background tasks running" guard never fired. globalThis survives module
 * re-evaluation, so all extensions share one instance.
 */
const _taskManagerGlobal = globalThis as unknown as {
  __PI_ATLAS_TASK_MANAGER__?: TaskManager;
};
export const taskManager: TaskManager =
  _taskManagerGlobal.__PI_ATLAS_TASK_MANAGER__ ??= new TaskManager();
