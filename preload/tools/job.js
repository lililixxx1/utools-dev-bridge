/**
 * 异步调用任务管理器与 dev_job 工具实现（不进 serialized 队列，确保查询/等待不被阻塞）。
 */
"use strict";

const hostTimers = require("timers");
const { LIMITS } = require("../contract");
const { ser } = require("../serialize");

function createJobManager(rt) {
  function _wake(job) {
    if (!job._waiters || !job._waiters.length) return;
    const list = job._waiters.splice(0, job._waiters.length);
    for (const w of list) {
      if (w.timer) hostTimers.clearTimeout(w.timer);
      w.resolve();
    }
  }

  function _trimJobs() {
    while (rt.jobs.length > LIMITS.JOB_MAX) {
      const idx = rt.jobs.findIndex((j) => j.status !== "running");
      if (idx >= 0) rt.jobs.splice(idx, 1);
      else rt.jobs.shift();
    }
  }

  function createJob(name, consoleFrom, callsFrom, reveal) {
    const job = {
      jobId: "job-" + (++rt.jobSeq),
      name,
      status: "running",
      startedAt: new Date().toISOString(),
      t0: Date.now(),
      durationMs: 0,
      finishedAt: undefined,
      consoleFrom,
      callsFrom,
      consoleTo: consoleFrom,
      callsTo: callsFrom,
      progress: [],
      progressDropped: 0,
      result: undefined,
      code: undefined,
      message: undefined,
      reveal: !!reveal,
      _guardTimer: null,
      _waiters: [],
    };
    rt.jobs.push(job);
    _trimJobs();
    return job;
  }

  function pushProgress(job, data) {
    if (!job || job.status !== "running") return;
    if (job.progress.length >= LIMITS.JOB_PROGRESS_CAP) {
      job.progress.shift();
      job.progressDropped++;
    }
    job.progress.push({
      ts: new Date().toISOString(),
      data: ser(data, true, { redact: !job.reveal }),
    });
  }

  function finishDone(job, result) {
    if (!job || job.status !== "running") return;
    if (job._guardTimer) { hostTimers.clearTimeout(job._guardTimer); job._guardTimer = null; }
    job.status = "done";
    job.finishedAt = new Date().toISOString();
    job.durationMs = Date.now() - job.t0;
    job.consoleTo = rt.consoleSeq;
    job.callsTo = rt.callsSeq;
    job.result = result;
    _wake(job);
  }

  function finishError(job, code, message) {
    if (!job || job.status !== "running") return;
    if (job._guardTimer) { hostTimers.clearTimeout(job._guardTimer); job._guardTimer = null; }
    job.status = code === "ASYNC_TIMEOUT" ? "timeout" : "error";
    job.finishedAt = new Date().toISOString();
    job.durationMs = Date.now() - job.t0;
    job.consoleTo = rt.consoleSeq;
    job.callsTo = rt.callsSeq;
    job.code = code;
    job.message = message;
    _wake(job);
  }

  function formatJobView(job) {
    const out = {
      ok: job.status === "done" || job.status === "running",
      jobId: job.jobId,
      name: job.name,
      status: job.status,
      startedAt: job.startedAt,
      durationMs: job.status === "running" ? (Date.now() - job.t0) : job.durationMs,
      progress: job.progress,
      consoleFrom: job.consoleFrom,
      callsFrom: job.callsFrom,
      consoleTo: job.status === "running" ? rt.consoleSeq : job.consoleTo,
      callsTo: job.status === "running" ? rt.callsSeq : job.callsTo,
    };
    if (job.progressDropped > 0) out.progressDropped = job.progressDropped;
    if (job.finishedAt) out.finishedAt = job.finishedAt;
    if (job.status === "done") out.result = job.result;
    if (job.status === "error" || job.status === "timeout" || job.status === "cancelled") {
      out.ok = false;
      out.code = job.code || (job.status === "cancelled" ? "CANCELLED" : "THROWN");
      out.message = job.message || (job.status === "cancelled" ? "任务已取消" : "异步任务失败");
    }
    const con = rt.sliceRingSince(rt.ringConsole, job.consoleFrom, LIMITS.INLINE_LOG_CAP, false);
    if (con.items.length) {
      out.console = con.items;
      if (con.more) out.consoleMore = true;
    }
    if (job.status !== "done") {
      const cal = rt.sliceRingSince(rt.ringCalls, job.callsFrom, LIMITS.INLINE_LOG_CAP, true);
      if (cal.items.length) {
        out.calls = cal.items;
        if (cal.more) out.callsMore = true;
      }
    }
    return out;
  }

  async function devJob(cfg) {
    const id = cfg && cfg.id;
    if (!id) {
      return {
        ok: true,
        jobs: rt.jobs.slice().reverse().map((j) => ({
          jobId: j.jobId,
          name: j.name,
          status: j.status,
          startedAt: j.startedAt,
          durationMs: j.status === "running" ? (Date.now() - j.t0) : j.durationMs,
          progressCount: j.progress.length,
        })),
      };
    }
    const job = rt.jobs.find((j) => j.jobId === id);
    if (!job) throw rt.err("JOB_NOT_FOUND", "未找到异步任务 '" + id + "'");

    if (cfg.cancel && job.status === "running") {
      if (job._guardTimer) { hostTimers.clearTimeout(job._guardTimer); job._guardTimer = null; }
      job.status = "cancelled";
      job.finishedAt = new Date().toISOString();
      job.durationMs = Date.now() - job.t0;
      job.code = "CANCELLED";
      job.message = "用户调用 dev_job {cancel:true} 中止等待";
      job.consoleTo = rt.consoleSeq;
      job.callsTo = rt.callsSeq;
      _wake(job);
      return formatJobView(job);
    }

    const waitMs = Math.min(Math.max(0, Number(cfg.waitMs) || 0), 25000);
    if (waitMs > 0 && job.status === "running") {
      await new Promise((resolve) => {
        const w = { resolve, timer: null };
        w.timer = hostTimers.setTimeout(() => {
          const i = job._waiters.indexOf(w);
          if (i >= 0) job._waiters.splice(i, 1);
          resolve();
        }, waitMs);
        job._waiters.push(w);
      });
    }
    return formatJobView(job);
  }

  return { createJob, pushProgress, finishDone, finishError, devJob };
}

module.exports = { createJobManager };
