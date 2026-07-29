# pi-atlas

> 中文文档：[README_CN.md](README_CN.md)

TypeScript extensions for the [pi](https://github.com/earendil-works/pi-mono) coding agent — asynchronous task management, user interaction, goal tracking, auto-continue, web search, and Feishu notifications.

## 介绍

pi-atlas is a collection of independent pi extensions. Each extension is a self-contained directory under `extensions/` and can be installed individually. They share a single runtime data root at `~/.pi/atlas/` (overridable via `PI_ATLAS_DIR`), scoped per session under `~/.pi/atlas/sessions/<sessionId>/`.

| Extension | Type | What it does |
|-----------|------|--------------|
| `task` | tools + guard | Background bash/agent task system (7 tools) |
| `askuser` | tool | Ask the user questions and block for answers |
| `target` | tool + command | Goal/todo management + `/goal` auto-continue |
| `bash-timeout` | passive | Default timeouts for the built-in `bash` tool |
| `websearch` | tool | Server-side web search via an Anthropic-compatible provider |
| `guard` | passive | Coordinates `agent_settled` + Feishu notifications |
| `pi-acp-v2` | standalone server | Exposes pi as an ACP v2 agent over stdio (dev bridge, not a pi extension) |

### Task (`extensions/task/`)

Background task system unifying bash and agent execution. Seven tools:

| Tool | Description |
|------|-------------|
| `create_bash` | Run a shell command in the background. Returns immediately with a task ID. |
| `create_agent` | Spawn a pi sub-process as a background agent task. Returns immediately with a task ID. Built-in agents: `explorer`, `code-reviewer`, `general` (use `general` for custom behavior). |
| `await_task` | Block until specified tasks finish. Default timeout 3600s; timeout does NOT cancel tasks. While waiting, streams a live status showing each running task's bash output tail (or the sub-agent's last action). |
| `cancel_task` | Kill a running task's process tree (SIGTERM → 5s → SIGKILL). |
| `resume_task` | Continue a finished agent task in a new sub-process. Bash tasks cannot be resumed. |
| `list_task` | List all tasks (running and finished) in the current session. |
| `watch_task` | View the current output and status of a task. |

Key features:
- **Agent presets** — three built-in agents (`explorer`, `code-reviewer`, `general`); the list is injected into the create_agent tool description.
- **Prompt wrapping** — agent `prefix`/`suffix` wrap the task prompt: `prefix + "\n\n" + prompt + "\n\n" + suffix`.
- **Session-level isolation** — tasks are scoped per session, persisted to `~/.pi/atlas/sessions/<sessionId>/task/`.
- **Output truncation** — tail-kept at 50KB / 2000 lines; full output saved to a file when truncated.
- **agent_settled guard** — prevents the agent from ending a turn while tasks are still running.
- **Nesting depth control** — `PI_ATLAS_TASK_DEPTH` env var limits nested agent tasks (default max: 3).
- **Usage tracking** — agent tasks accumulate token/cost stats from the sub-process.

### ask_user (`extensions/askuser/`)

Single tool that asks the user questions and blocks for answers:

| Tool | Description |
|------|-------------|
| `ask_user` | Ask one or more questions (select / input). Batch supported. |

Key features:
- **select** — single choice from options, with an "Other (free input)" fallback for custom answers. In TUI mode, selecting "Other" opens an inline editor directly (no separate dialog).
- **input** — free-text input. In TUI mode, typing starts an inline editor immediately.
- **TUI navigation** — in interactive mode, all questions are shown on one screen. Use ← → to switch between questions, ↑↓ to navigate options, Enter to confirm.
- **Session-level timeout** — per-session config at `~/.pi/atlas/sessions/<sessionId>/askuser/config.json` (`{"timeout": 0}` where 0 = infinite wait). Re-read on every call; other extensions can overwrite the file to change the timeout mid-session.
- **Non-interactive fallback** — returns an error in print/json modes.

### Target (`extensions/target/`)

Unified goal and todo management that also drives auto-continue.

