# uTools 开发桥(dev-bridge)实施计划 v3(已吸收 plan-code-reviewer 审核意见:2 Blocker + 7 Major 全部修入)

> v2 计划已交付并实机验证(含冻结 API 代理不变量修复),其设计要点仍有效;本文仅覆盖 v3 增量,冲突处以 v3 为准。

## 目标
在已验证的 v2 桥基础上:堵住 Node 层逃逸口(白名单门控)、fs 写副作用纳入还原契约(WAL 写日志)、目标异步异常可观测、web 全局补齐、真机回归套件固化、生命周期/DOM stub 按需扩展。
**定位口径(M1,必须写进 README):门控是防意外/卫生措施,不是安全边界。** vm 上下文注入了宿主对象(Buffer/timers),`Buffer.constructor("return process")()` 一行即可拿到宿主 process,蓄意代码不可防;与既有"dev_* 等价本机任意代码执行、key 即边界"口径一致,不做修补(堵不完)。

## 非目标
- 防蓄意逃逸/安全隔离(vm 非边界,见上)
- ESM 目标(宿主开不了 `--experimental-vm-modules`,naive 转换风险大)
- 完整 DOM 承载(仅极简 stub);XHR(只门控 fetch)
- UI 截图验收、市场发布、取消在途调用

## P0 Node 层门控(B1/M5/M7)
### 模块三分类——白名单制,非黑名单
- **匹配规范化**:`request.replace(/^node:/, "")` 后再比对;以 `Module.builtinModules` 全集为基数:
- **deny**(默认拦截,`allowHostModules` 放行):child_process、worker_threads、cluster、http、https、http2、net、dgram、tls、dns、inspector、vm、v8、repl、readline、electron
- **map**(恒映射安全替身,比 deny 更兼容):`process`→makeProcessShim、`console`→makeConsole、`timers` 与 `timers/promises`→登记版(否则目标绕过 gen.timers,killTimers 契约失效)、`fs` 与 `fs/promises`→写日志 shim(见下节)、`module`→`{ createRequire: (f) => (r) => localRequire(f, r), builtinModules }`(兼容且封闭)、`buffer`→宿主 Buffer 透传
- **allow**(透传):path、util、events、assert、os、crypto、url、zlib、stream、string_decoder、perf_hooks 等
- **deny 模块实现** `makeDeniedModule(name)`:空白 shim 载体 + forwardTraps(同冻结 API 修复思路,不用原模块对象当代理目标);get 时录制 `require:<name>.<prop>` 且条目带 `denied:true`;事件注册族(on/once/off/send/addListener/removeListener/removeAllListeners/prependListener/prependOnceListener)noop+录制,**返回值可链式 noop**;其余属性被调用时 throw `err("DENIED_MODULE", ...)`(message 指引 allowHostModules);**每模块缓存单例**(`require('http') === require('http')` 保 identity)。
- **开关拆分(决策 2 裁决)**:`allowSideEffects`(utools 破坏性 API,语义不变)+ `allowHostModules`(Node 内置/electron 门控;`true` 全放行,或数组白名单如 `["electron"]`)。两开关正交,不按模块拆一堆开关。
- 已知可接受分歧(README 注明):deny 代理下 `typeof http.get === "function"` 为 true;`http.METHODS.includes` 会 TypeError;`.node` 原生模块透传绕过全部门控(不拦,说明即可)。
### 沙箱 web/Node 全局补齐表(M5)
vm context 实测缺:URL、URLSearchParams、TextEncoder、TextDecoder、AbortController、AbortSignal、atob、btoa、structuredClone、performance——全部**透传宿主**(无副作用)。**fetch 例外**:默认返回 **rejected Promise**(code=DENIED_FETCH,不用同步 throw,保 `.catch()` 语义与 thenable 分支);allowHostModules 放行时透传宿主 fetch,宿主无 fetch 则明确报错。
### 可观测(M7)
- 错误契约新增 code:`DENIED_MODULE` / `DENIED_FETCH` / `DENIED_FS_UNTRACKED`
- `dev_load` 返回的 warnings 汇总"本次装载已触发懒拒绝的模块清单"
- calls_log 拒绝/noop 条目带 `denied:true`

