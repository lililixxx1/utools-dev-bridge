---
name: utools-dev-bridge
description: 用 uTools 开发桥（dev-bridge）在真实 uTools 里沙箱加载并实测任意 uTools 插件的 preload——dev_load 加载、dev_call 调导出函数与 __enter 生命周期、dev_console/dev_calls_log 看现场、dev_cleanup 还原 db/fs 副作用。Use whenever the user wants to 实测 / 跑通 / 调试 / 回归一个 uTools 插件（而不只是改代码），mentions 开发桥、dev-bridge、dev_load、dev_call、dev_cleanup、真机回归、rt-check，or asks whether a plugin's preload logic actually works —— even if they don't name the bridge.
---

# uTools 开发桥（dev-bridge）

本机 uTools 装有纯 AI 插件「开发桥 dev-bridge」：把任意目标插件的 preload 拉进 vm 沙箱真实执行。agent 可以调用其导出函数、读 console 与 utools 调用流水、测完按写日志还原 db/dbStorage/dbCryptoStorage/fs 副作用。会话内工具名形如 `mcp__utools__utools_zii2hjtj_dev_load`（插件 id 随安装而变，认 `dev_` 前缀即可）。

桥本体仓库即本仓库（本 skill 位于其 `skills/utools-dev-bridge/` 下），其 `README.md` 是权威文档（安装回退、安全口径、排障表）；本 skill 是日常驾驶手册，冲突时以 README 为准。

分工：写/改插件本体、查 utools API → skill `utools-plugin-dev`；让写好的逻辑真的跑起来、验证行为、回归 → 本 skill。

## 何时不用

- 测 UI 渲染期逻辑：沙箱只有极简 DOM stub（querySelector 恒 null），回调里做真实 DOM 的插件不承载
- ESM-only 目标：一期只支持 CommonJS
- 问 uTools 客户端怎么用（装插件、快捷键）：与开发无关
- tools/list 里没有 dev_* 工具：桥未加载或冷启动失败——官方 MCP 冷启动机制（见 utools-plugin-dev 技能的 `references/tools.md`）：Tool 被调用时若插件未运行，uTools 无头拉起插件并在初始化阶段执行 registerTool，故**首次调用有拉起延迟属正常**，tools/list 空说明这条链路没走通。让用户在 uTools 开发者工具里加载桥目录并重启 uTools；仍不行按 README「冷启动回退」
- 网关 403：key 随 uTools 重登/重置轮换，只能让用户重新复制到 `~/.zcode/cli/config.json`；key 绝不写进任何仓库/笔记/输出

## 标准测试循环

```
dev_load     {path: "<目标插件根目录>"}      # 或 mode:"file" 直跑单个 js；返回导出清单 + warnings
dev_call     {name: "<导出路径>", args: []}  # → {ok, result, consoleFrom, callsFrom}
dev_console  {since: <游标>}                 # 增量 console + level:"uncaught" 异步异常
dev_calls_log {since: <游标>}                # 增量 utools.*/fs.*/require:* 流水，含 stubbed/denied/untracked 标记
改代码 → 再 dev_load（热重载，services 子模块级，无需重启 uTools）→ dev_call ……
dev_cleanup  {}                              # 测完必做：按前态还原 db/kv/fs 写副作用
```

要点：

- **先看 warnings**：dev_load 返回的装载期模块拦截汇总在 warnings——目标 require 了被拦模块，装载时就该发现
- **生命周期**：`__enter`（args=[{code,type,payload}]）触发 onPluginEnter，同类 `__out`/`__detach`、`__mainPush`（args=[{code,type,payload}]）、`__dbPull`（args=[{docs}]）、`__domReady`（触发 document 的 DOMContentLoaded 监听）。目标在 onPluginEnter 里干活的话，光调导出函数不够，要 `__enter` 驱动。排查「onPluginEnter 没生效」先看 dev_load 返回的 `events`——它列出装载期注册的生命周期回调；为空说明压根没注册（UI 插件常把注册放在页面侧调用里，preload 只挂 window 命名空间），此时 `__enter` 返回 UNKNOWN_EXPORT 并提示直接调导出函数（airss 实测如此）
- **交叉验证**：`__enter` 之后读 dev_calls_log——目标实际调了哪些 utools API、哪些被 stub/deny，一目了然。读流水两个甄别点：`api` 以 `probe.` 开头的是桥自身存活探测，不是目标调用；fs 只有**写**入流水（读不记录），"kv 读到 null 但函数有返回"这类现象要靠读目标源码定位第二来源（gopeed-helper 的 token 即走本地 hive 文件兜底，实测如此）
- **凭证卫生**：dev_call 可能返回真实凭证（dbStorage/dbCryptoStorage/本地 token 文件；实测 gopeedHelper.getApiToken 直接返回 Gopeed API token），流水里也会出现 nativeId/设备标识——报告只说"非空/长度/已脱敏"，不复述值，更不写进任何文件
- **门控放行**：目标真要用 http/electron 等 → `dev_load {allowHostModules:["http"]}`（或 true 全放行）。网络型插件首次装载就可能需要：顶层代码（如 `new http.Agent()`）即触发懒拒绝，报 REQUIRE_FAILED，message 自带放行提示（airss 首次裸装载即如此，需 `allowHostModules:["http","https"]`）；破坏性 utools API（剪贴板/键鼠/shell/AI 计费等）默认 stub，确需真执行才 `allowSideEffects:true`（慎用）。被拦路径**可以放心故意调用**来验证代码路径：异常在触发点抛出（DENIED_MODULE，message 精确到 `require:electron.clipboard.readText`）、流水留痕、无真实副作用（utools-bridge-plugin 的 readClipboard 实测）
- **长任务**：AI/网络类 `dev_call timeoutMs` 按需调大（默认 30s，上限 300s）

