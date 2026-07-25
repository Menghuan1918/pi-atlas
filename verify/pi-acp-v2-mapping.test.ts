/**
 * Unit tests for the pure event→session/update mapper.
 * No model, no ACP transport — just canned AgentSessionEvents → SessionUpdate[].
 */
import { UpdateMapper, mapStopReason } from "../extensions/pi-acp-v2/mapping.js";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";

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

function msg(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "x",
    model: "m",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: 1,
  };
}

// ---- canned AgentSessionEvent constructors ----
const ev = {
  agentStart: (): AgentSessionEvent => ({ type: "agent_start" }),
  textStart: (m: AssistantMessage): AgentSessionEvent => ({ type: "message_update", message: m, assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: m } }),
  textDelta: (m: AssistantMessage, delta: string): AgentSessionEvent => ({ type: "message_update", message: m, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: m } }),
  textEnd: (m: AssistantMessage, content: string): AgentSessionEvent => ({ type: "message_update", message: m, assistantMessageEvent: { type: "text_end", contentIndex: 0, content, partial: m } }),
  msgEnd: (m: AssistantMessage): AgentSessionEvent => ({ type: "message_end", message: m }),
  turnEnd: (m: AssistantMessage): AgentSessionEvent => ({ type: "turn_end", message: m, toolResults: [] }),
  settled: (): AgentSessionEvent => ({ type: "agent_settled" }),
  toolStart: (id: string, name: string, args: unknown): AgentSessionEvent => ({ type: "tool_execution_start", toolCallId: id, toolName: name, args }),
  toolUpdate: (id: string, name: string, partial: unknown): AgentSessionEvent => ({ type: "tool_execution_update", toolCallId: id, toolName: name, args: {}, partialResult: partial }),
  toolEnd: (id: string, name: string, result: unknown, isError: boolean): AgentSessionEvent => ({ type: "tool_execution_end", toolCallId: id, toolName: name, result, isError }),
};

function runAll(events: AgentSessionEvent[], idFactory: () => string): SessionUpdate[] {
  const mapper = new UpdateMapper({ idFactory });
  const out: SessionUpdate[] = [];
  for (const e of events) out.push(...mapper.reduce(e));
  return out;
}

function types(updates: SessionUpdate[]): string[] {
  return updates.map((u) => u.sessionUpdate);
}

