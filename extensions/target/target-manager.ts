/**
 * Target state manager — in-memory state with disk persistence.
 *
 * Each session has its own TargetState. The manager holds an in-memory copy
 * for fast access and writes through to disk on every mutation.
 *
 * State lifecycle:
 *   - session_start → load from disk (or default empty state)
 *   - tool calls / /goal command → mutate + persist
 *   - session_shutdown → (state already persisted on each mutation)
 */

import { loadTargetState, saveTargetState } from "./persistence.js";
import {
  TARGET_CHANGED_CHANNEL,
  defaultTargetState,
  type TargetChangedPayload,
  type TargetItem,
  type TargetState,
  type TargetStatus,
} from "./types.js";
import type { EventBus } from "@earendil-works/pi-coding-agent";

/** Sentinel id for the primary target. */
export const PRIMARY_ID = 0;

/**
 * Result of a set/add/update operation — the new state and a message
 * describing what happened (for tool output or command feedback).
 */
export interface TargetResult {
  state: TargetState;
  message: string;
}

class TargetManager {
  /** Per-session in-memory state. */
  private states = new Map<string, TargetState>();
  /** Shared event bus for emitting target changes (set at session_start). */
  private eventBus?: EventBus;

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Load (or create default) state for a session.
   * Called at `session_start`.
   */
  async restoreSession(sessionId: string): Promise<void> {
    const state = await loadTargetState(sessionId);
    this.states.set(sessionId, state);
  }

  /**
   * Clear in-memory state for a session.
   * Called at `session_shutdown`. State is already persisted on each mutation.
   */
  clearSession(sessionId: string): void {
    this.states.delete(sessionId);
  }

  // ---------------------------------------------------------------------------
  // Read access
  // ---------------------------------------------------------------------------

  /**
   * Inject the shared event bus (called by the target extension at session_start
   * with `pi.events`). Once set, every persisting mutation emits a
   * `pi-atlas:target_changed` event carrying the new TargetState.
   */
  setEventBus(bus: EventBus): void {
    this.eventBus = bus;
  }