## P0 fs 写日志(决策 1 裁决:B2 + M3)
- **覆盖三套变体 × 四个入口**:callback / `*Sync` / promises;`require('fs')`、`node:fs`、`fs/promises`、`node:fs/promises`(后两个返回同一 promises 对象,但都映射 shim)
- **API 清单**:writeFile、appendFile、rm、rmdir、unlink、rename、copyFile、truncate、mkdir、symlink、link、`open/openSync`(写模式在 open 时抓前态)、`write/writeSync/closeSync`(fd 级)、createWriteStream(**创建流那一刻抓前态**,close 时 commit——此时文件尚未被写)
- **WAL**:前态先落盘 spill,再执行真实写(消除崩溃窗口;db put 的 curRev 崩溃缺失可接受,dev_cleanup 已有 `_safeGet` 兜底分支)
- **超限显式分级(M3)**,不许静默:
  - 破坏性操作(unlink/rm/rmdir/rename/truncate)超限 → **默认拒绝该次调用**(DENIED_FS_UNTRACKED,allowHostModules 放行)
  - 写类超限 → 放行,但 calls_log 条目带 `untracked:true`,dev_cleanup 返回 untracked 清单,dev_list 以 `untrackedJournal` 字段反映
  - 上限:单文件 8MB、单次目录快照 500 文件、**spill 总量 64MB**
- 还原:dev_cleanup 逆序还原内容/删除新建/恢复 rename(**显式降级:不做系统敏感路径告警**,测试产物路径由 agent 自律;真实调用失败时条目回滚,防 cleanup 误删既有文件)

## P1 真机回归套件 rt-check(M6)
- `scripts/rt-check/` 目标插件,导出:
  - `runAll(filter?)`——断言用例支持过滤参数/分组返回,规避序列化 100 条截断
  - `probeHost()`——宿主环境探测:fetch 存在性、getPath 各 name 实际返回值、utools 冻结状态、uTools/Electron 版本;一次实机运行钉死全部"待验证假设"
- 用例:冻结不变量(getNativeId 顶层读+调)、in/Object.keys 转发、db/dbStorage 写+cleanup、copyText stub、RISKY 模块懒拒绝(throw+calls_log denied)、`node:` 前缀规范化、fs 写日志+cleanup 还原、__enter/__out 触发、代理 identity、console.table 不炸、web 全局存在性
- **两阶段重启用例(M6)**:阶段 A 写入并返回标记 → 用户重启 uTools → 阶段 B 先 dev_cleanup(不依赖 gen)→ 断言还原——专门覆盖 journal 持久化的核心承诺
- 流程前提:先确认 uTools 开发者工具是否支持单插件"重新加载";支持则全程只需一次重启,不支持则 P0+P3 合并一轮改动

## P2 能力扩展(按优先级,多目标可裁剪)
- **生命周期(优先)**:dev_call 特殊名扩展 `__out` / `__detach` / `__dbPull(args=[{docs}])` / `__mainPush(args=[{code,type,payload}])`,触发 gen.events 登记回调,行为同 __enter
- **DOM 极简 stub**:getElementById/querySelector 恒 null、createElement 返回惰性记录元素、addEventListener noop+录制;可选 `__domReady` 特殊名显式触发;文档明示"选择器恒 null、DOMContentLoaded 永不触发,回调内做 DOM 的仍不承载"
- **多目标代际(可裁剪,决策 4)**:单 agent 串行迭代单插件占绝对多数,多 vm context 内存代价最高——仅当真实需要时做。若做:Map 键=规范化 entry+mode;ring/journal 条目带 `target` 字段,dev_console/dev_calls_log 的 `target` 参数做**真过滤**(精确匹配);journal 条目带 target、dev_cleanup 加可选 target;killTimers 遍历全 Map;restoreLast 旧单对象格式一次性迁移

