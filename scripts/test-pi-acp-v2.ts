/**
 * pi-acp-v2 conformance driver.
 *
 * Covers the A1 acceptance criteria (Spec §7):
 *   §7.1 initialize→new→prompt→stream→idle (messageId stable, user_message before running, ends idle+end_turn)
 *   §7.2 session/cancel mid-stream → idle+cancelled, no crash
 *   §7.3 session/list matches files; session/resume replays messages
 *   §7.4 session/close → subsequent ops return -32602
 *   §7.5 client declares/doesn't declare _ask_user → no crash
 *   §7.6 stdio framing (no embedded newlines) + stdin EOF → graceful exit
 *
 * Determinism: every session uses a FAKE model (canned AssistantMessageEvents) —
 * no real LLM, API key, or network. Lifecycle tests use real SessionManager over a
 * temp agentDir. The framing/EOF test spawns the server subprocess.
 *
 * Run: tsx scripts/test-pi-acp-v2.ts
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import type { AgentContext, SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

import { PiAcpBridge } from "../extensions/pi-acp-v2/bridge.js";
import { createAgentApp } from "../extensions/pi-acp-v2/agent-app.js";
import {
  createFakeModelRuntime,
  DEFAULT_FAKE_SCRIPT,
  FAKE_MODEL,
  hangingTurnEvents,
  askUserScript,
  targetScript,
  textTurnEvents,
  toolUseScript,
  type FakeScript,
} from "../extensions/pi-acp-v2/fake-model.js";
import { askUserExcludeToolsResolver, clientDeclares, VENDOR_CAPABILITIES } from "../extensions/pi-acp-v2/types.js";
import targetExtension from "../extensions/target/index.js";
import askUserExtension from "../extensions/askuser/index.js";

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

type UpdateNotification = { sessionId: string; update: SessionUpdate };

/** In-process ACP harness: bridge + apps + collected session/update notifications. */
function harness(opts: {
  script?: FakeScript;
  clientMeta?: Record<string, unknown>;
  idFactory?: () => string;
  extensionFactories?: InlineExtension[];
  agentDir?: string;
  excludeToolsResolver?: (clientMeta: unknown) => string[];
  /** If set, the (client) side answers `_ask_user` requests via this handler. */
  askUserHandler?: (params: unknown) => unknown;
}) {
  const updates: UpdateNotification[] = [];
  const askUserRequests: { method: string; params: any }[] = [];
  const bridge = new PiAcpBridge({
    model: FAKE_MODEL,
    modelRuntime: createFakeModelRuntime(opts.script ?? DEFAULT_FAKE_SCRIPT),
    idFactory: opts.idFactory,
    extensionFactories: opts.extensionFactories,
    agentDir: opts.agentDir,
    excludeToolsResolver: opts.excludeToolsResolver,
  });
  const app = createAgentApp(bridge);
  const clientApp = acp
    .client()
    .onNotification(acp.methods.client.session.update, (ctx) => {
      updates.push(ctx.params);
    });
  if (opts.askUserHandler) {
    // _ask_user is a client-side vendor method: the adapter calls it, we answer.
    clientApp.onRequest<unknown, unknown>("_ask_user", (p) => p, (ctx) => {
      askUserRequests.push({ method: "_ask_user", params: ctx.params });
      return opts.askUserHandler!(ctx.params);
    });
  }
  return { bridge, app, clientApp, updates, askUserRequests };
}

async function withClient<T>(app: ReturnType<typeof createAgentApp>, clientApp: acp.ClientApp, fn: (c: AgentContext) => Promise<T>): Promise<T> {
  return clientApp.connectWith(app, fn);
}

/** Typed request helper (the generic request overload returns unknown). */
function req(c: AgentContext, method: string, params: unknown): Promise<any> {
  return c.request(method, params) as Promise<any>;
}

/** Wait until an idle state_update is collected (poll with timeout). */
async function waitForIdle(updates: UpdateNotification[], timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (updates.some((u) => u.update.sessionUpdate === "state_update" && (u.update as { state?: string }).state === "idle")) return true;
    await sleep(10);
  }
  return false;
}

function isErr(e: unknown): e is { code: number; message: string } {
  return typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "number";
}

async function testInitializeAndCapabilities(): Promise<void> {
  console.log("initialize + capabilities");
  const { app, clientApp, bridge } = harness({});
  await withClient(app, clientApp, async (c) => {
    const res = await req(c, acp.methods.agent.initialize, {
      protocolVersion: 2,
      info: { name: "test-client", version: "1.0.0" },
      capabilities: { _meta: { _ask_user: {} } },
    });
    check(res.protocolVersion === 2, "protocolVersion === 2");
    check(res.info?.name === "pi-acp-v2", "info.name === pi-acp-v2");
    check(res.capabilities?.session && typeof res.capabilities.session === "object", "capabilities.session present");
    const meta = (res.capabilities as { _meta?: Record<string, unknown> })._meta;
    check(!!meta?._ask_user && !!meta?._fork_from && !!meta?._rewind_to, "advertises _ask_user/_fork_from/_rewind_to");
    check(bridge.clientMeta !== undefined && clientDeclares(bridge.clientMeta, VENDOR_CAPABILITIES.askUser), "stores client _ask_user capability");
  });
}

