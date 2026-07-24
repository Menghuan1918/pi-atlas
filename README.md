# pi-atlas

Asynchronous task management and user interaction extensions for [pi](https://github.com/earendil-works/pi-mono) coding agent.

## Extensions

### Task Extension (`extensions/task/`)

Background task system with unified bash and agent execution. Seven tools:

| Tool | Description |
|------|-------------|
| `CreateBash` | Run a shell command in the background. Returns immediately with a task ID. |
| `CreateAgent` | Spawn a pi sub-process as a background agent task. Returns immediately with a task ID. Built-in agents: `explorer`, `code-reviewer`, `general` (use `general` for custom behavior). |
| `AwaitTask` | Block until specified tasks finish. Default timeout 3600s; timeout does NOT cancel tasks. |
| `CancelTask` | Kill a running task's process tree (SIGTERM → 5s → SIGKILL). |
| `ResumeTask` | Continue a finished agent task in a new sub-process. Bash tasks cannot be resumed. |
| `ListTask` | List all tasks (running and finished) in the current session. |
| `WatchTask` | View the current output and status of a task. |

**Key features:**
- **Agent presets** — three built-in agents (`explorer`, `code-reviewer`, `general`). The agent list is injected into the CreateAgent tool description.
- **Prompt wrapping** — agent `prefix`/`suffix` wrap the task prompt: `prefix + "\n\n" + prompt + "\n\n" + suffix`.
- **Session-level isolation** — tasks are scoped per session, persisted to `~/.pi/atlas/sessions/<sessionId>/task/`.
- **Output truncation** — tail-kept at 50KB / 2000 lines; full output saved to a file when truncated.
- **agent_settled guard** — prevents the agent from ending a turn while tasks are still running.
- **Nesting depth control** — `PI_ATLAS_TASK_DEPTH` env var limits nested agent tasks (default max: 3).
- **Usage tracking** — agent tasks accumulate token/cost stats from the sub-process.

### AskUser Extension (`extensions/askuser/`)

Single tool that asks the user questions and blocks for answers:

| Tool | Description |
|------|-------------|
| `ask_user` | Ask one or more questions (select / confirm / input). Batch supported. |

**Key features:**
- **select** — single choice from options, with an "Other (free input)" fallback for custom answers. In TUI mode, selecting "Other" opens an inline editor directly (no separate dialog).
- **confirm** — yes/no dialog.
- **input** — free-text input. In TUI mode, typing starts an inline editor immediately.
- **TUI navigation** — in interactive mode, all questions are shown on one screen. Use ← → to switch between questions, ↑↓ to navigate options, Enter to confirm.
- **Session-level timeout** — per-session config at `~/.pi/atlas/sessions/<sessionId>/askuser/config.json` (`{"timeout": 0}` where 0 = infinite wait). Re-read on every call; other extensions can overwrite the file to change the timeout mid-session.
- **Non-interactive fallback** — returns an error in print/json modes.

### Bash Timeout Extension (`extensions/bash-timeout/`)

Injects default timeouts for the built-in `bash` tool via two event handlers:

- **`tool_call`** — when no timeout is specified, injects a default:
  - **20 s** for search commands (`find`, `grep`, `rg`, `ag`, `ack`, `fd`, `locate`) — detected via regex pre-filter + `shell-quote` parsing.
  - **120 s** for everything else.
  - Explicit timeouts from the caller are always respected.
- **`tool_result`** — when bash exits due to timeout, replaces the error message with a hint to use `CreateBash` for long-running commands.

No tools or configuration — purely passive interception. Zero overhead when an explicit timeout is provided.

## Installation

### Via symlink (development)

```bash
ln -s /path/to/pi-atlas/extensions/task ~/.pi/agent/extensions/task
ln -s /path/to/pi-atlas/extensions/askuser ~/.pi/agent/extensions/askuser
ln -s /path/to/pi-atlas/extensions/bash-timeout ~/.pi/agent/extensions/bash-timeout
```

### Via settings.json

```json
{
  "extensions": [
    "/path/to/pi-atlas/extensions/task",
    "/path/to/pi-atlas/extensions/askuser",
    "/path/to/pi-atlas/extensions/bash-timeout"
  ]
}
```

## Configuration

### AskUser timeout

The config file is created at `session_start` at:

```
~/.pi/atlas/sessions/<sessionId>/askuser/config.json
```

```json
{
  "timeout": 0
}
```

- `0` — wait indefinitely (default).
- `>0` — timeout in seconds. On timeout: confirm → `false`, select → `default` or `(no answer / timed out)`, input → `default` or `(no answer / timed out)`.

The file is re-read on every `ask_user` call, so other extensions can overwrite it at any time to change the timeout dynamically.

### Agent nesting depth

Set `PI_ATLAS_TASK_DEPTH` in the environment. The top-level session defaults to 0; each spawned agent increments by 1. Tasks exceeding `MAX_AGENT_DEPTH` (default: 3) are rejected.

### Agent presets

Three built-in agents are always available:

| Agent | Description | Tools |
|------|-------------|-------|
| `explorer` | Fast codebase recon returning compressed context | read, grep, find, ls, bash |
| `code-reviewer` | Read-only code review against requirements and quality | read, grep, bash |
| `general` | General-purpose, no special prompt — use for custom behavior | (all tools) |

For custom agent behavior, use `general` and craft the task prompt directly — its `prefix`/`suffix` are empty, so the prompt you pass becomes the full instruction. You can also pass `model` / `tools` / `cwd` to tailor it.

Specifying a non-existent agent returns an error with the available agents list.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # run all test suites
```

### Project structure

```
extensions/
├── shared/
│   └── atlas-paths.ts        # Shared path helpers (~/.pi/atlas/sessions/<sid>/)
├── task/
│   ├── index.ts              # Extension entry — registers tools + events
│   ├── types.ts              # Task / TaskUsage / TaskResult types
│   ├── task-manager.ts       # Lifecycle, state machine, session isolation
│   ├── persistence.ts        # ~/.pi/atlas/sessions/<sid>/task/ persistence
│   ├── output-accumulator.ts # Bounded-memory output tracking + temp file spill
│   ├── bash-task.ts          # CreateBash tool
│   ├── agent-task.ts         # CreateAgent + ResumeTask tools + dynamic description builder
│   ├── agents.ts             # Agent preset system — built-ins, discovery, prompt wrapping
│   ├── control.ts            # AwaitTask / CancelTask / ListTask / WatchTask
│   └── guard.ts              # agent_settled guard
├── askuser/
│   ├── index.ts              # Extension entry — registers ask_user tool
│   ├── config.ts             # Per-session timeout config reader
│   └── multi-question.ts     # TUI multi-question component (← → navigation + inline editor)
└── bash-timeout/
    ├── index.ts              # Extension entry — tool_call + tool_result handlers
    └── detect.ts            # Search command detection (regex + shell-quote)
```

## License

MIT
