/**
 * dev-bridge 契约单一来源（SSOT）：版本、上限常量、错误码、门控清单与全部 MCP 工具定义。
 * plugin.json 的 tools 段、README / SKILL 速查表及保活页均由此文件自动生成并做一致性校验。
 */
"use strict";

const Module = require("module");

const VERSION = "0.4.0";

const LIMITS = Object.freeze({
  RING_MAX: 500,
  JOURNAL_MAX: 2000,
  SER_DEPTH: 8,
  SER_BUDGET: 65536,
  DIGEST_BUDGET: 4096,
  LOAD_TIMEOUT_DEFAULT: 10000,
  CALL_TIMEOUT_DEFAULT: 30000,
  UI_TIMEOUT_DEFAULT: 15000,
  FS_FILE_CAP: 8 * 1024 * 1024,
  FS_DIR_FILES_CAP: 500,
  FS_SPILL_CAP: 64 * 1024 * 1024,
  SPILL_STALE_MS: 7 * 24 * 3600 * 1000,
  INLINE_LOG_CAP: 30,
  JOB_MAX: 50,
  JOB_PROGRESS_CAP: 50,
  UI_SNAPSHOT_MAX_NODES: 300,
  UI_SNAPSHOT_MAX_DEPTH: 12,
  DESCRIPTION_MAX_LEN: 500,
});

const ERROR_CODES = Object.freeze([
  { code: "PATH_NOT_FOUND", meaning: "目标路径或入口文件不存在，先核对 path" },
  { code: "NO_PLUGIN_JSON", meaning: "目标目录缺少或无法解析 plugin.json（单文件请传 mode:\"file\"）" },
  { code: "NO_PRELOAD", meaning: "目标 plugin.json 未声明 preload 或文件不存在" },
  { code: "NO_MAIN", meaning: "目标 plugin.json 未声明 main 入口 HTML 或文件不存在" },
  { code: "SYNTAX_ERROR", meaning: "目标代码编译失败（或疑似使用 ESM 语法，当前仅支持 CommonJS）" },
  { code: "REQUIRE_FAILED", meaning: "模块解析或顶层初始化失败；若含 require:xxx，用 allowHostModules 放行后重载" },
  { code: "UNKNOWN_EXPORT", meaning: "导出路径或生命周期/工具名不存在；用 dev_list 查清单" },
  { code: "NOT_LOADED", meaning: "尚未加载目标；先调用 dev_load" },
  { code: "TIMEOUT", meaning: "同步执行超时，沙箱已标记重建；下次调用自动重载" },
  { code: "ASYNC_TIMEOUT", meaning: "异步 Promise 超时放弃等待；长任务改传 dev_call async:true" },
  { code: "SERIALIZE_FAILED", meaning: "返回值过大或过深无法序列化，请让目标返回摘要或分页" },
  { code: "DENIED_MODULE", meaning: "Node 内置/electron 模块被默认门控拦截；allowHostModules 放行" },
  { code: "DENIED_FETCH", meaning: "fetch 默认拦截；dev_load 传 allowHostModules:true 放行" },
  { code: "DENIED_FS_UNTRACKED", meaning: "破坏性 fs 操作前态超限（8MB/500 文件）被拒；拆小或 allowHostModules:true 放行" },
  { code: "THROWN", meaning: "目标代码抛出异常，message 带调用栈并自动附带现场日志" },
  { code: "JOB_NOT_FOUND", meaning: "指定的异步任务 jobId 不存在或已被淘汰" },
  { code: "UI_NOT_OPEN", meaning: "尚未打开测试 UI 窗口；先调用 dev_ui_open" },
  { code: "UI_UNAVAILABLE", meaning: "当前宿主环境不支持 utools.createBrowserWindow" },
  { code: "UI_EVAL_FAILED", meaning: "UI 窗口内执行 JS/生命周期或生成快照失败" },
  { code: "CONFIRM_REQUIRED", meaning: "触发高危开关（allowSideEffects/allowHostModules/reveal）或越出会话目录写截图，需显式传 confirmRisk:true 或 confirmOutPath:true 二次确认" },
  { code: "BOOT_FAILED", meaning: "开发桥自身启动崩溃，仅暴露 dev_boot_err 诊断工具" },
]);

