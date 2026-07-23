/**
 * Runtime tests for the ask_user tool (execute logic, formatting, errors, timeout).
 * Run: npx tsx verify/askuser.test.ts
 *
 * Tests cover both:
 *   - Sequential fallback (mode="rpc"): ctx.ui.select / confirm / input
 *   - TUI multi-question component (mode="tui"): ctx.ui.custom
 */

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import askUserExtension from "../extensions/askuser/index";
import { getAskUserConfigPath } from "../extensions/askuser/config";

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string): void {
	if (cond) {
		pass++;
		console.log("  ✓ " + msg);
	} else {
		fail++;
		console.error("  ✗ " + msg);
	}
}

// ---------------------------------------------------------------------------
// Sequential mock: ctx.ui.select / confirm / input (mode="rpc")
// ---------------------------------------------------------------------------

interface SeqRecorded {
	select: Array<{ t: string; o: string[]; o2: unknown }>;
	confirm: Array<{ t: string; m: string; o2: unknown }>;
	input: Array<{ t: string; p: string | undefined; o2: unknown }>;
}

function makeSeqCtx(opts: {
	hasUI?: boolean;
	mode?: string;
	select?: unknown[];
	confirm?: boolean[];
	input?: unknown[];
}): { ctx: Record<string, unknown>; rec: SeqRecorded } {
	const rec: SeqRecorded = { select: [], confirm: [], input: [] };
	const sel = [...(opts.select ?? [])];
	const con = [...(opts.confirm ?? [])];
	const inp = [...(opts.input ?? [])];
	const ctx = {
		hasUI: opts.hasUI ?? true,
		mode: opts.mode ?? "rpc",
		cwd: "/tmp",
		sessionManager: { getSessionId: () => "test-session", getSessionDir: () => "/tmp" },
		ui: {
			select: async (t: string, o: string[], o2: unknown) => {
				rec.select.push({ t, o, o2 });
				return sel.shift();
			},
			confirm: async (t: string, m: string, o2: unknown) => {
				rec.confirm.push({ t, m, o2 });
				return con.shift() ?? false;
			},
			input: async (t: string, p: string | undefined, o2: unknown) => {
				rec.input.push({ t, p, o2 });
				return inp.shift();
			},
		},
	};
	return { ctx, rec };
}

// ---------------------------------------------------------------------------
// TUI mock: ctx.ui.custom (mode="tui")
// ---------------------------------------------------------------------------

/**
 * Create a TUI mock where `custom` simulates a user answering questions.
 * The `answers` array provides one answer per question (in order).
 * Cancel/timedOut is simulated by passing `null` or a special marker.
 */
function makeTuiCtx(perCallAnswers: (string | null)[][]): { ctx: Record<string, unknown> } {
	let callIdx = 0;
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: "/tmp",
		sessionManager: { getSessionId: () => "test-session", getSessionDir: () => "/tmp" },
		ui: {
			custom: async <T>(_factory: unknown): Promise<T> => {
				const answers = perCallAnswers[callIdx++] ?? [];
				if (answers.length === 0 || answers[0] === null) {
					return { answers: [], cancelled: true, timedOut: false } as unknown as T;
				}
				return { answers, cancelled: false, timedOut: false } as unknown as T;
			},
		},
	};
	return { ctx };
}

let tool: { execute: (...args: unknown[]) => Promise<unknown> } | null = null;
let onStart: ((event: unknown, ctx: { sessionManager: { getSessionId: () => string; getSessionDir: () => string }; cwd: string }) => void) | null = null;
askUserExtension({
	registerTool: (t: typeof tool) => {
		tool = t;
	},
	on: (event: string, h: typeof onStart) => {
		if (event === "session_start") onStart = h;
	},
} as never);

async function run(params: unknown, ctx: unknown): Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }> {
	return (await tool!.execute("tc1", params, undefined, undefined, ctx)) as never;
}

// ---------------------------------------------------------------------------
// Setup: isolated atlas dir for per-session config.
// ---------------------------------------------------------------------------

const atlasDir = mkdtempSync(join(tmpdir(), "askuser-test-atlas-"));
process.env.PI_ATLAS_DIR = atlasDir;
const sessionId = "test-session";
const configPath = getAskUserConfigPath(sessionId);

/** Write a timeout config for the test session. */
function setConfig(timeout: number): void {
	writeFileSync(configPath, JSON.stringify({ timeout }), "utf-8");
}

