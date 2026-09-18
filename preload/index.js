/**
 * dev-bridge — uTools 插件开发测试桥(纯 AI 插件,无 UI)
 *
 * 机制:plugin.json tools 声明 + 顶层 registerTool,经 uTools MCP 网关暴露给 agent。
 * 核心:自实现 CJS loader(目标模块逐个 vm 编译并【在 vm 内】执行,缓存仅存活于当前
 *       沙箱代际,宿主 require.cache 零污染 → services 级热重载真实生效);
 *      深代理逐叶子录制 utools 调用(含 db.promises.* / ubrowser 链);
 *      破坏性 utools API 默认 stub;Node 内置模块白名单门控(默认拒绝,防意外非安全边界);
 *      fs 写副作用 WAL 写日志(前态先落盘再执行,可还原);
 *      db/dbStorage/dbCryptoStorage/fs 写前抓前态,journal 持久化,重启后仍可还原;
 *      一切同步执行(模块顶层/被调函数)均经 runInContext({timeout}),死循环不挂宿主;
 *      timers/microtask 回调 try/catch 录制,目标异步异常不冒宿主。
 *
 * 错误契约:所有工具失败返回 {ok:false, code, message}
 *   PATH_NOT_FOUND / NO_PLUGIN_JSON / NO_PRELOAD / SYNTAX_ERROR / REQUIRE_FAILED
 *   / UNKNOWN_EXPORT / NOT_LOADED / TIMEOUT / ASYNC_TIMEOUT / SERIALIZE_FAILED
 *   / DENIED_MODULE / DENIED_FETCH / DENIED_FS_UNTRACKED
 */
"use strict";
// 引导保护网:IIFE+catch,任何顶层启动崩溃都会注册 dev_boot_err 回传崩溃栈(而非静默无工具)
(function () {
try {
const fs = require("fs");
const path = require("path");
const os = require("os");
const vm = require("vm");
const Module = require("module");
// libuv 定时器通道:uTools 无 UI 插件的隐藏页会被 Chromium 冻结 DOM 定时器(实测 62s 零触发),
// 沙箱定时器一律走 node timers 绕开页面节流
const hostTimers = require("timers");

const REAL = utools; // 真实 API,桥内部一律用它,不经代理

// ---------- 常量 ----------
const RING_MAX = 500;
const JOURNAL_MAX = 2000;
const SER_DEPTH = 8;
const SER_BUDGET = 65536;
const DIGEST_BUDGET = 4096;
const LOAD_TIMEOUT_DEFAULT = 10000;
const CALL_TIMEOUT_DEFAULT = 30000;

// 破坏性 API:默认 stub,dev_load allowSideEffects=true 才透传(审核 B5)
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
]);

// 生命周期事件:登记回调而非真注册(供 __enter 等特殊名触发)
const EVENT_APIS = new Set([
  "utools.onPluginEnter", "utools.onPluginOut", "utools.onMainPush",
  "utools.onPluginDetach", "utools.onDbPull",
]);

// dev_call 特殊名 → 生命周期回调表(P2);__domReady 触发 document DOMContentLoaded 监听
const LIFECYCLE_SPECIALS = {
  __enter: "utools.onPluginEnter",
  __out: "utools.onPluginOut",
  __detach: "utools.onPluginDetach",
  __dbPull: "utools.onDbPull",
  __mainPush: "utools.onMainPush",
  __domReady: "__dom",
};

// 深代理强制递归的命名空间(不论构造器/是否函数,审核 B2)
const FORCE_RECURSE_PROPS = new Set(["db", "dbStorage", "dbCryptoStorage", "promises", "ubrowser"]);

// ---------- Node 内置模块门控(v3 白名单制:B1) ----------
// deny 名单只用于错误提示;实际规则 = map 命中 → 安全替身;allow 名单命中 → 透传;
// 其余(含 electron 与未来新增内置模块)一律默认拒绝 → allowHostModules 放行
const DENY_MODULES = new Set([
  "child_process", "worker_threads", "cluster",
  "http", "https", "http2", "net", "dgram", "tls", "dns",
  "inspector", "vm", "v8", "repl", "readline", "electron",
]);
const ALLOW_MODULES = new Set((Module.builtinModules || []).filter((m) =>
  !DENY_MODULES.has(m)
  && !m.startsWith("_") // 下划线内部模块(_http_client/_tls_wrap 等)默认拒绝,防绕过 deny
  && !["process", "console", "timers", "timers/promises", "fs", "fs/promises", "module"].includes(m)
));

// denied 模块上按 noop+录制处理的"事件注册族"(返回自身可链式)
const EVENT_NOOP_PROPS = new Set([
  "on", "once", "off", "send", "addListener", "removeListener", "removeAllListeners",
  "prependListener", "prependOnceListener", "emit", "setMaxListeners", "getMaxListeners",
]);

// vm context 缺失的 web/Node 全局(存在即透传,M5);fetch 单独门控不在此列
const WEB_GLOBALS = [
  "URL", "URLSearchParams", "TextEncoder", "TextDecoder",
  "AbortController", "AbortSignal", "atob", "btoa",
  "structuredClone", "performance",
];

// ---------- fs 写日志上限(M3:超限显式,绝不静默) ----------
const FS_FILE_CAP = 8 * 1024 * 1024;      // 单文件前态 8MB
const FS_DIR_FILES_CAP = 500;             // 单次目录快照 500 文件
const FS_SPILL_CAP = 64 * 1024 * 1024;    // spill 总量 64MB,超限丢最旧并 truncated 标记

// ---------- 环形缓冲与写日志 ----------
const ringConsole = [];
const ringCalls = [];
const journal = []; // 数据副作用还原日志,不受环形截断(审核 G5)
let consoleSeq = 0;
let callsSeq = 0;

function pushRing(arr, entry) {
  arr.push(entry);
  if (arr.length > RING_MAX) arr.splice(0, arr.length - RING_MAX);
}

function err(code, message) {
  const e = new Error(message);
  e.__devErr = true;
  e.code = code;
  return e;
}

// ---------- 序列化器(审核 S5) ----------
function _isThenable(v) { return v && typeof v.then === "function"; }

function ser(v, digest) {
  try {
    return _ser(v, 0, new WeakSet(), { left: digest ? DIGEST_BUDGET : SER_BUDGET }, digest ? 4 : SER_DEPTH, digest ? DIGEST_BUDGET : SER_BUDGET);
  } catch (e) {
    return { __serError: String(e && e.message) };
  }
}

function _budgetStr(s, budget, limit) {
  if (budget.left <= 0) return "[__truncated]";
  const take = Math.min(s.length, budget.left, 200000);
  budget.left -= take;
  return take < s.length ? s.slice(0, take) + "…[__truncated]" : s;
}

function _ser(v, depth, seen, budget, maxDepth, limit) {
  if (v === null || v === undefined) return v;
  const t = typeof v;
  if (t === "boolean") return v;
  if (t === "number") return Number.isFinite(v) ? v : String(v);
  if (t === "bigint") return { __bigint: String(v) };
  if (t === "string") return _budgetStr(v, budget, limit);
  if (t === "function") {
    let name = "(anonymous)", len = -1, head = "";
    try { name = v.name || name; len = v.length; head = String(v).slice(0, 160); } catch (_) {}
    return { __function: true, name, length: len, src: head };
  }
  if (t !== "object") return { __type: t };
  // 跨 realm 判型:vm 内创建的 Error/Date/Map 等对宿主 instanceof 全部失效,必须用 toString 标签
  const tag = Object.prototype.toString.call(v);
  if (tag === "[object Error]") return { __error: true, name: String(v.name), message: String(v.message), stack: String(v.stack || "").slice(0, 2000) };
  if (tag === "[object Date]") return { __date: v.toISOString ? v.toISOString() : String(v) };
  if (tag === "[object RegExp]") return { __regexp: String(v) };
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(v)) {
    return { __buffer: true, bytes: v.length, head: v.slice(0, 48).toString("base64") };
  }
  if (ArrayBuffer.isView(v)) return { __typedArray: v.constructor.name, bytes: v.byteLength };
  if (seen.has(v)) return "[Circular]";
  if (depth >= maxDepth) return { __depthLimit: true };
  if (_isThenable(v)) return { __promise: true, note: "未 await 的 Promise" };
  seen.add(v);
  try {
    if (Array.isArray(v)) {
      const out = [];
      const n = Math.min(v.length, 100);
      for (let i = 0; i < n; i++) out.push(_ser(v[i], depth + 1, seen, budget, maxDepth, limit));
      if (v.length > n) out.push({ __truncated: true, length: v.length });
      return out;
    }
    if (tag === "[object Map]") {
      const out = [];
      for (const [k, val] of v) {
        if (out.length >= 50) { out.push({ __truncated: true }); break; }
        out.push([_ser(k, depth + 1, seen, budget, maxDepth, limit), _ser(val, depth + 1, seen, budget, maxDepth, limit)]);
      }
      return { __map: out };
    }
    if (tag === "[object Set]") {
      const out = [];
      for (const val of v) {
        if (out.length >= 100) { out.push({ __truncated: true }); break; }
        out.push(_ser(val, depth + 1, seen, budget, maxDepth, limit));
      }
      return { __set: out };
    }
    const out = {};
    for (const k of Object.keys(v).slice(0, 100)) out[k] = _ser(v[k], depth + 1, seen, budget, maxDepth, limit);
    return out;
  } finally {
    seen.delete(v);
  }
}