// 破坏性 utools API：默认 stub，allowSideEffects=true 时真实执行
const STUBBED_APIS = new Set([
  "utools.copyText", "utools.copyFile", "utools.copyImage",
  "utools.hideMainWindowPasteFile", "utools.hideMainWindowPasteImage",
  "utools.hideMainWindowPasteText", "utools.hideMainWindowTypeString",
  "utools.simulateKeyboardTap", "utools.simulateMouseMove",
  "utools.simulateMouseClick", "utools.simulateMouseDoubleClick", "utools.simulateMouseRightClick",
  "utools.shellTrashItem", "utools.shellOpenPath", "utools.shellOpenExternal",
  "utools.shellShowItemInFolder", "utools.shellBeep", "utools.showNotification",
  "utools.runFFmpeg", "utools.outPlugin", "utools.redirect",
  "utools.screenColorPick", "utools.screenCapture", "utools.desktopCaptureSources",
  "utools.createBrowserWindow", "utools.showOpenDialog", "utools.showSaveDialog",
  "utools.setFeature", "utools.removeFeature", "utools.startDrag",
  "utools.ai", "utools.setUBrowserProxy", "utools.clearUBrowserCache",
  "utools.redirectHotKeySetting", "utools.redirectAiModelsSetting",
  "utools.hideMainWindow", "utools.showMainWindow",
  "utools.requestSchedule", "utools.removeSchedule",
]);

// 官方签名为 Promise 的 stub API：拦截时保 thenable，避免 .then()/await 报错
const PROMISE_STUB_APIS = new Set(["utools.requestSchedule"]);

// 生命周期事件：登记回调而非真注册到宿主，供特殊名触发
const EVENT_APIS = new Set([
  "utools.onPluginEnter", "utools.onPluginOut", "utools.onMainPush",
  "utools.onPluginDetach", "utools.onDbPull",
  "utools.onPluginReady", "utools.onScheduleTrigger",
]);

// dev_call / dev_ui_eval 生命周期特殊名映射
const LIFECYCLE_SPECIALS = Object.freeze({
  __enter: "utools.onPluginEnter",
  __out: "utools.onPluginOut",
  __detach: "utools.onPluginDetach",
  __dbPull: "utools.onDbPull",
  __mainPush: "utools.onMainPush",
  __mainPushSelect: "utools.onMainPush:select",
  __ready: "utools.onPluginReady",
  __schedule: "utools.onScheduleTrigger",
  __domReady: "__dom",
});

// 深代理强制递归的命名空间
const FORCE_RECURSE_PROPS = new Set(["db", "dbStorage", "dbCryptoStorage", "promises", "ubrowser"]);

// Node 内置模块门控：map 为安全替身，allow 为只读透传，其余默认懒拒绝
const DENY_MODULES = new Set([
  "child_process", "worker_threads", "cluster",
  "http", "https", "http2", "net", "dgram", "tls", "dns",
  "inspector", "vm", "v8", "repl", "readline", "electron",
]);

const MAP_MODULE_NAMES = new Set([
  "process", "console", "timers", "timers/promises", "fs", "fs/promises", "module",
]);

const ALLOW_MODULES = new Set((Module.builtinModules || []).filter((m) =>
  !DENY_MODULES.has(m)
  && !m.startsWith("_")
  && !MAP_MODULE_NAMES.has(m)
));

const EVENT_NOOP_PROPS = new Set([
  "on", "once", "off", "send", "addListener", "removeListener", "removeAllListeners",
  "prependListener", "prependOnceListener", "emit", "setMaxListeners", "getMaxListeners",
]);

const WEB_GLOBALS = Object.freeze([
  "URL", "URLSearchParams", "TextEncoder", "TextDecoder",
  "AbortController", "AbortSignal", "atob", "btoa",
  "structuredClone", "performance",
]);

const FS_DESTRUCTIVE_OPS = new Set(["unlink", "rm", "rmdir", "rename", "truncate"]);

