/**
 * PiAcpBridge — the core ACP v2 ↔ pi bridge.
 *
 * Owns the ACP sessionId ↔ pi AgentSession map, capability negotiation, the
 * shared eventBus, the per-connection excludeTools/uiContext hooks, and the
 * event→session/update translation (delegated to UpdateMapper).
 *
 * Transport-agnostic: a thin `createAgentApp(bridge)` wires ACP method handlers
 * (agent-app.ts); `server.ts` connects that app to stdio, while tests connect it
 * in-process via `client().connectWith(app, ...)`.
 */
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type ExtensionUIContext,
  type InlineExtension,
  type ModelRuntime,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import {
  methods,
  RequestError,
  type AgentContext,
  type ContentBlock,
  type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2";

import { UpdateMapper, toContentBlocks, type PiMessage } from "./mapping.js";
import { MessageIdMap } from "./message-map.js";
import {
  TARGET_CHANGED_CHANNEL,
  isTargetStateEmpty,
  toPlanRemoved,
  toPlanUpdate,
} from "./plan-map.js";
import type { TargetState } from "../target/types.js";
import {
  ADAPTER_NAME,
  ADAPTER_TITLE,
  ADAPTER_VERSION,
  placeholderUIContext,
  readClientMeta,
} from "./types.js";

/** Per-session state. */
export interface SessionHandle {
  sessionId: string;
  session: AgentSession;
  sessionManager: SessionManager;
  mapper: UpdateMapper;
  messageMap: MessageIdMap;
  cwd: string;
  /** messageId awaiting its user entry (recorded on message_end). */
  pendingUserMessageId: string | null;
  /** Adapter-level busy flag (set synchronously in prompt(); cleared on settle). */
  turnInProgress: boolean;
  /** True once a real turn started (agent_start); distinguishes no-turn resolves (slash commands). */
  turnRan: boolean;
  /** True once this session has had a non-empty target (drives plan_removed vs no-op). */
  hasHadTarget: boolean;
  /** Last TargetState JSON sent as a plan (dedup: skip identical re-sends). */
  lastPlanStateJson: string | null;
}

export interface BridgeOptions {
  /** pi agent dir (sessions live under <agentDir>/sessions). Default: ~/.pi/agent. */
  agentDir?: string;
  /** Inject a model (fake for tests). When omitted, createAgentSession uses its default. */
  model?: Model<any>;
  /** Inject a modelRuntime (fake for tests). */
  modelRuntime?: ModelRuntime;
  /** Decide excludeTools per connection from client _meta. A3 overrides. Default: none. */
  excludeToolsResolver?: (clientMeta: unknown) => string[];
  /** UI context for extensions in rpc mode. A3 replaces with the _ask_user bridge. */
  uiContext?: ExtensionUIContext;
  /** Inline extension factories to load (e.g. test commands). */
  extensionFactories?: InlineExtension[];
  /** Deterministic messageId factory for tests. */
  idFactory?: () => string;
}

/** Replicate pi's per-cwd session directory naming (getDefaultSessionDirPath).
 *  Not imported from the SDK because it isn't re-exported from the package root. */
function encodeCwd(cwd: string): string {
  const resolved = resolve(cwd);
  return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}
function piSessionDir(cwd: string, agentDir: string): string {
  return join(agentDir, "sessions", encodeCwd(cwd));
}

/** List all sessions under <agentDir>/sessions (across all cwds). */
async function listAllSessions(agentDir: string): Promise<SessionInfo[]> {
  const root = join(agentDir, "sessions");
  if (!existsSync(root)) return [];
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(root, e.name));
  const results = await Promise.all(dirs.map((d) => SessionManager.listAll(d)));
  return results.flat().sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

/** Convert ACP prompt ContentBlock[] to a plain text string for session.prompt(). */
function contentBlocksToText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("");
}

/** Convert a pi user/assistant message's content to ACP ContentBlock[] (text + image). */
function agentMessageToContentBlocks(message: Extract<PiMessage, { role: "user" | "assistant" }>): ContentBlock[] {
  const content = message.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  const out: ContentBlock[] = [];
  for (const part of content) {
    if (part.type === "text") out.push({ type: "text", text: part.text });
    else if (part.type === "image") out.push({ type: "image", data: part.data, mimeType: part.mimeType });
    // thinking blocks and toolCalls are not part of message content
  }
  return out;
}

