/**
 * Tests for bash-timeout command detection.
 * Run: npx tsx verify/bash-timeout.test.ts
 */

import { isSearchCommand } from "../extensions/bash-timeout/detect";

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
function expectSearch(cmd: string): void {
	assert(isSearchCommand(cmd) === true, `search  ← ${cmd}`);
}
function expectNotSearch(cmd: string): void {
	assert(isSearchCommand(cmd) === false, `normal  ← ${cmd}`);
}

// ── Direct invocations ──────────────────────────────────────────────
expectSearch('find . -name "*.ts"');
expectSearch("rg pattern src/");
expectSearch("grep -rn foo .");
expectSearch("grep -rn 'foo' . 2>/dev/null");
expectSearch("ag --type=ts pattern");
expectSearch("ack pattern");
expectSearch("fd -e ts");
expectSearch("locate foo");
expectSearch("egrep 'foo' file");
expectSearch("fgrep 'foo' file");

// ── In pipelines ─────────────────────────────────────────────────────
expectSearch("cat file | grep foo");
expectSearch("find . -name x | xargs grep bar");
expectSearch("echo hello && rg pattern .");
expectSearch("echo hi; grep foo .");
expectSearch("rg pattern . || true");

// ── Env prefix & absolute paths ──────────────────────────────────────
expectSearch("FOO=bar rg pattern .");
expectSearch("/usr/bin/find .");
expectSearch("PATH=/usr/bin grep foo .");

// ── Not search commands ──────────────────────────────────────────────
expectNotSearch("ls -la");
expectNotSearch("echo hello world");
expectNotSearch("cat file.txt");
expectNotSearch("npm run build");
expectNotSearch("git status");
expectNotSearch("cd /tmp && ls");
expectNotSearch("echo 'use rg for searching'");
expectNotSearch("command -v find");
expectNotSearch("man grep");
expectNotSearch("which rg");

// ── Edge cases ───────────────────────────────────────────────────────
expectNotSearch("");
expectNotSearch("   ");
expectNotSearch("findutils --version"); // "findutils" contains "find" but \b prevents match
expectSearch("find ."); // minimal

console.log(`\nbash-timeout.test: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
