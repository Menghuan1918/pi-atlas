/**
 * Feishu notify (guard extension) — unit tests.
 *
 * Stubs `globalThis.fetch` to capture the payload; no network. Covers config
 * gating, subagent suppression, and card/payload structure.
 *
 * Run: npx tsx scripts/test-notify.ts
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  buildCard,
  isSubagent,
  loadNotifyConfig,
  notify,
  sign,
} from "../extensions/guard/notify.js";

let pass = 0;
let fail = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.error(`  ✗ ${msg}`);
  }
}

// ── fetch stub ──────────────────────────────────────────────────────
interface Captured {
  url: string;
  payload: any;
}
let captured: Captured | null = null;
const origFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init: any) => {
  captured = { url, payload: JSON.parse(init.body) };
  return new Response(JSON.stringify({ code: 0, msg: "success" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}) as typeof fetch;

// ── config fixture dir ──────────────────────────────────────────────
const tmpRoot = join(tmpdir(), `pi-atlas-notify-${process.pid}-${Date.now()}`);
const atlasDir = join(tmpRoot, "atlas");
process.env.PI_ATLAS_DIR = atlasDir;
mkdirSync(atlasDir, { recursive: true });

const sessionId = "notify-unit";
const ctx = {
  cwd: "/root/Code/pi-atlas",
  mode: "tui",
  sessionManager: { getSessionId: () => sessionId, getCwd: () => "/root/Code/pi-atlas" },
} as unknown as ExtensionContext;

function writeConfig(cfg: unknown): void {
  writeFileSync(join(atlasDir, "notify.json"), JSON.stringify(cfg), "utf-8");
}

console.log("Feishu notify (guard extension)\n");

// ── isSubagent ──────────────────────────────────────────────────────
const savedDepth = process.env.PI_ATLAS_TASK_DEPTH;
process.env.PI_ATLAS_TASK_DEPTH = "0";
assert(!isSubagent(), "depth 0 → not subagent");
process.env.PI_ATLAS_TASK_DEPTH = "2";
assert(isSubagent(), "depth 2 → subagent");
delete process.env.PI_ATLAS_TASK_DEPTH;
assert(!isSubagent(), "unset → not subagent");
process.env.PI_ATLAS_TASK_DEPTH = savedDepth;

// ── loadNotifyConfig gating ─────────────────────────────────────────
assert(loadNotifyConfig() === null, "missing file → null");
writeConfig({ enabled: false, webhookUrl: "https://x/hook" });
assert(loadNotifyConfig() === null, "enabled:false → null");
writeConfig({ enabled: true, webhookSecret: "s" });
assert(loadNotifyConfig() === null, "missing webhookUrl → null");
writeConfig({ webhookUrl: "  " });
assert(loadNotifyConfig() === null, "blank webhookUrl → null");

writeConfig({ webhookUrl: "https://x/hook" });
const c1 = loadNotifyConfig();
assert(c1?.enabled === true, "enabled defaults true when webhook set");
assert(c1?.webhookSecret === "", "no secret → empty string");
assert(c1?.webUrl === "https://pi-web.menghuan1918.com", "webUrl defaults when absent");
writeConfig({ webhookUrl: "https://x/hook", webUrl: "https://custom.example.com" });
assert(loadNotifyConfig()?.webUrl === "https://custom.example.com", "custom webUrl honored");

// ── buildCard structure ─────────────────────────────────────────────
const card = buildCard("askUser", "/root/Code/pi-atlas", sessionId, "https://w.example.com");
assert((card.config as any)?.wide_screen_mode === true, "card wide_screen_mode true");
const header = card.header as any;
assert(/🔔/.test(header.title.content), "askUser header has bell emoji");
assert(header.template === "orange", "askUser template orange");
const div = (card.elements as any[]).find((e) => e.tag === "div");
assert(/Code\/pi-atlas$/.test(div.text.content), "div shows last two dirs of pwd");
const action = (card.elements as any[]).find((e) => e.tag === "action");
const button = action.actions[0];
assert(button.tag === "button", "action contains a button");
assert(button.type === "primary", "button type primary");
assert(button.url === `https://w.example.com/?session=${sessionId}`, "button url has session id");
const card2 = buildCard("sessionEnd", "/a/b", sessionId, "https://w.example.com");
assert((card2.header as any).template === "blue", "sessionEnd template blue");

// ── sign ────────────────────────────────────────────────────────────
assert(typeof sign("1700000000", "secret") === "string", "sign returns a string");
assert(sign("1700000000", "abc") !== sign("1700000000", "xyz"), "sign differs by secret");
assert(sign("1", "s") !== sign("2", "s"), "sign differs by timestamp");

// ── notify: subagent suppression ────────────────────────────────────
process.env.PI_ATLAS_TASK_DEPTH = "1";
writeConfig({ webhookUrl: "https://x/hook" });
captured = null;
await notify(ctx, "sessionEnd");
assert(captured === null, "subagent → no fetch");
process.env.PI_ATLAS_TASK_DEPTH = savedDepth;

// ── notify: disabled config suppression ──────────────────────────────
writeConfig({ enabled: false, webhookUrl: "https://x/hook" });
captured = null;
await notify(ctx, "askUser");
assert(captured === null, "disabled config → no fetch");

// ── notify: happy path (unsigned webhook) ────────────────────────────
writeConfig({ webhookUrl: "https://hook.example.com/v2", webUrl: "https://w.example.com" });
captured = null;
await notify(ctx, "sessionEnd");
assert(captured !== null, "enabled config → fetch called");
assert(captured!.url === "https://hook.example.com/v2", "POSTs to configured webhook");
assert(captured!.payload.msg_type === "interactive", "msg_type interactive");
assert(captured!.payload.timestamp === undefined, "no secret → no timestamp/sign");
assert(
  captured!.payload.card.header.template === "blue",
  "sessionEnd card sent",
);

// ── notify: signed webhook ───────────────────────────────────────────
writeConfig({ webhookUrl: "https://hook.example.com/v2", webhookSecret: "topsecret" });
captured = null;
await notify(ctx, "askUser");
assert(captured!.payload.timestamp !== undefined, "secret → timestamp present");
assert(typeof captured!.payload.sign === "string", "secret → sign present");
assert(
  captured!.payload.card.header.template === "orange",
  "askUser card sent",
);

// ── notify: non-interactive modes suppressed ──────────────────────
writeConfig({ webhookUrl: "https://x/hook" });
const ctxRpc = { ...ctx, mode: "rpc" } as unknown as ExtensionContext;
const ctxPrint = { ...ctx, mode: "print" } as unknown as ExtensionContext;
captured = null;
await notify(ctxRpc, "sessionEnd");
assert(captured === null, "rpc mode → no fetch");
captured = null;
await notify(ctxPrint, "askUser");
assert(captured === null, "print mode → no fetch");
// sanity: tui (the shared ctx) still sends
captured = null;
await notify(ctx, "sessionEnd");
assert(captured !== null, "tui mode → fetch called");

// ── cleanup ─────────────────────────────────────────────────────────
globalThis.fetch = origFetch;
rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
