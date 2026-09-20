# dev-bridge — uTools 插件开发测试桥

让 AI agent(经 uTools MCP)自主加载、调用、调试任意 uTools 插件的 preload 逻辑,消除"开发者插件+人肉测试"循环。**纯 AI 插件,无 UI**(plugin.json 只有 logo/preload/tools)。

> uTools 8.0 公测适配版(v0.3.0):新增 `__ready`/`__schedule` 生命周期触发、目标 `registerTool` 捕获为 `__tool:<名>` 可调、定时任务 API(requestSchedule/removeSchedule)默认 stub;底座(plugin.json `tools` + 内置 MCP 服务)8.0 已正式化,机制不变。

> 仓库:https://github.com/lililixxx1/utools-dev-bridge

## 目录结构

| 路径 | 说明 |
|---|---|
| `preload/index.js` | 桥的全部实现(单文件 CommonJS;文件头注释 = 机制总览 + 错误码契约,改契约先改它) |
| `plugin.json` | 插件清单 + 六个 dev_* 工具的 description/inputSchema |
| `fallback-ui.html` / `logo.png` | 冷启动回退保活页(见下文)/ 图标 |
| `scripts/selftest.js` | 纯 Node 自测(mock utools 后 require 桥,验证全链路;改 preload 后必跑) |
| `scripts/rt-check/` | 真机回归目标插件(`runAll(filter?)` / `probeHost()`) |
| `scripts/fixtures/` | demo-plugin / loop-plugin 假目标插件 |
| `scripts/gw-call.js` | 网关直连兜底(schema 缓存 / 30s 掐断时用;仅回环,key 不打印) |
| `scripts/gsm-harness.js` | github-stars-manager-for-utools 存储层真机 harness(经桥跑的业务插件断言示例) |
| `scripts/final-restore.js` | 单进程背靠背终态还原范式(airss 孤儿清除实例) |
| `AGENTS.md` / `PLAN.md` | 工作须知 / v3 设计与 v3.1 热修史 |

## 一次性安装(唯一人工步骤)

1. uTools → 开发者工具(开发者插件)→ 加载本目录(`utools-dev-bridge/`,选含 plugin.json 的目录)
2. **重启 uTools**(验证 AI-only 插件冷启动常驻:重启后不打开任何插件,tools/list 里应出现 `dev_*` 六工具)
3. agent 侧:ZCode `~/.zcode/cli/config.json` 的 `mcp.servers.utools` 指向 `http://127.0.0.1:3501/mcp`(已配好),key 用 uTools 设置 → AI Agent 连接里复制的值

### 回退:冷启动失败时
若重启后 tools/list 没出现 dev_*,说明该版本不自动执行 AI-only preload。给 plugin.json 加:
```json
"main": "fallback-ui.html",
"features": [{ "code": "devbridge", "explain": "开发桥(保活入口)", "cmds": ["开发桥"] }]
```
并在 uTools 里打开一次"开发桥"让 preload 执行(每次重启 uTools 后需打开一次)。

## 本地自测(无需 uTools)

```bash
node scripts/selftest.js   # 在仓库根目录下跑;mock utools 全局,验证桥全链路
```

改 `preload/index.js` 后必跑;通过再走真机回归(下节)。

## agent 工作流(测试循环)

```
dev_load {path: "<目标插件根目录>"}          # 或 mode:"file" + 单 js 文件
  → 返回可调用清单(events/warnings 一并看;装载期模块拦截会汇总在 warnings)
dev_call {name: "airss.db.getFeeds", args: []}
  → {ok, result, consoleFrom/callsFrom 游标}
dev_console {since: <游标>}                  # 增量取 console/异常(含 level:"uncaught" 异步异常)
dev_calls_log {since: <游标>}                # 增量取调用流水(utools.*/fs.*/require:* 拦截;含 stubbed/denied/untracked 标记)
改代码 → 再 dev_load(热重载,services 级生效)→ dev_call ……
dev_cleanup                                 # 测完还原 db/dbStorage/dbCryptoStorage/fs 写副作用
```
- `dev_call {name:"__enter", args:[{code,type,payload,from}]}` 触发目标注册的 onPluginEnter;同类特殊名:`__out`/`__detach`(onPluginOut/Detach)、`__mainPush`(args=[{code,type,payload}])、`__dbPull`(args=[{docs}])、`__domReady`(触发 document 的 DOMContentLoaded 监听);8.0 新增:`__ready`(onPluginReady,args=[])、`__schedule`(onScheduleTrigger,args=[{code}])
- 8.0 MCP 工具测试:目标 preload 里 `utools.registerTool(name, handler)` 注册的处理器会被捕获(dev_load/dev_list 返回 tools 清单),`dev_call {name:"__tool:<名>", args:[参数对象]}` 直接调用——自动补仿真 ToolContext(sendProgress 录入流水),不必真开 MCP 会话即可驱动目标的工具逻辑
- DOM:沙箱有极简 document stub——getElementById/querySelector **恒 null**、createElement/addEventListener 惰性记录;"顶层仅注册回调"的插件可装载,回调内做真实 DOM 的仍不承载
- 长任务(AI/网络)`timeoutMs` 按需调大(默认 30s)
- 交叉验证:`__enter` 之后 `dev_calls_log` 看目标都调了哪些 utools API
- 目标要真用 electron/网络等被拦模块时:`dev_load {allowHostModules: true}` 或白名单 `["electron"]`

## 副作用与安全约定(必读)

