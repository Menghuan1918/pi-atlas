/**
 * Shared types for the Target extension.
 *
 * A Target is a unified concept merging "goal" and "todo" from other agent
 * systems. There is one primary target (id 0) that can drive auto-continue,
 * and zero or more secondary targets (id 1, 2, 3, …) for progress tracking.
 *
 * Storage: `~/.pi/atlas/sessions/<sessionId>/target/state.json`
 */

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
}

/**
 * The default empty state — no targets, no auto-continue.
 */
export function defaultTargetState(): TargetState {
  return {
    primary: null,
    secondary: [],
    autoContinue: false,
  };
}