async function testPromptStreaming(): Promise<void> {
  console.log("session/prompt streaming flow");
  let counter = 0;
  const { app, clientApp, updates } = harness({ idFactory: () => `msg-${counter++}` });
  await withClient(app, clientApp, async (c) => {
    await req(c, acp.methods.agent.initialize, { protocolVersion: 2, info: { name: "t", version: "1" }, capabilities: {} });
    const { sessionId } = await req(c, acp.methods.agent.session.new, { cwd: "/tmp" });
    const resp = await req(c, acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "Hello" }] });
    check(JSON.stringify(resp) === "{}", "prompt returns {} immediately");
    const ok = await waitForIdle(updates);
    check(ok, "turn settles to idle");

    const seq = updates.map((u) => u.update.sessionUpdate);
    const firstUser = seq.indexOf("user_message");
    const running = seq.indexOf("state_update");
    check(firstUser !== -1 && firstUser < running, "user_message precedes first state_update(running)");
    check(seq[running + 0] === undefined || (updates[running].update as { state?: string }).state === "running", "first state_update is running");

    // messageId stable across agent chunks
    const chunks = updates.filter((u) => u.update.sessionUpdate === "agent_message_chunk");
    check(chunks.length >= 1, "received agent_message_chunk(s)");
    const ids = new Set(chunks.map((u) => (u.update as { messageId: string }).messageId));
    check(ids.size === 1, "all chunks share one messageId");
    const fullMsg = updates.find((u) => u.update.sessionUpdate === "agent_message");
    check(!!fullMsg, "received agent_message (full replace)");
    check((fullMsg!.update as { messageId: string }).messageId === [...ids][0], "agent_message shares chunk messageId");

    const idle = updates[updates.length - 1].update as { sessionUpdate: string; state?: string; stopReason?: string };
    check(idle.sessionUpdate === "state_update" && idle.state === "idle" && idle.stopReason === "end_turn", "ends idle+end_turn");

    // fake echoes "echo: Hello"
    const text = chunks.map((u) => (u.update as { content: { text: string } }).content.text).join("");
    check(text === "echo: Hello", `agent text === "echo: Hello" (got "${text}")`);
  });
}

async function testCancel(): Promise<void> {
  console.log("session/cancel mid-stream");
  const script: FakeScript = () => hangingTurnEvents("working");
  const { app, clientApp, updates } = harness({ script });
  await withClient(app, clientApp, async (c) => {
    await req(c, acp.methods.agent.initialize, { protocolVersion: 2, info: { name: "t", version: "1" }, capabilities: {} });
    const { sessionId } = await req(c, acp.methods.agent.session.new, { cwd: "/tmp" });
    await req(c, acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "go" }] });
    // wait until the turn is in progress (running), then cancel
    const runningDeadline = Date.now() + 2000;
    while (Date.now() < runningDeadline && !updates.some((u) => (u.update as { state?: string }).state === "running")) await sleep(5);
    check(updates.some((u) => (u.update as { state?: string }).state === "running"), "turn reached running before cancel");
    await c.notify(acp.methods.agent.session.cancel, { sessionId });
    const ok = await waitForIdle(updates);
    check(ok, "settled to idle after cancel");
    const idle = updates[updates.length - 1].update as { sessionUpdate: string; state?: string; stopReason?: string };
    check(idle.state === "idle" && idle.stopReason === "cancelled", `cancel → idle+cancelled (got ${idle.stopReason})`);
  });
}

async function testSessionBusy(): Promise<void> {
  console.log("session/prompt while busy → -32000 (race)");
  const { app, clientApp, updates } = harness({});
  await withClient(app, clientApp, async (c) => {
    await req(c, acp.methods.agent.initialize, { protocolVersion: 2, info: { name: "t", version: "1" }, capabilities: {} });
    const { sessionId } = await req(c, acp.methods.agent.session.new, { cwd: "/tmp" });
    // Fire two prompts without awaiting the first → both buffered before the
    // deferred turn starts. The second must reject -32000 (turnInProgress is set
    // synchronously in prompt(), closing the macrotask-gap race).
    const p1 = req(c, acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "first" }] });
    const p2 = req(c, acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "second" }] });
    await p1;
    let code: number | undefined;
    try {
      await p2;
    } catch (e) {
      if (isErr(e)) code = e.code;
    }
    check(code === -32000, `2nd prompt while 1st pending → -32000 (got ${code})`);
    await waitForIdle(updates);
  });
}

