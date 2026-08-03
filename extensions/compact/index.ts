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
 *  - No output-token cap (effectiveness first).
 *  - Secret redaction before the model sees the text.
 *  - On any failure → return `undefined` so pi falls back to its default compaction.
 *  - No commands, no config, no extra storage.
 *
 * `runCompaction` is exported and dependency-injected (`deps`) so the orchestration
 * can be unit-tested with a fake `complete` and a fake serializer, without a real
 * model call or valid `AgentMessage`s.
 */

import { uuidv7 } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

import { loadTargetState } from "../target/persistence.js";
import {
	buildSystemPrompt,
	buildUserMessage,
	fileListsFromOps,
	formatTargets,
	redactSecrets,
} from "./summarize.js";

/** Injectable dependencies for `runCompaction` (testability seam). */
export interface CompactDeps {
	/** The summarization model call (real: pi-ai `complete`; tests: a fake). */
	complete: typeof complete;
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

	try {
		// No maxTokens cap — effectiveness first. cacheRetention "none" + fresh sessionId
		// (the summary is a throwaway call, not part of the cached prefix).
		const response = await deps.complete(
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

		const summary = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();

		if (!summary) {
			if (!signal.aborted) ctx.ui.notify("compact: summary was empty; using default compaction", "warning");
			return;
		}

		return {
			compaction: {
				summary,
				firstKeptEntryId,
				tokensBefore,
				usage: response.usage,
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
	complete,
	serializeText: (messages) => redactSecrets(serializeConversation(convertToLlm(messages))),
};

export default function compactExtension(pi: ExtensionAPI): void {
	pi.on("session_before_compact", (event, ctx) => runCompaction(event, ctx, realDeps));
}
