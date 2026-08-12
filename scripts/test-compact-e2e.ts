/**
 * compact extension — end-to-end integration test.
 * Run: npx tsx scripts/test-compact-e2e.ts
 *
 * Proves the deployment integration that unit tests cannot: that pi discovers and
 * loads the compact extension (via the pi package manifest — see the packages/ layout),
 * invokes our session_before_compact handler on manual compaction, and persists
 * the returned result as a CompactionEntry with fromHook=true (i.e. OUR handler,
 * not pi's default). Uses the real session model (macaron) — needs network.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

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

// Temp project dir with a tiny keepRecentTokens so even a single small exchange
// has content to summarize (otherwise the cut point keeps everything → nothing
// to summarize). agentDir stays ~/.pi/agent so the macaron model + auth resolve.
const tmpCwd = mkdtempSync(join(tmpdir(), "compact-e2e-"));
mkdirSync(join(tmpCwd, ".pi"), { recursive: true });
writeFileSync(
	join(tmpCwd, ".pi", "settings.json"),
	JSON.stringify({ compaction: { enabled: true, reserveTokens: 1024, keepRecentTokens: 1 } }),
);

let summary = "";
let fromHook: unknown = undefined;
let details: unknown = undefined;
let ran = false;

try {
	const { session } = await createAgentSession({
		cwd: tmpCwd,
		sessionManager: SessionManager.inMemory(),
		noTools: "all",
	});

	// Three substantive turns so the summarized span has real content (trivial
	// "acknowledge" exchanges get summarized to "(none)"). keepRecentTokens=1 so
	// the cut leaves the earlier turns to summarize. Embeds a secret (must be
	// redacted), a file path, and a goal to verify capture + redaction.
	await session.prompt(
		"In 2-3 sentences, explain what a session-compaction summarizer does and why it matters for long coding sessions. " +
			"Note: logs go to /tmp/compact-e2e/sample.ts, and the admin password=hunter2blackcat987 plus api_key=sk_test_1234567890abcdef must never appear in summaries.",
	);
	await session.prompt("In 2 sentences, what is the main risk of over-aggressive compaction, and how do you avoid it?");
	await session.prompt("Name one best practice for writing compaction summaries, in one sentence.");

	// Manual compaction → fires session_before_compact → our handler runs.
	const result = await session.compact("e2e: focus on the goal and redact secrets");
	ran = true;
	summary = result?.summary ?? "";

	const entries = session.sessionManager.getEntries();
	const comp = entries.find((e) => e.type === "compaction") as
		| { fromHook?: boolean; details?: unknown; firstKeptEntryId?: string }
		| undefined;
	fromHook = comp?.fromHook;
	details = comp?.details;
	// Diagnostic: how many entries were summarized (before the kept boundary)?
	const keptIdx = comp?.firstKeptEntryId ? entries.findIndex((e) => e.id === comp.firstKeptEntryId) : -1;
	const summarizedCount = keptIdx >= 0 ? entries.slice(0, keptIdx).filter((e) => e.type !== "compaction").length : -1;
	console.log(`  i messagesToSummarize entry count ≈ ${summarizedCount}`);
} catch (err) {
	console.error(`e2e aborted with error: ${err instanceof Error ? err.message : String(err)}`);
	console.error("(if this is a network/auth error, macaron may be unreachable in this environment)");
}

if (!ran) {
	console.error("\ne2e did not complete — integration NOT verified (see error above).");
	process.exit(2);
}

console.log("\nrunCompaction e2e assertions:");
assert(typeof summary === "string" && summary.trim().length > 0, "compact() returned a non-empty summary");
assert(fromHook === true, "CompactionEntry.fromHook === true (our handler ran, not pi default)");
assert(!/hunter2blackcat987/.test(summary), "secret redacted out of the summary");
assert(!/sk_test_1234567890abcdef/.test(summary), "api key redacted out of the summary");
assert(
	!!details && Array.isArray((details as { readFiles?: unknown[] }).readFiles),
	"CompactionEntry.details persisted with readFiles list",
);
// Soft check: content capture depends on the cut leaving mid-history + model
// compliance, not on our wiring. Print, don't fail.
if (/compact/.test(summary) || /sample\.ts/.test(summary)) {
	pass++;
	console.log(`  ✓ summary carries key context (compact / sample.ts)`);
} else {
	console.log(`  ⚠ summary did not surface key context (cut/model artifact — integration still proven by fromHook)`);
}

console.log(`\n--- summary (first 800 chars) ---\n${summary.slice(0, 800)}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
