/**
 * Runtime tests for agent tasks (CreateAgent / ResumeTask) and the TaskManager
 * agent lifecycle: JSON event stream parsing, nesting depth, resume, errors.
 *
 * Run: npx tsx verify/agent-task.test.ts
 */

import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TaskManager, taskManager } from "../extensions/task/index.js";
import {
  extractFinalOutput,
  getPiInvocation,
  MAX_AGENT_DEPTH,
} from "../extensions/task/agent-task.js";
import { resolveAgent, wrapPrompt, formatAgentCatalog, BUILTIN_AGENTS } from "../extensions/task/agents.js";
import * as persistence from "../extensions/task/persistence.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

let pass = 0;
let fail = 0;

/** Loose shape for tool results (allows isError + typed content). */
interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  details: { taskId: string; parentId?: string; status: string; agent?: string };
}

function assert(cond: unknown, msg: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.error(`  ✗ ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake ExtensionContext for tool-level testing. */
function makeCtx(sessionId: string, sessionDir: string, cwd = process.cwd()): ExtensionContext {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionDir: () => sessionDir,
    },
    cwd,
  } as unknown as ExtensionContext;
}

/** Write a mock pi script that emits a JSON event stream and exits with `exitCode`. */
function writeMockPi(dir: string, assistantText: string, exitCode = 0, extraEvents = ""): string {
  const script = `#!/usr/bin/env node
// Mock pi: parse --session-dir and emit JSON events.
const args = process.argv.slice(2);
let sessionDir = ".";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--session-dir") sessionDir = args[i + 1];
}
// Prompt is the last positional arg.
const prompt = args[args.length - 1];

const sid = "mock-" + Math.random().toString(36).slice(2, 10);
const ts = new Date().toISOString();
const fileTs = ts.replace(/[:.]/g, "-");

// Session header
console.log(JSON.stringify({ type: "session", version: 3, id: sid, timestamp: ts, cwd: sessionDir }));
console.log(JSON.stringify({ type: "agent_start" }));
console.log(JSON.stringify({ type: "turn_start" }));

// Assistant message
const msg = {
  role: "assistant",
  content: [{ type: "text", text: ${JSON.stringify(assistantText)} }],
  model: "mock-model",
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0 } },
  stopReason: "stop",
  timestamp: Date.now(),
};
console.log(JSON.stringify({ type: "message_start", message: msg }));
console.log(JSON.stringify({ type: "message_update", message: msg, assistantMessageEvent: { type: "text_delta", delta: ${JSON.stringify(assistantText)} } }));
console.log(JSON.stringify({ type: "message_end", message: msg }));
console.log(JSON.stringify({ type: "turn_end", message: msg, toolResults: [] }));
console.log(JSON.stringify({ type: "agent_end", messages: [msg] }));
console.log(JSON.stringify({ type: "agent_settled" }));
${extraEvents}

// Write a dummy session file so sessionFile derivation can be verified.
try {
  const fs = require("fs");
  const path = require("path");
  const file = path.join(sessionDir, fileTs + "_" + sid + ".jsonl");
  fs.writeFileSync(file, "mock session content\\n");
} catch (e) {}

process.exit(${exitCode});
`;
  const scriptPath = join(dir, "mock-pi.cjs");
  writeFileSync(scriptPath, script, { mode: 0o755 });
  return scriptPath;
}

/** Write a mock pi script that writes to stderr and exits non-zero. */
function writeMockPiError(dir: string): string {
  const script = `#!/usr/bin/env node