async function testToolUseTurn(): Promise<void> {
  console.log("tool-use turn (multi-message + tool_call_update)");
  const tmpFile = join(tmpdir(), `pi-acp-tool-${Date.now()}.txt`);
  writeFileSync(tmpFile, "file-contents");
  const { bridge, app, clientApp, updates } = harness({ script: toolUseScript(tmpFile) });
  try {
    await withClient(app, clientApp, async (c) => {
      await req(c, acp.methods.agent.initialize, { protocolVersion: 2, info: { name: "t", version: "1" }, capabilities: {} });
      const { sessionId } = await req(c, acp.methods.agent.session.new, { cwd: "/tmp" });
      await req(c, acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "read it" }] });
      const ok = await waitForIdle(updates, 6000);
      check(ok, "tool-use turn settles to idle");

      const toolUpdates = updates.filter((u) => u.update.sessionUpdate === "tool_call_update");
      check(toolUpdates.length >= 2, `received >=2 tool_call_update (got ${toolUpdates.length})`);
      const withContent = toolUpdates.find((u) => (u.update as { content?: unknown[] }).content);
      check(!!withContent, "a tool_call_update carries content");
      const c0 = (withContent!.update as { content?: Array<{ type: string; content?: { type: string; text?: string } }> }).content?.[0];
      check(c0?.type === "content" && c0?.content?.type === "text", "tool content is ToolCallContent{type:content,content{text}}");
      check(c0?.content?.text === "file-contents", "tool content text is the read result");

      // Two distinct assistant messageIds (turn 0 tool-use msg + turn 1 text msg), both mapped.
      const ids = new Set(
        updates
          .filter((u) => u.update.sessionUpdate === "agent_message_chunk" || u.update.sessionUpdate === "agent_message")
          .map((u) => (u.update as { messageId: string }).messageId),
      );
      check(ids.size >= 2, `two distinct assistant messageIds (got ${ids.size})`);
      const handle = bridge.getSessionHandle(sessionId);
      const allMapped = [...ids].every((id) => handle?.messageMap.getEntryId(id) !== undefined);
      check(allMapped, "both assistant messageIds mapped to entryIds");

      const idle = updates[updates.length - 1].update as { sessionUpdate: string; state?: string; stopReason?: string };
      check(idle.sessionUpdate === "state_update" && idle.state === "idle" && idle.stopReason === "end_turn", "ends idle+end_turn");
    });
  } finally {
    rmSync(tmpFile, { force: true });
  }
}

async function testSlashCommandNoDeadlock(): Promise<void> {
  console.log("slash-command prompt does not deadlock the session");
  // A /noop command resolves prompt() without running a turn (no agent_settled).
  // turnInProgress must be cleared on settle, or the next prompt returns -32000.
  const noopExtension: InlineExtension = (pi) => {
    pi.registerCommand("noop", { handler: async () => {} });
  };
  const { bridge, app, clientApp, updates } = harness({ extensionFactories: [noopExtension] });
  await withClient(app, clientApp, async (c) => {
    await req(c, acp.methods.agent.initialize, { protocolVersion: 2, info: { name: "t", version: "1" }, capabilities: {} });
    const { sessionId } = await req(c, acp.methods.agent.session.new, { cwd: "/tmp" });
    await req(c, acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "/noop" }] });
    await sleep(50);
    check(updates.some((u) => (u.update as { state?: string }).state === "idle"), "slash-command (no turn) bookended with idle");
    const handle = bridge.getSessionHandle(sessionId);
    check(!!handle && !handle.turnInProgress, "turnInProgress cleared after no-turn prompt");
    // Next prompt must succeed (not -32000) and run a real turn — proves no deadlock.
    updates.length = 0;
    await req(c, acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "hi" }] });
    const ok = await waitForIdle(updates);
    check(ok, "next prompt runs a turn after slash-command (no deadlock)");
  });
}

async function testListAndResume(): Promise<void> {
  console.log("session/list + session/resume replay");
  const agentDir = mkdtempSync(join(tmpdir(), "pi-acp-list-"));
  const cwd = "/tmp";
  const updates: UpdateNotification[] = [];
  const bridge = new PiAcpBridge({
    model: FAKE_MODEL,
    modelRuntime: createFakeModelRuntime(DEFAULT_FAKE_SCRIPT),
    agentDir,
  });
  const app = createAgentApp(bridge);
  const clientApp = acp.client().onNotification(acp.methods.client.session.update, (ctx) => {
    updates.push(ctx.params);
  });
  try {
    await clientApp.connectWith(app, async (c) => {
      await req(c, acp.methods.agent.initialize, { protocolVersion: 2, info: { name: "t", version: "1" }, capabilities: {} });
      const { sessionId } = await req(c, acp.methods.agent.session.new, { cwd });
      await req(c, acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "Hello" }] });
      await waitForIdle(updates);

      const list = await req(c, acp.methods.agent.session.list, {});
      check(list.sessions.some((s: { sessionId: string }) => s.sessionId === sessionId), "session/list contains created session");
      check(list.sessions.find((s: { sessionId: string; cwd: string }) => s.sessionId === sessionId)?.cwd === cwd, "listed session cwd matches");

      // resume with full replay
      updates.length = 0;
      await req(c, acp.methods.agent.session.resume, { sessionId, cwd, replayFrom: { type: "start" } });
      const replayed = updates.map((u) => u.update.sessionUpdate);
      check(replayed.includes("user_message") && replayed.includes("agent_message"), "resume replays user_message + agent_message");
      const userMsg = updates.find((u) => u.update.sessionUpdate === "user_message");
      check((userMsg?.update as { content?: { text?: string }[] })?.content?.[0]?.text === "Hello", "replayed user message text");
    });
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
}

async function testCloseAndErrors(): Promise<void> {
  console.log("session/close + error codes");
  const { app, clientApp } = harness({});
  await withClient(app, clientApp, async (c) => {
    await req(c, acp.methods.agent.initialize, { protocolVersion: 2, info: { name: "t", version: "1" }, capabilities: {} });
    const { sessionId } = await req(c, acp.methods.agent.session.new, { cwd: "/tmp" });
    await req(c, acp.methods.agent.session.close, { sessionId });

    let code: number | undefined;
    try {
      await req(c, acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "x" }] });
    } catch (e) {
      if (isErr(e)) code = e.code;
    }
    check(code === -32602, `prompt on closed session → -32602 (got ${code})`);

    let code2: number | undefined;
    try {
      await req(c, acp.methods.agent.session.prompt, { sessionId: "nope", prompt: [{ type: "text", text: "x" }] });
    } catch (e) {
      if (isErr(e)) code2 = e.code;
    }
    check(code2 === -32602, `prompt on unknown session → -32602 (got ${code2})`);
  });
}

