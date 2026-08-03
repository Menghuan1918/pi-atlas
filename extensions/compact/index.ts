/**
 * compact extension — higher-quality session compaction.
 *
 * Replaces pi's default summarization for the `session_before_compact` event.
 * Produces a structured handoff summary using the session's active model, reusing
 * pi's own `serializeConversation` + cut logic (the `CompactionPreparation` from
 * the event). Integrates the pi-atlas target system: reads the session's target
 * state and biases the summary to preserve the goal + target checklist across
 * compaction, so auto-continue stays effective.
 *
 * Design (Tier 1 / KISS, per `.workspace-docs/plans/08-03-compact-压缩插件.md`):
 *  - One handler: `session_before_compact` → returns `{ compaction: CompactionResult }`.
 *  - Summarization uses **raw HTTP streaming** to the model's `/chat/completions`
 *    endpoint (for openai-completions providers like macaron), bypassing pi-ai's
 *    OpenAI SDK wrapper — which intermittently drops very large user-message
 *    bodies (-> empty -> NA). Verified reliable on a 1.2M-char input. Non-openai
 *    models fall back to pi-ai `stream(...).result()`.
 *  - No output-token cap (effectiveness first).
 *  - Secret redaction before the model sees the text.
 *  - Degenerate-summary guard + progressive capping: retry with halved context on
 *    a degenerate result; if still degenerate, fall back to pi's default compaction
 *    rather than persisting a useless summary (data loss).
 *  - No commands, no config, no extra storage.
 *
 * `runCompaction` is exported and dependency-injected (`deps`) so the orchestration
 * can be unit-tested with a fake `summarize` and a fake serializer, without a real
 * model call or valid `AgentMessage`s.
 */

import { uuidv7 } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

import { loadTargetState } from "../target/persistence.js";
import {
	buildSystemPrompt,
	buildUserMessage,
	fileListsFromOps,
	formatTargets,
	isDegenerateSummary,
	redactSecrets,
} from "./summarize.js";

/** Injectable dependencies for `runCompaction` (testability seam). */
export interface CompactDeps {
	/** The summarization call (real: pi-ai `stream` + direct text_end collection; tests: a fake). */
	summarize: (model: unknown, context: unknown, options: unknown) => Promise<{ summary: string }>;
	/** Builds the (already-redacted) conversation text from pi's AgentMessage[]. */
	serializeText: (messages: SessionBeforeCompactEvent["preparation"]["messagesToSummarize"]) => string;
}

/**
 * Run the custom compaction for one `session_before_compact` event.
 * Returns `{ compaction }` on success, or `undefined` to let pi run its default.
 */
export async function runCompaction(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	deps: CompactDeps,
) {
	const { preparation, reason, signal, customInstructions } = event;
	const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary, fileOps } =
		preparation;

	const model = ctx.model;
	if (!model) {
		// No active model — let pi run default compaction.
		return;
	}

	// Resolve request auth for the session's active model.
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		if (!signal.aborted) {
			ctx.ui.notify(
				`compact: could not resolve API key for ${model.id}; using default compaction`,
				"warning",
			);
		}
		return;
	}

	// Conversation text: reuse pi's serializer (merge split-turn prefix), then redact.
	const allMessages = [...messagesToSummarize, ...(turnPrefixMessages ?? [])];
	const fullConversationText = deps.serializeText(allMessages);

	// Target system integration: read this session's goal/checklist (best-effort, never throws).
	const targetState = await loadTargetState(ctx.sessionManager.getSessionId()).catch(() => null);
	const targetsBlock = formatTargets(targetState);

	const { readFiles, modifiedFiles } = fileListsFromOps(fileOps);

	// macaron flakes (fast-returns an empty template) on very large (~285k-token)
	// inputs. Progressive capping: try the full context first (preserve content),
	// then halve it on each degenerate result until the model actually summarizes.
	const CAP_FACTORS = [1, 0.5, 0.25, 0.125];

	const summarizeOnce = async (capFactor: number): Promise<string> => {
		const conversationText =
			capFactor >= 1
				? fullConversationText
				: `[Note: older conversation omitted to fit the summarization context window (~${Math.round(capFactor * 100)}% retained, most recent).]\n\n${fullConversationText.slice(-Math.ceil(fullConversationText.length * capFactor))}`;
		const userText = buildUserMessage({
			conversationText,
			previousSummary,
			targetsBlock,
			readFiles,
			modifiedFiles,
			customInstructions,
			reason,
		});
		// Summarization call (raw HTTP streaming for openai-completions, else pi-ai
		// stream). No maxTokens cap (effectiveness first); fresh call (not cached).
		const { summary } = await deps.summarize(
			model,
			{
				systemPrompt: buildSystemPrompt(),
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: userText }],
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				signal,
				cacheRetention: "none",
				sessionId: uuidv7(),
			},
		);
		return summary;
	};

	try {
		let summary = await summarizeOnce(CAP_FACTORS[0]);
		let attempts = 1;
		while (isDegenerateSummary(summary, tokensBefore) && attempts < CAP_FACTORS.length && !signal.aborted) {
			ctx.ui.notify(
				`compact: degenerate summary, retrying with smaller context (~${Math.round(CAP_FACTORS[attempts] * 100)}%)…`,
				"warning",
			);
			summary = await summarizeOnce(CAP_FACTORS[attempts]);
			attempts++;
		}

		if (!summary || isDegenerateSummary(summary, tokensBefore)) {
			if (!signal.aborted)
				ctx.ui.notify("compact: summary still degenerate/empty; using default compaction", "warning");
			return;
		}

		return {
			compaction: {
				summary,
				firstKeptEntryId,
				tokensBefore,
				details: { readFiles, modifiedFiles },
			},
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!signal.aborted)
			ctx.ui.notify(`compact: summarization failed (${message}); using default compaction`, "warning");
		return;
	}
}

