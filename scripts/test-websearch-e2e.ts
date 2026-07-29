/**
 * End-to-end probe: does pi-ai's anthropic-messages adapter correctly consume
 * a macaron response that contains server-side `web_search` tool execution?
 *
 * macaron (mintcn.macaron.xin) exposes an Anthropic-compatible /v1/messages
 * endpoint. When a tool named `web_search` (lowercase) is sent as a custom
 * tool (no `type`), macaron executes the search server-side and returns
 * `server_tool_use` + `web_search_tool_result` blocks, followed by a `text`
 * block with the model's answer.
 *
 * pi-ai's stream parser only handles text/thinking/tool_use blocks — so the
 * server-tool blocks should be silently ignored and the final `text` answer
 * should arrive intact.
 */
import { Type } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/compat";

const { stream } = anthropicMessagesApi();

const apiKey = process.env.MACARON_API_KEY!;
const baseUrl = process.env.MACARON_BASE_URL ?? "https://mintcn.macaron.xin";

const model = {
	id: "macaron-v1-coding-venti",
	name: "Macaron V1 Coding Venti",
	api: "anthropic-messages" as const,
	provider: "macaron",
	baseUrl,
	reasoning: true,
	input: ["text", "image"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	contextWindow: 600000,
	maxTokens: 131072,
	thinkingLevelMap: { max: "max" },
};

const context = {
	systemPrompt: "You are a helpful assistant. Use web_search when the user asks about current information.",
	messages: [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: "What is the latest stable version of Node.js? Use web_search to verify." }],
			timestamp: Date.now(),
		},
	],
	tools: [
		{
			name: "web_search",
			description: "Search the web for current information.",
			parameters: Type.Object({
				query: Type.String({ minLength: 2 }),
				allowed_domains: Type.Optional(Type.Array(Type.String())),
				blocked_domains: Type.Optional(Type.Array(Type.String())),
			}),
		},
	],
};

const out = stream(model, context, { apiKey });

let finalText = "";
let stopReason = "";
let sawToolCall = false;
for await (const ev of out) {
	if (ev.type === "text_delta") process.stdout.write(ev.delta);
	if (ev.type === "text_end") finalText = ev.content;
	if (ev.type === "toolcall_end") sawToolCall = true;
	if (ev.type === "done") stopReason = ev.reason;
	if (ev.type === "error") stopReason = `ERROR: ${ev.error.errorMessage ?? "(no message)"}`;
}

console.log("\n\n==== RESULT ====");
console.log("stopReason:", stopReason);
console.log("sawToolCall (client):", sawToolCall);
console.log("finalText length:", finalText.length);
console.log("finalText:", finalText.slice(0, 400));
