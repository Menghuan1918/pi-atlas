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

import { Type, type Static } from "@earendil-works/pi-ai";
import {
  type ToolDefinition,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { taskManager } from "./task-manager.js";
import { resolveAgent, wrapPrompt, formatAgentCatalog, BUILTIN_AGENTS } from "./agents.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum nesting depth for agent tasks (depth 0 = top-level, 1 = first child, …). */
export const MAX_AGENT_DEPTH = 3;

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
  model: Type.Optional(
    Type.String({ description: "Model to use (e.g. 'anthropic/claude-sonnet-4-5')" }),
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
    let model = params.model;
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
      model = model ?? agentInfo.model;
      tools = tools ?? agentInfo.tools;
      effectivePrompt = wrapPrompt(params.prompt, agentInfo);
    }

    const task = taskManager.createAgentTask(sessionId, effectivePrompt, {
      cwd,
      agent: params.agent,
      model,
      tools,
      sessionDir: ctx.sessionManager.getSessionDir(),
      depth: currentDepth,
    });

    return {
      content: [
        {
          type: "text",
          text: `Agent task ${task.id} started (running in background).\n` +
            (params.agent ? `Agent: ${params.agent}\n` : "") +
            `Use AwaitTask to wait for completion (agent tasks may take long — use default timeout).`,
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
    "Resume a finished agent task by spawning a new pi sub-process that uses the " +
    "previous task's output as context. Only agent tasks can be resumed (not bash tasks).",
  promptSnippet: "Continue a finished agent task with new context",
  promptGuidelines: [
    "ResumeTask creates a new agent task linked to a previously completed agent task via parentId.",
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

    // Construct resume prompt
    const resumeInstruction = params.prompt ?? "Continue from where you left off.";
    const previousOutput = parentTask.output || "(no output from previous task)";
    const fullPrompt = `${resumeInstruction}\n\n--- Previous task output ---\n${previousOutput}`;

    // Re-resolve agent definition to carry over prefix/suffix, model, and tools.
    let model: string | undefined;
    let tools: string[] | undefined;
    let effectiveResumePrompt = fullPrompt;

    if (parentTask.agent) {
      const agentInfo = resolveAgent(parentTask.agent);
      if (agentInfo) {
        model = agentInfo.model;
        tools = agentInfo.tools;
        effectiveResumePrompt = wrapPrompt(fullPrompt, agentInfo);
      }
      // If the agent definition is no longer found (e.g. file deleted),
      // proceed as a generic agent — the task can still be resumed.
    }

    const task = taskManager.createAgentTask(sessionId, effectiveResumePrompt, {
      cwd: parentTask.cwd,
      agent: parentTask.agent,
      model,
      tools,
      sessionDir: ctx.sessionManager.getSessionDir(),
      depth: currentDepth,
      parentId: params.taskId,
    });

    return {
      content: [
        {
          type: "text",
          text: `Agent task ${task.id} resumed from ${params.taskId} (running in background).\n` +
            `Use AwaitTask to wait for completion (agent tasks may take long — use default timeout).`,
        },
      ],
      details: { taskId: task.id, parentId: params.taskId, status: task.status },
    };
  },
};
