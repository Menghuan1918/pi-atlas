/**
 * Wires ACP v2 method handlers onto an AgentApp (NOT yet connected).
 *
 * Separating app construction from transport lets `server.ts` connect to stdio
 * while tests connect in-process via `client().connectWith(app, ...)`.
 */
import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import type { AgentApp } from "@agentclientprotocol/sdk/experimental/v2";
import { z } from "zod";
import { PiAcpBridge } from "./bridge.js";

/** Params parsers for the A4 vendor methods (zod schemas double as ParamsParser). */
const forkFromParams = z.object({ sessionId: z.string(), fromMessageId: z.string() });
const rewindToParams = z.object({ sessionId: z.string(), toMessageId: z.string() });

export function createAgentApp(bridge: PiAcpBridge): AgentApp {
  return (
    acp
      .agent({ name: "pi-acp-v2" })
      // Capture the client context so the bridge can send session/update notifications.
      .onConnect((connection) => bridge.onConnect(connection.client))
      .onRequest(acp.methods.agent.initialize, (ctx) => bridge.initialize(ctx.params))
      .onRequest(acp.methods.agent.session.new, (ctx) => bridge.newSession(ctx.params))
      .onRequest(acp.methods.agent.session.list, (ctx) => bridge.listSessions(ctx.params))
      .onRequest(acp.methods.agent.session.resume, (ctx) => bridge.resumeSession(ctx.params))
      .onRequest(acp.methods.agent.session.close, (ctx) => bridge.closeSession(ctx.params.sessionId))
      .onRequest(acp.methods.agent.session.prompt, (ctx) => bridge.prompt(ctx.params.sessionId, ctx.params.prompt))
      .onNotification(acp.methods.agent.session.cancel, (ctx) => {
        void bridge.cancel(ctx.params.sessionId);
      })
      // A4: message-anchored vendor extensions (gated by capabilities._meta).
      .onRequest("_fork_from", forkFromParams, (ctx) => bridge.forkFrom(ctx.params.sessionId, ctx.params.fromMessageId))
      .onRequest("_rewind_to", rewindToParams, (ctx) => bridge.rewindTo(ctx.params.sessionId, ctx.params.toMessageId))
  );
}
