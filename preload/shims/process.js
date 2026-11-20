/**
 * process 白名单替身：暴露只读平台/环境信息，拦截 process.exit 并守卫 nextTick 异常。
 */
"use strict";

function makeProcessShim(recordUncaught) {
  const shim = {
    platform: process.platform,
    arch: process.arch,
    versions: Object.assign({}, process.versions),
    env: Object.assign({}, process.env),
    pid: process.pid,
    cwd: () => process.cwd(),
    nextTick: (fn, ...a) => Promise.resolve().then(() => {
      try { fn(...a); } catch (e) { recordUncaught(e); }
    }),
    hrtime: process.hrtime.bind(process),
    uptime: () => process.uptime(),
    memoryUsage: () => process.memoryUsage(),
    on: () => shim,
    once: () => shim,
    off: () => shim,
    removeListener: () => shim,
    addListener: () => shim,
    listeners: () => [],
    exit: (code) => { throw new Error("[dev-bridge] process.exit 已拦截(code=" + code + ")"); },
  };
  return shim;
}

module.exports = { makeProcessShim };
