/**
 * compact extension — higher-quality session compaction (handoff-style).
 *
 * Replaces pi's default summarization for the `session_before_compact` event.
 * Produces a **handoff document** (modeled on the `productivity/handoff` skill:
 * resumable core, references-not-copies, live thread, suggested skills) so the
 * agent can resume with the momentum, not the noise. Integrates the pi-atlas
 * target system: injects the goal + target checklist so auto-continue stays
 * aligned after compaction.
 *
 * How it summarizes (codex-style, NOT a giant serialized text block):
 *  - Sends the **real conversation history** (`convertToLlm(messagesToSummarize +
 *    turnPrefixMessages)`) as structured messages, then a trailing user turn that
 *    says "produce the handoff document now". This avoids the single huge
 *    text-content block that triggers pi-ai SDK body-drops (-> empty -> NA),
 *    verified reliable on a ~270k-token input.
 *  - The summarization call passes NO tools, so the model cannot call tools or
 *    continue the conversation — it only emits the document. Extraction takes
 *    only `text` content blocks.
 *
 * Design (Tier 1 / KISS, per `.workspace-docs/plans/08-03-compact-压缩插件.md`):
 *  - One handler: `session_before_compact` → returns `{ compaction: CompactionResult }`.
 *  - Reuses pi-ai `stream(...).result()` (works for all model APIs).
 *  - No output-token cap (effectiveness first). No secret redaction (by design).
 *  - Degenerate-summary guard + progressive (message-boundary) capping: on a
 *    degenerate result, retry with the most-recent half of the messages; if still
 *    degenerate, fall back to pi's default compaction rather than persisting a
 *    useless summary (data loss).
 *  - No commands, no config, no extra storage.
 *
 * `runCompaction` is exported and dependency-injected (`deps`) so the orchestration
 * can be unit-tested with a fake `summarize`, without a real model call.
 */

import { uuidv7 } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";

import { loadTargetState } from "../target/persistence.js";
import {
	buildAuxiliaryText,
	buildSystemPrompt,
	fileListsFromOps,
	formatTargets,
	isDegenerateSummary,
} from "./summarize.js";

/** Injectable dependencies for `runCompaction` (testability seam). */
export interface CompactDeps {
	/** The summarization call (real: pi-ai `stream(...).result()`; tests: a fake). */
	summarize: (model: unknown, context: unknown, options: unknown) => Promise<{ summary: string }>;
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

	// Real conversation history (merge split-turn prefix).
	const allMessages = [...messagesToSummarize, ...(turnPrefixMessages ?? [])];

	// Target system integration: read this session's goal/checklist (best-effort, never throws).
	const targetState = await loadTargetState(ctx.sessionManager.getSessionId()).catch(() => null);
	const targetsBlock = formatTargets(targetState);

	const { readFiles, modifiedFiles } = fileListsFromOps(fileOps);

	// Progressive (message-boundary) capping: try the full history first (preserve
	// content), then halve to the most-recent messages on each degenerate result,
	// until the model actually summarizes.
	const CAP_FACTORS = [1, 0.5, 0.25, 0.125];

	const summarizeOnce = async (capFactor: number): Promise<string> => {
		const capped =
			capFactor >= 1 ? allMessages : allMessages.slice(-Math.ceil(allMessages.length * capFactor));
		const omittedNote =
			capFactor < 1
				? `<note>~${allMessages.length - capped.length} older messages omitted to fit the summarization context window (most recent retained).</note>\n\n`
				: "";
		const auxiliaryText = buildAuxiliaryText({
			previousSummary,
			targetsBlock,
			readFiles,
			modifiedFiles,
			customInstructions,
			reason,
		});
		const trailing = `${
			auxiliaryText ? auxiliaryText + "\n\n" : ""
		}${omittedNote}Produce the handoff document now, following your instructions. Do NOT continue the conversation or call tools — output only the document.`;
		const messages = [
			...convertToLlm(capped),
			{
				role: "user",
				content: [{ type: "text", text: trailing }],
				timestamp: Date.now(),
			},
		];
		// No maxTokens cap (effectiveness first); NO tools (anti-continuation).
		// cacheRetention "none" + fresh sessionId (throwaway call, not cached).
		const { summary } = await deps.summarize(
			model,
			{ systemPrompt: buildSystemPrompt(), messages },
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
				`compact: degenerate summary, retrying with most-recent ~${Math.round(CAP_FACTORS[attempts] * 100)}% of history…`,
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
	// pi-ai streaming, assembled from the terminal `done` event. The real-history
	// message array (many small messages) avoids the giant single text-content
	// block that triggered SDK body-drops; verified reliable on ~270k-token inputs.
	summarize: async (model, context, options) => {
		const response = await stream(model as never, context as never, options as never).result();
		// Take only text content blocks (ignore any tool-call blocks — the call
		// passes no tools, so there shouldn't be any, but be safe).
		const summary = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();
		return { summary };
	},
};

export default function compactExtension(pi: ExtensionAPI): void {
	pi.on("session_before_compact", (event, ctx) => runCompaction(event, ctx, realDeps));
}
