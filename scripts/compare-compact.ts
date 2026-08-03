/**
 * compact extension — A/B comparison: OUR summarizer vs pi's DEFAULT, on a slice
 * of a REAL session's history.
 * Run: npx tsx scripts/compare-compact.ts
 *
 * - Extracts the first ~30k chars of real messages from a real session JSONL.
 * - Arm A (ours):   agentDir = ~/.pi/agent            → compact extension loaded.
 * - Arm B (pi def): agentDir = /tmp/agent-nocompact   → no compact extension → pi default.
 * - Both: same in-memory session content, same macaron model, same keepRecentTokens.
 * Prints both summaries + fromHook flags so you can compare quality side by side.
 */
import { readFileSync } from "node:fs";
import { createAgentSession, getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";

const REAL_SESSION =
	process.argv[2] ??
	"/root/.pi/agent/sessions/--vePFS-Mindverse-user-intern-yihang--/2026-07-23T12-35-03-469Z_019f8ef8-e2ad-7ab8-84f0-3009a4995a8f.jsonl";
const COMPARE_CWD = "/tmp/compact-compare-cwd";
const NOCOMPACT_AGENT_DIR = "/tmp/agent-nocompact";
const CHAR_CAP = 60000;
const MAX_USER_TURNS = 4;
const MAX_MSG_CHARS = 12000;

// --- extract a real message slice spanning multiple turns (so there are mid-branch
// cut points; a single turn forces the cut to the start → empty messagesToSummarize) ---
type AnyMsg = { role?: string; content?: unknown };
const messages: AnyMsg[] = [];
let chars = 0;
let userTurns = 0;
for (const line of readFileSync(REAL_SESSION, "utf-8").split("\n")) {
	if (!line.trim()) continue;
	let entry: { type?: string; message?: AnyMsg };
	try {
		entry = JSON.parse(line);
	} catch {
		continue;
	}
	if (entry.type !== "message" || !entry.message) continue;
	const role = entry.message.role;
	if (role !== "user" && role !== "assistant" && role !== "toolResult") continue;
	if (role === "user") userTurns++;
	let size = JSON.stringify(entry.message.content ?? "").length;
	if (size > MAX_MSG_CHARS) continue; // skip one giant tool result so it can't dominate
	if (chars + size > CHAR_CAP) break;
	messages.push(entry.message);
	chars += size;
	if (userTurns >= MAX_USER_TURNS) break;
}
console.log(`Extracted ${messages.length} real messages (${userTurns} user turns, ${chars} chars of content) from\n  ${REAL_SESSION}\n`);

async function compactArm(label: string, agentDir: string) {
	const { session } = await createAgentSession({
		cwd: COMPARE_CWD,
		agentDir,
		sessionManager: SessionManager.inMemory(COMPARE_CWD),
		noTools: "all",
	});
	for (const m of messages) {
		try {
			session.sessionManager.appendMessage(m as never);
		} catch (err) {
			console.error(`  [${label}] appendMessage skipped a ${m.role}: ${err instanceof Error ? err.message : err}`);
		}
	}
	const result = await session.compact("A/B comparison: focus on the goal, progress, and next steps");
	const entries = session.sessionManager.getEntries();
	const comp = entries.find((e) => e.type === "compaction") as { fromHook?: boolean } | undefined;
	console.log(`===== ${label} (agentDir=${agentDir}) =====`);
	console.log(`  fromHook: ${comp?.fromHook}  (${comp?.fromHook ? "OUR handler" : "pi DEFAULT"})`);
	console.log(`  summary chars: ${result.summary.length}`);
	console.log(`  --- summary ---`);
	console.log(result.summary);
	console.log();
}

await compactArm("ARM A — ours (compact extension)", getAgentDir());
await compactArm("ARM B — pi default (no compact extension)", NOCOMPACT_AGENT_DIR);
