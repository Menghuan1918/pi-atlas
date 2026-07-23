# pi-atlas

Asynchronous task management and user interaction extensions for [pi](https://github.com/earendil-works/pi-mono) coding agent.

## Extensions

### Task Extension (`extensions/task/`)

Background task system with unified bash and agent execution. Seven tools:

| Tool | Description |
|------|-------------|
| `CreateBash` | Run a shell command in the background. Returns immediately with a task ID. |
| `CreateAgent` | Spawn a pi sub-process as a background agent task. Returns immediately with a task ID. |
| `AwaitTask` | Block until specified tasks finish. Default timeout 3600s; timeout does NOT cancel tasks. |
| `CancelTask` | Kill a running task's process tree (SIGTERM → 5s → SIGKILL). |
| `ResumeTask` | Continue a finished agent task in a new sub-process. Bash tasks cannot be resumed. |
| `ListTask` | List all tasks (running and finished) in the current session. |
| `WatchTask` | View the current output and status of a task. |

**Key features:**
- **Session-level isolation** — tasks are scoped per session, persisted to `~/.pi/tasks/<sessionId>/`.
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
- **select** — single choice from options, with an "Other (free input)" fallback for custom answers.
- **confirm** — yes/no dialog.
- **input** — free-text input.
- **Session-level timeout** — configured via `~/.pi/agent/askuser-config.json` (`{"timeout": 0}` where 0 = infinite wait).
- **Non-interactive fallback** — returns an error in print/json modes.

## Installation

### Via symlink (development)

```bash
ln -s /path/to/pi-atlas/extensions/task ~/.pi/agent/extensions/task
ln -s /path/to/pi-atlas/extensions/askuser ~/.pi/agent/extensions/askuser
```

### Via settings.json

```json
{
  "extensions": [
    "/path/to/pi-atlas/extensions/task",
    "/path/to/pi-atlas/extensions/askuser"
  ]
}
```

## Configuration

### AskUser timeout

Create `~/.pi/agent/askuser-config.json`:

```json
{
  "timeout": 0
}
```

- `0` — wait indefinitely (default).
- `>0` — timeout in seconds. On timeout: confirm → `false`, select → `default` or `(no answer / timed out)`, input → `default` or `(no answer / timed out)`.

Project-level config at `<cwd>/.pi/askuser-config.json` overrides the global config.

### Agent nesting depth

Set `PI_ATLAS_TASK_DEPTH` in the environment. The top-level session defaults to 0; each spawned agent increments by 1. Tasks exceeding `MAX_AGENT_DEPTH` (default: 3) are rejected.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # run all test suites
```

### Project structure

```
extensions/
├── task/
│   ├── index.ts              # Extension entry — registers tools + events
│   ├── types.ts              # Task / TaskUsage / TaskResult types
│   ├── task-manager.ts       # Lifecycle, state machine, session isolation
│   ├── persistence.ts        # ~/.pi/tasks/<sessionId>/ persistence
│   ├── output-accumulator.ts # Bounded-memory output tracking + temp file spill
│   ├── bash-task.ts          # CreateBash tool
│   ├── agent-task.ts         # CreateAgent + ResumeTask tools
│   ├── control.ts            # AwaitTask / CancelTask / ListTask / WatchTask
│   └── guard.ts              # agent_settled guard
└── askuser/
    ├── index.ts              # Extension entry — registers ask_user tool
    └── config.ts             # Session-level timeout config reader
```

## License

MIT