// ---------- 写日志:调用【前】抓前态,成功后入账(审核 G4/G5) ----------
function _safeGet(id) {
  try { return REAL.db.get(id) || null; } catch (_) { return null; }
}

function isJournaledApi(api) {
  return /^utools\.db(\.promises)?\.(put|remove|bulkDocs|postAttachment)$/.test(api)
    || /^utools\.db(Crypto)?Storage\.(set|remove)Item$/.test(api);
}

function capturePre(api, args) {
  try {
    if (/\.db(\.promises)?\.put$/.test(api)) {
      const doc = args && args[0];
      return doc && doc._id ? { kind: "put", id: doc._id, prev: _safeGet(doc._id) } : null;
    }
    if (/\.db(\.promises)?\.remove$/.test(api)) {
      const a = args && args[0];
      const id = typeof a === "string" ? a : a && a._id;
      return id ? { kind: "remove", id, prev: _safeGet(id) } : null;
    }
    if (/\.db(\.promises)?\.bulkDocs$/.test(api)) {
      const docs = (args && args[0]) || [];
      return { kind: "bulkDocs", prevs: docs.filter((d) => d && d._id).map((d) => ({ id: d._id, doc: _safeGet(d._id) })) };
    }
    if (/\.db(\.promises)?\.postAttachment$/.test(api)) {
      const aid = args && args[0];
      return { kind: "attachment", id: aid, prev: _safeGet(aid) }; // 抓前态:既有文档挂附件时还原文档而非误删
    }
    if (/Storage\.(set|remove)Item$/.test(api)) {
      const key = args && args[0];
      const crypto = /dbCryptoStorage/.test(api);
      const store = crypto ? REAL.dbCryptoStorage : REAL.dbStorage;
      let prev;
      try { prev = store.getItem(key); } catch (_) { prev = undefined; }
      return { kind: "kv", key, prev, crypto, del: /removeItem$/.test(api) };
    }
  } catch (_) {}
  return null;
}

function commitJournal(pre, api, result) {
  const push = (curRev) => {
    const e = { api, ts: new Date().toISOString() };
    if (pre.kind === "put") { e.kind = "put"; e.id = pre.id; e.prev = pre.prev; e.curRev = curRev; }
    else if (pre.kind === "remove") { e.kind = "remove"; e.id = pre.id; e.prev = pre.prev; }
    else if (pre.kind === "bulkDocs") { e.kind = "bulkDocs"; e.prevs = pre.prevs; }
    else if (pre.kind === "attachment") { e.kind = "attachment"; e.id = pre.id; }
    else if (pre.kind === "kv") { e.kind = "kv"; e.key = pre.key; e.prev = pre.prev; e.crypto = pre.crypto; e.del = pre.del; }
    pushJournalEntry(e); // v3:统一走 WAL 通道(上限/溢出淘汰/元数据落盘)
  };
  if (_isThenable(result)) {
    result.then(
      (r) => push(Array.isArray(r) ? undefined : r && r._rev),
      () => {}
    );
  } else {
    push(result && result._rev);
  }
}

// ---------- utools 深代理(审核 B2) ----------
function recordCall(api, args, result, error, stubbed, denied, untracked) {
  const entry = {
    seq: ++callsSeq,
    ts: new Date().toISOString(),
    api,
    args: (args || []).map((a) => ser(a, true)),
  };
  if (stubbed) entry.stubbed = true;
  if (denied) entry.denied = true;
  if (untracked) entry.untracked = true;
  if (error) { entry.ok = false; entry.error = String((error && error.message) || error); }
  else { entry.ok = true; if (result !== undefined) entry.result = ser(result, true); }
  pushRing(ringCalls, entry);
}

// 目标异步回调内的异常:录进 console 环,不冒宿主 uncaughtException(M2)
function recordUncaught(e) {
  pushRing(ringConsole, { seq: ++consoleSeq, ts: new Date().toISOString(), level: "uncaught", args: [ser(e, true)] });
}
function guardAsyncFn(fn) {
  return function (...a) {
    try { return fn.apply(this, a); }
    catch (e) { recordUncaught(e); return undefined; }
  };
}

let CURRENT_GEN = null; // 当前沙箱代际

function makeLeaf(origFn, api, gen, allowSE) {
  return function (...args) {
    if (gen.retired) {
      const e = new Error("[dev-bridge] 旧代际代理已废弃: " + api);
      recordCall(api, args, undefined, e);
      throw e;
    }
    if (EVENT_APIS.has(api)) {
      (gen.events[api] = gen.events[api] || []).push(args[0]);
      recordCall(api, args, undefined, null, true);
      return undefined;
    }
    if (api === "utools.registerTool") { recordCall(api, args, undefined, null, true); return undefined; }
    if (STUBBED_APIS.has(api) && !allowSE) {
      const out = { stubbed: true, api, note: "破坏性 API 已被 dev-bridge 拦截;dev_load 传 allowSideEffects:true 放行" };
      recordCall(api, args, out, null, true);
      return out;
    }
    const pre = isJournaledApi(api) ? capturePre(api, args) : null;
    let res;
    try {
      res = origFn.apply(this, args);
    } catch (e) {
      recordCall(api, args, undefined, e);
      throw e;
    }
    if (pre) commitJournal(pre, api, res);
    recordCall(api, args, res);
    return res; // 返回值永不包装,链式调用不破
  };
}

// 真实 utools 对象带只读不可配置属性(疑似整树 freeze):代理 get 不能返回包装值,
// 否则违反"non-configurable+non-writable 必须原样返回"不变量直接 TypeError。
// 故代理目标用空白可配置 shim,读写枚举全部转发到真实对象,包装逻辑不受限。
function forwardTraps(realObj) {
  return {
    has(_, prop) { return prop in realObj; },
    ownKeys() { return Reflect.ownKeys(realObj); },
    getOwnPropertyDescriptor(_, prop) {
      const d = Reflect.getOwnPropertyDescriptor(realObj, prop);
      return d ? { configurable: true, enumerable: !!d.enumerable } : undefined;
    },
  };
}

// 代际级包装缓存:键 realObj → apiPath → wrapper。修 identity(utools.db===utools.db)+性能;
// 存 gen 上,热重载即整体失效(保 v2 G8 语义)
function cachedWrap(gen, realObj, apiPath, make) {
  let m = gen.proxyCache.get(realObj);
  if (!m) { m = new Map(); gen.proxyCache.set(realObj, m); }
  let w = m.get(apiPath);
  if (!w) { w = make(); m.set(apiPath, w); }
  return w;
}

function wrapLeaf(origFn, api, gen, allowSE) {
  return cachedWrap(gen, origFn, api, () => makeLeaf(origFn, api, gen, allowSE));
}

function wrapNamespace(realObj, apiPath, gen, allowSE) {
  return cachedWrap(gen, realObj, apiPath, () => new Proxy({}, Object.assign({
    get(_, prop) {
      if (typeof prop === "symbol") return Reflect.get(realObj, prop);
      const val = Reflect.get(realObj, prop); // 不传 receiver,防 getter this 漂移
      const api = apiPath + "." + String(prop);
      if (typeof val === "function") {
        // ubrowser 这类"函数即命名空间"的链式 API:包成函数代理,属性继续深代理
        if (FORCE_RECURSE_PROPS.has(String(prop))) return wrapFnNamespace(val, api, gen, allowSE);
        return wrapLeaf(val, api, gen, allowSE);
      }
      if (val && typeof val === "object") {
        const plain = !val.constructor || val.constructor === Object;
        if (plain || FORCE_RECURSE_PROPS.has(String(prop))) return wrapNamespace(val, api, gen, allowSE);
      }
      return val;
    },
  }, forwardTraps(realObj))));
}

