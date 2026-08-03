/**
 * Reproduce the failing compaction (session 019fc87e) and A/B it: ours vs pi default.
 * Injects ALL messages from the real session via appendMessage, compacts both arms.
 * Run: npx tsx scripts/repro-failing.ts
 */
import { readFileSync } from "node:fs";
import { createAgentSession, getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";

const REAL_SESSION =
	"/root/.pi/agent/sessions/--vePFS-Mindverse-user-intern-yihang-mint-anon--/2026-08-03T16-39-04-738Z_019fc87e-3f22-7dd7-9f2a-9b0f4e4d9ff8.jsonl";
const COMPARE_CWD = "/tmp/compact-compare-cwd";
const NOCOMPACT_AGENT_DIR = "/tmp/agent-nocompact";

// Extract ALL message entries (no cap) — the full real conversation.
const messages: unknown[] = [];
for (const line of readFileSync(REAL_SESSION, "utf-8").split("\n")) {
	if (!line.trim()) continue;
	let e: { type?: string; message?: unknown };
	try {
		e = JSON.parse(line);
	} catch {
		continue;
	}
	if (e.type !== "message" || !e.message) continue;
	messages.push(e.message);
}
console.log(`Injecting all ${messages.length} real messages from the failing session\n`);

async function compactArm(label: string, agentDir: string) {
	const { session } = await createAgentSession({
		cwd: COMPARE_CWD,
		agentDir,
		sessionManager: SessionManager.inMemory(COMPARE_CWD),
		noTools: "all",
	});
	let appended = 0;
	for (const m of messages) {
		try {
			session.sessionManager.appendMessage(m as never);
			appended++;
		} catch (err) {
			// ignore
		}
	}
	const result = await session.compact("repro: focus on goal, progress, next steps");
	const entries = session.sessionManager.getEntries();
	const comp = entries.find((e) => e.type === "compaction") as { fromHook?: boolean } | undefined;
	console.log(`===== ${label} (appended ${appended}) =====`);
	console.log(`  fromHook: ${comp?.fromHook}  (${comp?.fromHook ? "OUR handler" : "pi DEFAULT"})`);
	console.log(`  summary ${result.summary.length} chars:`);
	console.log(result.summary.slice(0, 1200));
	console.log();
}

await compactArm("ARM A — ours", getAgentDir());
await compactArm("ARM B — pi default", NOCOMPACT_AGENT_DIR);
