# pi-atlas

pi coding agent 的 TypeScript 扩展集合（task 异步任务管理 + askuser 用户交互 + target 目标管理 + guard 自动续跑）。

## 架构

```
extensions/
├── shared/
│   └── atlas-paths.ts        # 所有扩展共享的路径辅助
├── task/                     # 后台任务系统（create_bash / create_agent / await_task …）
├── askuser/                  # ask_user 工具（select / input）
├── target/                   # 目标管理（target 工具 + /goal 命令）
└── guard/                    # agent_settled guard 协调器（task + target 优先级）+ 飞书通知
```

每个扩展导出 `default` 工厂函数 `(pi: ExtensionAPI) => void`，通过 `pi.registerTool()` 注册工具、`pi.on(event, handler)` 注册生命周期事件。

## 共享存储位置

所有插件产生的运行时数据统一存储在 `~/.pi/atlas/` 下，按 session 隔离：

```
~/.pi/atlas/
├── notify.json                # 全局飞书通知配置（webhook / webUrl / enabled）
└── sessions/<sessionId>/
    ├── task/
    │   ├── tasks.json            # 任务元数据
    │   └── output-<taskId>.log   # 任务完整输出
    ├── askuser/
    │   └── config.json           # 超时配置 {"timeout": <seconds>}
    └── target/
        └── state.json            # 目标状态 {"sessionId", "state": TargetState}
```

### 路径辅助函数

定义在 `extensions/shared/atlas-paths.ts`，所有扩展通过它获取存储路径：

```ts
import { getAtlasDir, getAtlasSessionDir, getNotifyConfigPath, ENV_ATLAS_DIR } from "../shared/atlas-paths.js";

getAtlasDir()                  // → ~/.pi/atlas/（基目录）
getAtlasSessionDir(sessionId)  // → ~/.pi/atlas/sessions/<sessionId>/
getNotifyConfigPath()          // → ~/.pi/atlas/notify.json（全局飞书通知配置）
```

- 默认基目录是 `~/.pi/atlas/`（与 pi 自身的 `~/.pi/agent/` 平级）。
- 设置环境变量 `PI_ATLAS_DIR` 可覆盖基目录（主要用于测试隔离）。
- 各扩展在自己的 session 目录下创建子目录（如 `task/`、`askuser/`）。

### 新增扩展时的约定

1. 用 `getAtlasSessionDir(sessionId)` 拿到 session 根目录，在其下创建自己的子目录。
2. 不要直接使用 `getAgentDir()`（`~/.pi/agent/`）存放扩展数据——那是 pi 自身的配置目录。
3. 测试时设置 `process.env.PI_ATLAS_DIR = <tmpDir>` 做隔离。

## 测试

```bash
npm run typecheck   # tsc --noEmit
npm test            # 运行全部测试套件
```

测试文件在 `verify/` 和 `scripts/` 下，使用 `tsx` 直接运行（无测试框架依赖，手写 assert）。

## target 扩展

统一的目标（goal）和待办（todo）管理系统。核心概念：**Target**——融合了其他 agent 系统中的 goal 和 todo。

### 数据模型

```ts
TargetItem { id: number; text: string; status: "active" | "completed" | "failed"; note?: string }
TargetState { primary: TargetItem | null; secondary: TargetItem[]; autoContinue: boolean; askUserTimeoutCap: boolean }
```

- `primary`（id=0）是主目标，驱动 auto-continue
- `secondary`（id=1,2,3,…）是次目标，用于进度追踪
- `autoContinue` 控制 guard 是否在 `agent_settled` 时注入续跑消息
- `askUserTimeoutCap` 区分模式：`false` = goal 模式（ask_user 用配置超时，默认无限等待）；`true` = goal-auto 模式（ask_user 封顶 60s，无人应答不卡自主循环）

### Target 工具（5 actions）

| Action | 说明 |
|--------|------|
| `set` | 设置主 target 文本。设置成功即自动进入 **goal 模式**（auto-continue 开启、主 target 锁定）。autoContinue=true 时拒绝（主 target 被用户锁定） |
| `add` | 添加次 target，返回新 id |
| `update` | 更新任意 target 状态。id=0 + completed/failed → 关闭 auto-continue |
| `update_targets` | 全量覆盖所有 target。省略 text 时保留现有主 target，只替换次 target。带 text 且 autoContinue=false 时同样进入 goal 模式；autoContinue=true 时自动跳过主 target（部分失败），只覆盖次 target |
| `list` | 列出所有 target 及状态 |

### /goal 与 /goal-auto 命令（仅用户触发）

