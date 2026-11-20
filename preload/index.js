/**
 * dev-bridge — uTools 插件开发测试桥入口（CommonJS 模块化组装 + 引导保护网）
 *
 * 机制：由 contract.js 单一定义工具契约与常量，顶层 registerTool 暴露 13 个 dev_* 工具经 uTools MCP 网关给 AI Agent。
 *       支持 preload vm 沙箱（CJS 热重载/深代理/默认凭证脱敏/WAL 还原/批量断言 dev_run/异步 dev_job）
 *       以及真 BrowserWindow 渲染层测试（dev_ui_open/eval/snapshot/screenshot/close）。
 */
"use strict";

(function () {
  try {
    const REAL = utools;
    if (typeof window !== "undefined") window.utools = REAL;

    const { createState } = require("./state");
    const { createJournal } = require("./journal");
    const { createProxy } = require("./proxy");
    const { createLoader } = require("./loader");
    const { createLoadTools } = require("./tools/load");
    const { createJobManager } = require("./tools/job");
    const { createCallTools } = require("./tools/call");
    const { createRunTool } = require("./tools/run");
    const { createCleanupTool } = require("./tools/cleanup");
    const { createUiTools } = require("./tools/ui");

    const rt = createState(REAL);
    const journalApi = createJournal(rt);
    const proxyApi = createProxy(rt, journalApi);
    const loaderApi = createLoader(rt, proxyApi, journalApi);
    const jobMgr = createJobManager(rt);
    const loadApi = createLoadTools(rt, loaderApi);
    const callApi = createCallTools(rt, loaderApi, proxyApi, jobMgr);
    const uiApi = createUiTools(rt, journalApi);
    const cleanupApi = createCleanupTool(rt, journalApi, () => uiApi.flushSession);
    const runApi = createRunTool(rt, loadApi, callApi, cleanupApi);

    // 启动回灌上次未还原的写日志，跨 uTools 重启仍可 dev_cleanup
    journalApi.restoreJournalMeta();

    function reg(name, fn) {
      if (typeof utools.registerTool !== "function") return;
      utools.registerTool(name, async (params) => {
        try {
          return await fn(params || {});
        } catch (e) {
          return {
            ok: false,
            code: (e && e.code) || "ERROR",
            message: String((e && e.message) || e),
            consoleFrom: rt.consoleSeq,
            callsFrom: rt.callsSeq,
          };
        }
      });
    }

    reg("dev_load", rt.serialized(loadApi.devLoad));
    reg("dev_call", rt.serialized(callApi.devCall));
    reg("dev_run", rt.serialized(runApi.devRun));
    // dev_job 刻意不进 serialized 串口队列，保证运行中可即时查询/等待/取消
    reg("dev_job", jobMgr.devJob);
    reg("dev_list", rt.serialized(loadApi.devList));
    reg("dev_console", rt.serialized((cfg) => rt.readRing(rt.ringConsole, cfg.since || 0, !!cfg.clear)));
    reg("dev_calls_log", rt.serialized((cfg) => rt.readRing(rt.ringCalls, cfg.since || 0, !!cfg.clear)));
    reg("dev_cleanup", rt.serialized(cleanupApi.devCleanup));
    reg("dev_ui_open", rt.serialized(uiApi.devUiOpen));
    reg("dev_ui_eval", rt.serialized(uiApi.devUiEval));
    reg("dev_ui_snapshot", rt.serialized(uiApi.devUiSnapshot));
    reg("dev_ui_screenshot", rt.serialized(uiApi.devUiScreenshot));
    reg("dev_ui_close", rt.serialized(uiApi.devUiClose));
  } catch (e) {
    try {
      utools.registerTool("dev_boot_err", async () => ({
        ok: false,
        code: "BOOT_FAILED",
        message: String((e && e.stack) || e),
      }));
    } catch (_) {}
  }
})();
