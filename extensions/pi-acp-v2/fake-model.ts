/**
 * Deterministic fake model + modelRuntime for pi-acp-v2 tests.
 *
 * `createAgentSession` defaults to a real LLM. Tests must not depend on a real
 * model/API key/network, so we inject a fake `ModelRuntime` whose `streamSimple`
 * returns a canned `AssistantMessageEventStream`. This is the single
 * deterministic injection point (the Agent calls `modelRuntime.streamSimple`
 * once per turn via its `streamFn`).
 *
 * The fake respects the per-turn `AbortSignal` (passed by the Agent) so that
 * `session.abort()` surfaces as an `error` event with `stopReason:"aborted"`,
 * which the mapper turns into `state_update{state:"idle",stopReason:"cancelled"}`.
 *
 * In production, the server enables the default fake when
 * `PI_ACP_V2_FAKE_MODEL=1` is set (used by the subprocess framing/EOF test).
 */
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type Usage,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** Minimal fake model: `reasoning:false` so clampThinkingLevel → "off". */
export const FAKE_MODEL = {
  id: "pi-acp-v2-fake",
  name: "pi-acp-v2 fake model",
  api: "anthropic-messages",
  provider: "pi-acp-v2-fake",
  baseUrl: "http://localhost",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  contextWindow: 100_000,
  maxTokens: 4096,
} as unknown as Model<"anthropic-messages">;

function zeroUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

/** Build an AssistantMessage with the given content + stopReason. */
export function makeAssistantMessage(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "pi-acp-v2-fake",
    model: "pi-acp-v2-fake",
    usage: zeroUsage(),
    stopReason,
    timestamp: Date.now(),
  };
}

/** Events for a single text turn that completes normally. */
export function textTurnEvents(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessageEvent[] {
  const msg = makeAssistantMessage([{ type: "text", text }], stopReason);
  return [
    { type: "start", partial: msg },
    { type: "text_start", contentIndex: 0, partial: msg },
    { type: "text_delta", contentIndex: 0, delta: text, partial: msg },
    { type: "text_end", contentIndex: 0, content: text, partial: msg },
    { type: "done", reason: stopReason === "stop" || stopReason === "length" || stopReason === "toolUse" ? stopReason : "stop", message: msg },
  ];
}

/**
 * Events for a turn that streams `partialText` then hangs (no `done`).
 * Used for cancel tests: the turn stays in progress until `session.abort()`
 * fires the signal, at which point the fake pushes an `error(aborted)`.
 */
export function hangingTurnEvents(partialText: string): AssistantMessageEvent[] {
  const msg = makeAssistantMessage([{ type: "text", text: partialText }], "aborted");
  return [
    { type: "start", partial: msg },
    { type: "text_start", contentIndex: 0, partial: msg },
    { type: "text_delta", contentIndex: 0, delta: partialText, partial: msg },
  ];
}

/** Extract the last user message text from an LLM context (for echo-style scripts). */
export function lastUserText(context: Context): string {
  const messages = context?.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user") {
      const content = m.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content
          .filter((c): c is { type: "text"; text: string } => typeof c === "object" && c?.type === "text")
          .map((c) => c.text)
          .join("");
      }
    }
  }
  return "";
}

/** A script produces the canned events for one agent turn. */
export type FakeScript = (info: { userText: string; callIndex: number }) => AssistantMessageEvent[];

/**
 * Build a fake `ModelRuntime` from a script. The script is called once per
 * agent turn; its events are pushed onto a fresh `AssistantMessageEventStream`.
 * If the per-turn `AbortSignal` fires before the stream completes, an
 * `error(aborted)` is pushed so `session.abort()` resolves cleanly.
 */
export function createFakeModelRuntime(script: FakeScript): ModelRuntime {
  let callIndex = 0;
  return {
    hasConfiguredAuth: () => true,
    streamSimple: (_model: unknown, context: unknown, opts?: { signal?: AbortSignal }): AssistantMessageEventStream => {
      const stream = createAssistantMessageEventStream();
      const signal = opts?.signal;
      const userText = lastUserText((context as Context) ?? { messages: [] });
      const events = script({ userText, callIndex: callIndex++ });

      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            // push() is a no-op once the stream is already done.
            stream.push({ type: "error", reason: "aborted", error: makeAssistantMessage([], "aborted") });
          },
          { once: true },
        );
      }

      queueMicrotask(() => {
        for (const e of events) stream.push(e);
        // `done`/`error` events complete the stream automatically; no end() needed.
      });
      return stream;
    },
  } as unknown as ModelRuntime;
}

/** Default fake script for the env-gated server: echo the user's text. */
export const DEFAULT_FAKE_SCRIPT: FakeScript = ({ userText }) => textTurnEvents(`echo: ${userText}`);