async function main(): Promise<void> {
  // deterministic id factory
  let n = 0;
  const ids = () => `m${n++}`;

  console.log("mapStopReason");
  check(mapStopReason("stop") === "end_turn", "stop→end_turn");
  check(mapStopReason("toolUse") === "end_turn", "toolUse→end_turn");
  check(mapStopReason("length") === "max_tokens", "length→max_tokens");
  check(mapStopReason("aborted") === "cancelled", "aborted→cancelled");
  check(mapStopReason("error") === "refusal", "error→refusal");

  console.log("full text turn ordering");
  {
    const m = msg("Hello world");
    const updates = runAll(
      [ev.agentStart(), ev.textStart(m), ev.textDelta(m, "Hello"), ev.textDelta(m, " world"), ev.textEnd(m, "Hello world"), ev.msgEnd(m), ev.turnEnd(m), ev.settled()],
      ids,
    );
    // user_message is sent by the bridge, not the mapper; here we assert mapper output only.
    check(types(updates).join(",") === "state_update,agent_message_chunk,agent_message_chunk,agent_message,state_update", `order: ${types(updates).join(",")}`);
    const running = updates[0];
    check(running.sessionUpdate === "state_update" && running.state === "running", "first is running");
    const c1 = updates[1];
    check(c1.sessionUpdate === "agent_message_chunk" && (c1 as any).content.text === "Hello", "chunk 1 text");
    const c2 = updates[2];
    check(c2.sessionUpdate === "agent_message_chunk" && (c2 as any).content.text === " world", "chunk 2 text");
    check((c1 as any).messageId === (c2 as any).messageId, "chunks share messageId (monotonic/stable)");
    const full = updates[3];
    check(full.sessionUpdate === "agent_message" && (full as any).content[0].text === "Hello world", "agent_message full replace");
    check((full as any).messageId === (c1 as any).messageId, "agent_message same messageId");
    const idle = updates[4];
    check(idle.sessionUpdate === "state_update" && idle.state === "idle" && (idle as any).stopReason === "end_turn", "ends idle+end_turn");
  }

  console.log("user_message precedes running (bridge contract): mapper emits running on agent_start");
  {
    const updates = runAll([ev.agentStart()], ids);
    check(updates.length === 1 && updates[0].sessionUpdate === "state_update" && (updates[0] as any).state === "running", "agent_start→running only");
  }

  console.log("stopReason variants");
  for (const [pi, acp] of [["stop", "end_turn"], ["length", "max_tokens"], ["aborted", "cancelled"], ["error", "refusal"]] as const) {
    const m = msg("x", pi as AssistantMessage["stopReason"]);
    const updates = runAll([ev.agentStart(), ev.turnEnd(m), ev.settled()], ids);
    const idle = updates[updates.length - 1];
    check((idle as any).stopReason === acp, `turn_end ${pi} → idle ${acp} (got ${(idle as any).stopReason})`);
  }

  console.log("tool call mapping");
  {
    const updates = runAll(
      [ev.toolStart("tc1", "read", { path: "/a" }), ev.toolUpdate("tc1", "read", { content: [{ type: "text", text: "line1\nline2" }] }), ev.toolEnd("tc1", "read", { content: [{ type: "text", text: "line1\nline2" }] }, false)],
      ids,
    );
    check(types(updates).join(",") === "tool_call_update,tool_call_update,tool_call_update", "three tool_call_updates");
    const start = updates[0] as any;
    check(start.toolCallId === "tc1" && start.name === "read" && start.status === "in_progress" && JSON.stringify(start.rawInput) === '{"path":"/a"}', "tool start in_progress + rawInput");
    const upd = updates[1] as any;
    check(upd.content?.length === 1 && upd.content[0].text === "line1\nline2", "tool update content (replace semantics)");
    const end = updates[2] as any;
    check(end.status === "completed", "tool end completed");
  }

  console.log("tool error → failed");
  {
    const updates = runAll([ev.toolEnd("tc2", "bash", "boom", true)], ids);
    check((updates[0] as any).status === "failed", "isError→failed");
  }

  console.log("cancel: aborted turn → idle+cancelled");
  {
    const m = msg("partial", "aborted");
    const updates = runAll([ev.agentStart(), ev.textStart(m), ev.textDelta(m, "partial"), ev.turnEnd(m), ev.settled()], ids);
    const idle = updates[updates.length - 1];
    check(idle.sessionUpdate === "state_update" && (idle as any).stopReason === "cancelled", "aborted turn → idle+cancelled");
  }

  console.log("mapper resets between turns");
  {
    const mapper = new UpdateMapper({ idFactory: ids });
    const out: SessionUpdate[] = [];
    for (const e of [ev.agentStart(), ev.textDelta(msg("a"), "a"), ev.msgEnd(msg("a")), ev.turnEnd(msg("a")), ev.settled()]) out.push(...mapper.reduce(e));
    // after settle, mapper.reset() called internally; a new turn gets a fresh messageId
    const before = (out.find((u) => u.sessionUpdate === "agent_message_chunk") as any)?.messageId;
    const out2: SessionUpdate[] = [];
    for (const e of [ev.agentStart(), ev.textDelta(msg("b"), "b"), ev.turnEnd(msg("b")), ev.settled()]) out2.push(...mapper.reduce(e));
    const after = (out2.find((u) => u.sessionUpdate === "agent_message_chunk") as any)?.messageId;
    check(before !== after, "new turn → new messageId (reset works)");
  }
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