function wrapFnNamespace(origFn, api, gen, allowSE) {
  return cachedWrap(gen, origFn, api, () => new Proxy(origFn, {
    apply(target, thisArg, args) {
      return makeLeaf(target, api, gen, allowSE).apply(thisArg, args);
    },
    get(target, prop) {
      if (typeof prop === "symbol") return Reflect.get(target, prop);
      const val = Reflect.get(target, prop);
      // 函数载体上的只读不可配置属性(name/length/freeze 后的方法)必须原样返回,包装即违不变量
      const desc = Reflect.getOwnPropertyDescriptor(target, prop);
      if (desc && !desc.configurable && desc.writable === false) return val;
      const subApi = api + "." + String(prop);
      if (typeof val === "function") {
        return wrapLeaf(val, subApi, gen, allowSE); // this 由调用方(代理链)维持
      }
      if (val && typeof val === "object") return wrapNamespace(val, subApi, gen, allowSE);
      return val;
    },
  }));
}

function makeUtoolsProxy(gen) {
  return wrapNamespace(REAL, "utools", gen, gen.allowSideEffects);
}

// ---------- process 白名单 shim(审核 S3) ----------
function makeProcessShim() {
  const shim = {
    platform: process.platform,
    arch: process.arch,
    versions: Object.assign({}, process.versions),
    env: Object.assign({}, process.env),
    pid: process.pid,
    cwd: () => process.cwd(),
    nextTick: (fn, ...a) => Promise.resolve().then(() => { try { fn(...a); } catch (e) { recordUncaught(e); } }),
    hrtime: process.hrtime.bind(process),
    uptime: () => process.uptime(),
    memoryUsage: () => process.memoryUsage(),
    on: () => shim, once: () => shim, off: () => shim,
    removeListener: () => shim, addListener: () => shim, listeners: () => [],
    exit: (code) => { throw new Error("[dev-bridge] process.exit 已拦截(code=" + code + ")"); },
  };
  return shim;
}

// ---------- console 录制 + 定时器登记(审核 G6;v3 补全方法/异步守卫) ----------
function makeConsole() {
  const wrap = (level) => (...args) => {
    pushRing(ringConsole, { seq: ++consoleSeq, ts: new Date().toISOString(), level, args: args.map((a) => ser(a, true)) });
  };
  const out = {};
  for (const m of ["log", "info", "warn", "error", "debug", "table", "trace", "dir",
    "time", "timeEnd", "timeLog", "timeStamp", "group", "groupEnd", "groupCollapsed",
    "clear", "assert", "count", "countReset", "dirxml", "profile", "profileEnd"]) {
    out[m] = m === "assert"
      ? (cond, ...args) => { if (!cond) wrap("error")(...args); }
      : wrap(m);
  }
  return out;
}

function makeTimers(gen) {
  // 双通道:libuv 为主(不受隐藏页冻结影响);setImmediate/clearImmediate 渲染器可能缺失,做兜底
  const tSetTimeout = hostTimers.setTimeout || globalThis.setTimeout;
  const tClearTimeout = hostTimers.clearTimeout || globalThis.clearTimeout;
  const tSetInterval = hostTimers.setInterval || globalThis.setInterval;
  const tClearInterval = hostTimers.clearInterval || globalThis.clearInterval;
  const hostSetImmediate = (hostTimers.setImmediate || globalThis.setImmediate) ? (hostTimers.setImmediate || globalThis.setImmediate) : (fn, ...a) => tSetTimeout(fn, 0, ...a);
  const hostClearImmediate = (hostTimers.clearImmediate || globalThis.clearImmediate) || function () {};
  const markTimer = (api, arg) => recordCall(api, [arg && typeof arg === "object" ? { nodeTimer: true, ms: arg._idleTimeout } : arg], undefined, null, false, false, false);
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
  // timers/promises:登记进 gen.timers 不可行(无 id),靠 timeout 保护语义即可;无用户回调无需守卫
  const promises = {
    setTimeout: (ms, v) => new Promise((resolve) => { const id = tSetTimeout(() => resolve(v), ms); gen.timers.add(id); }),
    setImmediate: (v) => new Promise((resolve) => { const id = hostSetImmediate(() => resolve(v)); gen.timers.add(id); }),
  };
  timers.promises = promises; // require('timers').promises 同体
  return { timers, promises };
}

function killTimers(gen) {
  if (!gen) return;
  for (const id of gen.timers) {
    try { (hostTimers.clearTimeout || clearTimeout)(id); } catch (_) {} // libuv 通道
    try { clearTimeout(id); } catch (_) {} // window 通道(id 兼容时任一生效)
    try { (hostTimers.clearInterval || clearInterval)(id); } catch (_) {}
    try { clearInterval(id); } catch (_) {}
    try { if (hostTimers.clearImmediate) hostTimers.clearImmediate(id); } catch (_) {}
    try { if (typeof clearImmediate === "function") clearImmediate(id); } catch (_) {} // 实测 uTools 渲染器 window 侧无此全局
  }
  gen.timers.clear();
}

// ---------- denied 模块懒拒绝代理(v3 B1:空白载体+单例缓存;事件族 noop 可链式;任意深度递归) ----------
const deniedModuleCache = new Map();

function deniedMsg(api) {
  return err("DENIED_MODULE", "[dev-bridge] 模块行为已拦截(" + api + ");dev_load 传 allowHostModules:true 或白名单数组放行");
}

// 函数型 denied 节点:调用即抛 DENIED_MODULE;属性访问继续递归 denied(electron.ipcRenderer.on 这类多级链不炸)
function makeDeniedFn(api) {
  const fn = function (...args) {
    recordCall(api + "()", args, undefined, null, true, true);
    throw deniedMsg(api);
  };
  return new Proxy(fn, {
    get(_, prop) {
      if (typeof prop === "symbol") return undefined;
      const sub = api + "." + String(prop);
      recordCall(sub, [], undefined, null, true, true);
      return EVENT_NOOP_PROPS.has(String(prop)) ? makeDeniedChainNoop(sub) : makeDeniedFn(sub);
    },
  });
}

// 事件注册族节点:noop+录制,返回自身代理可链式(x.on(a).on(b) 不炸)
function makeDeniedChainNoop(api) {
  const f = function () { recordCall(api + "()", [], undefined, null, true, true); return proxy; };
  const proxy = new Proxy(f, {
    get(_, prop) {
      if (typeof prop === "symbol") return undefined;
      const sub = api + "." + String(prop);
      recordCall(sub, [], undefined, null, true, true);
      return EVENT_NOOP_PROPS.has(String(prop)) ? makeDeniedChainNoop(sub) : makeDeniedFn(sub);
    },
  });
  return proxy;
}

function makeDeniedModule(name) {
  if (deniedModuleCache.has(name)) return deniedModuleCache.get(name);
  const proxy = new Proxy(Object.create(null), {
    get(_, prop) {
      if (typeof prop === "symbol") return undefined;
      const api = "require:" + name + "." + String(prop);
      recordCall(api, [], undefined, null, true, true);
      return EVENT_NOOP_PROPS.has(String(prop)) ? makeDeniedChainNoop(api) : makeDeniedFn(api);
    },
    has(_, prop) { return typeof prop === "string"; },
  });
  deniedModuleCache.set(name, proxy);
  return proxy;
}

// ---------- fs 写日志(v3 决策1:真实写 + WAL 前态落盘,cleanup 还原;B2/M3) ----------
let spillSeq = 0;
let spillBytes = 0;
let journalTruncated = false;
let PENDING_RESTORE = 0;
let _journalDir = null;
function journalDir() {
  if (_journalDir) return _journalDir;
  let base;
  try { const t = REAL.getPath && REAL.getPath("temp"); if (t && typeof t === "string") base = t; } catch (_) {}
  if (!base) base = os.tmpdir();
  _journalDir = path.join(base, "devbridge-journal");
  return _journalDir;
}
function spillPath(file) { return path.join(journalDir(), file); }

// spill 写入必须用桥自身 require 的 fs,绝不经沙箱 shim(否则递归)
function writeSpillBuffer(buf) {
  fs.mkdirSync(journalDir(), { recursive: true });
  const file = "pre-" + Date.now() + "-" + (++spillSeq) + ".bin";
  fs.writeFileSync(spillPath(file), buf);
  spillBytes += buf.length;
  return { file, size: buf.length };
}

function dropSpills(entry) {
  for (const s of entry.spills || []) {
    try { fs.unlinkSync(spillPath(s.file)); } catch (_) {}
    spillBytes -= s.size;
  }
}

// spill 总量超 64MB:丢最旧并标记 spillLost,cleanup 会以失败形式暴露(truncated)
function evictSpillOverCap() {
  while (spillBytes > FS_SPILL_CAP) {
    const e = journal.find((j) => j.spills && j.spills.length && !j.spillLost);
    if (!e) break;
    dropSpills(e);
    e.spillLost = true;
    journalTruncated = true;
  }
}