async function testAskUserCapabilityNoCrash(): Promise<void> {
  console.log("ask_user capability gating (no-crash)");
  for (const declares of [true, false]) {
    const { app, clientApp, bridge } = harness({});
    await withClient(app, clientApp, async (c) => {
      const caps = declares ? { _meta: { _ask_user: {} } } : {};
      const res = await req(c, acp.methods.agent.initialize, { protocolVersion: 2, info: { name: "t", version: "1" }, capabilities: caps });
      check(res.protocolVersion === 2, `initialize survives (declares=${declares})`);
      check(clientDeclares(bridge.clientMeta, VENDOR_CAPABILITIES.askUser) === declares, `clientMeta._ask_user reflected (declares=${declares})`);
      const { sessionId } = await req(c, acp.methods.agent.session.new, { cwd: "/tmp" });
      await req(c, acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "hi" }] });
    });
  }
}

async function testMessageIdEntryMapping(): Promise<void> {
  console.log("messageId ↔ entryId mapping (real turn)");
  const { bridge, app, clientApp, updates } = harness({});
  await withClient(app, clientApp, async (c) => {
    await req(c, acp.methods.agent.initialize, { protocolVersion: 2, info: { name: "t", version: "1" }, capabilities: {} });
    const { sessionId } = await req(c, acp.methods.agent.session.new, { cwd: "/tmp" });
    // Turn 1: user(root) + assistant. Turn 2's user message has the turn-1
    // assistant entry as parent → resolveAnchorBefore must be non-null.
    await req(c, acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "first" }] });
    await waitForIdle(updates);
    updates.length = 0;
    await req(c, acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "second" }] });
    await waitForIdle(updates);

    const userMsg = updates.find((u) => u.update.sessionUpdate === "user_message");
    const userMessageId = (userMsg?.update as { messageId?: string })?.messageId;
    check(typeof userMessageId === "string", "captured 2nd-turn user messageId");
    const anchor = bridge.resolveAnchorBefore(sessionId, userMessageId!);
    check(anchor !== null, `resolveAnchorBefore non-null after real turn (got ${anchor})`);

    const handle = bridge.getSessionHandle(sessionId);
    check(!!handle && handle.messageMap.getEntryId(userMessageId!) !== undefined, "messageMap recorded user messageId→entryId");
    const asstMsg = updates.find((u) => u.update.sessionUpdate === "agent_message");
    const asstMessageId = (asstMsg?.update as { messageId?: string })?.messageId;
    check(asstMessageId !== undefined && handle!.messageMap.getEntryId(asstMessageId!) !== undefined, "messageMap recorded assistant messageId→entryId");
  });
}

// ---- A3: ask_user gating + _ask_user bridge -------------------------------

/** Extract the text of the last tool_call_update carrying content. */
function lastToolResultText(updates: UpdateNotification[]): string {
  const withContent = updates.filter((u) => u.update.sessionUpdate === "tool_call_update" && (u.update as { content?: unknown[] }).content);
  const last = withContent[withContent.length - 1];
  return ((last?.update as { content?: Array<{ content?: { text?: string } }> })?.content?.[0]?.content?.text) ?? "";
}

async function testAskUserSelect(): Promise<void> {
  console.log("ask_user: select (declared) → _ask_user request + answer");
  const atlasDir = freshAtlasDir();
  process.env.PI_ATLAS_DIR = atlasDir;
  const script = askUserScript([{ question: "Pick one", type: "select", options: ["Option A", "Option B"] }]);
  const { app, clientApp, updates, askUserRequests } = harness({
    script,
    extensionFactories: [askUserExtension],
    excludeToolsResolver: askUserExcludeToolsResolver,
    agentDir: atlasDir,
    askUserHandler: () => ({ action: "accept", content: "Option A" }),
  });
  try {
    await withClient(app, clientApp, async (c) => {
      await req(c, acp.methods.agent.initialize, { protocolVersion: 2, info: { name: "t", version: "1" }, capabilities: { _meta: { _ask_user: {} } } });
      const { sessionId } = await req(c, acp.methods.agent.session.new, { cwd: "/tmp" });
      await req(c, acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "ask" }] });
      const ok = await waitForIdle(updates, 8000);
      check(ok, "turn settles to idle");
    });
    check(askUserRequests.length === 1, `exactly one _ask_user request (got ${askUserRequests.length})`);
    const p = askUserRequests[0]?.params as { mode?: string; sessionId?: string; title?: string; options?: string[] };
    check(p?.mode === "select", "_ask_user mode=select");
    check(typeof p?.sessionId === "string" && p.sessionId.length > 0, "_ask_user carries sessionId");
    check(p?.title === "Pick one", "_ask_user title passed through");
    check(Array.isArray(p?.options) && p.options.includes("Option A") && p.options.includes("Option B"), "_ask_user options carried");
    check(lastToolResultText(updates).includes("Option A"), "tool result includes the chosen answer");
  } finally {
    rmSync(atlasDir, { recursive: true, force: true });
  }
}

