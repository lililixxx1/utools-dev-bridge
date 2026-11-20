# 更新日志（CHANGELOG）

## [0.4.0] - 2026-11-20

### 新增（Agent 效率与测试覆盖面）
- **真窗口渲染层测试（UI 家族 5 工具）**：`dev_ui_open` / `dev_ui_eval` / `dev_ui_snapshot` / `dev_ui_screenshot` / `dev_ui_close`。基于 `utools.createBrowserWindow` + 过渡页 `preload/ui-host.html` 跳转与 `preload/ui-preload.js` 注入，自动按需启回环静态服务以支持 ES Module，且将窗口内的 `utools.*`/`fs.*` 写副作用统一汇入父进程 WAL 日志，实现 UI 测试同样可 `dev_cleanup` 还原。
- **批量背靠背测试运行器 `dev_run`**：单次往返完成可选 `load` + 多步 `steps`（支持 14 种 `expect` 断言运算符）+ 可选 `cleanup`，彻底规避多轮往返与隐藏页挂起。
- **异步任务队列 `dev_job`**：`dev_call {async:true}` 立即释放串口锁并返回 `jobId`；`dev_job`（独立于串口队列）支持查询列表、`waitMs` 长轮询、`cancel` 及 `sendProgress` 进度流。
- **调用内联现场（`dev_call include`）**：默认在成功时附带非空 `console`、失败时附带 `console` + `calls`（过滤探针，上限 30 条并附 `More` 标记），减少常规 3 次往返为 1 次。
- **默认凭证脱敏与 `reveal` 开关**：`getNativeId`、`getUser`、`dbCryptoStorage`、敏感 kv 键、敏感字段与敏感导出返回默认替换为 `<redacted len=...>`；`dev_load`/`dev_ui_open` 传 `reveal:true` 查看原文。脱敏仅作用于输出边界，写日志前态绝不脱敏。
- **越界写标注（`outsideWrites`）**：越出目标插件根目录的 `fs` 写操作在流水标 `outside:true`，并在 `dev_cleanup` 返回 `outsideWrites` 清单。
- **响应瘦身**：`dev_load` 默认省略函数源码 `preview` 并附 `exportsCount`/`exportsHash`；`dev_list` 默认不回传完整 `exports` 数组（`verbose:true` 展开）。

### 修复与架构改进
- **契约单一来源与模块化拆分**：将 1726 行单文件拆为 `preload/contract.js`、`state.js`、`serialize.js`、`journal.js`、`proxy.js`、`loader.js`、`shims/*`、`tools/*`；新增 `scripts/gen-docs.js --check` 自动同步校验 `plugin.json`、`README.md`、`SKILL.md` 与 `fallback-ui.html`，修正 `dev_cleanup` 过时临时目录描述。
- **生命周期补全与多回调修复**：新增 `__mainPushSelect` 捕获 `onMainPush` 第二参数 `onSelect`；同一生命周期注册多个回调时顺序执行并逐个 `await`，返回结果数组；目标执行期抛出的 `TIMEOUT`/`DENIED_*` 同样保留调用前游标与内联现场。
- **测试迁移与去私有化**：测试迁至零依赖 `node:test`（`test/*.test.js`）；脚本自动探测开发桥网关前缀（移除硬编码插件 ID 与私有配置文件路径）；新增 `scripts/bench-workflow.js`、`scripts/pack-stage.js`、`scripts/rt-suite.json`。

## [0.3.3] - 2026-10-31

### 性能与持久化
- **写日志 NDJSON 增量追加**：`journal.ndjson` 逐行追加替代每次全量 `JSON.stringify` + 重命名（1500 次 4KB kv 写 2746ms → 390ms）；损坏行按行隔离。
- **spill 迁至插件本地数据目录**：从系统临时目录迁至 `getPluginLocalDataPath()/devbridge-spill/`，启动自动迁移旧目录并兼容回读 `journal.json`；遗留超过 7 天按弃置会话整体清空并置 `spillWiped:true`。
- 环形缓冲改为均摊 O(1)；修复 `cleanupSpillDir` 删目录未重置 `mkdir` 标志导致的后续 `ENOENT` 误报。

## [0.3.2] - 2026-09-20

- 适配 uTools 8.0 开发者工具校验器硬限制：所有工具 `description` 压缩至 `<= 500` 字符（实测 `dev_call` 528 字符被拒装）；同步补全工具名下划线前缀 `utools_plugin_<id>_<名>` 动态探测与 `scripts/rt-run.js` 一键真机回归脚本。

## [0.3.1] - 2026-09-20

- uTools 8.0 校验器把 `features` 设为必填，新增 `main: "fallback-ui.html"` 与「开发桥」保活指令入口。

## [0.3.0] - 2026-09-20

- 适配 uTools 8.0 公测（Electron 34 / Node 20）：新增 `onPluginReady`/`onScheduleTrigger` 捕获（`__ready`/`__schedule`）、捕获目标 `utools.registerTool` 为 `__tool:<名>` 并补仿真 `ToolContext`（`sendProgress` 录入 `tool.progress:<名>`）、`requestSchedule` 保 thenable stub。

## [0.2.0] - 2026-09-16

- 修复 `bulkDocs` 新建文档与后续 `remove` 级联时的回滚孤儿残留；新增 `dev_cleanup {dropAll}`；新增 `fs` 写日志 WAL（8MB / 500 文件 / 64MB 上限）、Node 内置模块白名单门控、极简 DOM stub 与 `__out`/`__detach`/`__dbPull`/`__mainPush`/`__domReady` 生命周期模拟。
