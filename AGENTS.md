# pi-atlas

pi coding agent 的 TypeScript 扩展集合（task 异步任务管理 + askuser 用户交互 + target 目标管理 + guard 自动续跑）。

## 架构

```
extensions/
├── shared/
│   └── atlas-paths.ts        # 所有扩展共享的路径辅助
├── task/                     # 后台任务系统（CreateBash / CreateAgent / AwaitTask …）
├── askuser/                  # ask_user 工具（select / confirm / input）
├── target/                   # 目标管理（Target 工具 + /goal 命令）
└── guard/                    # agent_settled guard 协调器（task + target 优先级）
```

每个扩展导出 `default` 工厂函数 `(pi: ExtensionAPI) => void`，通过 `pi.registerTool()` 注册工具、`pi.on(event, handler)` 注册生命周期事件。

## 共享存储位置

所有插件产生的运行时数据统一存储在 `~/.pi/atlas/` 下，按 session 隔离：

```
~/.pi/atlas/
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
import { getAtlasDir, getAtlasSessionDir, ENV_ATLAS_DIR } from "../shared/atlas-paths.js";

getAtlasDir()                  // → ~/.pi/atlas/（基目录）
getAtlasSessionDir(sessionId)  // → ~/.pi/atlas/sessions/<sessionId>/
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
TargetState { primary: TargetItem | null; secondary: TargetItem[]; autoContinue: boolean }
```

- `primary`（id=0）是主目标，驱动 auto-continue
- `secondary`（id=1,2,3,…）是次目标，用于进度追踪
- `autoContinue` 控制 guard 是否在 `agent_settled` 时注入续跑消息

### Target 工具（5 actions）

| Action | 说明 |
|--------|------|
| `set` | 设置/更新主 target 文本。autoContinue=true 时拒绝（主 target 被用户锁定） |
| `add` | 添加次 target，返回新 id |
| `update` | 更新任意 target 状态。id=0 + completed/failed → 关闭 auto-continue |
| `update_targets` | 全量覆盖所有 target。autoContinue=true 时自动跳过主 target（部分失败），只覆盖次 target |
| `list` | 列出所有 target 及状态 |

### /goal 命令（仅用户触发）

| 用法 | 效果 |
|------|------|
| `/goal <text>` | 设置不可变主 target + 激活 auto-continue + 空闲时立即发送目标文本（启动首轮工作） |
| `/goal on` | 重新激活 auto-continue（primary 重置为 active）+ 空闲时立即发送 primary 文本（恢复工作） |
| `/goal off` | 关闭 auto-continue（primary 保留，agent 可修改） |
| `/goal` | 显示当前状态 |

> **立即发送**：`/goal <text>` 与 `/goal on` 在 agent 空闲（`isIdle`）时会立即 `sendUserMessage` 发送目标文本，触发首轮工作；agent 正在流式输出时跳过，由 guard 在 `agent_settled` 时注入续跑消息接手（避免与 guard 的 `followUp` 重复注入）。

### 状态流转

```
/goal <text>      → primary={active}, autoContinue=true + 空闲时立即发送目标文本（主 target 锁定，set 被拒绝）
autoContinue=true → agent 可 add/update，不可 set
update id=0 completed/failed → autoContinue=false（主 target 解锁）
/goal off         → autoContinue=false（主 target 解锁）
/goal on          → primary={active}, autoContinue=true + 空闲时立即发送 primary 文本（主 target 重新锁定）
Escape (aborted)  → autoContinue=false（与 /goal off 相同）
```

## guard 扩展

协调 `agent_settled` 事件的多个 guard，按优先级处理：

1. **Escape 检测**（最高优先级）：最后一条 assistant 消息 `stopReason === "aborted"` → 关闭 target auto-continue，停止注入
2. **后台任务**（task 扩展）：有运行中的 background tasks → task guard 注入提醒，跳过 target guard
3. **Target auto-continue**：autoContinue=true && primary=active → 注入续跑消息（含 completion audit）

续跑消息作为新 user 消息追加到对话尾部（`deliverAs: "followUp"`），不触碰 system prompt，不破坏 API 前缀缓存。
