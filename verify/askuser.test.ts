/**
 * Runtime tests for the ask_user tool (execute logic, formatting, errors, timeout).
 * Run: npx tsx verify/askuser.test.ts
 */

import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import askUserExtension from "../extensions/askuser/index";

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

interface Recorded {
	select: Array<{ t: string; o: string[]; o2: unknown }>;
	confirm: Array<{ t: string; m: string; o2: unknown }>;
	input: Array<{ t: string; p: string | undefined; o2: unknown }>;
}

function makeCtx(opts: {
	hasUI?: boolean;
	mode?: string;
	cwd?: string;
	select?: unknown[];
	confirm?: boolean[];
	input?: unknown[];
}): { ctx: Record<string, unknown>; rec: Recorded } {
	const rec: Recorded = { select: [], confirm: [], input: [] };
	const sel = [...(opts.select ?? [])];
	const con = [...(opts.confirm ?? [])];
	const inp = [...(opts.input ?? [])];
	const ctx = {
		hasUI: opts.hasUI ?? true,
		mode: opts.mode ?? "tui",
		cwd: opts.cwd ?? "/tmp",
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

let tool: { execute: (...args: unknown[]) => Promise<unknown> } | null = null;
let onStart: ((event: unknown, ctx: { cwd: string }) => void) | null = null;
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

/** Create a temp cwd with a project-level askuser config. */
function cwdWithTimeout(seconds: number): string {
	const tmp = mkdtempSync(join(tmpdir(), "askuser-cfg-"));
	if (seconds >= 0) {
		mkdirSync(join(tmp, ".pi"), { recursive: true });
		writeFileSync(join(tmp, ".pi", "askuser-config.json"), JSON.stringify({ timeout: seconds }));
	}
	return tmp;
}

// 1. Non-interactive mode → error.
{
	const { ctx } = makeCtx({ hasUI: false, mode: "print" });
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
	const { ctx, rec } = makeCtx({ select: ["React"], confirm: [true], input: ["foo"] });
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
	const { ctx } = makeCtx({});
	const r = await run({ questions: [{ question: "Pick one", type: "select" }] }, ctx);
	assert(r.isError === true, "select without options → isError");
	assert(r.content[0].text === "Question 'Pick one' has type 'select' but no options provided", "select-no-options message");
}

// 4. type defaults to "input" when omitted.
{
	const { ctx } = makeCtx({ input: ["bar"] });
	const r = await run({ questions: [{ question: "Anything?" }] }, ctx);
	assert(r.content[0].text === "Q1: Anything?\nA1: bar", "omitted type defaults to input");
}

// 5. timeout=0 (infinite) → no timeout option passed.
{
	onStart!({ type: "session_start" } as never, { cwd: cwdWithTimeout(0), sessionManager: { getSessionId: () => "test-session", getSessionDir: () => "/tmp" } } as never);
	const { ctx, rec } = makeCtx({ input: ["x"] });
	await run({ questions: [{ question: "q?", type: "input" }] }, ctx);
	assert(rec.input[0].o2 === undefined, "timeout=0 → opts undefined (infinite wait)");
}

// 6. timeout=5s → { timeout: 5000 } milliseconds.
{
	onStart!({ type: "session_start" } as never, { cwd: cwdWithTimeout(5), sessionManager: { getSessionId: () => "test-session", getSessionDir: () => "/tmp" } } as never);
	const { ctx, rec } = makeCtx({ input: ["y"] });
	await run({ questions: [{ question: "q?", type: "input" }] }, ctx);
	assert(JSON.stringify(rec.input[0].o2) === JSON.stringify({ timeout: 5000 }), "timeout=5s → {timeout: 5000} ms");
}

// 7. select timeout (undefined) + default → default value used.
{
	onStart!({ type: "session_start" } as never, { cwd: cwdWithTimeout(5), sessionManager: { getSessionId: () => "test-session", getSessionDir: () => "/tmp" } } as never);
	const { ctx } = makeCtx({ select: [undefined] });
	const r = await run({ questions: [{ question: "Pick", type: "select", options: ["a", "b"], default: "a" }] }, ctx);
	assert(r.content[0].text === "Q1: Pick\nA1: a", "select timeout + default → default");
}

// 8. input timeout (undefined), no default → "(no answer / timed out)".
{
	onStart!({ type: "session_start" } as never, { cwd: cwdWithTimeout(5), sessionManager: { getSessionId: () => "test-session", getSessionDir: () => "/tmp" } } as never);
	const { ctx } = makeCtx({ input: [undefined] });
	const r = await run({ questions: [{ question: "Name?", type: "input" }] }, ctx);
	assert(r.content[0].text === "Q1: Name?\nA1: (no answer / timed out)", "input timeout no default → (no answer / timed out)");
}

// 9. cancel under infinite wait (timeout=0): undefined → "(cancelled)".
{
	onStart!({ type: "session_start" } as never, { cwd: cwdWithTimeout(0), sessionManager: { getSessionId: () => "test-session", getSessionDir: () => "/tmp" } } as never);
	const { ctx } = makeCtx({ select: [undefined] });
	const r = await run({ questions: [{ question: "Pick", type: "select", options: ["a", "b"] }] }, ctx);
	assert(r.content[0].text === "Q1: Pick\nA1: (cancelled)", "cancel (infinite) → (cancelled)");
}

// 10. confirm false → "No".
{
	onStart!({ type: "session_start" } as never, { cwd: cwdWithTimeout(0), sessionManager: { getSessionId: () => "test-session", getSessionDir: () => "/tmp" } } as never);
	const { ctx } = makeCtx({ confirm: [false] });
	const r = await run({ questions: [{ question: "Sure?", type: "confirm" }] }, ctx);
	assert(r.content[0].text === "Q1: Sure?\nA1: No", "confirm false → No");
}

// 11. Continue after a cancel: subsequent question still answered.
{
	onStart!({ type: "session_start" } as never, { cwd: cwdWithTimeout(0), sessionManager: { getSessionId: () => "test-session", getSessionDir: () => "/tmp" } } as never);
	const { ctx } = makeCtx({ select: [undefined, "Vue"] });
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
	onStart!({ type: "session_start" } as never, { cwd: cwdWithTimeout(0), sessionManager: { getSessionId: () => "test-session", getSessionDir: () => "/tmp" } } as never);
	const { ctx } = makeCtx({ confirm: [true] });
	const r = await run({ questions: [{ question: "Proceed?", type: "confirm" }] }, ctx);
	assert(r.content[0].text === "Q1: Proceed?\nA1: Yes", "confirm true → Yes");
}

console.log(`\naskuser.test: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