// journal 元数据原子落盘(db/kv/fs 条目共用;内容永远在独立 spill 文件)
function persistJournalMeta() {
  try {
    const dir = journalDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(spillPath("journal.json.tmp"), JSON.stringify(journal));
    fs.renameSync(spillPath("journal.json.tmp"), spillPath("journal.json"));
  } catch (_) {}
}

// 桥启动时回灌:上次会话未还原的条目仍可 dev_cleanup(决策5)
function restoreJournalMeta() {
  try {
    const fin = spillPath("journal.json");
    if (!fs.existsSync(fin)) return;
    const entries = JSON.parse(fs.readFileSync(fin, "utf8"));
    if (!Array.isArray(entries)) return;
    for (const e of entries) {
      for (const s of e.spills || []) {
        try { spillBytes += fs.statSync(spillPath(s.file)).size; }
        catch (_) { e.spillLost = true; journalTruncated = true; }
      }
      journal.push(e);
    }
    PENDING_RESTORE = journal.length;
  } catch (_) {}
}

function pushJournalEntry(e) {
  while (journal.length >= JOURNAL_MAX) {
    const old = journal.shift();
    dropSpills(old);
    journalTruncated = true;
  }
  journal.push(e);
  evictSpillOverCap();
  persistJournalMeta();
}

// 单文件/符号链接前态快照;超 8MB → over:true(调用方按 M3 分级处置)
function snapFileStat(p) {
  let st;
  try { st = fs.lstatSync(p); } catch (_) { return { exists: false }; }
  if (st.isSymbolicLink()) {
    let linkTarget = null;
    try { linkTarget = fs.readlinkSync(p); } catch (_) {}
    return { exists: true, isLink: true, linkTarget };
  }
  if (!st.isFile()) return { exists: true, special: true };
  if (st.size > FS_FILE_CAP) return { exists: true, over: true, size: st.size };
  try {
    const spills = [writeSpillBuffer(fs.readFileSync(p))];
    return { exists: true, size: st.size, spills };
  } catch (_) { return { exists: true, over: true, size: st.size }; }
}

// 目录递归快照,上限 500 文件;超限/读失败 → truncated:true(不可完整还原)
function snapDirStat(p) {
  const files = [];
  let truncated = false;
  const walk = (dir, rel) => {
    let names;
    try { names = fs.readdirSync(dir); } catch (_) { truncated = true; return; }
    for (const n of names) {
      if (files.length >= FS_DIR_FILES_CAP) { truncated = true; return; }
      const fp = path.join(dir, n);
      const r = rel ? rel + "/" + n : n;
      let st;
      try { st = fs.lstatSync(fp); } catch (_) { continue; }
      if (st.isDirectory()) { walk(fp, r); continue; }
      if (!st.isFile()) continue; // 链接/设备不快照(还原时跳过)
      if (st.size > FS_FILE_CAP) { truncated = true; return; }
      try { files.push({ rel: r, spill: writeSpillBuffer(fs.readFileSync(fp)), size: st.size }); }
      catch (_) { truncated = true; return; }
    }
  };
  walk(p, "");
  if (truncated) return { exists: true, isDir: true, dirSpills: files, truncated: true };
  return { exists: true, isDir: true, dirSpills: files };
}

function snapPathAuto(p) {
  let st;
  try { st = fs.lstatSync(p); } catch (_) { return { exists: false }; }
  return st.isDirectory() ? snapDirStat(p) : snapFileStat(p);
}

function collectSnapSpills(snap) {
  if (!snap) return [];
  const out = [];
  for (const s of snap.spills || []) out.push(s);
  for (const f of snap.dirSpills || []) out.push(f.spill);
  return out;
}

const FS_DESTRUCTIVE_OPS = new Set(["unlink", "rm", "rmdir", "rename", "truncate"]);

// WAL 核心:快照→spill 落盘→条目入 journal+元数据落盘。返回 entry;返回 null 表示该调用无需日志。
// 破坏性操作前态超限 → 默认拒绝(DENIED_FS_UNTRACKED);写类超限 → untracked 标记放行(M3)。
function journalFsOp(op, args, gen) {
  let snapSpecs;
  switch (op) {
    case "writeFile": case "appendFile": case "truncate": case "unlink":
    case "rm": case "rmdir":
      snapSpecs = [["snap", args[0]]]; break;
    case "mkdir": {
      // recursive 会补建父目录:缺失祖先自顶向下逐个入账,逆序清理时从叶子往上删
      const recursive = !!(args[1] && (args[1] === true || args[1].recursive));
      if (recursive) {
        const missing = [];
        let cur = path.resolve(String(args[0]));
        while (!fs.existsSync(cur)) {
          missing.push(cur);
          const parent = path.dirname(cur);
          if (parent === cur) break;
          cur = parent;
        }
        const entries = [];
        for (let i = missing.length - 1; i >= 0; i--) {
          entries.push({ kind: "fs", op: "mkdir", ts: new Date().toISOString(), spills: [], path: missing[i], snap: { exists: false } });
        }
        for (const e of entries) pushJournalEntry(e);
        return entries.length ? entries[entries.length - 1] : null;
      }
      snapSpecs = [["snap", args[0]]]; break;
    }
    case "rename":
      snapSpecs = [["snapFrom", args[0]], ["snapTo", args[1]]]; break;
    case "copyFile": case "symlink": case "link": case "cp":
      snapSpecs = [["snap", args[1]]]; break;
    case "mkdtemp": {
      // 唯一目录名事前不可知,无法抓前态:入账但标 untracked(还原靠系统清 temp)
      const e0 = { kind: "fs", op: "mkdtemp", ts: new Date().toISOString(), spills: [], path: String(args[0] || ""), untracked: true };
      pushJournalEntry(e0);
      return e0;
    }
    case "open": {
      const fl = args[1] && typeof args[1] === "object" ? args[1].flags : args[1];
      if (fl === undefined || fl === "r" || fl === "rs" || fl === 0) return null; // open 缺省只读,不日志
      snapSpecs = [["snap", args[0]]]; break;
    }
    case "createWriteStream": {
      const fl = args[1] && typeof args[1] === "object" ? args[1].flags : args[1];
      if (fl === "r" || fl === "rs") return null; // B2 修复:缺省 flags='w' 属写,必须记账
      snapSpecs = [["snap", args[0]]]; break;
    }
    default: return null;
  }
  const entry = { kind: "fs", op, ts: new Date().toISOString(), spills: [], path: "" };
  try {
    for (const [key, p] of snapSpecs) {
      if (typeof p !== "string") { entry.untracked = true; continue; }
      if (key === "snap" || entry.path === "") entry.path = p;
      if (key === "snapTo") entry.path2 = p;
      const snap = snapPathAuto(p);
      entry[key] = snap;
      entry.spills.push(...collectSnapSpills(snap));
      const over = snap.over || snap.truncated;
      if (over && FS_DESTRUCTIVE_OPS.has(op)) {
        if (gen.allowAllModules) { entry.untracked = true; }
        else throw err("DENIED_FS_UNTRACKED", "[dev-bridge] fs." + op + " 前态超限无法日志化(" + p + "),破坏性操作默认拒绝;dev_load 传 allowHostModules 放行(将不可还原)");
      } else if (over) entry.untracked = true;
    }
  } catch (e) {
    dropSpills(entry); // 拒绝路径回滚已写 spill
    throw e;
  }
  pushJournalEntry(entry);
  return entry;
}

function makeFsWrapFn(name, realFn, gen) {
  const op = name.replace(/Sync$/, "");
  return function (...args) {
    let entry = null;
    let untracked = false;
    try { entry = journalFsOp(op, args, gen); }
    catch (e) {
      recordCall("fs." + name, args, undefined, e, false, false, false);
      throw e;
    }
    if (entry && entry.untracked) untracked = true;
    // M1 修复:真实调用失败 → 回滚条目(失败的操作没有副作用,不还原),防 cleanup 误删既有文件
    const rollback = () => {
      if (!entry) return;
      const i = journal.indexOf(entry);
      if (i >= 0) journal.splice(i, 1);
      dropSpills(entry);
      persistJournalMeta();
    };
    try {
      const res = realFn.apply(fs, args);
      if (res && typeof res.then === "function") res.catch(() => rollback()); // promises 变体异步失败同样回滚
      recordCall("fs." + name, args, res, null, false, false, untracked);
      return res;
    } catch (e) {
      rollback();
      recordCall("fs." + name, args, undefined, e, false, false, untracked);
      throw e;
    }
  };
}

const FS_JOURNAL_OP_NAMES = new Set([
  "writeFile", "appendFile", "truncate", "unlink", "rm", "rmdir", "rename",
  "copyFile", "mkdir", "symlink", "link", "open", "createWriteStream", "mkdtemp", "cp",
]);

