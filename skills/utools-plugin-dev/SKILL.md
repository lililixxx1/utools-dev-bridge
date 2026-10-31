---
name: utools-plugin-dev
description: 开发、修改、调试 uTools 插件应用时使用——配 plugin.json（main/logo/preload/features/cmds/tools）、写 preload.js（CommonJS + Node 能力）、注册 MCP 工具（registerTool）、查任意 utools.* / ubrowser.* API 的签名示例与版本门槛。Use whenever the user mentions uTools 插件, plugin.json, preload.js, utools.db/dbStorage/dbCryptoStorage, ubrowser, utools.sharp, registerTool, setSubInput, onPluginEnter, or asks to build / extend / debug a uTools plugin — even when they don't name the API they need.
---

# uTools 插件开发

本 skill 给两样东西：官方 API 参考（`references/`，26 个章节、151 行速查索引，已对齐 uTools 8.0.2 官方文档），以及几条最容易踩的硬约束。

> 公开版说明：本目录是随 dev-bridge 仓库分发的公开版。维护者的完整版另含官方 AI 生成插件规范镜像与文档同步管线，因内容来源限制不随公开仓库分发。

## 何时用

- 新建 uTools 插件应用，或改 `plugin.json`（`main` / `logo` / `preload` / `features` / `cmds` / `pluginSetting`）
- 写或改 `preload.js`（Node 侧逻辑、暴露给前端的能力）
- 查 API 的签名、参数、返回值、示例、版本门槛
- MCP 工具集成与冷启动、数据存储选型 → `references/tools.md` / `references/storage.md`

## 何时不用

- 普通网页 / Electron / Node 工程的一般问题——本 skill 只覆盖 uTools 插件应用特有的约定，通用问题按通用办法解决
- 用户问的是 uTools 客户端怎么用（装插件、快捷键、会员），不是开发插件
- 需要文档里没有的信息（插件市场审核、uTools 内部实现细节）时，直说查不到，别按 API 名字推测行为

## 硬约束（违反会被 uTools 拒收或静默失效）

1. **入口**：`plugin.json` 必填 `logo` + `main`，`main` 必须是相对 `plugin.json` 的 `.html` 路径。仅面向 AI Agent 的无 UI 插件可省 `main` / `features`，但必须 `logo` + `preload` + `tools`。
2. **preload 不许压缩**：`preload.js` 及其 `require` 的 node 第三方模块禁止打包/压缩/混淆，必须源码清晰可读、随插件一同提交，且模块要位于 `preload.js` 同级目录。前端代码相反——必须先编译成普通 html/css/js（通常输出 `dist`）再打包，不要把项目根目录整个打包。
3. **CommonJS（Node.js 20）**：`preload.js` 用 `require` 引原生模块 / 第三方模块 / Electron 渲染进程 API；给 `window.xxx = {...}` 挂属性，前端页面即可直接访问。
4. **版本门槛**：文档中标注「版本：>=x.y.z」的 API 需要 uTools 达到对应版本，写代码前先确认目标版本，或做能力探测。
5. **MCP 工具注册时机**：`utools.registerTool(name, handler)` 必须在页面初始化阶段执行（推荐 `preload.js` 或与 `onPluginEnter` 同级作用域）；写在 `onPluginEnter` 内部则 AI Agent 调用时不会触发，工具等于没注册。
6. **指令命名**：功能指令 1~80 字符（推荐 ≤20），禁控制字符与 `\ / : * ? " < > |`，禁纯 Emoji/空白；同一功能最多 5 条功能指令（超出被忽略），插件至少 1 条功能指令。
7. **logo 打包格式**：开发者工具打包/发布强制 `.png/.jpg/.jpeg`（SVG 只在 AI builder 内部管线用），建议 128~256px 正方形；手动打包 builder 产物先转 PNG。
8. **挂件生命周期**：uTools 主窗隐藏后插件默认 **3 分钟自动退出**；不要在 `onPluginOut` 里关自定义窗口（会把在用挂件一起带走）。
9. **运行时版本**：uTools 8.0 = Electron 34.5.8 / Chromium 132 / Node.js 20.19.1（7.x 为 Node 16.x；需兼容旧版 uTools 时按 16.x 能力口径写）。

## 拼写与版本坑（8.0 官方改名）

- 官方 8.0 文档修正了 7.x 拼写并改名一批 API：`getCopyedFiles`→`getCopiedFiles`、`CopiedFile.isDiractory`→`isDirectory`、`onPluginEnter` `from:"reirect"`→`"redirect"`、`setExpendHeight`→`setExpandHeight`、`ubrowser.useragent`→`userAgent`、`ubrowser.end()`→`endWhen()`、`feature.explain`→`feature.description`、`getWindowType()` 自定义窗口返回 `"browser"`→`"custom"`。**新代码按 8.0 新名写**；读 7.x 存量代码时旧名是历史真名，别当错别字"修复"（文档内以 📜 标注旧名）。
- `feature` 描述字段：8.0 官方文档为 `description`，7.x 文档/市场存量插件为 `explain`（运行时双轨兼容），维护旧插件认 `explain`。
- 文档里的 `jsonc` 代码块含 `//` 注释，不是严格 JSON，不能直接 `JSON.parse`。

