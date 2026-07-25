/**
 * Pure event→session/update mapper for the pi-acp-v2 bridge.
 *
 * Decoupled from the real pi model driver: feed canned `AgentSessionEvent`s,
 * get back ACP `SessionUpdate` objects. This is the bulk of the streaming
 * correctness and is unit-tested without any model or ACP transport.
 *
 * Mapping reference (verified-reality.md §1.5):
 *   agent_start            → state_update{state:"running"}
 *   message_update(text_*) → agent_message_chunk / agent_message
 *   toolcall_end           → tool_call_update{status:"pending", rawInput}
 *   tool_execution_start   → tool_call_update{status:"in_progress"}
 *   tool_execution_update  → tool_call_update{content} (replace semantics)
 *   tool_execution_end     → tool_call_update{status:"completed"|"failed"}
 *   turn_end               → (capture stopReason)
 *   agent_settled          → state_update{state:"idle", stopReason}
 *
 * running/idle are derived from agent_start / agent_settled (no state_changed
 * event). The final stopReason comes from the last turn_end's message.
 */
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ContentBlock, SessionUpdate, StopReason } from "@agentclientprotocol/sdk/experimental/v2";

/** pi AgentMessage (union) — not re-exported by the SDK, so derive it from the event. */
export type PiMessage = Extract<AgentSessionEvent, { type: "message_end" }>["message"];

/** ACP stop reason, mapped from pi's StopReason. */
export type AcpStopReason = "end_turn" | "max_tokens" | "cancelled" | "refusal";

/** pi StopReason → ACP stopReason. */
export function mapStopReason(reason: string | undefined | null): AcpStopReason {
  switch (reason) {
    case "stop":
    case "toolUse":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "aborted":
      return "cancelled";
    case "error":
      return "refusal";
    default:
      return "end_turn";
  }
}

/** pi AssistantMessage content → ACP ContentBlock[] (text only; thinking/toolcalls handled elsewhere). */
export function toContentBlocks(message: AssistantMessage): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const part of message.content) {
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text });
    }
    // thinking blocks and toolCalls are not part of the agent_message content
    // (tool calls are reported via tool_call_update).
  }
  return blocks;
}

/** Best-effort stringification of a tool result for tool_call content. */
function resultToText(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (typeof result === "object") {
    // pi tool results often carry { content: [{ type:"text", text }] } or a `text` field
    const r = result as Record<string, unknown>;
    if (Array.isArray(r.content)) {
      const texts = r.content
        .map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : ""))
        .filter(Boolean);
      if (texts.length) return texts.join("\n");
    }
    if (typeof r.text === "string") return r.text;
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

export interface UpdateMapperOptions {
  /** Inject an id generator for deterministic messageIds in tests. */
  idFactory?: () => string;
}

/**
 * Stateful reducer: feed `AgentSessionEvent`s via `reduce()`, collect the
 * resulting `SessionUpdate`s. Call `reset()` between prompt turns.
 */
export class UpdateMapper {
  private readonly idFactory: () => string;
  /** messageId for the in-progress assistant message (allocated lazily). */
  private assistantMessageId: string | null = null;
  /** Most recent stopReason captured from turn_end; emitted on idle. */
  private lastStopReason: string | null = null;
  /** toolCallId → known name (so end can still report name if absent). */
  private toolNames = new Map<string, string>();
  /** toolCallId → current status (for cancel marking). */
  private toolStatus = new Map<string, string>();

  constructor(options: UpdateMapperOptions = {}) {
    this.idFactory = options.idFactory ?? defaultIdFactory;
  }

  reset(): void {
    this.assistantMessageId = null;
    this.lastStopReason = null;
    this.toolNames.clear();
    this.toolStatus.clear();
  }

  /** Current assistant messageId (for the bridge to record messageId↔entryId). */
  get currentAssistantMessageId(): string | null {
    return this.assistantMessageId;
  }

  /** toolCallIds currently in_progress (for cancel → mark cancelled). */
  inProgressToolCalls(): string[] {
    return [...this.toolStatus.entries()].filter(([, s]) => s === "in_progress").map(([id]) => id);
  }

  /** Build tool_call_update{status:"cancelled"} for every in-progress tool call. */
  cancelInProgressToolCalls(): SessionUpdate[] {
    return this.inProgressToolCalls().map((id) => ({
      sessionUpdate: "tool_call_update",
      toolCallId: id,
      name: this.toolNames.get(id) ?? null,
      status: "cancelled",
    } as SessionUpdate));
  }

