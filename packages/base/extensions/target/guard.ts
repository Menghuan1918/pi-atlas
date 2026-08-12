/**
 * Target guard — auto-continue mechanism.
 *
 * When auto-continue is active and the primary target is still `active`,
 * the guard injects a continuation message on `agent_settled` to keep the
 * agent working until the target is completed or failed.
 *
 * Guard priority (handled in the guard extension, not here):
 *   1. Escape (aborted) → disable auto-continue, stop.
 *   2. Background tasks running → task guard takes priority, skip target guard.
 *   3. auto-continue active → inject continuation message.
 *
 * The continuation message is appended as a new user message at the tail of
 * the conversation (via `pi.sendUserMessage`), so it never touches the system
 * prompt and does not break API prefix caching.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { targetManager } from "./target-manager.js";
import type { TargetState } from "./types.js";

/**
 * Check whether the last assistant message was aborted (user pressed Escape).
 *
 * In pi, pressing Escape aborts the current turn, resulting in an assistant
 * message with `stopReason === "aborted"`.
 */
export function wasLastTurnAborted(ctx: ExtensionContext): boolean {
  const entries = ctx.sessionManager.getBranch();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "message" && entry.message.role === "assistant") {
      return entry.message.stopReason === "aborted";
    }
  }
  return false;
}

/**
 * Build the continuation message injected on `agent_settled`.
 *
 * Includes a completion audit (inspired by codex's continuation.md but
 * without token budgets or turn limits — pure KISS).
 */
function buildContinuationMessage(state: TargetState): string {
  const lines: string[] = [
    "You are working toward a target that is not yet complete.",
    "",
    `Target: ${state.primary?.text ?? "(none)"}`,
  ];

  if (state.secondary.length > 0) {
    lines.push("", "Current progress:");
    for (const item of state.secondary) {
      const mark =
        item.status === "completed" ? "✓" : item.status === "failed" ? "✗" : "○";
      lines.push(`  ${mark} [#${item.id}] ${item.text} (${item.status})`);
    }
  }

  lines.push(
    "",
    "Before finishing, audit whether this target is truly complete:",
    "- Derive concrete requirements from the target text above.",
    "- Verify each requirement against real state (files, test results, command output).",
    "- Do not rely on memory — check the actual state.",
    "- Uncertain or indirect evidence means NOT complete.",
    "- The audit must PROVE completion, not merely fail to find remaining work.",
    "",
    'If the target is fully achieved, call Target(action: "update", id: 0, status: "completed", note: "...").',
    "If you strongly need human input, or the target cannot be achieved, do NOT leave it open — ",
    'call Target(action: "update", id: 0, status: "failed", note: "<reason>") directly.',
    "An open primary target means the session keeps auto-resuming; it can only end when the target",
    "reaches a terminal state (completed or failed) — unless the user interrupts.",
    "Otherwise, continue working toward it.",
  );

  return lines.join("\n");
}

/**
 * Create the target guard handler for `agent_settled`.
 *
 * Returns a function suitable for `pi.on("agent_settled", handler)`.
 *
 * The caller (guard extension) is responsible for checking background tasks
 * before calling this handler — if tasks are running, the caller skips this
 * handler so the task guard takes priority.
 */
export function createTargetGuardHandler(
  pi: ExtensionAPI,
): (event: { type: "agent_settled" }, ctx: ExtensionContext) => void {
  // Prevents double-injection within the same synchronous settle event.
  let injecting = false;

  return (_event, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();

    // Non-interactive modes: skip.
    if (ctx.mode === "print" || ctx.mode === "json") return;

    // Check Escape (aborted) — disable auto-continue.
    if (wasLastTurnAborted(ctx)) {
      if (targetManager.isAutoContinueActive(sessionId)) {
        targetManager.disableAutoContinue(sessionId);
        // Persist the state change (fire-and-forget).
        const state = targetManager.getState(sessionId);
        void import("./persistence.js").then(({ saveTargetState }) =>
          saveTargetState(sessionId, state),
        );
        try {
          // Deliver the notice WITHOUT starting a new turn: `sendUserMessage`
          // always triggers a turn when the agent is idle, which would look
          // like the agent auto-resuming right after an abort (and the LLM may
          // even "continue working" in response). A display-only custom
          // message keeps the agent truly idle — abort is the human taking
          // over — while still telling the user how to resume.
          pi.sendMessage(
            {
              customType: "target-pause",
              content:
                "Auto-continue stopped (interrupted). The primary target is still set — you can resume with /goal on.",
              display: true,
            },
            { triggerTurn: false },
          );
        } catch {
          // Ignore injection errors — the state change is what matters.
        }
      }
      return;
    }

    // Check if auto-continue should fire.
    if (!targetManager.isAutoContinueActive(sessionId)) {
      injecting = false;
      return;
    }

    if (injecting) return;

    injecting = true;
    const state = targetManager.getState(sessionId);
    const message = buildContinuationMessage(state);
    try {
      // followUp: delivered after the agent finishes current work.
      // triggerTurn is implicit for sendUserMessage (always triggers a turn).
      pi.sendUserMessage(message, { deliverAs: "followUp" });
    } catch (err) {
      console.error(
        `[pi-atlas] Target guard injection failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      injecting = false;
    }
  };
}