  /** Get the in-memory state for a session (creates a default if missing). */
  getState(sessionId: string): TargetState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = defaultTargetState();
      this.states.set(sessionId, state);
    }
    return state;
  }

  /** Whether auto-continue is active for a session. */
  isAutoContinueActive(sessionId: string): boolean {
    const state = this.getState(sessionId);
    return state.autoContinue && state.primary?.status === "active";
  }

  // ---------------------------------------------------------------------------
  // Mutations (all persist to disk)
  // ---------------------------------------------------------------------------

  /**
   * Set or update the primary target text.
   *
   * Rejected when auto-continue is active (the primary is locked by user).
   */
  async setPrimary(
    sessionId: string,
    text: string,
  ): Promise<TargetResult> {
    const state = this.getState(sessionId);

    if (state.autoContinue) {
      return {
        state,
        message:
          "Primary target is locked by user. You can create secondary targets with Target(action: 'add') instead. " +
          "Use Target(action: 'update', id: 0, status: 'completed') when the primary target is done.",
      };
    }

    state.primary = {
      id: PRIMARY_ID,
      text,
      status: "active",
    };

    await this.persist(sessionId, state);
    this.emitChange(sessionId);
    return {
      state,
      message: `Primary target set: ${text}`,
    };
  }

  /**
   * Add a secondary target. Returns the new target id (1, 2, 3, …).
   */
  async addSecondary(
    sessionId: string,
    text: string,
  ): Promise<TargetResult> {
    const state = this.getState(sessionId);

    const nextId =
      state.secondary.length === 0
        ? 1
        : Math.max(...state.secondary.map((t) => t.id)) + 1;

    const item: TargetItem = {
      id: nextId,
      text,
      status: "active",
    };

    state.secondary.push(item);

    await this.persist(sessionId, state);
    this.emitChange(sessionId);
    return {
      state,
      message: `Secondary target [#${nextId}] added: ${text}`,
    };
  }

  /**
   * Update a target (primary or secondary).
   *
   * At least one of `status`, `text`, or `note` should be provided. `status`
   * is optional so a caller can update just the text or note without forcing a
   * (no-op) status change.
   *
   * When the primary (id 0) transitions to a terminal state (completed/failed),
   * auto-continue is turned off.
   */
  async updateStatus(
    sessionId: string,
    id: number,
    status: TargetStatus | undefined,
    note?: string,
    text?: string,
  ): Promise<TargetResult> {
    const state = this.getState(sessionId);

    if (id === PRIMARY_ID) {
      if (!state.primary) {
        return { state, message: "No primary target to update." };
      }
      const prevStatus = state.primary.status;
      if (status !== undefined) state.primary.status = status;
      if (text !== undefined) state.primary.text = text;
      if (note !== undefined) state.primary.note = note;

      // Terminal states turn off auto-continue.
      if (status === "completed" || status === "failed") {
        state.autoContinue = false;
      }

      await this.persist(sessionId, state);
      this.emitChange(sessionId);
      const changed: string[] = [];
      if (status !== undefined) {
        const verb =
          status === "completed" ? "completed"
          : status === "failed" ? "failed"
          : `set to ${status}`;
        changed.push(
          verb + (prevStatus === status ? " (already)" : ""),
        );
      }
      if (text !== undefined) changed.push("text updated");
      if (note) changed.push(note);
      return {
        state,
        message: `Primary target ${changed.join("; ")}`,
      };
    }

    // Secondary target
    const item = state.secondary.find((t) => t.id === id);
    if (!item) {
      return { state, message: `No target with id ${id}.` };
    }
    if (status !== undefined) item.status = status;
    if (text !== undefined) item.text = text;
    if (note !== undefined) item.note = note;

    await this.persist(sessionId, state);
    this.emitChange(sessionId);
    const changed: string[] = [];
    if (status !== undefined) changed.push(`set to ${status}`);
    if (text !== undefined) changed.push("text updated");
    if (note) changed.push(note);
    return {
      state,
      message: `Target [#${id}] ${changed.join("; ")}`,
    };
  }

  /**
   * Replace all targets at once (full overwrite).
   *
   * - When auto-continue is active, the primary target is locked by user and
   *   will NOT be overwritten — only the secondary targets are replaced.
   *   This is the "allow partial failure" behavior: the primary is silently
   *   skipped rather than causing an error.
   * - When auto-continue is off and `primaryText` is provided, both primary
   *   and secondary are replaced.
   * - When `primaryText` is omitted/null, the existing primary is preserved
   *   (only secondary targets are replaced). This prevents accidentally
   *   wiping the primary goal when an agent only wants to update its todos.
   *
   * @param primaryText  New primary target text. If omitted/null, the existing
   *                     primary is preserved.
   * @param secondary    New secondary targets (id auto-assigned 1, 2, 3, …).
   */
  async replaceTargets(
    sessionId: string,
    primaryText: string | null,
    secondary: { text: string; status?: TargetStatus; note?: string }[],
  ): Promise<TargetResult> {
    const state = this.getState(sessionId);
    const skipped: string[] = [];

    // Primary: skip when auto-continue is active (locked by user), or when
    // primaryText is omitted (preserve existing primary — only update secondary).
    if (state.autoContinue) {
      skipped.push("primary (locked by user)");
    } else if (primaryText) {
      state.primary = { id: PRIMARY_ID, text: primaryText, status: "active" };
    }
    // If primaryText is null/undefined and auto-continue is off, the existing
    // primary is preserved (not cleared).

    // Secondary: always fully replaced.
    state.secondary = secondary.map((item, i) => ({
      id: i + 1,
      text: item.text,
      status: item.status ?? "active",
      note: item.note,
    }));

    await this.persist(sessionId, state);
    this.emitChange(sessionId);

    const parts: string[] = [];
    if (skipped.length > 0) {
      parts.push(`Skipped: ${skipped.join(", ")}`);
    }
    parts.push(
      `Replaced ${state.secondary.length} secondary target(s)` +
        (state.primary ? `, primary: "${state.primary.text}"` : ", no primary"),
    );
    return { state, message: parts.join(". ") };
  }

  // ---------------------------------------------------------------------------
  // /goal command operations (user-only)
  // ---------------------------------------------------------------------------

  /**
   * User sets a primary target and activates auto-continue.
   * `/goal <text>` — creates/overwrites the primary, turns auto-continue on.
   */
  async goalSet(sessionId: string, text: string): Promise<TargetResult> {
    const state = this.getState(sessionId);
    state.primary = {
      id: PRIMARY_ID,
      text,
      status: "active",
    };
    state.autoContinue = true;

    await this.persist(sessionId, state);
    this.emitChange(sessionId);
    return {
      state,
      message: `Goal activated: ${text}`,
    };
  }

  /**
   * User turns off auto-continue without clearing the primary target.
   * `/goal off` — the primary target stays, agent can modify it again.
   */
  async goalOff(sessionId: string): Promise<TargetResult> {
    const state = this.getState(sessionId);

    if (!state.autoContinue) {
      return { state, message: "Auto-continue is already off." };
    }

    state.autoContinue = false;

    await this.persist(sessionId, state);
    this.emitChange(sessionId);
    return {
      state,
      message: "Auto-continue turned off. Primary target can now be modified.",
    };
  }

  /**
   * User re-activates auto-continue for an existing primary target.
   * `/goal on` — resets primary to active, turns auto-continue on.
   */
  async goalOn(sessionId: string): Promise<TargetResult> {
    const state = this.getState(sessionId);

    if (!state.primary) {
      return {
        state,
        message: "No primary target set. Use /goal <text> to set one.",
      };
    }

    state.primary.status = "active";
    state.autoContinue = true;

    await this.persist(sessionId, state);
    this.emitChange(sessionId);
    return {
      state,
      message: `Auto-continue activated for: ${state.primary.text}`,
    };
  }

  /**
   * Internally turn off auto-continue (e.g. when user presses Escape).
   * Does NOT persist — callers should persist if needed.
   */
  disableAutoContinue(sessionId: string): void {
    const state = this.getState(sessionId);
    state.autoContinue = false;
  }

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------

  /**
   * Render the full target state as a human-readable string.
   * Used by the `list` action and `/goal` (no args).
   */
  formatState(state: TargetState): string {
    const lines: string[] = [];

    if (!state.primary) {
      lines.push("No primary target set.");
    } else {
      const p = state.primary;
      lines.push(
        `Primary [${p.status}]${state.autoContinue ? " (auto-continue ON)" : ""}: ${p.text}`,
      );
      if (p.note) lines.push(`  note: ${p.note}`);
    }

    if (state.secondary.length > 0) {
      const done = state.secondary.filter((t) => t.status === "completed").length;
      lines.push("");
      lines.push(`Secondary targets (${done}/${state.secondary.length} completed):`);
      for (const item of state.secondary) {
        const mark =
          item.status === "completed"
            ? "✓"
            : item.status === "failed"
              ? "✗"
              : "○";
        lines.push(`  ${mark} [#${item.id}] ${item.text}`);
        if (item.note) lines.push(`      note: ${item.note}`);
      }
    } else if (state.primary) {
      lines.push("");
      lines.push("No secondary targets.");
    }

    return lines.join("\n");
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /**
   * Emit a `pi-atlas:target_changed` event carrying the current TargetState.
   * No-op when no event bus is wired (e.g. unit tests / non-bridge usage).
   * The payload is a deep clone so receivers cannot mutate in-memory state.
   */
  private emitChange(sessionId: string): void {
    if (!this.eventBus) return;
    const state = this.states.get(sessionId);
    if (!state) return;
    this.eventBus.emit(TARGET_CHANGED_CHANNEL, {
      sessionId,
      state: structuredClone(state),
    } satisfies TargetChangedPayload);
  }

  /** Persist in-memory state to disk (fire-and-forget, errors logged). */
  private async persist(
    sessionId: string,
    state: TargetState,
  ): Promise<void> {
    try {
      await saveTargetState(sessionId, state);
    } catch (err) {
      console.error(
        `[pi-atlas] Failed to persist target state: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

/** Singleton — shared across all event handlers and tool calls. */
export const targetManager = new TargetManager();