function makeFsPromisesShim(gen) {
  const real = fs.promises;
  const shim = Object.create(null);
  for (const k of Object.getOwnPropertyNames(real)) {
    const v = real[k];
    shim[k] = typeof v === "function" && FS_JOURNAL_OP_NAMES.has(k) ? makeFsWrapFn(k, v, gen) : v;
  }
  return shim;
}

function makeFsShim(gen) {
  const shim = Object.create(null);
  for (const k of Object.keys(fs)) {
    if (k === "promises") continue;
    const v = fs[k];
    shim[k] = typeof v === "function" && FS_JOURNAL_OP_NAMES.has(k.replace(/Sync$/, "")) ? makeFsWrapFn(k, v, gen) : v;
  }
  shim.promises = makeFsPromisesShim(gen);
  return shim;
}

// fs 条目还原(逆序执行时调用);失败抛错 → devCleanup 保留条目可重试(M4)
function restoreFsEntry(j) {
  const restoreOne = (snap, p) => {
    if (!snap) return;
    if (snap.exists === false) { try { fs.unlinkSync(p); } catch (_) {} return; }
    if (j.spillLost) throw new Error("spill 已丢失(spill 超限被淘汰),无法还原: " + p);
    if (snap.isLink) {
      try { fs.unlinkSync(p); } catch (_) {}
      fs.symlinkSync(snap.linkTarget || "", p);
      return;
    }
    if (snap.isDir) {
      fs.mkdirSync(p, { recursive: true });
      if (snap.truncated) throw new Error("目录快照不完整,仅还原了 " + (snap.dirSpills || []).length + " 个文件: " + p);
      for (const f of snap.dirSpills || []) {
        const dest = path.join(p, ...String(f.rel).split("/"));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(spillPath(f.spill.file), dest);
      }
      return;
    }
    if (snap.special) return;
    if (!snap.spills || !snap.spills.length) throw new Error("前态未 spill 化(超限),无法还原: " + p);
    fs.writeFileSync(p, fs.readFileSync(spillPath(snap.spills[0].file)));
  };
  switch (j.op) {
    case "writeFile": case "appendFile": case "truncate": case "copyFile":
    case "open": case "createWriteStream": case "unlink": case "rm": case "rmdir":
      restoreOne(j.snap, j.path);
      break;
    case "mkdir":
      if (j.snap && j.snap.exists) break; // 目录本就存在(mkdir 对已存在目录为 no-op):不动,防误删(M1)
      try { fs.rmdirSync(j.path); } catch (_) {} // 非空(后续写入未清)保留,尽力而为
      break;
    case "symlink": case "link":
      if (j.snap && j.snap.exists) restoreOne(j.snap, j.path); // 目标位原有内容,还原之(M1)
      else { try { fs.unlinkSync(j.path); } catch (_) {} }
      break;
    case "rename": {
      const from = j.path, to = j.path2 || "";
      if (j.snapFrom && j.snapFrom.exists) {
        if (j.snapFrom.isDir) {
          fs.rmSync(to, { recursive: true, force: true });
          restoreOne(j.snapFrom, from);
        } else {
          try { fs.renameSync(to, from); } catch (_) { restoreOne(j.snapFrom, from); }
        }
      } else {
        try { fs.unlinkSync(to); } catch (_) {}
      }
      restoreOne(j.snapTo, to);
      break;
    }
    default: throw new Error("未知 fs 日志操作: " + j.op);
  }
  dropSpills(j);
}

function cleanupSpillDir() {
  try {
    const dir = journalDir();
    for (const f of fs.readdirSync(dir)) {
      if (/^pre-.*\.bin$/.test(f) || f === "journal.json" || f === "journal.json.tmp") fs.unlinkSync(path.join(dir, f));
    }
    fs.rmdirSync(dir);
  } catch (_) {}
  spillBytes = 0;
}

// ---------- 极简 DOM stub(P2):查询恒 null,创建/监听惰性记录;真实 DOM 行为不承诺 ----------
function makeDomShim(gen) {
  const rec = (api, args) => recordCall("dom." + api, args || [], undefined, null, true);
  const makeEl = (tagName) => {
    const el = {
      tagName: String(tagName || "div").toUpperCase(),
      style: {}, dataset: {}, children: [], attributes: {},
      setAttribute(k, v) { el.attributes[k] = v; rec("setAttribute", [el.tagName, k]); },
      getAttribute(k) { return k in el.attributes ? el.attributes[k] : null; },
      appendChild(c) { el.children.push(c); return c; },
      removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; },
      addEventListener(t, fn) { ((el._ev = el._ev || {})[t] = el._ev[t] || []).push(fn); rec("el.addEventListener", [el.tagName, t]); },
      removeEventListener() {},
    };
    el.classList = { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false };
    return el;
  };
  return {
    createElement: (t) => makeEl(t),
    createTextNode: (t) => ({ text: String(t) }),
    createDocumentFragment: () => makeEl("#fragment"),
    getElementById: () => null, // 恒 null(文档明示)
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(type, fn) {
      if (typeof type === "string" && typeof fn === "function") {
        (gen.domEvents[type] = gen.domEvents[type] || []).push(fn);
        rec("addEventListener", [type]);
      }
    },
    removeEventListener() {},
    body: makeEl("body"), head: makeEl("head"), documentElement: makeEl("html"),
    readyState: "complete",
  };
}

// ---------- 在 vm 内执行 wrapper(同步超时的唯一正道,审核 B3) ----------
function execWrapperInCtx(ctx, wrapper, exp, req, mod, filename, dirname, timeoutMs, label) {
  ctx.__devWrap = wrapper; ctx.__devExp = exp; ctx.__devReq = req;
  ctx.__devMod = mod; ctx.__devFn = filename; ctx.__devDn = dirname;
  try {
    vm.runInContext("__devOut = __devWrap(__devExp, __devReq, __devMod, __devFn, __devDn)", ctx, { timeout: timeoutMs, filename: label });
    return ctx.__devOut;
  } catch (e) {
    if (/timed out/i.test(String(e && e.message))) {
      throw err("TIMEOUT", label + " 顶层同步执行超时(>" + timeoutMs + "ms);沙箱已标记重建");
    }
    throw e;
  } finally {
    delete ctx.__devWrap; delete ctx.__devExp; delete ctx.__devReq;
    delete ctx.__devMod; delete ctx.__devFn; delete ctx.__devDn; delete ctx.__devOut;
  }
}

// ---------- 沙箱构建 ----------
function resolveEntry(cfg) {
  const p = path.resolve(cfg.path);
  if (!fs.existsSync(p)) throw err("PATH_NOT_FOUND", "路径不存在: " + p);
  if (cfg.mode === "file") {
    if (!fs.statSync(p).isFile()) throw err("PATH_NOT_FOUND", "mode=file 需要 .js 文件路径: " + p);
    return p;
  }
  const pjPath = fs.statSync(p).isFile() ? p : path.join(p, "plugin.json");
  if (!fs.existsSync(pjPath)) throw err("NO_PLUGIN_JSON", "找不到 plugin.json: " + pjPath + ";单文件目标请用 mode=file");
  let pj;
  try { pj = JSON.parse(fs.readFileSync(pjPath, "utf8")); }
  catch (e) { throw err("NO_PLUGIN_JSON", "plugin.json 解析失败: " + e.message); }
  if (!pj.preload) throw err("NO_PRELOAD", "目标 plugin.json 未声明 preload");
  const entry = path.resolve(path.dirname(pjPath), pj.preload);
  if (!fs.existsSync(entry)) throw err("NO_PRELOAD", "preload 文件不存在: " + entry);
  return entry;
}

