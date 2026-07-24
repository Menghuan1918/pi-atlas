/**
 * Agent preset system — built-in roles and prompt wrapping.
 *
 * Three built-in agents are always available:
 *   - explorer      — fast codebase recon returning compressed context
 *   - code-reviewer — read-only code review (requirements + quality)
 *   - general       — general-purpose, no special prompt
 *
 * For custom agent behavior, use `general` and craft the task prompt directly.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A resolved agent definition ready for prompt wrapping and spawn. */
export interface AgentDefinition {
  /** Agent name. */
  name: string;
  /** Short description shown in the CreateAgent tool listing. */
  description: string;
  /** Text prepended to the task prompt. */
  prefix?: string;
  /** Text appended to the task prompt. */
  suffix?: string;
  /** Model override (e.g. "claude-haiku-4-5"). */
  model?: string;
  /** Model tier ("fast" | "quality") — preferred over `model` for built-in agents. */
  modelTier?: "fast" | "quality";
  /** Tool allowlist. */
  tools?: string[];
}

// ---------------------------------------------------------------------------
// Built-in agents
// ---------------------------------------------------------------------------

const EXPLORER_PREFIX = `You are a scout. Quickly investigate a codebase and return structured findings that another agent can use without re-reading everything.

Your output will be passed to an agent who has NOT seen the files you explored.

Strategy:
1. grep/find to locate relevant code
2. Read key sections (not entire files)
3. Identify types, interfaces, key functions
4. Note dependencies between files

Output format:

## Files Retrieved
List with exact line ranges:
1. \`path/to/file.ts\` (lines 10-50) - Description of what's here
2. \`path/to/other.ts\` (lines 100-150) - Description

## Key Code
Critical types, interfaces, or functions (include actual code snippets)

## Architecture
Brief explanation of how the pieces connect.

## Start Here
Which file to look at first and why.`;

const CODE_REVIEWER_PREFIX = `You are a Senior Code Reviewer with expertise in software architecture, design patterns, and best practices. Your job is to review completed work against its plan or requirements and identify issues before they cascade.

Your review is read-only. Do not mutate the working tree, the index, HEAD, or branch state. Use tools like git show, git diff, and git log to inspect history.

## What to Check

Plan alignment:
- Does the implementation match the plan / requirements?
- Are deviations justified improvements, or problematic departures?
- Is all planned functionality present?

Code quality:
- Clean separation of concerns?
- Proper error handling?
- Type safety where applicable?
- DRY without premature abstraction?
- Edge cases handled?

Architecture:
- Sound design decisions?
- Reasonable scalability and performance?
- Security concerns?
- Integrates cleanly with surrounding code?

Testing:
- Tests verify real behavior, not mocks?
- Edge cases covered?
- All tests passing?

## Calibration

Categorize issues by actual severity. Not everything is Critical. Acknowledge what was done well before listing issues.

## Output Format

### Strengths
[What's well done? Be specific.]

### Issues
#### Critical (Must Fix)
[Bugs, security issues, data loss risks, broken functionality]
#### Important (Should Fix)
[Architecture problems, missing features, poor error handling, test gaps]
#### Minor (Nice to Have)
[Code style, optimization opportunities, documentation polish]

For each issue: File:line reference, What's wrong, Why it matters, How to fix.

### Assessment
Ready to merge? [Yes | No | With fixes]
Reasoning: [1-2 sentence technical assessment]`;

/** Built-in agent definitions. */
export const BUILTIN_AGENTS: Record<string, AgentDefinition> = {
  explorer: {
    name: "explorer",
    description:
      "Fast codebase recon that returns compressed context for handoff to other agents",
    prefix: EXPLORER_PREFIX,
    modelTier: "fast",
    tools: ["read", "grep", "find", "ls", "bash"],
  },
  "code-reviewer": {
    name: "code-reviewer",
    description:
      "Reviews code changes against requirements and quality standards (read-only)",
    prefix: CODE_REVIEWER_PREFIX,
    tools: ["read", "grep", "bash"],
  },
  general: {
    name: "general",
    description:
      "General-purpose agent with no special prompt — use for custom agent behavior",
  },
};

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a built-in agent by name.
 * Returns null when not found.
 */
export function resolveAgent(name: string): AgentDefinition | null {
  return BUILTIN_AGENTS[name] ?? null;
}

// ---------------------------------------------------------------------------
// Prompt wrapping
// ---------------------------------------------------------------------------

/**
 * Wrap a task prompt with the agent's prefix and suffix.
 *
 * effective_prompt = [prefix]\n\n[prompt]\n\n[suffix]
 * If the agent has no prefix/suffix (e.g. general), returns the prompt as-is.
 */
export function wrapPrompt(
  prompt: string,
  agent: Pick<AgentDefinition, "prefix" | "suffix">,
): string {
  const parts: string[] = [];
  if (agent.prefix) parts.push(agent.prefix.trim());
  parts.push(prompt);
  if (agent.suffix) parts.push(agent.suffix.trim());
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Catalog formatting (for tool description)
// ---------------------------------------------------------------------------

/**
 * Format the agent list as a human/LLM-readable catalog.
 * Used to inject available agents into the CreateAgent tool description.
 */
export function formatAgentCatalog(agents: AgentDefinition[]): string {
  const lines = agents.map((a) => `- ${a.name}: ${a.description}`);
  return lines.join("\n");
}
