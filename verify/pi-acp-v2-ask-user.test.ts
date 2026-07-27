/**
 * A3 unit tests — _ask_user mapping + capability gating, no LLM/network.
 *
 * Covers:
 *   - select/confirm/input ↔ _ask_user request shape + response mapping
 *   - decline/cancel/timeout → pi cancel value (undefined/false)
 *   - client disconnect (reject) → tool surfaces error (rejects)
 *   - askUserExcludeToolsResolver: declared → enabled, undeclared → excluded
 *
 * Run: tsx verify/pi-acp-v2-ask-user.test.ts
 */
import type { AgentContext } from "@agentclientprotocol/sdk/experimental/v2";
import {
  createAskUserUiContext,
  mapConfirmResponse,
  mapInputResponse,
  mapSelectResponse,
  type AskUserDeps,
  type AskUserResponse,
} from "../extensions/pi-acp-v2/ask-user-ui.js";
import {
  askUserExcludeToolsResolver,
  clientDeclares,
  VENDOR_CAPABILITIES,
} from "../extensions/pi-acp-v2/types.js";

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

/** A fake ACP client that records every `request` call and replies per `behavior`. */
function fakeClient(behavior: (params: unknown) => Promise<AskUserResponse>): {
  client: AgentContext;
  requests: { method: string; params: unknown }[];
} {
  const requests: { method: string; params: unknown }[] = [];
  const client = {
    request(method: string, params: unknown): Promise<AskUserResponse> {
      requests.push({ method, params });
      return behavior(params);
    },
  } as unknown as AgentContext;
  return { client, requests };
}

/** Build a uiContext wired to a fake client that always replies `resp`. */
function uiWith(resp: AskUserResponse): { ui: ReturnType<typeof createAskUserUiContext>; requests: { method: string; params: unknown }[] } {
  const { client, requests } = fakeClient(async () => resp);
  const deps: AskUserDeps = { getClient: () => client, getSessionId: () => "sess-1" };
  return { ui: createAskUserUiContext(deps), requests };
}

// ---- mapping helpers (pure) ----------------------------------------------

function testMappingHelpers(): void {
  console.log("mapping helpers");
  const accept = (content: string | boolean): AskUserResponse => ({ action: "accept", content });
  check(mapSelectResponse(accept("A")) === "A", "select accept+string → string");
  check(mapSelectResponse(accept(true)) === undefined, "select accept+non-string → undefined");
  check(mapSelectResponse({ action: "decline" }) === undefined, "select decline → undefined");
  check(mapSelectResponse({ action: "cancel" }) === undefined, "select cancel → undefined");
  check(mapConfirmResponse(accept(true)) === true, "confirm accept+true → true");
  check(mapConfirmResponse(accept(false)) === false, "confirm accept+false → false");
  check(mapConfirmResponse({ action: "decline" }) === false, "confirm decline → false");
  check(mapInputResponse(accept("hello")) === "hello", "input accept+string → string");
  check(mapInputResponse(accept("")) === undefined, "input accept+empty → undefined");
  check(mapInputResponse({ action: "decline" }) === undefined, "input decline → undefined");
}

// ---- select ↔ _ask_user ---------------------------------------------------

async function testSelectBridge(): Promise<void> {
  console.log("select → _ask_user (accept)");
  const { ui, requests } = uiWith({ action: "accept", content: "Option A" });
  const v = await ui.select("Pick one", ["Option A", "Option B"]);
  check(v === "Option A", "returns chosen option");
  check(requests.length === 1, "exactly one _ask_user request");
  const r = requests[0];
  check(r.method === "_ask_user", "method is _ask_user");
  const p = r.params as { sessionId: string; mode: string; title: string; options: string[] };
  check(p.sessionId === "sess-1", "params carry sessionId");
  check(p.mode === "select", "params mode=select");
  check(p.title === "Pick one", "params title passed through");
  check(Array.isArray(p.options) && p.options.includes("Option A") && p.options.includes("Option B"), "params options passed through");
}

async function testSelectDeclineCancel(): Promise<void> {
  console.log("select decline/cancel → undefined");
  const d = uiWith({ action: "decline" });
  check((await d.ui.select("q", ["a", "b"])) === undefined, "decline → undefined");
  const c = uiWith({ action: "cancel" });
  check((await c.ui.select("q", ["a", "b"])) === undefined, "cancel → undefined");
}

// ---- confirm ↔ _ask_user --------------------------------------------------

async function testConfirmBridge(): Promise<void> {
  console.log("confirm → _ask_user (accept true/false)");
  const t = uiWith({ action: "accept", content: true });
  check((await t.ui.confirm("Proceed?", "Proceed?")) === true, "accept+true → true");
  check((t.requests[0].params as { mode: string }).mode === "confirm", "mode=confirm");
  const f = uiWith({ action: "accept", content: false });
  check((await f.ui.confirm("Proceed?", "Proceed?")) === false, "accept+false → false");
  const dec = uiWith({ action: "decline" });
  check((await dec.ui.confirm("Proceed?", "Proceed?")) === false, "decline → false");
}