**定位口径:门控是"防意外"的卫生措施,不是安全边界。** vm 沙箱注入了宿主对象(Buffer/timers 等),蓄意代码可经 `Buffer.constructor("return process")()` 逃逸——永远堵不完,也不试图堵。dev_* 等价于**本机任意代码执行 + 任意路径读取**;3501 仅绑回环,x-mcp-key 即边界,key 不入任何仓库/笔记。

- **破坏性 utools API 默认 stub**(剪贴板/键鼠模拟/shell/通知/录屏/窗口/AI 计费/outPlugin/定时任务创建删除等),调用流水里标 `stubbed:true`;确需真执行才 `dev_load {allowSideEffects:true}`
- **Node 内置模块白名单门控**(`node:` 前缀已规范化,防绕过):
  | 类别 | 模块 | 行为 |
  |---|---|---|
  | map(安全替身) | process/console/timers/timers-promises/fs/fs-promises/module | shim:process 白名单、timers 登记、fs 写日志、module.createRequire 封闭回 loader |
  | allow(透传) | path/os/util/events/assert/crypto/url/zlib/stream 等只读系 | 原样透传 |
  | 默认拒绝 | child_process/worker_threads/cluster/http(s)/http2/net/dgram/tls/dns/inspector/vm/v8/repl/readline/**electron** 及未列入白名单的一切 | **懒拒绝**:import 不炸(事件注册族方法 noop+录制,可链式),真正调用时抛 `DENIED_MODULE`;`allowHostModules:true` 或 `["electron"]` 白名单放行 |
- **fetch 默认拦截**(rejected Promise,code=DENIED_FETCH);沙箱已补齐 URL/TextEncoder/AbortController 等 web 全局
- 已知分歧(可接受):denied 模块上 `typeof m.get === "function"` 为 true、常量属性访问会得到函数;`.node` 原生模块透传绕过门控
- **db/dbStorage/dbCryptoStorage 真实执行但记写日志**;**fs 写操作真实执行 + WAL 写日志**(前态先落盘再执行):`dev_cleanup` 按前态还原文件内容/删除新建/恢复 rename;上限:单文件 8MB、目录快照 500 文件、spill 总量 64MB——**破坏性操作(unlink/rm/rename/truncate 等)前态超限默认直接拒绝**(DENIED_FS_UNTRACKED),写类超限放行但 `untracked` 标记不还原;journal 跨 uTools 重启持久化(临时目录 spill,系统清理会失去还原依据,`truncated:true` 会明示);还原失败条目保留可重试(retryable;注意重试可能**过度还原**——配对条目已执行完毕,必要时用 dropAll 或手工 db.remove 处置)
- **bulkDocs 新建的文档在回滚时会被删除**(与 put 一致):逆序回放会先执行更晚 remove 条目的还原(复活文档),再由 bulkDocs/put 的无前态回滚删除——两动作配对,孤儿不会残留(2026-09-16 airss 实测缺陷已修,回归用例见 selftest 5c)
- `dev_cleanup {dropAll:true}`:**跳过回放**直接清空写日志(先杀目标定时器),现场保持现状。仅在已人工核对终态符合预期时使用(如实测后确认终态、清除历史遗留孤儿文档);与 force 同传时 dropAll 优先,以响应 `dropped:true` 判定生效
- 还原模型假设 journal 记录的操作之间无沙箱外并发写:若同一 utools.db 还有**其他进程在写**(如插件本体同时也在 uTools 里运行),cleanup 可能误删/误还原它的写入;测试期间避免目标插件的正式实例并行运行
- 网关 key 会在 uTools 重登/重置后轮换,403 时去 uTools 设置重新复制并更新 config.json

## 能力边界

- 一期仅 CommonJS(`require`);ESM-only 依赖不支持(报错有提示);`.node` 原生模块透传(绕过门控,风险自担)
- 渲染期 DOM 不可用(UI 插件的 renderer 逻辑测不到);二期走 createBrowserWindow 真窗口+截图
- 同步死循环受 `timeoutMs` 硬保护(超时→沙箱自动重建);但 **await 之后的同步死循环无法打断**,残余风险自担;目标异步回调内的异常会以 level:"uncaught" 录进 dev_console,不会炸宿主
- 目标代码读到的是 process 白名单 shim(platform/versions/env 只读拷贝等),`process.exit` 被拦截

## 排障

| 症状 | 处置 |
|---|---|
| tools/list 无 dev_* | 冷启动回退(上文);确认开发者插件里已加载且未禁用;**plugin.json 的 inputSchema 避免用 oneOf 等组合构造**(实测 uTools 校验器拒收,导致整个插件加载失败) |
| dev_call 返回 THROWN | 看 message 里的 stack;dev_console{since:consoleFrom} 取现场 |
| 沙箱脏(dirty) | 任何一次 dev_* 会自动重建;dev_list 可查 dirty 状态 |
| 网关 403 | key 轮换,重复制 |
| 异步 dev_call 长于 ~30s 被客户端掐断 | MCP 客户端有自身调用超时;超长异步任务改为目标内自录结果(写 db/console),事后读取,不要靠 dev_call 同步等待;或用 `node scripts/gw-call.js <tool> '<json>'` 直连网关(长超时,且不受客户端 schema 缓存影响) |
| MCP 客户端把 dev_load 的新参数(如 allowHostModules)滤掉 | 会话缓存的工具 schema 落后于 plugin.json;用 scripts/gw-call.js 直连网关调用(自动读本机 key、补 `utools.<pluginId>.` 前缀) |
| 沙箱定时器不触发(真机已观察到) | timer.schedule/timer.fire 已全程入 dev_calls_log;若 schedule 有而 fire 无,说明宿主挂起该渲染进程的定时器队列——目标代码不要依赖跨 dev_call 的延迟回调,改同步或轮询 |
