# AGENTS.md — utools-dev-bridge 工作须知

uTools 插件开发测试桥:**纯 AI 插件,无 UI**(plugin.json 只有 logo/preload/tools)。让 agent 经 uTools MCP 网关(`http://127.0.0.1:3501/mcp`)沙箱加载/调用/调试任意 uTools 插件的 preload,并还原测试副作用。git 仓库(公开于 https://github.com/lililixxx1/utools-dev-bridge),无 npm 依赖、无构建/打包步骤。

## 目录

- `preload/index.js` — 桥的全部实现(单文件 ~1500 行,CommonJS)。文件头注释是权威:机制总览 + 全部错误码契约(PATH_NOT_FOUND/DENIED_MODULE/DENIED_FETCH/DENIED_FS_UNTRACKED/TIMEOUT 等),改契约先改头注释。
- `plugin.json` — 清单 + 六个 MCP 工具(dev_load/dev_call/dev_list/dev_console/dev_calls_log/dev_cleanup)的 description 与 inputSchema。
- `scripts/selftest.js` — 纯 Node 自测(mock utools 全局后 require 桥,验证全链路)。
- `scripts/rt-check/` — 真机回归目标插件(`runAll(filter?)` + `probeHost()`,经 dev_* 工具在真实 uTools 里跑)。
- `scripts/fixtures/` — demo-plugin / loop-plugin 假目标。
- `scripts/gw-call.js` — 网关直连兜底(绕过 MCP 客户端 schema 缓存与 30s 掐断;仅回环,key 不打印)。
- `scripts/gsm-harness.js` / `scripts/final-restore.js` — 经桥跑的业务插件 harness 示例 / 单进程背靠背还原范式(见 gotchas)。
- `README.md` — 工作流、副作用与安全约定(必读)、排障表;`PLAN.md` — v3 设计与 v3.1 热修史。改桥行为前两份都要对照。

## 命令

```bash
node scripts/selftest.js        # 唯一本地测试;改 preload/index.js 后必跑(在仓库根目录下)
node scripts/gw-call.js <tool> '<json>'   # 直连网关调 dev_* 工具(自动读本机 key、补 utools.dev_zii2hjtj. 前缀)
git push                        # 改动直接提交 main 并推送;提交信息走 Conventional Commits、全中文
```

真机回归:uTools 里经 dev_load 加载 `scripts/rt-check`,dev_call `runAll`/`probeHost`,断言全绿。改 preload 后需在 uTools 开发者工具里重载插件(或重启 uTools)才生效——冷启动回退见 README。

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
- 网关 key 在 uTools 重登/重置后轮换(403 = 重新复制到 `~/.zcode/cli/config.json`),key 绝不入任何仓库/笔记。
- dev_cleanup 语义:`dropAll` 跳过回放(仅人工核对终态后用)、`force` 放弃失败条目;retryable 重试可能过度还原。还原模型假设无沙箱外并发写同一 db。
- 安全口径:门控是防意外的卫生措施,**不是安全边界**(vm 注入宿主对象可逃逸、`.node` 透传绕过门控);网关仅绑回环,key 即边界。不要试图"修补"逃逸口(PLAN 明确非目标)。

## 交付状态(2026-09-18)

v3.1 闭环:airss 全功能实测完毕,孤儿文档缺陷已修(bulkDocs 无前态回滚删除,selftest 5c 复刻),终态已清零。新增能力:生命周期特殊名(`__enter/__out/__detach/__mainPush/__dbPull/__domReady`)、DOM 极简 stub(选择器恒 null)、fs 写日志 WAL(前态先落盘,8MB/500 文件/64MB 上限)。

2026-09-20 v3.2(uTools 8.0 公测适配,plugin.json 0.3.0):新生命周期 `__ready`/`__schedule` 入 EVENT_APIS(不拦截会真挂宿主);目标 `registerTool` 捕获进 gen.tools,`dev_call __tool:<名>` 按 MCP ToolContext 仿真调用(dev_load/dev_list 返回 tools 清单);`requestSchedule`/`removeSchedule` 入 stub(getSchedules 只读透传)。8.0 运行时 Electron 34/Node 20;`tools` 字段与内置 MCP 服务已正式化,桥底座机制不变;真机升级 beta 后需重载插件,若 tools/list 无 dev_* 走 README 冷启动回退。

2026-09-18:建 git 仓库并公开(github.com/lililixxx1/utools-dev-bridge),初始提交收录全部 20 文件;文档同步公开口径。
