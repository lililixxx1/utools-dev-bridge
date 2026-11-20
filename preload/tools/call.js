/**
 * dev_call 工具实现：
 * - 支持点路径导出、全生命周期特殊名（含 __mainPushSelect）与 __tool:<名>
 * - 多回调按顺序逐个 await 并返回数组
 * - 默认内联返回新增 console/calls（include 可显式控制）
 * - 支持 async:true 立即返回 jobId 交由 dev_job 跟踪
 */
"use strict";

const hostTimers = require("timers");
const { LIMITS, LIFECYCLE_SPECIALS } = require("../contract");
const { _isThenable, ser, shouldRedactResultByName, redactValue } = require("../serialize");

function attachInlineLogs(out, rt, consoleFrom, callsFrom, include, isOk) {
  const conSlice = rt.sliceRingSince(rt.ringConsole, consoleFrom, LIMITS.INLINE_LOG_CAP, false);
  const callsSlice = rt.sliceRingSince(rt.ringCalls, callsFrom, LIMITS.INLINE_LOG_CAP, true);

  if (Array.isArray(include)) {
    if (include.indexOf("console") >= 0) {
      out.console = conSlice.items;
      if (conSlice.more) out.consoleMore = true;
    }
    if (include.indexOf("calls") >= 0) {
      out.calls = callsSlice.items;
      if (callsSlice.more) out.callsMore = true;
    }
    return out;
  }

  if (conSlice.items.length > 0) {
    out.console = conSlice.items;
    if (conSlice.more) out.consoleMore = true;
  }
  if (!isOk && callsSlice.items.length > 0) {
    out.calls = callsSlice.items;
    if (callsSlice.more) out.callsMore = true;
  }
  return out;
}

function lookupExport(gen, name) {
  if (LIFECYCLE_SPECIALS[name]) return { special: name };
  if (name.indexOf("__tool:") === 0) {
    const tn = name.slice("__tool:".length);
    return gen.tools[tn] ? { tool: tn } : null;
  }
  const parts = name.split(".");
  let val = gen.ctx;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (i === 0) {
      if (!(p in gen.ctx)) return null;
      val = gen.ctx[p];
    } else {
      if (!val || !(p in Object(val))) return null;
      val = val[p];
    }
  }
  return { value: val };
}

function serializeCallResult(raw, name, reveal) {
  if (!reveal && shouldRedactResultByName(name) && raw != null && (typeof raw !== "object" || Buffer.isBuffer(raw))) {
    return redactValue(raw);
  }
  return ser(raw, false, { redact: !reveal });
}