/** Trigger session_start (creates default config if not exists). */
function startSession(): void {
	onStart!({ type: "session_start" } as never, {
		cwd: "/tmp",
		sessionManager: { getSessionId: () => sessionId, getSessionDir: () => "/tmp" },
	} as never);
}

// ---------------------------------------------------------------------------
// Sequential fallback tests (mode="rpc")
// ---------------------------------------------------------------------------

console.log("--- Sequential fallback (mode=rpc) ---");

// 1. Non-interactive mode → error.
{
	const { ctx } = makeSeqCtx({ hasUI: false, mode: "print" });
	const r = await run(
		{ questions: [{ question: "Pick", type: "select", options: ["a", "b"] }, { question: "Sure?", type: "confirm" }] },
		ctx,
	);
	assert(r.isError === true, "non-interactive → isError true");
	assert(r.content[0].text.startsWith("Cannot ask user in non-interactive mode (mode: print). Questions were:"), "non-interactive message format");
	assert(r.content[0].text.includes("select: Pick"), "summary includes first question");
}

// 2. Happy-path batch (select + confirm + input) formatting.
{
	startSession();
	const { ctx, rec } = makeSeqCtx({ select: ["React"], confirm: [true], input: ["foo"] });
	const r = await run(
		{
			questions: [
				{ question: "Which framework do you prefer?", type: "select", options: ["React", "Vue"] },
				{ question: "Are you sure?", type: "confirm" },
				{ question: "Name?", type: "input", placeholder: "your name" },
			],
		},
		ctx,
	);
	const expected =
		"Q1: Which framework do you prefer?\nA1: React\n\nQ2: Are you sure?\nA2: Yes\n\nQ3: Name?\nA3: foo";
	assert(r.content[0].text === expected, "batch Q/A formatting (blank line between)");
	assert(r.isError !== true, "happy path not an error");
	assert(JSON.stringify(rec.select[0].o) === JSON.stringify(["React", "Vue", "Other (free input)"]), "select receives options array + Other");
	assert(rec.input[0].p === "your name", "input receives placeholder");
}

// 3. select without options → error.
{
	const { ctx } = makeSeqCtx({});
	const r = await run({ questions: [{ question: "Pick one", type: "select" }] }, ctx);
	assert(r.isError === true, "select without options → isError");
	assert(r.content[0].text === "Question 'Pick one' has type 'select' but no options provided", "select-no-options message");
}

// 4. type defaults to "input" when omitted.
{
	const { ctx } = makeSeqCtx({ input: ["bar"] });
	const r = await run({ questions: [{ question: "Anything?" }] }, ctx);
	assert(r.content[0].text === "Q1: Anything?\nA1: bar", "omitted type defaults to input");
}

// 5. timeout=0 (infinite) → no timeout option passed.
{
	startSession();
	const { ctx, rec } = makeSeqCtx({ input: ["x"] });
	await run({ questions: [{ question: "q?", type: "input" }] }, ctx);
	assert(rec.input[0].o2 === undefined, "timeout=0 → opts undefined (infinite wait)");
}

// 6. timeout=5s → { timeout: 5000 } milliseconds.
{
	setConfig(5);
	const { ctx, rec } = makeSeqCtx({ input: ["y"] });
	await run({ questions: [{ question: "q?", type: "input" }] }, ctx);
	assert(JSON.stringify(rec.input[0].o2) === JSON.stringify({ timeout: 5000 }), "timeout=5s → {timeout: 5000} ms");
}

// 7. select timeout (undefined) + default → default value used.
{
	setConfig(5);
	const { ctx } = makeSeqCtx({ select: [undefined] });
	const r = await run({ questions: [{ question: "Pick", type: "select", options: ["a", "b"], default: "a" }] }, ctx);
	assert(r.content[0].text === "Q1: Pick\nA1: a", "select timeout + default → default");
}

// 8. input timeout (undefined), no default → "(no answer / timed out)".
{
	setConfig(5);
	const { ctx } = makeSeqCtx({ input: [undefined] });
	const r = await run({ questions: [{ question: "Name?", type: "input" }] }, ctx);
	assert(r.content[0].text === "Q1: Name?\nA1: (no answer / timed out)", "input timeout no default → (no answer / timed out)");
}

// 9. cancel under infinite wait (timeout=0): undefined → "(cancelled)".
{
	setConfig(0);
	const { ctx } = makeSeqCtx({ select: [undefined] });
	const r = await run({ questions: [{ question: "Pick", type: "select", options: ["a", "b"] }] }, ctx);
	assert(r.content[0].text === "Q1: Pick\nA1: (cancelled)", "cancel (infinite) → (cancelled)");
}

