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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import type { AgentContext, SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";

import { PiAcpBridge } from "../extensions/pi-acp-v2/bridge.js";
import { createAgentApp } from "../extensions/pi-acp-v2/agent-app.js";
import {
  createFakeModelRuntime,
  DEFAULT_FAKE_SCRIPT,
  FAKE_MODEL,
  hangingTurnEvents,
  type FakeScript,
} from "../extensions/pi-acp-v2/fake-model.js";
import { clientDeclares, VENDOR_CAPABILITIES } from "../extensions/pi-acp-v2/types.js";

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
function harness(opts: { script?: FakeScript; clientMeta?: Record<string, unknown>; idFactory?: () => string }) {
  const updates: UpdateNotification[] = [];
  const bridge = new PiAcpBridge({
    model: FAKE_MODEL,
    modelRuntime: createFakeModelRuntime(opts.script ?? DEFAULT_FAKE_SCRIPT),
    idFactory: opts.idFactory,
  });
  const app = createAgentApp(bridge);
  const clientApp = acp
    .client()
    .onNotification(acp.methods.client.session.update, (ctx) => {
      updates.push(ctx.params);
    });
  return { bridge, app, clientApp, updates };
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
  console.log("session/prompt while busy → -32000");
  const script: FakeScript = () => hangingTurnEvents("working");
  const { app, clientApp, updates } = harness({ script });
  await withClient(app, clientApp, async (c) => {
    await req(c, acp.methods.agent.initialize, { protocolVersion: 2, info: { name: "t", version: "1" }, capabilities: {} });
    const { sessionId } = await req(c, acp.methods.agent.session.new, { cwd: "/tmp" });
    await req(c, acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "go" }] });
    while (!updates.some((u) => (u.update as { state?: string }).state === "running")) await sleep(5);
    let code: number | undefined;
    try {
      await req(c, acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "again" }] });
    } catch (e) {
      if (isErr(e)) code = e.code;
    }
    check(code === -32000, `busy prompt → -32000 (got ${code})`);
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
    const init = await waitForResponse(initId);
    check(init?.result && (init.result as any).protocolVersion === 2, "initialize response over stdio");

    const newId = send("session/new", { cwd: "/tmp" });
    const ns = await waitForResponse(newId);
    const sessionId = (ns?.result as { sessionId?: string })?.sessionId;
    check(typeof sessionId === "string" && sessionId.length > 0, "session/new returns sessionId over stdio");

    const promptId = send("session/prompt", { sessionId, prompt: [{ type: "text", text: "Hello" }] });
    const promptResp = await waitForResponse(promptId);
    check(promptResp?.result !== undefined && JSON.stringify(promptResp.result) === "{}", "session/prompt returns {} over stdio");

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

async function main(): Promise<void> {
  await testInitializeAndCapabilities();
  await testPromptStreaming();
  await testCancel();
  await testSessionBusy();
  await testListAndResume();
  await testCloseAndErrors();
  await testAskUserCapabilityNoCrash();
  await testSubprocessFramingAndEof();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
