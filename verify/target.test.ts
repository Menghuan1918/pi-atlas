/**
 * Target tool + manager unit tests.
 *
 * Tests the TargetManager state logic and the Target tool execute handler
 * in isolation (no pi runtime, no LLM, no TUI).
 *
 * Run: npx tsx verify/target.test.ts
 */

import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { rmSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { targetManager } from "../packages/base/extensions/target/target-manager.js";
import { targetTool } from "../packages/base/extensions/target/tool.js";
import { getStatePath } from "../packages/base/extensions/target/persistence.js";

let pass = 0;
let fail = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.error(`  ✗ ${msg}`);
  }
}

// Isolate storage to a temp dir.
const tmpDir = mkdtempSync(join(tmpdir(), "target-test-"));
process.env.PI_ATLAS_DIR = tmpDir;

const sessionId = "target-unit";

// Mock ExtensionContext — only needs sessionId.
const ctx = {
  sessionManager: { getSessionId: () => sessionId },
} as unknown as ExtensionContext;

// Helper: call the tool and extract text.
async function callTool(params: Record<string, unknown>): Promise<string> {
  const result = await targetTool.execute(
    "test-call-id",
    params as any,
    undefined,
    undefined,
    ctx,
  );
  return result.content[0]?.type === "text" ? result.content[0].text : "";
}

// Helper: call the tool and get details too.
async function callToolFull(
  params: Record<string, unknown>,
): Promise<{ text: string; details: any }> {
  const result = await targetTool.execute(
    "test-call-id",
    params as any,
    undefined,
    undefined,
    ctx,
  );
  return {
    text: result.content[0]?.type === "text" ? result.content[0].text : "",
    details: result.details,
  };
}

