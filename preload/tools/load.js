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

function collectHighRiskFlags(cfg) {
  const risks = [];
  if (!cfg) return risks;
  if (cfg.allowSideEffects === true) {
    risks.push("allowSideEffects:true（放行剪贴板、键鼠模拟、shell、系统弹窗、AI 计费等破坏性 utools API）");
  }
  if (cfg.allowHostModules === true) {
    risks.push("allowHostModules:true（放行全部 Node 高危内置模块含 child_process/net/http/electron、fetch 及超限破坏性 fs 操作）");
  } else if (Array.isArray(cfg.allowHostModules) && cfg.allowHostModules.length > 0) {
    risks.push("allowHostModules:" + JSON.stringify(cfg.allowHostModules) + "（放行指定宿主/Node 内置模块）");
  }
  if (cfg.reveal === true) {
    risks.push("reveal:true（关闭日志与返回值的自动凭证脱敏，明文暴露密钥/令牌/原生 ID）");
  }
  return risks;
}

function assertHighRiskConfirmed(rt, cfg) {
  const risks = collectHighRiskFlags(cfg);
  if (risks.length > 0 && !(cfg && cfg.confirmRisk === true)) {
    throw rt.err(
      "CONFIRM_REQUIRED",
      "检测到高危开关，启用前需二次确认（请向用户说明风险并显式传 confirmRisk: true）：" + risks.join("；")
    );
  }
  return risks;
}

function createLoadTools(rt, loaderApi) {
  function devLoad(cfg) {
    const safeCfg = cfg || {};
    const risks = assertHighRiskConfirmed(rt, safeCfg);
    const callsBefore = rt.callsSeq;
    const gen = loaderApi.buildGeneration(safeCfg);
    if (rt.CURRENT_GEN) rt.CURRENT_GEN.retired = true;
    killTimers(rt.CURRENT_GEN);
    rt.CURRENT_GEN = gen;

    rt.persistLast({
      path: safeCfg.path,
      mode: safeCfg.mode || "plugin",
      allowSideEffects: !!safeCfg.allowSideEffects,
      allowHostModules: safeCfg.allowHostModules === undefined ? false : safeCfg.allowHostModules,
      reveal: !!safeCfg.reveal,
      timeoutMs: safeCfg.timeoutMs,
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
    if (risks.length) {
      gen.warnings.push("高危开关已按 confirmRisk 放行: " + risks.join("；"));
    }

    const out = {
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
      exports: formatManifest(gen.manifest, !!(safeCfg && safeCfg.verbose)),
      events: gen.eventsList,
      tools: toolsList(gen),
      warnings: gen.warnings,
      hint: "用 dev_call/dev_run 执行清单导出;name=__enter 可触发 onPluginEnter;UI 插件可用 dev_ui_open",
    };
    if (risks.length) out.riskNotice = risks;
    return out;
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

module.exports = { createLoadTools, toolsList, collectHighRiskFlags, assertHighRiskConfirmed };
