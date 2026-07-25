/**
 * Unit tests for A4 anchor resolution + fork/rewind behavior.
 *
 * Part 1 — `MessageIdMap.resolveAnchorBefore` (pure, no session): the
 *   "messageId → entry immediately before it" anchor that fork/rewind consume.
 *   Covers first / middle / last user message and CONSECUTIVE user messages
 *   (picking the Nth anchors before the Nth, not before the first).
 *
 * Part 2 — bridge-level `_fork_from` (non-destructive: new session history =
 *   up to before M, original untouched) and `_rewind_to` (dormant branch
 *   preserved), driven over a real fake-model session.
 *
 * Run: tsx verify/pi-acp-v2-fork-rewind.test.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import type { AgentContext, SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";

import { MessageIdMap, type AnchorEntry } from "../extensions/pi-acp-v2/message-map.js";
import { PiAcpBridge } from "../extensions/pi-acp-v2/bridge.js";
import { createAgentApp } from "../extensions/pi-acp-v2/agent-app.js";
import { createFakeModelRuntime, DEFAULT_FAKE_SCRIPT, FAKE_MODEL, type FakeScript } from "../extensions/pi-acp-v2/fake-model.js";

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
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- Part 1: pure anchor resolution ----------------------------------------

/** A linear branch: root → user1 → assistant1 → user2 → assistant2 → user3 → assistant3. */
function linearBranch(): AnchorEntry[] {
  return [
    { id: "u1", parentId: null },
    { id: "a1", parentId: "u1" },
    { id: "u2", parentId: "a1" },
    { id: "a2", parentId: "u2" },
    { id: "u3", parentId: "a2" },
    { id: "a3", parentId: "u3" },
  ];
}

/** A branch with CONSECUTIVE user messages: root → u1 → u2 → a1 (no assistant between u1,u2). */
function consecutiveBranch(): AnchorEntry[] {
  return [
    { id: "u1", parentId: null },
    { id: "u2", parentId: "u1" }, // consecutive user message — parent is u1, not null
    { id: "a1", parentId: "u2" },
  ];
}

function testAnchorFirstMessage(): void {
  console.log("anchor: first user message → null (root, fork-to-empty / rewind-to-root)");
  const map = new MessageIdMap();
  for (const e of linearBranch()) map.record(`M-${e.id}`, e.id);
  check(map.resolveAnchorBefore("M-u1", linearBranch()) === null, "anchor(u1) === null (root)");
}

function testAnchorMiddleMessage(): void {
  console.log("anchor: middle user message → previous assistant");
  const map = new MessageIdMap();
  const branch = linearBranch();
  for (const e of branch) map.record(`M-${e.id}`, e.id);
  check(map.resolveAnchorBefore("M-u2", branch) === "a1", "anchor(u2) === a1 (prev assistant)");
  check(map.resolveAnchorBefore("M-u3", branch) === "a2", "anchor(u3) === a2 (prev assistant)");
}

function testAnchorLastMessage(): void {
  console.log("anchor: last user message → previous assistant");
  const map = new MessageIdMap();
  const branch = linearBranch();
  for (const e of branch) map.record(`M-${e.id}`, e.id);
  // u3 is the last user message; its anchor is a2.
  check(map.resolveAnchorBefore("M-u3", branch) === "a2", "anchor(last user) === a2");
}

function testAnchorConsecutiveUserMessages(): void {
  console.log("anchor: consecutive user messages — Nth anchors before the Nth, not the first");
  const map = new MessageIdMap();
  const branch = consecutiveBranch();
  for (const e of branch) map.record(`M-${e.id}`, e.id);
  // Picking u2 (the 2nd, consecutive user message) must anchor to u1 (the entry
  // immediately before u2), NOT to null (which would be "before u1").
  check(map.resolveAnchorBefore("M-u1", branch) === null, "anchor(u1) === null (root)");
  check(map.resolveAnchorBefore("M-u2", branch) === "u1", "anchor(u2) === u1 (not root) — §6.6");
}

function testAnchorErrors(): void {
  console.log("anchor: unknown messageId / off-branch → null");
  const map = new MessageIdMap();
  const branch = linearBranch();
  for (const e of branch) map.record(`M-${e.id}`, e.id);
  check(map.resolveAnchorBefore("M-does-not-exist", branch) === null, "unknown messageId → null");
  // An entry not on the active branch resolves to null.
  check(map.resolveAnchorBefore("M-u1", []) === null, "empty branch → null");
}

// ---- Part 2: bridge-level fork / rewind -----------------------------------

type UpdateNotification = { sessionId: string; update: SessionUpdate };

function harness(script: FakeScript, agentDir: string) {
  const updates: UpdateNotification[] = [];
  const bridge = new PiAcpBridge({ model: FAKE_MODEL, modelRuntime: createFakeModelRuntime(script), agentDir });
  const app = createAgentApp(bridge);
  const clientApp = acp.client().onNotification(acp.methods.client.session.update, (ctx) => {
    updates.push(ctx.params);
  });
  return { bridge, app, clientApp, updates };
}

