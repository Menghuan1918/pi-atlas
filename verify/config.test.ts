/**
 * Runtime tests for askuser config loading (per-session).
 * Run: npx tsx verify/config.test.ts
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadTimeoutConfig,
	ensureDefaultConfig,
	getAskUserConfigPath,
	getAskUserConfigDir,
} from "../packages/ask/extensions/askuser/config";

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string): void {
	if (cond) {
		pass++;
		console.log("  ✓ " + msg);
	} else {
		fail++;
		console.error("  ✗ " + msg);
	}
}

/** Temp atlas dir for test isolation. */
const atlasDir = mkdtempSync(join(tmpdir(), "askuser-cfg-atlas-"));
process.env.PI_ATLAS_DIR = atlasDir;

const sessionId = "cfg-test-session";
const configPath = getAskUserConfigPath(sessionId);

/** Write a config file for the test session (or delete it). */
function setup(json?: string): void {
	try {
		rmSync(getAskUserConfigDir(sessionId), { recursive: true, force: true });
	} catch {
		/* ignore */
	}
	if (json !== undefined) {
		mkdirSync(getAskUserConfigDir(sessionId), { recursive: true });
		writeFileSync(configPath, json);
	}
}

// 1. No config file → default 0.
setup();
assert(loadTimeoutConfig(sessionId) === 0, "no config → 0 (default, no timeout)");

// 2. Config with timeout 30.
setup(JSON.stringify({ timeout: 30 }));
assert(loadTimeoutConfig(sessionId) === 30, "timeout 30 → 30");

// 3. Explicit timeout 0 → 0 (infinite).
setup(JSON.stringify({ timeout: 0 }));
assert(loadTimeoutConfig(sessionId) === 0, "explicit timeout 0 → 0 (infinite)");

// 4. Malformed JSON → default 0.
setup("{ not valid json }");
assert(loadTimeoutConfig(sessionId) === 0, "malformed JSON → 0");

// 5. Invalid timeout values ignored → default 0.
setup(JSON.stringify({ timeout: -5 }));
assert(loadTimeoutConfig(sessionId) === 0, "negative timeout ignored → 0");
setup(JSON.stringify({ timeout: "60" }));
assert(loadTimeoutConfig(sessionId) === 0, "string timeout ignored → 0");
setup(JSON.stringify({}));
assert(loadTimeoutConfig(sessionId) === 0, "empty object → 0");
setup(JSON.stringify({ timeout: Infinity }));
assert(loadTimeoutConfig(sessionId) === 0, "Infinity timeout ignored → 0");
setup(JSON.stringify({ timeout: NaN }));
assert(loadTimeoutConfig(sessionId) === 0, "NaN timeout ignored → 0");

// 6. Extra/unknown fields tolerated.
setup(JSON.stringify({ timeout: 12, extra: "ignored" }));
assert(loadTimeoutConfig(sessionId) === 12, "unknown fields tolerated");

// 7. ensureDefaultConfig creates directory + default config file.
{
	const freshSession = "ensure-session";
	try {
		rmSync(getAskUserConfigDir(freshSession), { recursive: true, force: true });
	} catch {
		/* ignore */
	}
	ensureDefaultConfig(freshSession);
	const path = getAskUserConfigPath(freshSession);
	assert(existsSync(path), "ensureDefaultConfig creates config file");
	const content = JSON.parse(readFileSync(path, "utf-8"));
	assert(content.timeout === 0, "default config has timeout 0");
}

// 8. ensureDefaultConfig does NOT overwrite existing config.
{
	const overwriteSession = "overwrite-session";
	mkdirSync(getAskUserConfigDir(overwriteSession), { recursive: true });
	writeFileSync(getAskUserConfigPath(overwriteSession), JSON.stringify({ timeout: 42 }));
	ensureDefaultConfig(overwriteSession);
	const content = JSON.parse(readFileSync(getAskUserConfigPath(overwriteSession), "utf-8"));
	assert(content.timeout === 42, "ensureDefaultConfig preserves existing config (timeout 42)");
}

// 9. Different sessions have independent configs.
{
	setup(JSON.stringify({ timeout: 10 }));
	assert(loadTimeoutConfig(sessionId) === 10, "session A has timeout 10");
	const otherSession = "other-session";
	mkdirSync(getAskUserConfigDir(otherSession), { recursive: true });
	writeFileSync(getAskUserConfigPath(otherSession), JSON.stringify({ timeout: 99 }));
	assert(loadTimeoutConfig(otherSession) === 99, "session B has timeout 99");
	assert(loadTimeoutConfig(sessionId) === 10, "session A still has timeout 10 (independent)");
}

console.log(`\nconfig.test: ${pass} passed, ${fail} failed`);

// Cleanup
rmSync(atlasDir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
