/**
 * CreateAgent + ResumeTask tools — spawn pi sub-processes as background agent tasks.
 *
 * CreateAgent launches a `pi --mode json -p` child process that runs the given
 * prompt as an isolated agent turn. The JSON event stream on stdout is parsed
 * to accumulate assistant/tool messages and extract the session file path.
 * ResumeTask takes the output of a finished agent task and feeds it as context
 * to a new agent invocation.
 *
 * Nesting depth is controlled via the PI_ATLAS_TASK_DEPTH environment variable:
 * the parent session reads it at session_start (default 0), and each spawned
 * agent sets PI_ATLAS_TASK_DEPTH = depth + 1 for its children.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

import { Type, StringEnum, type Static } from "@earendil-works/pi-ai";
import {
  type ToolDefinition,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { taskManager } from "./task-manager.js";
import { resolveAgent, wrapPrompt, formatAgentCatalog, BUILTIN_AGENTS } from "./agents.js";
import { getAgentSessionDir, getModelTiersPath } from "../shared/atlas-paths.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum nesting depth for agent tasks (depth 0 = top-level, 1 = first child, …). */
export const MAX_AGENT_DEPTH = 3;

/** The two model tiers available to sub-agents. */
export type ModelTier = "fast" | "quality";

/** Default model pattern when auto-detection succeeds. */
const DEFAULT_MODEL_PATTERN = "macaron-v1-coding-venti";

// ---------------------------------------------------------------------------
// model_tier resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a model_tier ("fast" | "quality") to a pi model pattern.
 *
 * Reads the global config at `~/.pi/atlas/model-tiers.json`. On first use
 * (config missing or incomplete), auto-detects available models via
 * `pi --list-models` and writes a default config.
 *
 * Returns the model pattern string, or undefined to inherit the parent's model.
 */
export function resolveModelFromTier(tier: ModelTier): string | undefined {
  const configPath = getModelTiersPath();
  const config = loadModelTiers(configPath);
  return config[tier];
}

interface ModelTiersConfig {
  fast: string;
  quality: string;
}

/**
 * A valid model pattern: a non-empty string with no internal whitespace.
 *
 * pi model patterns are single tokens (e.g. "macaron-v1-coding-venti") and may
 * include a provider prefix ("provider/id") or thinking shorthand
 * ("sonnet:high"), but never contain spaces. This guards against treating the
 * `pi --list-models` table header (which is space-separated) as a model name.
 */
function isValidModelPattern(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !/\s/.test(value);
}

/**
 * Load (and lazily create) the model-tiers config.
 *
 * If the file is missing, corrupt, or holds an invalid (e.g. pre-fix table
 * header) value, auto-detect models and write fresh defaults — so a stale
 * config from before the fix self-heals on the next call.
 */
