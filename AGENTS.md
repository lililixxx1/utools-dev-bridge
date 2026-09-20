# AGENTS.md — utools-dev-bridge 工作须知

uTools 插件开发测试桥:**工具面纯 AI 驱动,无功能 UI**(plugin.json:logo/preload/tools + fallback-ui.html 保活入口,8.0 校验器必填 features)。让 agent 经 uTools MCP 网关(`http://127.0.0.1:3501/mcp`)沙箱加载/调用/调试任意 uTools 插件的 preload,并还原测试副作用。git 仓库(公开于 https://github.com/lililixxx1/utools-dev-bridge),无 npm 依赖、无构建/打包步骤。

## 目录

- `preload/index.js` — 桥的全部实现(单文件 ~1500 行,CommonJS)。文件头注释是权威:机制总览 + 全部错误码契约(PATH_NOT_FOUND/DENIED_MODULE/DENIED_FETCH/DENIED_FS_UNTRACKED/TIMEOUT 等),改契约先改头注释。
- `plugin.json` — 清单 + 六个 MCP 工具(dev_load/dev_call/dev_list/dev_console/dev_calls_log/dev_cleanup)的 description 与 inputSchema。
- `scripts/selftest.js` — 纯 Node 自测(mock utools 全局后 require 桥,验证全链路)。
- `scripts/rt-check/` — 真机回归目标插件(`runAll(filter?)` + `probeHost()`,经 dev_* 工具在真实 uTools 里跑)。
- `scripts/rt-run.js` — 真机回归一键驱动(单进程背靠背:前缀探测 → dev_load → runAll/probeHost/v80 用例 → `__tool:` 端到端 → 还原核对)。
- `scripts/fixtures/` — demo-plugin / loop-plugin 假目标。
- `scripts/gw-call.js` — 网关直连兜底(绕过 MCP 客户端 schema 缓存与 30s 掐断;仅回环,key 不打印)。
- `scripts/gsm-harness.js` / `scripts/final-restore.js` — 经桥跑的业务插件 harness 示例 / 单进程背靠背还原范式(见 gotchas)。
- `README.md` — 工作流、副作用与安全约定(必读)、排障表;`PLAN.md` — v3 设计与 v3.1 热修史。改桥行为前两份都要对照。

## 命令

```bash
node scripts/selftest.js        # 唯一本地测试;改 preload/index.js 后必跑(在仓库根目录下)
node scripts/gw-call.js <tool> '<json>'   # 直连网关调 dev_* 工具(自动读本机 key、探测插件前缀:8.0 为 utools_plugin_<id>_<名>,旧版 utools.<id>.<名>)
git push                        # 改动直接提交 main 并推送;提交信息走 Conventional Commits、全中文
```

真机回归:`node scripts/rt-run.js` 一键(单进程背靠背,含 v80 用例与还原核对);或手工经 dev_load 加载 `scripts/rt-check` 后 dev_call `runAll`/`probeHost`。改 preload 后需在 uTools 开发者工具里重载插件(或重启 uTools)才生效——冷启动回退见 README。

## 硬性约定

- **只写 CommonJS**("use strict");一期不支持 ESM 目标,桥自身也勿引入 ESM/TS/打包器。
- 注释与文档全中文,风格随现有文件(密集中文注释 + 表格)。
- **冻结不变量**:真实 utools API 整树只读不可配置(Object.freeze)。桥的深代理 get 对不可配置属性必须返回原值、不得返回包装;selftest 里 mock utools 必须 freeze(有回归用例)。
- **plugin.json inputSchema 禁用 oneOf 等组合构造**——uTools 校验器拒收会导致整个插件加载失败。改工具 schema 时同步更新 description 文本(不只 schema)。
- 桥内部一律用 `REAL = utools` 直连真实 API,不经自己的代理。
- 错误返回统一 `{ok:false, code, message}`;新增错误码要写进 preload 头注释与 README。

## 已知 gotchas(实机踩过)

- **uTools 会挂起隐藏页**:桥的渲染进程闲置后定时器/回调可能不触发。多步网关操作要**单进程背靠背**完成(范式见 `scripts/final-restore.js`),不要依赖跨 dev_call 的延迟回调。
- 沙箱定时器可能 schedule 有、fire 无(宿主挂起队列)——目标代码测试别依赖延迟回调,改同步或轮询。
- MCP 客户端会话会缓存旧工具 schema,新参数(如 allowHostModules/dropAll)被滤掉时用 `scripts/gw-call.js` 直连。
- **8.0 网关工具名改版**:`utools_plugin_<id>_<名>`(下划线),旧 `utools.<id>.<名>` 已失效——任何直连脚本都经 tools/list 动态探测前缀(gw-call.js/rt-run.js/final-restore.js 已内置),不要写死。
- 网关 key 在 uTools 重登/重置后轮换(403 = 重新复制到 `~/.zcode/cli/config.json`),key 绝不入任何仓库/笔记。
- dev_cleanup 语义:`dropAll` 跳过回放(仅人工核对终态后用)、`force` 放弃失败条目;retryable 重试可能过度还原。还原模型假设无沙箱外并发写同一 db。
- 安全口径:门控是防意外的卫生措施,**不是安全边界**(vm 注入宿主对象可逃逸、`.node` 透传绕过门控);网关仅绑回环,key 即边界。不要试图"修补"逃逸口(PLAN 明确非目标)。

## 交付状态(2026-09-18)

v3.1 闭环:airss 全功能实测完毕,孤儿文档缺陷已修(bulkDocs 无前态回滚删除,selftest 5c 复刻),终态已清零。新增能力:生命周期特殊名(`__enter/__out/__detach/__mainPush/__dbPull/__domReady`)、DOM 极简 stub(选择器恒 null)、fs 写日志 WAL(前态先落盘,8MB/500 文件/64MB 上限)。

2026-09-20 v3.2(uTools 8.0 公测适配,plugin.json 0.3.0):新生命周期 `__ready`/`__schedule` 入 EVENT_APIS(不拦截会真挂宿主);目标 `registerTool` 捕获进 gen.tools(null 原型),`dev_call __tool:<名>` 按 MCP ToolContext 仿真调用(dev_load/dev_list 返回 tools 清单);`requestSchedule`/`removeSchedule` 入 stub(requestSchedule stub 保 thenable,getSchedules 只读透传)。plan-code-reviewer 审核:可合入(无 Blocker/Major),4 Minor 已修(thenable/null 原型/非函数 handler 警告/tool.progress 文档),selftest 114 断言全绿,rt-check 增 3 个 v80 真机用例待下次实机回归。8.0 运行时 Electron 34/Node 20;`tools` 字段与内置 MCP 服务已正式化,桥底座机制不变。

2026-09-20 热修(0.3.1):真机反馈 8.0 开发者工具安装报"plugin.json features 无效"——8.0 校验器把 features 标必填,AI-only(tools-only)清单不再被容忍。plugin.json 内置 `main: fallback-ui.html` + `features`(「开发桥」保活指令);重启后 dev_* 无响应时打开一次「开发桥」拉起 preload。

2026-09-20 热修(0.3.2):8.0 开发者工具报 tools description 超 500 字符拒装(v3.2 扩写 dev_call 至 528)。已压至 413;**经验:工具 description ≤500 硬上限,selftest 已加合规断言——改 plugin.json 后先跑 selftest 再上真机**。已实证的 8.0 校验器约束:features 必填、工具 description 非空且 ≤500、inputSchema 禁 oneOf 等组合构造。

2026-09-20 8.0 真机回归全绿:`rt-run.js` 12 项断言全过(appVersion 8.0.0-beta.6/Node 20.19.1;runAll 22 例含 v80、`__tool:rt8_probe` 端到端、还原终态清零)。回归中发现 8.0 网关工具名改版(`utools_plugin_<id>_<名>`),gw-call.js/final-restore.js 改 tools/list 动态探测前缀,并固化 `scripts/rt-run.js` 一键回归。

2026-09-20 审核落实(cffbe7b 复审,裁决"修后可合入",无 Blocker):2 Major 全修——① gw-call.js 全名解析改 tools/list 精确匹配优先(8.0 下划线全名不含点,原 `includes(".")` 判全名会误报 not found);② rt-run.js 终态断言改直证(dev_cleanup `failures` 为空 + dev_list 无 `pendingRestore`/`untrackedJournal`;原"二次 cleanup 计数为零"对失败条目保留重试的场景无鉴别力)。3 Minor + 3 Nit 同批:rpc 加 !res.ok(403 提示 key 轮换)与 isError 守卫、README 前缀笔误、runAll `total>=22` 防用例静默删减、SSE 判定正则三处统一锚定、去掉末尾 process.exit。m3(抽 gw-lib.js 公共模块)未采纳,按审核备选方案维持脚本自包含、匹配规则三处统一——本仓排障脚本按约定各自独立、可整份复制。真机复跑 rt-run 12 项全绿;gw-call 裸名/8.0 全名/错名三路径验证通过。

2026-09-18:建 git 仓库并公开(github.com/lililixxx1/utools-dev-bridge),初始提交收录全部 20 文件;文档同步公开口径。
