/**
 * websearch extension — search backend.
 *
 * Performs a server-side web search via macaron's Anthropic-compatible
 * /v1/messages endpoint. When a tool named `web_search` (lowercase) is sent,
 * macaron executes the search in the cloud, returns the results to the model,
 * and the model answers from them. We collect that final answer text.
 *
 * macaron credentials are resolved at call time from the host's model registry
 * (the `macaron` provider must be configured) — no hardcoded keys.
 */

import { Type } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// Resolve via the compat entrypoint: pi's jiti extension loader aliases
// `@earendil-works/pi-ai` (root) and `/compat` to compat.js, but NOT the
// `/api/*` subpaths — so the stream must come from compat, not a deep import.
const { stream } = anthropicMessagesApi();

const MACARON_PROVIDER = "macaron";
const MACARON_MODEL_ID = "macaron-v1-coding-venti";

/** macaron's openai baseUrl ends with `/v1`; the Anthropic SDK appends `/v1/messages`, so strip the suffix. */
function toAnthropicBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/v1\/?$/, "");
}

export interface WebSearchParams {
	query: string;
	allowed_domains?: string[];
	blocked_domains?: string[];
}

export interface MacaronConfig {
	apiKey: string;
	baseUrl: string; // anthropic baseURL (no /v1)
}

/**
 * Resolve macaron credentials + anthropic baseURL from the model registry.
 * Returns null when the `macaron` provider is not configured (no apiKey/baseUrl).
 */
export async function resolveMacaronConfig(ctx: ExtensionContext): Promise<MacaronConfig | null> {
	const apiKey = await ctx.modelRegistry.getApiKeyForProvider(MACARON_PROVIDER);
	const provider = ctx.modelRegistry.getProvider(MACARON_PROVIDER);
	const baseUrl = provider?.baseUrl;
	if (!apiKey || !baseUrl) return null;
	return { apiKey, baseUrl: toAnthropicBaseUrl(baseUrl) };
}

/** web_search tool passed to macaron (lowercase name triggers server-side execution). */
const webSearchTool = {
	name: "web_search",
	description: "Search the web for current information.",
	parameters: Type.Object({
		query: Type.String({ minLength: 2 }),
		allowed_domains: Type.Optional(Type.Array(Type.String())),
		blocked_domains: Type.Optional(Type.Array(Type.String())),
	}),
};

function buildSystemPrompt(params: WebSearchParams): string {
	const lines = [
		"You are a web research assistant. Use the web_search tool to find current information for the user's query, then answer concisely with key facts and source URLs.",
	];
	if (params.allowed_domains?.length) {
		lines.push(`Restrict results to these domains: ${params.allowed_domains.join(", ")}.`);
	}
	if (params.blocked_domains?.length) {
		lines.push(`Exclude these domains: ${params.blocked_domains.join(", ")}.`);
	}
	return lines.join("\n");
}

/**
 * Run a server-side web search via macaron and return the model's answer text.
 * Throws on misconfiguration or transport failure; the caller maps errors to
 * an `isError` tool result.
 */
export async function searchWithMacaron(
	params: WebSearchParams,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<string> {
	const config = await resolveMacaronConfig(ctx);
	if (!config) {
		throw new Error("macaron provider is not configured (no apiKey/baseUrl found in model registry).");
	}

	const model = {
		id: MACARON_MODEL_ID,
		name: "Macaron V1 Coding Venti",
		api: "anthropic-messages" as const,
		provider: MACARON_PROVIDER,
		baseUrl: config.baseUrl,
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		contextWindow: 600000,
		maxTokens: 131072,
		thinkingLevelMap: { max: "max" },
	};

	const context = {
		systemPrompt: buildSystemPrompt(params),
		messages: [
			{ role: "user" as const, content: [{ type: "text" as const, text: params.query }], timestamp: Date.now() },
		],
		tools: [webSearchTool],
	};

	const out = stream(model, context, { apiKey: config.apiKey, ...(signal ? { signal } : {}) });
	const chunks: string[] = [];
	for await (const ev of out) {
		if (ev.type === "text_end") chunks.push(ev.content);
		if (ev.type === "error") {
			throw new Error(ev.error.errorMessage ?? "macaron stream error");
		}
	}
	return chunks.join("\n").trim() || "(no answer returned)";
}