async function testAskUserConfirm(): Promise<void> {
  console.log("ask_user: confirm (declared) → _ask_user + boolean");
  const atlasDir = freshAtlasDir();
  process.env.PI_ATLAS_DIR = atlasDir;
  const script = askUserScript([{ question: "Proceed?", type: "confirm" }]);
  const { app, clientApp, updates, askUserRequests } = harness({
    script,
    extensionFactories: [askUserExtension],
    excludeToolsResolver: askUserExcludeToolsResolver,
    agentDir: atlasDir,
    askUserHandler: () => ({ action: "accept", content: true }),
  });
  try {
    await withClient(app, clientApp, async (c) => {
      await req(c, acp.methods.agent.initialize, { protocolVersion: 2, info: { name: "t", version: "1" }, capabilities: { _meta: { _ask_user: {} } } });
      const { sessionId } = await req(c, acp.methods.agent.session.new, { cwd: "/tmp" });
      await req(c, acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "ask" }] });
      const ok = await waitForIdle(updates, 8000);
      check(ok, "turn settles to idle");
    });
    check(askUserRequests.length === 1, "_ask_user request sent");
    check((askUserRequests[0]?.params as { mode?: string }).mode === "confirm", "mode=confirm");
    check(lastToolResultText(updates).includes("Yes"), 'confirm true → answer "Yes"');
  } finally {
    rmSync(atlasDir, { recursive: true, force: true });
  }
}

async function testAskUserInput(): Promise<void> {
  console.log("ask_user: input (declared) → _ask_user + string");
  const atlasDir = freshAtlasDir();
  process.env.PI_ATLAS_DIR = atlasDir;
  const script = askUserScript([{ question: "Name?", type: "input", placeholder: "your name" }]);
  const { app, clientApp, updates, askUserRequests } = harness({
    script,
    extensionFactories: [askUserExtension],
    excludeToolsResolver: askUserExcludeToolsResolver,
    agentDir: atlasDir,
    askUserHandler: () => ({ action: "accept", content: "Alice" }),
  });
  try {
    await withClient(app, clientApp, async (c) => {
      await req(c, acp.methods.agent.initialize, { protocolVersion: 2, info: { name: "t", version: "1" }, capabilities: { _meta: { _ask_user: {} } } });
      const { sessionId } = await req(c, acp.methods.agent.session.new, { cwd: "/tmp" });
      await req(c, acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "ask" }] });
      const ok = await waitForIdle(updates, 8000);
      check(ok, "turn settles to idle");
    });
    check(askUserRequests.length === 1, "_ask_user request sent");
    const p = askUserRequests[0]?.params as { mode?: string; placeholder?: string };
    check(p?.mode === "input", "mode=input");
    check(p?.placeholder === "your name", "placeholder carried");
    check(lastToolResultText(updates).includes("Alice"), "input answer carried into tool result");
  } finally {
    rmSync(atlasDir, { recursive: true, force: true });
  }
}

async function testAskUserGated(): Promise<void> {
  console.log("ask_user: undeclared _ask_user → tool excluded, no _ask_user request");
  const atlasDir = freshAtlasDir();
  process.env.PI_ATLAS_DIR = atlasDir;
  // Client does NOT declare _ask_user → resolver excludes the tool. The fake model
  // still emits an ask_user toolcall, which pi reports as "not found" (excluded).
  const script = askUserScript([{ question: "Pick", type: "select", options: ["A", "B"] }]);
  const { app, clientApp, updates, askUserRequests } = harness({
    script,
    extensionFactories: [askUserExtension],
    excludeToolsResolver: askUserExcludeToolsResolver,
    agentDir: atlasDir,
    askUserHandler: () => ({ action: "accept", content: "A" }),
  });
  try {
    await withClient(app, clientApp, async (c) => {
      // No _meta._ask_user → ask_user is excluded.
      await req(c, acp.methods.agent.initialize, { protocolVersion: 2, info: { name: "t", version: "1" }, capabilities: {} });
      const { sessionId } = await req(c, acp.methods.agent.session.new, { cwd: "/tmp" });
      await req(c, acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "ask" }] });
      const ok = await waitForIdle(updates, 8000);
      check(ok, "turn still settles to idle (no crash)");
    });
    check(askUserRequests.length === 0, "no _ask_user request when capability undeclared");
    // The ask_user toolcall failed as "not found" (excluded) — status failed.
    const failed = updates.find(
      (u) => u.update.sessionUpdate === "tool_call_update" && (u.update as { status?: string }).status === "failed",
    );
    check(!!failed, "excluded tool call reported as failed");
    check(lastToolResultText(updates).includes("not found"), 'error text mentions "not found"');
  } finally {
    rmSync(atlasDir, { recursive: true, force: true });
  }
}

