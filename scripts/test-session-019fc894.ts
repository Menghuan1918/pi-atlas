/**
 * Actually test compaction on session 019fc894 with the fix active.
 * Loads a COPY of the session (via setSessionFile) so the real file is never
 * mutated, then calls session.compact() — our compact extension handler runs
 * (loaded via the real ~/.pi/agent agentDir). Reports fromHook + summary.
 * Run: npx tsx scripts/test-session-019fc894.ts
 */
import { copyFileSync } from "node:fs";
import { createAgentSession, getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";

const REAL =
	"/root/.pi/agent/sessions/--vePFS-Mindverse-user-intern-yihang-mint-anon--/2026-08-03T17-03-15-118Z_019fc894-60ae-7fbc-940e-47d215f0ccd9.jsonl";
const COPY = "/tmp/test-019fc894.jsonl";
copyFileSync(REAL, COPY);

const sm = SessionManager.create("/tmp");
sm.setSessionFile(COPY);
const { session } = await createAgentSession({
	cwd: "/tmp",
	agentDir: getAgentDir(),
	sessionManager: sm,
	noTools: "all",
});
console.log("loaded entries:", session.sessionManager.getEntries().length);

const result = await session.compact("real test on 019fc894");
const entries = session.sessionManager.getEntries();
const comp = entries.find((e) => e.type === "compaction") as
	| { fromHook?: boolean; tokensBefore?: number; summary?: string }
	| undefined;
console.log("\n===== compaction result =====");
console.log("fromHook:", comp?.fromHook, `(${comp?.fromHook ? "OUR handler" : "pi DEFAULT (fell back)"})`);
console.log("tokensBefore:", comp?.tokensBefore, "summary len:", result.summary.length);
console.log("--- summary (first 1200 chars) ---");
console.log(result.summary.slice(0, 1200));