export class PiAcpBridge {
  private readonly sessions = new Map<string, SessionHandle>();
  private readonly eventBus = createEventBus();
  private readonly agentDir: string;
  private readonly model?: Model<any>;
  private readonly modelRuntime?: ModelRuntime;
  private readonly excludeToolsResolver: (clientMeta: unknown) => string[];
  private readonly uiContext?: ExtensionUIContext;
  private readonly extensionFactories?: InlineExtension[];
  private readonly idFactory: () => string;
  /** Per-session pending TargetState (latest wins) awaiting a microtask flush. */
  private readonly pendingTargetStates = new Map<string, TargetState>();
  /** True while a microtask flush is scheduled (coalesces same-batch emits). */
  private flushScheduled = false;

  /** Client context for sending notifications (captured on connect). */
  client: AgentContext | null = null;
  /** Client capabilities._meta from initialize (A3/A4 read this for gating). */
  clientMeta: unknown = undefined;

  constructor(options: BridgeOptions = {}) {
    this.agentDir = options.agentDir ?? getAgentDir();
    this.model = options.model;
    this.modelRuntime = options.modelRuntime;
    this.excludeToolsResolver = options.excludeToolsResolver ?? (() => []);
    this.uiContext = options.uiContext;
    this.extensionFactories = options.extensionFactories;
    this.idFactory = options.idFactory ?? defaultIdFactory;
    // A2: forward pi Target progress to the client as ACP plan variants.
    this.eventBus.on(TARGET_CHANGED_CHANNEL, (data) => this.onTargetChanged(data));
  }

  /** Called when the ACP connection opens — capture the client for notifications. */
  onConnect(client: AgentContext): void {
    this.client = client;
  }

  /** Expose the shared eventBus (A2 subscribes to target_changed here). */
  getEventBus() {
    return this.eventBus;
  }

  // ---- ACP method handlers -------------------------------------------------

  initialize(params: { capabilities?: unknown }): {
    protocolVersion: number;
    info: { name: string; title: string; version: string };
    capabilities: Record<string, unknown>;
  } {
    this.clientMeta = readClientMeta(params.capabilities);
    return {
      protocolVersion: 2,
      info: { name: ADAPTER_NAME, title: ADAPTER_TITLE, version: ADAPTER_VERSION },
      capabilities: {
        session: {},
        _meta: { _ask_user: {}, _fork_from: {}, _rewind_to: {} },
      },
    };
  }

  async newSession(params: { cwd: string; mcpServers?: unknown[]; additionalDirectories?: string[] }): Promise<{ sessionId: string }> {
    // A1 ignores mcpServers (MCP-over-ACP out of scope) and additionalDirectories
    // (pi SDK createAgentSession has no multi-root option; deferred).
    const sessionManager = SessionManager.create(params.cwd, piSessionDir(params.cwd, this.agentDir));
    const handle = await this.createSession(params.cwd, sessionManager);
    return { sessionId: handle.sessionId };
  }

  async listSessions(params: { cwd?: string | null }): Promise<{ sessions: Array<{ sessionId: string; cwd: string; title?: string | null; updatedAt?: string | null }> }> {
    let infos: SessionInfo[];
    if (params.cwd) {
      infos = await SessionManager.list(params.cwd, piSessionDir(params.cwd, this.agentDir));
    } else {
      infos = await listAllSessions(this.agentDir);
    }
    return {
      sessions: infos.map((i) => ({
        sessionId: i.id,
        cwd: i.cwd,
        title: i.name ?? null,
        updatedAt: i.modified.toISOString(),
      })),
    };
  }

  async resumeSession(params: { sessionId: string; cwd: string; replayFrom?: { type: string } | null }): Promise<Record<string, never>> {
    const infos = await listAllSessions(this.agentDir);
    const match = infos.find((i) => i.id === params.sessionId);
    if (!match) throw new RequestError(-32602, `Unknown session: ${params.sessionId}`);
    const sessionManager = SessionManager.open(match.path);
    const handle = await this.createSession(params.cwd, sessionManager);
    // replayFrom omitted/null → resume WITHOUT replaying history (session loaded, ready for new prompts);
    // replayFrom {type:"start"} → replay the whole active branch as user/agent messages.
    if (params.replayFrom?.type === "start") {
      this.replayBranch(handle);
    }
    return {};
  }

  async closeSession(sessionId: string): Promise<Record<string, never>> {
    const handle = this.sessions.get(sessionId);
    if (!handle) throw new RequestError(-32602, `Unknown session: ${sessionId}`);
    await this.disposeHandle(handle);
    return {};
  }