function loadModelTiers(configPath: string): ModelTiersConfig {
  // Try reading existing config.
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ModelTiersConfig>;
    if (isValidModelPattern(parsed.fast) && isValidModelPattern(parsed.quality)) {
      return parsed as ModelTiersConfig;
    }
    // Config present but invalid (e.g. the pre-fix table header was stored) —
    // fall through and re-detect.
  } catch {
    // File missing or corrupt — fall through to auto-detection.
  }

  // Auto-detect and write defaults.
  const detected = autoDetectModelPattern();
  const config: ModelTiersConfig = {
    fast: detected ?? DEFAULT_MODEL_PATTERN,
    quality: detected ?? DEFAULT_MODEL_PATTERN,
  };
  try {
    mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  } catch (err) {
    console.error(
      `[pi-atlas] Failed to write model-tiers config: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return config;
}

/** Column-name words that only appear in the `pi --list-models` header row. */
const LIST_MODELS_HEADER_WORDS = new Set([
  "provider",
  "model",
  "context",
  "max-out",
  "thinking",
  "images",
]);

/**
 * Parse `pi --list-models` table output and return the first model pattern.
 *
 * `pi --list-models` prints a fixed-width table with a header row:
 *   provider  model                   context  max-out  thinking  images
 *   macaron   macaron-v1-coding-venti 600K     131.1K   yes       no
 * Columns are separated by 2+ spaces. The header row is skipped and the model
 * name (2nd column) is extracted from the first data row. Only whitespace-free
 * tokens are accepted, so a malformed/header line can never be returned.
 *
 * Returns null if no model can be parsed (caller falls back to the default).
 */
export function parseModelPatternFromListOutput(output: string): string | null {
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (line.startsWith("#") || line.toLowerCase().includes("error")) continue;
    const fields = line.split(/\s{2,}/).map((f) => f.trim());
    // Skip the header row — it contains the column-name words.
    if (fields.some((f) => LIST_MODELS_HEADER_WORDS.has(f.toLowerCase()))) continue;
    const model = fields[1] ?? fields[0] ?? "";
    if (isValidModelPattern(model)) return model;
  }
  return null;
}

/**
 * Run `pi --list-models` and return the first available model pattern.
 * Returns null if detection fails (caller falls back to DEFAULT_MODEL_PATTERN).
 */
function autoDetectModelPattern(): string | null {
  try {
    const invocation = getPiInvocation(["--list-models"]);
    const output = execFileSync(invocation.command, invocation.args, {
      encoding: "utf-8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseModelPatternFromListOutput(output);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pi invocation helper
// ---------------------------------------------------------------------------

/**
 * Determine the command + args to invoke pi.
 *
 * Prefers `process.argv[1]` (the current pi script path) so the child uses the
 * same binary and extensions as the parent. Falls back to the bare `pi` command
 * when the script path is not available (e.g. running under a custom runtime).
 */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------

/** Minimal shape of a pi JSON event message (duck-typed for safety). */
interface PiMessage {
  role: string;
  content: { type: string; text?: string; name?: string; arguments?: unknown }[];
}

/**
 * Extract the text of the last assistant message from a list of messages.
 * Returns an empty string when no assistant message with text content exists.
 */
export function extractFinalOutput(messages: PiMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text" && part.text) return part.text;
      }
    }
  }
  return "";
}

/**
 * Extract a session ID (UUID) from a pi session file path.
 *
 * pi session files are named `<timestamp>_<uuid>.jsonl`, e.g.
 * `2026-07-24T03-36-16-199Z_019f9231-f847-791d-a9bb-e7240865d95f.jsonl`.
 * Returns the UUID portion, or undefined if the path doesn't match.
 */
export function extractSessionIdFromPath(sessionFile: string): string | undefined {
  const basename = path.basename(sessionFile);
  // UUID v7-ish: hex-8-4-4-4-12
  const match = basename.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return match?.[1];
}

/**
 * Format accumulated agent messages into a human/agent-readable transcript.
 *
 * Strips usage stats, API metadata, timestamps, and other noise — keeping only
 * the role and text/tool-call content. This is what gets persisted as the full
 * output file for agent tasks (instead of the raw JSON event stream).
 */
export function formatAgentOutput(messages: PiMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const role = msg.role === "assistant" ? "Assistant" : msg.role === "user" ? "User" : msg.role;
    for (const part of msg.content) {
      if (part.type === "text" && part.text) {
        lines.push(`[${role}]`);
        lines.push(part.text);
        lines.push("");
      } else if (part.type === "toolCall" && part.name) {
        const args = part.arguments ? JSON.stringify(part.arguments) : "";
        lines.push(`[${role} → ${part.name}]`);
        if (args) lines.push(args);
        lines.push("");
      }
    }
  }
  return lines.join("\n").trimEnd();
}

// ---------------------------------------------------------------------------
// CreateAgent tool
// ---------------------------------------------------------------------------

const createAgentParameters = Type.Object({
  prompt: Type.String({ description: "Task prompt for the agent" }),
  agent: Type.Optional(
    Type.String({
      description:
        "Agent name (built-in: explorer, code-reviewer, general). Use general for custom agent behavior.",
    }),
  ),
  model_tier: Type.Optional(
    StringEnum(["fast", "quality"], {
      description:
        "Model tier: 'fast' for quick tasks (scout, explore) or 'quality' for complex work (review, refactor). Default: 'quality'.",
    }),
  ),
  cwd: Type.Optional(
    Type.String({ description: "Working directory (default: current cwd)" }),
  ),
  tools: Type.Optional(
    Type.Array(Type.String(), { description: "Tools to enable for the agent" }),
  ),
});

type CreateAgentParams = Static<typeof createAgentParameters>;

interface CreateAgentDetails {
  taskId: string;
  status: string;
  agent?: string;
}

export const createAgentTool: ToolDefinition<typeof createAgentParameters, CreateAgentDetails> = {
  name: "CreateAgent",
  label: "Create Agent Task",
  description:
    "Launch a background agent task that runs a pi sub-process with the given prompt. " +
    "Returns immediately with a task ID. Use AwaitTask to wait for completion " +
    "(agent tasks may take long — use the default timeout).\n\n" +
    "Available agents:\n" +
    formatAgentCatalog(Object.values(BUILTIN_AGENTS)),
  promptSnippet: "Run a background agent task (returns task ID immediately)",
  promptGuidelines: [
    "Use CreateAgent to delegate work to a sub-agent that runs independently while you continue.",
    "After creating an agent task, call AwaitTask before relying on its output — the task runs asynchronously.",
    "Agent tasks run in isolated context with their own session; use ResumeTask to continue from a previous agent's output.",
  ],
  parameters: createAgentParameters,
  async execute(
    _toolCallId: string,
    params: CreateAgentParams,
    _signal: AbortSignal | undefined,
    _onUpdate: unknown,
    ctx: ExtensionContext,
  ): Promise<{ content: { type: "text"; text: string }[]; details: CreateAgentDetails; isError?: boolean }> {
    const sessionId = ctx.sessionManager.getSessionId();
    const cwd = params.cwd ?? ctx.cwd;

    // Validate prompt
    if (!params.prompt?.trim()) {
      return {
        content: [{ type: "text", text: "Error: prompt must not be empty." }],
        details: { taskId: "", status: "failed", agent: params.agent },
      };
    }

    // Check nesting depth
    const currentDepth = taskManager.getSessionDepth(sessionId);
    if (currentDepth + 1 > MAX_AGENT_DEPTH) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Max nesting depth (${MAX_AGENT_DEPTH}) exceeded. Cannot create nested agent task.`,
          },
        ],
        details: { taskId: "", status: "failed", agent: params.agent },
      };
    }

    // Resolve agent definition (if specified)
    let model = resolveModelFromTier((params.model_tier ?? "quality") as ModelTier);
    let tools = params.tools;
    let effectivePrompt = params.prompt;

    if (params.agent) {
      const agentInfo = resolveAgent(params.agent);
      if (!agentInfo) {
        // Agent not found — error and list available agents.
        const catalog = formatAgentCatalog(Object.values(BUILTIN_AGENTS));
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Agent "${params.agent}" not found.\n\nAvailable agents:\n${catalog}`,
            },
          ],
          details: { taskId: "", status: "failed", agent: params.agent },
        };
      }
      // Agent's modelTier overrides only if the caller didn't specify one.
      if (!params.model_tier && agentInfo.modelTier) {
        model = resolveModelFromTier(agentInfo.modelTier);
      }
      model = model ?? agentInfo.model;
      tools = tools ?? agentInfo.tools;
      effectivePrompt = wrapPrompt(params.prompt, agentInfo);
    }

    const task = taskManager.createAgentTask(sessionId, effectivePrompt, {
      cwd,
      agent: params.agent,
      model,
      tools,
      sessionDir: getAgentSessionDir(sessionId),
      depth: currentDepth,
    });

    return {
      content: [
        {
          type: "text",
          text: `Agent task ${task.id} started (running in background).`,
        },
      ],
      details: { taskId: task.id, status: task.status, agent: params.agent },
    };
  },
};

// ---------------------------------------------------------------------------
// ResumeTask tool
// ---------------------------------------------------------------------------

const resumeTaskParameters = Type.Object({
  taskId: Type.String({ description: "ID of the agent task to resume" }),
  prompt: Type.Optional(
    Type.String({
      description:
        "Optional new instruction. Defaults to 'Continue from where you left off.'",
    }),
  ),
});

type ResumeTaskParams = Static<typeof resumeTaskParameters>;

interface ResumeTaskDetails {
  taskId: string;
  parentId: string;
  status: string;
}

export const resumeTaskTool: ToolDefinition<typeof resumeTaskParameters, ResumeTaskDetails> = {
  name: "ResumeTask",
  label: "Resume Agent Task",
  description:
    "Resume a finished agent task by restoring its session history and sending " +
    "a new prompt. The sub-agent's previous conversation context is fully restored " +
    "(it remembers everything). Only agent tasks can be resumed (not bash tasks).",
  promptSnippet: "Continue a finished agent task with full session history",
  promptGuidelines: [
    "ResumeTask restores the previous agent's full session history and sends a new prompt — the agent remembers its prior conversation.",
    "The previous task must be in a terminal state (completed, failed, or cancelled).",
  ],
  parameters: resumeTaskParameters,
  async execute(
    _toolCallId: string,
    params: ResumeTaskParams,
    _signal: AbortSignal | undefined,
    _onUpdate: unknown,
    ctx: ExtensionContext,
  ): Promise<{ content: { type: "text"; text: string }[]; details: ResumeTaskDetails; isError?: boolean }> {
    const sessionId = ctx.sessionManager.getSessionId();

    // Look up the parent task
    const parentTask = taskManager.getTask(sessionId, params.taskId);
    if (!parentTask) {
      return {
        isError: true,
        content: [{ type: "text", text: `Task ${params.taskId} not found` }],
        details: { taskId: "", parentId: params.taskId, status: "failed" },
      };
    }

    // Reject bash tasks
    if (parentTask.type === "bash") {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Cannot resume bash tasks. Resume is only available for agent tasks.",
          },
        ],
        details: { taskId: "", parentId: params.taskId, status: "failed" },
      };
    }

    // Only resume terminal tasks
    if (parentTask.status === "running") {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Task ${params.taskId} is still running. Use AwaitTask or CancelTask first.`,
          },
        ],
        details: { taskId: "", parentId: params.taskId, status: "failed" },
      };
    }

    // Check nesting depth
    const currentDepth = taskManager.getSessionDepth(sessionId);
    if (currentDepth + 1 > MAX_AGENT_DEPTH) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Max nesting depth (${MAX_AGENT_DEPTH}) exceeded. Cannot create nested agent task.`,
          },
        ],
        details: { taskId: "", parentId: params.taskId, status: "failed" },
      };
    }

    // Extract the sub-session ID from the parent task's sessionFile path.
    // The path looks like `<dir>/<timestamp>_<sid>.jsonl`.
    const resumeSid = parentTask.sessionFile
      ? extractSessionIdFromPath(parentTask.sessionFile)
      : undefined;

    if (!resumeSid) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Cannot resume task ${params.taskId}: no session history found. The task may be too old (created before session persistence). Please create a new agent task instead.`,
          },
        ],
        details: { taskId: "", parentId: params.taskId, status: "failed" },
      };
    }

    // The new prompt is just the instruction — the real session history is
    // restored via `--session <sid>` by spawnAgent (not by text injection).
    const resumeInstruction = params.prompt ?? "Continue from where you left off.";

    // Re-resolve agent definition to carry over prefix/suffix, model, and tools.
    let model = resolveModelFromTier("quality");
    let tools: string[] | undefined;
    let effectiveResumePrompt = resumeInstruction;

    if (parentTask.agent) {
      const agentInfo = resolveAgent(parentTask.agent);
      if (agentInfo) {
        if (agentInfo.modelTier) {
          model = resolveModelFromTier(agentInfo.modelTier);
        }
        model = model ?? agentInfo.model;
        tools = agentInfo.tools;
        effectiveResumePrompt = wrapPrompt(resumeInstruction, agentInfo);
      }
      // If the agent definition is no longer found (e.g. file deleted),
      // proceed as a generic agent — the task can still be resumed.
    }

    const task = taskManager.createAgentTask(sessionId, effectiveResumePrompt, {
      cwd: parentTask.cwd,
      agent: parentTask.agent,
      model,
      tools,
      sessionDir: getAgentSessionDir(sessionId),
      depth: currentDepth,
      parentId: params.taskId,
      resumeSid,
    });

    return {
      content: [
        {
          type: "text",
          text: `Agent task ${task.id} resumed from ${params.taskId} (running in background).`,
        },
      ],
      details: { taskId: task.id, parentId: params.taskId, status: task.status },
    };
  },
};