function buildGeneration(cfg) {
  const entry = resolveEntry(cfg);
  const gen = {
    id: Date.now(),
    entry,
    mode: cfg.mode || "plugin",
    allowSideEffects: !!cfg.allowSideEffects,
    allowHostModules: cfg.allowHostModules === true ? true
      : (Array.isArray(cfg.allowHostModules) ? cfg.allowHostModules.map(String) : false),
    allowAllModules: cfg.allowHostModules === true, // B1 修复:数组(含[])不得解除 fetch 门控与 fs 超限拒绝
    loadedAt: new Date().toISOString(),
    timeoutMs: cfg.timeoutMs || LOAD_TIMEOUT_DEFAULT,
    ctx: null, manifest: [], events: {}, warnings: [], timers: new Set(), dirty: false,
    retired: false,
    proxyCache: new WeakMap(),
    domEvents: {},
  };

  // 1) 上下文与 globals(B2/S2/S3;v3 M5 web 补齐/fetch 门控):window/global/globalThis 同体,utools 三别名
  const sandboxGlobal = {};
  const ctx = vm.createContext(sandboxGlobal);
  gen.ctx = ctx;
  const timersBundle = makeTimers(gen);
  const sandboxConsole = makeConsole();
  const processShim = makeProcessShim();
  const fsShim = makeFsShim(gen);
  sandboxGlobal.window = sandboxGlobal;
  sandboxGlobal.global = sandboxGlobal;
  sandboxGlobal.utools = makeUtoolsProxy(gen);
  sandboxGlobal.console = sandboxConsole;
  sandboxGlobal.process = processShim;
  sandboxGlobal.document = makeDomShim(gen);
  sandboxGlobal.Buffer = Buffer;
  sandboxGlobal.setTimeout = timersBundle.timers.setTimeout;
  sandboxGlobal.setInterval = timersBundle.timers.setInterval;
  sandboxGlobal.setImmediate = timersBundle.timers.setImmediate;
  sandboxGlobal.clearTimeout = timersBundle.timers.clearTimeout;
  sandboxGlobal.clearInterval = timersBundle.timers.clearInterval;
  sandboxGlobal.clearImmediate = timersBundle.timers.clearImmediate;
  sandboxGlobal.queueMicrotask = (fn) => queueMicrotask(guardAsyncFn(fn));
  for (const g of WEB_GLOBALS) {
    try { if (typeof globalThis[g] !== "undefined") sandboxGlobal[g] = globalThis[g]; } catch (_) {}
  }
  // fetch 门控:默认 rejected Promise(保 .catch 语义),allowHostModules 放行透传宿主
  sandboxGlobal.fetch = function (input, init) {
    if (gen.allowAllModules) {
      if (typeof globalThis.fetch !== "function") throw err("DENIED_FETCH", "宿主环境无 fetch");
      return globalThis.fetch(input, init);
    }
    const e = err("DENIED_FETCH", "[dev-bridge] fetch 已拦截;dev_load 传 allowHostModules:true 放行");
    recordCall("fetch", [input, init], undefined, e, true, true);
    return Promise.reject(e);
  };
  const entryModule = { exports: {} };
  sandboxGlobal.module = entryModule;
  sandboxGlobal.exports = entryModule.exports;

  // 2) 自实现 CJS loader(B1/G1;v3 B1 内置模块白名单门控):vm 编译+vm 内执行,缓存仅本代际
  const cache = new Map();
  const hostResolveBase = Module.createRequire(entry);

  const builtinMap = {
    "process": processShim,
    "console": sandboxConsole,
    "timers": timersBundle.timers,
    "timers/promises": timersBundle.promises,
    "fs": fsShim,
    "fs/promises": fsShim.promises,
    "module": {
      createRequire: (f) => makeRequireFn(String(f)),
      builtinModules: Module.builtinModules,
    },
  };

  function hostModuleAllowed(bare) {
    return gen.allowAllModules === true
      || (Array.isArray(gen.allowHostModules) && gen.allowHostModules.some((m) => String(m).replace(/^node:/, "") === bare));
  }

  function resolveBuiltinModule(resolved) {
    const bare = String(resolved).replace(/^node:/, ""); // node: 前缀规范化,防一行绕过(B1)
    if (Object.prototype.hasOwnProperty.call(builtinMap, bare)) return builtinMap[bare];
    if (ALLOW_MODULES.has(bare)) return hostResolveBase(resolved); // 白名单透传
    if (hostModuleAllowed(bare)) return hostResolveBase(resolved);
    return makeDeniedModule(bare); // 默认拒绝(白名单制:未列出即拒),懒拒绝代理
  }

  // M3 修复:相对路径按 fromFile 解析(services/ 之间的相互 require 不再以 entry 为基准)
  const resolverCache = new Map();
  function resolverFor(fromFile) {
    if (!fromFile || fromFile === entry) return hostResolveBase;
    let r = resolverCache.get(fromFile);
    if (!r) { r = Module.createRequire(fromFile); resolverCache.set(fromFile, r); }
    return r;
  }

  function makeRequireFn(fromFile) {
    const f = (r) => localRequire(fromFile, r);
    f.resolve = (r) => resolverFor(fromFile).resolve(r);
    f.cache = cache;
    return f;
  }

  function compileSource(src, filename) {
    const code = "(function (exports, require, module, __filename, __dirname) {\n" + src + "\n})";
    try {
      return vm.runInContext(code, ctx, { filename });
    } catch (e) {
      if (e instanceof SyntaxError && /\bimport\b|\bexport\b/.test(src.slice(0, 4000))) {
        throw err("SYNTAX_ERROR", filename + " 疑似 ESM 语法;dev-bridge 一期仅支持 CommonJS: " + e.message);
      }
      throw err("SYNTAX_ERROR", filename + " 编译失败: " + ((e && e.stack) || e));
    }
  }

  function loadVmModule(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const mod = { exports: {}, loaded: false, id: filename };
    cache.set(filename, mod);
    let src;
    try { src = fs.readFileSync(filename, "utf8"); }
    catch (e) { throw err("REQUIRE_FAILED", "读取模块失败 " + filename + ": " + e.message); }
    if (src.startsWith("#!")) src = "//" + src.slice(2);
    const wrapper = compileSource(src, filename);
    try {
      execWrapperInCtx(ctx, wrapper, mod.exports, makeRequireFn(filename), mod, filename, path.dirname(filename), gen.timeoutMs, filename);
    } catch (e) {
      cache.delete(filename);
      if (e && e.__devErr && e.code === "TIMEOUT") gen.dirty = true;
      throw e;
    }
    mod.loaded = true;
    return mod.exports;
  }

  function localRequire(fromFile, request) {
    const reqStr = String(request);
    const bare0 = reqStr.replace(/^node:/, "");
    const isPathy = /^[./\\]/.test(reqStr) || path.isAbsolute(reqStr);
    // deny 名单先于解析短路(加固):与宿主可解析性无关,纯 Node 与真 uTools 行为一致
    if (!isPathy && DENY_MODULES.has(bare0) && !hostModuleAllowed(bare0)) return makeDeniedModule(bare0);
    let resolved;
    try { resolved = resolverFor(fromFile).resolve(request); }
    catch (e) {
      if (!isPathy && DENY_MODULES.has(bare0)) return makeDeniedModule(bare0); // 兜底(理论上已短路)
      throw err("REQUIRE_FAILED", "无法解析模块 '" + request + "' (from " + fromFile + "): " + e.message);
    }
    if (!path.isAbsolute(resolved)) return resolveBuiltinModule(resolved); // 内置模块/electron 走门控
    if (/\.node$/i.test(resolved)) return hostResolveBase(resolved); // 原生模块透传(绕过门控,README 明示)
    if (/\.json$/i.test(resolved)) return JSON.parse(fs.readFileSync(resolved, "utf8"));
    if (/\.mjs$/i.test(resolved)) throw err("REQUIRE_FAILED", "ESM 模块不支持 vm 加载(一期仅 CommonJS): " + resolved);
    if (!/\.c?js$/i.test(resolved)) return hostResolveBase(resolved); // 其他资源
    return loadVmModule(resolved);
  }

  // 3) 基线快照 → 执行入口 → 差集发现导出(S2)
  const baseKeys = new Set(Reflect.ownKeys(sandboxGlobal));
  let src;
  try { src = fs.readFileSync(entry, "utf8"); }
  catch (e) { throw err("PATH_NOT_FOUND", "读取入口失败 " + entry + ": " + e.message); }
  if (src.startsWith("#!")) src = "//" + src.slice(2);
  const wrapper = compileSource(src, entry);
  try {
    execWrapperInCtx(ctx, wrapper, entryModule.exports, makeRequireFn(entry), entryModule, entry, path.dirname(entry), gen.timeoutMs, entry);
  } catch (e) {
    if (e && e.__devErr && e.code === "TIMEOUT") gen.dirty = true;
    throw err("REQUIRE_FAILED", "入口执行失败: " + ((e && e.stack) || e));
  }

  const manifest = [];
  const addFn = (name, fn) => {
    let preview = "";
    try { preview = String(fn).split("\n")[0].slice(0, 160); } catch (_) {}
    manifest.push({ name, kind: "function", args: fn.length, preview });
  };
  const walkOne = (name, val) => {
    if (typeof val === "function") { addFn(name, val); return; }
    if (val && typeof val === "object") {
      let fnCount = 0;
      const keys = Object.keys(val);
      for (const k of keys) if (typeof val[k] === "function") { fnCount++; addFn(name + "." + k, val[k]); }
      manifest.push({ name, kind: "object", functions: fnCount, keys: keys.length });
    }
  };
  for (const k of Reflect.ownKeys(sandboxGlobal)) {
    if (typeof k !== "string" || baseKeys.has(k)) continue;
    walkOne(k, sandboxGlobal[k]);
  }
  for (const [holder, label] of [[entryModule.exports, "module.exports"], [sandboxGlobal.exports, "exports"]]) {
    if (typeof holder === "function") addFn(label, holder);
    else if (holder && typeof holder === "object") {
      for (const k of Object.keys(holder)) walkOne(label + "." + k, holder[k]);
    }
  }
  gen.manifest = manifest;
  gen.eventsList = Object.keys(gen.events).map((api) => ({ api, count: gen.events[api].length }));
  if (!manifest.length) gen.warnings.push("未发现可调用导出;若目标依赖渲染期 DOM,dev-bridge 一期无法承载(见 README)");
  return gen;
}

