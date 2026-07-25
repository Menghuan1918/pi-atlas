/**
 * Wires ACP v2 method handlers onto an AgentApp (NOT yet connected).
 *
 * Separating app construction from transport lets `server.ts` connect to stdio
 * while tests connect in-process via `client().connectWith(app, ...)`.
 */
import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import type { AgentApp } from "@agentclientprotocol/sdk/experimental/v2";
import { PiAcpBridge } from "./bridge.js";

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
  );
}