## 最小可用插件

一个能被 uTools 识别的插件，最小结构是这样（`structure.md` 的官方示例）：

```shell
/{plugin}
|-- plugin.json
|-- preload.js
|-- index.html
|-- index.js
|-- index.css
|-- logo.png
```

`plugin.json`：

```json
{
  "main": "index.html",
  "logo": "logo.png",
  "preload": "preload.js",
  "features": [
    {
      "code": "hello",
      "description": "hello world",
      "cmds": ["hello", "你好"]
    }
  ]
}
```

`preload.js`——Node 能力挂在 `window` 上，前端页面直接读 `window.customApis`：

```js
const fs = require("fs");

window.customApis = {
  readFile: (path) => fs.readFileSync(path, "utf8"),
};
```

字段含义与更多可选项（`pluginSetting`、`cmds` 的匹配类型、AI Agent 插件的 `tools` 等）见 [plugin-json.md](references/plugin-json.md)。

## 先读哪一篇

`references/` 一章一文件；`references/api-index.md` 是总索引（151 行速查表 + 全局约束）。按任务直接读对应篇，不要通读：

| 任务 | 读 |
| --- | --- |
| 新建插件、搞清目录怎么摆、运行时架构、怎么打包 | [structure.md](references/structure.md) |
| 配 plugin.json（main / logo / preload / features / cmds / pluginSetting / tools…）、要 TS 类型提示或 JSONSchema | [plugin-json.md](references/plugin-json.md) |
| 搞懂 preload 机制、前端如何调用它 | [preload.md](references/preload.md) |
| preload 里要用第三方 node 模块 | [nodejs.md](references/nodejs.md) |
| 数据存储选型（同步 db / 本地目录 / 临时目录 / 用户文件） | [storage.md](references/storage.md) |
| 进入/就绪/退出插件拿参数、定时任务触发、主搜索框推送、分离窗口 | [events.md](references/events.md)（7 API） |
| 主窗口显隐、子输入框、独立 BrowserWindow、页面内查找、窗口类型 | [window.md](references/window.md)（15 API + 自定义窗口要点） |
| 跳转其他插件、指令快捷键设置与查询 | [redirect.md](references/redirect.md)（3 API） |
| Cron 定时任务注册/查询/移除 | [schedule.md](references/schedule.md)（3 API） |
| 往剪贴板写文本/文件/图片、读剪贴板文件列表 | [copy.md](references/copy.md)（4 API） |
| 隐藏窗口后粘贴文件/图片/文本、模拟输入、向其他窗口拖拽文件 | [input.md](references/input.md)（5 API） |
| 模拟键盘按键与鼠标动作 | [simulate-input.md](references/simulate-input.md)（5 API） |
| 系统通知、文件对话框、打开文件/URL、特殊路径、本地数据/临时目录、用户信息、平台判断、暗色主题 | [system.md](references/system.md)（23 API） |
| 屏幕捕获/截图、取色、显示器信息、物理/DIP 坐标换算、录屏源 | [screen.md](references/screen.md)（13 API） |
| 动态增删功能指令 | [dynamic-features.md](references/dynamic-features.md)（3 API） |
| 调 AI（流式返回、Function Calling、reasoning_effort）、列模型、注册 MCP 工具（registerTool） | [ai.md](references/ai.md)（3 API） |
| 图像处理（内置 Sharp v0.35.3：缩放/裁剪/合成/格式转换） | [sharp.md](references/sharp.md)（1 API） |
| 跑 FFmpeg 做音视频处理 | [ffmpeg.md](references/ffmpeg.md)（1 API） |
| 文档型存储：put / get / allDocs / 附件 / 云同步状态 | [db.md](references/db.md)（9 API） |
| 键值存储（明文，适合配置项） | [db-storage.md](references/db-storage.md)（3 API） |
| 键值存储（加密，📜 8.0 文档已移除，仅存量维护） | [db-crypto-storage.md](references/db-crypto-storage.md)（3 API） |
| 抓网页、网页自动化、下载、导 PDF/Markdown、cookie、代理与实例管理 | [ubrowser.md](references/ubrowser.md)（36 API + 3 个 utools 级） |
| MCP 集成机制、plugin.json tools 声明、冷启动 | [tools.md](references/tools.md)（指南） |
| 团队应用信息与下发配置 | [team.md](references/team.md)（3 API） |
| 付费用户判断、拉起购买（isPurchasedUser / openPurchase） | [payment.md](references/payment.md)（2 API + 历史） |
| 服务端接口：用户信息、订单查询、创建商品、支付回调、临时令牌（📜 官方已下线） | [server-api.md](references/server-api.md)（4 端点 + 1 客户端 API） |

拿不准该读哪篇时，先看 `references/api-index.md` 的速查表按 API 名定位。

## 安装（复制到本机技能目录）

```bash
# 假设已 clone 本仓库
cp -r skills/utools-plugin-dev ~/.agents/skills/          # ZCode/通用 agents 技能目录
```

技能是纯静态 Markdown，无脚本无依赖；更新时重新复制覆盖即可。

