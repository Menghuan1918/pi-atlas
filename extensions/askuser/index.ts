/**
 * askuser extension — registers the `ask_user` tool.
 *
 * Lets the agent ask the user one or more questions and block for answers. A
 * single call may batch multiple questions, each of type:
 *   - "select"  → single choice from `options`
 *   - "confirm" → yes/no
 *   - "input"   → free text
 *
 * In interactive (TUI) mode, all questions are shown on a single screen with
 * ← → navigation between questions and inline editing for "Other" and "input"
 * types (see `./multi-question.ts`).
 *
 * Per-question timeout behaviour is governed by a per-session config file (see
 * `./config.ts`), re-read on every call. Other extensions can overwrite the
 * config file at any time; the new value takes effect on the next call.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum, Type, type Static } from "@earendil-works/pi-ai";
import { loadTimeoutConfig, ensureDefaultConfig } from "./config";
import { showMultiQuestion, type MultiQuestion } from "./multi-question";

const AskUserSchema = Type.Object({
	questions: Type.Array(
		Type.Object({
			question: Type.String({ description: "The question to ask" }),
			type: StringEnum(["select", "confirm", "input"], {
				description: "Question type. Default: 'input'",
				default: "input",
			}),
			options: Type.Optional(
				Type.Array(Type.String(), {
					description: "Options for 'select' type (required when type='select')",
				}),
			),
			default: Type.Optional(
				Type.String({
					description: "Default answer used on timeout (for input/select types)",
				}),
			),
			placeholder: Type.Optional(
				Type.String({ description: "Placeholder text for 'input' type" }),
			),
		}),
		{ description: "Array of questions to ask the user" },
	),
});

type AskUserParams = Static<typeof AskUserSchema>;

/** Build the timeout option passed to `ctx.ui`. `0` → omitted (infinite wait); `>0` → milliseconds. */
function timeoutOption(seconds: number): { timeout: number } | undefined {
	return seconds > 0 ? { timeout: seconds * 1000 } : undefined;
}

/**
 * Map a fallback answer (when the user cancels or times out on a question that
 * was not answered). Follows the same semantics as the old sequential UI:
 *   - a configured `default` is used;
 *   - else, with a timeout → "(no answer / timed out)";
 *   - else (infinite wait, explicit cancel) → "(cancelled)".
 */
function fallbackAnswer(q: { default?: string }, timedOut: boolean): string {
	if (q.default !== undefined) return q.default;
	return timedOut ? "(no answer / timed out)" : "(cancelled)";
}

export default function askUserExtension(pi: ExtensionAPI): void {
	// Create the per-session config directory + default config file.
	// Other extensions can overwrite the file to change the timeout;
	// the new value takes effect on the next ask_user call.
	pi.on("session_start", (_event, ctx) => {
		const sid = ctx.sessionManager.getSessionId();
		ensureDefaultConfig(sid);
	});

	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description:
			"Ask the user one or more questions and block for their answers. " +
			"Supports 'select' (single choice), 'confirm' (yes/no) and 'input' " +
			"(free text) question types. Use this when you need information or a " +
			"decision from the user that you cannot infer yourself.",
		promptSnippet:
			"ask_user: ask the user questions (select/confirm/input) and wait for answers",
		promptGuidelines: [
			"Prefer ask_user only when you genuinely need user input or a decision you cannot reasonably infer.",
			"Batch related questions into a single ask_user call rather than calling it repeatedly.",
		],
		parameters: AskUserSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const questions = params.questions;

			// 1. Non-interactive mode: cannot prompt the user.
			if (!ctx.hasUI) {
				const summary = questions.map((q) => `${q.type ?? "input"}: ${q.question}`).join("; ");
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: `Cannot ask user in non-interactive mode (mode: ${ctx.mode}). Questions were: ${summary}`,
						},
					],
					details: undefined,
				};
			}

			// 2. Re-read the timeout config for this session (no caching — other
			//    extensions may have updated it since session_start).
			const sid = ctx.sessionManager.getSessionId();
			const timeoutSeconds = loadTimeoutConfig(sid);

			// 3. Validate select questions have options.
			for (const q of questions) {
				const type = q.type ?? "input";
				if (type === "select" && (!q.options || q.options.length === 0)) {
					return {
						isError: true,
						content: [
							{
								type: "text",
								text: `Question '${q.question}' has type 'select' but no options provided`,
							},
						],
						details: undefined,
					};
				}
			}

			// 4. Interactive TUI mode: use the multi-question custom component.
			if (ctx.mode === "tui") {
				const mqQuestions: MultiQuestion[] = questions.map((q) => ({
					question: q.question,
					type: (q.type ?? "input") as "select" | "confirm" | "input",
					options: q.options,
					default: q.default,
					placeholder: q.placeholder,
				}));

				const result = await showMultiQuestion(ctx.ui, mqQuestions, timeoutSeconds);

				// Resolve answers: answered questions use their value; unanswered
				// questions get fallback (default / timeout / cancelled).
				const answers = questions.map((q, i) => {
					if (result.answers[i] !== undefined) return result.answers[i]!;
					return fallbackAnswer(q, result.timedOut);
				});

				return formatResult(questions, answers);
			}

			// 5. Non-TUI interactive mode (e.g. RPC): fall back to sequential
			//    ctx.ui.select / confirm / input dialogs.
			const opts = timeoutOption(timeoutSeconds);
			const answers: string[] = [];

			for (const q of questions) {
				const type = q.type ?? "input";
				let answer: string;

				if (type === "select") {
					const optsWithOther = [...(q.options ?? []), "Other (free input)"];
					const choice = await ctx.ui.select(q.question, optsWithOther, opts);
					if (choice === "Other (free input)" || choice === undefined) {
						const text = await ctx.ui.input(`${q.question} (custom answer)`, q.placeholder, opts);
						answer = text !== undefined
							? text
							: (q.default ?? (timeoutSeconds > 0 ? "(no answer / timed out)" : "(cancelled)"));
					} else {
						answer = choice;
					}
				} else if (type === "confirm") {
					const confirmed = await ctx.ui.confirm(q.question, q.question, opts);
					answer = confirmed ? "Yes" : "No";
				} else {
					const text = await ctx.ui.input(q.question, q.placeholder, opts);
					answer = text !== undefined
						? text
						: (q.default ?? (timeoutSeconds > 0 ? "(no answer / timed out)" : "(cancelled)"));
				}

				answers.push(answer);
			}

			return formatResult(questions, answers);
		},
	});
}

/** Format the Q/A output: "Q1: <question>\nA1: <answer>" per question, blank line between. */
function formatResult(
	questions: AskUserParams["questions"],
	answers: string[],
): { content: { type: "text"; text: string }[]; details: undefined } {
	const lines: string[] = [];
	questions.forEach((q, i) => {
		lines.push(`Q${i + 1}: ${q.question}`);
		lines.push(`A${i + 1}: ${answers[i]}`);
		if (i < questions.length - 1) lines.push("");
	});
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: undefined,
	};
}
