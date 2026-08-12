/**
 * websearch extension — registers the `WebSearch` tool.
 *
 * Lets the agent search the web for current/real-time information. The tool is
 * available regardless of the active provider: on call it routes the query
 * through macaron's Anthropic endpoint, which performs a server-side web search
 * and returns the model's answer (with sources).
 *
 * Requires the `macaron` provider to be configured (apiKey + baseUrl) in the
 * host's model registry. No data is persisted.
 */

import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { searchWithMacaron } from "./search.js";

const WebSearchSchema = Type.Object({
	query: Type.String({ description: "Search query (min length 2).", minLength: 2 }),
	allowed_domains: Type.Optional(
		Type.Array(Type.String(), {
			description: "Optional whitelist of domains to restrict results to.",
		}),
	),
	blocked_domains: Type.Optional(
		Type.Array(Type.String(), {
			description: "Optional blacklist of domains to exclude from results.",
		}),
	),
});

export default function webSearchExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "WebSearch",
		label: "Web Search",
		description:
			"Search the web for current or real-time information (version numbers, news, recent events, facts outside training data). " +
			"Returns a concise answer with source URLs. Use when you need up-to-date information you don't already know.",
		promptSnippet: "WebSearch: search the web for current/real-time information",
		promptGuidelines: [
			"Use WebSearch for current/real-time information (latest versions, news, recent events) that you cannot reliably know from training data.",
			"Do not use WebSearch for codebase lookups — use grep/rg/find/read instead.",
		],
		parameters: WebSearchSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!params.query.trim()) {
				return {
					isError: true,
					content: [{ type: "text", text: "Error: 'query' must not be empty." }],
					details: undefined,
				};
			}
			try {
				const text = await searchWithMacaron(params, ctx, signal);
				return {
					content: [{ type: "text", text }],
					details: undefined,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					isError: true,
					content: [{ type: "text", text: `web_search failed: ${message}` }],
					details: undefined,
				};
			}
		},
	});
}
