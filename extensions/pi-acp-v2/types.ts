/**
 * Shared types and constants for the pi-acp-v2 adapter.
 */

/** Adapter identity advertised in `initialize`. */
export const ADAPTER_NAME = "pi-acp-v2";
export const ADAPTER_TITLE = "pi ACP v2";
export const ADAPTER_VERSION = "0.1.0";

/**
 * Vendor capability keys declared in `capabilities._meta`.
 *
 * The adapter always DECLARES all three (A1 owns the declaration). Whether each
 * is ENABLED for a given connection depends on the client declaring support in
 * its own `capabilities._meta` — A3/A4 read `clientMeta` to gate behavior.
 */
export const VENDOR_CAPABILITIES = {
  askUser: "_ask_user",
  forkFrom: "_fork_from",
  rewindTo: "_rewind_to",
} as const;

/** Read the client's `_meta` capabilities object (may be absent). */
export function readClientMeta(capabilities: unknown): Record<string, unknown> | undefined {
  if (capabilities && typeof capabilities === "object") {
    const meta = (capabilities as { _meta?: unknown })._meta;
    if (meta && typeof meta === "object") return meta as Record<string, unknown>;
  }
  return undefined;
}

/** Whether the client declared a given vendor capability in `capabilities._meta`. */
export function clientDeclares(clientMeta: unknown, key: string): boolean {
  return !!(clientMeta && typeof clientMeta === "object" && (clientMeta as Record<string, unknown>)[key]);
}

/**
 * A3 capability gating: exclude pi's `ask_user` tool unless the client declared
 * the `_ask_user` vendor capability. Wired as the bridge's `excludeToolsResolver`
 * (applied per session via `createAgentSession({ excludeTools })`). When the
 * client did NOT declare `_ask_user`, the tool is hidden from the model and any
 * attempted call fails as "not found" — and no `_ask_user` request is ever sent.
 */
export function askUserExcludeToolsResolver(clientMeta: unknown): string[] {
  return clientDeclares(clientMeta, VENDOR_CAPABILITIES.askUser) ? [] : ["ask_user"];
}