## P3 可靠性小修集
- **代理缓存**:代际级 Map,键 (realObj, apiPath) 二元组,wrapFnNamespace 一并入缓存(修 `utools.db === utools.db` identity + 性能);存 gen 上,热重载即失效(保 v2 G8 语义)
- **console 补全**:table/trace/dir/time/timeEnd/timeLog/group/groupEnd/clear/assert/count,录制或安全 noop(现在 console.table 直接 TypeError)
- **journal 持久化(决策 5 裁决)**:fs 前态**每文件单独存 spill**(`getPath("temp")/devbridge-journal/`,try/catch + fallback `os.tmpdir()` + mkdir -p;spill 写入必须用桥自身 require('fs'),绝不经沙箱 shim,否则递归);JSON 只存元数据+文件引用(dbStorage 放不下 8MB 级前态,弃用);落盘时机=WAL 写前;桥顶层回灌,存在未还原 journal 时 dev_list/dev_load 显式提示;还原成功删 spill;丢最旧时 cleanup 返回 `truncated:true`
- **timers/microtask 回调 try/catch + 录入 ringConsole(level:"uncaught"),不重抛**(M2——现在目标异步异常直接冒宿主 uncaughtException);process.nextTick 的 Promise 包装同理
- devCall 异步 guard 成功路径 clearTimeout(小泄漏)
- **dev_cleanup 失败条目保留(M4)**:还原成功才移除 journal 条目;失败的保留可重试,返回 `retryable:true` + 完整细节(现在无条件 `journal.length = 0`)
- 文档同步:plugin.json 六工具 **description 文本**更新(不只 schema);README 安全边界章节重写(Node 门控表 + fs 写日志边界 + "防意外非安全边界"口径 + vm 逃逸与 .node 透传说明);修正 v2 契约漂移——`dev_calls_log detail:true` 分页从未实现,v3 从契约删除

## 工具契约增量
1. `dev_load`:`+allowHostModules?: boolean | string[]`(默认 false);返回 `+deniedModules` warnings
2. `dev_call`:`+__out/__detach/__dbPull/__mainPush`(可选 `__domReady`)
3. `dev_cleanup`:返回 `+untracked 清单`、`+truncated`、失败条目 `retryable`;`{force:true}` 放弃重试并清空写日志(spill 永久悬挂时的出口)
4. 新错误码:`DENIED_MODULE / DENIED_FETCH / DENIED_FS_UNTRACKED`
5. (可裁剪)`target?:` 参数与过滤语义:dev_console/dev_calls_log 按 entry.target 精确匹配

## 实施顺序
1. **第一轮 = P0 全部 + P3 全部**(影响错误契约/还原契约的改动合并,避免多次重启;若实机确认 uTools 支持单插件重载则拆开)
2. selftest.js 同步扩用例:拒绝模块、`node:` 前缀、fs 三变体还原、timers 录制、identity、console 补全、web 全局、cleanup 失败保留
3. 用户重启 uTools → 我跑 rt-check `runAll` + `probeHost` 全绿
4. **两阶段重启用例**单独走(阶段 A → 重启 → 阶段 B),全程共 2 次重启
5. 第二轮 = P2 生命周期 + DOM stub(低风险)→ 再重启一次验证
6. 多目标:仅当真实需要时实现

## 风险表
| 风险 | 对策 |
|---|---|
| `node:` 前缀 / 新内置模块漏网 | 白名单制(builtinModules − allow),deny 为默认兜底 |
| fs 前态超限静默不还原 | 破坏性超限默认拒绝;写类 untracked 标记;cleanup 返回清单 |
| temp 被系统清理 → spill 丢 | cleanup 报 failures + retryable;接受为既定弱点(README 注明) |
| vm 逃逸(非安全边界) | 文档口径"防意外非安全";不修补 |
| uTools 不支持单插件重载 | P0+P3 合并一轮,全程重启 2 次(含两阶段用例) |
| 多 vm context 内存 | 多目标默认不做(可裁剪) |
| rt-check 结果被序列化截断 | runAll 过滤参数/分组返回 |

