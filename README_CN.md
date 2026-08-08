# pi-atlas

> English: [README.md](README.md)

[pi](https://github.com/earendil-works/pi-mono) 编码 Agent 的事件驱动扩展集合 —— 异步 bash 与子代理任务、目标驱动的自动续跑，以及面向无人值守 infra/SRE 场景的飞书通知。

## 为什么是 pi-atlas

LLM 编码 Agent 在一轮结束时就会停下。对于 infra 工作——凌晨排查事故、跑一次长部署、等 `terraform apply` 结束——这是错的模型。你要的是 Agent 自己继续推进、卡住时自动绕回、只在真正需要人时才在飞书提醒你。

pi-atlas 把 pi 变成这样的 Agent。四个扩展组成一个自驱动闭环：

- **定目标，放手不管。** `/goal <文本>` 锁定一个目标并开启自动续跑。Agent 跨任意多轮朝它推进，并拆成可跟踪的待办清单。会话只有目标被标记 `completed`/`failed`（或你主动中断）后才会真正结束。
- **默认异步。** 长命令（构建、测试、部署、`kubectl logs -f`）作为后台 `bash` 任务运行，立即返回并流式输出末尾内容 + 退出码——不再被 60 秒超时打断半截部署。
- **委托而非臃肿。** `create_agent` 派生子代理（`explorer`、`code-reviewer`、`general`）在隔离会话中并行运行，回传压缩摘要，让主上下文保持精简。嵌套深度有界（`PI_ATLAS_TASK_DEPTH`，上限 3），不会失控。
- **只在关键处提问。** 当 Agent 需要决策时，`ask_user` 阻塞当前轮并触发一张带「打开会话」按钮的飞书卡片。goal 模式（`/goal` 或 Agent 设置主目标）下 Agent 会一直等待你的回答；goal-auto 模式（`/goal-auto`）下未回答的问题会在 60 秒后超时，避免夜间运行卡死。
- **循环，而不是停摆。** 每次 `agent_settled`，guard 协调器按严格优先级决定下一步——被中断 → 暂停并把控制权交还用户；仍有后台任务 → 提示 Agent 去等待它们；目标激活 → 注入带完成审计的续跑消息。只有真的无事可做时，才通知「会话结束」并真正空闲。

整个闭环是事件驱动的：它挂在 pi 的生命周期事件（`tool_call`、`turn_end`、`agent_settled`）上，以普通 follow-up 用户消息形式注入续跑——绝不触碰 system prompt，所以供应商的前缀缓存在整段长任务中保持有效。

→ 完整架构与事件流：[docs/principles.md](docs/principles.md)

> 想用浏览器？[pi-web](https://github.com/Menghuan1918/pi-web) 是 pi Web UI 的 fork，专门为 pi-atlas 做了两处适配——修复了 Next.js 下子代理进程 spawn 的问题，并把 `ask_user` 提问内联渲染在聊天里。

## 扩展一览

pi-atlas 是一组相互独立的 pi 扩展。每个扩展是 `extensions/` 下的独立目录，可单独安装。它们共享同一个运行时数据根目录 `~/.pi/atlas/`（可用 `PI_ATLAS_DIR` 覆盖），按会话隔离在 `~/.pi/atlas/sessions/<sessionId>/` 下。

| 扩展 | 类型 | 作用 |
|------|------|------|
| `task` | 工具 + 守卫 | 后台 bash/agent 任务系统（7 个工具） |
| `askuser` | 工具 | 向用户提问并阻塞等待回答 |
| `target` | 工具 + 命令 | 目标/待办管理 + `/goal` 自动续跑 |
| `bash-timeout` | 被动 | 为内置 `bash` 工具注入默认超时 |
| `compact` | 被动 | 更高质量的会话压缩（替换默认摘要） |
| `websearch` | 工具 | 经 Anthropic 兼容供应商做服务端网页搜索 |
| `guard` | 被动 | 协调 `agent_settled` + 飞书通知 |
| `pi-acp-v2` | 独立服务 | 把 pi 暴露为 stdio 上的 ACP v2 agent（开发桥接，非 pi 扩展） |

### Task (`extensions/task/`)

后台任务系统，统一管理 bash 和 agent 执行。提供 7 个工具：

| 工具 | 说明 |
|------|------|
| `CreateBash` | 后台执行 shell 命令，立即返回任务 ID。 |
| `CreateAgent` | 后台启动 pi 子进程执行 agent 任务，立即返回任务 ID。内置角色：`explorer`、`code-reviewer`、`general`（自定义行为用 `general`）。 |
| `AwaitTask` | 阻塞等待指定任务完成。默认超时 3600 秒；超时不会取消任务。等待期间实时流式显示状态：每个运行中的任务会附带 bash 输出尾部（或子代理的最后一个动作）。 |
| `CancelTask` | 终止运行中的任务进程树（SIGTERM → 5秒 → SIGKILL）。 |
| `ResumeTask` | 续跑已完成的 agent 任务（启动新子进程）。bash 任务不可续跑。 |
| `ListTask` | 列出当前会话的所有任务（运行中和已完成）。 |
| `WatchTask` | 查看任务的当前输出和状态。 |

核心特性：
- **Agent 预设角色** — 三个内置角色（`explorer`、`code-reviewer`、`general`）；角色列表注入到 CreateAgent 工具描述。
- **提示词包裹** — agent 的 `prefix`/`suffix` 包裹 task prompt：`prefix + "\n\n" + prompt + "\n\n" + suffix`。
- **会话级隔离** — 任务按会话隔离，持久化到 `~/.pi/atlas/sessions/<sessionId>/task/`。
- **输出截断** — 尾部保留 50KB / 2000 行；超限时完整输出保存到文件。
- **agent_settled 守卫** — 有活跃任务时阻止 agent 结束当前回合。
- **嵌套深度控制** — 通过 `PI_ATLAS_TASK_DEPTH` 环境变量限制嵌套 agent 任务（默认最大 3 层）。
- **用量追踪** — agent 任务自动累积 token/cost 统计。

### AskUser (`extensions/askuser/`)

单个工具，向用户提问并阻塞等待回答：

| 工具 | 说明 |
|------|------|
| `AskUser` | 提出一个或多个问题（select / input），支持批量提问。 |

核心特性：
- **select** — 单选，附带"Other (自由输入)"选项供自定义答案。TUI 模式下选择 "Other" 直接进入内联编辑（无需额外对话框）。
- **input** — 自由文本输入。TUI 模式下直接输入即开始内联编辑。
- **TUI 导航** — 交互模式下所有问题显示在同一屏。← → 切换问题，↑↓ 导航选项，Enter 确认。
- **会话级超时** — 通过 per-session 配置文件 `~/.pi/atlas/sessions/<sessionId>/askuser/config.json` 设置（`{"timeout": 0}`，0 = 无限等待）。每次调用时重新读取，其他扩展可随时覆盖写入以动态调整超时。
- **非交互降级** — print/json 模式下返回错误提示。

### Target (`extensions/target/`)

统一的目标与待办管理，同时驱动自动续跑。

| 工具 | 说明 |
|------|------|
| `Target` | 管理目标：`set` 设主目标、`add` 加次目标、`update` 更新状态、`update_targets` 全量覆盖、`list` 列出。 |

**target** 分为 `primary`（id 0，驱动自动续跑）和 `secondary`（id 1+，用于进度追踪）。状态按会话持久化到 `~/.pi/atlas/sessions/<sessionId>/target/state.json`。

`/goal` 与 `/goal-auto` 命令（仅用户触发）设置主目标并切换自动续跑：

| 用法 | 效果 |
|------|------|
| `/goal <text>` | 设置主目标 + 激活自动续跑（**goal 模式**：ask_user 无限等待，不设超时）+ 空闲时立即发送目标文本 |
| `/goal-auto <text>` | 同上，但为 **goal-auto 模式**：ask_user 超时封顶 60 秒，无人应答不卡自主循环 |
| `/goal on` / `/goal-auto on` | 为现有主目标重新激活自动续跑（模式按命令名）+ 空闲时立即恢复 |
| `/goal off` / `/goal-auto off` | 关闭自动续跑（主目标保留） |
| `/goal` / `/goal-auto` | 显示当前状态 |

Agent 侧设置主目标（`set` 或带 text 的 `update_targets`）会自动进入 goal 模式——与 `/goal <text>` 相同：主目标锁定，直到 Agent 将其标记为 `completed` 或 `failed`。

自动续跑激活时，`guard` 扩展在每次 `agent_settled` 重新注入一条带完成审计的续跑消息，直到主目标达到终态。续跑消息明确指示：强烈需要人接入或无法完成时，直接把主目标置为 `failed`——开放的主目标会让会话持续自动续跑。

### Bash 超时 (`extensions/bash-timeout/`)

被动扩展（无工具），通过两个事件处理器为内置 `bash` 工具注入默认超时：

- **`tool_call`** — 未指定超时时注入默认值：
  - **20 秒** 用于搜索命令（`find`、`grep`、`rg`、`ag`、`ack`、`fd`、`locate`）— 通过正则预筛 + `shell-quote` 解析检测。
  - **120 秒** 用于其他命令。
  - 调用方显式指定的超时始终优先。
- **`tool_result`** — 当 bash 因超时退出时，替换错误消息为使用 `CreateBash` 运行长耗时命令的提示。

纯被动拦截 —— 指定了显式超时时零开销。

### WebSearch (`extensions/websearch/`)

单个工具，搜索网页获取当前/实时信息：

| 工具 | 说明 |
|------|------|
| `WebSearch` | 搜索网页（版本号、新闻、近期事件）。返回带来源 URL 的简明答案。 |

工作原理：
- 查询经 **`macaron`** 供应商的 Anthropic 兼容 `/v1/messages` 端点路由，由其执行服务端 `web_search` 工具并返回模型的答案（含来源）。扩展本身只转发查询、收集答案，不含任何搜索逻辑。
- **macaron 凭证**（`apiKey` + `baseUrl`）在调用时从宿主模型注册表解析，源码不含硬编码密钥。需在 `~/.pi/agent/models.json` 配置 `macaron` 供应商。
- **域名过滤** — 可选 `allowed_domains` / `blocked_domains`，作为软约束传入。
- **优雅失败** — 供应商未配置或网络错误时返回 `isError` 结果，不抛异常。

> 服务端 `web_search` 这一约定也被其他 Anthropic 兼容的搜索端点共享（如 DeepSeek 的 `/anthropic` 端点），因此接入更多供应商并不困难。目前仅 `macaron` 已接入并验证。

### Guard (`extensions/guard/`)

被动扩展（无工具），协调 `agent_settled` 事件并发送飞书通知。它依赖 `task` 和 `target` 扩展（导入了它们的管理器/守卫），三者需一起加载。

`agent_settled` 时按优先级依次处理：
1. **Escape / 中断**（最高）— 若上一回合被中断，关闭 target 自动续跑并停止。
2. **后台任务** — 若仍有后台任务在运行，注入任务提醒（跳过 target 守卫）。
3. **Target 自动续跑** — 若激活，注入带完成审计的续跑消息。
4. **否则（真正空闲）** — 发送「会话结束」飞书通知。

调用 `AskUser` 工具时也会发送飞书通知（「等待输入」）。子代理会话（`PI_ATLAS_TASK_DEPTH > 0`）下不通知。

飞书配置为全局（非按会话）的 `~/.pi/atlas/notify.json`：

```json
{
  "enabled": true,
  "webhookUrl": "https://open.feishu.cn/open-apis/bot/v2/hook/<id>",
  "webhookSecret": "<可选，仅当 webhook 启用签名校验时填>",
  "webUrl": "https://your-pi-web.example.com"
}
```

- 文件缺失 / `enabled:false` / `webhookUrl` 为空 → 静默不通知（安全默认，源码不含密钥）。
- `webUrl` 可选 — 决定「打开会话」按钮跳转地址 `${webUrl}/?session=<sessionId>`；未配置时卡片不含该按钮。
- 每次通知时同步重读配置，改完即生效，无需重启。

### pi-acp-v2 (`extensions/pi-acp-v2/`)

**不是 pi 扩展** —— 一个独立的 stdio 服务，把 pi 暴露为 [Agent Client Protocol v2](https://agentclientprotocol.com/) agent。它让 ACP v2 兼容客户端（IDE、编辑器）驱动 pi：`newSession` / `prompt` / `cancel` / `resume` / `close`，以及 fork/rewind、ask-user 等扩展方法。

从源码运行（从 stdin 读 NDJSON，每行一条 JSON 消息写到 stdout）。`pi-acp-v2` **不在** npm 包内——克隆仓库后用 tsx 运行：

```bash
git clone https://github.com/Menghuan1918/pi-atlas.git
cd pi-atlas && npm install
npx tsx extensions/pi-acp-v2/server.ts
```

设置 `PI_ACP_V2_FAKE_MODEL=1` 可使用确定性假模型（无 LLM/鉴权/网络），用于一致性测试。

## 安装

### 前置条件

- pi 编码 Agent（`@earendil-works/pi-coding-agent`）和 Node.js。
- 在本仓库执行 `npm install` 拉取依赖（扩展和 `pi-acp-v2` bin 都需要）。

### 安装扩展

每个扩展是 `extensions/` 下的一个目录。推荐方式是安装已发布的 npm 包，让 pi 通过 `pi` 清单一次性加载全部扩展：

**通过 npm（推荐）：**

```bash
pi install npm:pi-atlas
# 或不安装直接试用：
pi -e npm:pi-atlas
```

开发模式下，可把单个扩展目录软链到 pi 的扩展目录，或在 `settings.json` 中列出路径：

**通过软链接（开发模式）：**

```bash
ln -s /path/to/pi-atlas/extensions/task         ~/.pi/agent/extensions/task
ln -s /path/to/pi-atlas/extensions/askuser      ~/.pi/agent/extensions/askuser
ln -s /path/to/pi-atlas/extensions/target       ~/.pi/agent/extensions/target
ln -s /path/to/pi-atlas/extensions/bash-timeout  ~/.pi/agent/extensions/bash-timeout
ln -s /path/to/pi-atlas/extensions/compact       ~/.pi/agent/extensions/compact
ln -s /path/to/pi-atlas/extensions/websearch     ~/.pi/agent/extensions/websearch
ln -s /path/to/pi-atlas/extensions/guard         ~/.pi/agent/extensions/guard
```

**通过 `settings.json`：**

```json
{
  "extensions": [
    "/path/to/pi-atlas/extensions/task",
    "/path/to/pi-atlas/extensions/askuser",
    "/path/to/pi-atlas/extensions/target",
    "/path/to/pi-atlas/extensions/bash-timeout",
    "/path/to/pi-atlas/extensions/compact",
    "/path/to/pi-atlas/extensions/websearch",
    "/path/to/pi-atlas/extensions/guard"
  ]
}
```

> `guard` 导入了 `task` 和 `target` 的管理器/守卫，三者需一起安装。

### 配置

**WebSearch —— macaron 供应商。** 在 `~/.pi/agent/models.json` 中配置 `macaron` 供应商（apiKey + baseUrl）。WebSearch 在调用时从该注册表解析凭证，扩展本身无需改动。

**飞书通知（guard）。** 创建 `~/.pi/atlas/notify.json` 填入 webhook（见上文 Guard 小节）。未配置时静默关闭通知。

**AskUser 超时。** `~/.pi/atlas/sessions/<sessionId>/askuser/config.json` 在 `session_start` 时创建，默认 `{"timeout": 0}`（0 = 无限等待）。goal 模式（`/goal` 或 Agent 设置主目标）按配置原值执行，**不设超时**；只有 goal-auto 模式（`/goal-auto`）把超时封顶 60 秒，避免无人应答卡住自主循环。每次调用重新读取，其他扩展可随时覆盖写入。

**Agent 嵌套深度。** 设置环境变量 `PI_ATLAS_TASK_DEPTH`。顶层会话默认 0，每层 agent 子进程递增 1。超过 `MAX_AGENT_DEPTH`（默认 3）的任务会被拒绝。

### 安装 pi-acp-v2（供 ACP 客户端）

`pi-acp-v2` 是独立的 stdio 服务，**不在** npm 包内。克隆仓库、安装依赖后，让 ACP v2 客户端指向 tsx 入口（在仓库根目录运行）：

```jsonc
// ACP 客户端配置示例（stdio）— cwd = 克隆的仓库根目录
{
  "command": "npx",
  "args": ["tsx", "extensions/pi-acp-v2/server.ts"]
}
```

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # 运行全部测试套件
```

测试在 `verify/` 和 `scripts/` 下，用 `tsx` 直接运行（无测试框架）。项目结构对应 `extensions/` 下的扩展目录。

## 许可证

MIT
