# How pi-atlas Works — The Event-Driven Coding Loop

> A principle doc. For per-tool/reference detail, see the [README](../README.md). This page explains *why* pi-atlas exists and *how* its extensions compose a self-driving agent loop.

## The problem: agents that stop

Most LLM coding agents do exactly one thing well: answer a single prompt, then hand control back to the human. Every turn ends with the agent idle, waiting for you to type the next instruction.

That model breaks down for infra and SRE work:

- **Incidents don't fit in one turn.** Diagnose → query logs → form hypothesis → apply fix → verify → document. Each step produces evidence the next step needs. You don't want to relay that by hand at 3am.
- **Real commands take minutes, not seconds.** `terraform apply`, `kubectl logs -f`, a full test suite, a model download. A 60-second bash timeout kills the deploy halfway through.
- **Some decisions need a human, most don't.** "Which of these three rollback strategies?" needs you. "Continue gathering evidence" does not. The agent should only interrupt you for the former.
- **You need to walk away.** An overnight remediation run should make progress unattended and ping you when it's done — or when it's genuinely stuck.

pi-atlas turns pi into an agent that keeps going.

## The closed loop

Four extensions compose a single event-driven loop. The agent never "settles" as long as there is work, a running task, or an active goal — unless you explicitly pause it.

```
USER: /goal <text>
  └─ target: primary={active}, autoContinue=true, persist state.json
  └─ if idle: inject kickoff message ──────────────────────▶ AGENT TURN 1

AGENT works (calls tools):
  ├─ bash / create_bash  → long commands run in background, stream live progress
  ├─ create_agent        → delegate exploration/review to a sub-agent (bounded nesting)
  ├─ Target              → add sub-goals, mark progress, complete/fail the primary
  └─ ask_user            → needs a human decision
       └─ guard: fire Feishu card (🔔 "needs input") with "open session" button
       └─ ask_user BLOCKS the turn until answered
            (while goal active: 60s timeout cap so an overnight run never deadlocks)

AGENT finishes turn ──▶ pi emits agent_settled ──▶ guard coordinator picks next move:

  1. aborted (Esc)?        → disable auto-continue + notice (custom message, no new turn) → LOOP PAUSES, control → user
  2. background tasks ran? → followUp "await/cancel your tasks"   → AGENT CONTINUES
  3. goal active?          → followUp with target + ✓/✗ checklist + completion audit
                                                                  → AGENT CONTINUES
  4. otherwise (truly idle)→ fire Feishu card (✅ "session ended") → LOOP ENDS

When the goal is genuinely met:
  Target(update, id=0, status="completed")
    └─ autoContinue=false → next agent_settled hits branch 4 → session-end notify → done
```

The loop is **event-driven**: it has no timer, no polling thread, no daemon. It advances purely on pi's lifecycle events — `tool_call`, `turn_end`, `agent_settled` — and on a goal state file on disk. Nothing runs unless the agent is running; nothing keeps running just to stay alive.

## The four roles

| Extension | Role in the loop |
|-----------|------------------|
| **task** | Async execution. `create_bash` / `create_agent` return immediately; `await_task` blocks the *agent* (not a human) and streams live progress. Long commands no longer time out. |
| **askuser** | The human-in-the-loop gate. `ask_user` blocks the turn and, via `guard`, pings Feishu. While a goal is active, unanswered questions time out at 60s so an unattended run can't deadlock on a missing answer. |
| **target** | The objective + progress ledger. `/goal <text>` locks a primary target and switches on auto-continue. The `Target` tool tracks sub-goals as a checklist. State is write-through to disk, so the goal survives compaction and restart. |
| **guard** | The coordinator. On every `agent_settled` it picks the next move in strict priority (abort → running tasks → goal continuation → idle). Owns the two Feishu notification triggers. |

`guard` imports the `task` and `target` managers, so install all three together. `bash-timeout`, `compact`, and `websearch` are independent enhancers (sane bash timeouts, goal-aware compaction summaries, server-side search).

## Why event-driven (and not a scheduler)

Two properties make the loop robust for long, unattended runs:

**1. Continuations are plain user messages, not system-prompt edits.**
Both guards inject their next-step message via `pi.sendUserMessage(text, { deliverAs: "followUp" })`. This appends a new user message at the conversation tail. The system prompt is never touched, so the provider's **prefix cache stays valid** across the entire multi-hour run. The Escape path never starts a new turn — it appends a display-only custom message (`sendMessage`, `triggerTurn: false`) so aborting truly hands control back to the user. The loop is cheap to keep alive.