| Tool | Description |
|------|-------------|
| `Target` | Manage targets: `set` primary, `add` secondary, `update` status, `update_targets` (overwrite all), `list`. |

A **target** is either `primary` (id 0, drives auto-continue) or `secondary` (id 1+, for progress tracking). State persists per session to `~/.pi/atlas/sessions/<sessionId>/target/state.json`.

The `/goal` command (user-only) sets the primary target and toggles auto-continue:

| Usage | Effect |
|-------|--------|
| `/goal <text>` | Set the primary target + activate auto-continue + send the goal immediately if idle |
| `/goal on` | Re-activate auto-continue for the existing primary + resume immediately if idle |
| `/goal off` | Turn off auto-continue (primary target retained) |
| `/goal` | Show current status |

When auto-continue is active, the `guard` extension re-injects a completion-audit message on each `agent_settled` until the primary target is marked `completed` or `failed`.

### Bash Timeout (`extensions/bash-timeout/`)

Passive extension (no tools) that injects default timeouts for the built-in `bash` tool via two event handlers:

- **`tool_call`** — when no timeout is specified, injects a default:
  - **20 s** for search commands (`find`, `grep`, `rg`, `ag`, `ack`, `fd`, `locate`) — detected via regex pre-filter + `shell-quote` parsing.
  - **120 s** for everything else.
  - Explicit timeouts from the caller are always respected.
- **`tool_result`** — when bash exits due to timeout, replaces the error message with a hint to use `create_bash` for long-running commands.

Purely passive interception — zero overhead when an explicit timeout is provided.

### WebSearch (`extensions/websearch/`)

Single tool that searches the web for current/real-time information:

| Tool | Description |
|------|-------------|
| `WebSearch` | Search the web (version numbers, news, recent events). Returns a concise answer with source URLs. |

How it works:
- The query is routed through the **`macaron`** provider's Anthropic-compatible `/v1/messages` endpoint, which executes a server-side `web_search` tool and returns the model's answer (with sources). The extension only relays the query and collects the answer — no search logic lives in the plugin.
- **macaron credentials** (`apiKey` + `baseUrl`) are resolved from the host model registry at call time; no keys are hardcoded. The `macaron` provider must be configured in `~/.pi/agent/models.json`.
- **Domain filtering** — optional `allowed_domains` / `blocked_domains` passed as soft constraints.
- **Graceful failure** — an unconfigured provider or network error returns an `isError` result instead of throwing.