  reduce(event: AgentSessionEvent): SessionUpdate[] {
    switch (event.type) {
      case "agent_start":
        return [{ sessionUpdate: "state_update", state: "running" }];

      case "message_update":
        return this.reduceMessageUpdate(event.assistantMessageEvent);

      case "message_end":
        return this.reduceMessageEnd(event.message);

      case "tool_execution_start":
        return this.reduceToolStart(event.toolCallId, event.toolName, event.args);

      case "tool_execution_update":
        return this.reduceToolUpdate(event.toolCallId, event.toolName, event.partialResult);

      case "tool_execution_end":
        return this.reduceToolEnd(event.toolCallId, event.toolName, event.result, event.isError);

      case "turn_end": {
        const m = event.message;
        this.lastStopReason = m && m.role === "assistant" ? m.stopReason : null;
        return [];
      }

      case "agent_settled": {
        const stopReason: StopReason = mapStopReason(this.lastStopReason);
        const out: SessionUpdate = { sessionUpdate: "state_update", state: "idle", stopReason };
        this.reset();
        return [out];
      }

      // Events A1 does not map (no ACP equivalent in scope, or handled elsewhere).
      case "turn_start":
      case "message_start":
      case "agent_end":
      case "entry_appended":
      case "queue_update":
      case "session_info_changed":
      case "thinking_level_changed":
      case "compaction_start":
      case "compaction_end":
      case "auto_retry_start":
      case "auto_retry_end":
      case "summarization_retry_scheduled":
      case "summarization_retry_attempt_start":
      case "summarization_retry_finished":
        return [];

      default:
        return [];
    }
  }

  private reduceMessageUpdate(e: AssistantMessageEvent): SessionUpdate[] {
    switch (e.type) {
      case "text_start":
        // Allocate the assistant messageId up front so chunks share it.
        this.assistantMessageId ??= this.idFactory();
        return [];
      case "text_delta":
        this.assistantMessageId ??= this.idFactory();
        return [
          {
            sessionUpdate: "agent_message_chunk",
            messageId: this.assistantMessageId,
            content: { type: "text", text: e.delta },
          },
        ];
      default:
        // thinking_*, toolcall_start/delta handled via tool_execution_*; done/error via turn_end.
        return [];
    }
  }

  private reduceMessageEnd(message: PiMessage): SessionUpdate[] {
    if (!message || message.role !== "assistant" || !this.assistantMessageId) return [];
    const content = toContentBlocks(message);
    return [{ sessionUpdate: "agent_message", messageId: this.assistantMessageId, content }];
  }

  private reduceToolStart(toolCallId: string, toolName: string, args: unknown): SessionUpdate[] {
    this.toolNames.set(toolCallId, toolName);
    this.toolStatus.set(toolCallId, "in_progress");
    return [
      {
        sessionUpdate: "tool_call_update",
        toolCallId,
        name: toolName,
        status: "in_progress",
        rawInput: args,
      },
    ];
  }

  private reduceToolUpdate(toolCallId: string, toolName: string, partialResult: unknown): SessionUpdate[] {
    const content = partialResultToContent(partialResult);
    return [
      {
        sessionUpdate: "tool_call_update",
        toolCallId,
        name: toolName,
        content: content.length ? content : null,
      },
    ];
  }

  private reduceToolEnd(toolCallId: string, toolName: string, result: unknown, isError: boolean): SessionUpdate[] {
    const content = partialResultToContent(result);
    this.toolStatus.set(toolCallId, isError ? "failed" : "completed");
    return [
      {
        sessionUpdate: "tool_call_update",
        toolCallId,
        name: toolName,
        status: isError ? "failed" : "completed",
        content: content.length ? content : null,
        rawOutput: result,
      },
    ];
  }
}

/** Map a pi tool partialResult/result (cumulative, replace semantics) to ACP tool content blocks. */
function partialResultToContent(partial: unknown): Array<{ type: "text"; text: string }> {
  if (partial == null) return [];
  if (typeof partial === "string") return [{ type: "text", text: partial }];
  if (typeof partial === "object") {
    const r = partial as Record<string, unknown>;
    if (Array.isArray(r.content)) {
      const texts = r.content
        .map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : ""))
        .filter(Boolean);
      if (texts.length) return texts.map((t) => ({ type: "text" as const, text: t }));
    }
    if (typeof r.text === "string") return [{ type: "text", text: r.text }];
  }
  return [{ type: "text", text: resultToText(partial) }];
}

let counter = 0;
function defaultIdFactory(): string {
  // Prefer crypto.randomUUID when available; fall back to a monotonic counter.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `msg-${Date.now()}-${counter++}`;
}