async function testAskUserDecline(): Promise<void> {
  console.log("ask_user: decline → cancel value, no crash");
  const atlasDir = freshAtlasDir();
  process.env.PI_ATLAS_DIR = atlasDir;
  // input question: decline → input returns undefined → askuser fallback "(cancelled)".
  // (select decline would additionally trigger askuser's "Other" input fallback,
  //  muddying the request count; input gives a single clean _ask_user request.)
  const script = askUserScript([{ question: "Name?", type: "input" }]);
  const { app, clientApp, updates, askUserRequests } = harness({
    script,
    extensionFactories: [askUserExtension],
    excludeToolsResolver: askUserExcludeToolsResolver,
    agentDir: atlasDir,
    askUserHandler: () => ({ action: "decline" }),
  });
  try {
    await withClient(app, clientApp, async (c) => {
      await req(c, acp.methods.agent.initialize, { protocolVersion: 2, info: { name: "t", version: "1" }, capabilities: { _meta: { _ask_user: {} } } });
      const { sessionId } = await req(c, acp.methods.agent.session.new, { cwd: "/tmp" });
      await req(c, acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "ask" }] });
      const ok = await waitForIdle(updates, 8000);
      check(ok, "turn settles to idle after decline");
    });
    check(askUserRequests.length === 1, `single _ask_user request (got ${askUserRequests.length})`);
    check((askUserRequests[0]?.params as { mode?: string }).mode === "input", "request mode=input");
    // decline → input returns undefined → askuser fallback "(cancelled)".
    check(lastToolResultText(updates).includes("(cancelled)"), 'decline → cancel fallback in tool result');
  } finally {
    rmSync(atlasDir, { recursive: true, force: true });
  }
}

/** Subprocess test: real stdio framing + EOF graceful exit (Spec §7.6). */
async function testSubprocessFramingAndEof(): Promise<void> {
  console.log("subprocess: stdio framing + EOF");
  const agentDir = mkdtempSync(join(tmpdir(), "pi-acp-sub-"));
  const serverPath = resolve("extensions/pi-acp-v2/server.ts");
  const env = { ...process.env, PI_ACP_V2_FAKE_MODEL: "1", PI_ATLAS_DIR: agentDir };
  const child = spawn("npx", ["tsx", serverPath], { env, stdio: ["pipe", "pipe", "pipe"] });

  const lines: string[] = [];
  const responses = new Map<number, { result?: unknown; error?: unknown }>();
  const notifications: { method: string; params?: any }[] = [];
  let rawOut = "";
  let rawErr = "";
  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");
  child.stdout.on("data", (d: string) => {
    rawOut += d;
    let idx: number;
    while ((idx = rawOut.indexOf("\n")) >= 0) {
      const line = rawOut.slice(0, idx);
      rawOut = rawOut.slice(idx + 1);
      if (!line.trim()) continue;
      lines.push(line);
      let msg: { id?: number; result?: unknown; error?: unknown; method?: string; params?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) responses.set(msg.id, msg);
      else if (msg.method) notifications.push(msg as { method: string; params?: any });
    }
  });
  child.stderr.on("data", (d: string) => (rawErr += d));

  let nextId = 1;
  const send = (method: string, params: unknown): number => {
    const id = nextId++;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return id;
  };
  const waitForResponse = (id: number, timeoutMs = 5000): Promise<{ result?: any; error?: any } | undefined> =>
    new Promise((res) => {
      const existing = responses.get(id);
      if (existing) return res(existing);
      const t = setInterval(() => {
        const r = responses.get(id);
        if (r) {
          clearInterval(t);
          res(r);
        }
      }, 10);
      setTimeout(() => {
        clearInterval(t);
        res(undefined);
      }, timeoutMs);
    });

  try {
    const initId = send("initialize", { protocolVersion: 2, info: { name: "c", version: "1" }, capabilities: {} });
    // Allow ample time for the `npx tsx` cold start (module resolution + compile)
    // before the first response arrives; 5s was too tight under CI load.
    const init = await waitForResponse(initId, 15000);
    check(init?.result && (init.result as any).protocolVersion === 2, "initialize response over stdio");

    const newId = send("session/new", { cwd: "/tmp" });
    const ns = await waitForResponse(newId);
    const sessionId = (ns?.result as { sessionId?: string })?.sessionId;
    check(typeof sessionId === "string" && sessionId.length > 0, "session/new returns sessionId over stdio");

    const promptId = send("session/prompt", { sessionId, prompt: [{ type: "text", text: "Hello" }] });
    const promptResp = await waitForResponse(promptId);
    check(promptResp?.result !== undefined && JSON.stringify(promptResp.result) === "{}", "session/prompt returns {} over stdio");

    // The user_message notification is sent on a deferred macrotask (bridge setTimeout(0));
    // wait for it to flush over stdio + be parsed before asserting ordering (§4.5).
    const userMsgDeadline = Date.now() + 5000;
    while (
      Date.now() < userMsgDeadline &&
      !lines.some((l) => {
        try {
          const m = JSON.parse(l);
          return m.method === "session/update" && m.params?.update?.sessionUpdate === "user_message";
        } catch { return false; }
      })
    )
      await sleep(10);

    // §4.5: the prompt response must NOT be preempted by user_message.
    const promptRespIdx = lines.findIndex((l) => {
      try { return JSON.parse(l).id === promptId; } catch { return false; }
    });
    const userMsgIdx = lines.findIndex((l) => {
      try {
        const m = JSON.parse(l);
        return m.method === "session/update" && m.params?.update?.sessionUpdate === "user_message";
      } catch { return false; }
    });
    check(promptRespIdx !== -1 && userMsgIdx !== -1 && promptRespIdx < userMsgIdx, "prompt response precedes user_message (no preemption)");

    // Wait for the turn to settle (running + idle) over stdio.
    const idleDeadline = Date.now() + 5000;
    while (
      Date.now() < idleDeadline &&
      !notifications.some((n) => n.method === "session/update" && n.params?.update?.state === "idle")
    )
      await sleep(10);
    const states = notifications.filter((n) => n.method === "session/update").map((n) => n.params?.update?.sessionUpdate);
    check(states.includes("agent_message_chunk"), "agent_message_chunk received over stdio");
    const stopReasons = notifications
      .filter((n) => n.params?.update?.state === "idle")
      .map((n) => n.params?.update?.stopReason);
    check(stopReasons.includes("end_turn"), "turn completes idle+end_turn over stdio");

    // Framing: every emitted line is a single JSON object (no embedded newlines in messages).
    let allJson = true;
    for (const line of lines) {
      try {
        JSON.parse(line);
      } catch {
        allJson = false;
        break;
      }
    }
    check(lines.length >= 4 && allJson, `every stdout line valid JSON, no embedded newlines (${lines.length} lines)`);

    // stdin EOF → graceful exit.
    child.stdin.end();
    const code = await new Promise<number>((res) => child.on("exit", (c) => res(c ?? -1)));
    check(code === 0, `process exits 0 on EOF (got ${code})`);
    if (rawErr.trim()) console.log(`  (stderr: ${rawErr.trim().slice(0, 200)})`);
  } finally {
    try {
      child.kill();
    } catch {
      // ignore
    }
    rmSync(agentDir, { recursive: true, force: true });
  }
}

