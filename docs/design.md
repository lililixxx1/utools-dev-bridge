# dev-bridge 技术设计说明（v0.4.0）

本文仅描述**当前版本**的架构、契约机制与设计边界；历史演进见 [`CHANGELOG.md`](../CHANGELOG.md)。

## 1. 整体架构

```text
AI Agent ──(MCP HTTP 127.0.0.1:3501/mcp)──▶ uTools MCP 网关
                                                   │
                                        ┌──────────▼──────────┐
                                        │   preload/index.js  │  13 工具注册 + 引导保护网
                                        └──┬───────────────┬──┘
                     ┌─────────────────────┘               └─────────────────────┐
                     ▼ (preload 沙箱)                                            ▼ (真窗口 UI)
           vm 独立上下文 + CJS loader                                 createBrowserWindow(ui-host.html)
      (contract / proxy / journal / shims)                                  │ location.href 跳转
                     │                                                目标 HTML + ui-preload.js
                     │                                                      │ (HTTP /ingest 汇入)
                     └──────────────────────────┬───────────────────────────┘
                                                ▼
                                 统一环形缓冲 & WAL NDJSON 写日志
                              (getPluginLocalDataPath/devbridge-spill)
```

## 2. 模块职责

| 模块 | 职责 |
| --- | --- |
| `preload/contract.js` | 版本、上限常量、错误码、门控清单与 13 个工具 schema 的单一来源 |
| `preload/state.js` | 状态工厂 `createState(REAL)`，避免子模块顶层单例污染热重载/重新加载 |
| `preload/serialize.js` | 跨 realm 序列化器与输出边界默认脱敏（`reveal:false` 时生效） |
| `preload/journal.js` | WAL 前态快照、spill 二进制落盘、NDJSON 追加、越界写 `outside` 判定与逆序还原 |
| `preload/proxy.js` | `utools` 冻结对象深代理、调用流水录制、`onMainPush(cb, onSelect)` 双回调捕获与异步异常守卫 |
| `preload/loader.js` | 纯策略函数（路径解析/门控判定/导出摘要与哈希）+ 容器适配器（`createVmContainer` 与 `loadIntoCurrentWindow`） |
| `preload/shims/` | `process`、`console`、`timers`（Node libuv 通道绕过隐藏页节流）、`denied`、`fs`、`dom` 替身 |
| `preload/tools/` | `load`、`call`、`run`、`job`、`cleanup`、`ui` 工具实现 |
| `preload/ui-preload.js` | 子窗口注入脚本：接管 `window.utools` / `console` / 未捕获异常与目标 preload，回传日志及 journal |

## 3. 关键设计边界

1. **门控是防意外措施，不是安全边界**：`vm` 注入了宿主对象（`Buffer`/timers 等），`.node` 原生模块透传，`dev_*` 等价本机代码执行；网关仅监听 `127.0.0.1`，`x-mcp-key` 即访问边界。
2. **脱敏只发生在输出边界**：`recordCall`、`makeConsole` 与 `devCall`/`devUiEval` 返回值默认脱敏；`journal` 中存储的 `prev` 与 spill 二进制**永不脱敏**，确保 `dev_cleanup` 还原真实存储内容。
3. **uTools 8.0 冻结代理不变量**：真实 `utools` API 整树冻结不可配置，深代理必须使用空白可配置载体 `{}` + `forwardTraps`，`wrapFnNamespace` 对只读不可配置属性原样返回。
4. **BrowserWindow 真实限制适配**：uTools 8.0 `createBrowserWindow(url, opts, cb)` 仅接受相对插件根目录的 HTML/preload 路径且无 `loadFile`/`loadURL`。桥先创建 `preload/ui-host.html?staging=1`（挂 `preload/ui-preload.js`），再经 `executeJavaScript("location.href = ...")` 跳转目标 HTML 或本机回环静态服务（自动探测 ES Module / 根路径资源）。
5. **未来 `worker_threads` 迁移接口**：`preload/loader.js` 已将模块解析、白名单判定与导出收集抽为纯函数，与 `createVmContainer` 解耦；若未来 Electron 正式移除渲染进程 `vm`，只需以 `worker_threads` 替换容器适配器。
