/**
 * Shared types and constants for the pi-acp-v2 adapter.
 */
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

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

/** A no-op ExtensionUIContext placeholder. A3 replaces this with the _ask_user bridge. */
export function placeholderUIContext(): ExtensionUIContext {
  const noop = () => {};
  const pending = () => Promise.resolve(undefined);
  return {
    select: pending,
    confirm: () => Promise.resolve(false),
    input: pending,
    notify: noop,
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