async function main(): Promise<void> {
  await targetManager.restoreSession(sessionId);

  console.log("Target tool + manager tests\n");

  // ── set ──────────────────────────────────────────────────────────
  console.log("set action:");
  let text = await callTool({ action: "set", text: "Refactor auth module" });
  assert(text.includes("Primary target set"), "set creates primary target");
  assert(
    targetManager.getState(sessionId).primary?.text === "Refactor auth module",
    "primary text stored correctly",
  );
  assert(
    targetManager.getState(sessionId).primary?.status === "active",
    "primary starts as active",
  );
  assert(
    targetManager.getState(sessionId).autoContinue === true,
    "set activates goal mode (auto-continue)",
  );
  assert(
    targetManager.getState(sessionId).askUserTimeoutCap === false,
    "set → goal mode, not goal-auto (no ask_user timeout cap)",
  );
  assert(
    targetManager.isAutoContinueActive(sessionId) === true,
    "set → auto-continue active",
  );

  // set again while goal mode active → rejected (primary locked)
  text = await callTool({ action: "set", text: "Refactor auth v2" });
  assert(text.includes("locked by user"), "set rejected while goal mode active");
  assert(
    targetManager.getState(sessionId).primary?.text === "Refactor auth module",
    "primary text unchanged when locked",
  );

  // goalOff, then set again → allowed, re-enters goal mode
  await targetManager.goalOff(sessionId);
  text = await callTool({ action: "set", text: "Refactor auth v2" });
  assert(text.includes("Primary target set"), "set works after goalOff");
  assert(
    targetManager.getState(sessionId).primary?.text === "Refactor auth v2",
    "primary text updated",
  );
  assert(
    targetManager.isAutoContinueActive(sessionId) === true,
    "set after goalOff re-enters goal mode",
  );
  await targetManager.goalOff(sessionId);

  // ── add ──────────────────────────────────────────────────────────
  console.log("\nadd action:");
  text = await callTool({ action: "add", text: "Analyze current code" });
  assert(text.includes("[#1]"), "add returns id 1 for first secondary");
  text = await callTool({ action: "add", text: "Write tests" });
  assert(text.includes("[#2]"), "add returns id 2 for second secondary");
  assert(
    targetManager.getState(sessionId).secondary.length === 2,
    "two secondary targets stored",
  );

  // ── list ─────────────────────────────────────────────────────────
  console.log("\nlist action:");
  text = await callTool({ action: "list" });
  assert(text.includes("Primary"), "list shows primary");
  assert(text.includes("[#1]"), "list shows secondary #1");
  assert(text.includes("[#2]"), "list shows secondary #2");

  // ── update secondary ──────────────────────────────────────────────
  console.log("\nupdate secondary:");
  text = await callTool({ action: "update", id: 1, status: "completed" });
  assert(text.includes("[#1]"), "update returns target id");
  assert(
    targetManager.getState(sessionId).secondary[0]?.status === "completed",
    "secondary #1 marked completed",
  );

  text = await callTool({ action: "update", id: 2, status: "completed", note: "All done" });
  assert(
    targetManager.getState(sessionId).secondary[1]?.note === "All done",
    "update stores note",
  );

  // update non-existent
  text = await callTool({ action: "update", id: 99, status: "completed" });
  assert(text.includes("No target"), "update non-existent returns error");

  // ── /goal via manager (auto-continue lock) ───────────────────────
  console.log("\n/goal (auto-continue):");
  await targetManager.goalSet(sessionId, "Build feature X");
  const state = targetManager.getState(sessionId);
  assert(state.autoContinue === true, "goalSet activates auto-continue");
  assert(state.primary?.text === "Build feature X", "goalSet sets primary text");

  // set should be rejected when auto-continue is on
  text = await callTool({ action: "set", text: "Something else" });
  assert(text.includes("locked by user"), "set rejected during auto-continue");
  assert(
    targetManager.getState(sessionId).primary?.text === "Build feature X",
    "primary text unchanged when locked",
  );

  // add should still work during auto-continue
  text = await callTool({ action: "add", text: "Step 1" });
  assert(text.includes("[#3]"), "add works during auto-continue (continues id sequence)");

  // ── /goal off ────────────────────────────────────────────────────
  console.log("\n/goal off:");
  await targetManager.goalOff(sessionId);
  assert(
    targetManager.getState(sessionId).autoContinue === false,
    "goalOff disables auto-continue",
  );
  assert(
    targetManager.getState(sessionId).primary !== null,
    "goalOff keeps primary target",
  );

  // set should work again after off
  text = await callTool({ action: "set", text: "New primary" });
  assert(text.includes("Primary target set"), "set works after goalOff");

  // ── /goal on (re-activate) ───────────────────────────────────────
  console.log("\n/goal on (re-activate):");
  // First, complete the primary
  await callTool({ action: "update", id: 0, status: "completed" });
  assert(
    targetManager.getState(sessionId).primary?.status === "completed",
    "primary completed before goalOn test",
  );

  // goalOn should reset to active and re-enable auto-continue
  const result = await targetManager.goalOn(sessionId);
  const state2 = targetManager.getState(sessionId);
  assert(state2.autoContinue === true, "goalOn re-activates auto-continue");
  assert(
    state2.primary?.status === "active",
    "goalOn resets primary status to active",
  );
  assert(
    result.message.includes("New primary"),
    "goalOn preserves primary text",
  );

  // goalOn with no primary — need to delete the persisted state file too,
  // otherwise restoreSession reloads the old primary from disk.
  const { unlinkSync } = await import("node:fs");
  targetManager.clearSession(sessionId);
  try { unlinkSync(getStatePath(sessionId)); } catch { /* may not exist */ }
  await targetManager.restoreSession(sessionId);
  const r2 = await targetManager.goalOn(sessionId);
  assert(
    r2.message.includes("No primary target"),
    "goalOn with no primary shows hint",
  );

  // ── update primary to completed disables auto-continue ───────────
  console.log("\nupdate primary → terminal disables auto-continue:");
  await targetManager.goalSet(sessionId, "Final goal");
  assert(
    targetManager.isAutoContinueActive(sessionId) === true,
    "auto-continue active after goalSet",
  );
  await callTool({ action: "update", id: 0, status: "completed", note: "Done!" });
  assert(
    targetManager.isAutoContinueActive(sessionId) === false,
    "auto-continue off after primary completed",
  );
  assert(
    targetManager.getState(sessionId).primary?.note === "Done!",
    "primary note stored",
  );

  // ── update primary to failed disables auto-continue ───────────────
  await targetManager.goalSet(sessionId, "Another goal");
  await callTool({ action: "update", id: 0, status: "failed", note: "Blocked" });
  assert(
    targetManager.isAutoContinueActive(sessionId) === false,
    "auto-continue off after primary failed",
  );

  // ── update_targets (full overwrite) ─────────────────────────────
  console.log("\nupdate_targets (full overwrite):");
  targetManager.clearSession(sessionId);
  try { unlinkSync(getStatePath(sessionId)); } catch { /* may not exist */ }
  await targetManager.restoreSession(sessionId);

  // Full replace: primary + 3 secondary
  text = await callTool({
    action: "update_targets",
    text: "Overwrite primary",
    secondary: [
      { text: "Task A", status: "active" },
      { text: "Task B", status: "completed" },
      { text: "Task C", status: "failed", note: "blocked" },
    ],
  });
  const st = targetManager.getState(sessionId);
  assert(st.primary?.text === "Overwrite primary", "update_targets sets primary");
  assert(st.secondary.length === 3, "update_targets sets 3 secondary");
  assert(st.secondary[0]?.id === 1, "secondary #1 id = 1");
  assert(st.secondary[1]?.status === "completed", "secondary #2 status = completed");
  assert(st.secondary[2]?.note === "blocked", "secondary #3 note preserved");
  assert(st.autoContinue === true, "update_targets with text enters goal mode");
  assert(st.askUserTimeoutCap === false, "update_targets → goal mode, not goal-auto");

  // Replace: omit text → preserve existing primary, replace secondary
  text = await callTool({
    action: "update_targets",
    secondary: [{ text: "Only secondary" }],
  });
  assert(
    targetManager.getState(sessionId).primary?.text === "Overwrite primary",
    "update_targets preserves primary when no text",
  );
  assert(
    targetManager.getState(sessionId).secondary.length === 1,
    "update_targets replaces secondary",
  );

  // ── update_targets: auto-continue skips primary (partial failure) ──
  console.log("\nupdate_targets (auto-continue skips primary):");
  await targetManager.goalSet(sessionId, "Locked goal");
  const lockedPrimary = targetManager.getState(sessionId).primary?.text;
  text = await callTool({
    action: "update_targets",
    text: "Should be skipped",
    secondary: [{ text: "New task" }, { text: "Another task" }],
  });
  assert(
    text.includes("Skipped") && text.includes("primary"),
    "update_targets reports primary was skipped",
  );
  assert(
    targetManager.getState(sessionId).primary?.text === lockedPrimary,
    "primary unchanged when auto-continue active",
  );
  assert(
    targetManager.getState(sessionId).secondary.length === 2,
    "secondary still replaced when auto-continue active",
  );

  // ── validation errors ─────────────────────────────────────────────
  console.log("\nvalidation:");
  text = await callTool({ action: "set" });
  assert(text.includes("Error"), "set without text returns error");

  text = await callTool({ action: "add" });
  assert(text.includes("Error"), "add without text returns error");

  text = await callTool({ action: "update", status: "completed" });
  assert(text.includes("Error"), "update without id returns error");

  // update with nothing to change → error
  text = await callTool({ action: "update", id: 0 });
  assert(text.includes("Error"), "update with nothing to change returns error");

  // ── update text-only and note-only (status optional) ───────────
  console.log("\nupdate text/note only:");
  await targetManager.goalOff(sessionId); // unlock before agent set
  await callTool({ action: "set", text: "Original primary" });
  // note-only: no status needed
  text = await callTool({ action: "update", id: 0, note: "just a note" });
  assert(
    targetManager.getState(sessionId).primary?.note === "just a note",
    "update note-only without status",
  );
  // text-only: updates the text, keeps status
  const beforeStatus = targetManager.getState(sessionId).primary?.status;
  text = await callTool({ action: "update", id: 0, text: "Updated primary" });
  assert(
    targetManager.getState(sessionId).primary?.text === "Updated primary",
    "update text-only changes text",
  );
  assert(
    targetManager.getState(sessionId).primary?.status === beforeStatus,
    "update text-only preserves status",
  );
  // secondary text-only
  await callTool({ action: "add", text: "Original secondary" });
  text = await callTool({ action: "update", id: 1, text: "Updated secondary" });
  assert(
    targetManager.getState(sessionId).secondary[0]?.text === "Updated secondary",
    "update text-only on secondary",
  );

  // ── details check ─────────────────────────────────────────────────
  console.log("\ndetails:");
  targetManager.clearSession(sessionId);
  try { unlinkSync(getStatePath(sessionId)); } catch { /* may not exist */ }
  await targetManager.restoreSession(sessionId);
  const full = await callToolFull({ action: "set", text: "Test details" });
  assert(
    full.details.primaryStatus === "active",
    "details.primaryStatus correct",
  );
  assert(
    full.details.autoContinue === true,
    "details.autoContinue true for set (goal mode)",
  );

  await targetManager.goalSet(sessionId, "Test details");
  const full2 = await callToolFull({ action: "list" });
  assert(
    full2.details.autoContinue === true,
    "details.autoContinue true after goalSet",
  );

  // ── goal-auto mode (ask_user timeout cap) ────────────────────────────
  console.log("\ngoal-auto mode (askUserTimeoutCap):");
  await targetManager.goalSet(sessionId, "Auto goal", true);
  assert(
    targetManager.isAskUserTimeoutCapped(sessionId) === true,
    "goalSet(..., true) → goal-auto (cap on)",
  );
  assert(
    targetManager.getState(sessionId).askUserTimeoutCap === true,
    "askUserTimeoutCap persisted in state",
  );
  await targetManager.goalSet(sessionId, "Plain goal", false);
  assert(
    targetManager.isAskUserTimeoutCapped(sessionId) === false,
    "goalSet(..., false) → goal mode (cap off)",
  );
  await targetManager.goalSet(sessionId, "Auto again", true);
  await targetManager.goalOff(sessionId);
  assert(
    targetManager.isAskUserTimeoutCapped(sessionId) === false,
    "cap not effective when auto-continue off",
  );

  // Cleanup
  rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
