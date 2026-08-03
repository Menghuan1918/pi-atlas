/**
 * compact extension — summarization helpers (pure functions).
 *
 * Builds the summarization prompt for pi's `session_before_compact` hook:
 *  - reuses pi's `serializeConversation` output (passed in as `conversationText`),
 *  - conservatively redacts secrets before the model sees the text,
 *  - injects the pi-atlas target system's goal/checklist (so auto-continue stays
 *    aligned after compaction),
 *  - injects the file-operations list (read/modified) computed from `FileOperations`,
 *  - produces a strict structured-Markdown instruction set (opencode template +
 *    handoff "resumable core" + codex "another-you-resumes-this" framing).
 *
 * These functions are pure and side-effect free so they can be unit tested without
 * a model or a session.
 */

import type { FileOperations } from "@earendil-works/pi-coding-agent";

import type { TargetState } from "../target/types.js";

/**
 * High-confidence secret patterns. Conservative on purpose (risk: false positives
 * that strip legitimate content). Each match is replaced with a labelled placeholder
 * so the summarizer can tell something was redacted.
 */
const SECRET_PATTERNS: ReadonlyArray<{ kind: string; re: RegExp }> = [
	{ kind: "openai-key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
	{ kind: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
	{ kind: "google-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
	{ kind: "github-token", re: /\bgh[opsr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
	{ kind: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
	{ kind: "bearer", re: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/g },
	{
		kind: "assignment",
		re: /\b(?:password|passwd|api[_-]?key|apikey|secret|access[_-]?token)\s*[:=]\s*["']?[^\s"']{6,}["']?/gi,
	},
];

/** Conservatively redact secrets from text before it is sent to the summarization model. */
export function redactSecrets(text: string): string {
	let out = text;
	for (const { kind, re } of SECRET_PATTERNS) {
		out = out.replace(re, `[REDACTED:${kind}]`);
	}
	return out;
}

/**
 * Format the target system state into a compact block for the prompt.
 * Returns an empty string when there is no primary goal and no secondary targets,
 * so the caller can omit the `<targets>` block entirely.
 */
export function formatTargets(state: TargetState | null | undefined): string {
	if (!state) return "";
	if (!state.primary && state.secondary.length === 0) return "";

	const lines: string[] = [];
	if (state.primary) {
		lines.push(`Primary goal [${state.primary.status}]: ${state.primary.text}`);
		if (state.primary.note) lines.push(`  note: ${state.primary.note}`);
	}
	if (state.secondary.length > 0) {
		lines.push("Targets:");
		for (const t of state.secondary) {
			const note = t.note ? ` — ${t.note}` : "";
			lines.push(`  [#${t.id}] [${t.status}] ${t.text}${note}`);
		}
	}
	lines.push(`auto-continue: ${state.autoContinue ? "on" : "off"}`);
	return lines.join("\n");
}

/**
 * Compute `{ readFiles, modifiedFiles }` from pi's `FileOperations` Sets, matching
 * pi's own `CompactionDetails` semantics: readFiles = files only read (not modified),
 * modifiedFiles = written ∪ edited. Sorted + de-duplicated.
 */
export function fileListsFromOps(
	fileOps: FileOperations | null | undefined,
): { readFiles: string[]; modifiedFiles: string[] } {
	if (!fileOps) return { readFiles: [], modifiedFiles: [] };
	const read = fileOps.read ?? new Set<string>();
	const written = fileOps.written ?? new Set<string>();
	const edited = fileOps.edited ?? new Set<string>();
	const modified = new Set<string>([...written, ...edited]);
	const readFiles = [...read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles, modifiedFiles };
}

export interface PromptInputs {
	conversationText: string;
	previousSummary?: string;
	targetsBlock?: string;
	readFiles?: string[];
	modifiedFiles?: string[];
	customInstructions?: string;
	reason: "manual" | "threshold" | "overflow";
}

/**
 * The summarizer's system prompt: role framing + strict output structure + rules.
 * Effectiveness-first: asks for a complete handoff (omitting needed detail is worse
 * than being verbose). No length cap is imposed at the call site either.
 */
export function buildSystemPrompt(): string {
	return [
		"You are a context-checkpoint summarizer for a long-running coding agent. Another instance of you was working on a task and produced the conversation below. Your job is to produce a structured handoff summary that lets a fresh instance seamlessly continue the work.",
		"",
		"This is COMPACTION: squeeze the conversation down to its resumable core. Drop noise — pleasantries, chit-chat, dead-end debugging, superseded attempts, status narration. Keep everything needed to resume momentum and avoid re-doing finished work. Omitting needed detail is worse than being verbose.",
		"",
		"Output EXACTLY this Markdown structure. Keep every section even if empty (write \"(none)\"):",
		"",
		"## Goal & Targets",
		"## Constraints & Preferences",
		"## Progress",
		"### Done",
		"### In Progress",
		"### Blocked",
		"## Key Decisions",
		"## Active Files",
		"## Critical Context",
		"## Next Steps",
		"",
		"Rules:",
		"- Preserve EXACT wording of: user directives, constraints, decisions, goals; file paths; function/symbol names; shell commands; error messages; URLs; identifiers. Do not paraphrase these.",
		"- Terse bullets, not prose paragraphs.",
		"- Do NOT mention compaction or that you are summarizing.",
		"- Do NOT continue the conversation or answer any questions inside it.",
		"- Secrets already appear as [REDACTED:...]; never restore or guess them.",
		"- If a <previous-summary> is provided, UPDATE it: keep still-true details, drop stale ones, merge new facts. Do not rewrite from scratch.",
		"- If a <targets> block is provided, restate the primary goal and the target checklist with their statuses, updated for progress made in the conversation.",
		"- If an <active-files> block is provided, list those files under Active Files.",
	].join("\n");
}

/**
 * Build the user message body: tagged data blocks (only those present) followed by
 * the conversation transcript. The summarizer's system prompt (above) explains them.
 */
export function buildUserMessage(input: PromptInputs): string {
	const sections: string[] = [];
	if (input.previousSummary) {
		sections.push(`<previous-summary>\n${input.previousSummary}\n</previous-summary>`);
	}
	if (input.targetsBlock) {
		sections.push(`<targets>\n${input.targetsBlock}\n</targets>`);
	}
	if (input.readFiles?.length || input.modifiedFiles?.length) {
		const read = (input.readFiles ?? []).join(", ") || "(none)";
		const modified = (input.modifiedFiles ?? []).join(", ") || "(none)";
		sections.push(`<active-files>\nRead: ${read}\nModified: ${modified}\n</active-files>`);
	}
	if (input.customInstructions) {
		sections.push(`<custom-instructions>\n${input.customInstructions}\n</custom-instructions>`);
	}
	if (input.reason === "overflow") {
		sections.push(
			`<note>This compaction was triggered by context overflow and the turn will be retried. Produce a complete, focused summary so the retried turn fits.</note>`,
		);
	}
	sections.push(`<conversation>\n${input.conversationText}\n</conversation>`);
	return sections.join("\n\n");
}
