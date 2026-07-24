/**
 * Target extension entry point.
 *
 * Registers:
 *   - The `Target` tool (set / add / update / list)
 *   - The `/goal` command (user-only: set primary target + activate auto-continue)
 *   - session_start → restore persisted target state
 *   - session_shutdown → clear in-memory state
 *
 * The `agent_settled` guard (auto-continue) is handled by the separate
 * `guard` extension to coordinate priority with the task guard.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { targetManager } from "./target-manager.js";
import { targetTool } from "./tool.js";

export default function targetExtension(pi: ExtensionAPI): void {
  // ── Tools ───────────────────────────────────────────────────────────
  pi.registerTool(targetTool);

  // ── Events ──────────────────────────────────────────────────────────

  // session_start: restore persisted target state from disk.
  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    await targetManager.restoreSession(sessionId);
  });

  // session_shutdown: clear in-memory state (already persisted on mutation).
  pi.on("session_shutdown", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    targetManager.clearSession(sessionId);
  });

  // ── /goal command ──────────────────────────────────────────────────
  pi.registerCommand("goal", {
    description: "Set, show, or toggle the primary target + auto-continue",
    handler: async (args, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const trimmed = args.trim();

      // /goal off — turn off auto-continue (primary target stays).
      if (trimmed === "off") {
        const result = await targetManager.goalOff(sessionId);
        ctx.ui.notify(result.message, "info");
        return;
      }

      // /goal on — re-activate auto-continue for existing primary target.
      if (trimmed === "on") {
        const result = await targetManager.goalOn(sessionId);
        ctx.ui.notify(result.message, "info");
        return;
      }

      // /goal <text> — set primary target and activate auto-continue.
      if (trimmed) {
        const result = await targetManager.goalSet(sessionId, trimmed);
        ctx.ui.notify(result.message, "info");
        return;
      }

      // /goal (no args) — show current status.
      const state = targetManager.getState(sessionId);
      const text = targetManager.formatState(state);
      ctx.ui.notify(text, "info");
    },
  });
}

// Re-export public API for consumers and testing.
export { targetManager } from "./target-manager.js";
export { targetTool } from "./tool.js";
export { createTargetGuardHandler, wasLastTurnAborted } from "./guard.js";
export type { TargetItem, TargetState, TargetStatus } from "./types.js";
