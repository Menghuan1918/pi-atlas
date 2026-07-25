/**
 * A3 — the real `ExtensionUIContext` that bridges pi's interactive prompts
 * (`ctx.ui.select/confirm/input/notify`) to the ACP v2 vendor method
 * `_ask_user` (an agent→client request).
 *
 * `_ask_user` is a **client-side** method: the adapter (agent) CALLS it via
 * `client.request("_ask_user", params)` and awaits the response — it does NOT
 * register a handler for it. See notes §2.3.
 *
 * Injection (notes §1.7, verified): `bindExtensions({ mode: "rpc", uiContext })`
 * makes the extension `ctx.ui` return OUR implementation directly (pi's runner
 * stores whatever `ExtensionUIContext` we pass; `mode:"rpc"` only sets
 * `ctx.mode`/`ctx.hasUI` and does not run a serialization subprotocol for
 * `ctx.ui`). So `ctx.ui.select(...)` in the askuser extension hits this code,
 * which issues the `_ask_user` request over the ACP connection.
 *
 * This module is pure (no bridge dependency): `createAskUserUiContext(deps)`
 * closes over a tiny `AskUserDeps` so it can be unit-tested with a fake client.
 */
import type { AgentContext } from "@agentclientprotocol/sdk/experimental/v2";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";

/** The three pi prompt modes we bridge. */
export type AskUserMode = "select" | "confirm" | "input";

/** `_ask_user` request params (agent → client). */
export interface AskUserParams {
  sessionId: string;
  mode: AskUserMode;
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
}

/** `_ask_user` response (client → agent). */
export type AskUserResponse =
  | { action: "accept"; content: string | boolean }
  | { action: "decline" }
  | { action: "cancel" };

/**
 * Minimal bridge surface the uiContext needs. The bridge implements this so
 * the uiContext can reach the ACP client and the active session without a hard
 * dependency on the bridge class (keeps this module unit-testable).
 */
export interface AskUserDeps {
  /** The ACP client to send `_ask_user` requests through, or null if disconnected. */
  getClient(): AgentContext | null;
  /** The ACP sessionId of the session whose turn is currently asking, or null. */
  getSessionId(): string | null;
}

const ASK_USER_METHOD = "_ask_user";

/**
 * Map a `_ask_user` response for a `select` prompt to pi's return value.
 * accept + string  → the chosen option; anything else (decline/cancel/no string)
 * → undefined (pi treats "no selection" as a cancel).
 */
export function mapSelectResponse(r: AskUserResponse): string | undefined {
  return r.action === "accept" && typeof r.content === "string" ? r.content : undefined;
}

/**
 * Map a `_ask_user` response for a `confirm` prompt to a boolean.
 * accept + content===true → true; everything else → false.
 */
export function mapConfirmResponse(r: AskUserResponse): boolean {
  return r.action === "accept" && r.content === true;
}

/**
 * Map a `_ask_user` response for an `input` prompt to pi's return value.
 * accept + non-empty string → the text; accept + empty string → undefined
 * (Spec §3: "空→undefined"); decline/cancel → undefined.
 */
export function mapInputResponse(r: AskUserResponse): string | undefined {
  return r.action === "accept" && typeof r.content === "string" && r.content.length > 0 ? r.content : undefined;
}

/**
 * Race a promise against a local timeout. On timeout, resolve to `onTimeout()`
 * (the cancel value) instead of rejecting — the abandoned request's later
 * settlement is swallowed so it never surfaces as an unhandled rejection.
 *
 * If the promise rejects before the timeout (e.g. client disconnect), the
 * rejection propagates so the calling tool surfaces a tool error (Spec §5).
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined, onTimeout: () => T): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  // Swallow a late settlement after the timeout fires (the request is abandoned).
  promise.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Send a `_ask_user` request and await the client's response. Throws if no client/session. */
async function sendAskUser(deps: AskUserDeps, params: Omit<AskUserParams, "sessionId">): Promise<AskUserResponse> {
  const client = deps.getClient();
  const sessionId = deps.getSessionId();
  if (!client) throw new Error("[pi-acp-v2] _ask_user: no ACP client (connection not established)");
  if (!sessionId) throw new Error("[pi-acp-v2] _ask_user: no active session (no turn in progress)");
  return client.request<AskUserResponse>(ASK_USER_METHOD, { sessionId, ...params });
}

/**
 * Build the real `ExtensionUIContext` that bridges pi prompts to ACP `_ask_user`.
 * Only `select`/`confirm`/`input`/`notify` are meaningful; every other UI method
 * is a no-op (rpc mode has no TUI surface).
 */
export function createAskUserUiContext(deps: AskUserDeps): ExtensionUIContext {
  const noop = () => {};

  const select = (title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined> =>
    withTimeout(sendAskUser(deps, { mode: "select", title, options }).then(mapSelectResponse), opts?.timeout, () => undefined);

  const confirm = (title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean> =>
    withTimeout(sendAskUser(deps, { mode: "confirm", title, message }).then(mapConfirmResponse), opts?.timeout, () => false);

  const input = (title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined> =>
    withTimeout(sendAskUser(deps, { mode: "input", title, placeholder }).then(mapInputResponse), opts?.timeout, () => undefined);

  const notify = (message: string, type?: "info" | "warning" | "error"): void => {
    // Fire-and-forget: log to stderr (separate from the NDJSON stdout stream),
    // never send a _ask_user request (Spec §3).
    const t = type ?? "info";
    const line = `[pi-acp-v2] notify(${t}): ${message}`;
    if (t === "error") console.error(line);
    else console.warn(line);
  };

  return {
    select,
    confirm,
    input,
    notify,
    // rpc mode has no terminal/editor/widget surface — no-op the rest.
    onTerminalInput: () => noop,
    setStatus: noop,
    setWorkingMessage: noop,
    setWorkingVisible: noop,
    setWorkingIndicator: noop,
    setHiddenThinkingLabel: noop,
    setWidget: noop,
    setFooter: noop,
    setHeader: noop,
    setTitle: noop,
    custom: () => Promise.resolve(undefined as never),
    pasteToEditor: noop,
    setEditorText: noop,
    getEditorText: () => "",
    editor: () => Promise.resolve(undefined),
    addAutocompleteProvider: noop,
    setEditorComponent: noop,
    getEditorComponent: () => undefined,
    get theme() {
      return undefined as never;
    },
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "no UI" }),
    getToolsExpanded: () => false,
    setToolsExpanded: noop,
  } as unknown as ExtensionUIContext;
}