process.stderr.write("Error: something went wrong\\n");
process.exit(1);
`;
  const scriptPath = join(dir, "mock-pi-err.cjs");
  writeFileSync(scriptPath, script, { mode: 0o755 });
  return scriptPath;
}

// ---------------------------------------------------------------------------
// 1. Unit tests: extractFinalOutput
// ---------------------------------------------------------------------------

console.log("\nTest 1: extractFinalOutput");
{
  const msgs = [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    { role: "assistant", content: [{ type: "text", text: "first answer" }] },
    { role: "assistant", content: [{ type: "text", text: "final answer" }] },
  ];
  assert(extractFinalOutput(msgs) === "final answer", "returns last assistant text");

  const noAssistant = [{ role: "user", content: [{ type: "text", text: "q" }] }];
  assert(extractFinalOutput(noAssistant) === "", "empty string when no assistant message");

  const toolOnly = [{ role: "assistant", content: [{ type: "toolCall", name: "bash" }] }];
  assert(extractFinalOutput(toolOnly) === "", "empty when assistant has no text part");

  assert(extractFinalOutput([]) === "", "empty for empty messages");
}

// ---------------------------------------------------------------------------
// 2. Unit tests: getPiInvocation
// ---------------------------------------------------------------------------

console.log("\nTest 2: getPiInvocation");
{
  const inv = getPiInvocation(["--mode", "json", "-p", "hello"]);
  assert(inv.command.length > 0, "returns a command");
  assert(inv.args.includes("--mode"), "args include --mode");
  assert(inv.args.includes("json"), "args include json");
  assert(inv.args.includes("hello"), "args include the prompt");
}

// ---------------------------------------------------------------------------
// 3. Integration: createAgentTask with mock pi (success)
// ---------------------------------------------------------------------------

console.log("\nTest 3: createAgentTask parses JSON event stream (mock pi)");
{
  const tempDir = mkdtempSync(join(tmpdir(), "pi-agent-test-"));
  process.env.PI_CODING_AGENT_DIR = tempDir;
  process.env.PI_ATLAS_DIR = tempDir;

  const sessionId = "agent-session-1";
  const tm = taskManager; // use singleton (the tool reads from it)
  tm.setSessionDepth(sessionId, 0);

  const sessionDir = mkdtempSync(join(tmpdir(), "pi-agent-session-"));
  const mockScript = writeMockPi(tempDir, "The answer is 42");

  // Point process.argv[1] to the mock script so getPiInvocation uses it.
  const savedArgv1 = process.argv[1];
  process.argv[1] = mockScript;

  try {
    const task = tm.createAgentTask(sessionId, "What is the answer?", {
      cwd: process.cwd(),
      sessionDir,
      depth: 0,
    });

    assert(task.type === "agent", "task type is agent");
    assert(task.status === "running", "task starts as running");
    assert(task.prompt === "What is the answer?", "prompt is stored");
    assert(task.depth === 0, "depth is 0");

    const { results, timedOut } = await tm.awaitTasks(sessionId, [task.id], 15000);
    assert(!timedOut, "did not time out");
    assert(results.length === 1, "one result");
    assert(results[0].status === "completed", "task completed");
    assert(results[0].exitCode === 0, "exit code 0");
    assert(results[0].output.includes("42"), "output contains '42'");
    assert(results[0].output.includes("The answer is 42"), "output is the full assistant message");

    // sessionFile should be derived from the session header
    const finalTask = tm.getTask(sessionId, task.id);
    assert(finalTask?.sessionFile !== undefined, "sessionFile is set");
    assert(finalTask?.sessionFile?.includes(".jsonl"), "sessionFile is a .jsonl path");
    assert(existsSync(finalTask!.sessionFile!), "session file exists on disk");

    // Output persisted to file
    const tasksDir = persistence.getTasksDir(sessionId);
    const outputFile = join(tasksDir, `output-${task.id}.log`);
    assert(existsSync(outputFile), "output file exists");
    const rawOutput = readFileSync(outputFile, "utf-8");
    assert(rawOutput.includes("[Assistant]"), "output file has readable transcript format");
  } finally {
    process.argv[1] = savedArgv1;
    rmSync(sessionDir, { recursive: true, force: true });
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 4. Integration: createAgentTask failure (non-zero exit)
// ---------------------------------------------------------------------------

console.log("\nTest 4: createAgentTask failure (mock pi exits 1)");
{
  const tempDir = mkdtempSync(join(tmpdir(), "pi-agent-fail-"));
  const sessionId = "agent-fail-session";
  const tm = new TaskManager();
  tm.setSessionDepth(sessionId, 0);

  const sessionDir = mkdtempSync(join(tmpdir(), "pi-agent-fail-sess-"));
  const mockScript = writeMockPiError(tempDir);

  const savedArgv1 = process.argv[1];
  process.argv[1] = mockScript;

  try {
    const task = tm.createAgentTask(sessionId, "do something", {
      cwd: process.cwd(),
      sessionDir,
      depth: 0,
    });

    const { results } = await tm.awaitTasks(sessionId, [task.id], 15000);
    assert(results[0].status === "failed", "task failed on non-zero exit");
    assert(results[0].exitCode === 1, "exit code 1");
    assert(results[0].output.includes("something went wrong"), "output contains stderr");
  } finally {
    process.argv[1] = savedArgv1;
    rmSync(sessionDir, { recursive: true, force: true });
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 5. Tool-level: CreateAgent nesting depth check
// ---------------------------------------------------------------------------

console.log("\nTest 5: CreateAgent nesting depth check");
{
  const tempDir = mkdtempSync(join(tmpdir(), "pi-agent-depth-"));
  process.env.PI_CODING_AGENT_DIR = tempDir;
  process.env.PI_ATLAS_DIR = tempDir;
  const sessionId = "depth-session";
  const sessionDir = mkdtempSync(join(tmpdir(), "pi-agent-depth-sess-"));

  // Set depth to max on the singleton — the tool uses the singleton taskManager.
  taskManager.setSessionDepth(sessionId, MAX_AGENT_DEPTH);

  // Dynamically import the tool to call execute.
  const { createAgentTool } = await import("../extensions/task/agent-task.js");

  const ctx = makeCtx(sessionId, sessionDir);

  const result = await createAgentTool.execute(
    "tc1",
    { prompt: "test prompt" },
    undefined,
    undefined,
    ctx,
  ) as unknown as ToolResult;

  assert(result.isError === true, "depth-exceeded returns isError");
  assert(result.content[0].text.includes("Max nesting depth"), "error mentions max nesting depth");
  assert(result.content[0].text.includes(String(MAX_AGENT_DEPTH)), "error includes the depth number");

  rmSync(sessionDir, { recursive: true, force: true });
  rmSync(tempDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 6. Tool-level: CreateAgent empty prompt
// ---------------------------------------------------------------------------

console.log("\nTest 6: CreateAgent rejects empty prompt");
{
  const tempDir = mkdtempSync(join(tmpdir(), "pi-agent-empty-"));
  process.env.PI_CODING_AGENT_DIR = tempDir;
  process.env.PI_ATLAS_DIR = tempDir;
  const sessionId = "empty-session";
  const sessionDir = mkdtempSync(join(tmpdir(), "pi-agent-empty-sess-"));

  const { createAgentTool } = await import("../extensions/task/agent-task.js");
  const ctx = makeCtx(sessionId, sessionDir);

  const result = await createAgentTool.execute(
    "tc1",
    { prompt: "   " },
    undefined,
    undefined,
    ctx,
  ) as unknown as ToolResult;

  assert(result.content[0].text.includes("prompt must not be empty"), "empty prompt rejected");
  assert(result.details.taskId === "", "no task created");

  rmSync(sessionDir, { recursive: true, force: true });
  rmSync(tempDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 7. Tool-level: ResumeTask rejects bash tasks
// ---------------------------------------------------------------------------

console.log("\nTest 7: ResumeTask rejects bash tasks");
{
  const tempDir = mkdtempSync(join(tmpdir(), "pi-agent-resume-bash-"));
  process.env.PI_CODING_AGENT_DIR = tempDir;
  process.env.PI_ATLAS_DIR = tempDir;
  const sessionId = "resume-bash-session";
  const sessionDir = mkdtempSync(join(tmpdir(), "pi-agent-resume-bash-sess-"));

  // Create a completed bash task on the singleton (the tool reads from it).
  const bashTask = taskManager.createBashTask(sessionId, "echo done", process.cwd());
  await taskManager.awaitTasks(sessionId, [bashTask.id], 10000);

  const { resumeTaskTool } = await import("../extensions/task/agent-task.js");
  const ctx = makeCtx(sessionId, sessionDir);

  const result = await resumeTaskTool.execute(
    "tc1",
    { taskId: bashTask.id },
    undefined,
    undefined,
    ctx,
  ) as unknown as ToolResult;

  assert(result.isError === true, "bash resume returns isError");
  assert(
    result.content[0].text.includes("Cannot resume bash tasks"),
    "error says cannot resume bash tasks",
  );

  rmSync(sessionDir, { recursive: true, force: true });
  rmSync(tempDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 8. Tool-level: ResumeTask rejects non-existent and running tasks
// ---------------------------------------------------------------------------

console.log("\nTest 8: ResumeTask rejects non-existent and running tasks");
{
  const tempDir = mkdtempSync(join(tmpdir(), "pi-agent-resume-misc-"));
  process.env.PI_CODING_AGENT_DIR = tempDir;
  process.env.PI_ATLAS_DIR = tempDir;
  const sessionId = "resume-misc-session";
  const sessionDir = mkdtempSync(join(tmpdir(), "pi-agent-resume-misc-sess-"));

  const tm = taskManager; // use singleton (the tool reads from it)
  const { resumeTaskTool } = await import("../extensions/task/agent-task.js");
  const ctx = makeCtx(sessionId, sessionDir);

  // Non-existent task
  const r1 = await resumeTaskTool.execute("tc1", { taskId: "deadbeef" }, undefined, undefined, ctx) as unknown as ToolResult;
  assert(r1.isError === true, "non-existent task → isError");
  assert(r1.content[0].text.includes("not found"), "non-existent → 'not found'");

  // Running agent task (use mock pi that sleeps)
  const sleepScript = join(tempDir, "sleep-pi.cjs");
  writeFileSync(sleepScript, `setTimeout(() => process.exit(0), 5000);\n`, { mode: 0o755 });
  const savedArgv1 = process.argv[1];
  process.argv[1] = sleepScript;
  try {
    const runningTask = tm.createAgentTask(sessionId, "sleep", {
      cwd: process.cwd(),
      sessionDir,
      depth: 0,
    });
    const r2 = await resumeTaskTool.execute(
      "tc1",
      { taskId: runningTask.id },
      undefined,
      undefined,
      ctx,
    ) as unknown as ToolResult;
    assert(r2.isError === true, "running task → isError");
    assert(r2.content[0].text.includes("still running"), "running → 'still running'");

    // Clean up the running task
    await tm.cancel(sessionId, runningTask.id);
  } finally {
    process.argv[1] = savedArgv1;
  }

  rmSync(sessionDir, { recursive: true, force: true });
  rmSync(tempDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 9. Integration: ResumeTask on completed agent task
// ---------------------------------------------------------------------------

console.log("\nTest 9: ResumeTask creates child task from completed agent");
{
  const tempDir = mkdtempSync(join(tmpdir(), "pi-agent-resume-ok-"));
  process.env.PI_CODING_AGENT_DIR = tempDir;
  process.env.PI_ATLAS_DIR = tempDir;
  const sessionId = "resume-ok-session";
  const sessionDir = mkdtempSync(join(tmpdir(), "pi-agent-resume-ok-sess-"));

  const tm = taskManager; // use singleton (the tool reads from it)
  tm.setSessionDepth(sessionId, 0);
  const mockScript = writeMockPi(tempDir, "First result");

  const savedArgv1 = process.argv[1];
  process.argv[1] = mockScript;

  try {
    // Create and complete an agent task
    const parentTask = tm.createAgentTask(sessionId, "step 1", {
      cwd: process.cwd(),
      sessionDir,
      depth: 0,
    });
    await tm.awaitTasks(sessionId, [parentTask.id], 15000);
    assert(tm.getTask(sessionId, parentTask.id)!.status === "completed", "parent completed");

    // Resume via the tool
    const { resumeTaskTool } = await import("../extensions/task/agent-task.js");
    const ctx = makeCtx(sessionId, sessionDir);
    const resumeResult = await resumeTaskTool.execute(
      "tc1",
      { taskId: parentTask.id, prompt: "Now do step 2" },
      undefined,
      undefined,
      ctx,
    ) as unknown as ToolResult;

    assert(resumeResult.details.taskId !== "", "resume created a new task");
    assert(resumeResult.details.parentId === parentTask.id, "parentId links to parent");
    assert(resumeResult.details.status === "running", "new task is running");
    assert(!("isError" in resumeResult) || resumeResult.isError !== true, "resume not an error");

    const childTask = tm.getTask(sessionId, resumeResult.details.taskId);
    assert(childTask?.parentId === parentTask.id, "child task parentId correct");
    assert(childTask?.prompt?.includes("Now do step 2"), "child prompt includes new instruction");
    assert(childTask?.prompt?.includes("First result"), "child prompt includes parent output");

    await tm.awaitTasks(sessionId, [childTask!.id], 15000);
    assert(tm.getTask(sessionId, childTask!.id)!.status === "completed", "child completed");
  } finally {
    process.argv[1] = savedArgv1;
    rmSync(sessionDir, { recursive: true, force: true });
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 10. Integration: nesting depth via env var
// ---------------------------------------------------------------------------

console.log("\nTest 10: PI_ATLAS_TASK_DEPTH propagation");
{
  const tempDir = mkdtempSync(join(tmpdir(), "pi-agent-env-"));
  process.env.PI_CODING_AGENT_DIR = tempDir;
  process.env.PI_ATLAS_DIR = tempDir;
  const sessionId = "env-session";
  const sessionDir = mkdtempSync(join(tmpdir(), "pi-agent-env-sess-"));

  // Mock pi that echoes PI_ATLAS_TASK_DEPTH and exits.
  const echoScript = join(tempDir, "echo-depth.cjs");
  writeFileSync(
    echoScript,
    `console.log(JSON.stringify({type:"session",version:3,id:"echo-sid",timestamp:new Date().toISOString(),cwd:"."}));\n` +
      `const msg = { role: "assistant", content: [{ type: "text", text: "depth=" + process.env.PI_ATLAS_TASK_DEPTH }] };\n` +
      `console.log(JSON.stringify({ type: "message_end", message: msg }));\n` +
      `process.exit(0);\n`,
    { mode: 0o755 },
  );

  const tm = new TaskManager();
  tm.setSessionDepth(sessionId, 1); // simulate depth 1 (child session)

  const savedArgv1 = process.argv[1];
  process.argv[1] = echoScript;

  try {
    const task = tm.createAgentTask(sessionId, "echo depth", {
      cwd: process.cwd(),
      sessionDir,
      depth: 1,
    });
    const { results } = await tm.awaitTasks(sessionId, [task.id], 15000);
    assert(results[0].status === "completed", "task completed");
    assert(results[0].output.includes("depth=2"), "child sees PI_ATLAS_TASK_DEPTH=2 (depth+1)");
  } finally {
    process.argv[1] = savedArgv1;
    rmSync(sessionDir, { recursive: true, force: true });
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 11. Integration: real pi (end-to-end)
// ---------------------------------------------------------------------------

console.log("\nTest 11: real pi end-to-end (simple prompt)");
{
  // Don't override PI_CODING_AGENT_DIR — real pi needs the actual ~/.pi
  // for API keys and config. (Previous tests set it to temp dirs that are now
  // deleted.) Delete it so pi defaults to ~/.pi.
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
  const savedAtlasDir = process.env.PI_ATLAS_DIR;
  delete process.env.PI_ATLAS_DIR;
  const sessionId = "real-session";
  const sessionDir = mkdtempSync(join(tmpdir(), "pi-agent-real-sess-"));

  const tm = new TaskManager();
  tm.setSessionDepth(sessionId, 0);

  // Save argv[1] and unset it so getPiInvocation falls back to the `pi` command.
  const savedArgv1 = process.argv[1];
  try {
    process.argv[1] = "/nonexistent/path/to/pi"; // force fallback to `pi` command

    const task = tm.createAgentTask(sessionId, "Reply with exactly: AGENT_OK", {
      cwd: process.cwd(),
      sessionDir,
      depth: 0,
    });

    const { results, timedOut } = await tm.awaitTasks(sessionId, [task.id], 60000);
    assert(!timedOut, "real pi did not time out");
    assert(results[0].status === "completed", "real pi task completed");
    assert(
      results[0].output.includes("AGENT_OK"),
      "real pi output contains AGENT_OK",
    );

    const finalTask = tm.getTask(sessionId, task.id);
    assert(finalTask?.sessionFile !== undefined, "real pi sessionFile set");
    assert(existsSync(finalTask!.sessionFile!), "real pi session file exists");
  } finally {
    process.argv[1] = savedArgv1;
    if (savedAgentDir !== undefined) process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    if (savedAtlasDir !== undefined) process.env.PI_ATLAS_DIR = savedAtlasDir;
    rmSync(sessionDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 12. resolveAgent (built-in only)
// ---------------------------------------------------------------------------

console.log("\nTest 12: resolveAgent finds built-in agents");
{
  const resolved = resolveAgent("explorer");
  assert(resolved !== null, "explorer resolved");
  assert(resolved!.prefix?.includes("You are a scout"), "explorer prefix extracted");
  assert(resolved!.tools?.includes("read"), "explorer tools include read");

  const reviewer = resolveAgent("code-reviewer");
  assert(reviewer !== null, "code-reviewer resolved");
  assert(reviewer!.prefix?.includes("Senior Code Reviewer"), "code-reviewer prefix extracted");

  const general = resolveAgent("general");
  assert(general !== null, "general resolved");
  assert(general!.prefix === undefined, "general has no prefix");

  const notFound = resolveAgent("nonexistent-agent");
  assert(notFound === null, "unknown agent returns null");
}

// ---------------------------------------------------------------------------
// 12a. Built-in agents
// ---------------------------------------------------------------------------

console.log("\nTest 12a: built-in agents (explorer, code-reviewer, general)");
{
  assert(BUILTIN_AGENTS["explorer"] !== undefined, "explorer built-in exists");
  assert(BUILTIN_AGENTS["code-reviewer"] !== undefined, "code-reviewer built-in exists");
  assert(BUILTIN_AGENTS["general"] !== undefined, "general built-in exists");

  assert(BUILTIN_AGENTS["explorer"].prefix !== undefined, "explorer has prefix");
  assert(BUILTIN_AGENTS["explorer"].suffix === undefined, "explorer has no suffix");
  assert(BUILTIN_AGENTS["explorer"].tools?.includes("read"), "explorer tools include read");
  assert(BUILTIN_AGENTS["explorer"].tools?.includes("grep"), "explorer tools include grep");

  assert(BUILTIN_AGENTS["code-reviewer"].prefix !== undefined, "code-reviewer has prefix");
  assert(BUILTIN_AGENTS["code-reviewer"].tools?.includes("read"), "code-reviewer tools include read");
  assert(BUILTIN_AGENTS["code-reviewer"].tools?.includes("bash"), "code-reviewer tools include bash");

  // general: no prefix, no suffix, no tools
  assert(BUILTIN_AGENTS["general"].prefix === undefined, "general has no prefix");
  assert(BUILTIN_AGENTS["general"].suffix === undefined, "general has no suffix");
  assert(BUILTIN_AGENTS["general"].tools === undefined, "general has no tools");
}

// ---------------------------------------------------------------------------
// 12b. wrapPrompt
// ---------------------------------------------------------------------------

console.log("\nTest 12b: wrapPrompt wraps prompt with prefix and suffix");
{
  // prefix only (explorer)
  const explorer = BUILTIN_AGENTS["explorer"];
  const wrapped = wrapPrompt("Find the auth module", explorer);
  assert(wrapped.startsWith("You are a scout"), "prefix at start");
  assert(wrapped.includes("Find the auth module"), "prompt in middle");
  assert(wrapped.endsWith("Find the auth module"), "prompt at end (no suffix)");

  // prefix + suffix
  const both: { prefix: string; suffix: string } = {
    prefix: "BEFORE",
    suffix: "AFTER",
  };
  const wrapped2 = wrapPrompt("TASK", both);
  assert(wrapped2 === "BEFORE\n\nTASK\n\nAFTER", "prefix + prompt + suffix with newlines");

  // general (no prefix, no suffix) — prompt returned as-is
  const general = BUILTIN_AGENTS["general"];
  const wrapped3 = wrapPrompt("Do something", general);
  assert(wrapped3 === "Do something", "general returns prompt unchanged");
}

// ---------------------------------------------------------------------------
// 12c. formatAgentCatalog
// ---------------------------------------------------------------------------

console.log("\nTest 12c: formatAgentCatalog lists all built-in agents");
{
  const catalog = formatAgentCatalog(Object.values(BUILTIN_AGENTS));
  assert(catalog.includes("explorer:"), "catalog includes explorer");
  assert(catalog.includes("code-reviewer:"), "catalog includes code-reviewer");
  assert(catalog.includes("general:"), "catalog includes general");
  assert(catalog.includes("- "), "catalog uses dash format");
}

// ---------------------------------------------------------------------------
// 12d. CreateAgent tool description contains agent catalog
// ---------------------------------------------------------------------------

console.log("\nTest 12d: CreateAgent description has agent catalog");
{
  const { createAgentTool } = await import("../extensions/task/agent-task.js");
  assert(createAgentTool.description.includes("Available agents:"), "description has Available agents header");
  assert(createAgentTool.description.includes("explorer:"), "description lists explorer");
  assert(createAgentTool.description.includes("code-reviewer:"), "description lists code-reviewer");
  assert(createAgentTool.description.includes("general:"), "description lists general");
}

// ---------------------------------------------------------------------------
// 12e. CreateAgent not-found error lists available agents
// ---------------------------------------------------------------------------

console.log("\nTest 12e: CreateAgent not-found error lists available agents");
{
  const tempDir = mkdtempSync(join(tmpdir(), "pi-agent-notfound-"));
  process.env.PI_CODING_AGENT_DIR = tempDir;
  process.env.PI_ATLAS_DIR = tempDir;
  const sessionId = "notfound-session";
  const sessionDir = mkdtempSync(join(tmpdir(), "pi-agent-notfound-sess-"));
  taskManager.setSessionDepth(sessionId, 0);

  const { createAgentTool } = await import("../extensions/task/agent-task.js");
  const ctx = makeCtx(sessionId, sessionDir);

  const result = await createAgentTool.execute(
    "tc1",
    { prompt: "do something", agent: "nonexistent-agent" },
    undefined, undefined, ctx,
  ) as unknown as ToolResult;

  assert(result.isError === true, "returns isError");
  assert(result.content[0].text.includes("not found"), "error says not found");
  assert(result.content[0].text.includes("explorer"), "error lists explorer");
  assert(result.content[0].text.includes("code-reviewer"), "error lists code-reviewer");
  assert(result.content[0].text.includes("general"), "error lists general");
  assert(result.details.taskId === "", "no task created");

  rmSync(sessionDir, { recursive: true, force: true });
  rmSync(tempDir, { recursive: true, force: true });
}
// ---------------------------------------------------------------------------
// 12f. Integration: usage tracking (cost as object)
// ---------------------------------------------------------------------------

console.log("\nTest 12f: usage.cost accumulation (object form)");
{
  const tempDir = mkdtempSync(join(tmpdir(), "pi-agent-usage-"));
  process.env.PI_CODING_AGENT_DIR = tempDir;
  process.env.PI_ATLAS_DIR = tempDir;
  const sessionId = "usage-session";
  const sessionDir = mkdtempSync(join(tmpdir(), "pi-agent-usage-sess-"));
  taskManager.setSessionDepth(sessionId, 0);

  // Mock pi that emits two assistant messages with cost objects.
  const usageScript = join(tempDir, "usage-pi.cjs");
  writeFileSync(
    usageScript,
    `const sid = "usage-sid"; const ts = new Date().toISOString();\n` +
      `console.log(JSON.stringify({type:"session",version:3,id:sid,timestamp:ts,cwd:process.argv[2]}));\n` +
      `const msg1 = { role: "assistant", content: [{ type: "text", text: "first" }], model: "test", usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, totalTokens: 165, cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.25, total: 3.75 } }, stopReason: "stop" };\n` +
      `console.log(JSON.stringify({ type: "message_end", message: msg1 }));\n` +
      `const msg2 = { role: "assistant", content: [{ type: "text", text: "second" }], model: "test", usage: { input: 200, output: 100, cacheRead: 20, cacheWrite: 10, totalTokens: 330, cost: { input: 2, output: 4, cacheRead: 1, cacheWrite: 0.5, total: 7.5 } }, stopReason: "stop" };\n` +
      `console.log(JSON.stringify({ type: "message_end", message: msg2 }));\n` +
      `process.exit(0);\n`,
    { mode: 0o755 },
  );

  const savedArgv1 = process.argv[1];
  process.argv[1] = usageScript;

  try {
    const task = taskManager.createAgentTask(sessionId, "test usage", {
      cwd: process.cwd(),
      sessionDir,
      depth: 0,
    });
    const { results } = await taskManager.awaitTasks(sessionId, [task.id], 15000);
    assert(results[0].status === "completed", "usage task completed");

    const finalTask = taskManager.getTask(sessionId, task.id);
    assert(finalTask?.usage !== undefined, "usage is set on task");
    assert(finalTask!.usage!.input === 300, "input accumulated (100+200)");
    assert(finalTask!.usage!.output === 150, "output accumulated (50+100)");
    assert(finalTask!.usage!.cacheRead === 30, "cacheRead accumulated (10+20)");
    assert(finalTask!.usage!.cacheWrite === 15, "cacheWrite accumulated (5+10)");
    assert(finalTask!.usage!.cost === 11.25, "cost accumulated from object.total (3.75+7.5)");
    assert(finalTask!.usage!.turns === 2, "turns accumulated (2)");
    assert(finalTask!.usage!.model === "test", "model set");
    assert(finalTask!.usage!.stopReason === "stop", "stopReason set");
  } finally {
    process.argv[1] = savedArgv1;
    rmSync(sessionDir, { recursive: true, force: true });
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\nagent-task.test: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
