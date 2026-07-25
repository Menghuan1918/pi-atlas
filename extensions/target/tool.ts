/**
 * Target tool — unified goal + todo management.
 *
 * Actions:
 *   set             — Set or update the primary target (id 0). Rejected when
 *                     auto-continue is active (primary locked by user).
 *   add             — Add a secondary target. Returns the new id (1, 2, 3, …).
 *   update          — Update the status (and optional note) of any target by id.
 *                     id 0 + completed/failed turns off auto-continue.
 *   update_targets  — Full overwrite of all targets at once. When
 *                     auto-continue is active, the primary is silently skipped
 *                     (locked by user); only secondary targets are replaced.
 *   list            — Show all targets and their current status.
 *
 * Auto-continue is controlled exclusively by the /goal command (user-only).
 * When active, the primary target text is immutable; the agent can still
 * complete/fail it and manage secondary targets freely.
 */

import { StringEnum, Type, type Static } from "@earendil-works/pi-ai";
import type { ToolDefinition, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { targetManager } from "./target-manager.js";

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

const targetParameters = Type.Object({
  action: StringEnum(["set", "add", "update", "update_targets", "list"], {
    description:
      "What to do: 'set' the primary target text, 'add' a secondary target, 'update' a target's status, 'update_targets' to overwrite all targets at once, or 'list' all targets.",
  }),
  text: Type.Optional(
    Type.String({
      description:
        "Target text. Required for 'set' and 'add'. For 'update', replaces the target's text. For 'update_targets', the new primary target text (omit to preserve the existing primary).",
    }),
  ),
  id: Type.Optional(
    Type.Number({
      description:
        "Target id to update. 0 = primary, 1+ = secondary. Required for 'update'.",
    }),
  ),
  status: Type.Optional(
    StringEnum(["active", "completed", "failed"], {
      description: "New status for 'update'. 'completed' or 'failed' are terminal. Optional — omit to update only text/note.",
    }),
  ),
  note: Type.Optional(
    Type.String({
      description: "Optional note for 'update' — completion summary, failure reason, or arbitrary annotation.",
    }),
  ),
  secondary: Type.Optional(
    Type.Array(
      Type.Object({
        text: Type.String({ description: "Target description." }),
        status: Type.Optional(
          StringEnum(["active", "completed", "failed"], {
            description: "Target status. Default: 'active'.",
          }),
        ),
        note: Type.Optional(
          Type.String({ description: "Optional note." }),
        ),
      }),
      { description: "Full list of secondary targets for 'update_targets'." },
    ),
  ),
});

type TargetParams = Static<typeof targetParameters>;

interface TargetToolDetails {
  action: string;
  primaryStatus: string | null;
  autoContinue: boolean;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const targetTool: ToolDefinition<typeof targetParameters, TargetToolDetails> =
  {
    name: "Target",
    label: "Target",
    description:
      "Manage targets — a unified goal and todo system. " +
      "Set a primary target (id 0) that defines what to achieve, and add " +
      "secondary targets (id 1+) to track progress. " +
      "When auto-continue is active (set by user via /goal), the primary " +
      "target is locked: use 'update' with status 'completed' or 'failed' " +
      "to finish it and turn off auto-continue.",
    promptSnippet:
      "Set primary target, add/update targets, full overwrite, or list all targets",
    promptGuidelines: [
      "Use Target(action: 'set', text: '...') to define the primary goal — what the user ultimately wants achieved.",
      "Use Target(action: 'add', text: '...') to break the goal into trackable sub-tasks.",
      "Use Target(action: 'update_targets', text: '...', secondary: [{text: '...', status: '...'}, ...]) to replace all targets at once. Omit text to update only secondary targets (existing primary is preserved).",
      "Use Target(action: 'update', id: <id>, status: 'completed') to mark a target done. For id 0, this also stops auto-continue. status is optional — you can also update just text or note.",
      "Use Target(action: 'update', id: 0, status: 'failed', note: '...') if the goal cannot be achieved.",
      "Use Target(action: 'list') to review all targets and their current status.",
    ],
    parameters: targetParameters,

    async execute(
      _toolCallId: string,
      params: TargetParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<{
      content: { type: "text"; text: string }[];
      details: TargetToolDetails;
      isError?: boolean;
    }> {
      const sessionId = ctx.sessionManager.getSessionId();
      const { action } = params;

      // ---- list ----
      if (action === "list") {
        const state = targetManager.getState(sessionId);
        const text = targetManager.formatState(state);
        return {
          content: [{ type: "text", text }],
          details: {
            action,
            primaryStatus: state.primary?.status ?? null,
            autoContinue: state.autoContinue,
          },
        };
      }

      // ---- set ----
      if (action === "set") {
        if (!params.text?.trim()) {
          return {
            isError: true,
            content: [
              { type: "text", text: "Error: 'text' is required for 'set'." },
            ],
            details: {
              action,
              primaryStatus: targetManager.getState(sessionId).primary?.status ?? null,
              autoContinue: targetManager.getState(sessionId).autoContinue,
            },
          };
        }
        const result = await targetManager.setPrimary(sessionId, params.text);
        return {
          content: [{ type: "text", text: result.message }],
          details: {
            action,
            primaryStatus: result.state.primary?.status ?? null,
            autoContinue: result.state.autoContinue,
          },
        };
      }

      // ---- add ----
      if (action === "add") {
        if (!params.text?.trim()) {
          return {
            isError: true,
            content: [
              { type: "text", text: "Error: 'text' is required for 'add'." },
            ],
            details: {
              action,
              primaryStatus: targetManager.getState(sessionId).primary?.status ?? null,
              autoContinue: targetManager.getState(sessionId).autoContinue,
            },
          };
        }
        const result = await targetManager.addSecondary(sessionId, params.text);
        return {
          content: [{ type: "text", text: result.message }],
          details: {
            action,
            primaryStatus: result.state.primary?.status ?? null,
            autoContinue: result.state.autoContinue,
          },
        };
      }

      // ---- update ----
      if (action === "update") {
        if (params.id === undefined) {
          return {
            isError: true,
            content: [
              { type: "text", text: "Error: 'id' is required for 'update'." },
            ],
            details: {
              action,
              primaryStatus: targetManager.getState(sessionId).primary?.status ?? null,
              autoContinue: targetManager.getState(sessionId).autoContinue,
            },
          };
        }
        if (params.status === undefined && params.text === undefined && params.note === undefined) {
          return {
            isError: true,
            content: [
              { type: "text", text: "Error: 'update' needs at least one of 'status', 'text', or 'note'." },
            ],
            details: {
              action,
              primaryStatus: targetManager.getState(sessionId).primary?.status ?? null,
              autoContinue: targetManager.getState(sessionId).autoContinue,
            },
          };
        }
        const result = await targetManager.updateStatus(
          sessionId,
          params.id,
          params.status as "active" | "completed" | "failed" | undefined,
          params.note,
          params.text,
        );
        return {
          content: [{ type: "text", text: result.message }],
          details: {
            action,
            primaryStatus: result.state.primary?.status ?? null,
            autoContinue: result.state.autoContinue,
          },
        };
      }

      // ---- update_targets (full overwrite) ----
      if (action === "update_targets") {
        const result = await targetManager.replaceTargets(
          sessionId,
          params.text ?? null,
          (params.secondary ?? []).map((s) => ({
            text: s.text,
            status: s.status as "active" | "completed" | "failed" | undefined,
            note: s.note,
          })),
        );
        return {
          content: [{ type: "text", text: result.message }],
          details: {
            action,
            primaryStatus: result.state.primary?.status ?? null,
            autoContinue: result.state.autoContinue,
          },
        };
      }

      // Should be unreachable due to StringEnum, but TypeScript needs it.
      return {
        content: [{ type: "text", text: `Unknown action: ${action}` }],
        details: {
          action,
          primaryStatus: null,
          autoContinue: false,
        },
      };
    },
  };