**2. No background threads started speculatively.**
The only long-lived resources are the user's own background tasks (`create_bash` / `create_agent`) and the OS processes they spawn. Extensions defer all resource startup to `session_start` or the tool/event that needs them, and tear down in `session_shutdown`. There is no heartbeat, no watcher loop, no timer that could leak or wedge.

## Why it fits infra / SRE

Concrete design points that map to operational reality:

- **Async-by-default execution** — builds, tests, deploys, `kubectl logs -f`, `terraform apply` run as background tasks with live tailing and process-tree teardown (`cancel_task`: SIGTERM → 5s → SIGKILL). No more truncated deploys.
- **Sane bash timeouts** — `bash-timeout` gives search commands (`find`/`grep`/`rg`/`fd`/…) 20s and everything else 120s by default, and rewrites timeout errors to point the agent at `create_bash`. Prevents hung searches over huge log trees — a classic SRE pain.
- **Unattended + notified** — `guard` fires a Feishu card at exactly two moments: when the agent needs a human decision (`ask_user`), and when the session truly ends (no work, no tasks, goal not active). Each card carries the working dir and an "open session" button back to pi-web. Fire-and-forget, never breaks the run.
- **Goal-driven autonomy** — set `/goal "diagnose prod incident → apply fix → verify"`, walk away. The agent loops, sub-divides into a checklist, and only returns control on completion, failure, or a real decision point. Escape gracefully pauses and tells you how to resume (`/goal on`).
- **Anti-amnesia across compaction** — `compact` reads `target/state.json` and re-injects the primary goal + checklist into the compaction summary, so a multi-hour incident response doesn't lose its objective when context is compacted.
- **Bounded delegation** — `create_agent` spawns sub-agents (`explorer`, `code-reviewer`, `general`) with `PI_ATLAS_TASK_DEPTH` incrementing per level, capped at `MAX_AGENT_DEPTH=3`. Sub-agents are excluded from Feishu notifications and use isolated session dirs so they don't pollute your `/resume` picker. Cost control via `model_tier` (`fast` for scouting, `quality` for decisions).
- **Per-session isolation & durability** — all runtime state lives under `~/.pi/atlas/sessions/<sessionId>/` (`task/`, `target/`, `askuser/`), survives restart, and marks in-flight tasks as `orphaned` on restore rather than assuming they're still alive.

## State & data flow at a glance

- **Goal state** — `~/.pi/atlas/sessions/<sid>/target/state.json`, write-through on every mutation; `TargetManager` is a `globalThis`-pinned singleton (pi's jiti loader re-evaluates modules on cross-extension import; pinning guarantees `guard`, `target`, and `task` share one instance).
- **Task state** — `~/.pi/atlas/sessions/<sid>/task/tasks.json` + full output at `task/output-<id>.log` (atomic writes, per-session write lock, short symlink to save tokens in tool output).
- **ask_user config** — `~/.pi/atlas/sessions/<sid>/askuser/config.json`, re-read on every call so other extensions can override mid-session.
- **Feishu config** — global `~/.pi/atlas/notify.json`, re-read on every notification (edits take effect without restart). Missing / `enabled:false` / empty webhook → silent no-op. No secrets in source.
- **Event bus** — pi lifecycle events (`session_start`, `tool_call`, `turn_result`, `turn_end`, `agent_settled`, `session_before_compact`, `session_shutdown`) + a custom channel `pi-atlas:target_changed` consumed by the ACP bridge.

## Composition note for package consumers

`guard` imports the `task` and `target` managers/guards, so the three are bundled together in `@pi-atlas/base` (version-skew is impossible). Each package's `pi` manifest loads its own extension entry points (`extensions/*/index.ts`): `pi install npm:@pi-atlas/base` gets the core five (task, target, guard, bash-timeout, compact), `@pi-atlas/ask` adds ask_user, `@pi-atlas/extend` adds WebSearch, and the meta package `pi-atlas` loads everything via `packages/*/extensions/*/index.ts`. `packages/shared/` is a helper module (not an entry): it holds the storage path helpers plus the target-state read model, so the ask package reads goal-auto state (timeout cap) without importing target code. `extensions/pi-acp-v2/` (repo root) is a standalone stdio bin, not an extension entry.