// ---------- 状态/持久化/串行(审核 G7/G8) ----------
let lastConfig = null;
let chain = Promise.resolve();

function serialized(fn) {
  return function (args) {
    const p = chain.then(() => fn(args || {}));
    chain = p.catch(() => {});
    return p;
  };
}

const NS = "devbridge:" + String(REAL.getNativeId ? REAL.getNativeId() : "local").slice(0, 12) + ":";

function persistLast(cfg) {
  lastConfig = cfg;
  try { REAL.dbStorage.setItem(NS + "last", JSON.stringify(cfg)); } catch (_) {}
}

function restoreLast() {
  if (lastConfig) return lastConfig;
  try {
    const raw = REAL.dbStorage.getItem(NS + "last");
    if (raw) { lastConfig = JSON.parse(raw); return lastConfig; }
  } catch (_) {}
  return null;
}

function ensureState(meta) {
  if (CURRENT_GEN && !CURRENT_GEN.dirty) return;
  const cfg = restoreLast();
  if (!cfg) return;
  const fresh = buildGeneration(cfg);
  if (CURRENT_GEN) CURRENT_GEN.retired = true;
  killTimers(CURRENT_GEN);
  CURRENT_GEN = fresh;
  if (meta) meta.reloaded = true;
}

// ---------- 工具实现 ----------
function devLoad(cfg) {
  const callsBefore = callsSeq;
  const gen = buildGeneration(cfg); // 成功才切换(G8)
  if (CURRENT_GEN) CURRENT_GEN.retired = true;
  killTimers(CURRENT_GEN);
  CURRENT_GEN = gen;
  persistLast({ path: cfg.path, mode: cfg.mode || "plugin", allowSideEffects: !!cfg.allowSideEffects, allowHostModules: cfg.allowHostModules === undefined ? false : cfg.allowHostModules, timeoutMs: cfg.timeoutMs });
  // M7:汇总装载期触发的模块拦截,agent 不必等莫名其妙的 throw 才知道门控生效
  const deniedMods = new Set();
  for (const e of ringCalls) {
    if (e.seq > callsBefore && e.denied && String(e.api).indexOf("require:") === 0) {
      deniedMods.add(String(e.api).slice(8).split(".")[0]);
    }
  }
  if (deniedMods.size) gen.warnings.push("装载期模块拦截: " + Array.from(deniedMods).join(", ") + "(dev_load 传 allowHostModules 放行)");
  if (PENDING_RESTORE > 0) gen.warnings.push("上次会话遗留 " + PENDING_RESTORE + " 条未还原写日志;建议先 dev_cleanup");
  return {
    ok: true, entry: gen.entry, mode: gen.mode, allowSideEffects: gen.allowSideEffects,
    allowHostModules: gen.allowHostModules === undefined ? false : gen.allowHostModules,
    loadedAt: gen.loadedAt, exports: gen.manifest, events: gen.eventsList, warnings: gen.warnings,
    hint: "用 dev_call 执行清单中的导出;name=__enter 且 args=[{code,type,payload}] 可触发 onPluginEnter",
  };
}