const FS_JOURNAL_OP_NAMES = new Set([
  "writeFile", "appendFile", "truncate", "unlink", "rm", "rmdir", "rename",
  "copyFile", "mkdir", "symlink", "link", "open", "createWriteStream", "mkdtemp", "cp",
]);

// 13 个 MCP 工具的权威定义（注意：每条 description 必须 <= 500 字符，schema 禁止 oneOf/anyOf/allOf/$ref）
const TOOLS = Object.freeze({
  dev_load: {
    summary: "加载或热重载目标插件 preload",
    keyParams: "`path`（必）、`mode`、`allowSideEffects`、`allowHostModules`、`reveal`、`confirmRisk`、`verbose`",
    description: "在隔离 vm 沙箱加载/热重载目标插件 preload（mode=plugin 读 plugin.json；mode=file 直跑 JS），按 services 级重建。返回 exportsCount/exportsHash（verbose:true 附源码 preview）、events、tools 及拦截 warnings。allowSideEffects/allowHostModules/reveal 为高危放行开关，启用时须同时传 confirmRisk:true 二次确认，否则返回 CONFIRM_REQUIRED。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "目标插件根目录(含 plugin.json)或 .js 文件的绝对路径" },
        mode: { type: "string", enum: ["plugin", "file"], default: "plugin", description: "plugin=按插件结构加载;file=直接执行单个 JS 文件" },
        allowSideEffects: { type: "boolean", default: false, description: "true 时放行破坏性 utools API（剪贴板/键鼠/shell/窗口/AI 等），高危开关须配合 confirmRisk:true" },
        allowHostModules: { type: ["boolean", "array"], items: { type: "string" }, default: false, description: "Node 内置模块门控：true 全放行或传模块名白名单，高危开关须配合 confirmRisk:true，默认 false 懒拒绝" },
        reveal: { type: "boolean", default: false, description: "true 时关闭日志与返回值的自动凭证脱敏，高危开关须配合 confirmRisk:true" },
        confirmRisk: { type: "boolean", default: false, description: "高危开关二次确认：启用 allowSideEffects / allowHostModules / reveal 时必须显式传 true，否则返回 CONFIRM_REQUIRED" },
        verbose: { type: "boolean", default: false, description: "true 时 exports 附带函数源码 preview，默认 false 仅返回精简清单" },
        timeoutMs: { type: "integer", default: 10000, minimum: 1000, maximum: 60000, description: "入口顶层同步执行超时(ms)" },
      },
      required: ["path"],
    },
  },
  dev_call: {
    summary: "调用导出函数、生命周期或 __tool:<名>",
    keyParams: "`name`（必）、`args`、`include`、`async`、`timeoutMs`",
    description: "调用已加载目标的导出路径、生命周期（__enter/__out/__detach/__mainPush/__mainPushSelect/__dbPull/__ready/__schedule/__domReady）或 __tool:<名>。默认内联返回新增现场（成功带非空 console，失败带 console+calls，可用 include 显式控制）。传 async:true 立即返回 jobId 供 dev_job 查询，规避客户端长耗时超时。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", description: "导出函数路径、生命周期特殊名（如 __enter）或 __tool:<名>" },
        args: { type: "array", default: [], description: "位置参数数组" },
        timeoutMs: { type: "integer", default: 30000, minimum: 1000, maximum: 300000, description: "同步硬超时与异步软超时(ms)" },
        include: {
          type: "array",
          items: { type: "string", enum: ["console", "calls"] },
          description: "内联附带日志：可包含 console / calls；省略时成功附非空 console，失败附非空 console+calls",
        },
        async: { type: "boolean", default: false, description: "true 时异步启动并立即返回 jobId，不阻塞 MCP 会话" },
      },
      required: ["name"],
    },
  },
  dev_run: {
    summary: "单次背靠背执行多步调用与断言（可选加载与清理）",
    keyParams: "`steps`（必）、`load`、`stopOnFail`、`cleanup`",
    description: "在单次调用内背靠背执行可选 dev_load + 多步调用与断言（expect）+ 可选 dev_cleanup，消除多轮往返与隐藏页挂起问题。每步支持 ok/code/path/eq/ne/gt/gte/lt/lte/contains/matches/truthy/type/hasCall/hasConsole 断言，并默认在失败时停跑后续步骤。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        load: {
          type: "object",
          additionalProperties: false,
          description: "可选：先执行一次 dev_load",
          properties: {
            path: { type: "string" },
            mode: { type: "string", enum: ["plugin", "file"], default: "plugin" },
            allowSideEffects: { type: "boolean", default: false },
            allowHostModules: { type: ["boolean", "array"], items: { type: "string" }, default: false },
            reveal: { type: "boolean", default: false },
            confirmRisk: { type: "boolean", default: false },
            timeoutMs: { type: "integer", default: 10000, minimum: 1000, maximum: 60000 },
          },
          required: ["path"],
        },
        steps: {
          type: "array",
          description: "按顺序执行的步骤列表",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              call: { type: "string", description: "导出名、生命周期特殊名或 __tool:<名>" },
              args: { type: "array", default: [], description: "位置参数数组" },
              label: { type: "string", description: "步骤显示名" },
              timeoutMs: { type: "integer", minimum: 1000, maximum: 300000 },
              include: { type: "array", items: { type: "string", enum: ["console", "calls"] } },
              expect: {
                type: "object",
                additionalProperties: false,
                description: "断言条件；省略时默认断言 ok===true",
                properties: {
                  ok: { type: "boolean" },
                  code: { type: "string" },
                  path: { type: "string", description: "点号路径（如 result.items.0.id），省略时指向 result" },
                  eq: { description: "期望值（JSON 规范相等）" },
                  ne: { description: "不等值" },
                  gt: { type: "number" },
                  gte: { type: "number" },
                  lt: { type: "number" },
                  lte: { type: "number" },
                  contains: { description: "字符串子串或数组包含项" },
                  matches: { type: "string", description: "正则表达式字符串" },
                  truthy: { type: "boolean" },
                  type: { type: "string", enum: ["string", "number", "boolean", "object", "array", "null", "undefined"] },
                  hasCall: { type: "string", description: "期望调用流水中存在以此字符串开头的 api" },
                  hasConsole: { type: "string", description: "期望 console 中包含此子串" },
                },
              },
            },
            required: ["call"],
          },
        },
        stopOnFail: { type: "boolean", default: true, description: "任一步骤断言失败时是否中止后续步骤" },
        cleanup: { type: "boolean", default: false, description: "全部步骤结束后是否自动执行 dev_cleanup" },
      },
      required: ["steps"],
    },
  },
  dev_job: {
    summary: "查询、等待或取消异步调用任务",
    keyParams: "`id`、`waitMs`、`cancel`",
    description: "查询、等待或取消由 dev_call {async:true} 启动的异步任务。省略 id 列出近期任务摘要；传 id 返回进度（含 sendProgress）及终态结果或异常与内联日志；传 waitMs 可短轮询等待完成（最长 25s）；传 cancel:true 中止等待标记取消。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "目标 jobId；省略时列出近期任务" },
        waitMs: { type: "integer", default: 0, minimum: 0, maximum: 25000, description: "最长等待任务完成的毫秒数" },
        cancel: { type: "boolean", default: false, description: "true 时将运行中任务标记为 cancelled" },
      },
    },
  },
  dev_list: {
    summary: "查看当前加载状态、摘要清单与 UI 会话",
    keyParams: "`verbose`",
    description: "查看当前已加载目标状态（路径/模式/dirty/events/tools/ui 会话及未还原提示），不重载。默认返回 exportsCount 与 exportsHash 以节省 token，传 verbose:true 才展开完整 exports 清单。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        verbose: { type: "boolean", default: false, description: "true 时展开完整 exports 数组（含 preview）" },
      },
    },
  },
  dev_console: {
    summary: "增量读取 console 与异步未捕获异常",
    keyParams: "`since`、`clear`",
    description: "读取被测代码的 console 输出与异步未捕获异常（level:\"uncaught\"，环形 500 条）。传 since 做增量拉取，被环形覆盖时返回 expired:true 提示全量重取；clear:true 清空。默认对敏感值脱敏。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        since: { type: "integer", default: 0, description: "只返回 seq 大于该值的条目" },
        clear: { type: "boolean", default: false, description: "true 时读取后清空缓冲" },
      },
    },
  },
  dev_calls_log: {
    summary: "增量读取 utools/fs/require 调用流水",
    keyParams: "`since`、`clear`",
    description: "读取被测代码及 UI 窗口的调用流水（utools.*、fs.* 写操作含 outside 标记、require:* 拦截与 tool.progress:*）。条目含 stubbed/denied/untracked/outside 标记，默认对敏感值脱敏。since 与 clear 语义同 dev_console。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        since: { type: "integer", default: 0, description: "只返回 seq 大于该值的条目" },
        clear: { type: "boolean", default: false, description: "true 时读取后清空流水" },
      },
    },
  },
  dev_cleanup: {
    summary: "逆序还原 db/dbStorage/dbCryptoStorage/fs 写副作用并清理 UI 缓存",
    keyParams: "`force`、`dropAll`",
    description: "按 WAL 写日志逆序还原测试期间（含 UI 窗口）的 db/dbStorage/dbCryptoStorage 与 fs 写副作用（越界写入在 outsideWrites 单列），并清理会话目录下的截图缓存 devbridge-shots/ 及非活跃会话文件 devbridge-ui-session.json。force 放弃失败重试项；dropAll 跳过回放直接清空写日志。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        force: { type: "boolean", default: false, description: "true 时放弃无法还原/重试失败条目并清空写日志" },
        dropAll: { type: "boolean", default: false, description: "true 时先杀定时器并跳过回放直接清空写日志，现场保持现状（优先于 force）" },
      },
    },
  },
  dev_ui_open: {
    summary: "在真实 BrowserWindow 中加载目标插件 UI 与 preload",
    keyParams: "`path`、`width`、`height`、`show`、`serveHttp`、`enter`、`confirmRisk`",
    description: "用真实 BrowserWindow 加载目标插件的 main HTML 与可选 preload，并注入桥代理使界面与 preload 调用的 db/kv/fs 副作用可录制可还原。默认隐藏窗口（show:true 可视），自动按需启回环静态服务以兼容 ES Module；可传 enter 触发 onPluginReady/Enter。启用 allowSideEffects/allowHostModules/reveal 高危开关须同时传 confirmRisk:true 二次确认。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "目标插件根目录；省略时沿用当前 dev_load 的插件根目录" },
        width: { type: "integer", default: 800, minimum: 200, maximum: 3840 },
        height: { type: "integer", default: 600, minimum: 200, maximum: 2160 },
        show: { type: "boolean", default: false, description: "是否显示测试窗口，默认 false 后台运行" },
        allowSideEffects: { type: "boolean", default: false },
        allowHostModules: { type: ["boolean", "array"], items: { type: "string" }, default: false },
        reveal: { type: "boolean", default: false },
        confirmRisk: { type: "boolean", default: false, description: "高危开关二次确认：启用 allowSideEffects / allowHostModules / reveal 时必须显式传 true" },
        serveHttp: { type: "boolean", description: "是否强制启用回环静态文件服务；省略时自动检测 ESM/根路径资源" },
        enter: {
          type: "object",
          additionalProperties: false,
          description: "页面就绪后自动触发的 onPluginEnter 参数",
          properties: {
            code: { type: "string" },
            type: { type: "string" },
            payload: { description: "匹配数据（文本/文件数组等）" },
            from: { type: "string" },
          },
        },
        timeoutMs: { type: "integer", default: 15000, minimum: 1000, maximum: 120000 },
      },
    },
  },
  dev_ui_eval: {
    summary: "在 UI 窗口内执行 JS 或触发生命周期事件",
    keyParams: "`js`、`lifecycle`、`args`、`include`、`awaitPromise`",
    description: "在已打开的 UI 窗口内执行 JS 代码或触发页面侧登记的生命周期回调（__enter/__out/__detach/__mainPush/__mainPushSelect/__dbPull/__ready/__schedule），同步收集 window.console、未捕获异常与 utools/fs 调用流水并支持 include 内联返回。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        js: { type: "string", description: "在窗口页面上下文中执行的 JS 代码或表达式" },
        lifecycle: {
          type: "string",
          enum: ["__enter", "__out", "__detach", "__mainPush", "__mainPushSelect", "__dbPull", "__ready", "__schedule"],
          description: "可选：触发目标在窗口内注册的生命周期回调",
        },
        args: { type: "array", default: [], description: "配合 lifecycle 使用的参数数组" },
        awaitPromise: { type: "boolean", default: true, description: "若 js 返回 Promise 是否自动等待其完成" },
        include: { type: "array", items: { type: "string", enum: ["console", "calls"] } },
        timeoutMs: { type: "integer", default: 15000, minimum: 1000, maximum: 120000 },
      },
    },
  },
  dev_ui_snapshot: {
    summary: "获取 UI 窗口的紧凑 DOM 与可访问性文本树",
    keyParams: "`selector`、`maxDepth`、`maxNodes`、`includeHidden`",
    description: "提取当前 UI 窗口的紧凑结构化 DOM 树与类 Playwright 缩进文本树（含 tag/role/id/testid/状态/文本），用于低 token 验证页面渲染与交互状态，默认忽略不可见节点并受 maxNodes 限流。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        selector: { type: "string", default: "body", description: "根节点 CSS 选择器" },
        maxDepth: { type: "integer", default: 12, minimum: 1, maximum: 30 },
        maxNodes: { type: "integer", default: 300, minimum: 10, maximum: 1000 },
        includeHidden: { type: "boolean", default: false },
      },
    },
  },
  dev_ui_screenshot: {
    summary: "截取 UI 窗口画面为 PNG 文件",
    keyParams: "`outPath`、`confirmOutPath`、`rect`、`returnBase64`",
    description: "调用窗口 capturePage() 截取当前渲染画面并保存为 PNG，即使 show:false 隐藏窗口也可截图。默认限制写入插件会话目录 devbridge-shots/ 内（可由 dev_cleanup 自动清理）；若传超出该目录的 outPath 必须同时传 confirmOutPath:true 二次确认，否则返回 CONFIRM_REQUIRED。默认仅返回路径与宽高以节省 token，returnBase64:true 才附带 dataUrl。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        outPath: { type: "string", description: "可选：PNG 输出路径（默认在会话目录 devbridge-shots/；超出该目录需同时传 confirmOutPath:true）" },
        confirmOutPath: { type: "boolean", default: false, description: "二次确认：outPath 超出会话截图目录时必须显式传 true，否则返回 CONFIRM_REQUIRED" },
        rect: {
          type: "object",
          additionalProperties: false,
          description: "可选：裁剪区域",
          properties: {
            x: { type: "integer", minimum: 0 },
            y: { type: "integer", minimum: 0 },
            width: { type: "integer", minimum: 1 },
            height: { type: "integer", minimum: 1 },
          },
          required: ["x", "y", "width", "height"],
        },
        returnBase64: { type: "boolean", default: false, description: "true 时额外返回 dataUrl" },
      },
    },
  },
  dev_ui_close: {
    summary: "关闭 UI 测试窗口并释放本地静态服务",
    keyParams: "无",
    description: "冲刷未落盘的 UI 窗口调用日志与写日志，销毁测试 BrowserWindow 并关闭回环静态服务与会话临时文件。幂等安全，窗口未打开时也返回 ok:true。",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
});

module.exports = {
  VERSION,
  LIMITS,
  ERROR_CODES,
  STUBBED_APIS,
  PROMISE_STUB_APIS,
  EVENT_APIS,
  LIFECYCLE_SPECIALS,
  FORCE_RECURSE_PROPS,
  DENY_MODULES,
  MAP_MODULE_NAMES,
  ALLOW_MODULES,
  EVENT_NOOP_PROPS,
  WEB_GLOBALS,
  FS_DESTRUCTIVE_OPS,
  FS_JOURNAL_OP_NAMES,
  TOOLS,
};