// ---- input ↔ _ask_user ----------------------------------------------------

async function testInputBridge(): Promise<void> {
  console.log("input → _ask_user (accept string)");
  const t = uiWith({ action: "accept", content: "Alice" });
  check((await t.ui.input("Name?", "your name")) === "Alice", "accept+string → string");
  const p = t.requests[0].params as { mode: string; title: string; placeholder: string };
  check(p.mode === "input", "mode=input");
  check(p.placeholder === "your name", "placeholder passed through");
  const empty = uiWith({ action: "accept", content: "" });
  check((await empty.ui.input("Name?")) === undefined, "accept+empty → undefined");
  const dec = uiWith({ action: "decline" });
  check((await dec.ui.input("Name?")) === undefined, "decline → undefined");
}

// ---- notify (no request) --------------------------------------------------

async function testNotifyNoRequest(): Promise<void> {
  console.log("notify → no _ask_user request");
  const { ui, requests } = uiWith({ action: "accept", content: "x" });
  ui.notify("hello", "info");
  check(requests.length === 0, "notify sends no request");
}

// ---- timeout → cancel value -----------------------------------------------

async function testTimeout(): Promise<void> {
  console.log("timeout → cancel value, late response swallowed");
  // Client never responds.
  const { client, requests } = fakeClient(() => new Promise<AskUserResponse>(() => {}));
  const deps: AskUserDeps = { getClient: () => client, getSessionId: () => "sess-1" };
  const ui = createAskUserUiContext(deps);
  const start = Date.now();
  const s = await ui.select("q", ["a"], { timeout: 50 });
  check(s === undefined, "select timeout → undefined");
  check(Date.now() - start >= 45, "waited ~timeout before resolving");
  const c = await ui.confirm("q", "q", { timeout: 50 });
  check(c === false, "confirm timeout → false");
  const i = await ui.input("q", undefined, { timeout: 50 });
  check(i === undefined, "input timeout → undefined");
  check(requests.length === 3, "each call issued one _ask_user request");
}

// ---- client disconnect → reject (tool error) -----------------------------

async function testReject(): Promise<void> {
  console.log("client disconnect → reject (tool error)");
  const { client } = fakeClient(() => Promise.reject(new Error("connection reset")));
  const deps: AskUserDeps = { getClient: () => client, getSessionId: () => "sess-1" };
  const ui = createAskUserUiContext(deps);
  let threw = false;
  try {
    await ui.select("q", ["a"]);
  } catch {
    threw = true;
  }
  check(threw, "select rejects when client request rejects");

  // No client at all (disconnected before the call).
  const noClient: AskUserDeps = { getClient: () => null, getSessionId: () => "sess-1" };
  let threw2 = false;
  try {
    await createAskUserUiContext(noClient).select("q", ["a"]);
  } catch {
    threw2 = true;
  }
  check(threw2, "select rejects when no client");

  // No active session.
  const noSession: AskUserDeps = { getClient: () => client, getSessionId: () => null };
  let threw3 = false;
  try {
    await createAskUserUiContext(noSession).select("q", ["a"]);
  } catch {
    threw3 = true;
  }
  check(threw3, "select rejects when no active session");
}

// ---- capability gating (excludeToolsResolver) ----------------------------

function testExcludeResolver(): void {
  console.log("askUserExcludeToolsResolver");
  const declared = { _ask_user: {} };
  const undeclared = {};
  check(askUserExcludeToolsResolver(declared).includes("AskUser") === false, "declared → AskUser NOT excluded");
  check(askUserExcludeToolsResolver(declared).length === 0, "declared → empty exclude list");
  const excl = askUserExcludeToolsResolver(undeclared);
  check(excl.includes("AskUser"), "undeclared → AskUser excluded");
  check(excl.length === 1 && excl[0] === "AskUser", "undeclared → only AskUser excluded");
  check(askUserExcludeToolsResolver(undefined).includes("AskUser"), "missing clientMeta → excluded");
  // Consistency with clientDeclares.
  check(clientDeclares(declared, VENDOR_CAPABILITIES.askUser) === true, "clientDeclares agrees: declared");
  check(clientDeclares(undeclared, VENDOR_CAPABILITIES.askUser) === false, "clientDeclares agrees: undeclared");
}

async function main(): Promise<void> {
  testMappingHelpers();
  await testSelectBridge();
  await testSelectDeclineCancel();
  await testConfirmBridge();
  await testInputBridge();
  await testNotifyNoRequest();
  await testTimeout();
  await testReject();
  testExcludeResolver();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