function lookupExport(gen, name) {
  if (LIFECYCLE_SPECIALS[name]) return { special: name };
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

function runSyncInCtx(gen, fn, args, timeoutMs) {
  gen.ctx.__devFn = fn;
  gen.ctx.__devArgs = args;
  try {
    vm.runInContext("__devOut = __devFn(...__devArgs)", gen.ctx, { timeout: timeoutMs });
    return gen.ctx.__devOut;
  } catch (e) {
    if (/timed out/i.test(String(e && e.message))) {
      gen.dirty = true;
      throw err("TIMEOUT", "同步执行超时(>" + timeoutMs + "ms),沙箱已标记重建;下次调用将自动重载");
    }
    throw e;
  } finally {
    delete gen.ctx.__devFn; delete gen.ctx.__devArgs; delete gen.ctx.__devOut;
  }
}

async function devCall(cfg) {
  const meta = {};
  ensureState(meta);
  if (!CURRENT_GEN) throw err("NOT_LOADED", "尚未加载目标;先调用 dev_load");
  const gen = CURRENT_GEN;
  const timeoutMs = cfg.timeoutMs || CALL_TIMEOUT_DEFAULT;
  const found = lookupExport(gen, cfg.name);
  if (!found) {
    const cands = gen.manifest.filter((m) => m.kind === "function").map((m) => m.name).slice(0, 40);
    throw err("UNKNOWN_EXPORT", "未找到导出 '" + cfg.name + "';函数候选: " + cands.join(", "));
  }
  const isDom = found.special === "__domReady";
  const specialApi = found.special ? LIFECYCLE_SPECIALS[found.special] : null;
  const targets = found.special
    ? (isDom ? (gen.domEvents.DOMContentLoaded || []) : (gen.events[specialApi] || []))
    : [found.value];
  if (found.special && !targets.length) {
    throw err("UNKNOWN_EXPORT", isDom
      ? "目标未监听 document 的 DOMContentLoaded(查询类 stub 恒 null,见 README)"
      : "目标未注册 " + specialApi.slice("utools.".length) + " 回调;直接调用其导出函数即可");
  }
  if (!found.special && found.value !== undefined && typeof found.value !== "function") {
    throw err("UNKNOWN_EXPORT", "'" + cfg.name + "' 不是函数(kind=object);请调用其下级函数,如 " + cfg.name + ".xxx");
  }
  const t0 = Date.now();
  // 孪生探针:window 与 libuv 双通道各挂一枚 50ms 定时器,fire 与否入流水(排障隐藏页定时器冻结用)
  try { setTimeout(() => recordCall("probe.winTimer", [], undefined, null, false, false, false), 50); } catch (_) {}
  try { hostTimers.setTimeout(() => recordCall("probe.nodeTimer", [], undefined, null, false, false, false), 50); } catch (_) {}
  const consoleFrom = consoleSeq;
  const callsFrom = callsSeq;
  let raw;
  let lastErr = null;
  for (const fn of targets) {
    try { raw = runSyncInCtx(gen, fn, cfg.args || [], timeoutMs); }
    catch (e) { lastErr = e; break; }
  }
  if (lastErr) {
    if (lastErr.__devErr) throw lastErr;
    return {
      ok: false, code: "THROWN", message: String((lastErr && lastErr.stack) || lastErr),
      durationMs: Date.now() - t0, consoleFrom, callsFrom,
      hint: "dev_console/dev_calls_log 用 since 增量取现场",
    };
  }
  if (_isThenable(raw)) {
    let timedOut = false;
    let guardId;
    const guard = new Promise((resolve) => { guardId = hostTimers.setTimeout(() => { timedOut = true; resolve(undefined); }, timeoutMs); });
    try {
      raw = await Promise.race([raw, guard]);
    } finally {
      hostTimers.clearTimeout(guardId); // 成功路径同样清理,不悬挂定时器(libuv 通道)
    }
    if (timedOut) {
      return {
        ok: false, code: "ASYNC_TIMEOUT",
        message: "异步执行超过 " + timeoutMs + "ms 已放弃等待(代码可能仍在后台跑;await 之后的同步死循环无法打断,见 README)",
        durationMs: Date.now() - t0, consoleFrom, callsFrom,
      };
    }
  }
  let result;
  try { result = ser(raw); }
  catch (e) { throw err("SERIALIZE_FAILED", "结果序列化失败: " + e.message); }
  const out = {
    ok: true, result, durationMs: Date.now() - t0,
    consoleFrom, callsFrom, consoleTo: consoleSeq, callsTo: callsSeq,
  };
  if (meta.reloaded) out.reloaded = true;
  return out;
}

function devList() {
  const meta = {};
  ensureState(meta);
  if (!CURRENT_GEN) {
    const out0 = { ok: true, loaded: false, hint: "尚未加载;调用 dev_load {path}" };
    if (PENDING_RESTORE > 0) { out0.pendingRestore = PENDING_RESTORE; out0.hint += ";上次会话遗留 " + PENDING_RESTORE + " 条未还原写日志,建议先 dev_cleanup"; }
    return out0;
  }
  const g = CURRENT_GEN;
  const untrackedCount = journal.reduce((n, j) => n + (j.kind === "fs" && j.untracked ? 1 : 0), 0);
  return {
    ok: true, loaded: true, entry: g.entry, mode: g.mode, allowSideEffects: g.allowSideEffects,
    allowHostModules: g.allowHostModules === undefined ? false : g.allowHostModules,
    loadedAt: g.loadedAt, dirty: g.dirty, exports: g.manifest, events: g.eventsList,
    warnings: g.warnings, reloaded: meta.reloaded || undefined,
    pendingRestore: PENDING_RESTORE > 0 ? PENDING_RESTORE : undefined,
    untrackedJournal: untrackedCount > 0 ? untrackedCount : undefined, // journal 中不可还原的 fs 写条目数
  };
}

function readRing(arr, since, clear) {
  const idx = arr.findIndex((e) => e.seq > since);
  const expired = since > 0 && arr.length > 0 && arr[0].seq > since + 1;
  const entries = idx >= 0 ? arr.slice(idx) : [];
  const out = { ok: true, entries, count: entries.length, to: entries.length ? entries[entries.length - 1].seq : since };
  if (expired) { out.expired = true; out.hint = "since 已被环形覆盖,本次为当前全量;下次请用返回的 to 做游标"; }
  if (clear) arr.length = 0;
  return out;
}

function devCleanup(cfg) {
  const force = !!(cfg && cfg.force); // 强制丢弃无法还原的条目(spill 丢失等),journal 清空出口
  const dropAll = !!(cfg && cfg.dropAll); // 跳过回放直接清空写日志(现场已人工核对/残留条目有意保留现状时使用)
  const stats = { dbRestore: 0, dbDelete: 0, kvRestore: 0, kvDelete: 0, kvCryptoRestore: 0, kvCryptoDelete: 0, attachment: 0, fsRestore: 0 };
  const failures = [];
  const untracked = [];
  const keep = []; // M4:还原失败的条目保留,可重试
  if (dropAll) {
    // 不回放任何条目:db/kv/fs 副作用全部保持现状;仅清 spill 与 journal 本身。
    // killTimers 必须先行(M1):否则目标残留定时器会在"清理完成"后继续写库,终态不可信
    killTimers(CURRENT_GEN);
    let droppedEntries = 0;
    for (const e of journal) { droppedEntries++; if (e && e.kind === "fs") dropSpills(e); }
    journal.length = 0;
    cleanupSpillDir();
    PENDING_RESTORE = 0;
    journalTruncated = false;
    return { ok: true, restored: stats, dropped: true, droppedEntries, note: "dropAll:已跳过回放直接清空写日志(丢弃 " + droppedEntries + " 条),现场保持现状;dropAll 优先于 force;确认无还原需要时才用,以 dropped:true 判定生效" };
  }
  // M2 修复:还原一律用【当前】文档 rev(日志里的 curRev 可能已过期),并检查 db 返回的 {error}
  const dbPutRestore = (doc, id) => {
    const cur = _safeGet(id);
    const payload = Object.assign({}, doc);
    delete payload._rev;
    const r = REAL.db.put(cur ? Object.assign(payload, { _rev: cur._rev }) : payload);
    if (r && r.error) throw new Error("db.put 还原失败: " + (r.message || r.error));
  };
  for (let i = journal.length - 1; i >= 0; i--) {
    const j = journal[i];
    if (j.kind === "fs") {
      if (j.untracked) {
        dropSpills(j); // 无前态,只报告(同时清掉可能的目录部分 spill,防账目虚高)
        untracked.push(j.op + " " + (j.path2 ? j.path + " -> " + j.path2 : (j.path || "")));
        continue;
      }
      try { restoreFsEntry(j); stats.fsRestore++; }
      catch (e) { j.retryable = true; keep.unshift(j); failures.push("fs." + j.op + " " + (j.path || "") + ": " + ((e && e.message) || e) + " (retryable)"); }
      continue;
    }
    try {
      if (j.kind === "put") {
        if (j.prev) { dbPutRestore(j.prev, j.id); stats.dbRestore++; }
        else {
          const cur = _safeGet(j.id);
          if (cur) {
            const r = REAL.db.remove(cur);
            if (r && r.error) throw new Error("db.remove 还原失败: " + (r.message || r.error));
            stats.dbDelete++;
          } else if (j.curRev) {
            const r = REAL.db.remove({ _id: j.id, _rev: j.curRev });
            if (r && r.error) throw new Error("db.remove(curRev) 还原失败: " + (r.message || r.error));
            stats.dbDelete++;
          } else {
            failures.push(j.api + " " + j.id + ": 无前态且无法定位当前文档");
          }
        }
      } else if (j.kind === "remove") {
        if (j.prev) { dbPutRestore(j.prev, j.id); stats.dbRestore++; }
      } else if (j.kind === "bulkDocs") {
        for (const p of j.prevs || []) {
          if (p.doc) { dbPutRestore(p.doc, p.id); stats.dbRestore++; }
          else {
            // 2026-09-16 实测回归:bulkDocs 新建的文档(无前态)回滚必须删除——
            // 逆序回放会先执行更晚的 remove 条目还原(复活文档),此处不删就成了孤儿
            const cur = _safeGet(p.id);
            if (cur) {
              const r = REAL.db.remove(cur);
              if (r && r.error) throw new Error("db.remove 还原失败: " + (r.message || r.error));
              stats.dbDelete++;
            } // 当前不存在 = 已被更晚回滚删除,幂等跳过
          }
        }
      } else if (j.kind === "attachment") {
        if (j.prev) { dbPutRestore(j.prev, j.id); stats.dbRestore++; } // 有前态:还原原文档
        else {
          const cur = _safeGet(j.id);
          if (cur) {
            const r = REAL.db.remove(cur);
            if (r && r.error) throw new Error("db.remove(附件) 还原失败: " + (r.message || r.error));
            stats.attachment++;
          }
        }
      } else if (j.kind === "kv") {
        const store = j.crypto ? REAL.dbCryptoStorage : REAL.dbStorage;
        if (j.prev === undefined || j.prev === null) {
          store.removeItem(j.key);
          if (j.crypto) stats.kvCryptoDelete++; else stats.kvDelete++;
        } else {
          store.setItem(j.key, j.prev);
          if (j.crypto) stats.kvCryptoRestore++; else stats.kvRestore++;
        }
      }
    } catch (e) {
      j.retryable = true;
      keep.unshift(j);
      failures.push(j.api + " " + (j.id || j.key || "") + ": " + ((e && e.message) || e) + " (retryable)");
    }
  }
  if (force) {
    for (const e of keep) dropSpills(e);
    keep.length = 0; // force:放弃重试,清空 journal 出口
  }
  journal.length = 0;
  for (const e of keep) journal.push(e);
  if (journal.length === 0) {
    cleanupSpillDir();
    PENDING_RESTORE = 0;
  } else {
    persistJournalMeta();
  }
  killTimers(CURRENT_GEN);
  const out = {
    ok: true, restored: stats, failures,
    note: "网络/进程副作用不在回收范围;fs 前态已按写日志还原(超限项见 untracked)",
  };
  if (untracked.length) out.untracked = untracked;
  if (journalTruncated) { out.truncated = true; if (journal.length === 0) journalTruncated = false; }
  if (PENDING_RESTORE > 0) out.pendingRestore = PENDING_RESTORE;
  if (force) out.forced = true;
  return out;
}

// ---------- 注册(registerTool 必须顶层,禁入 onPluginEnter) ----------
restoreJournalMeta(); // v3:回灌上次会话遗留 journal,重启后 dev_cleanup 仍可还原

function reg(name, fn) {
  if (typeof utools.registerTool !== "function") return;
  utools.registerTool(name, async (params) => {
    try {
      return await fn(params || {});
    } catch (e) {
      // 带 console/calls 游标:TIMEOUT/DENIED 类失败 agent 也能定位现场
      return { ok: false, code: (e && e.code) || "ERROR", message: String((e && e.message) || e), consoleFrom: consoleSeq, callsFrom: callsSeq };
    }
  });
}

reg("dev_load", serialized(devLoad));
reg("dev_call", serialized(devCall));
reg("dev_list", serialized(devList));
reg("dev_console", serialized((cfg) => readRing(ringConsole, cfg.since || 0, !!cfg.clear)));
reg("dev_calls_log", serialized((cfg) => readRing(ringCalls, cfg.since || 0, !!cfg.clear)));
reg("dev_cleanup", serialized(devCleanup));

} catch (e) {
  // 启动崩溃兜底:注册诊断工具回传崩溃栈,agent 可直接调用定位
  try {
    utools.registerTool("dev_boot_err", async () => ({ ok: false, code: "BOOT_FAILED", message: String((e && e.stack) || e) }));
  } catch (_) {}
}
})(); // ---- 引导保护网结束 ----