## v3.1 热修(2026-09-16,airss 全功能实测发现)

- **缺陷**:devCleanup 逆序回放中 bulkDocs 分支只还原有前态文档,无前态(新建)文档永不删除——先执行的 remove 条目还原会把文档复活,留下孤儿(airss 实测残留 6 个 item/itemfull,统计 dbRestore:12/dbDelete:1 吻合推导)。修复:无前态 p 补 else 删除分支(_safeGet 取当前文档→REAL.db.remove→stats.dbDelete++;不存在则幂等跳过)。selftest 5c 复刻实测序列,反向实验证明旧实现必挂。
- **新增 dev_cleanup {dropAll}**:跳过回放直接清空写日志(先 killTimers(M1 审查发现:否则目标残留定时器在清理后继续写库,终态不可信)),返回 dropped/droppedEntries。用途:实测后确认终态、清除历史遗留孤儿(避免"回放 remove→还原孤儿"循环)。与 force 同传 dropAll 优先。
- 附带:gw-call.js 网关直连排障脚本(客户端 schema 缓存缺新参数/30s 掐断时的兜底;仅回环、key 不打印、工具级错误非零退出)。
- 审查:plan-code-reviewer 裁决"修后可合入",M1(killTimers)/M2(上线验证:重载后以 tools/list 出现 dropAll、响应 dropped:true 为准)/s1(droppedEntries)/s2(README·description 口径)/s3(5d 定时器断言+5e bulk 覆盖还原) 全部落实;m1(retryable 过度还原)以文档口径记录。

## v3.2 uTools 8.0 公测适配(2026-09-20)

对照 next.u-tools.cn 8.0 文档(公测 beta.6;运行时 Electron 34.5.8 / Chromium 132 / Node 20.19.1)的差异更新。桥赖以工作的底座(plugin.json `tools` 字段 + `utools.registerTool()` + 内置 MCP 服务,设置→AI 设置→MCP 服务)在 8.0 已正式化,机制不变。

- **新增生命周期捕获**:`onPluginReady`(Runtime 等 callback 完成再进入)、`onScheduleTrigger`(定时任务触发,插件未运行会被拉起)入 EVENT_APIS——此前未拦截,目标注册会真挂到宿主 Runtime(副作用泄漏);对应 dev_call 特殊名 `__ready`(args=[])、`__schedule`(args=[{code}])。
- **registerTool 捕获(核心)**:目标 preload 调 `utools.registerTool(name, handler)` 不再纯 no-op,handler 捕获进 `gen.tools`;dev_call 新特殊名 `__tool:<name>`(args=[params])按 MCP ToolContext 形态补仿真 ctx(`{requestId:"dev_call", sendProgress}` ,sendProgress 录入调用流水 `tool.progress:<name>`);dev_load/dev_list 返回 `tools` 清单。目标 8.0 MCP 工具处理器从此可在桥内被 agent 直接驱动测试。未注册名报 UNKNOWN_EXPORT 并列已注册清单。
- **定时任务 API 入 stub**:`requestSchedule`(弹用户确认+创建持久任务)、`removeSchedule`(删真任务)默认 stub;`getSchedules` 只读透传。
- **plugin.json**:version 0.3.0,六工具 description 同步新特殊名;`tools` 字段格式与 8.0 文档一致(对象 keyed by name,description+inputSchema 必填),无需结构变更。文档把 `features` 标为必填,但实测 AI-only(tools-only)清单仍被开发者工具容忍且冷启动常驻——保持无 main/features 现状,冷启动失败回退方案见 README。
- selftest 新增第 19 组用例(12 断言):8.0 事件登记/触发、tools 清单、`__tool:` 调用+未知名、requestSchedule/removeSchedule stub 宿主零触达;全套通过。