> The server-side `web_search` convention is shared by other Anthropic-compatible search endpoints (e.g. DeepSeek's `/anthropic` endpoint), so wiring additional providers is straightforward. Today only `macaron` is wired and verified.

### Guard (`extensions/guard/`)

Passive extension (no tools) that coordinates the `agent_settled` event and sends Feishu notifications. It depends on the `task` and `target` extensions (it imports their managers/guards), so load all three together.

On `agent_settled`, guards run in priority order:
1. **Escape / aborted** (highest) — if the last assistant turn was aborted, disable target auto-continue and stop.
2. **Background tasks** — if any background task is still running, inject a task reminder (skip the target guard).
3. **Target auto-continue** — if active, inject a continuation message with a completion audit.
4. **Otherwise (truly idle)** — send a Feishu "session ended" notification.

A Feishu notification is also sent when the `ask_user` tool is invoked ("waiting for input"). Notifications are suppressed in subagent sessions (`PI_ATLAS_TASK_DEPTH > 0`).

Feishu config is global (not per session) at `~/.pi/atlas/notify.json`:

```json
{
  "enabled": true,
  "webhookUrl": "https://open.feishu.cn/open-apis/bot/v2/hook/<id>",
  "webhookSecret": "<optional; required only if the webhook verifies signatures>",
  "webUrl": "https://your-pi-web.example.com"
}
```

- Missing file / `enabled: false` / empty `webhookUrl` → silent no-op (safe default; no secrets in source).
- `webUrl` is optional — it sets the "open session" button target `${webUrl}/?session=<sessionId>`; when unset the card omits the button.
- The config is re-read on every notification, so edits take effect without a restart.

### pi-acp-v2 (`extensions/pi-acp-v2/`)

**Not a pi extension** — a standalone stdio server that exposes pi as an [Agent Client Protocol v2](https://agentclientprotocol.com/) agent. It lets ACP v2-compatible clients (IDEs, editors) drive pi: `newSession` / `prompt` / `cancel` / `resume` / `close`, plus vendor extensions for fork/rewind and ask-user.

Run it via the npm bin (it reads NDJSON from stdin, writes one JSON message per line to stdout):

```bash
npx pi-acp-v2
# or, from the repo:
npx tsx extensions/pi-acp-v2/server.ts
```

Set `PI_ACP_V2_FAKE_MODEL=1` to use a deterministic fake model (no LLM/auth/network) for conformance testing.

## 安装

### Prerequisites

- The pi coding agent (`@earendil-works/pi-coding-agent`) and Node.js.
- `npm install` in this repo to fetch dependencies (used by both the extensions and the `pi-acp-v2` bin).

### Install the extensions

Each extension is a directory under `extensions/`. Install the ones you want either by symlinking into pi's extensions dir (development) or by listing paths in `settings.json`.

**Via symlink (development):**

```bash
ln -s /path/to/pi-atlas/extensions/task        ~/.pi/agent/extensions/task
ln -s /path/to/pi-atlas/extensions/askuser     ~/.pi/agent/extensions/askuser
ln -s /path/to/pi-atlas/extensions/target      ~/.pi/agent/extensions/target
ln -s /path/to/pi-atlas/extensions/bash-timeout ~/.pi/agent/extensions/bash-timeout
ln -s /path/to/pi-atlas/extensions/websearch    ~/.pi/agent/extensions/websearch
ln -s /path/to/pi-atlas/extensions/guard        ~/.pi/agent/extensions/guard
```

**Via `settings.json`:**

```json
{
  "extensions": [
    "/path/to/pi-atlas/extensions/task",
    "/path/to/pi-atlas/extensions/askuser",
    "/path/to/pi-atlas/extensions/target",
    "/path/to/pi-atlas/extensions/bash-timeout",
    "/path/to/pi-atlas/extensions/websearch",
    "/path/to/pi-atlas/extensions/guard"
  ]
}
```

> `guard` imports the `task` and `target` managers/guards, so install all three together.

### Configure

**WebSearch — macaron provider.** Add the `macaron` provider (apiKey + baseUrl) to `~/.pi/agent/models.json`. WebSearch resolves credentials from this registry at call time; no change to the extension is needed.

**Feishu notifications (guard).** Create `~/.pi/atlas/notify.json` with your webhook (see the Guard section above). Without it, notifications are silently disabled.

**ask_user timeout.** `~/.pi/atlas/sessions/<sessionId>/askuser/config.json` is created at `session_start` with `{"timeout": 0}` (0 = wait indefinitely). While `goal`/auto-continue is active, the timeout is capped at 60s so an unanswered question can't stall the autonomous loop. The file is re-read on every call, so other extensions can overwrite it mid-session.

**Agent nesting depth.** Set `PI_ATLAS_TASK_DEPTH` in the environment. The top-level session defaults to 0; each spawned agent increments by 1. Tasks exceeding `MAX_AGENT_DEPTH` (default 3) are rejected.

### Install pi-acp-v2 (for ACP clients)

`pi-acp-v2` is an npm bin, not a symlinked extension. After `npm install`, point your ACP v2 client at the command:

```jsonc
// example ACP client config (stdio)
{
  "command": "npx",
  "args": ["pi-acp-v2"]
}
```

Or run it directly: `npx tsx extensions/pi-acp-v2/server.ts`.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # run all test suites
```

Tests live in `verify/` and `scripts/` and run directly via `tsx` (no test framework). Project structure mirrors the extension directories under `extensions/`.

## License

MIT
