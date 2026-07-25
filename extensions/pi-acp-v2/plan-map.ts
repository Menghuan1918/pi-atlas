/**
 * TargetState → ACP plan variant mapping (A2).
 *
 * The bridge subscribes to `pi-atlas:target_changed` (emitted by the target
 * extension's targetManager) and maps each per-session TargetState to the
 * STABLE ACP plan variants sent via `session/update`:
 *
 *   non-empty state → sessionUpdate:"plan_update"
 *                       plan:{ type:"items", planId:"pi-targets",
 *                              entries:[{ content, priority, status, _meta? }] }
 *   empty state      → sessionUpdate:"plan_removed"  (planId:"pi-targets")
 *
 * Mapping reference (verified-reality.md §2.4 STABLE plan, §1.8 TargetState):
 *   primary + each secondary  → one entry (primary first, then secondaries in order)
 *   content  = item.text (+ " — " + note when present)
 *   status   = active→in_progress, completed→completed, failed→cancelled
 *   priority = "medium"  (pi has no priority concept)
 *   _meta    = { id }     (pi target id; lets the client map entries back)
 *   autoContinue is NOT mapped into plan entries (non-essential; A2 leaves it out)
 *
 * ⚠️ Erratum: the A2 spec body (§3/§4) describes `sessionUpdate:"plan"` + bare
 * `entries` + no planId + a `capabilities.plan` gate — all of that is WRONG per
 * verified-reality.md §2.4. The STABLE form is `plan_update`/`plan_removed` with
 * a REQUIRED planId; no capability gating (baseline `session:{}` suffices).
 */
import { TARGET_CHANGED_CHANNEL, type TargetState, type TargetStatus, type TargetItem } from "../target/types.js";
import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";

/** Channel the target extension emits TargetState changes on (shared contract). */
// TARGET_CHANGED_CHANNEL is re-exported from the target types module above.
export { TARGET_CHANGED_CHANNEL };

/** Fixed planId for the pi-targets plan (ACP plan_update requires planId). */
export const PI_TARGETS_PLAN_ID = "pi-targets";

/** A TargetState with no primary and no secondary targets. */
export function isTargetStateEmpty(state: TargetState): boolean {
  return state.primary === null && state.secondary.length === 0;
}

/** Map a pi TargetStatus → ACP PlanEntryStatus. */
export function mapTargetStatus(status: TargetStatus): "in_progress" | "completed" | "cancelled" {
  switch (status) {
    case "active":
      return "in_progress";
    case "completed":
      return "completed";
    case "failed":
      return "cancelled";
  }
}

/** Build the `entries` array for a plan_update (primary first, then secondaries). */
function toEntries(state: TargetState): Array<{
  content: string;
  priority: "medium";
  status: "in_progress" | "completed" | "cancelled";
  _meta: { id: number };
}> {
  const entries: Array<{
    content: string;
    priority: "medium";
    status: "in_progress" | "completed" | "cancelled";
    _meta: { id: number };
  }> = [];
  if (state.primary) entries.push(targetItemToEntry(state.primary));
  for (const item of state.secondary) entries.push(targetItemToEntry(item));
  return entries;
}

/** Map a single TargetItem → an ACP plan entry (content includes note summary). */
function targetItemToEntry(item: TargetItem): {
  content: string;
  priority: "medium";
  status: "in_progress" | "completed" | "cancelled";
  _meta: { id: number };
} {
  const content = item.note ? `${item.text} — ${item.note}` : item.text;
  return {
    content,
    priority: "medium",
    status: mapTargetStatus(item.status),
    _meta: { id: item.id },
  };
}

/** Build the plan_update SessionUpdate for a (non-empty) TargetState — full replace. */
export function toPlanUpdate(state: TargetState): SessionUpdate {
  return {
    sessionUpdate: "plan_update",
    plan: { type: "items", planId: PI_TARGETS_PLAN_ID, entries: toEntries(state) },
  };
}

/** Build the plan_removed SessionUpdate (clear the pi-targets plan). */
export function toPlanRemoved(): SessionUpdate {
  return { sessionUpdate: "plan_removed", planId: PI_TARGETS_PLAN_ID };
}