function createCallTools(rt, loaderApi, proxyApi, jobMgr) {
  function _formatErrOut(errObj, t0, consoleFrom, callsFrom, include, meta) {
    const isDev = !!(errObj && errObj.__devErr);
    const out = {
      ok: false,
      code: isDev ? errObj.code : "THROWN",
      message: isDev ? String(errObj.message) : String((errObj && errObj.stack) || errObj),
      durationMs: Date.now() - t0,
      consoleFrom,
      callsFrom,
      consoleTo: rt.consoleSeq,
      callsTo: rt.callsSeq,
    };
    if (!isDev) out.hint = "dev_console/dev_calls_log 用 since 增量取现场";
    if (meta && meta.reloaded) out.reloaded = true;
    return attachInlineLogs(out, rt, consoleFrom, callsFrom, include, false);
  }

  async function _awaitWithBudget(promise, remainingMs) {
    if (remainingMs <= 0) {
      throw rt.err("ASYNC_TIMEOUT", "异步执行超时已放弃等待");
    }
    let timedOut = false;
    let guardId;
    const guard = new Promise((resolve) => {
      guardId = hostTimers.setTimeout(() => { timedOut = true; resolve(undefined); }, remainingMs);
    });
    try {
      const val = await Promise.race([promise, guard]);
      if (timedOut) {
        throw rt.err("ASYNC_TIMEOUT", "异步执行超时已放弃等待(代码可能仍在后台跑;await 之后的同步死循环无法打断)");
      }
      return val;
    } finally {
      hostTimers.clearTimeout(guardId);
    }
  }

  async function executeCall(cfg, meta) {
    loaderApi.ensureState(meta);
    if (!rt.CURRENT_GEN) throw rt.err("NOT_LOADED", "尚未加载目标;先调用 dev_load");
    const gen = rt.CURRENT_GEN;
    const timeoutMs = (cfg && cfg.timeoutMs) || LIMITS.CALL_TIMEOUT_DEFAULT;
    const name = String((cfg && cfg.name) || "");
    const found = lookupExport(gen, name);
    if (!found) {
      if (name.indexOf("__tool:") === 0) {
        const names = Object.keys(gen.tools);
        throw rt.err(
          "UNKNOWN_EXPORT",
          "目标未注册工具 '" + name.slice(7) + "'" + (names.length ? ";已注册: " + names.join(", ") : "(未见 utools.registerTool 调用)")
        );
      }
      const cands = gen.manifest.filter((m) => m.kind === "function").map((m) => m.name).slice(0, 40);
      throw rt.err("UNKNOWN_EXPORT", "未找到导出 '" + name + "';函数候选: " + cands.join(", "));
    }

    const isDom = found.special === "__domReady";
    const specialApi = found.special ? LIFECYCLE_SPECIALS[found.special] : null;
    const targets = found.tool
      ? [gen.tools[found.tool]]
      : found.special
        ? (isDom ? (gen.domEvents.DOMContentLoaded || []) : (gen.events[specialApi] || []))
        : [found.value];

    if (found.special && !targets.length) {
      throw rt.err(
        "UNKNOWN_EXPORT",
        isDom
          ? "目标未监听 document 的 DOMContentLoaded(查询类 stub 恒 null,见 README)"
          : "目标未注册 " + specialApi.slice("utools.".length) + " 回调;直接调用其导出函数即可"
      );
    }
    if (!found.special && found.value !== undefined && typeof found.value !== "function") {
      throw rt.err("UNKNOWN_EXPORT", "'" + name + "' 不是函数(kind=object);请调用其下级函数,如 " + name + ".xxx");
    }

    const t0 = Date.now();
    // 孪生探针：同时检查页面与 libuv 定时器，供排障渲染器挂起
    try { setTimeout(() => proxyApi.recordCall("probe.winTimer", [], undefined, null), 50); } catch (_) {}
    try { hostTimers.setTimeout(() => proxyApi.recordCall("probe.nodeTimer", [], undefined, null), 50); } catch (_) {}
    const consoleFrom = rt.consoleSeq;
    const callsFrom = rt.callsSeq;

    let activeJob = null;
    const earlyProgress = [];
    const callArgs = found.tool
      ? [((cfg && cfg.args) || [])[0], {
          requestId: "dev_call",
          sendProgress: async (o) => {
            proxyApi.recordCall("tool.progress:" + found.tool, [o], undefined, null, { stubbed: true });
            if (activeJob) jobMgr.pushProgress(activeJob, o);
            else if (cfg && cfg.async) earlyProgress.push(o);
          },
        }]
      : ((cfg && cfg.args) || []);

    const isMulti = targets.length > 1;
    let firstRaw;
    try {
      firstRaw = gen.container.runCall(targets[0], callArgs, timeoutMs, gen);
    } catch (e) {
      return _formatErrOut(e, t0, consoleFrom, callsFrom, cfg && cfg.include, meta);
    }

    // 异步 job 模式：同步已结束直接返回 done job；否则登记后台驱动并立即释放串口锁
    if (cfg && cfg.async) {
      if (!isMulti && !_isThenable(firstRaw)) {
        let result;
        try { result = serializeCallResult(firstRaw, name, gen.reveal); }
        catch (e) { throw rt.err("SERIALIZE_FAILED", "结果序列化失败: " + e.message); }
        const job = jobMgr.createJob(name, consoleFrom, callsFrom, gen.reveal);
        for (const p of earlyProgress) jobMgr.pushProgress(job, p);
        jobMgr.finishDone(job, result);
        const out = {
          ok: true,
          async: true,
          jobId: job.jobId,
          status: "done",
          result,
          durationMs: Date.now() - t0,
          consoleFrom,
          callsFrom,
          consoleTo: rt.consoleSeq,
          callsTo: rt.callsSeq,
        };
        if (meta && meta.reloaded) out.reloaded = true;
        return attachInlineLogs(out, rt, consoleFrom, callsFrom, cfg.include, true);
      }

      const job = jobMgr.createJob(name, consoleFrom, callsFrom, gen.reveal);
      for (const p of earlyProgress) jobMgr.pushProgress(job, p);
      activeJob = job;
      const runSequence = async () => {
        const results = [];
        const v0 = _isThenable(firstRaw) ? await firstRaw : firstRaw;
        results.push(v0);
        for (let i = 1; i < targets.length; i++) {
          if (job.status !== "running") return results;
          const rem = Math.max(1, timeoutMs - (Date.now() - t0));
          const vi = gen.container.runCall(targets[i], callArgs, rem, gen);
          results.push(_isThenable(vi) ? await vi : vi);
        }
        return isMulti ? results : results[0];
      };

      job._guardTimer = hostTimers.setTimeout(() => {
        jobMgr.finishError(job, "ASYNC_TIMEOUT", "异步任务超过 " + timeoutMs + "ms 超时");
      }, timeoutMs);

      runSequence().then(
        (finalRaw) => {
          if (job.status !== "running") return;
          try {
            jobMgr.finishDone(job, serializeCallResult(finalRaw, name, gen.reveal));
          } catch (e) {
            jobMgr.finishError(job, "SERIALIZE_FAILED", "结果序列化失败: " + e.message);
          }
        },
        (e) => {
          if (job.status !== "running") return;
          const isDev = !!(e && e.__devErr);
          jobMgr.finishError(job, isDev ? e.code : "THROWN", isDev ? String(e.message) : String((e && e.stack) || e));
        }
      );

      const out = {
        ok: true,
        async: true,
        jobId: job.jobId,
        status: "running",
        startedAt: job.startedAt,
        consoleFrom,
        callsFrom,
      };
      if (meta && meta.reloaded) out.reloaded = true;
      return out;
    }

    // 同步/常规 await 模式：逐个执行并 await 多回调
    const collected = [];
    try {
      const rem0 = Math.max(1, timeoutMs - (Date.now() - t0));
      collected.push(_isThenable(firstRaw) ? await _awaitWithBudget(firstRaw, rem0) : firstRaw);
      for (let i = 1; i < targets.length; i++) {
        const rem = Math.max(1, timeoutMs - (Date.now() - t0));
        const vi = gen.container.runCall(targets[i], callArgs, rem, gen);
        const remAfter = Math.max(1, timeoutMs - (Date.now() - t0));
        collected.push(_isThenable(vi) ? await _awaitWithBudget(vi, remAfter) : vi);
      }
    } catch (e) {
      return _formatErrOut(e, t0, consoleFrom, callsFrom, cfg && cfg.include, meta);
    }

    const raw = isMulti ? collected : collected[0];
    let result;
    try { result = serializeCallResult(raw, name, gen.reveal); }
    catch (e) { throw rt.err("SERIALIZE_FAILED", "结果序列化失败: " + e.message); }

    const out = {
      ok: true,
      result,
      durationMs: Date.now() - t0,
      consoleFrom,
      callsFrom,
      consoleTo: rt.consoleSeq,
      callsTo: rt.callsSeq,
    };
    if (meta && meta.reloaded) out.reloaded = true;
    return attachInlineLogs(out, rt, consoleFrom, callsFrom, cfg && cfg.include, true);
  }

  async function devCall(cfg) {
    const meta = {};
    return executeCall(cfg, meta);
  }

  return { lookupExport, executeCall, devCall, attachInlineLogs };
}

module.exports = { createCallTools, attachInlineLogs, lookupExport };
