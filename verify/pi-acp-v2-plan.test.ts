/**
 * Unit tests for the A2 plan_update bridge:
 *   - TargetState → ACP plan variant mapping (plan-map.ts)
 *   - target extension emit wiring (target-manager emits target_changed)
 *
 * No model, no ACP transport. Pure mapping + target-manager event emission
 * over a real EventBus. PI_ATLAS_DIR is isolated to a temp dir.
 *
 * Run: tsx verify/pi-acp-v2-plan.test.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";

import {
  PI_TARGETS_PLAN_ID,
  TARGET_CHANGED_CHANNEL,
  isTargetStateEmpty,
  mapTargetStatus,
  toPlanRemoved,
  toPlanUpdate,
} from "../extensions/pi-acp-v2/plan-map.js";
import { targetManager } from "../extensions/target/target-manager.js";
import { defaultTargetState, type TargetState } from "../extensions/target/types.js";

let pass = 0;
let fail = 0;
function check(cond: unknown, msg: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.error(`  ✗ ${msg}`);
  }
}

// Isolate pi-atlas storage (target state.json) to a temp dir.
const tmpAtlas = mkdtempSync(join(tmpdir(), "pi-acp-plan-"));
process.env.PI_ATLAS_DIR = tmpAtlas;

// ---- helpers ---------------------------------------------------------------

interface Emitted {
  sessionId: string;
  state: TargetState;
}

/** Wire a recorder onto a fresh EventBus + inject it into the singleton. */
function wireRecorder(): { emitted: Emitted[]; bus: ReturnType<typeof createEventBus> } {
  const emitted: Emitted[] = [];
  const bus = createEventBus();
  bus.on(TARGET_CHANGED_CHANNEL, (data) => {
    const d = data as Emitted;
    emitted.push({ sessionId: d.sessionId, state: structuredClone(d.state) });
  });
  targetManager.setEventBus(bus);
  return { emitted, bus };
}

