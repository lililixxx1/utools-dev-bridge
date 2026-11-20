/**
 * dev_load 与 dev_list 工具实现：支持精简导出摘要（verbose 控制源码 preview）与 UI 会话状态暴露。
 */
"use strict";

const { formatManifest } = require("../loader");
const { killTimers } = require("../shims/timers");

function toolsList(gen) {
  return Object.keys(gen.tools).map((n) => ({
    name: n,
    args: typeof gen.tools[n].length === "number" ? gen.tools[n].length : 0,
  }));
}

function createLoadTools(rt, loaderApi) {
  function devLoad(cfg) {
    const callsBefore = rt.callsSeq;
    const gen = loaderApi.buildGeneration(cfg || {});
    if (rt.CURRENT_GEN) rt.CURRENT_GEN.retired = true;
    killTimers(rt.CURRENT_GEN);
    rt.CURRENT_GEN = gen;

    rt.persistLast({
      path: cfg.path,
      mode: cfg.mode || "plugin",
      allowSideEffects: !!cfg.allowSideEffects,
      allowHostModules: cfg.allowHostModules === undefined ? false : cfg.allowHostModules,
      reveal: !!cfg.reveal,
      timeoutMs: cfg.timeoutMs,
    });

    const deniedMods = new Set();
    for (const e of rt.ringItems(rt.ringCalls)) {
      if (e.seq > callsBefore && e.denied && String(e.api).indexOf("require:") === 0) {
        deniedMods.add(String(e.api).slice(8).split(".")[0]);
      }
    }
    if (deniedMods.size) {
      gen.warnings.push("装载期模块拦截: " + Array.from(deniedMods).join(", ") + "(dev_load 传 allowHostModules 放行)");
    }
    if (rt.spill.pendingRestore > 0) {
      gen.warnings.push("上次会话遗留 " + rt.spill.pendingRestore + " 条未还原写日志;建议先 dev_cleanup");
    }
    if (rt.spill.wiped) {
      gen.warnings.push("上次遗留 spill 已超 7 天,启动时按弃置会话整体清空(如需保留现场请缩短测试与还原间隔)");
    }

    return {
      ok: true,
      entry: gen.entry,
      targetRoot: gen.targetRoot,
      mode: gen.mode,
      allowSideEffects: gen.allowSideEffects,
      allowHostModules: gen.allowHostModules === undefined ? false : gen.allowHostModules,
      reveal: gen.reveal,
      loadedAt: gen.loadedAt,
      exportsCount: gen.manifest.length,
      exportsHash: gen.exportsHash,
      exports: formatManifest(gen.manifest, !!(cfg && cfg.verbose)),
      events: gen.eventsList,
      tools: toolsList(gen),
      warnings: gen.warnings,
      hint: "用 dev_call/dev_run 执行清单导出;name=__enter 可触发 onPluginEnter;UI 插件可用 dev_ui_open",
    };
  }

  function devList(cfg) {
    const meta = {};
    loaderApi.ensureState(meta);
    const uiInfo = (rt.uiSession && rt.uiSession.win && !rt.uiSession.win.isDestroyed())
      ? { open: true, winId: rt.uiSession.winId, url: rt.uiSession.url, targetRoot: rt.uiSession.targetRoot }
      : undefined;

    if (!rt.CURRENT_GEN) {
      const out0 = { ok: true, loaded: false, hint: "尚未加载;调用 dev_load {path}" };
      if (rt.spill.pendingRestore > 0) {
        out0.pendingRestore = rt.spill.pendingRestore;
        out0.hint += ";上次会话遗留 " + rt.spill.pendingRestore + " 条未还原写日志,建议先 dev_cleanup";
      }
      if (rt.spill.wiped) out0.spillWiped = true;
      if (meta.lastRestoreFailed) {
        out0.lastRestoreFailed = meta.lastRestoreFailed;
        out0.hint += ";上次目标自动恢复失败已作废,请重新 dev_load";
      }
      if (uiInfo) out0.ui = uiInfo;
      return out0;
    }

    const g = rt.CURRENT_GEN;
    const untrackedCount = rt.journal.reduce((n, j) => n + (j.kind === "fs" && j.untracked ? 1 : 0), 0);
    const out = {
      ok: true,
      loaded: true,
      entry: g.entry,
      targetRoot: g.targetRoot,
      mode: g.mode,
      allowSideEffects: g.allowSideEffects,
      allowHostModules: g.allowHostModules === undefined ? false : g.allowHostModules,
      reveal: g.reveal,
      loadedAt: g.loadedAt,
      dirty: g.dirty,
      exportsCount: g.manifest.length,
      exportsHash: g.exportsHash,
      events: g.eventsList,
      tools: toolsList(g),
      warnings: g.warnings,
      reloaded: meta.reloaded || undefined,
      pendingRestore: rt.spill.pendingRestore > 0 ? rt.spill.pendingRestore : undefined,
      untrackedJournal: untrackedCount > 0 ? untrackedCount : undefined,
      spillWiped: rt.spill.wiped || undefined,
      lastRestoreFailed: meta.lastRestoreFailed || undefined,
      ui: uiInfo,
    };
    if (cfg && cfg.verbose) {
      out.exports = formatManifest(g.manifest, true);
    }
    return out;
  }

  return { devLoad, devList, toolsList };
}

module.exports = { createLoadTools, toolsList };
