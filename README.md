# dev-bridge — uTools 插件开发测试桥

![version](https://img.shields.io/badge/version-0.4.0-blue) ![uTools](https://img.shields.io/badge/uTools-8.0.2%20tested-brightgreen) ![runtime](https://img.shields.io/badge/Electron%2034%20%C2%B7%20Node%2020-339933) ![tools](https://img.shields.io/badge/MCP-13%20dev%20tools-blueviolet) ![tests](https://img.shields.io/badge/node%3Atest-zero--deps-success) ![last commit](https://img.shields.io/github/last-commit/lililixxx1/utools-dev-bridge)

让 AI agent（经 uTools MCP）自主加载、批量断言、异步跟踪并调试任意 uTools 插件的 preload 与真实窗口 UI，消除"开发者插件 + 人肉测试"循环。**工具面纯 AI 驱动，无功能 UI**（`plugin.json`：`logo`/`preload`/`tools` + 一页保活入口）。

## 快速开始

### 给 agent（推荐）

把下面这句原样发给你的 AI agent，它会自己完成技能装配：

> 请安装 uTools 开发桥配套技能：clone https://github.com/lililixxx1/utools-dev-bridge ，把 skills/ 下 utools-dev-bridge（插件实测手册）与 utools-plugin-dev（API 参考）装进你的技能目录；此后实测/调试 uTools 插件，用 uTools MCP 的 dev_* 工具按手册驱动。

（uTools 插件里的「开发桥」保活页有同款一键复制。）

### 人工安装（唯一人工步骤）

1. uTools → 开发者工具 → 加载本目录（`utools-dev-bridge/`，选含 `plugin.json` 的目录）
2. **重启 uTools**（不打开任何插件，agent 的 `tools/list` 里应出现 `dev_*` 13 个工具——8.0 起 MCP 服务支持调用时按需拉起插件）
3. agent 侧：MCP 服务指向 `http://127.0.0.1:3501/mcp`，鉴权 header `x-mcp-key` 用 uTools 设置 →「AI Agent 连接」里复制的值

若重启 uTools 后 `dev_*` 无响应：在 uTools 里打开一次「开发桥」窗口拉起 preload 即可（冷启动回退）。该窗口是 8.0 校验器 `features` 必填要求下的保活入口，仅显示就绪状态与资源指引，不是功能 UI。

## 13 个工具速查（由 `preload/contract.js` 自动生成）

<!-- GENERATED:TOOLS_TABLE:START -->
| 工具 | 用途 | 关键参数 |
| --- | --- | --- |
| `dev_load` | 加载或热重载目标插件 preload | `path`（必）、`mode`、`allowSideEffects`、`allowHostModules`、`reveal`、`confirmRisk`、`verbose` |
| `dev_call` | 调用导出函数、生命周期或 __tool:<名> | `name`（必）、`args`、`include`、`async`、`timeoutMs` |
| `dev_run` | 单次背靠背执行多步调用与断言（可选加载与清理） | `steps`（必）、`load`、`stopOnFail`、`cleanup` |
| `dev_job` | 查询、等待或取消异步调用任务 | `id`、`waitMs`、`cancel` |
| `dev_list` | 查看当前加载状态、摘要清单与 UI 会话 | `verbose` |
| `dev_console` | 增量读取 console 与异步未捕获异常 | `since`、`clear` |
| `dev_calls_log` | 增量读取 utools/fs/require 调用流水 | `since`、`clear` |
| `dev_cleanup` | 逆序还原 db/dbStorage/dbCryptoStorage/fs 写副作用并清理 UI 缓存 | `force`、`dropAll` |
| `dev_ui_open` | 在真实 BrowserWindow 中加载目标插件 UI 与 preload | `path`、`width`、`height`、`show`、`serveHttp`、`enter`、`confirmRisk` |
| `dev_ui_eval` | 在 UI 窗口内执行 JS 或触发生命周期事件 | `js`、`lifecycle`、`args`、`include`、`awaitPromise` |
| `dev_ui_snapshot` | 获取 UI 窗口的紧凑 DOM 与可访问性文本树 | `selector`、`maxDepth`、`maxNodes`、`includeHidden` |
| `dev_ui_screenshot` | 截取 UI 窗口画面为 PNG 文件 | `outPath`、`confirmOutPath`、`rect`、`returnBase64` |
| `dev_ui_close` | 关闭 UI 测试窗口并释放本地静态服务 | 无 |
<!-- GENERATED:TOOLS_TABLE:END -->

## agent 工作流

### 1) Preload 沙箱单步与内联现场

```text
dev_load {path: "<目标插件根目录>"}                  # 默认精简 exports + 默认脱敏敏感值
dev_call {name: "airss.db.getFeeds"}                  # 返回 {ok, result, console?, calls?, consoleFrom, callsFrom}
改代码 → dev_load (热重载，services 子模块级生效) → dev_call ……
dev_cleanup                                           # 按 WAL 还原 db/dbStorage/dbCryptoStorage/fs 写副作用
```

- **内联现场**：`dev_call` 默认在成功时附带非空 `console`，在失败（含 `THROWN` / `DENIED_MODULE` / `TIMEOUT`）时附带非空 `console` 与 `calls`（排除探针，上限 30 条，超限标 `consoleMore`/`callsMore`）；也可传 `include: ["console","calls"]` 或 `include: []` 精确控制，`dev_console`/`dev_calls_log` 保留用于全量翻页。
- **响应瘦身**：`dev_load` 默认仅返回 `exportsCount`、`exportsHash` 与无源码 `preview` 的精简 `exports`（传 `verbose:true` 附源码片段）；`dev_list` 默认不回传 `exports` 数组（传 `verbose:true` 展开）。
- **生命周期触发**：`__enter`（`args=[{code,type,payload,from}]`）、`__out`（`args=[isKill]`）、`__detach`、`__mainPush`（`args=[{code,type,payload}]`）、`__mainPushSelect`（触发 `onMainPush` 第二参数 `onSelect`）、`__dbPull`（`args=[[docs]]`）、`__ready`（`args=[]`）、`__schedule`（`args=[{code}]`）、`__domReady`。多回调会顺序执行并逐个 `await`，返回结果数组。
- **8.0 MCP 工具**：目标调用 `utools.registerTool(name, handler)` 注册的工具经 `__tool:<名>` 直接驱动，自动注入仿真 `ToolContext`（`sendProgress` 录入 `tool.progress:<名>`）。

### 2) 批量断言与异步长任务（低往返、抗挂起）

- **`dev_run`**：一次调用背靠背执行可选 `load` + 多步 `steps`（支持 `ok`/`code`/`path`/`eq`/`ne`/`gt`/`gte`/`lt`/`lte`/`contains`/`matches`/`truthy`/`type`/`hasCall`/`hasConsole` 断言）+ 可选 `cleanup:true`。在单次进程调用内闭环，彻底规避隐藏页挂起与多轮往返开销。
- **`dev_job`**：长耗时异步操作传 `dev_call {name, args, async:true}` 立即返回 `jobId`（不阻塞串口锁、不撞客户端 30s 超时）；用 `dev_job {id, waitMs}` 轮询进度（含 `sendProgress`）与终态结果，或传 `cancel:true` 取消等待。

### 3) 真窗口 UI 渲染层测试

```text
dev_ui_open {path: "<目标插件根目录>", enter: {code: "hello", type: "text", payload: ""}}
dev_ui_snapshot                                       # 紧凑 DOM/可访问性树（含缩进 text 树）
dev_ui_eval {js: "document.querySelector('#go').click()"}
dev_ui_screenshot                                     # 截屏存 PNG（默认不回传 base64 省 token）
dev_ui_close
dev_cleanup                                           # 连同 UI 窗口产生的 db/kv/fs 写副作用一并还原
```

- 自动探测目标 HTML 中的 `<script type="module">` 或根路径资源，按需启本机回环静态文件服务（也可显式传 `serveHttp:true/false`）。
- 窗口内的 `window.utools`、`console`、未捕获异常与目标 `preload` 的 `fs` 写操作全部接入与沙箱一致的门控与 WAL 日志，经本机回环通道汇入父进程单点落盘。

## 副作用、脱敏与安全约定（必读）

**定位口径：门控是"防意外"的卫生措施，不是安全边界。** `vm` 沙箱注入了宿主对象（`Buffer`/timers 等），蓄意代码可经 `Buffer.constructor("return process")()` 逃逸——永远堵不完，也不试图堵。`dev_*` 等价于**本机任意代码执行 + 任意路径读取**；3501 仅绑回环，`x-mcp-key` 即边界，key 不入任何仓库或笔记。

- **默认凭证脱敏**：`utools.getNativeId`、`utools.getUser`、`utools.getUserServerTemporaryToken`、`dbCryptoStorage.*`、键名/字段命中敏感词（`token`/`secret`/`password`/`apiKey` 等）以及命中敏感词的导出函数返回值，在 `dev_console`、`dev_calls_log` 与 `dev_call` 返回中默认替换为 `<redacted len=...>`；`dev_load`/`dev_ui_open` 传 `reveal:true` 可查看原值。**写日志前态（`journal`）绝不脱敏**，保证 `dev_cleanup` 还原真实值。
- **高危开关二次确认（`confirmRisk: true`）**：启用 `allowSideEffects: true`、`allowHostModules: true` / 非空数组或 `reveal: true` 时，`dev_load`、`dev_run.load`、`dev_ui_open` 默认返回 `CONFIRM_REQUIRED` 并说明对应风险；向用户说明风险并显式传 `confirmRisk: true` 后方可执行，且返回载荷会附带 `riskNotice`。
- **破坏性 utools API 默认 stub**（剪贴板/键鼠模拟/shell/通知/录屏/窗口/AI 计费/`outPlugin`/定时任务创建删除等），`requestSchedule` stub 保 thenable；确需真执行才 `allowSideEffects:true` + `confirmRisk:true`。
- **Node 内置模块白名单门控**（`node:` 前缀已规范化）：
  | 类别 | 模块 | 行为 |
  | --- | --- | --- |
  | map（安全替身） | `process`/`console`/`timers`/`timers/promises`/`fs`/`fs/promises`/`module` | shim：`process` 白名单、`timers` 走 libuv 通道、`fs` 写日志、`module.createRequire` 封闭回 loader |
  | allow（透传） | `path`/`os`/`util`/`events`/`assert`/`crypto`/`url`/`zlib`/`stream` 等只读系 | 原样透传 |
  | 默认拒绝 | `child_process`/`worker_threads`/`cluster`/`http(s)`/`http2`/`net`/`dgram`/`tls`/`dns`/`inspector`/`vm`/`v8`/`repl`/`readline`/`electron` 及未列入白名单的一切 | **懒拒绝**：import 不炸（事件注册族 noop 可链式），真正调用时抛 `DENIED_MODULE`；`allowHostModules:true` 或白名单数组（配 `confirmRisk:true`）放行 |
- **fetch 默认拦截**（rejected Promise，`code=DENIED_FETCH`）；沙箱已补齐 `URL`/`TextEncoder`/`AbortController` 等 web 全局。`.node` 原生模块透传绕过门控。
- **截图与会话清理**：`dev_ui_screenshot` 默认限制保存在会话目录 `devbridge-shots/`，传入超出该目录的 `outPath` 须同时传 `confirmOutPath: true` 二次确认；`dev_cleanup` 会一并清理 `devbridge-shots/` 与非活跃 `devbridge-ui-session.json`。
- **db / dbStorage / dbCryptoStorage / fs 还原契约**：
  - WAL 前态先落盘 **`getPluginLocalDataPath()/devbridge-spill/`**（NDJSON 增量追加，旧 `temp` 目录或 `journal.json` 启动自动迁移，遗留 >7 天按弃置会话整体清空并置 `spillWiped:true`）。
  - fs 单文件上限 8MB、目录快照上限 500 文件、spill 总量 64MB：破坏性操作前态超限默认拒绝（`DENIED_FS_UNTRACKED`），写类超限放行但标 `untracked`；**越出目标插件根目录的 fs 写会在流水标 `outside:true`，并在 `dev_cleanup` 返回 `outsideWrites` 清单**。
  - `dev_cleanup {dropAll:true}` 先杀定时器并跳过回放直接清空写日志（仅确认终态后使用）；还原模型假设无沙箱外并发写同一 db。

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
| `CONFIRM_REQUIRED` | 触发高危开关（allowSideEffects/allowHostModules/reveal）或越出会话目录写截图，需显式传 confirmRisk:true 或 confirmOutPath:true 二次确认 |
| `BOOT_FAILED` | 开发桥自身启动崩溃，仅暴露 dev_boot_err 诊断工具 |
<!-- GENERATED:ERROR_CODES:END -->

## 能力边界

- `dev_load` 的 `vm` 沙箱仅支持 CommonJS（`require`），ESM-only preload 会报 `SYNTAX_ERROR`/`REQUIRE_FAILED`；前端 ESM 应用请用 `dev_ui_open`（自动启回环静态服务）。
- 同步死循环受 `timeoutMs` 硬保护；`await` 之后的同步死循环无法打断。异步异常以 `level:"uncaught"` 录入 `dev_console`。

## 开发、测试与打包

```bash
npm test                                    # 运行 node:test 全套测试（零依赖）
node scripts/gen-docs.js --check            # 校验契约、plugin.json、README、SKILL 一致性
node scripts/bench-workflow.js              # 对比旧多轮往返 vs 新内联/批量往返效率
npm run pack                                # 生成纯净发行目录 dist/（仅 plugin.json/logo/html/preload）
node scripts/pack-stage.js --dry-run        # 预览最小分发打包清单
UTOOLS_MCP_KEY=<key> node scripts/rt-run.js # 真机回归（需 uTools 已装并重载新版桥）
```

> **发布打包规范**：提交 uTools 插件商店或导出 `.upx` 前请先运行 `npm run pack`，在 uTools 开发者工具中加载/打包 **`dist/`** 目录，**勿直接打包仓库根目录**（`dist/` 已自动排除 `test/`、`scripts/`、`skills/`、`docs/` 与根 `package.json` 并通过完整性自检）。

| 路径 | 说明 |
| --- | --- |
| `preload/contract.js` | 契约单一来源（版本、上限、错误码、13 工具 schema） |
| `preload/index.js` | 引导保护网与 13 工具注册入口 |
| `preload/state.js` / `serialize.js` | 状态工厂、序列化器与默认脱敏 |
| `preload/journal.js` / `proxy.js` / `loader.js` | WAL 还原、深代理、容器无关加载策略与 vm 适配器 |
| `preload/shims/` | `process` / `console` / `timers` / `denied` / `fs` / `dom` 替身 |
| `preload/tools/` | `load` / `call` / `run` / `job` / `cleanup` / `ui` 工具实现 |
| `preload/ui-host.html` / `ui-preload.js` | 真窗口加载过渡页与子窗口注入代理 |
| `test/` | 基于 `node:test` 的模块化测试套件（`scripts/selftest.js` 作为统一入口） |
| `scripts/gen-docs.js` / `pack-stage.js` | 契约文档同步校验 / 最小分发包暂存 |
| `scripts/rt-run.js` / `rt-suite.json` / `gw-call.js` | 真机一键回归 / 声明式套件 / 网关直连兜底 |
| `docs/design.md` / `CHANGELOG.md` | 当前设计说明 / 版本演进史 |
