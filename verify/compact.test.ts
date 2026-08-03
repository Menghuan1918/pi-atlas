/**
 * compact extension — unit + orchestration tests.
 * Run: npx tsx verify/compact.test.ts
 *
 * Covers: pure helpers (redactSecrets, formatTargets, fileListsFromOps,
 * buildSystemPrompt, buildUserMessage) and the runCompaction orchestration via
 * dependency injection (fake `complete` + fake serializer), including the
 * fallback paths (no model, auth fail, empty summary, throw) and the target-system
 * + previous-summary + no-maxTokens integration.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

import { runCompaction, type CompactDeps } from "../extensions/compact/index.js";
import {
	buildSystemPrompt,
	buildUserMessage,
	fileListsFromOps,
	formatTargets,
	redactSecrets,
} from "../extensions/compact/summarize.js";
import { getStatePath } from "../extensions/target/persistence.js";
import type { TargetState } from "../extensions/target/types.js";

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

// Isolate pi-atlas storage to a temp dir.
const tmpDir = mkdtempSync(join(tmpdir(), "compact-test-"));
process.env.PI_ATLAS_DIR = tmpDir;

// ---------- pure helpers ----------

console.log("redactSecrets:");
assert(redactSecrets(`key=sk-${"a".repeat(30)}`).includes("[REDACTED:openai-key]"), "redacts OpenAI key");
assert(redactSecrets(`Bearer ${"y".repeat(25)}`).includes("[REDACTED:bearer]"), "redacts Bearer token");
assert(redactSecrets(`ghp_${"z".repeat(40)}`).includes("[REDACTED:github-token]"), "redacts GitHub token");
assert(redactSecrets(`password=${"s".repeat(8)}`).includes("[REDACTED:assignment]"), "redacts password= assignment");
assert(redactSecrets(`the access token is cool`).includes("access token"), "leaves prose 'access token' untouched");

console.log("\nformatTargets:");
const emptyState: TargetState = { primary: null, secondary: [], autoContinue: false };
assert(formatTargets(null) === "", "null → empty block");
assert(formatTargets(emptyState) === "", "empty state → empty block");
const state: TargetState = {
	primary: { id: 0, text: "build compact ext", status: "active" },
	secondary: [
		{ id: 1, text: "write tests", status: "completed" },
		{ id: 2, text: "wire symlink", status: "active" },
	],
	autoContinue: true,
};
const tb = formatTargets(state);
assert(tb.includes("build compact ext"), "includes primary goal");
assert(tb.includes("[completed]"), "includes target status");
assert(tb.includes("[#2]"), "includes secondary target id");
assert(tb.includes("auto-continue: on"), "includes auto-continue state");

console.log("\nfileListsFromOps:");
const lists = fileListsFromOps({
	read: new Set(["a.ts", "b.ts", "c.ts"]),
	written: new Set(["b.ts"]),
	edited: new Set(["c.ts", "d.ts"]),
});
assert(JSON.stringify(lists.readFiles) === JSON.stringify(["a.ts"]), "readFiles = only-read files");
assert(
	JSON.stringify([...lists.modifiedFiles].sort()) === JSON.stringify(["b.ts", "c.ts", "d.ts"]),
	"modifiedFiles = written ∪ edited",
);
assert(
	JSON.stringify(fileListsFromOps(null).readFiles) === "[]",
	"null fileOps → empty lists",
);

console.log("\nbuildSystemPrompt:");
const sp = buildSystemPrompt();
assert(sp.includes("## Goal & Targets"), "has Goal & Targets section");
assert(sp.includes("## Active Files"), "has Active Files section");
assert(sp.includes("EXACT wording"), "has verbatim-preservation rule");
assert(sp.includes("<previous-summary>"), "explains previous-summary update rule");
assert(sp.includes("<targets>"), "explains targets rule");

console.log("\nbuildUserMessage:");
const um = buildUserMessage({
	conversationText: "CONVO",
	previousSummary: "PREV",
	targetsBlock: "TGT",
	readFiles: ["a.ts"],
	modifiedFiles: ["b.ts"],
	customInstructions: "focus on X",
	reason: "manual",
});
assert(um.includes("<conversation>"), "includes conversation block");
assert(um.includes("<previous-summary>"), "includes previous-summary when given");
assert(um.includes("PREV"), "embeds previous summary text");
assert(um.includes("<targets>"), "includes targets when given");
assert(um.includes("<active-files>"), "includes active-files when files present");
assert(um.includes("<custom-instructions>"), "includes custom-instructions when given");
const um2 = buildUserMessage({ conversationText: "C", reason: "overflow" });
assert(!um2.includes("<previous-summary>"), "omits previous-summary when absent");
assert(!um2.includes("<active-files>"), "omits active-files when no files");
assert(um2.includes("<note>"), "overflow reason adds a note");
assert(!buildUserMessage({ conversationText: "C", reason: "manual" }).includes("<note>"), "manual reason omits note");

// ---------- runCompaction orchestration (DI) ----------

/** A capturing fake `complete`. Inspect `captured` after a call. */
let captured: { model: unknown; context: unknown; options: unknown } | null = null;
const fakeComplete = async (model: unknown, context: unknown, options: unknown) => {
	captured = { model, context, options };
	return { content: [{ type: "text", text: "SUMMARY" }], usage: { total: 150 } };
};
const fakeSerialize = (_messages: unknown[]) => "FAKE CONVO TEXT";
const deps: CompactDeps = { complete: fakeComplete as unknown as CompactDeps["complete"], serializeText: fakeSerialize };

