/**
 * Target state model + read helpers, shared across pi-atlas packages.
 *
 * Lives in `pi-atlas-shared` so extensions outside the `base` package
 * (e.g. `pi-atlas-ask`) can read the Target extension's persisted state
 * without importing its code. Writes stay in the Target extension
 * (`packages/base/extensions/target/persistence.ts`).
 *
 * Storage: `~/.pi/atlas/sessions/<sessionId>/target/state.json`
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAtlasSessionDir } from "./atlas-paths.js";

/**
 * Lifecycle state of a Target item.
 *
 * - `active`    — not yet done (or in-progress for the primary when auto-continue is on)
 * - `completed` — successfully finished
 * - `failed`    — could not be achieved
 *
 * `completed` and `failed` are terminal states.
 */
export type TargetStatus = "active" | "completed" | "failed";

/**
 * A single target item.
 */
export interface TargetItem {
  /** 0 = primary target, 1+ = secondary targets. */
  id: number;
  /** Human-readable description of what to achieve. */
  text: string;
  /** Current lifecycle state. */
  status: TargetStatus;
  /** Optional completion summary or failure reason. */
  note?: string;
}

/**
 * Full target state for a session, persisted as `state.json`.
 */
export interface TargetState {
  /** The primary target (id 0), or null if none has been set. */
  primary: TargetItem | null;
  /** Secondary targets (id 1, 2, 3, …), ordered by id. */
  secondary: TargetItem[];
  /**
   * Whether auto-continue is active.
   *
   * When true, the guard injects a continuation message on `agent_settled`
   * to keep the agent working toward the primary target. When the primary
   * reaches a terminal state (completed/failed), this is set to false.
   */
  autoContinue: boolean;
  /**
   * Whether the ask_user timeout cap applies (goal-auto mode).
   *
   * - `false` — goal mode (default): ask_user uses the configured timeout
   *   as-is (0 = wait indefinitely). Activated by `/goal` and by the agent
   *   setting the primary target.
   * - `true` — goal-auto mode: ask_user is capped at a fixed upper bound so
   *   an unanswered question cannot stall the autonomous loop. Activated by
   *   `/goal-auto` only.
   *
   * Only meaningful while `autoContinue` is true.
   */
  askUserTimeoutCap: boolean;
}

/**
 * The default empty state — no targets, no auto-continue.
 */
export function defaultTargetState(): TargetState {
  return {
    primary: null,
    secondary: [],
    autoContinue: false,
    askUserTimeoutCap: false,
  };
}

/**
 * Channel emitted on every TargetState change (consumed by the pi-acp-v2 bridge
 * to forward Target progress as ACP plan variants). Defined here as the
 * emitter's public contract so the adapter and the manager share one source.
 */
export const TARGET_CHANGED_CHANNEL = "pi-atlas:target_changed";

/** Payload of a `pi-atlas:target_changed` event. */
export interface TargetChangedPayload {
  sessionId: string;
  state: TargetState;
}

/** Resolve the target directory for a session: `~/.pi/atlas/sessions/<sid>/target/` */
export function getTargetDir(sessionId: string): string {
  return join(getAtlasSessionDir(sessionId), "target");
}

/** Get the state file path for a session. */
export function getStatePath(sessionId: string): string {
  return join(getTargetDir(sessionId), "state.json");
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

// ---------------------------------------------------------------------------
// Atomic write helpers (used by the Target extension's persistence layer)
// ---------------------------------------------------------------------------

/** Ensure a directory exists, creating parents as needed. */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * Atomic write: write to a sibling temp file then rename over the target.
 */
export async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, data, "utf-8");
  await rename(tmp, filePath);
}
