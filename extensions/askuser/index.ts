/**
 * askuser extension — registers the `ask_user` tool.
 *
 * Lets the agent ask the user one or more questions and block for answers. A
 * single call may batch multiple questions, each of type:
 *   - "select"  → single choice from `options`
 *   - "confirm" → yes/no
 *   - "input"   → free text
 *
 * Per-question timeout behaviour is governed by a session-level config (see
 * `./config.ts`), cached on `session_start`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { StringEnum, Type, type Static } from "@earendil-works/pi-ai";
import { loadTimeoutConfig } from "./config";

/** Per-session cached timeout in seconds; `0` means wait indefinitely. */
const sessionTimeouts = new Map<string, number>();

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
type Question = AskUserParams["questions"][number];

/** Build the timeout option passed to `ctx.ui`. `0` → omitted (infinite wait); `>0` → milliseconds. */
function timeoutOption(seconds: number): { timeout: number } | undefined {
	return seconds > 0 ? { timeout: seconds * 1000 } : undefined;
}

/**
 * Map a `select`/`input` result to a display answer.
 *
 * - A concrete value → returned as-is.
 * - `undefined` (timeout or user cancel):
 *     • a configured `default` is used (default-on-timeout semantics);
 *     • else, with a timeout configured (`seconds > 0`), this is a timeout →
 *       "(no answer / timed out)";
 *     • else (infinite wait) the only way to get `undefined` is an explicit
 *       cancel (Esc) → "(cancelled)".
 */
function resolveAnswer(value: string | undefined, q: Question, timeoutSeconds: number): string {
	if (value !== undefined) return value;
	if (q.default !== undefined) return q.default;
	return timeoutSeconds > 0 ? "(no answer / timed out)" : "(cancelled)";
}

export default function askUserExtension(pi: ExtensionAPI): void {
	// Cache the session-level timeout config whenever a session starts.
	pi.on("session_start", (_event, ctx) => {
		const sid = ctx.sessionManager.getSessionId();
		sessionTimeouts.set(sid, loadTimeoutConfig(ctx.cwd, getAgentDir()));
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

			// 2. Resolve the cached timeout for this session.
			const sid = ctx.sessionManager.getSessionId();
			const timeoutSeconds = sessionTimeouts.get(sid) ?? 0;
			const opts = timeoutOption(timeoutSeconds);

			// 3. Ask each question in order and collect answers.
			const answers: string[] = [];
			for (let qi = 0; qi < questions.length; qi++) {
				const q = questions[qi];
				const type = q.type ?? "input";
				let answer: string;

				if (type === "select") {
					const options = q.options;
					if (!options || options.length === 0) {
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
					// Add "Other (free input)" so the user can type a custom answer.
					const optsWithOther = [...options, "Other (free input)"];
					const choice = await ctx.ui.select(q.question, optsWithOther, opts);
					if (choice === "Other (free input)" || choice === undefined) {
						// User chose Other → prompt for free text; or timed out/cancelled.
						const text = await ctx.ui.input(`${q.question} (custom answer)`, q.placeholder, opts);
						answer = resolveAnswer(text, q, timeoutSeconds);
					} else {
						answer = choice;
					}
				} else if (type === "confirm") {
					const confirmed = await ctx.ui.confirm(q.question, q.question, opts);
					answer = confirmed ? "Yes" : "No";
				} else {
					const text = await ctx.ui.input(q.question, q.placeholder, opts);
					answer = resolveAnswer(text, q, timeoutSeconds);
				}

				answers.push(answer);
			}

			// 4. Format: "Q1: <question>\nA1: <answer>" per question, blank line between.
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
		},
	});
}