  prompt(sessionId: string, promptBlocks: ContentBlock[]): Record<string, never> {
    const handle = this.getHandle(sessionId);
    // Check an adapter-level flag (not just session.isStreaming): isStreaming is only
    // set once the deferred turn starts, so two back-to-back prompts would both pass
    // a streaming-only check. turnInProgress is set synchronously here, before return.
    if (handle.session.isStreaming || handle.turnInProgress) throw new RequestError(-32000, "session busy");
    handle.turnInProgress = true;
    const userMessageId = this.idFactory();
    handle.pendingUserMessageId = userMessageId;
    handle.mapper.reset();
    handle.turnRan = false;
    const text = contentBlocksToText(promptBlocks);
    // Defer to a macrotask so the prompt RESPONSE is written before any update.
    // (A microtask is insufficient: the SDK's responder.respond() is itself awaited
    // after the handler returns, so a microtask-sent user_message still preempts the
    // response. setTimeout(0) runs after the response write chain, preserving order:
    // response {} → user_message → state_update:running → …)
    setTimeout(() => {
      // Session may have been closed during the macrotask gap.
      if (!this.sessions.has(sessionId)) {
        handle.turnInProgress = false;
        return;
      }
      this.notify(sessionId, { sessionUpdate: "user_message", messageId: userMessageId, content: promptBlocks });
      void handle.session
        .prompt(text)
        .then(
          () => {
            // Resolved without a turn (e.g. a slash-command prompt that an extension
            // handled and returned early): bookend the user_message with idle.
            handle.pendingUserMessageId = null;
            if (!handle.turnRan) this.notify(sessionId, { sessionUpdate: "state_update", state: "idle" });
          },
          (err) => {
            // Only emit idle(refusal) if no turn ran (pre-turn error like missing auth);
            // a turn that ran already emitted idle via agent_settled.
            if (!handle.turnRan) {
              this.notify(sessionId, { sessionUpdate: "state_update", state: "idle", stopReason: "refusal" });
            }
            handle.pendingUserMessageId = null;
            this.logError("prompt error", err);
          },
        )
        .finally(() => {
          handle.turnInProgress = false;
        });
    }, 0);
    return {};
  }

  async cancel(sessionId: string): Promise<void> {
    const handle = this.sessions.get(sessionId);
    if (!handle) return; // cancel is a notification; tolerate unknown session
    // Mark in-progress tool calls cancelled (Spec §4.6).
    for (const u of handle.mapper.cancelInProgressToolCalls()) this.notify(sessionId, u);
    await handle.session.abort();
  }

  // ---- internals ----------------------------------------------------------

  private getHandle(sessionId: string): SessionHandle {
    const handle = this.sessions.get(sessionId);
    if (!handle) throw new RequestError(-32602, `Unknown session: ${sessionId}`);
    return handle;
  }

