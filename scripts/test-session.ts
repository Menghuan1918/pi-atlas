/**
 * Actually test compaction on a real session with the fix active.
 * Loads a COPY of the session (via setSessionFile) so the real file is never
 * mutated, then calls session.compact() — our compact extension handler runs
 * (real-history handoff via pi-ai, loaded through the real ~/.pi/agent agentDir).
 * Reports fromHook + summary.
 * Run: npx tsx scripts/test-session.ts [path/to/session.jsonl]
 */
import { copyFileSync } from "node:fs";
import { createAgentSession, getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";

const REAL =
	process.argv[2] ??
	"/root/.pi/agent/sessions/--vePFS-Mindverse-user-intern-yihang-mint-anon--/2026-07-28T09-59-55-692Z_019fa82a-a82c-7b3a-9942-d7e64ed5a6ca.jsonl";
const COPY = "/tmp/test-compact-session.jsonl";
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

const result = await session.compact("real test on the session");
const entries = session.sessionManager.getEntries();
const comp = entries.find((e) => e.type === "compaction") as
	| { fromHook?: boolean; tokensBefore?: number; summary?: string }
	| undefined;
console.log("\n===== compaction result =====");
console.log("fromHook:", comp?.fromHook, `(${comp?.fromHook ? "OUR handler" : "pi DEFAULT (fell back)"})`);
console.log("tokensBefore:", comp?.tokensBefore, "summary len:", result.summary.length);
console.log("--- summary (first 1200 chars) ---");
console.log(result.summary.slice(0, 1200));
