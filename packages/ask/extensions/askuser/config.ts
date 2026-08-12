/**
 * AskUser extension — per-session timeout configuration.
 *
 * Config file location:
 *   `~/.pi/atlas/sessions/<sessionId>/askuser/config.json`
 *
 * Format: `{ "timeout": <seconds> }`
 *   - 0  → no timeout, wait indefinitely (the default)
 *   - >0 → timeout in seconds
 *
 * The config file is created at `session_start` with a default value of `0`.
 * Other extensions can overwrite the file at any time to change the timeout;
 * the new value takes effect on the next `AskUser` call (re-read each time).
 *
 * Missing, unreadable, or malformed config falls back to 0 (no timeout).
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAtlasSessionDir } from "@pi-atlas/shared/atlas-paths.js";

const CONFIG_FILENAME = "config.json";

/**
 * Get the askuser config directory: `~/.pi/atlas/sessions/<sid>/askuser/`.
 */
export function getAskUserConfigDir(sessionId: string): string {
	return join(getAtlasSessionDir(sessionId), "askuser");
}

/**
 * Get the askuser config file path: `~/.pi/atlas/sessions/<sid>/askuser/config.json`.
 */
export function getAskUserConfigPath(sessionId: string): string {
	return join(getAskUserConfigDir(sessionId), CONFIG_FILENAME);
}

/**
 * Load the askuser timeout (seconds) for a session.
 *
 * Re-reads the config file on every call (no caching) so other extensions
 * can update the timeout mid-session. Returns `0` (no timeout) when the
 * file is missing, unreadable, or malformed.
 *
 * @param sessionId  Current session ID.
 * @returns Timeout in seconds; `0` means no timeout (wait indefinitely).
 */
export function loadTimeoutConfig(sessionId: string): number {
	const filePath = getAskUserConfigPath(sessionId);
	if (!existsSync(filePath)) return 0;

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(filePath, "utf-8"));
	} catch {
		// Malformed JSON — fall back to default.
		return 0;
	}

	if (parsed !== null && typeof parsed === "object" && "timeout" in parsed) {
		const timeout = (parsed as { timeout?: unknown }).timeout;
		if (typeof timeout === "number" && Number.isFinite(timeout) && timeout >= 0) {
			return timeout;
		}
	}

	return 0;
}

/**
 * Ensure the per-session askuser config directory and default config file
 * exist. Called at `session_start` so other extensions know the path and can
 * overwrite the file directly.
 *
 * If the config file already exists, it is NOT overwritten (preserves any
 * pre-existing config, e.g. written by another extension before session_start).
 *
 * @param sessionId  Current session ID.
 */
export function ensureDefaultConfig(sessionId: string): void {
	const dir = getAskUserConfigDir(sessionId);
	const filePath = getAskUserConfigPath(sessionId);
	if (!existsSync(filePath)) {
		mkdirSync(dir, { recursive: true });
		writeFileSync(filePath, JSON.stringify({ timeout: 0 }, null, 2), "utf-8");
	}
}