| 用法 | 效果 |
|------|------|
| `/goal <text>` | 设置不可变主 target + 激活 auto-continue（**goal 模式**：ask_user 不设超时）+ 空闲时立即发送目标文本（启动首轮工作） |
| `/goal-auto <text>` | 同 `/goal`，但为 **goal-auto 模式**：ask_user 超时封顶 60s（无人应答时 agent 用 fallback 继续，不卡自主循环） |
| `/goal on` / `/goal-auto on` | 重新激活 auto-continue（primary 重置为 active，模式按命令名）+ 空闲时立即发送 primary 文本（恢复工作） |
| `/goal off` / `/goal-auto off` | 关闭 auto-continue（primary 保留，agent 可修改） |
| `/goal` / `/goal-auto` | 显示当前状态（goal-auto 时有标记） |

> **立即发送**：`/goal <text>`、`/goal-auto <text>`、`/goal on`、`/goal-auto on` 在 agent 空闲（`isIdle`）时会立即 `sendUserMessage` 发送目标文本，触发首轮工作；agent 正在流式输出时跳过，由 guard 在 `agent_settled` 时注入续跑消息接手（避免与 guard 的 `followUp` 重复注入）。

### 状态流转

```
/goal <text>       → primary={active}, autoContinue=true, cap=false（goal 模式）+ 空闲时立即发送目标文本（主 target 锁定，set 被拒绝）
/goal-auto <text>  → primary={active}, autoContinue=true, cap=true（goal-auto 模式：ask_user 60s 封顶）+ 同上
agent set/update_targets(带 text) → 同 /goal <text>（自动进入 goal 模式，cap=false）
autoContinue=true  → agent 可 add/update，不可 set
update id=0 completed/failed → autoContinue=false（主 target 解锁）
/goal off          → autoContinue=false（主 target 解锁）
/goal on           → primary={active}, autoContinue=true, cap=false + 空闲时立即发送 primary 文本（主 target 重新锁定）
/goal-auto on      → 同上但 cap=true
Escape (aborted)   → autoContinue=false（与 /goal off 相同；用户主动中断时任何 auto-resume 检查都不触发）
```

## guard 扩展

协调 `agent_settled` 事件的多个 guard，按优先级处理：

1. **Escape 检测**（最高优先级）：最后一条 assistant 消息 `stopReason === "aborted"` → 关闭 target auto-continue，停止注入
2. **后台任务**（task 扩展）：有运行中的 background tasks → task guard 注入提醒，跳过 target guard
3. **Target auto-continue**：autoContinue=true && primary=active → 注入续跑消息（含 completion audit + 「需要人接入/无法完成 → 直接置 failed」引导）。主 target 未达终态（completed/failed）前持续注入——会话只有在主 target 终态或用户主动中断时才会真正结束

续跑消息作为新 user 消息追加到对话尾部（`deliverAs: "followUp"`），不触碰 system prompt，不破坏 API 前缀缓存。

### 飞书通知（Feishu）

实现见 `extensions/guard/notify.ts`，在两个时机发送精简卡片（pwd 末两段 + 「打开会话」按钮）：

1. **ask_user**：监听 `tool_call`，`toolName === "ask_user"` 时通知（工具执行前触发，ask_user 阻塞 turn，与会话结束通知不冲突）。
2. **会话结束**：`agent_settled` 中当 Escape / 后台任务 / auto-continue 三个 guard **均不注入**（即 auto-continue 未激活、无运行中任务、非中断）时通知——agent 真正交还控制权。

排除条件（满足任一则不通知）：
- **subagent**：`PI_ATLAS_TASK_DEPTH > 0`（与 task 扩展判定子代理一致，由 create_agent spawn 时注入）。
- **会触发 guard 续跑**：仅对「会话结束」生效——auto-continue 激活期间持续续跑，零通知，直到目标完成、agent 真正空闲时通知一次。ask_user 不属此类，即便在 auto-continue 运行中也照样通知。

> 通知与运行模式无关（tui / rpc / print / json 均触发）——pi-web 以 `rpc` 模式运行主会话，按模式过滤会漏掉 web 端通知。

配置存全局 `~/.pi/atlas/notify.json`（非按 session）：

```json
{
  "enabled": true,
  "webhookUrl": "https://open.feishu.cn/open-apis/bot/v2/hook/<id>",
  "webhookSecret": "<可选，webhook 启用签名时填>",
  "webUrl": "https://your-pi-web.example.com"
}
```

- 文件缺失 / `enabled:false` / `webhookUrl` 为空 → 静默不通知（安全默认，源码不含密钥）。
- 每次通知时同步重读配置（用户改完即生效，无需重启）。`webUrl` 可选，决定「打开会话」按钮跳转地址 `${webUrl}/?session=${sessionId}`；未配置时卡片不含该按钮。
- 通知为 fire-and-forget（fetch 8s 超时、全程吞错写 stderr），失败绝不影响 guard 主流程。
