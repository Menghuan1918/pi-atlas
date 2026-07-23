/**
 * Persistence layer for the Task extension.
 *
 * Tasks are persisted under `~/.pi/tasks/<sessionId>/`:
 *   - `tasks.json`          — array of task metadata
 *   - `output-<taskId>.log`  — full (untruncated) output for a task
 *
 * Writes are atomic: data is written to a temp file then renamed.
 */

import { mkdir, rename, readFile, writeFile, access, constants } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Task } from "./types.js";

const TASKS_FILE = "tasks.json";

/**
 * Per-session write serialization.
 *
 * `saveTask` / `saveTasks` do read-modify-write, so concurrent calls for the
 * same session would lose data. This chain ensures writes are serialized per
 * session without blocking other sessions.
 */
const writeLocks = new Map<string, Promise<void>>();

function withWriteLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(sessionId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  // Keep the chain alive even if fn rejects; store a swallowed version.
  writeLocks.set(
    sessionId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/**
 * Resolve (and create) the tasks directory for a session.
 */
export function getTasksDir(sessionId: string): string {
  const dir = join(getAgentDir(), "tasks", sessionId);
  return dir;
}

/** Ensure a directory exists, creating it (and parents) as needed. */
async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * Load all tasks for a session from disk.
 * Returns an empty array if no tasks file exists yet (ENOENT).
 * For other errors (corrupt JSON, I/O errors), logs a warning and THROWS
 * so callers can decide whether to skip writeback (avoiding data loss).
 */
export async function loadTasks(sessionId: string): Promise<Task[]> {
  const filePath = join(getTasksDir(sessionId), TASKS_FILE);
  try {
    const raw = await readFile(filePath, "utf-8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data?.tasks)) {
      throw new Error(`tasks.json has invalid schema: missing 'tasks' array`);
    }
    return data.tasks as Task[];
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return []; // expected for new sessions
    // Non-ENOENT: log and re-throw so callers can skip writeback.
    console.error(`[pi-atlas] Failed to load tasks for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

/**
 * Save a single task — update if it already exists, append otherwise.
 */
export async function saveTask(sessionId: string, task: Task): Promise<void> {
  await withWriteLock(sessionId, async () => {
    const tasks = await loadTasks(sessionId);
    const idx = tasks.findIndex((t) => t.id === task.id);
    if (idx >= 0) {
      tasks[idx] = task;
    } else {
      tasks.push(task);
    }
    await saveTasksLocked(sessionId, tasks);
  });
}

/**
 * Full overwrite of the tasks array for a session (atomic).
 */
export async function saveTasks(sessionId: string, tasks: Task[]): Promise<void> {
  await withWriteLock(sessionId, () => saveTasksLocked(sessionId, tasks));
}

/** Internal: perform the actual write (caller must hold the write lock). */
async function saveTasksLocked(sessionId: string, tasks: Task[]): Promise<void> {
  const dir = getTasksDir(sessionId);
  await ensureDir(dir);
  const filePath = join(dir, TASKS_FILE);
  const data = JSON.stringify({ sessionId, tasks }, null, 2);
  await atomicWrite(filePath, data);
}

/**
 * Write the full (untruncated) output for a task and return the file path.
 */
export async function writeOutput(sessionId: string, taskId: string, output: string): Promise<string> {
  const dir = getTasksDir(sessionId);
  await ensureDir(dir);
  const filePath = join(dir, `output-${taskId}.log`);
  await atomicWrite(filePath, output);
  return filePath;
}

/**
 * Read the full output for a task. Returns null if the file doesn't exist.
 */
export async function readOutput(sessionId: string, taskId: string): Promise<string | null> {
  const filePath = join(getTasksDir(sessionId), `output-${taskId}.log`);
  try {
    await access(filePath, constants.F_OK);
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Atomic write: write to a sibling temp file then rename over the target.
 */
async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, data, "utf-8");
  await rename(tmp, filePath);
}
