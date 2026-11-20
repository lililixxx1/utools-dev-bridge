/**
 * Node 内置模块懒拒绝代理工厂：
 * require 阶段返回可链接的单例空白代理；事件注册族方法 noop+录制；实际调用时抛出 DENIED_MODULE。
 */
"use strict";

const { EVENT_NOOP_PROPS } = require("../contract");

const DENIED_NODE_CACHE_MAX = 500;

function createDeniedFactory(rt, recordCall) {
  function cacheDeniedNode(api, proxy) {
    if (rt.deniedNodeCache.size < DENIED_NODE_CACHE_MAX) {
      rt.deniedNodeCache.set(api, proxy);
    }
    return proxy;
  }

  function deniedErr(api) {
    return rt.err(
      "DENIED_MODULE",
      "[dev-bridge] 模块行为已拦截(" + api + ");dev_load 传 allowHostModules:true 或白名单数组放行"
    );
  }

  function makeDeniedFn(api) {
    if (rt.deniedNodeCache.has(api)) return rt.deniedNodeCache.get(api);
    const fn = function (...args) {
      recordCall(api + "()", args, undefined, null, { stubbed: true, denied: true });
      throw deniedErr(api);
    };
    const proxy = new Proxy(fn, {
      get(_, prop) {
        if (typeof prop === "symbol") return undefined;
        const sub = api + "." + String(prop);
        recordCall(sub, [], undefined, null, { stubbed: true, denied: true });
        return EVENT_NOOP_PROPS.has(String(prop)) ? makeDeniedChainNoop(sub) : makeDeniedFn(sub);
      },
    });
    return cacheDeniedNode(api, proxy);
  }

  function makeDeniedChainNoop(api) {
    if (rt.deniedNodeCache.has(api)) return rt.deniedNodeCache.get(api);
    const f = function () {
      recordCall(api + "()", [], undefined, null, { stubbed: true, denied: true });
      return proxy;
    };
    const proxy = new Proxy(f, {
      get(_, prop) {
        if (typeof prop === "symbol") return undefined;
        const sub = api + "." + String(prop);
        recordCall(sub, [], undefined, null, { stubbed: true, denied: true });
        return EVENT_NOOP_PROPS.has(String(prop)) ? makeDeniedChainNoop(sub) : makeDeniedFn(sub);
      },
    });
    return cacheDeniedNode(api, proxy);
  }

  function makeDeniedModule(name) {
    if (rt.deniedModuleCache.has(name)) return rt.deniedModuleCache.get(name);
    const proxy = new Proxy(Object.create(null), {
      get(_, prop) {
        if (typeof prop === "symbol") return undefined;
        const api = "require:" + name + "." + String(prop);
        recordCall(api, [], undefined, null, { stubbed: true, denied: true });
        return EVENT_NOOP_PROPS.has(String(prop)) ? makeDeniedChainNoop(api) : makeDeniedFn(api);
      },
      has(_, prop) { return typeof prop === "string"; },
    });
    rt.deniedModuleCache.set(name, proxy);
    return proxy;
  }

  return { makeDeniedModule };
}

module.exports = { createDeniedFactory };
