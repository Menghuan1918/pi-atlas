# pi-atlas

[pi](https://github.com/earendil-works/pi-mono) 编码 Agent 的异步任务管理和用户交互扩展。

## 扩展

### Task 扩展 (`extensions/task/`)

后台任务系统，统一管理 bash 和 agent 执行。提供 7 个工具：

| 工具 | 说明 |
|------|------|
| `CreateBash` | 后台执行 shell 命令，立即返回任务 ID。 |
| `CreateAgent` | 后台启动 pi 子进程执行 agent 任务，立即返回任务 ID。内置角色：`explorer`、`code-reviewer`、`general`。自定义：`.pi/agents/*.md`。 |
| `AwaitTask` | 阻塞等待指定任务完成。默认超时 3600 秒；超时不会取消任务。 |
| `CancelTask` | 终止运行中的任务进程树（SIGTERM → 5秒 → SIGKILL）。 |
| `ResumeTask` | 续跑已完成的 agent 任务（启动新子进程）。bash 任务不可续跑。 |
| `ListTask` | 列出当前会话的所有任务（运行中和已完成）。 |
| `WatchTask` | 查看任务的当前输出和状态。 |

**核心特性：**
- **会话级隔离** — 任务按会话隔离，持久化到 `~/.pi/atlas/sessions/<sessionId>/task/`。
- **Agent 预设角色** — 内置角色（`explorer`、`code-reviewer`、`general`）+ 自定义 `.pi/agents/*.md`。角色列表在 `session_start` 时注入到 CreateAgent 工具描述。
- **提示词包裹** — agent 的 `prefix`/`suffix`（YAML frontmatter）包裹 task prompt：`prefix + "\n\n" + prompt + "\n\n" + suffix`。
- **输出截断** — 尾部保留 50KB / 2000 行；超限时完整输出保存到文件。
- **agent_settled 守卫** — 有活跃任务时阻止 agent 结束当前回合。
- **嵌套深度控制** — 通过 `PI_ATLAS_TASK_DEPTH` 环境变量限制嵌套 agent 任务（默认最大 3 层）。
- **用量追踪** — agent 任务自动累积 token/cost 统计。

### AskUser 扩展 (`extensions/askuser/``

单个工具，向用户提问并阻塞等待回答：

| 工具 | 说明 |
|------|------|
| `ask_user` | 提出一个或多个问题（select / confirm / input），支持批量提问。 |

**核心特性：**
- **select** — 单选，附带"Other (自由输入)"选项供自定义答案。TUI 模式下选择 "Other" 直接进入内联编辑（无需额外对话框）。
- **confirm** — 是/否确认。
- **input** — 自由文本输入。TUI 模式下直接输入即开始内联编辑。
- **TUI 导航** — 交互模式下所有问题显示在同一屏。← → 切换问题，↑↓ 导航选项，Enter 确认。
- **会话级超时** — 通过 per-session 配置文件 `~/.pi/atlas/sessions/<sessionId>/askuser/config.json` 设置（`{"timeout": 0}`，0 = 无限等待）。每次调用时重新读取，其他扩展可随时覆盖写入以动态调整超时。
- **非交互降级** — print/json 模式下返回错误提示。

### Bash 超时扩展 (`extensions/bash-timeout/`)

通过两个事件处理器为内置 `bash` 工具注入默认超时：

- **`tool_call`** — 未指定超时时注入默认值：
  - **20 秒** 用于搜索命令（`find`、`grep`、`rg`、`ag`、`ack`、`fd`、`locate`）— 通过正则预筛 + `shell-quote` 解析检测。
  - **120 秒** 用于其他命令。
  - 调用方显式指定的超时始终优先。
- **`tool_result`** — 当 bash 因超时退出时，替换错误消息为使用 `CreateBash` 运行长耗时命令的提示。

无工具、无配置 — 纯被动拦截。指定了显式超时时零开销。

## 安装

### 通过软链接（开发模式）

```bash
ln -s /path/to/pi-atlas/extensions/task ~/.pi/agent/extensions/task
ln -s /path/to/pi-atlas/extensions/askuser ~/.pi/agent/extensions/askuser
ln -s /path/to/pi-atlas/extensions/bash-timeout ~/.pi/agent/extensions/bash-timeout
```

### 通过 settings.json

```json
{
  "extensions": [
    "/path/to/pi-atlas/extensions/task",
    "/path/to/pi-atlas/extensions/askuser",
    "/path/to/pi-atlas/extensions/bash-timeout"
  ]
}
```

## 配置

### AskUser 超时

配置文件在 `session_start` 时自动创建于：

```
~/.pi/atlas/sessions/<sessionId>/askuser/config.json
```

```json
{
  "timeout": 0
}
```

- `0` — 无限等待（默认）。
- `>0` — 超时秒数。超时后：confirm → `false`，select → `default` 或 `(no answer / timed out)`，input → `default` 或 `(no answer / timed out)`。

每次 `ask_user` 调用时重新读取配置文件，其他扩展可随时覆盖写入以动态调整超时。

### Agent 嵌套深度

设置环境变量 `PI_ATLAS_TASK_DEPTH`。顶层会话默认为 0，每层 agent 子进程递增 1。超过 `MAX_AGENT_DEPTH`（默认 3）的任务会被拒绝创建。

### Agent 预设角色

内置角色（始终可用）：

| 角色 | 描述 | 工具 |
|------|------|------|
| `explorer` | 快速代码侦察，返回压缩上下文 | read, grep, find, ls, bash |
| `code-reviewer` | 只读代码审查（需求合规 + 质量标准） | read, grep, bash |
| `general` | 通用，无特殊提示词 | （所有工具） |

自定义角色为 `.md` 文件，放在 `.pi/agents/`（项目）或 `~/.pi/agents/`（用户）：

```yaml
---
description: 总结 agent
model: claude-haiku-4-5
tools: read, grep
prefix: |
  你是一个总结者，保持简洁。
suffix: |
  以列表形式输出。
---
```

- `description`（必填）— 显示在 CreateAgent 工具列表中。
- `prefix` / `suffix`（至少一个必填）— 包裹 task prompt。
- `model`（可选）— 模型覆盖。
- `tools`（可选）— 逗号分隔的工具白名单。

解析优先级：项目 `.pi/agents/`（最近，向上）→ 用户 `~/.pi/agents/` → 内置。

指定不存在的 agent 会报错并列出所有可用角色。

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # 运行全部测试
```

### 项目结构

```
extensions/
├── shared/
│   └── atlas-paths.ts        # 共享路径辅助 (~/.pi/atlas/sessions/<sid>/)
├── task/
│   ├── index.ts              # 扩展入口 — 注册工具 + 事件
│   ├── types.ts              # Task / TaskUsage / TaskResult 类型
│   ├── task-manager.ts       # 生命周期、状态机、会话隔离
│   ├── persistence.ts        # ~/.pi/atlas/sessions/<sid>/task/ 持久化
│   ├── output-accumulator.ts # 有界内存输出追踪 + 临时文件溢出
│   ├── bash-task.ts          # CreateBash 工具
│   ├── agent-task.ts         # CreateAgent + ResumeTask 工具 + 动态描述构建器
│   ├── agents.ts             # Agent 预设角色系统 — 内置角色、发现机制、提示词包裹
│   ├── control.ts            # AwaitTask / CancelTask / ListTask / WatchTask
│   └── guard.ts              # agent_settled 守卫
├── askuser/
│   ├── index.ts              # 扩展入口 — 注册 ask_user 工具
│   ├── config.ts             # Per-session 超时配置读取
│   └── multi-question.ts     # TUI 多问题组件（← → 导航 + 内联编辑）
└── bash-timeout/
    ├── index.ts              # 扩展入口 — tool_call + tool_result 处理
    └── detect.ts            # 搜索命令检测（正则 + shell-quote）
```

## 许可证

MIT