function req(c: AgentContext, method: string, params: unknown): Promise<any> {
  return c.request(method, params) as Promise<any>;
}

/** Wait for a NEW idle (count must increase past the baseline). */
async function waitForIdle(updates: UpdateNotification[], baseline: number, timeoutMs = 6000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const idle = updates.filter((u) => u.update.sessionUpdate === "state_update" && (u.update as { state?: string }).state === "idle").length;
    if (idle > baseline) return true;
    await sleep(10);
  }
  return false;
}

function userMessageIds(updates: UpdateNotification[]): string[] {
  return updates.filter((u) => u.update.sessionUpdate === "user_message").map((u) => (u.update as { messageId: string }).messageId);
}

function userTextsOnBranch(handle: NonNullable<ReturnType<PiAcpBridge["getSessionHandle"]>>): string[] {
  return handle.sessionManager
    .getBranch()
    .filter((e) => e.type === "message" && e.message.role === "user")
    .map((e) => extractText((e as { message: { content: unknown } }).message.content));
}

/** Extract text from a user message content (string or content-array). */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type: "text"; text: string } => typeof p === "object" && p?.type === "text")
      .map((p) => p.text)
      .join("");
  }
  return "";
}

const CAPS = { _meta: { _fork_from: {}, _rewind_to: {} } };

async function testForkNonDestructive(): Promise<void> {
  console.log("fork: non-destructive — new session history = up-to-before-M, original unchanged");
  const { bridge, app, clientApp, updates } = harness(DEFAULT_FAKE_SCRIPT, mkdtempSync(join(tmpdir(), "vr-fork-")));
  await clientApp.connectWith(app, async (c) => {
    await req(c, acp.methods.agent.initialize, { protocolVersion: 2, info: { name: "t", version: "1" }, capabilities: CAPS });
    const { sessionId } = await req(c, acp.methods.agent.session.new, { cwd: "/tmp" });
    await req(c, acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "first" }] });
    await waitForIdle(updates, 0);
    updates.length = 0;
    await req(c, acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "second" }] });
    await waitForIdle(updates, 0);
    const [u2] = userMessageIds(updates);

    const hA = bridge.getSessionHandle(sessionId)!;
    const aLeafBefore = hA.sessionManager.getLeafId();

    const { sessionId: newId } = await req(c, "_fork_from", { sessionId, fromMessageId: u2 });
    check(newId !== sessionId, "new sessionId differs from original");

    const hB = bridge.getSessionHandle(newId)!;
    check(userTextsOnBranch(hB).join(",") === "first", "forked session history = ['first'] (up to before M)");
    check(!userTextsOnBranch(hB).includes("second"), "forked session excludes M ('second')");

    // Non-destructive: original content + leaf unchanged.
    check(userTextsOnBranch(hA).join(",") === "first,second", "original still has both turns");
    check(hA.sessionManager.getLeafId() === aLeafBefore, "original leaf unchanged");
  });
}

async function testRewindDormantBranch(): Promise<void> {
  console.log("rewind: leaf moves before M; dormant branch preserved (not deleted)");
  const { bridge, app, clientApp, updates } = harness(DEFAULT_FAKE_SCRIPT, mkdtempSync(join(tmpdir(), "vr-rew-")));
  await clientApp.connectWith(app, async (c) => {
    await req(c, acp.methods.agent.initialize, { protocolVersion: 2, info: { name: "t", version: "1" }, capabilities: CAPS });
    const { sessionId } = await req(c, acp.methods.agent.session.new, { cwd: "/tmp" });
    await req(c, acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "first" }] });
    await waitForIdle(updates, 0);
    updates.length = 0;
    await req(c, acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "second" }] });
    await waitForIdle(updates, 0);
    const [u2] = userMessageIds(updates);

    const hA = bridge.getSessionHandle(sessionId)!;
    const entriesBefore = hA.sessionManager.getEntries().length;

    const res = await req(c, "_rewind_to", { sessionId, toMessageId: u2 });
    check(JSON.stringify(res) === "{}", "rewind returns {}");

    // Active branch collapsed to before M; M and after are off-branch but still in the tree.
    check(userTextsOnBranch(hA).join(",") === "first", "active branch = ['first'] after rewind");
    // Dormant branch preserved: the whole tree still holds M (and the tree size is unchanged).
    const allUserTexts = hA.sessionManager
      .getEntries()
      .filter((e) => e.type === "message" && e.message.role === "user")
      .map((e) => extractText((e as { message: { content: unknown } }).message.content));
    check(allUserTexts.includes("second"), "M ('second') still reachable in the tree (dormant branch)");
    check(hA.sessionManager.getEntries().length === entriesBefore, "tree size unchanged (nothing deleted)");
  });
}

async function main(): Promise<void> {
  testAnchorFirstMessage();
  testAnchorMiddleMessage();
  testAnchorLastMessage();
  testAnchorConsecutiveUserMessages();
  testAnchorErrors();
  await testForkNonDestructive();
  await testRewindDormantBranch();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