// ---- A2: plan_update bridge (Target tool + /goal command paths) ------------

/** Fresh temp PI_ATLAS_DIR so target state.json never leaks across tests/runs. */
function freshAtlasDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-acp-plan-"));
}

/** Collect plan_update / plan_removed notifications from the update stream. */
function planNotifications(updates: UpdateNotification[]) {
  const planUpdates = updates.filter((u) => u.update.sessionUpdate === "plan_update");
  const planRemoved = updates.filter((u) => u.update.sessionUpdate === "plan_removed");
  return { planUpdates, planRemoved };
}

async function testPlanTargetToolPath(): Promise<void> {
  console.log("plan: Target tool call → plan_update");
  const atlasDir = freshAtlasDir();
  process.env.PI_ATLAS_DIR = atlasDir;
  // turn 0: add "sub task A" (plan_update [{A}]); turn 1: add "sub task B" (plan_update [{A},{B}]); turn 2: Done.
  const script = targetScript([
    { action: "add", args: { text: "sub task A" } },
    { action: "add", args: { text: "sub task B" } },
  ]);
  const { app, clientApp, updates } = harness({ script, extensionFactories: [targetExtension], agentDir: atlasDir });
  try {
    await withClient(app, clientApp, async (c) => {
      await req(c, acp.methods.agent.initialize, { protocolVersion: 2, info: { name: "t", version: "1" }, capabilities: {} });
      const { sessionId } = await req(c, acp.methods.agent.session.new, { cwd: "/tmp" });
      await req(c, acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "add targets" }] });
      const ok = await waitForIdle(updates, 8000);
      check(ok, "tool-use turns settle to idle");
      const { planUpdates } = planNotifications(updates);
      check(planUpdates.length >= 1, `received plan_update (got ${planUpdates.length})`);
      const last = planUpdates[planUpdates.length - 1].update as { plan?: { type?: string; planId?: string; entries?: Array<{ content: string; priority: string; status: string; _meta?: { id: number } }> } };
      check(last.plan?.type === "items", "plan.type=items");
      check(last.plan?.planId === "pi-targets", "planId=pi-targets");
      const entries = last.plan?.entries ?? [];
      check(entries.length === 2, `final plan has 2 entries (got ${entries.length})`);
      check(entries[0]?.content === "sub task A" && entries[0]?._meta?.id === 1, "entry 0 = first secondary");
      check(entries[1]?.content === "sub task B" && entries[1]?._meta?.id === 2, "entry 1 = second secondary");
      check(entries.every((e) => e.priority === "medium"), "all priority=medium");
      check(entries.every((e) => e.status === "in_progress"), "all status=in_progress (active→in_progress)");
    });
  } finally {
    rmSync(atlasDir, { recursive: true, force: true });
  }
}

async function testPlanGoalCommandPath(): Promise<void> {
  console.log("plan: /goal command → plan_update");
  const atlasDir = freshAtlasDir();
  process.env.PI_ATLAS_DIR = atlasDir;
  const script: FakeScript = ({ callIndex }) => (callIndex === 0 ? textTurnEvents("Working on it.") : textTurnEvents("Done."));
  const { app, clientApp, updates } = harness({ script, extensionFactories: [targetExtension], agentDir: atlasDir });
  try {
    await withClient(app, clientApp, async (c) => {
      await req(c, acp.methods.agent.initialize, { protocolVersion: 2, info: { name: "t", version: "1" }, capabilities: {} });
      const { sessionId } = await req(c, acp.methods.agent.session.new, { cwd: "/tmp" });
      await req(c, acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "/goal ship the feature" }] });
      const ok = await waitForIdle(updates, 8000);
      check(ok, "/goal turn settles to idle");
      const { planUpdates } = planNotifications(updates);
      check(planUpdates.length >= 1, `received plan_update from /goal (got ${planUpdates.length})`);
      const last = planUpdates[planUpdates.length - 1].update as { plan?: { planId?: string; entries?: Array<{ content: string; status: string; _meta?: { id: number } }> } };
      check(last.plan?.planId === "pi-targets", "planId=pi-targets");
      const entries = last.plan?.entries ?? [];
      check(entries.length === 1, "primary is the single entry");
      check(entries[0]?.content.includes("ship the feature"), "entry content includes goal text");
      check(entries[0]?.status === "in_progress", "primary active→in_progress");
      check(entries[0]?._meta?.id === 0, "primary _meta.id=0");
    });
  } finally {
    rmSync(atlasDir, { recursive: true, force: true });
  }
}

