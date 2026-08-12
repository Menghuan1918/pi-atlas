/**
 * Command classification for the bash-timeout extension.
 *
 * `isSearchCommand` determines whether a shell command invokes a filesystem
 * or text search tool (find, grep, rg, …) anywhere in its pipeline.  These
 * commands can be slow on large trees, so they get a shorter default timeout.
 *
 * Strategy: regex pre-filter → shell-quote parse → walk command segments.
 */

import { parse } from "shell-quote";

/** Commands that scan the filesystem or large text and may be slow. */
const SEARCH_COMMANDS = new Set([
	"find",
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"ag",
	"ack",
	"fd",
	"locate",
]);

/** Quick regex pre-filter — skips shell-quote entirely when no tool name is present. */
const SEARCH_REGEX = new RegExp(`\\b(?:${[...SEARCH_COMMANDS].join("|")})\\b`);

/**
 * Detect whether a bash command invokes a search command (find, grep, rg, …)
 * anywhere in its pipeline.
 *
 * Uses shell-quote for accurate tokenisation (handles pipes, `&&`, `||`, `;`,
 * env-assignment prefixes, and absolute paths). Falls back to a regex word
 * match if parsing fails.
 */
export function isSearchCommand(command: string): boolean {
	if (!SEARCH_REGEX.test(command)) return false;

	try {
		let expectCommand = true;
		for (const token of parse(command)) {
			if (typeof token !== "string") {
				// Control operator (|, &&, ||, ;, …) — next string token is a command.
				expectCommand = true;
				continue;
			}
			if (!expectCommand) continue;

			// Env assignment (FOO=bar) or flag (--) — the real command follows.
			if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || token.startsWith("-")) continue;

			expectCommand = false;
			// Strip path: /usr/bin/find → find
			const name = token.slice(token.lastIndexOf("/") + 1);
			if (SEARCH_COMMANDS.has(name)) return true;
		}
		return false;
	} catch {
		return SEARCH_REGEX.test(command);
	}
}