  private async createSession(cwd: string, sessionManager: SessionManager): Promise<SessionHandle> {
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: this.agentDir,
      eventBus: this.eventBus,
      extensionFactories: this.extensionFactories,
    });
    await loader.reload();
    const opts: CreateAgentSessionOptions = {
      cwd,
      agentDir: this.agentDir,
      sessionManager,
      resourceLoader: loader,
      excludeTools: this.excludeToolsResolver(this.clientMeta),
    };
    if (this.model) opts.model = this.model;
    if (this.modelRuntime) opts.modelRuntime = this.modelRuntime;
    const { session } = await createAgentSession(opts);
    return this.attachSession(session, sessionManager, cwd);
  }

  /**
   * Bind extensions + subscribe events for a session obtained via fork/switch
   * (A4 re-bind helper). `fork()`/`switchSession()` yield a NEW AgentSession that
   * must be re-bound and re-subscribed. Returns a fresh handle registered in the
   * session map under the (new) pi sessionId.
   */
  async attachSession(session: AgentSession, sessionManager: SessionManager, cwd: string): Promise<SessionHandle> {
    await session.bindExtensions({ mode: "rpc", uiContext: this.uiContext ?? placeholderUIContext() });
    const handle: SessionHandle = {
      sessionId: sessionManager.getSessionId(),
      session,
      sessionManager,
      mapper: new UpdateMapper({ idFactory: this.idFactory }),
      messageMap: new MessageIdMap(),
      cwd,
      pendingUserMessageId: null,
      turnInProgress: false,
      turnRan: false,
      hasHadTarget: false,
      lastPlanStateJson: null,
    };
    session.subscribe((ev) => this.onPiEvent(handle, ev));
    this.sessions.set(handle.sessionId, handle);
    return handle;
  }

  /** A4 anchor resolver: the entryId immediately before a user message (Spec §5.1). */
  resolveAnchorBefore(sessionId: string, messageId: string): string | null {
    const handle = this.sessions.get(sessionId);
    if (!handle) return null;
    return handle.messageMap.resolveAnchorBefore(messageId, handle.sessionManager.getBranch());
  }

  /** A3/A4 handle access (session, sessionManager, messageMap). */
  getSessionHandle(sessionId: string): SessionHandle | undefined {
    return this.sessions.get(sessionId);
  }

  private onPiEvent(handle: SessionHandle, event: AgentSessionEvent): void {
    const updates = handle.mapper.reduce(event);
    for (const u of updates) this.notify(handle.sessionId, u);
    if (event.type === "agent_start") handle.turnRan = true;
    if (event.type === "agent_settled") handle.turnInProgress = false;

    // Record messageId ↔ entryId. pi emits message_end BEFORE persisting the entry
    // (appendMessage runs synchronously right after the emit), so defer one tick and
    // read the just-appended leaf entry. (entry_appended is never emitted for regular
    // messages — only for custom entries — so it cannot drive this mapping.)
    if (event.type === "message_end") {
      const role = event.message?.role;
      if (role === "user" || role === "assistant") {
        queueMicrotask(() => this.recordMessageMapping(handle, role));
      }
    }
  }

  private recordMessageMapping(handle: SessionHandle, role: "user" | "assistant"): void {
    const leaf = handle.sessionManager.getLeafEntry();
    if (!leaf || leaf.type !== "message" || leaf.message.role !== role) return;
    if (role === "user" && handle.pendingUserMessageId) {
      handle.messageMap.record(handle.pendingUserMessageId, leaf.id);
      handle.pendingUserMessageId = null;
    } else if (role === "assistant") {
      const mid = handle.mapper.currentAssistantMessageId;
      if (mid) handle.messageMap.record(mid, leaf.id);
    }
  }

  // ---- A2: target → plan forwarding ---------------------------------------

  /** Handle a `pi-atlas:target_changed` event: stage the state, coalesce, flush. */
  private onTargetChanged(data: unknown): void {
    const d = data as { sessionId?: unknown; state?: unknown };
    if (
      typeof d?.sessionId !== "string" ||
      !d?.state ||
      typeof d.state !== "object" ||
      Array.isArray(d.state)
    ) {
      return; // malformed payload — skip this update (Spec §5)
    }
    this.pendingTargetStates.set(d.sessionId, d.state as TargetState);
    this.schedulePlanFlush();
  }

  /** Coalesce same-batch emits into a single microtask flush (avoids storms). */
  private schedulePlanFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      this.flushPendingPlans();
    });
  }

  /** Emit one plan variant per pending session (dedup by serialized state). */
  private flushPendingPlans(): void {
    if (this.pendingTargetStates.size === 0) return;
    const pending = [...this.pendingTargetStates.entries()];
    this.pendingTargetStates.clear();
    for (const [sessionId, state] of pending) {
      const handle = this.sessions.get(sessionId);
      if (!handle) continue; // session closed/gone
      const json = JSON.stringify(state);
      if (isTargetStateEmpty(state)) {
        // Cleared: only send plan_removed if we previously sent a plan.
        if (handle.hasHadTarget) {
          this.notify(sessionId, toPlanRemoved());
          handle.hasHadTarget = false;
          handle.lastPlanStateJson = null;
        }
        // else: never had a target → emit nothing (Spec §6.5)
      } else {
        handle.hasHadTarget = true;
        if (json !== handle.lastPlanStateJson) {
          this.notify(sessionId, toPlanUpdate(state));
          handle.lastPlanStateJson = json;
        }
        // else: identical to last sent → skip (dedup, Spec §6.3)
      }
    }
  }

  /** Replay the active branch as user_message / agent_message updates (resume). */
  private replayBranch(handle: SessionHandle): void {
    const branch = handle.sessionManager.getBranch();
    for (const entry of branch) {
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (message.role !== "user" && message.role !== "assistant") continue;
      const messageId = this.idFactory();
      handle.messageMap.record(messageId, entry.id);
      const content = message.role === "assistant" ? toContentBlocks(message) : agentMessageToContentBlocks(message);
      const variant = message.role === "user" ? "user_message" : "agent_message";
      this.notify(handle.sessionId, { sessionUpdate: variant, messageId, content });
    }
  }

  private async disposeHandle(handle: SessionHandle): Promise<void> {
    try {
      if (handle.session.isStreaming) await handle.session.abort();
    } catch {
      // ignore abort errors during close
    }
    try {
      handle.session.dispose();
    } catch {
      // ignore
    }
    this.pendingTargetStates.delete(handle.sessionId);
    this.sessions.delete(handle.sessionId);
  }

  private notify(sessionId: string, update: SessionUpdate): void {
    if (!this.client) return;
    void this.client.notify(methods.client.session.update, { sessionId, update }).catch(() => {
      // connection closed / client gone — best-effort notification
    });
  }

  private logError(label: string, err: unknown): void {
    console.error(`[pi-acp-v2] ${label}:`, err instanceof Error ? err.message : err);
  }
}

let counter = 0;
function defaultIdFactory(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `msg-${Date.now()}-${counter++}`;
}
