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
