/**
 * Target guard Escape-path regression tests.
 *
 * The bug: after an abort (Esc / RPC abort), the guard's Escape path used
 * `pi.sendUserMessage(steer, { deliverAs: "steer" })`. Since `sendUserMessage`
 * ALWAYS triggers a turn when the agent is idle (and `agent_settled` fires
 * exactly when the agent is idle), the abort was immediately followed by a
 * brand-new agent turn — the agent visibly "auto-resumed" right after the
 * user pressed Esc (and the LLM would even keep working in response to the
 * notice). Fix: the notice is delivered as a display-only custom message with
 * `triggerTurn: false`, so aborting truly hands control back to the user.
 *
 * Run: npx tsx verify/guard-escape.test.ts
 */

import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { targetManager } from "../extensions/target/target-manager.js";
import { createTargetGuardHandler } from "../extensions/target/guard.js";

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
const tmpDir = mkdtempSync(join(tmpdir(), "guard-escape-test-"));
process.env.PI_ATLAS_DIR = tmpDir;

const sessionId = "guard-escape-unit";

interface Sent {
  kind: "user" | "custom";
  content: string;
  opts?: { deliverAs?: string; triggerTurn?: boolean };
}

function createMockPi() {
  const sent: Sent[] = [];
  const pi = {
    on: () => {},
    sendUserMessage: (content: string, opts?: { deliverAs?: string }) => {
      sent.push({ kind: "user", content, opts });
    },
    sendMessage: (message: { customType: string; content: string; display?: boolean }, opts?: { triggerTurn?: boolean }) => {
      sent.push({ kind: "custom", content: message.content, opts });
    },
  };
  return { pi: pi as unknown as ExtensionAPI, sent };
}

/** Build a ctx whose branch ends with an assistant message of the given stopReason. */
function createMockCtx(lastAssistantStopReason: string) {
  return {
    mode: "tui",
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => [
        { type: "message", id: "u1", parentId: null, timestamp: 1, message: { role: "user", content: [{ type: "text", text: "start" }] } },
        { type: "message", id: "a1", parentId: "u1", timestamp: 2, message: { role: "assistant", content: [], stopReason: lastAssistantStopReason } },
      ],
    },
  } as unknown as ExtensionContext;
}

async function main(): Promise<void> {
  await targetManager.restoreSession(sessionId);

  const { pi, sent } = createMockPi();
  const guard = createTargetGuardHandler(pi);

  console.log("Target guard Escape path (abort must NOT auto-resume)\n");

  // ── A. Aborted turn + auto-continue on → disable + notice, NO new turn ──
  console.log("A. abort with auto-continue active:");
  await targetManager.goalSet(sessionId, "test goal", false);
  sent.length = 0;
  guard({ type: "agent_settled" }, createMockCtx("aborted"));
  assert(
    targetManager.isAutoContinueActive(sessionId) === false,
    "auto-continue disabled",
  );
  assert(sent.length === 1, "exactly one message sent");
  assert(sent[0]?.kind === "custom", "delivered as custom message (not a user message)");
  assert(
    sent[0]?.content.includes("Auto-continue stopped"),
    "notice text present",
  );
  assert(
    sent[0]?.opts?.triggerTurn === false,
    "triggerTurn: false — no new agent turn",
  );
  assert(
    sent.some((s) => s.kind === "user") === false,
    "sendUserMessage NOT used (would start a new turn)",
  );

  // ── B. Aborted turn + auto-continue already off → no message at all ──
  console.log("\nB. abort with auto-continue already off:");
  sent.length = 0;
  guard({ type: "agent_settled" }, createMockCtx("aborted"));
  assert(sent.length === 0, "no message sent (nothing to pause)");

  // ── C. Normal turn + auto-continue on → continuation still injected ──
  console.log("\nC. normal turn with auto-continue on (regression):");
  await targetManager.goalSet(sessionId, "test goal", false);
  sent.length = 0;
  guard({ type: "agent_settled" }, createMockCtx("stop"));
  assert(sent.length === 1, "continuation injected");
  assert(sent[0]?.kind === "user", "continuation is a user message (triggers the loop)");
  assert(
    sent[0]?.content.includes("You are working toward a target"),
    "continuation text present",
  );
  assert(
    targetManager.isAutoContinueActive(sessionId) === true,
    "auto-continue still active after normal settle",
  );

  // ── D. toolUse turn + auto-continue on → continuation injected ──
  console.log("\nD. toolUse turn with auto-continue on:");
  sent.length = 0;
  guard({ type: "agent_settled" }, createMockCtx("toolUse"));
  assert(sent.length === 1, "continuation injected after toolUse settle");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