// 10. confirm false → "No".
{
	setConfig(0);
	const { ctx } = makeSeqCtx({ confirm: [false] });
	const r = await run({ questions: [{ question: "Sure?", type: "confirm" }] }, ctx);
	assert(r.content[0].text === "Q1: Sure?\nA1: No", "confirm false → No");
}

// 11. Continue after a cancel: subsequent question still answered.
{
	setConfig(0);
	const { ctx } = makeSeqCtx({ select: [undefined, "Vue"] });
	const r = await run(
		{
			questions: [
				{ question: "First", type: "select", options: ["a", "b"] },
				{ question: "Second", type: "select", options: ["Vue", "Ang"] },
			],
		},
		ctx,
	);
	assert(r.content[0].text === "Q1: First\nA1: (cancelled)\n\nQ2: Second\nA2: Vue", "continue after cancel");
}

// 12. confirm true → "Yes".
{
	setConfig(0);
	const { ctx } = makeSeqCtx({ confirm: [true] });
	const r = await run({ questions: [{ question: "Proceed?", type: "confirm" }] }, ctx);
	assert(r.content[0].text === "Q1: Proceed?\nA1: Yes", "confirm true → Yes");
}

// 13. Re-read config: changing config file between calls takes effect.
{
	setConfig(0);
	const { ctx: ctx1, rec: rec1 } = makeSeqCtx({ input: ["a"] });
	await run({ questions: [{ question: "first?", type: "input" }] }, ctx1);
	assert(rec1.input[0].o2 === undefined, "first call: timeout=0 → no timeout");

	setConfig(10);
	const { ctx: ctx2, rec: rec2 } = makeSeqCtx({ input: ["b"] });
	await run({ questions: [{ question: "second?", type: "input" }] }, ctx2);
	assert(JSON.stringify(rec2.input[0].o2) === JSON.stringify({ timeout: 10000 }), "second call: timeout=10 → 10000ms (re-read)");
}

// ---------------------------------------------------------------------------
// TUI multi-question tests (mode="tui")
// ---------------------------------------------------------------------------

console.log("\n--- TUI multi-question (mode=tui) ---");

// 14. TUI single select question.
{
	startSession();
	const { ctx } = makeTuiCtx([["React"]]);
	const r = await run(
		{ questions: [{ question: "Which framework?", type: "select", options: ["React", "Vue"] }] },
		ctx,
	);
	assert(r.content[0].text === "Q1: Which framework?\nA1: React", "TUI select → answer");
}

// 15. TUI batch (select + confirm + input).
{
	const { ctx } = makeTuiCtx([["Vue", "Yes", "hello"]]);
	const r = await run(
		{
			questions: [
				{ question: "Framework?", type: "select", options: ["React", "Vue"] },
				{ question: "Sure?", type: "confirm" },
				{ question: "Name?", type: "input" },
			],
		},
		ctx,
	);
	const expected = "Q1: Framework?\nA1: Vue\n\nQ2: Sure?\nA2: Yes\n\nQ3: Name?\nA3: hello";
	assert(r.content[0].text === expected, "TUI batch formatting");
}

// 16. TUI cancel → fallback answers.
{
	setConfig(0);
	const { ctx } = makeTuiCtx([[]]);
	const r = await run(
		{ questions: [{ question: "Pick", type: "select", options: ["a", "b"], default: "a" }] },
		ctx,
	);
	// Cancelled: fallback uses default
	assert(r.content[0].text === "Q1: Pick\nA1: a", "TUI cancel with default → default");
}

// 17. TUI cancel without default → "(cancelled)".
{
	setConfig(0);
	const { ctx } = makeTuiCtx([[]]);
	const r = await run(
		{ questions: [{ question: "Name?", type: "input" }] },
		ctx,
	);
	assert(r.content[0].text === "Q1: Name?\nA1: (cancelled)", "TUI cancel no default → (cancelled)");
}

// 18. TUI select without options → error (validated before custom).
{
	const { ctx } = makeTuiCtx([]);
	const r = await run({ questions: [{ question: "Pick", type: "select" }] }, ctx);
	assert(r.isError === true, "TUI select no options → isError");
	assert(r.content[0].text === "Question 'Pick' has type 'select' but no options provided", "TUI select no options message");
}

console.log(`\naskuser.test: ${pass} passed, ${fail} failed`);

// Cleanup
rmSync(atlasDir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
