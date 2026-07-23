/**
 * Runtime tests for askuser config loading.
 * Run: npx tsx verify/config.test.ts
 */

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTimeoutConfig } from "../extensions/askuser/config";

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

const projectDir = mkdtempSync(join(tmpdir(), "askuser-proj-"));
const agentDir = mkdtempSync(join(tmpdir(), "askuser-agent-"));
const projectPi = join(projectDir, ".pi");
const projectFile = join(projectPi, "askuser-config.json");
const globalFile = join(agentDir, "askuser-config.json");

/** Clear both config files, then optionally write project/global JSON. */
function setup(projectJson?: string, globalJson?: string): void {
	for (const f of [projectFile, globalFile]) {
		try {
			rmSync(f);
		} catch {
			/* ignore */
		}
	}
	if (projectJson !== undefined) {
		mkdirSync(projectPi, { recursive: true });
		writeFileSync(projectFile, projectJson);
	}
	if (globalJson !== undefined) {
		writeFileSync(globalFile, globalJson);
	}
}

// 1. No config anywhere → default 0.
setup();
assert(loadTimeoutConfig(projectDir, agentDir) === 0, "no config → 0 (default, no timeout)");

// 2. Global only.
setup(undefined, JSON.stringify({ timeout: 30 }));
assert(loadTimeoutConfig(projectDir, agentDir) === 30, "global only → 30");

// 3. Project overrides global.
setup(JSON.stringify({ timeout: 5 }), JSON.stringify({ timeout: 30 }));
assert(loadTimeoutConfig(projectDir, agentDir) === 5, "project overrides global → 5");

// 4. Project only (no global file).
setup(JSON.stringify({ timeout: 7 }));
assert(loadTimeoutConfig(projectDir, agentDir) === 7, "project only (no global) → 7");

// 5. Malformed project JSON → fall back to global.
setup("{ not valid json }", JSON.stringify({ timeout: 30 }));
assert(loadTimeoutConfig(projectDir, agentDir) === 30, "malformed project → fall back to global 30");

// 6. Malformed project + no global → default 0.
setup("{ broken }");
assert(loadTimeoutConfig(projectDir, agentDir) === 0, "malformed project + no global → 0");

// 7. timeout: 0 explicit.
setup(JSON.stringify({ timeout: 0 }));
assert(loadTimeoutConfig(projectDir, agentDir) === 0, "explicit timeout 0 → 0 (infinite)");

// 8. Invalid timeout values ignored → default.
setup(undefined, JSON.stringify({ timeout: -5 }));
assert(loadTimeoutConfig(projectDir, agentDir) === 0, "negative timeout ignored → 0");
setup(undefined, JSON.stringify({ timeout: "60" }));
assert(loadTimeoutConfig(projectDir, agentDir) === 0, "string timeout ignored → 0");
setup(undefined, JSON.stringify({}));
assert(loadTimeoutConfig(projectDir, agentDir) === 0, "empty object → 0");

// 9. Extra/unknown fields tolerated.
setup(JSON.stringify({ timeout: 12, extra: "ignored" }));
assert(loadTimeoutConfig(projectDir, agentDir) === 12, "unknown fields tolerated");

console.log(`\nconfig.test: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
