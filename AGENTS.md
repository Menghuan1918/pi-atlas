# pi-atlas

pi coding agent 的 TypeScript 扩展集合（task 异步任务管理 + askuser 用户交互）。

## 架构

```
extensions/
├── shared/
│   └── atlas-paths.ts        # 所有扩展共享的路径辅助
├── task/                     # 后台任务系统（CreateBash / CreateAgent / AwaitTask …）
└── askuser/                  # ask_user 工具（select / confirm / input）
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
    └── askuser/
        └── config.json           # 超时配置 {"timeout": <seconds>}
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
