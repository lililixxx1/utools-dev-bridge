/**
 * utools 深代理、调用流水录制与异步异常守卫：
 * - 对冻结的 REAL.utools 整树用空白可配置目标 + forwardTraps 绕过 JS 代理不变量
 * - 代际级 proxyCache 保持 utools.db === utools.db 等引用稳定性
 * - 捕获 7 项生命周期（含 onMainPush 的第二个回调 onSelect）与 8.0 registerTool
 */
"use strict";

const { STUBBED_APIS, PROMISE_STUB_APIS, EVENT_APIS, FORCE_RECURSE_PROPS } = require("./contract");
const { ser, redactCallPayload } = require("./serialize");

function createProxy(rt, journalApi, opts) {
  const REAL = rt.REAL;
  const onCall = opts && opts.onCall;
  const onConsole = opts && opts.onConsole;

  function recordCall(api, args, result, error, stubbed, denied, untracked, outside) {
    // 兼容 flags 对象与旧版位置参数
    let isStub = stubbed;
    let isDenied = denied;
    let isUntracked = untracked;
    let isOutside = outside;
    if (stubbed && typeof stubbed === "object") {
      isStub = !!stubbed.stubbed;
      isDenied = !!stubbed.denied;
      isUntracked = !!stubbed.untracked;
      isOutside = !!stubbed.outside;
    }
    const reveal = rt.isRevealActive();
    const payload = redactCallPayload(api, args, result, reveal);
    const entry = {
      seq: ++rt.callsSeq,
      ts: new Date().toISOString(),
      api,
      args: payload.args,
    };
    if (isStub) entry.stubbed = true;
    if (isDenied) entry.denied = true;
    if (isUntracked) entry.untracked = true;
    if (isOutside) entry.outside = true;
    if (error) {
      entry.ok = false;
      entry.error = String((error && error.message) || error);
    } else {
      entry.ok = true;
      if (result !== undefined) entry.result = payload.result;
    }
    rt.pushRing(rt.ringCalls, entry);
    if (onCall) onCall(entry);
    return entry;
  }

  function recordUncaught(e) {
    const entry = {
      seq: ++rt.consoleSeq,
      ts: new Date().toISOString(),
      level: "uncaught",
      args: [ser(e, true, { redact: !rt.isRevealActive() })],
    };
    rt.pushRing(rt.ringConsole, entry);
    if (onConsole) onConsole(entry);
  }

  function guardAsyncFn(fn) {
    return function (...a) {
      try { return fn.apply(this, a); }
      catch (e) { recordUncaught(e); return undefined; }
    };
  }

  function makeLeaf(origFn, api, gen, allowSE) {
    return function (...args) {
      if (gen.retired) {
        const e = new Error("[dev-bridge] 旧代际代理已废弃: " + api);
        recordCall(api, args, undefined, e);
        throw e;
      }
      if (EVENT_APIS.has(api)) {
        if (typeof args[0] === "function") {
          (gen.events[api] = gen.events[api] || []).push(args[0]);
        }
        // onMainPush(callback, onSelect)：第二个参数是用户选中推送项后的回调
        if (api === "utools.onMainPush" && typeof args[1] === "function") {
          const selKey = "utools.onMainPush:select";
          (gen.events[selKey] = gen.events[selKey] || []).push(args[1]);
        }
        recordCall(api, args, undefined, null, true);
        return undefined;
      }
      if (api === "utools.registerTool") {
        const nm = args && args[0];
        if (typeof nm === "string" && typeof args[1] === "function") gen.tools[nm] = args[1];
        else if (typeof nm === "string") gen.warnings.push("registerTool('" + nm + "') handler 非函数,已忽略(不可经 __tool: 调用)");
        recordCall(api, [nm], undefined, null, true);
        return undefined;
      }
      if (STUBBED_APIS.has(api) && !allowSE) {
        const out = { stubbed: true, api, note: "破坏性 API 已被 dev-bridge 拦截;dev_load 传 allowSideEffects:true 放行" };
        recordCall(api, args, out, null, true);
        return PROMISE_STUB_APIS.has(api) ? Promise.resolve(out) : out;
      }
      const pre = journalApi.isJournaledApi(api) ? journalApi.capturePre(api, args) : null;
      let res;
      try {
        res = origFn.apply(this, args);
      } catch (e) {
        recordCall(api, args, undefined, e);
        throw e;
      }
      if (pre) journalApi.commitJournal(pre, api, res);
      recordCall(api, args, res);
      return res;
    };
  }

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
        const val = Reflect.get(realObj, prop);
        const api = apiPath + "." + String(prop);
        if (typeof val === "function") {
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
        const desc = Reflect.getOwnPropertyDescriptor(target, prop);
        if (desc && !desc.configurable && desc.writable === false) return val;
        const subApi = api + "." + String(prop);
        if (typeof val === "function") return wrapLeaf(val, subApi, gen, allowSE);
        if (val && typeof val === "object") return wrapNamespace(val, subApi, gen, allowSE);
        return val;
      },
    }));
  }

  function makeUtoolsProxy(gen) {
    return wrapNamespace(REAL, "utools", gen, gen.allowSideEffects);
  }

  return {
    recordCall,
    recordUncaught,
    guardAsyncFn,
    makeUtoolsProxy,
  };
}

module.exports = { createProxy };
