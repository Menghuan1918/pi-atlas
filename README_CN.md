# pi-atlas

[pi](https://github.com/earendil-works/pi-mono) 编码 Agent 的异步任务管理和用户交互扩展。

## 扩展

### Task 扩展 (`extensions/task/`)

后台任务系统，统一管理 bash 和 agent 执行。提供 7 个工具：

| 工具 | 说明 |
|------|------|
| `CreateBash` | 后台执行 shell 命令，立即返回任务 ID。 |
| `CreateAgent` | 后台启动 pi 子进程执行 agent 任务，立即返回任务 ID。 |
| `AwaitTask` | 阻塞等待指定任务完成。默认超时 3600 秒；超时不会取消任务。 |
| `CancelTask` | 终止运行中的任务进程树（SIGTERM → 5秒 → SIGKILL）。 |
| `ResumeTask` | 续跑已完成的 agent 任务（启动新子进程）。bash 任务不可续跑。 |
| `ListTask` | 列出当前会话的所有任务（运行中和已完成）。 |
| `WatchTask` | 查看任务的当前输出和状态。 |

**核心特性：**
- **会话级隔离** — 任务按会话隔离，持久化到 `~/.pi/tasks/<sessionId>/`。
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
- **select** — 单选，附带"Other (自由输入)"选项供自定义答案。
- **confirm** — 是/否确认。
- **input** — 自由文本输入。
- **会话级超时** — 通过 `~/.pi/agent/askuser-config.json` 配置（`{"timeout": 0}`，0 = 无限等待）。
- **非交互降级** — print/json 模式下返回错误提示。

## 安装

### 通过软链接（开发模式）

```bash
ln -s /path/to/pi-atlas/extensions/task ~/.pi/agent/extensions/task
ln -s /path/to/pi-atlas/extensions/askuser ~/.pi/agent/extensions/askuser
```

### 通过 settings.json

```json
{
  "extensions": [
    "/path/to/pi-atlas/extensions/task",
    "/path/to/pi-atlas/extensions/askuser"
  ]
}
```

## 配置

### AskUser 超时

创建 `~/.pi/agent/askuser-config.json`：

```json
{
  "timeout": 0
}
```

- `0` — 无限等待（默认）。
- `>0` — 超时秒数。超时后：confirm → `false`，select → `default` 或 `(no answer / timed out)`，input → `default` 或 `(no answer / timed out)`。

项目级配置 `<cwd>/.pi/askuser-config.json` 覆盖全局配置。

### Agent 嵌套深度

设置环境变量 `PI_ATLAS_TASK_DEPTH`。顶层会话默认为 0，每层 agent 子进程递增 1。超过 `MAX_AGENT_DEPTH`（默认 3）的任务会被拒绝创建。

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # 运行全部测试
```

### 项目结构

```
extensions/
├── task/
│   ├── index.ts              # 扩展入口 — 注册工具 + 事件
│   ├── types.ts              # Task / TaskUsage / TaskResult 类型
│   ├── task-manager.ts       # 生命周期、状态机、会话隔离
│   ├── persistence.ts        # ~/.pi/tasks/<sessionId>/ 持久化
│   ├── output-accumulator.ts # 有界内存输出追踪 + 临时文件溢出
│   ├── bash-task.ts          # CreateBash 工具
│   ├── agent-task.ts         # CreateAgent + ResumeTask 工具
│   ├── control.ts            # AwaitTask / CancelTask / ListTask / WatchTask
│   └── guard.ts              # agent_settled 守卫
└── askuser/
    ├── index.ts              # 扩展入口 — 注册 ask_user 工具
    └── config.ts             # 会话级超时配置读取
```

## 许可证

MIT