async function testPlanDedup(): Promise<void> {
  console.log("plan: dedup — identical re-emit sends a single plan_update");
  const atlasDir = freshAtlasDir();
  process.env.PI_ATLAS_DIR = atlasDir;
  // Two turns, both set the SAME full state → second emit is deduped (no new plan_update).
  const script = targetScript([
    { action: "update_targets", args: { text: "P", secondary: [{ text: "S" }] } },
    { action: "update_targets", args: { text: "P", secondary: [{ text: "S" }] } },
  ]);
  const { app, clientApp, updates } = harness({ script, extensionFactories: [targetExtension], agentDir: atlasDir });
  try {
    await withClient(app, clientApp, async (c) => {
      await req(c, acp.methods.agent.initialize, { protocolVersion: 2, info: { name: "t", version: "1" }, capabilities: {} });
      const { sessionId } = await req(c, acp.methods.agent.session.new, { cwd: "/tmp" });
      await req(c, acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "set targets twice" }] });
      const ok = await waitForIdle(updates, 8000);
      check(ok, "turns settle to idle");
      const { planUpdates } = planNotifications(updates);
      check(planUpdates.length === 1, `identical re-emit → single plan_update (got ${planUpdates.length})`);
    });
  } finally {
    rmSync(atlasDir, { recursive: true, force: true });
  }
}

async function testPlanRemovedOnClear(): Promise<void> {
  console.log("plan: clear targets → plan_removed");
  const atlasDir = freshAtlasDir();
  process.env.PI_ATLAS_DIR = atlasDir;
  // turn 0: add a secondary (state non-empty → plan_update). turn 1: update_targets with secondary:[]
  // (primaryText null → primary stays null; secondary cleared → empty state → plan_removed).
  const script = targetScript([
    { action: "add", args: { text: "temp task" } },
    { action: "update_targets", args: { secondary: [] } },
  ]);
  const { app, clientApp, updates } = harness({ script, extensionFactories: [targetExtension], agentDir: atlasDir });
  try {
    await withClient(app, clientApp, async (c) => {
      await req(c, acp.methods.agent.initialize, { protocolVersion: 2, info: { name: "t", version: "1" }, capabilities: {} });
      const { sessionId } = await req(c, acp.methods.agent.session.new, { cwd: "/tmp" });
      await req(c, acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "manage" }] });
      const ok = await waitForIdle(updates, 8000);
      check(ok, "turns settle to idle");
      const { planUpdates, planRemoved } = planNotifications(updates);
      check(planUpdates.length >= 1, "received plan_update when a target was added");
      check(planRemoved.length >= 1, `received plan_removed on clear (got ${planRemoved.length})`);
      const removed = planRemoved[planRemoved.length - 1].update as { planId?: string };
      check(removed.planId === "pi-targets", "plan_removed planId=pi-targets");
      const idxUpdate = updates.findIndex((u) => u.update.sessionUpdate === "plan_update");
      const idxRemoved = updates.findIndex((u) => u.update.sessionUpdate === "plan_removed");
      check(idxUpdate !== -1 && idxRemoved !== -1 && idxUpdate < idxRemoved, "plan_update precedes plan_removed");
    });
  } finally {
    rmSync(atlasDir, { recursive: true, force: true });
  }
}

async function testNoPlanWhenNeverHadTarget(): Promise<void> {
  console.log("plan: never had a target → no plan emitted");
  const atlasDir = freshAtlasDir();
  process.env.PI_ATLAS_DIR = atlasDir;
  const { app, clientApp, updates } = harness({ extensionFactories: [targetExtension], agentDir: atlasDir });
  try {
    await withClient(app, clientApp, async (c) => {
      await req(c, acp.methods.agent.initialize, { protocolVersion: 2, info: { name: "t", version: "1" }, capabilities: {} });
      const { sessionId } = await req(c, acp.methods.agent.session.new, { cwd: "/tmp" });
      await req(c, acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "hello" }] });
      const ok = await waitForIdle(updates, 8000);
      check(ok, "turn settles to idle");
      const { planUpdates, planRemoved } = planNotifications(updates);
      check(planUpdates.length === 0 && planRemoved.length === 0, `no plan emitted when no target ever set (got ${planUpdates.length}+${planRemoved.length})`);
    });
  } finally {
    rmSync(atlasDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await testInitializeAndCapabilities();
  await testPromptStreaming();
  await testCancel();
  await testSessionBusy();
  await testToolUseTurn();
  await testListAndResume();
  await testCloseAndErrors();
  await testAskUserCapabilityNoCrash();
  await testMessageIdEntryMapping();
  await testSlashCommandNoDeadlock();
  await testPlanTargetToolPath();
  await testPlanGoalCommandPath();
  await testPlanDedup();
  await testPlanRemovedOnClear();
  await testNoPlanWhenNeverHadTarget();
  await testAskUserSelect();
  await testAskUserConfirm();
  await testAskUserInput();
  await testAskUserGated();
  await testAskUserDecline();
  await testSubprocessFramingAndEof();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
