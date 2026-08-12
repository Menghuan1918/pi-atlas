/**
 * compact extension — summarization helpers (pure functions).
 *
 * Builds the summarization prompt for pi's `session_before_compact` hook using a
 * **handoff-style** document (modeled on the `productivity/handoff` skill):
 * resumable core, references-not-copies, live thread, suggested skills. The
 * conversation is sent as **real history** (structured messages) + a trailing
 * "produce the handoff" instruction (codex-style), NOT serialized into one
 * giant text block.
 *
 * These functions are pure and side-effect free so they can be unit tested
 * without a model or a session.
 */

import type { FileOperations } from "@earendil-works/pi-coding-agent";

import type { TargetState } from "../target/types.js";

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
	previousSummary?: string;
	targetsBlock?: string;
	readFiles?: string[];
	modifiedFiles?: string[];
	customInstructions?: string;
	reason: "manual" | "threshold" | "overflow";
}

/**
 * The summarizer's system prompt: a handoff-style document contract.
 * Also pins down anti-continuation / anti-tool-call rules so the model, on seeing
 * real history (with tool calls/results), only emits the handoff document.
 */
export function buildSystemPrompt(): string {
	return [
		"You are producing a **handoff document** for another instance of yourself that will pick up this work. Another you was working on a task and produced the conversation above (real history is provided as messages, ending with this instruction). Your job: squeeze the conversation down to its **resumable core** — what's in flight, why, and what's next — so the next agent inherits the momentum, not the noise.",
		"",
		"This is COMPACTION. Drop noise — pleasantries, chit-chat, dead-end debugging, superseded attempts, status narration. Keep everything needed to resume and avoid re-doing finished work. Omitting needed detail is worse than being verbose.",
		"",
		"Output a single Markdown document with these sections. Keep every section, even if empty (write \"(none)\"):",
		"",
		"## Live Thread",
		"## Key Decisions & Constraints",
		"## Progress",
		"### Done",
		"### In Progress",
		"### Blocked",
		"## References",
		"## Active Files",
		"## Critical Context",
		"## Next Steps",
		"## Suggested Skills",
		"",
		"Rules:",
		"- **References, not copies**: do NOT duplicate content already captured in specs, plans, ADRs, issues, commits, or diffs. Reference them by path or URL instead. The document carries only the live thread.",
		"- Preserve EXACT wording of: user directives, constraints, decisions, goals; file paths; function/symbol names; shell commands; error messages; URLs; identifiers. Do not paraphrase these.",
		"- Be terse: bullets, not prose paragraphs.",
		"- Write in the conversation's own terms.",
		"- `References` = paths/URLs to specs/plans/ADRs/issues/commits/diffs/files that hold settled detail. `Active Files` = files read/modified (from the <active-files> block if provided).",
		"- `Suggested Skills` = skills the next agent should reach for, if any are evident from the conversation; else \"(none)\".",
		"- If a <previous-summary> is provided, UPDATE it: keep still-true details, drop stale ones, merge new facts. Do not rewrite from scratch.",
		"- If a <targets> block is provided, restate the primary goal and the target checklist with their statuses, updated for progress made in the conversation.",
		"- Do NOT continue the conversation. Do NOT call any tools. Do NOT answer questions in the conversation. ONLY output the handoff document.",
		"- Do NOT mention compaction or that you are summarizing.",
	].join("\n");
}

/**
 * Build the auxiliary context (non-conversation blocks) that rides along with the
 * trailing "produce the handoff" instruction. Empty blocks are omitted.
 */
export function buildAuxiliaryText(input: PromptInputs): string {
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
		sections.push(`<focus>\n${input.customInstructions}\n</focus>`);
	}
	if (input.reason === "overflow") {
		sections.push(
			`<note>This compaction was triggered by context overflow and the turn will be retried. Produce a complete, focused handoff so the retried turn fits.</note>`,
		);
	}
	return sections.join("\n\n");
}

/**
 * Detect a degenerate/empty summary that would cause data loss if persisted
 * (e.g. the model returned the empty template instead of summarizing). For a
 * substantial conversation, a real handoff is non-trivial; the all-"(none)"
 * template is ~230 chars with many "(none)" markers.
 */
export function isDegenerateSummary(summary: string, tokensBefore: number): boolean {
	const s = summary.trim();
	if (!s) return true;
	if (tokensBefore <= 20000) return false; // small conversations aren't checked
	const noneCount = (s.match(/\(none\)/g) ?? []).length;
	return s.length < 400 || noneCount >= 4;
}
