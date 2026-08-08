/**
 * Persistence layer for the Target extension.
 *
 * State is persisted under `~/.pi/atlas/sessions/<sessionId>/target/`:
 *   - `state.json` — the full TargetState for the session
 *
 * Writes are atomic: data is written to a temp file then renamed.
 */

import { mkdir, rename, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAtlasSessionDir } from "../shared/atlas-paths.js";
import { defaultTargetState, type TargetItem, type TargetState } from "./types.js";

const STATE_FILE = "state.json";

/**
 * Per-session write serialization.
 *
 * Read-modify-write calls are serialized per session to avoid losing data
 * when multiple tool calls fire in the same turn.
 */
const writeLocks = new Map<string, Promise<void>>();

function withWriteLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(sessionId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
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
 * Resolve the target directory for a session:
 * `~/.pi/atlas/sessions/<sid>/target/`
 */
export function getTargetDir(sessionId: string): string {
  return join(getAtlasSessionDir(sessionId), "target");
}

/** Get the state file path for a session. */
export function getStatePath(sessionId: string): string {
  return join(getTargetDir(sessionId), STATE_FILE);
}

/** Ensure a directory exists, creating parents as needed. */
async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * Load the target state for a session from disk.
 *
 * Returns the default empty state if no file exists yet (ENOENT).
 * For corrupt JSON, logs a warning and returns the default state rather
 * than throwing — target state is best-effort and should not block the agent.
 */
export async function loadTargetState(sessionId: string): Promise<TargetState> {
  const filePath = getStatePath(sessionId);
  try {
    const raw = await readFile(filePath, "utf-8");
    const data = JSON.parse(raw);
    return normalizeState(data);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return defaultTargetState();
    console.error(
      `[pi-atlas] Failed to load target state for session ${sessionId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return defaultTargetState();
  }
}

/**
 * Persist the full target state for a session (atomic write).
 */
export async function saveTargetState(
  sessionId: string,
  state: TargetState,
): Promise<void> {
  await withWriteLock(sessionId, async () => {
    const dir = getTargetDir(sessionId);
    await ensureDir(dir);
    const filePath = getStatePath(sessionId);
    const data = JSON.stringify({ sessionId, state }, null, 2);
    await atomicWrite(filePath, data);
  });
}

/**
 * Atomic write: write to a sibling temp file then rename over the target.
 */
async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, data, "utf-8");
  await rename(tmp, filePath);
}

/**
 * Validate and normalize a parsed JSON object into a TargetState.
 * Falls back to defaults for missing or malformed fields.
 */
function normalizeState(data: unknown): TargetState {
  if (data === null || typeof data !== "object") return defaultTargetState();
  const obj = data as Record<string, unknown>;

  // The file is saved as { sessionId, state: TargetState } — unwrap if needed.
  const stateObj = (obj.state && typeof obj.state === "object") ? obj.state as Record<string, unknown> : obj;

  const state = defaultTargetState();

  // Normalize primary
  if (stateObj.primary !== null && typeof stateObj.primary === "object") {
    state.primary = normalizeItem(stateObj.primary, 0);
  }

  // Normalize secondary
  if (Array.isArray(stateObj.secondary)) {
    state.secondary = stateObj.secondary
      .map((item, i) => normalizeItem(item, i + 1))
      .filter((item): item is NonNullable<typeof item> => item !== null);
  }

  if (typeof stateObj.autoContinue === "boolean") {
    state.autoContinue = stateObj.autoContinue;
  }

  if (typeof stateObj.askUserTimeoutCap === "boolean") {
    state.askUserTimeoutCap = stateObj.askUserTimeoutCap;
  }

  return state;
}

/**
 * Validate a single target item. Returns null if invalid.
 * The `expectedId` is used when the parsed object lacks a valid id.
 */
function normalizeItem(
  data: unknown,
  expectedId: number,
): TargetItem | null {
  if (data === null || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;

  const text = typeof obj.text === "string" ? obj.text : "";
  if (!text) return null;

  const status =
    obj.status === "active" ||
    obj.status === "completed" ||
    obj.status === "failed"
      ? obj.status
      : "active";

  const note = typeof obj.note === "string" ? obj.note : undefined;

  const id =
    typeof obj.id === "number" && Number.isFinite(obj.id)
      ? obj.id
      : expectedId;

  return { id, text, status, note };
}

// Re-export for convenience
export { defaultTargetState } from "./types.js";