async function main(): Promise<void> {
  // ── mapping: isTargetStateEmpty ───────────────────────────────────────
  console.log("isTargetStateEmpty");
  check(isTargetStateEmpty(defaultTargetState()) === true, "default state is empty");
  check(
    isTargetStateEmpty({ primary: { id: 0, text: "p", status: "active" }, secondary: [], autoContinue: false }) === false,
    "state with primary is not empty",
  );
  check(
    isTargetStateEmpty({ primary: null, secondary: [{ id: 1, text: "s", status: "active" }], autoContinue: false }) === false,
    "state with secondary only is not empty",
  );

  // ── mapping: mapTargetStatus ──────────────────────────────────────────
  console.log("mapTargetStatus");
  check(mapTargetStatus("active") === "in_progress", "active→in_progress");
  check(mapTargetStatus("completed") === "completed", "completed→completed");
  check(mapTargetStatus("failed") === "cancelled", "failed→cancelled");

  // ── mapping: toPlanUpdate ─────────────────────────────────────────────
  console.log("toPlanUpdate");
  {
    const state: TargetState = {
      primary: { id: 0, text: "Build feature", status: "active", note: "do it well" },
      secondary: [
        { id: 1, text: "step one", status: "completed" },
        { id: 2, text: "step two", status: "failed", note: "blocked" },
      ],
      autoContinue: true,
    };
    const u = toPlanUpdate(state) as {
      sessionUpdate: string;
      plan: { type: string; planId: string; entries: Array<{ content: string; priority: string; status: string; _meta?: { id: number } }> };
    };
    check(u.sessionUpdate === "plan_update", "sessionUpdate=plan_update");
    check(u.plan.type === "items", "plan.type=items");
    check(u.plan.planId === PI_TARGETS_PLAN_ID, `plan.planId=${PI_TARGETS_PLAN_ID}`);
    check(u.plan.planId === "pi-targets", "planId literal pi-targets");
    check(u.plan.entries.length === 3, "3 entries (primary + 2 secondary)");
    // primary first
    check(u.plan.entries[0].content === "Build feature — do it well", "primary content = text + note");
    check(u.plan.entries[0].status === "in_progress", "primary active→in_progress");
    check(u.plan.entries[0].priority === "medium", "priority=medium");
    check(u.plan.entries[0]._meta?.id === 0, "primary _meta.id=0");
    // secondary order preserved, statuses mapped
    check(u.plan.entries[1].content === "step one", "secondary 1 content");
    check(u.plan.entries[1].status === "completed", "secondary completed→completed");
    check(u.plan.entries[1]._meta?.id === 1, "secondary 1 _meta.id=1");
    check(u.plan.entries[2].content === "step two — blocked", "secondary 2 content = text + note");
    check(u.plan.entries[2].status === "cancelled", "secondary failed→cancelled");
    check(u.plan.entries[2]._meta?.id === 2, "secondary 2 _meta.id=2");
    // autoContinue is NOT mapped into entries
    const hasAuto = u.plan.entries.some((e) => "autoContinue" in e || (e._meta && "autoContinue" in e._meta));
    check(!hasAuto, "autoContinue not in entries");
  }

  // ── mapping: toPlanUpdate primary=null ───────────────────────────────
  console.log("toPlanUpdate (primary=null, secondary only)");
  {
    const state: TargetState = {
      primary: null,
      secondary: [{ id: 1, text: "only", status: "active" }],
      autoContinue: false,
    };
    const u = toPlanUpdate(state) as { plan: { entries: Array<{ content: string; _meta?: { id: number } }> } };
    check(u.plan.entries.length === 1, "1 entry (secondary only)");
    check(u.plan.entries[0].content === "only", "secondary content");
    check(u.plan.entries[0]._meta?.id === 1, "secondary _meta.id=1");
  }

  // ── mapping: toPlanRemoved ───────────────────────────────────────────
  console.log("toPlanRemoved");
  {
    const u = toPlanRemoved() as { sessionUpdate: string; planId: string };
    check(u.sessionUpdate === "plan_removed", "sessionUpdate=plan_removed");
    check(u.planId === PI_TARGETS_PLAN_ID, `planId=${PI_TARGETS_PLAN_ID}`);
  }

  // ── target extension emit wiring ─────────────────────────────────────
  console.log("target extension emit wiring");
  const sid = "plan-unit-session";
  const { emitted } = wireRecorder();
  // clearSession first to start clean (singleton may carry state from prior files — N/A here, but safe)
  targetManager.clearSession(sid);

  // setPrimary → emits, payload = current state (clone)
  await targetManager.setPrimary(sid, "primary goal");
  check(emitted.length === 1, `setPrimary emits once (got ${emitted.length})`);
  check(emitted[0].sessionId === sid, "emit payload sessionId matches");
  check(emitted[0].state.primary?.text === "primary goal", "emit payload state.primary.text");
  check(emitted[0].state.primary?.status === "active", "emit payload state.primary.status=active");
  check(emitted[0].state.autoContinue === false, "autoContinue=false after setPrimary");
  // payload is a clone: mutating it must not affect the manager's in-memory state
  emitted[0].state.primary!.text = "MUTATED";
  check(targetManager.getState(sid).primary?.text === "primary goal", "emit payload is a deep clone (manager unaffected)");

  // addSecondary → emits, state reflects new secondary
  await targetManager.addSecondary(sid, "sub one");
  check(emitted.length === 2, "addSecondary emits");
  check(emitted[1].state.secondary.length === 1, "emit state has 1 secondary");
  check(emitted[1].state.secondary[0].text === "sub one", "emit secondary text");

  // updateStatus (secondary → completed) → emits
  await targetManager.updateStatus(sid, 1, "completed");
  check(emitted.length === 3, "updateStatus emits");
  check(emitted[2].state.secondary[0].status === "completed", "emit reflects status update");

  // updateStatus (primary → failed, note) → emits + autoContinue stays off
  await targetManager.updateStatus(sid, 0, "failed", "could not");
  check(emitted.length === 4, "updateStatus(primary) emits");
  check(emitted[3].state.primary?.status === "failed", "emit primary status=failed");
  check(emitted[3].state.primary?.note === "could not", "emit primary note");

  // replaceTargets → emits full state
  await targetManager.replaceTargets(sid, "new primary", [{ text: "a", status: "active" }, { text: "b", status: "completed" }]);
  check(emitted.length === 5, "replaceTargets emits");
  check(emitted[4].state.primary?.text === "new primary", "emit replaced primary");
  check(emitted[4].state.secondary.length === 2, "emit replaced secondaries");

  // /goal path: goalSet → emits (autoContinue=true)
  await targetManager.goalSet(sid, "goal via command");
  check(emitted.length === 6, "goalSet emits");
  check(emitted[5].state.autoContinue === true, "goalSet sets autoContinue=true");
  check(emitted[5].state.primary?.text === "goal via command", "goalSet primary text");

  // setPrimary while auto-continue locked → NO state change → NO emit
  await targetManager.setPrimary(sid, "should be rejected");
  check(emitted.length === 6, "setPrimary while locked does NOT emit (no state change)");
  check(targetManager.getState(sid).primary?.text === "goal via command", "locked setPrimary left primary unchanged");

  // goalOff → emits (autoContinue=false)
  await targetManager.goalOff(sid);
  check(emitted.length === 7, "goalOff emits");
  check(emitted[6].state.autoContinue === false, "goalOff sets autoContinue=false");

  // goalOn → emits (primary active, autoContinue=true)
  await targetManager.goalOn(sid);
  check(emitted.length === 8, "goalOn emits");
  check(emitted[7].state.autoContinue === true, "goalOn sets autoContinue=true");
  check(emitted[7].state.primary?.status === "active", "goalOn resets primary to active");

  // no eventBus → emit is a no-op (does not throw)
  targetManager.setEventBus(undefined as unknown as ReturnType<typeof createEventBus>);
  await targetManager.setPrimary(sid, "after unwire");
  check(emitted.length === 8, "emit is a no-op when eventBus is unset");

  targetManager.clearSession(sid);
}

main()
  .then(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