/** Real dependencies wired into the factory. */
const realDeps: CompactDeps = {
	summarize: async (model, context, options) => {
		const m = model as { api?: string; baseUrl?: string; id?: string; maxTokens?: number };
		const opts = (options ?? {}) as { apiKey?: string; headers?: Record<string, string>; signal?: AbortSignal };
		const ctx = (context ?? {}) as {
			systemPrompt?: string;
			messages?: Array<{ content?: Array<{ text?: string }> | string }>;
		};
		const sysText = ctx.systemPrompt ?? "";
		const userContent = ctx.messages?.[0]?.content;
		const userText = Array.isArray(userContent)
			? userContent.map((c) => c.text ?? "").join("")
			: typeof userContent === "string"
				? userContent
				: "";

		// For openai-completions providers (e.g. macaron), call /chat/completions
		// directly via raw HTTP streaming. pi-ai's OpenAI SDK wrapper intermittently
		// drops very large user-message bodies (-> empty -> NA); raw fetch + SSE
		// reliably delivers them (verified on a 1.2M-char input).
		if (m.api === "openai-completions" && m.baseUrl && opts.apiKey) {
			const url = `${m.baseUrl.replace(/\/$/, "")}/chat/completions`;
			const res = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${opts.apiKey}`,
					...(opts.headers ?? {}),
				},
				body: JSON.stringify({
					model: m.id,
					messages: [
						{ role: "system", content: sysText },
						{ role: "user", content: userText },
					],
					stream: true,
					// Effectiveness first: no low output cap (use the model's own max).
					max_tokens: m.maxTokens ?? 16384,
				}),
				signal: opts.signal,
			});
			if (!res.ok || !res.body) {
				throw new Error(`summarization HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
			}
			const chunks: string[] = [];
			const decoder = new TextDecoder();
			let buf = "";
			for await (const chunk of res.body) {
				buf += decoder.decode(chunk, { stream: true });
				const lines = buf.split("\n");
				buf = lines.pop() ?? "";
				for (const ln of lines) {
					const t = ln.trim();
					if (!t.startsWith("data:")) continue;
					const data = t.slice(5).trim();
					if (data === "[DONE]") continue;
					try {
						const j = JSON.parse(data);
						const c = j?.choices?.[0]?.delta?.content;
						if (typeof c === "string") chunks.push(c);
					} catch {
						/* ignore non-JSON keepalive lines */
					}
				}
			}
			return { summary: chunks.join("").trim() };
		}

		// Fallback for other model APIs: pi-ai streaming (assembles from `done`).
		const response = await stream(model as never, context as never, options as never).result();
		const summary = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();
		return { summary };
	},
	serializeText: (messages) => redactSecrets(serializeConversation(convertToLlm(messages))),
};

export default function compactExtension(pi: ExtensionAPI): void {
	pi.on("session_before_compact", (event, ctx) => runCompaction(event, ctx, realDeps));
}