## 实机坑（都真踩过，别再踩）

1. **uTools 会挂起桥的隐藏页**：闲置后定时器/延迟回调可能 schedule 有、fire 无。根因是平台生命周期：主窗隐藏后插件默认 **3 分钟内自动退出/挂起**（官方平台生命周期口径，见 utools-plugin-dev 技能的 `references/events.md`），不是 vm 沙箱缺陷。目标代码测试别依赖跨 dev_call 的延迟回调（改同步或轮询）；成套多步操作（终态核对、cleanup 编排、真机回归）写成一次性 node 脚本单进程背靠背直连网关，范式见桥仓库 `scripts/final-restore.js`
2. **MCP 客户端缓存旧工具 schema**：新参数（如 allowHostModules/dropAll）被静默滤掉时，用 `node <桥仓库>/scripts/gw-call.js dev_cleanup '{"dropAll":true}'` 直连网关（自动读本机 key、补工具名前缀、不受客户端 30s 掐断）
3. **异步 dev_call 超 ~30s 被客户端掐断**：改为目标内自录结果（写 db/console），事后读取，不要同步干等
4. **cleanup 语义**：db 写是真实执行不是 mock——这是测试有信心的来源，也是测完必 `dev_cleanup` 的原因；注意**装载本身也可能写 db/kv**（目标顶层初始化；airss 装载即写一个 dbStorage key，cleanup 会连它一起还原，实测 kvDelete:1）。`dropAll:true` 跳过回放、现场保持，仅在人工核对终态后用；`force:true` 是 spill 丢失、journal 永久悬挂时的出口；retryable 条目重试可能过度还原（配对条目已执行完），必要时 dropAll 或手工 db.remove 处置
5. **无并发假设**：还原模型假设 journal 记录的操作之间没有沙箱外并发写——测试期间目标插件的正式实例别在 uTools 里同时运行
6. **改桥自身 preload 后**：须在 uTools 开发者工具里重载插件（或重启 uTools）才生效；本地先跑 `node <桥>/scripts/selftest.js`

## 六工具速查

| 工具 | 用途 | 关键参数 |
| --- | --- | --- |
| dev_load | 加载/热重载目标 | path（必）、mode:"plugin"\|"file"、allowSideEffects、allowHostModules（true 或 ["electron"]）、timeoutMs |
| dev_call | 调导出函数或生命周期特殊名 | name（必）、args、timeoutMs（1s–300s） |
| dev_list | 查加载状态/导出清单（不重载）、沙箱 dirty | — |
| dev_console | console + 未捕获异常（环形 500 条） | since、clear |
| dev_calls_log | utools.*/fs.*/require:* 调用流水 | since、clear |
| dev_cleanup | 逆序还原 db/kv/fs 写副作用 | force、dropAll |

## 错误码速查（统一 `{ok:false, code, message}`）

| code | 含义与处置 |
| --- | --- |
| PATH_NOT_FOUND / NO_PLUGIN_JSON / NO_PRELOAD | 路径或目标结构不对，先核对 path |
| SYNTAX_ERROR / REQUIRE_FAILED | 目标代码问题，看 message 里的栈；REQUIRE_FAILED 且 message 含「模块行为已拦截(require:xxx)」= 装载期顶层用了被拦模块，allowHostModules 放行后重载 |
| UNKNOWN_EXPORT / NOT_LOADED | 名字打错或没先 dev_load；dev_list 查清单（`__enter` 报它 = 目标未注册该生命周期回调，见上文 events） |
| TIMEOUT / ASYNC_TIMEOUT | 调大 timeoutMs；同步死循环超时后沙箱自动重建，不炸宿主 |
| SERIALIZE_FAILED | 返回值太大/太深，让目标返回摘要或分页 |
| DENIED_MODULE / DENIED_FETCH | 门控拦截；allowHostModules 放行或改设计 |
| DENIED_FS_UNTRACKED | 破坏性 fs 操作前态超限被拒（单文件 8MB/目录 500 文件/spill 64MB）——拆小或自管前态 |
| THROWN | 目标抛异常，message 带 stack；配合 `dev_console {since: consoleFrom}` 取现场 |

## 深入（都在桥仓库里）

- `README.md`——安装与冷启动回退、副作用与安全口径（门控是防意外的卫生措施，**不是安全边界**，dev_* 等价本机任意代码执行）、排障表
- `PLAN.md`——v3 设计与 v3.1 热修史，改桥行为前对照
- `scripts/gw-call.js`——网关直连兜底；`scripts/final-restore.js`——背靠背编排范式；`scripts/rt-check/`——真机回归目标（dev_load 后 dev_call `runAll(filter?)` / `probeHost`）；`scripts/selftest.js`——唯一本地测试；`scripts/fixtures/`——demo/loop 假目标
- 桥自身回归门槛：改 `preload/index.js` 后 selftest 全绿 + 真机 rt-check `runAll` 全绿
