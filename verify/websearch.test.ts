/**
 * Tests for the websearch extension (config resolution + WebSearch execute).
 * Run: npx tsx verify/websearch.test.ts
 *
 * The live macaron call is guarded by MACARON_API_KEY / models.json presence;
 * without it the network test is skipped (not a failure).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import webSearchExtension from "../extensions/websearch/index";
import { resolveMacaronConfig } from "../extensions/websearch/search";

let pass = 0;
let fail = 0;
let skip = 0;
function assert(cond: boolean, msg: string): void {
	if (cond) {
		pass++;
		console.log("  ✓ " + msg);
	} else {
		fail++;
		console.error("  ✗ " + msg);
	}
}

// Capture the registered tool via a mock ExtensionAPI.
let tool: { execute: (...args: unknown[]) => Promise<unknown> } | null = null;
webSearchExtension({
	registerTool: (t: NonNullable<typeof tool>) => {
		tool = t;
	},
} as never);

async function run(params: unknown, ctx: unknown): Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }> {
	return (await tool!.execute("tc1", params, undefined, undefined, ctx)) as never;
}

/** Minimal ctx with a modelRegistry that serves macaron config (or none). */
function makeCtx(macaron?: { apiKey?: string; baseUrl?: string }): ExtensionContext {
	return {
		modelRegistry: {
			getApiKeyForProvider: async () => macaron?.apiKey,
			getProvider: () => (macaron?.baseUrl ? { baseUrl: macaron.baseUrl } : undefined),
		},
	} as unknown as ExtensionContext;
}

/** Load macaron provider config from the host's models.json, if present. */
function loadMacaronConfig(): { apiKey?: string; baseUrl?: string } | null {
	const envKey = process.env.MACARON_API_KEY;
	if (envKey) return { apiKey: envKey, baseUrl: "https://mintcn.macaron.xin/v1" };
	try {
		const cfg = JSON.parse(readFileSync(join(homedir(), ".pi/agent/models.json"), "utf8"));
		return cfg.providers?.macaron ?? null;
	} catch {
		return null;
	}
}

async function main(): Promise<void> {
	// ── resolveMacaronConfig ────────────────────────────────────────────
	console.log("resolveMacaronConfig:");
	{
		const cfg = await resolveMacaronConfig(makeCtx({ apiKey: "sk-test", baseUrl: "https://mintcn.macaron.xin/v1" }));
		assert(cfg !== null, "returns config when macaron configured");
		assert(cfg?.apiKey === "sk-test", "exposes apiKey");
		assert(cfg?.baseUrl === "https://mintcn.macaron.xin", "strips /v1 suffix for anthropic baseURL");
	}
	{
		const cfg = await resolveMacaronConfig(makeCtx({ baseUrl: "https://mintcn.macaron.xin/v1" }));
		assert(cfg === null, "returns null when apiKey missing");
	}
	{
		const cfg = await resolveMacaronConfig(makeCtx(undefined));
		assert(cfg === null, "returns null when macaron unconfigured");
	}

	// ── execute: validation ────────────────────────────────────────────
	console.log("execute (validation):");
	{
		const res = await run({ query: "  " }, makeCtx({ apiKey: "sk-test", baseUrl: "https://mintcn.macaron.xin/v1" }));
		assert(res.isError === true, "empty query → isError");
		assert(/must not be empty/.test(res.content[0]?.text ?? ""), "empty query message");
	}

	// ── execute: macaron not configured ────────────────────────────────
	console.log("execute (unconfigured):");
	{
		const res = await run({ query: "anything" }, makeCtx(undefined));
		assert(res.isError === true, "unconfigured → isError");
		assert(/not configured/.test(res.content[0]?.text ?? ""), "mentions not configured");
	}

	// ── execute: live macaron search ────────────────────────────────────
	console.log("execute (live macaron):");
	const macaron = loadMacaronConfig();
	if (!macaron?.apiKey) {
		skip++;
		console.log("  ⋯ skipped (no macaron apiKey in models.json or MACARON_API_KEY)");
	} else {
		try {
			const res = await run(
				{ query: "What is the latest stable version of Node.js?" },
				makeCtx({ apiKey: macaron.apiKey, baseUrl: macaron.baseUrl ?? "https://mintcn.macaron.xin/v1" }),
			);
			assert(res.isError !== true, "live search does not error");
			const text = res.content[0]?.text ?? "";
			assert(text.length > 30, "returns a non-trivial answer");
			console.log("    answer preview: " + text.slice(0, 120).replace(/\n/g, " ") + "…");
		} catch (err) {
			fail++;
			console.error("  ✗ live search threw: " + (err instanceof Error ? err.message : String(err)));
		}
	}

	console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
	if (fail > 0) process.exit(1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
