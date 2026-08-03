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
 *  - Summarization uses **streaming** (`stream` + direct `text_end` event collection),
 *    not `complete`/`.result()` — the most direct use of streaming transport, and
 *    more robust on very large inputs than assembling from the `done` event.
 *  - No output-token cap (effectiveness first).
 *  - Secret redaction before the model sees the text.
 *  - Degenerate-summary guard: retry once; if still degenerate, fall back to pi's
 *    default compaction rather than persisting a useless summary (data loss).
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
	const conversationText = deps.serializeText(allMessages);

	// Target system integration: read this session's goal/checklist (best-effort, never throws).
	const targetState = await loadTargetState(ctx.sessionManager.getSessionId()).catch(() => null);
	const targetsBlock = formatTargets(targetState);

	const { readFiles, modifiedFiles } = fileListsFromOps(fileOps);

	const userText = buildUserMessage({
		conversationText,
		previousSummary,
		targetsBlock,
		readFiles,
		modifiedFiles,
		customInstructions,
		reason,
	});

	const summarizeOnce = async (): Promise<string> => {
		// Streaming + direct text_end collection. No maxTokens cap (effectiveness
		// first). cacheRetention "none" + fresh sessionId (throwaway call, not cached).
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
		let summary = await summarizeOnce();

		// Guard against degenerate/empty summaries (e.g. the model returns the empty
		// template instead of summarizing a large conversation). Retrying once handles
		// transient flakes; if still degenerate, fall back to pi's default compaction
		// rather than persisting a useless summary and losing the context.
		if (isDegenerateSummary(summary, tokensBefore) && !signal.aborted) {
			ctx.ui.notify("compact: degenerate summary, retrying…", "warning");
			summary = await summarizeOnce();
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
	// Use streaming (`stream(...).result()`) — same transport as `complete`, but
	// explicit. `.result()` assembles the message from the terminal `done` event,
	// which is robust across providers (some, e.g. openai-completions, don't emit
	// `text_end`), so we don't hand-collect stream events.
	summarize: async (model, context, options) => {
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
