---
name: utools-dev-bridge
description: 用 uTools 开发桥（dev-bridge）在真实 uTools 里加载并实测任意 uTools 插件的 preload 与窗口 UI——dev_load 加载、dev_call/dev_run 批量断言、dev_job 异步任务、dev_ui_* 真窗口调试、dev_cleanup 还原 db/fs 副作用。Use whenever the user wants to 实测 / 跑通 / 调试 / 回归一个 uTools 插件（而不只是改代码），mentions 开发桥、dev-bridge、dev_load、dev_call、dev_run、dev_ui_open、dev_cleanup、真机回归、rt-check，or asks whether a plugin actually works —— even if they don't name the bridge.
---

# uTools 开发桥（dev-bridge）

本机 uTools 装有纯 AI 插件「开发桥 dev-bridge」：既可将目标插件 preload 拉进隔离 vm 沙箱驱动测试，也可通过 `dev_ui_*` 打开真实 `BrowserWindow` 实测渲染层与 preload 接缝，并把期间的 db/dbStorage/dbCryptoStorage/fs 写副作用全部纳入 WAL 写日志还原。会话内工具名形如 `mcp__utools__utools_plugin_<id>_dev_load`（旧版 `utools.<id>.dev_load`），认 `dev_` 后缀即可。

权威说明以仓库 `README.md` 与 `preload/contract.js` 为准；写/改插件本体、查 utools API 参考 → 技能 `utools-plugin-dev`（现已提供官方版本，见 [官方 Skill 说明](https://www.u-tools.cn/docs/ai/plugin-dev-skill.html)）。

## 何时用与工具选择

- **测纯服务 / preload 逻辑、批量回归**：`dev_load` → `dev_call` / `dev_run` → `dev_cleanup`
- **测耗时超过 ~25s 的任务**：`dev_call {async:true}` → `dev_job {id, waitMs}`
- **测真实页面渲染、DOM 交互、Vue/React + preload 联调**：`dev_ui_open` → `dev_ui_snapshot` / `dev_ui_eval` / `dev_ui_screenshot` → `dev_ui_close` → `dev_cleanup`
- **tools/list 无 `dev_*`**：首次调用应触发 uTools 按需无头拉起；若仍失败，检查开发者工具加载状态或打开一次「开发桥」窗口保活
- **网关 403**：key 随 uTools 重登/重置轮换，在 uTools 设置 →「AI Agent 连接」重新复制并更新你的 MCP 客户端配置（脚本直连用环境变量 `UTOOLS_MCP_KEY`）

## 高效测试循环

### 1) 沙箱测试与内联现场

```text
dev_load {path: "<目标插件根目录>"}                   # 默认精简 exports + 默认脱敏；要看源码片段传 verbose:true
dev_call {name: "airss.db.getFeeds"}                  # 默认附非空 console；失败默认附 console+calls
dev_cleanup {}                                        # 逆序还原 db/kv/fs 写副作用（越界写会在 outsideWrites 单列）
```

### 2) 批量背靠背 `dev_run`（优先用于多步测试与回归）

一次调用在桥内连续跑完加载、多步调用、断言和清理，避免客户端 30s 超时和隐藏页定时器冻结：

```json
{
  "load": { "path": "<目标插件根目录>" },
  "steps": [
    { "call": "demo.saveDoc", "args": ["_dev_:1"], "expect": { "ok": true } },
    { "call": "demo.boom", "expect": { "ok": false, "code": "THROWN" } },
    { "call": "__enter", "args": [{ "code": "demo", "type": "text", "payload": "hi", "from": "main" }], "expect": { "hasConsole": "enter" } }
  ],
  "cleanup": true
}
```

### 3) 真窗口 UI 测试 `dev_ui_*`

- `dev_ui_open` 支持 `enter: {code, type, payload, from}`，会在页面和 preload 加载就绪后依次触发 `onPluginReady`（如有）与 `onPluginEnter`。
- 含 `<script type="module">` 或 `/assets/...` 根路径的前端产物会自动启本机回环静态服务；可用 `serveHttp` 显式覆盖。
- 优先用 `dev_ui_snapshot` 获取低 token 紧凑 DOM/可访问性树验证状态，只在确实需要视觉检查时才调 `dev_ui_screenshot`（且默认仅存文件不回传 base64）。
- **测完务必 `dev_ui_close` + `dev_cleanup`**：窗口内的 db/kv/fs 写已汇总到父进程写日志，可直接还原。

## 关键注意点

- **生命周期参数签名（对齐 uTools 8.0 文档）**：
  - `__enter`: `args=[{code, type, payload, from}]`
  - `__out`: `args=[isKill]`（`true` 进程退出，`false` 隐藏后台）
  - `__detach`: `args=[]`
  - `__mainPush`: `args=[{code, type, payload}]`；**`__mainPushSelect`** 触发 `onMainPush` 的第二参数 `onSelect(action)`
  - `__dbPull`: `args=[[doc1, doc2, ...]]`（注意参数本身是一个文档数组，传进 `args` 就是嵌套二维数组）
  - `__ready`: `args=[]`；`__schedule`: `args=[{code}]`
  - 同一生命周期注册了多个回调时，`dev_call` 会顺序执行并逐个 `await`，返回结果数组。
- **凭证自动脱敏**：`getNativeId`、`getUser`、`dbCryptoStorage.*`、敏感 kv 键及敏感字段在返回值与日志里默认显示为 `<redacted len=N>`；仅确需验证原文时传 `dev_load {reveal:true}` 或 `dev_ui_open {reveal:true}`。绝不把真实密钥写进文件或输出。
- **门控放行**：顶层 `require` 被拦时（`REQUIRE_FAILED` 且含 `require:xxx`），用 `dev_load {allowHostModules:["http"]}` 或 `true` 放行；破坏性 utools API 确需真执行才 `allowSideEffects:true`。
- **MCP 客户端缓存旧 schema 时**：用环境变量 `UTOOLS_MCP_KEY` + `node <桥仓库>/scripts/gw-call.js <工具名> '<json>'` 直连网关绕过客户端缓存。
- **越出目标目录的 fs 写入**：若被测插件往目标根目录之外写了文件，流水条目会标 `outside:true`，`dev_cleanup` 会在 `outsideWrites` 单列。

## 13 工具速查（由 `preload/contract.js` 自动生成）

<!-- GENERATED:TOOLS_TABLE:START -->
| 工具 | 用途 | 关键参数 |
| --- | --- | --- |
| `dev_load` | 加载或热重载目标插件 preload | `path`（必）、`mode`、`allowSideEffects`、`allowHostModules`、`reveal`、`verbose` |
| `dev_call` | 调用导出函数、生命周期或 __tool:<名> | `name`（必）、`args`、`include`、`async`、`timeoutMs` |
| `dev_run` | 单次背靠背执行多步调用与断言（可选加载与清理） | `steps`（必）、`load`、`stopOnFail`、`cleanup` |
| `dev_job` | 查询、等待或取消异步调用任务 | `id`、`waitMs`、`cancel` |
| `dev_list` | 查看当前加载状态、摘要清单与 UI 会话 | `verbose` |
| `dev_console` | 增量读取 console 与异步未捕获异常 | `since`、`clear` |
| `dev_calls_log` | 增量读取 utools/fs/require 调用流水 | `since`、`clear` |
| `dev_cleanup` | 逆序还原 db/dbStorage/dbCryptoStorage/fs 写副作用 | `force`、`dropAll` |
| `dev_ui_open` | 在真实 BrowserWindow 中加载目标插件 UI 与 preload | `path`、`width`、`height`、`show`、`serveHttp`、`enter` |
| `dev_ui_eval` | 在 UI 窗口内执行 JS 或触发生命周期事件 | `js`、`lifecycle`、`args`、`include`、`awaitPromise` |
| `dev_ui_snapshot` | 获取 UI 窗口的紧凑 DOM 与可访问性文本树 | `selector`、`maxDepth`、`maxNodes`、`includeHidden` |
| `dev_ui_screenshot` | 截取 UI 窗口画面为 PNG 文件 | `outPath`、`rect`、`returnBase64` |
| `dev_ui_close` | 关闭 UI 测试窗口并释放本地静态服务 | 无 |
<!-- GENERATED:TOOLS_TABLE:END -->

## 错误码速查（由 `preload/contract.js` 自动生成）

<!-- GENERATED:ERROR_CODES:START -->
| code | 含义与处置 |
| --- | --- |
| `PATH_NOT_FOUND` | 目标路径或入口文件不存在，先核对 path |
| `NO_PLUGIN_JSON` | 目标目录缺少或无法解析 plugin.json（单文件请传 mode:"file"） |
| `NO_PRELOAD` | 目标 plugin.json 未声明 preload 或文件不存在 |
| `NO_MAIN` | 目标 plugin.json 未声明 main 入口 HTML 或文件不存在 |
| `SYNTAX_ERROR` | 目标代码编译失败（或疑似使用 ESM 语法，当前仅支持 CommonJS） |
| `REQUIRE_FAILED` | 模块解析或顶层初始化失败；若含 require:xxx，用 allowHostModules 放行后重载 |
| `UNKNOWN_EXPORT` | 导出路径或生命周期/工具名不存在；用 dev_list 查清单 |
| `NOT_LOADED` | 尚未加载目标；先调用 dev_load |
| `TIMEOUT` | 同步执行超时，沙箱已标记重建；下次调用自动重载 |
| `ASYNC_TIMEOUT` | 异步 Promise 超时放弃等待；长任务改传 dev_call async:true |
| `SERIALIZE_FAILED` | 返回值过大或过深无法序列化，请让目标返回摘要或分页 |
| `DENIED_MODULE` | Node 内置/electron 模块被默认门控拦截；allowHostModules 放行 |
| `DENIED_FETCH` | fetch 默认拦截；dev_load 传 allowHostModules:true 放行 |
| `DENIED_FS_UNTRACKED` | 破坏性 fs 操作前态超限（8MB/500 文件）被拒；拆小或 allowHostModules:true 放行 |
| `THROWN` | 目标代码抛出异常，message 带调用栈并自动附带现场日志 |
| `JOB_NOT_FOUND` | 指定的异步任务 jobId 不存在或已被淘汰 |
| `UI_NOT_OPEN` | 尚未打开测试 UI 窗口；先调用 dev_ui_open |
| `UI_UNAVAILABLE` | 当前宿主环境不支持 utools.createBrowserWindow |
| `UI_EVAL_FAILED` | UI 窗口内执行 JS/生命周期或生成快照失败 |
| `BOOT_FAILED` | 开发桥自身启动崩溃，仅暴露 dev_boot_err 诊断工具 |
<!-- GENERATED:ERROR_CODES:END -->
