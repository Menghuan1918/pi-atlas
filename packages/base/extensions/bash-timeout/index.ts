/**
 * bash-timeout extension — inject default timeouts for the `bash` tool.
 *
 * - `tool_call`: if no timeout is specified, inject a default.
 *     • 20 s for search commands (find, grep, rg, …) — they can hang on large trees.
 *     • 120 s for everything else.
 * - `tool_result`: when bash exits due to timeout, replace the error message
 *   with a hint to use CreateBash for long-running commands.
 *
 * Explicit timeouts from the caller are always respected — this extension
 * only fills in the default when `timeout` is omitted.
 */

import { isBashToolResult, isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { isSearchCommand } from "./detect";

const DEFAULT_TIMEOUT = 120;
const SEARCH_TIMEOUT = 20;

export default function bashTimeoutExtension(pi: ExtensionAPI): void {
	// ── Inject default timeout ──────────────────────────────────────────
	pi.on("tool_call", (event) => {
		if (!isToolCallEventType("bash", event)) return;
		if (event.input.timeout !== undefined) return;

		event.input.timeout = isSearchCommand(event.input.command)
			? SEARCH_TIMEOUT
			: DEFAULT_TIMEOUT;
	});

	// ── Customise timeout error output ──────────────────────────────────
	pi.on("tool_result", (event) => {
		if (!isBashToolResult(event) || !event.isError) return;

		const text =
			event.content
				?.map((c) => (c.type === "text" ? c.text : ""))
				.join("") ?? "";

		const m = text.match(/Command timed out after (\d+) seconds/);
		if (!m) return; // not a timeout — leave other errors alone

		const secs = m[1];
		const captured = text
			.replace(/(?:\n\n)?Command timed out after \d+ seconds$/, "")
			.trim();

		return {
			content: [
				{
					type: "text" as const,
					text: [
						captured || "(no output before timeout)",
						"",
						`Command timed out after ${secs}s. Use create_bash to run long-running commands in the background.`,
					].join("\n"),
				},
			],
			isError: true,
		};
	});
}
