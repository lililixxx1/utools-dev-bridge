/**
 * 定时器替身与代际级清理：
 * 沙箱定时器优先走 Node libuv 通道（require("timers")），绕开 Chromium 隐藏页节流；
 * 同时登记至 gen.timers 并守卫回调异常，确保 reload/cleanup 可彻底回收。
 */
"use strict";

const hostTimers = require("timers");

function makeTimers(gen, recordCall, guardAsyncFn) {
  const tSetTimeout = hostTimers.setTimeout || globalThis.setTimeout;
  const tClearTimeout = hostTimers.clearTimeout || globalThis.clearTimeout;
  const tSetInterval = hostTimers.setInterval || globalThis.setInterval;
  const tClearInterval = hostTimers.clearInterval || globalThis.clearInterval;
  const hostSetImmediate = (hostTimers.setImmediate || globalThis.setImmediate)
    ? (hostTimers.setImmediate || globalThis.setImmediate)
    : (fn, ...a) => tSetTimeout(fn, 0, ...a);
  const hostClearImmediate = (hostTimers.clearImmediate || globalThis.clearImmediate) || function () {};
  const markTimer = (api, arg) => recordCall(
    api,
    [arg && typeof arg === "object" ? { nodeTimer: true, ms: arg._idleTimeout } : arg],
    undefined,
    null
  );

  const timers = {
    setTimeout: (fn, ms, ...a) => {
      const id = tSetTimeout(() => { markTimer("timer.fire", id); guardAsyncFn(fn).apply(undefined, a); }, ms);
      markTimer("timer.schedule", id);
      gen.timers.add(id);
      return id;
    },
    setInterval: (fn, ms, ...a) => {
      const id = tSetInterval(() => { markTimer("timer.fire", id); guardAsyncFn(fn).apply(undefined, a); }, ms);
      markTimer("timer.schedule", id);
      gen.timers.add(id);
      return id;
    },
    setImmediate: (fn, ...a) => {
      const id = hostSetImmediate(() => { markTimer("timer.fire", id); guardAsyncFn(fn).apply(undefined, a); });
      markTimer("timer.schedule", id);
      gen.timers.add(id);
      return id;
    },
    clearTimeout: (id) => { gen.timers.delete(id); tClearTimeout(id); },
    clearInterval: (id) => { gen.timers.delete(id); tClearInterval(id); },
    clearImmediate: (id) => { gen.timers.delete(id); hostClearImmediate(id); },
  };
  const promises = {
    setTimeout: (ms, v) => new Promise((resolve) => {
      const id = tSetTimeout(() => resolve(v), ms);
      gen.timers.add(id);
    }),
    setImmediate: (v) => new Promise((resolve) => {
      const id = hostSetImmediate(() => resolve(v));
      gen.timers.add(id);
    }),
  };
  timers.promises = promises;
  return { timers, promises };
}

function killTimers(gen) {
  if (!gen) return;
  for (const id of gen.timers) {
    try { (hostTimers.clearTimeout || clearTimeout)(id); } catch (_) {}
    try { clearTimeout(id); } catch (_) {}
    try { (hostTimers.clearInterval || clearInterval)(id); } catch (_) {}
    try { clearInterval(id); } catch (_) {}
    try { if (hostTimers.clearImmediate) hostTimers.clearImmediate(id); } catch (_) {}
    try { if (typeof clearImmediate === "function") clearImmediate(id); } catch (_) {}
  }
  gen.timers.clear();
}

module.exports = { makeTimers, killTimers };