function makeEvent(overrides: Partial<{ previousSummary: string; reason: "manual" | "threshold" | "overflow"; customInstructions: string }> = {}): SessionBeforeCompactEvent {
	return {
		preparation: {
			messagesToSummarize: [],
			turnPrefixMessages: [],
			tokensBefore: 5000,
			firstKeptEntryId: "entry-kept-1",
			previousSummary: overrides.previousSummary,
			isSplitTurn: false,
			fileOps: { read: new Set(["r.ts"]), written: new Set(["w.ts"]), edited: new Set<string>() },
			settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
		},
		branchEntries: [],
		reason: overrides.reason ?? "manual",
		willRetry: false,
		signal: new AbortController().signal,
		customInstructions: overrides.customInstructions,
	} as unknown as SessionBeforeCompactEvent;
}

interface CtxOpts {
	ok?: boolean;
	apiKey?: string | null;
	model?: unknown;
}
function makeCtx(opts: CtxOpts = {}): ExtensionContext {
	return {
		model: opts.model === undefined ? { id: "test-model", provider: "test", api: "anthropic-messages" } : opts.model,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({
				ok: opts.ok !== false,
				apiKey: opts.apiKey === undefined ? "test-key" : opts.apiKey,
				headers: {},
				env: {},
			}),
		},
		sessionManager: { getSessionId: () => "compact-test" },
		ui: { notify: () => {} },
	} as unknown as ExtensionContext;
}

console.log("\nrunCompaction — happy path:");
captured = null;
const result = await runCompaction(makeEvent(), makeCtx(), deps);
assert(!!result && !!result.compaction, "returns a compaction result");
const cmp = (result as { compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; details: { readFiles: string[]; modifiedFiles: string[] }; usage?: unknown } }).compaction;
assert(cmp.summary === "SUMMARY", "summary is the model output");
assert(cmp.firstKeptEntryId === "entry-kept-1", "firstKeptEntryId preserved from preparation");
assert(cmp.tokensBefore === 5000, "tokensBefore preserved from preparation");
assert(JSON.stringify(cmp.details.modifiedFiles) === JSON.stringify(["w.ts"]), "details.modifiedFiles computed from fileOps");
assert(JSON.stringify(cmp.details.readFiles) === JSON.stringify(["r.ts"]), "details.readFiles computed from fileOps");
assert(captured !== null, "complete was called");
const opts = (captured as unknown as { options: Record<string, unknown> }).options;
assert(opts.maxTokens === undefined, "no maxTokens cap (effectiveness first)");
assert(opts.cacheRetention === "none", "cacheRetention none");
assert(typeof opts.sessionId === "string", "fresh sessionId passed");

console.log("\nrunCompaction — fallback paths:");
assert((await runCompaction(makeEvent(), makeCtx({ model: null }), deps)) === undefined, "no model → fallback");
assert((await runCompaction(makeEvent(), makeCtx({ ok: false }), deps)) === undefined, "auth fails → fallback");
assert(
	(await runCompaction(makeEvent(), makeCtx(), { complete: (async () => ({ content: [{ type: "text", text: "   " }] })) as unknown as CompactDeps["complete"], serializeText: fakeSerialize })) === undefined,
	"empty summary → fallback",
);
assert(
	(await runCompaction(makeEvent(), makeCtx(), { complete: (async () => { throw new Error("boom"); }) as unknown as CompactDeps["complete"], serializeText: fakeSerialize })) === undefined,
	"complete throws → fallback",
);

console.log("\nrunCompaction — previous-summary + targets integration:");
// Write a target state file for the test session so loadTargetState finds it.
const statePath = getStatePath("compact-test");
mkdirSync(dirname(statePath), { recursive: true });
const targetState: TargetState = {
	primary: { id: 0, text: "the overarching goal", status: "active" },
	secondary: [{ id: 1, text: "a sub-target", status: "active" }],
	autoContinue: true,
};
writeFileSync(statePath, JSON.stringify({ sessionId: "compact-test", state: targetState }));

captured = null;
await runCompaction(makeEvent({ previousSummary: "OLD SUMMARY" }), makeCtx(), deps);
const userText = ((captured as unknown as { context: { messages: Array<{ content: Array<{ text?: string }> }> } }).context.messages[0].content[0].text) ?? "";
assert(userText.includes("<previous-summary>"), "prompt includes <previous-summary> when previousSummary set");
assert(userText.includes("OLD SUMMARY"), "prompt embeds previous summary text");
assert(userText.includes("<targets>"), "prompt includes <targets> when target state exists");
assert(userText.includes("the overarching goal"), "prompt embeds primary goal from target state");
assert(userText.includes("FAKE CONVO TEXT"), "prompt uses serializer output (redacted conversation)");

// Corrupt target state file → graceful (no <targets>, but still compacts).
writeFileSync(statePath, "{ not valid json");
captured = null;
const resCorrupt = await runCompaction(makeEvent(), makeCtx(), deps);
assert(!!resCorrupt && !!resCorrupt.compaction, "corrupt target state does not break compaction");
const userTextCorrupt = ((captured as unknown as { context: { messages: Array<{ content: Array<{ text?: string }> }> } }).context.messages[0].content[0].text) ?? "";
assert(!userTextCorrupt.includes("<targets>"), "corrupt target state → no <targets> block");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
