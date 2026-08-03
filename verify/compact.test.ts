/**
 * compact extension — unit + orchestration tests.
 * Run: npx tsx verify/compact.test.ts
 *
 * Covers: pure helpers (redactSecrets, formatTargets, fileListsFromOps,
 * buildSystemPrompt, buildUserMessage, isDegenerateSummary) and the runCompaction
 * orchestration via dependency injection (fake `summarize` + fake serializer),
 * including the fallback paths (no model, auth fail, empty, throw, degenerate)
 * and the target-system + previous-summary + no-maxTokens integration.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

import { runCompaction } from "../extensions/compact/index.js";
import {
	buildSystemPrompt,
	buildUserMessage,
	fileListsFromOps,
	formatTargets,
	isDegenerateSummary,
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
assert(JSON.stringify(fileListsFromOps(null).readFiles) === "[]", "null fileOps → empty lists");

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

console.log("\nisDegenerateSummary:");
assert(isDegenerateSummary("", 418260), "empty → degenerate");
assert(
	isDegenerateSummary(
		"## Goal & Targets\n(none)\n## Constraints & Preferences\n(none)\n## Progress\n### Done\n(none)\n## Key Decisions\n(none)\n",
		418260,
	),
	"all-(none) template → degenerate",
);
assert(!isDegenerateSummary("x".repeat(700), 418260), "long summary → not degenerate");
assert(!isDegenerateSummary("short", 1000), "small conversation, short summary → not checked");
assert(isDegenerateSummary("short", 50000), "large conversation, too-short summary → degenerate");

// ---------- runCompaction orchestration (DI) ----------

/** A capturing fake `summarize`. Inspect `captured` after a call. */
let captured: { model: unknown; context: unknown; options: unknown } | null = null;
const fakeSummarize = async (model: unknown, context: unknown, options: unknown) => {
	captured = { model, context, options };
	return { summary: "SUMMARY" };
};
const fakeSerialize = (_messages: unknown[]) => "FAKE CONVO TEXT";

function makeEvent(
	overrides: Partial<{ previousSummary: string; reason: "manual" | "threshold" | "overflow"; customInstructions: string }> = {},
): SessionBeforeCompactEvent {
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
const result = await runCompaction(makeEvent(), makeCtx(), { summarize: fakeSummarize, serializeText: fakeSerialize });
assert(!!result && !!result.compaction, "returns a compaction result");
const cmp = (result as { compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; details: { readFiles: string[]; modifiedFiles: string[] } } }).compaction;
assert(cmp.summary === "SUMMARY", "summary is the model output");
assert(cmp.firstKeptEntryId === "entry-kept-1", "firstKeptEntryId preserved from preparation");
assert(cmp.tokensBefore === 5000, "tokensBefore preserved from preparation");
assert(JSON.stringify(cmp.details.modifiedFiles) === JSON.stringify(["w.ts"]), "details.modifiedFiles computed from fileOps");
assert(JSON.stringify(cmp.details.readFiles) === JSON.stringify(["r.ts"]), "details.readFiles computed from fileOps");
assert(captured !== null, "summarize was called");
const opts = (captured as unknown as { options: Record<string, unknown> }).options;
assert(opts.maxTokens === undefined, "no maxTokens cap (effectiveness first)");
assert(opts.cacheRetention === "none", "cacheRetention none");
assert(typeof opts.sessionId === "string", "fresh sessionId passed");
const userText = ((captured as unknown as { context: { messages: Array<{ content: Array<{ text?: string }> }> } }).context.messages[0].content[0].text) ?? "";
assert(userText.includes("<conversation>"), "prompt includes <conversation>");
assert(userText.includes("FAKE CONVO TEXT"), "prompt uses serializer output (redacted conversation)");

console.log("\nrunCompaction — fallback paths:");
assert((await runCompaction(makeEvent(), makeCtx({ model: null }), { summarize: fakeSummarize, serializeText: fakeSerialize })) === undefined, "no model → fallback");
assert((await runCompaction(makeEvent(), makeCtx({ ok: false }), { summarize: fakeSummarize, serializeText: fakeSerialize })) === undefined, "auth fails → fallback");
assert(
	(await runCompaction(makeEvent(), makeCtx(), { summarize: async () => ({ summary: "   " }), serializeText: fakeSerialize })) === undefined,
	"empty summary → fallback",
);
assert(
	(await runCompaction(makeEvent(), makeCtx(), { summarize: async () => { throw new Error("boom"); }, serializeText: fakeSerialize })) === undefined,
	"summarize throws → fallback",
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
await runCompaction(makeEvent({ previousSummary: "OLD SUMMARY" }), makeCtx(), { summarize: fakeSummarize, serializeText: fakeSerialize });
const txt = ((captured as unknown as { context: { messages: Array<{ content: Array<{ text?: string }> }> } }).context.messages[0].content[0].text) ?? "";
assert(txt.includes("<previous-summary>"), "prompt includes <previous-summary> when previousSummary set");
assert(txt.includes("OLD SUMMARY"), "prompt embeds previous summary text");
assert(txt.includes("<targets>"), "prompt includes <targets> when target state exists");
assert(txt.includes("the overarching goal"), "prompt embeds primary goal from target state");

// Corrupt target state file → graceful (no <targets>, but still compacts).
writeFileSync(statePath, "{ not valid json");
captured = null;
const resCorrupt = await runCompaction(makeEvent(), makeCtx(), { summarize: fakeSummarize, serializeText: fakeSerialize });
assert(!!resCorrupt && !!resCorrupt.compaction, "corrupt target state does not break compaction");
const txtCorrupt = ((captured as unknown as { context: { messages: Array<{ content: Array<{ text?: string }> }> } }).context.messages[0].content[0].text) ?? "";
assert(!txtCorrupt.includes("<targets>"), "corrupt target state → no <targets> block");

console.log("\nrunCompaction — degenerate retry / fallback:");
const degenerateTemplate =
	"## Goal & Targets\n(none)\n## Constraints & Preferences\n(none)\n## Progress\n### Done\n(none)\n## Key Decisions\n(none)\n";
const goodLongSummary =
	"## Goal & Targets\nCompleted the compact extension with redaction, target integration, and fallback handling. " +
	"Detail. ".repeat(60);

const bigEvent = makeEvent();
(bigEvent as { preparation: { tokensBefore: number } }).preparation.tokensBefore = 50000;

// 1st call degenerate, 2nd good → retries, returns the good summary.
let calls = 0;
const flakeSummarize = async () => {
	calls++;
	return { summary: calls === 1 ? degenerateTemplate : goodLongSummary };
};
const retryResult = await runCompaction(bigEvent, makeCtx(), { summarize: flakeSummarize, serializeText: fakeSerialize });
assert(
	retryResult !== undefined && (retryResult as { compaction?: { summary?: string } }).compaction?.summary === goodLongSummary,
	"degenerate-then-good → returns good summary after retry",
);
assert(calls === 2, "retried once (2 model calls)");

// always degenerate → fall back to pi default (return void).
calls = 0;
const alwaysDegenerate = async () => {
	calls++;
	return { summary: degenerateTemplate };
};
const fbResult = await runCompaction(bigEvent, makeCtx(), { summarize: alwaysDegenerate, serializeText: fakeSerialize });
assert(fbResult === undefined, "always-degenerate → falls back to pi default (void)");
assert(calls === 4, "tried 4 times (MAX_ATTEMPTS) before falling back");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
