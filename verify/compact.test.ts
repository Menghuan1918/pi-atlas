/**
 * compact extension — unit + orchestration tests.
 * Run: npx tsx verify/compact.test.ts
 *
 * Covers: pure helpers (formatTargets, fileListsFromOps, buildSystemPrompt,
 * buildAuxiliaryText, isDegenerateSummary) and the runCompaction orchestration via
 * dependency injection (fake `summarize`), including fallback paths
 * (no model, auth fail, empty, throw, degenerate) and the target-system +
 * previous-summary + no-maxTokens + no-tools integration.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

import { runCompaction } from "../extensions/compact/index.js";
import {
	buildAuxiliaryText,
	buildSystemPrompt,
	fileListsFromOps,
	formatTargets,
	isDegenerateSummary,
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

console.log("formatTargets:");
const emptyState: TargetState = { primary: null, secondary: [], autoContinue: false, askUserTimeoutCap: false };
assert(formatTargets(null) === "", "null → empty block");
assert(formatTargets(emptyState) === "", "empty state → empty block");
const state: TargetState = {
	primary: { id: 0, text: "build compact ext", status: "active" },
	secondary: [
		{ id: 1, text: "write tests", status: "completed" },
		{ id: 2, text: "wire symlink", status: "active" },
	],
	autoContinue: true,
	askUserTimeoutCap: false,
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

console.log("\nbuildSystemPrompt (handoff-style):");
const sp = buildSystemPrompt();
assert(sp.includes("## Live Thread"), "has Live Thread section");
assert(sp.includes("## References"), "has References section");
assert(sp.includes("## Suggested Skills"), "has Suggested Skills section");
assert(sp.includes("References, not copies"), "has references-not-copies rule");
assert(sp.includes("Do NOT call any tools"), "has anti-tool-call rule");
assert(sp.includes("Do NOT continue the conversation"), "has anti-continuation rule");
assert(sp.includes("<previous-summary>"), "explains previous-summary update rule");
assert(sp.includes("<targets>"), "explains targets rule");

console.log("\nbuildAuxiliaryText:");
const aux = buildAuxiliaryText({
	previousSummary: "PREV",
	targetsBlock: "TGT",
	readFiles: ["a.ts"],
	modifiedFiles: ["b.ts"],
	customInstructions: "focus on X",
	reason: "manual",
});
assert(aux.includes("<previous-summary>"), "includes previous-summary when given");
assert(aux.includes("PREV"), "embeds previous summary text");
assert(aux.includes("<targets>"), "includes targets when given");
assert(aux.includes("<active-files>"), "includes active-files when files present");
assert(aux.includes("a.ts") && aux.includes("b.ts"), "embeds file lists");
assert(aux.includes("<focus>"), "includes focus (custom instructions) when given");
assert(!aux.includes("<note>"), "manual reason omits overflow note");
const auxOver = buildAuxiliaryText({ reason: "overflow" });
assert(auxOver.includes("<note>"), "overflow reason adds a note");
assert(buildAuxiliaryText({ reason: "manual" }) === "", "all-empty input → empty string");

console.log("\nisDegenerateSummary:");
assert(isDegenerateSummary("", 418260), "empty → degenerate");
assert(
	isDegenerateSummary(
		"## Live Thread\n(none)\n## Key Decisions\n(none)\n## Progress\n### Done\n(none)\n## Next Steps\n(none)\n",
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

function trailingText(): string {
	const ctx = (captured as { context: { messages: Array<{ content: Array<{ text?: string }> }> } }).context;
	const last = ctx.messages[ctx.messages.length - 1];
	return (last.content[0]?.text ?? "") as string;
}

console.log("\nrunCompaction — happy path:");
captured = null;
const result = await runCompaction(makeEvent(), makeCtx(), { summarize: fakeSummarize });
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
// No tools passed to the summarization context (anti-tool-call).
assert(
	(captured as unknown as { context: { tools?: unknown } }).context.tools === undefined,
	"no tools passed to the summarization call (anti-tool-call)",
);
assert(trailingText().includes("Produce the handoff document now"), "trailing turn asks for the handoff");
assert(trailingText().includes("Do NOT continue the conversation or call tools"), "trailing turn forbids continuation/tools");

console.log("\nrunCompaction — fallback paths:");
assert((await runCompaction(makeEvent(), makeCtx({ model: null }), { summarize: fakeSummarize })) === undefined, "no model → fallback");
assert((await runCompaction(makeEvent(), makeCtx({ ok: false }), { summarize: fakeSummarize })) === undefined, "auth fails → fallback");
assert(
	(await runCompaction(makeEvent(), makeCtx(), { summarize: async () => ({ summary: "   " }) })) === undefined,
	"empty summary → fallback",
);
assert(
	(await runCompaction(makeEvent(), makeCtx(), { summarize: async () => { throw new Error("boom"); } })) === undefined,
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
	askUserTimeoutCap: false,
};
writeFileSync(statePath, JSON.stringify({ sessionId: "compact-test", state: targetState }));

captured = null;
await runCompaction(makeEvent({ previousSummary: "OLD SUMMARY" }), makeCtx(), { summarize: fakeSummarize });
const txt = trailingText();
assert(txt.includes("<previous-summary>"), "trailing turn includes <previous-summary> when previousSummary set");
assert(txt.includes("OLD SUMMARY"), "trailing turn embeds previous summary text");
assert(txt.includes("<targets>"), "trailing turn includes <targets> when target state exists");
assert(txt.includes("the overarching goal"), "trailing turn embeds primary goal from target state");

// Corrupt target state file → graceful (no <targets>, but still compacts).
writeFileSync(statePath, "{ not valid json");
captured = null;
const resCorrupt = await runCompaction(makeEvent(), makeCtx(), { summarize: fakeSummarize });
assert(!!resCorrupt && !!resCorrupt.compaction, "corrupt target state does not break compaction");
assert(!trailingText().includes("<targets>"), "corrupt target state → no <targets> block");

console.log("\nrunCompaction — degenerate retry / fallback (progressive capping):");
const degenerateTemplate =
	"## Live Thread\n(none)\n## Key Decisions\n(none)\n## Progress\n### Done\n(none)\n## Next Steps\n(none)\n";
const goodLongSummary =
	"## Live Thread\nFinished the compact extension with target integration, handoff-style prompt, and fallback handling. " +
	"Detail. ".repeat(60);

const bigEvent = makeEvent();
(bigEvent as { preparation: { tokensBefore: number } }).preparation.tokensBefore = 50000;

// 1st call degenerate, 2nd good → retries with capped history, returns the good summary.
let calls = 0;
const flakeSummarize = async () => {
	calls++;
	return { summary: calls === 1 ? degenerateTemplate : goodLongSummary };
};
const retryResult = await runCompaction(bigEvent, makeCtx(), { summarize: flakeSummarize });
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
const fbResult = await runCompaction(bigEvent, makeCtx(), { summarize: alwaysDegenerate });
assert(fbResult === undefined, "always-degenerate → falls back to pi default (void)");
assert(calls === 4, "tried 4 times (CAP_FACTORS) before falling back");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
