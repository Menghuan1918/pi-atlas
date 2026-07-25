#!/usr/bin/env tsx
/**
 * pi-acp-v2 adapter entry point — stdio JSON-RPC ACP v2 agent server.
 *
 * Run: `tsx extensions/pi-acp-v2/server.ts` (or `node` after build).
 *
 * Environment:
 *   PI_ACP_V2_FAKE_MODEL=1   Use a deterministic fake model (no LLM/auth/network).
 *                            Intended for conformance/transport tests; not for real use.
 *
 * Lifecycle: reads NDJSON requests from stdin, writes responses/notifications to
 * stdout (one JSON message per line, no embedded newlines). On stdin EOF the
 * connection is closed and the process exits gracefully.
 */
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk/experimental/v2";
import { PiAcpBridge } from "./bridge.js";
import { createAgentApp } from "./agent-app.js";
import { FAKE_MODEL, DEFAULT_FAKE_SCRIPT, createFakeModelRuntime } from "./fake-model.js";

function main(): void {
  const useFakeModel = process.env.PI_ACP_V2_FAKE_MODEL === "1";
  const bridge = new PiAcpBridge(
    useFakeModel ? { model: FAKE_MODEL, modelRuntime: createFakeModelRuntime(DEFAULT_FAKE_SCRIPT) } : {},
  );
  const app = createAgentApp(bridge);

  const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
  const connection = app.connect(stream);

  let closing = false;
  const gracefulClose = (): void => {
    if (closing) return;
    closing = true;
    try {
      connection.close();
    } catch {
      // ignore
    }
    // Allow in-flight writes to flush, then exit.
    setImmediate(() => process.exit(0));
  };

  // stdin EOF → graceful close.
  process.stdin.on("end", gracefulClose);
  process.stdin.on("close", gracefulClose);

  // Never let a single handler error crash the server process.
  process.on("uncaughtException", (err) => {
    console.error("[pi-acp-v2] uncaughtException:", err instanceof Error ? err.message : err);
  });
}

main();
