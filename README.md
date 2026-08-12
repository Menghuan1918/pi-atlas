# pi-atlas

> 中文文档：[README_CN.md](README_CN.md)

Event-driven coding extensions for the [pi](https://github.com/earendil-works/pi-mono) agent — async bash & sub-agent tasks, goal-driven auto-continue, and Feishu notifications for unattended infra/SRE runs.

## Why pi-atlas

LLM coding agents stop the moment a turn ends. For infra work — diagnosing an incident at 3am, running a long deploy, waiting on `terraform apply` — that's the wrong model. You want the agent to keep going, loop back when it stalls, and ping you on Feishu only when it actually needs a human.

pi-atlas turns pi into that kind of agent. Four extensions compose a self-driving loop:

- **Set a goal, walk away.** `/goal <text>` locks an objective and switches on auto-continue. The agent works toward it across as many turns as needed, breaking it into a trackable checklist. The session only truly ends once the goal is `completed` or `failed` (or you interrupt).
- **Async by default.** Long commands (builds, tests, deploys, `kubectl logs -f`) run as background `bash` tasks that return instantly and stream live tail + exit status — no more 60s timeouts killing your deploy mid-flight.
- **Delegate, don't bloat.** `create_agent` spawns sub-agents (`explorer`, `code-reviewer`, `general`) in isolated sessions that run in parallel, report back a compressed summary, and keep the main context lean. Nesting is bounded (`PI_ATLAS_TASK_DEPTH`, max 3) so it never runs away.
- **Ask only when it matters.** When the agent needs a decision, `ask_user` blocks the turn and fires a Feishu card with an "open session" button. In goal mode (`/goal` or agent-set target) the agent waits as long as needed for your answer; in goal-auto mode (`/goal-auto`) unanswered questions time out at 60s so an overnight run never deadlocks.
- **Loop, don't settle.** On every `agent_settled`, a guard coordinator picks the next move in strict priority — aborted → pause and hand back control; background tasks still running → nudge the agent to await them; goal active → inject a continuation with a completion audit. Only when nothing is left does it notify "session ended" and truly idle.

The whole loop is event-driven: it rides on pi's lifecycle events (`tool_call`, `turn_end`, `agent_settled`) and injects continuations as plain follow-up user messages — never touching the system prompt, so provider prefix caching stays intact across the long run.

→ Full architecture and event flow: [docs/principles.md](docs/principles.md)

> Prefer a browser? [pi-web](https://github.com/Menghuan1918/pi-web) is a fork of pi's web UI with two special adaptations for pi-atlas — it fixes sub-agent process spawning under Next.js and renders `ask_user` questions inline in the chat.

## Extensions at a glance

pi-atlas is a collection of independent pi extensions, split into npm packages so you can install only what you need. All packages share one version number (published together). Each extension is a self-contained directory under `extensions/` inside its package. They share a single runtime data root at `~/.pi/atlas/` (overridable via `PI_ATLAS_DIR`), scoped per session under `~/.pi/atlas/sessions/<sessionId>/`.

| Package | Extension | Type | What it does |
|---------|-----------|------|--------------|
| `@pi-atlas/base` (default) | `task` | tools + guard | Background bash/agent task system (7 tools) |
| `@pi-atlas/base` (default) | `target` | tool + command | Goal/todo management + `/goal` auto-continue |
| `@pi-atlas/base` (default) | `bash-timeout` | passive | Default timeouts for the built-in `bash` tool |
| `@pi-atlas/base` (default) | `compact` | passive | Higher-quality session compaction (replaces default summarization) |
| `@pi-atlas/base` (default) | `guard` | passive | Coordinates `agent_settled` + Feishu notifications |
| `@pi-atlas/ask` | `askuser` | tool | Ask the user questions and block for answers |
| `@pi-atlas/extend` | `websearch` | tool | Server-side web search via an Anthropic-compatible provider |
| `pi-atlas` (meta) | all of the above | – | Everything in one package |

### Task (`@pi-atlas/base` → `extensions/task/`)

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

### ask_user (`@pi-atlas/ask` → `extensions/askuser/`)

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

### Target (`@pi-atlas/base` → `extensions/target/`)

Unified goal and todo management that also drives auto-continue.

| Tool | Description |
|------|-------------|
| `Target` | Manage targets: `set` primary, `add` secondary, `update` status, `update_targets` (overwrite all), `list`. |

A **target** is either `primary` (id 0, drives auto-continue) or `secondary` (id 1+, for progress tracking). State persists per session to `~/.pi/atlas/sessions/<sessionId>/target/state.json`.

The `/goal` and `/goal-auto` commands (user-only) set the primary target and toggle auto-continue:

| Usage | Effect |
|-------|--------|
| `/goal <text>` | Set the primary target + activate auto-continue (**goal mode** — ask_user waits without timeout) + send the goal immediately if idle |
| `/goal-auto <text>` | Same, but **goal-auto mode** — ask_user is capped at 60s so an unanswered question can't stall the autonomous loop |
| `/goal on` / `/goal-auto on` | Re-activate auto-continue for the existing primary (mode per command) + resume immediately if idle |
| `/goal off` / `/goal-auto off` | Turn off auto-continue (primary target retained) |
| `/goal` / `/goal-auto` | Show current status |

Setting the primary target from the agent side (`set` or `update_targets` with text) automatically enters goal mode — the same as `/goal <text>`: the primary is locked until the agent marks it `completed` or `failed`.

When auto-continue is active, the `guard` extension re-injects a completion-audit message on each `agent_settled` until the primary target reaches a terminal state. The continuation explicitly instructs the agent to fail the target directly when it strongly needs human input or cannot complete it — an open primary keeps the session auto-resuming.

### Bash Timeout (`@pi-atlas/base` → `extensions/bash-timeout/`)

Passive extension (no tools) that injects default timeouts for the built-in `bash` tool via two event handlers:

- **`tool_call`** — when no timeout is specified, injects a default:
  - **20 s** for search commands (`find`, `grep`, `rg`, `ag`, `ack`, `fd`, `locate`) — detected via regex pre-filter + `shell-quote` parsing.
  - **120 s** for everything else.
  - Explicit timeouts from the caller are always respected.
- **`tool_result`** — when bash exits due to timeout, replaces the error message with a hint to use `create_bash` for long-running commands.

Purely passive interception — zero overhead when an explicit timeout is provided.

### Compact (`@pi-atlas/base` → `extensions/compact/`)

Passive extension (no tools, no commands) that replaces pi's default session compaction with a higher-quality summarizer. It hooks the `session_before_compact` event and returns a **handoff document** (modeled on the `productivity/handoff` skill) built with the session's active model.

How it works:
- On `session_before_compact`, it consumes pi's pre-computed `CompactionPreparation` (cut point, `messagesToSummarize`, `previousSummary`, `fileOps`) and produces a handoff-style Markdown document — **Live Thread / Key Decisions & Constraints / Progress / References / Active Files / Critical Context / Next Steps / Suggested Skills** — via the session's active model, then returns `{ compaction: CompactionResult }`. pi persists it and rebuilds context; no cut logic is reinvented.
- **Real-history summarization (codex-style)** — sends the **actual conversation messages** (`convertToLlm(messagesToSummarize + turnPrefix)`) as structured history plus a trailing "produce the handoff" instruction, via pi-ai `stream(...).result()` (works for all model APIs). This avoids the single giant serialized text-content block that triggered pi-ai SDK body-drops (→ empty → NA); verified reliable on a ~400k-token input. No output-token cap (effectiveness first).
- **Anti-continuation / anti-tool-call** — the summarization call passes **no tools**, so the model can't call tools or continue the conversation; it only emits the document. Extraction takes only `text` content blocks.
- **Quality levers** — handoff principles: resumable core (drop noise), **references-not-copies** (point to specs/plans/ADRs/issues/commits/diffs by path/URL, don't duplicate), live thread, suggested skills; preserves user directives, file paths, commands, and error strings verbatim; updates the prior summary incrementally (`previousSummary`) rather than rewriting from scratch. No secret redaction (by design).
- **Target system integration** — reads the session's `target/state.json` and injects the primary goal + target checklist (with statuses) so the summary carries goal/progress across compaction and auto-continue stays aligned. Read-only and best-effort: a missing or corrupt state file is skipped and never breaks compaction.
- **Robust fallback** — a degenerate/empty summary (e.g. the model returns the empty template on a very large input) is detected and retried with the most-recent half of the history (message-boundary progressive capping, up to 4 attempts); if still degenerate the handler returns `undefined` so pi runs its own default compaction — never persisting a useless summary (no data loss). Missing model, unresolved auth, or a thrown call likewise fall back. This extension can never break compaction.
- Persists `{ readFiles, modifiedFiles }` in `CompactionEntry.details` so pi's cumulative file tracking survives across compactions.

No configuration, no extra storage, no commands.

### WebSearch (`@pi-atlas/extend` → `extensions/websearch/`)

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

### Guard (`@pi-atlas/base` → `extensions/guard/`)

Passive extension (no tools) that coordinates the `agent_settled` event and sends Feishu notifications. It depends on the `task` and `target` extensions (it imports their managers/guards), so load all three together.

On `agent_settled`, guards run in priority order:
1. **Escape / aborted** (highest) — if the last assistant turn was aborted, disable target auto-continue and stop. The "stopped" notice is appended as a custom message without triggering a new turn, so the agent stays fully idle (abort = human taking over).
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

Run it from source (it reads NDJSON from stdin, writes one JSON message per line to stdout). `pi-acp-v2` is **not** included in the npm package — clone the repo and run it with tsx:

```bash
git clone https://github.com/Menghuan1918/pi-atlas.git
cd pi-atlas && npm install
npx tsx extensions/pi-acp-v2/server.ts
```

Set `PI_ACP_V2_FAKE_MODEL=1` to use a deterministic fake model (no LLM/auth/network) for conformance testing.

## 安装

### Prerequisites

- The pi coding agent (`@earendil-works/pi-coding-agent`) and Node.js.
- `npm install` in this repo to fetch dependencies (used by both the extensions and the `pi-acp-v2` bin).

### Install the extensions (npm packages)

pi-atlas is split into npm packages — install only what you need, or everything at once via the meta package. The recommended way is `pi install` (writes to `~/.pi/agent/settings.json`):

```bash
pi install npm:@pi-atlas/base        # recommended default: task+target+guard+bash-timeout+compact
pi install npm:@pi-atlas/ask         # + ask_user (user questions)
pi install npm:@pi-atlas/extend      # + WebSearch
# everything at once:
pi install npm:pi-atlas
# or try without installing:
pi -e npm:@pi-atlas/base
```

> `@pi-atlas/base` bundles `task`, `target`, `guard`, `bash-timeout`, and `compact`. `guard` imports the `task` and `target` managers/guards, so keeping them in one package avoids version-skew. `askuser` and `websearch` are independent and read target state (goal-auto timeout cap) through the shared `@pi-atlas/shared` helper package, which npm installs automatically.

For development, symlink individual extension directories or list their paths in `settings.json`:

**Via symlink (development):**

```bash
ln -s /path/to/pi-atlas/packages/base/extensions/task         ~/.pi/agent/extensions/task
ln -s /path/to/pi-atlas/packages/base/extensions/target      ~/.pi/agent/extensions/target
ln -s /path/to/pi-atlas/packages/base/extensions/guard        ~/.pi/agent/extensions/guard
ln -s /path/to/pi-atlas/packages/base/extensions/bash-timeout ~/.pi/agent/extensions/bash-timeout
ln -s /path/to/pi-atlas/packages/base/extensions/compact      ~/.pi/agent/extensions/compact
ln -s /path/to/pi-atlas/packages/ask/extensions/askuser       ~/.pi/agent/extensions/askuser
ln -s /path/to/pi-atlas/packages/extend/extensions/websearch  ~/.pi/agent/extensions/websearch
```

**Via `settings.json`:**

```json
{
  "extensions": [
    "/path/to/pi-atlas/packages/base/extensions/task",
    "/path/to/pi-atlas/packages/base/extensions/target",
    "/path/to/pi-atlas/packages/base/extensions/guard",
    "/path/to/pi-atlas/packages/base/extensions/bash-timeout",
    "/path/to/pi-atlas/packages/base/extensions/compact",
    "/path/to/pi-atlas/packages/ask/extensions/askuser",
    "/path/to/pi-atlas/packages/extend/extensions/websearch"
  ]
}
```

> `guard` imports the `task` and `target` managers/guards, so install all three together (they live in `@pi-atlas/base`).

### Configure

**WebSearch — macaron provider.** Add the `macaron` provider (apiKey + baseUrl) to `~/.pi/agent/models.json`. WebSearch resolves credentials from this registry at call time; no change to the extension is needed.

**Feishu notifications (guard).** Create `~/.pi/atlas/notify.json` with your webhook (see the Guard section above). Without it, notifications are silently disabled.

**ask_user timeout.** `~/.pi/atlas/sessions/<sessionId>/askuser/config.json` is created at `session_start` with `{"timeout": 0}` (0 = wait indefinitely). Goal mode (`/goal` or agent-set target) uses the configured value as-is — no cap. Only goal-auto mode (`/goal-auto`) caps the timeout at 60s so an unanswered question can't stall the autonomous loop. The file is re-read on every call, so other extensions can overwrite it mid-session.

**Agent nesting depth.** Set `PI_ATLAS_TASK_DEPTH` in the environment. The top-level session defaults to 0; each spawned agent increments by 1. Tasks exceeding `MAX_AGENT_DEPTH` (default 3) are rejected.

### Install pi-acp-v2 (for ACP clients)

`pi-acp-v2` is a standalone stdio server, **not** included in the npm package. Clone the repo, install deps, and point your ACP v2 client at the tsx entry (run from the repo root):

```jsonc
// example ACP client config (stdio) — cwd = the cloned repo root
{
  "command": "npx",
  "args": ["tsx", "extensions/pi-acp-v2/server.ts"]
}
```

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # run all test suites
```

Tests live in `verify/` and `scripts/` and run directly via `tsx` (no test framework). Project structure mirrors the extension directories under `extensions/`.

## License

MIT
