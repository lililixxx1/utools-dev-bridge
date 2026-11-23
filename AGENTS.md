# AGENTS.md — utools-dev-bridge 工作须知

uTools 插件开发测试桥（**纯 AI 驱动，无功能 UI**，`plugin.json` 保留 `fallback-ui.html` + `features` 满足 uTools 8.0 校验）。经 uTools MCP 网关（`http://127.0.0.1:3501/mcp`）驱动目标插件 preload 沙箱与真实 BrowserWindow UI，并支持 WAL 副作用还原。零 npm 依赖、零构建/打包步骤。

## 目录结构

- `preload/contract.js` — 契约单一来源（版本、上限常量、错误码、13 工具 schema）。改工具或错误码只改这里，再跑 `node scripts/gen-docs.js`。
- `preload/index.js` — 引导保护网与 13 工具注册入口（`dev_job` 不进 `serialized` 队列，其余 12 工具串行化）。
- `preload/state.js` / `serialize.js` / `journal.js` / `proxy.js` / `loader.js` — 状态工厂、序列化与脱敏、WAL 还原、深代理、容器无关加载策略。
- `preload/shims/` — `process` / `console` / `timers` / `denied` / `fs` / `dom`。
- `preload/tools/` — `load` / `call` / `run` / `job` / `cleanup` / `ui`。
- `preload/ui-host.html` / `ui-preload.js` — UI 测试子窗口过渡页与注入脚本。
- `test/` — 基于内置 `node:test` 的模块化测试套件（`scripts/selftest.js` 作为统一入口）。
- `scripts/gen-docs.js` — 契约同步与 `--check` 校验。
- `scripts/rt-run.js` / `scripts/rt-suite.json` / `scripts/rt-check/` — 真机一键回归。
- `scripts/gw-call.js` — 网关直连兜底（支持 `UTOOLS_MCP_KEY` 环境变量）。
- `scripts/pack-stage.js` / `scripts/bench-workflow.js` — 最小打包暂存 / 往返效率对比。
- `skills/` — 配套 AI 技能公开分发版（`utools-dev-bridge/` + `utools-plugin-dev/`）。

## 常用命令

```bash
npm test                                    # 运行全部 node:test 用例
node scripts/selftest.js                    # 兼容入口，同上
node scripts/gen-docs.js                    # 从 contract.js 同步生成 plugin.json/README/SKILL/fallback-ui
node scripts/gen-docs.js --check            # 校验契约文档无漂移
npm run pack                                # 生成纯净发行目录 dist/（勿直接打包仓库根目录）
node scripts/pack-stage.js --dry-run        # 预览分发打包清单
UTOOLS_MCP_KEY=<key> node scripts/rt-run.js # 真机回归（需在 uTools 开发者工具加载并重载本目录）
```

## 硬性约定

- **只写 CommonJS**（`"use strict"`），不引入 ESM/TS/打包器与第三方 npm 依赖。
- **注释与文档全中文**，解释"为什么"而非堆砌过程编号。
- **子模块禁止持有可变模块级单例**：状态一律经 `createState(REAL)` 创建并向下注入，确保 `require.cache` 清理重载或热加载完全隔离。
- **脱敏绝不触碰 `journal`**：`prev` 与 spill 二进制必须保留真实原文，否则 `dev_cleanup` 会写坏数据。
- **冻结不变量**：真实 `utools` API 整树 `Object.freeze`，深代理载体必须是空白 `{}` + `forwardTraps`；测试 mock 必须继续 `Object.freeze`。
- **8.0 清单校验硬约束**：`features` 必填、工具 `description` 非空且 `<= 500` 字符、`inputSchema` 禁用 `oneOf`/`anyOf`/`allOf`/`$ref`。改契约后必跑 `node scripts/gen-docs.js` 与 `npm test`。
- **测试卫生**：测试夹具一律建在 `os.tmpdir()` 并清理，禁止修改 `scripts/fixtures/` 内已跟踪文件。
- **零私有信息**：脚本与文档不得出现本机绝对用户路径或具体客户端私人配置文件路径，gateway key 绝不入仓。

## 已知 gotchas

- **隐藏页节流**：uTools 主窗隐藏后可能挂起页面定时器，多步测试优先走 `dev_run` 单次调用内闭环；跨步延迟回调改同步或 `dev_job` 查询。
- **网关插件前缀**：uTools 8.0 为 `utools_plugin_<id>_<名>`，旧版为 `utools.<id>.<名>`。直连脚本统一经 `tools/list` 匹配 `/(?:_|\.)dev_load$/` 自动探测，绝不写死插件 ID。
- **BrowserWindow 外链加载**：uTools 8.0 `createBrowserWindow` 仅收相对路径且无 `loadFile`/`loadURL`，`dev_ui_*` 必须经 `ui-host.html` 跳转。
- **`vm` 渲染进程弃用警告无害**：Electron 34 加载时打印的旧警告不影响运行，`loader.js` 已隔离容器适配器以便未来迁移 `worker_threads`。
