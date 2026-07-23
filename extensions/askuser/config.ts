/**
 * askuser extension — session-level timeout configuration.
 *
 * Configuration file locations (first found wins, project overrides global):
 *   1. Project-level: `<cwd>/.pi/askuser-config.json`     (overrides global)
 *   2. Global-level:  `<agentDir>/askuser-config.json`     (~/.pi/agent/askuser-config.json)
 *
 * Format: `{ "timeout": <seconds> }`
 *   - 0  → no timeout, wait indefinitely (the default)
 *   - >0 → timeout in seconds
 *
 * Missing, unreadable, or malformed config falls back to 0 (no timeout).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CONFIG_FILENAME = "askuser-config.json";

/**
 * Parse `timeout` (seconds) from a config file.
 * Returns `undefined` when the file is missing, unreadable, malformed,
 * or does not contain a valid non-negative finite number.
 */
function readTimeoutFile(filePath: string): number | undefined {
	if (!existsSync(filePath)) return undefined;

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(filePath, "utf-8"));
	} catch {
		// Malformed JSON — ignore and fall back to other sources / default.
		return undefined;
	}

	if (parsed !== null && typeof parsed === "object" && "timeout" in parsed) {
		const timeout = (parsed as { timeout?: unknown }).timeout;
		if (typeof timeout === "number" && Number.isFinite(timeout) && timeout >= 0) {
			return timeout;
		}
	}

	return undefined;
}

/**
 * Load the askuser timeout (seconds) from session-level config.
 *
 * Project-level config (`<cwd>/.pi/askuser-config.json`) overrides the global
 * config (`<agentDir>/askuser-config.json`). Missing or invalid config yields
 * the default of `0` (no timeout — wait indefinitely).
 *
 * @param cwd      Current working directory (project root for project-level config).
 * @param agentDir Agent config directory (e.g. `~/.pi/agent/`), for global config.
 * @returns Timeout in seconds; `0` means no timeout.
 */
export function loadTimeoutConfig(cwd: string, agentDir: string): number {
	const projectTimeout = readTimeoutFile(join(cwd, ".pi", CONFIG_FILENAME));
	if (projectTimeout !== undefined) return projectTimeout;

	const globalTimeout = readTimeoutFile(join(agentDir, CONFIG_FILENAME));
	if (globalTimeout !== undefined) return globalTimeout;

	return 0;
}
