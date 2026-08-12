/**
 * /goal command handler tests.
 *
 * Verifies that `/goal <text>` and `/goal on` immediately send the goal as a
 * user message when the agent is idle (so the agent starts working right away),
 * and that no message is sent when the agent is streaming (the guard handles
 * continuation on the next agent_settled instead).
 *
 * Run: npx tsx verify/goal-command.test.ts
 */

import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import targetExtension from "../packages/base/extensions/target/index.js";
import { targetManager } from "../packages/base/extensions/target/target-manager.js";

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
const tmpDir = mkdtempSync(join(tmpdir(), "goal-cmd-test-"));
process.env.PI_ATLAS_DIR = tmpDir;

const sessionId = "goal-cmd-unit";

interface Sent {
  content: string;
  opts?: { deliverAs?: string };
}

/**
 * Minimal mock pi: captures the registered `/goal` + `/goal-auto` command
 * handlers and records every `sendUserMessage` call.
 */
function createMockPi() {
  const sent: Sent[] = [];
  const goalHandlers = new Map<string, (args: string, ctx: any) => Promise<void>>();
  const pi = {
    registerTool: () => {},
    on: () => {},
    registerCommand: (name: string, def: any) => {
      if (name === "goal" || name === "goal-auto") goalHandlers.set(name, def.handler);
    },
    sendUserMessage: (content: string, opts?: { deliverAs?: string }) => {
      sent.push({ content, opts });
    },
  };
  return {
    pi: pi as unknown as ExtensionAPI,
    sent,
    getGoalHandler: () => goalHandlers.get("goal") ?? null,
    getGoalAutoHandler: () => goalHandlers.get("goal-auto") ?? null,
  };
}

function createMockCtx(idle: boolean) {
  return {
    sessionManager: { getSessionId: () => sessionId },
    ui: { notify: () => {} },
    isIdle: () => idle,
    mode: "tui",
  } as any;
}

async function main(): Promise<void> {
  await targetManager.restoreSession(sessionId);

  const { pi, sent, getGoalHandler, getGoalAutoHandler } = createMockPi();
  targetExtension(pi); // registers the /goal + /goal-auto commands
  const goal = getGoalHandler()!;
  const goalAuto = getGoalAutoHandler()!;
  assert(goal !== null, "/goal command registered");
  assert(goalAuto !== null, "/goal-auto command registered");

  console.log("/goal command handler tests\n");

  // ── /goal <text> while idle → sends goal text immediately ──────────
  console.log("/goal <text> (idle):");
  sent.length = 0;
  await goal("Refactor the auth module", createMockCtx(true));
  assert(sent.length === 1, "sends exactly one message when idle");
  assert(
    sent[0]?.content !== "Refactor the auth module",
    "message is wrapped, not the raw goal text",
  );
  assert(
    sent[0]?.content.includes("Refactor the auth module"),
    "wrapped message includes the goal text",
  );
  assert(
    sent[0]?.content.includes('Target(action: "add"'),
    "message nudges breaking the goal into sub-tasks",
  );
  assert(
    /narrower|easier-to-test/.test(sent[0]?.content ?? ""),
    "message includes fidelity / anti-narrowing guidance",
  );
  assert(
    sent[0]?.opts === undefined || sent[0]?.opts?.deliverAs === undefined,
    "no deliverAs (triggers a turn directly when idle)",
  );
  assert(
    targetManager.getState(sessionId).primary?.text === "Refactor the auth module",
    "primary target also set",
  );
  assert(
    targetManager.isAutoContinueActive(sessionId) === true,
    "auto-continue activated",
  );
  assert(
    targetManager.isAskUserTimeoutCapped(sessionId) === false,
    "/goal → goal mode, no ask_user timeout cap",
  );

  // ── /goal-auto <text> while idle → sends goal text immediately + cap ─
  console.log("\n/goal-auto <text> (idle):");
  sent.length = 0;
  await goalAuto("Automate the nightly run", createMockCtx(true));
  assert(sent.length === 1, "/goal-auto sends exactly one message when idle");
  assert(
    sent[0]?.content.includes("Automate the nightly run"),
    "/goal-auto wrapped message includes the goal text",
  );
  assert(
    targetManager.getState(sessionId).primary?.text === "Automate the nightly run",
    "/goal-auto sets primary target",
  );
  assert(
    targetManager.isAutoContinueActive(sessionId) === true,
    "/goal-auto activates auto-continue",
  );
  assert(
    targetManager.isAskUserTimeoutCapped(sessionId) === true,
    "/goal-auto → goal-auto mode, ask_user timeout cap on",
  );

  // ── /goal-auto on → re-activates goal-auto; /goal on → back to goal ──
  console.log("\n/goal-auto on vs /goal on:");
  await targetManager.goalOff(sessionId);
  await goalAuto("on", createMockCtx(false));
  assert(
    targetManager.isAskUserTimeoutCapped(sessionId) === true,
    "/goal-auto on restores goal-auto mode (cap on)",
  );
  await targetManager.goalOff(sessionId);
  await goal("on", createMockCtx(false));
  assert(
    targetManager.isAskUserTimeoutCapped(sessionId) === false,
    "/goal on restores goal mode (cap off)",
  );

  // ── /goal-auto off → disables auto-continue like /goal off ──────────
  console.log("\n/goal-auto off:");
  await goalAuto("off", createMockCtx(true));
  assert(
    targetManager.isAutoContinueActive(sessionId) === false,
    "/goal-auto off disables auto-continue",
  );
  assert(
    targetManager.getState(sessionId).primary !== null,
    "/goal-auto off keeps primary target",
  );

  // ── /goal <text> while streaming (not idle) → no immediate send ────
  console.log("\n/goal <text> (streaming):");
  sent.length = 0;
  await goal("Write more tests", createMockCtx(false));
  assert(sent.length === 0, "sends no message when streaming (guard handles it)");
  assert(
    targetManager.getState(sessionId).primary?.text === "Write more tests",
    "primary target still set",
  );
  assert(
    targetManager.isAutoContinueActive(sessionId) === true,
    "auto-continue still activated",
  );

  // ── /goal on while idle → resumes by sending primary text ─────────
  console.log("\n/goal on (idle, with primary):");
  // Turn off auto-continue first (simulating a prior /goal off or completion).
  await targetManager.goalOff(sessionId);
  sent.length = 0;
  await goal("on", createMockCtx(true));
  assert(sent.length === 1, "/goal on sends one message when idle");
  assert(
    sent[0]?.content !== "Write more tests",
    "/goal on message is wrapped, not the raw primary text",
  );
  assert(
    sent[0]?.content.includes("Write more tests"),
    "/goal on message includes the existing primary text",
  );

  // ── /goal on while streaming → no immediate send ──────────────────
  console.log("\n/goal on (streaming):");
  await targetManager.goalOff(sessionId);
  sent.length = 0;
  await goal("on", createMockCtx(false));
  assert(sent.length === 0, "/goal on sends no message when streaming");

  // ── /goal off → never sends a message ─────────────────────────────
  console.log("\n/goal off:");
  await targetManager.goalSet(sessionId, "Some goal");
  sent.length = 0;
  await goal("off", createMockCtx(true));
  assert(sent.length === 0, "/goal off sends no message");
  assert(
    targetManager.isAutoContinueActive(sessionId) === false,
    "/goal off disables auto-continue",
  );

  // ── /goal (no args) → never sends a message ───────────────────────
  console.log("\n/goal (no args, status):");
  sent.length = 0;
  await goal("", createMockCtx(true));
  assert(sent.length === 0, "/goal with no args sends no message");

  // Cleanup
  rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
