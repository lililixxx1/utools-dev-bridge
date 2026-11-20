/**
 * 目标加载器：拆分为容器无关的策略层（路径解析/模块门控/导出清单）与执行容器适配器（vm / 当前窗口）。
 * 未来如迁移 worker_threads，仅需替换容器适配器层，策略与门控逻辑可直接复用。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");
const Module = require("module");
const { LIMITS, DENY_MODULES, ALLOW_MODULES, WEB_GLOBALS } = require("./contract");
const { makeProcessShim } = require("./shims/process");
const { makeConsole } = require("./shims/console");
const { makeTimers, killTimers } = require("./shims/timers");
const { createDeniedFactory } = require("./shims/denied");
const { makeFsShim } = require("./shims/fs");
const { makeDomShim } = require("./shims/dom");

function normalizeModuleName(req) {
  return String(req || "").replace(/^node:/, "");
}

function isHostModuleAllowed(gen, bare) {
  if (!gen) return false;
  if (gen.allowAllModules === true) return true;
  if (!Array.isArray(gen.allowHostModules)) return false;
  return gen.allowHostModules.some((m) => normalizeModuleName(m) === bare);
}

function resolvePluginManifest(rt, targetPath) {
  const p = path.resolve(String(targetPath || ""));
  if (!targetPath || !fs.existsSync(p)) {
    throw rt.err("PATH_NOT_FOUND", "路径不存在: " + p);
  }
  const st = fs.statSync(p);
  const pjPath = st.isFile() ? p : path.join(p, "plugin.json");
  if (!fs.existsSync(pjPath)) {
    throw rt.err("NO_PLUGIN_JSON", "找不到 plugin.json: " + pjPath + ";单文件目标请用 mode=file");
  }
  let pj;
  try {
    pj = JSON.parse(fs.readFileSync(pjPath, "utf8"));
  } catch (e) {
    throw rt.err("NO_PLUGIN_JSON", "plugin.json 解析失败: " + e.message);
  }
  const targetRoot = path.dirname(pjPath);
  const preloadPath = pj.preload ? path.resolve(targetRoot, pj.preload) : null;
  const mainPath = pj.main ? path.resolve(targetRoot, pj.main) : null;
  return { targetRoot, pjPath, pluginJson: pj, preloadPath, mainPath };
}

function resolveEntry(rt, cfg) {
  const p = path.resolve(String((cfg && cfg.path) || ""));
  if (!cfg || !cfg.path || !fs.existsSync(p)) {
    throw rt.err("PATH_NOT_FOUND", "路径不存在: " + p);
  }
  if (cfg.mode === "file") {
    if (!fs.statSync(p).isFile()) {
      throw rt.err("PATH_NOT_FOUND", "mode=file 需要 .js 文件路径: " + p);
    }
    return { entry: p, targetRoot: path.dirname(p), mainPath: null, pluginJson: null };
  }
  const info = resolvePluginManifest(rt, p);
  if (!info.pluginJson.preload) {
    throw rt.err("NO_PRELOAD", "目标 plugin.json 未声明 preload");
  }
  if (!fs.existsSync(info.preloadPath)) {
    throw rt.err("NO_PRELOAD", "preload 文件不存在: " + info.preloadPath);
  }
  return {
    entry: info.preloadPath,
    targetRoot: info.targetRoot,
    mainPath: info.mainPath,
    pluginJson: info.pluginJson,
  };
}

function collectExportsManifest(sandboxGlobal, baseKeys, entryModule) {
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
      for (const k of keys) {
        if (typeof val[k] === "function") { fnCount++; addFn(name + "." + k, val[k]); }
      }
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
  return manifest;
}

function formatManifest(manifest, verbose) {
  if (verbose) return manifest.map((m) => Object.assign({}, m));
  return manifest.map((m) => {
    if (m.kind === "function") return { name: m.name, kind: "function", args: m.args };
    return { name: m.name, kind: "object", functions: m.functions, keys: m.keys };
  });
}

function hashManifest(manifest) {
  const canonical = (manifest || []).map((m) => m.name + ":" + m.kind + ":" + (m.args !== undefined ? m.args : m.keys)).join("|");
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

// vm 执行容器适配器：负责独立 realm 编译、顶层加载超时与同步调用超时中断
function createVmContainer(rt, sandboxGlobal) {
  const ctx = vm.createContext(sandboxGlobal);

  function compile(src, filename) {
    const code = "(function (exports, require, module, __filename, __dirname) {\n" + src + "\n})";
    try {
      return vm.runInContext(code, ctx, { filename });
    } catch (e) {
      if (e instanceof SyntaxError && /\bimport\b|\bexport\b/.test(src.slice(0, 4000))) {
        throw rt.err("SYNTAX_ERROR", filename + " 疑似 ESM 语法;dev-bridge 当前仅支持 CommonJS: " + e.message);
      }
      throw rt.err("SYNTAX_ERROR", filename + " 编译失败: " + ((e && e.stack) || e));
    }
  }

  function execWrapper(wrapper, exp, req, mod, filename, dirname, timeoutMs, label) {
    ctx.__devWrap = wrapper;
    ctx.__devExp = exp;
    ctx.__devReq = req;
    ctx.__devMod = mod;
    ctx.__devFn = filename;
    ctx.__devDn = dirname;
    try {
      vm.runInContext("__devOut = __devWrap(__devExp, __devReq, __devMod, __devFn, __devDn)", ctx, { timeout: timeoutMs, filename: label });
      return ctx.__devOut;
    } catch (e) {
      if (/timed out/i.test(String(e && e.message))) {
        throw rt.err("TIMEOUT", label + " 顶层同步执行超时(>" + timeoutMs + "ms);沙箱已标记重建");
      }
      throw e;
    } finally {
      delete ctx.__devWrap;
      delete ctx.__devExp;
      delete ctx.__devReq;
      delete ctx.__devMod;
      delete ctx.__devFn;
      delete ctx.__devDn;
      delete ctx.__devOut;
    }
  }

  function runCall(fn, args, timeoutMs, gen) {
    ctx.__devFn = fn;
    ctx.__devArgs = args;
    try {
      vm.runInContext("__devOut = __devFn(...__devArgs)", ctx, { timeout: timeoutMs });
      return ctx.__devOut;
    } catch (e) {
      if (/timed out/i.test(String(e && e.message))) {
        if (gen) gen.dirty = true;
        throw rt.err("TIMEOUT", "同步执行超时(>" + timeoutMs + "ms),沙箱已标记重建;下次调用将自动重载");
      }
      throw e;
    } finally {
      delete ctx.__devFn;
      delete ctx.__devArgs;
      delete ctx.__devOut;
    }
  }

  return { ctx, compile, execWrapper, runCall };
}

function createCjsResolver(rt, gen, entry, deps) {
  const { builtinMap, compileAndRun } = deps;
  const deniedFactory = createDeniedFactory(rt, deps.recordCall);
  const cache = new Map();
  const hostResolveBase = Module.createRequire(entry);
  const resolverCache = new Map();

  function resolverFor(fromFile) {
    if (!fromFile || fromFile === entry) return hostResolveBase;
    let r = resolverCache.get(fromFile);
    if (!r) {
      r = Module.createRequire(fromFile);
      resolverCache.set(fromFile, r);
    }
    return r;
  }

  function resolveBuiltinModule(resolved) {
    const bare = normalizeModuleName(resolved);
    if (Object.prototype.hasOwnProperty.call(builtinMap, bare)) return builtinMap[bare];
    if (ALLOW_MODULES.has(bare)) return hostResolveBase(resolved);
    if (isHostModuleAllowed(gen, bare)) return hostResolveBase(resolved);
    return deniedFactory.makeDeniedModule(bare);
  }

  function makeRequireFn(fromFile) {
    const f = (r) => localRequire(fromFile, r);
    f.resolve = (r) => resolverFor(fromFile).resolve(r);
    f.cache = cache;
    return f;
  }

  function loadModule(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const mod = { exports: {}, loaded: false, id: filename };
    cache.set(filename, mod);
    let src;
    try { src = fs.readFileSync(filename, "utf8"); }
    catch (e) { throw rt.err("REQUIRE_FAILED", "读取模块失败 " + filename + ": " + e.message); }
    if (src.startsWith("#!")) src = "//" + src.slice(2);
    try {
      compileAndRun(src, mod.exports, makeRequireFn(filename), mod, filename, path.dirname(filename));
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
    const bare0 = normalizeModuleName(reqStr);
    const isPathy = /^[./\\]/.test(reqStr) || path.isAbsolute(reqStr);
    if (!isPathy && DENY_MODULES.has(bare0) && !isHostModuleAllowed(gen, bare0)) {
      return deniedFactory.makeDeniedModule(bare0);
    }
    let resolved;
    try {
      resolved = resolverFor(fromFile).resolve(request);
    } catch (e) {
      if (!isPathy && DENY_MODULES.has(bare0)) return deniedFactory.makeDeniedModule(bare0);
      throw rt.err("REQUIRE_FAILED", "无法解析模块 '" + request + "' (from " + fromFile + "): " + e.message);
    }
    if (!path.isAbsolute(resolved)) return resolveBuiltinModule(resolved);
    if (/\.node$/i.test(resolved)) return hostResolveBase(resolved);
    if (/\.json$/i.test(resolved)) return JSON.parse(fs.readFileSync(resolved, "utf8"));
    if (/\.mjs$/i.test(resolved)) {
      throw rt.err("REQUIRE_FAILED", "ESM 模块不支持 vm 加载(当前仅支持 CommonJS): " + resolved);
    }
    if (!/\.c?js$/i.test(resolved)) return hostResolveBase(resolved);
    return loadModule(resolved);
  }

  return { makeRequireFn };
}

function createLoader(rt, proxyApi, journalApi) {
  function buildGeneration(cfg) {
    const resolved = resolveEntry(rt, cfg);
    const entry = resolved.entry;
    const gen = {
      id: Date.now(),
      entry,
      targetRoot: resolved.targetRoot,
      mainPath: resolved.mainPath,
      mode: cfg.mode || "plugin",
      allowSideEffects: !!cfg.allowSideEffects,
      allowHostModules: cfg.allowHostModules === true ? true
        : (Array.isArray(cfg.allowHostModules) ? cfg.allowHostModules.map(String) : false),
      allowAllModules: cfg.allowHostModules === true,
      reveal: !!cfg.reveal,
      loadedAt: new Date().toISOString(),
      timeoutMs: cfg.timeoutMs || LIMITS.LOAD_TIMEOUT_DEFAULT,
      ctx: null,
      container: null,
      manifest: [],
      exportsHash: "",
      events: {},
      eventsList: [],
      tools: Object.create(null),
      warnings: [],
      timers: new Set(),
      dirty: false,
      retired: false,
      proxyCache: new WeakMap(),
      domEvents: {},
    };

    const sandboxGlobal = {};
    const container = createVmContainer(rt, sandboxGlobal);
    gen.ctx = container.ctx;
    gen.container = container;

    const timersBundle = makeTimers(gen, proxyApi.recordCall, proxyApi.guardAsyncFn);
    const sandboxConsole = makeConsole(rt);
    const processShim = makeProcessShim(proxyApi.recordUncaught);
    const fsShim = makeFsShim(gen, journalApi, proxyApi.recordCall);

    sandboxGlobal.window = sandboxGlobal;
    sandboxGlobal.global = sandboxGlobal;
    sandboxGlobal.utools = proxyApi.makeUtoolsProxy(gen);
    sandboxGlobal.console = sandboxConsole;
    sandboxGlobal.process = processShim;
    sandboxGlobal.document = makeDomShim(gen, proxyApi.recordCall);
    sandboxGlobal.Buffer = Buffer;
    sandboxGlobal.setTimeout = timersBundle.timers.setTimeout;
    sandboxGlobal.setInterval = timersBundle.timers.setInterval;
    sandboxGlobal.setImmediate = timersBundle.timers.setImmediate;
    sandboxGlobal.clearTimeout = timersBundle.timers.clearTimeout;
    sandboxGlobal.clearInterval = timersBundle.timers.clearInterval;
    sandboxGlobal.clearImmediate = timersBundle.timers.clearImmediate;
    sandboxGlobal.queueMicrotask = (fn) => queueMicrotask(proxyApi.guardAsyncFn(fn));
    for (const g of WEB_GLOBALS) {
      try { if (typeof globalThis[g] !== "undefined") sandboxGlobal[g] = globalThis[g]; } catch (_) {}
    }
    sandboxGlobal.fetch = function (input, init) {
      if (gen.allowAllModules) {
        if (typeof globalThis.fetch !== "function") throw rt.err("DENIED_FETCH", "宿主环境无 fetch");
        return globalThis.fetch(input, init);
      }
      const e = rt.err("DENIED_FETCH", "[dev-bridge] fetch 已拦截;dev_load 传 allowHostModules:true 放行");
      proxyApi.recordCall("fetch", [input, init], undefined, e, true, true);
      return Promise.reject(e);
    };

    const entryModule = { exports: {} };
    sandboxGlobal.module = entryModule;
    sandboxGlobal.exports = entryModule.exports;

    const builtinMap = {
      "process": processShim,
      "console": sandboxConsole,
      "timers": timersBundle.timers,
      "timers/promises": timersBundle.promises,
      "fs": fsShim,
      "fs/promises": fsShim.promises,
      "module": null,
    };

    const { makeRequireFn } = createCjsResolver(rt, gen, entry, {
      builtinMap,
      recordCall: proxyApi.recordCall,
      compileAndRun(src, exp, req, mod, filename, dirname) {
        const wrapper = container.compile(src, filename);
        return container.execWrapper(wrapper, exp, req, mod, filename, dirname, gen.timeoutMs, filename);
      },
    });
    builtinMap.module = {
      createRequire: (f) => makeRequireFn(String(f)),
      builtinModules: Module.builtinModules,
    };

    const baseKeys = new Set(Reflect.ownKeys(sandboxGlobal));
    let src;
    try { src = fs.readFileSync(entry, "utf8"); }
    catch (e) { throw rt.err("PATH_NOT_FOUND", "读取入口失败 " + entry + ": " + e.message); }
    if (src.startsWith("#!")) src = "//" + src.slice(2);
    const wrapper = container.compile(src, entry);
    try {
      container.execWrapper(wrapper, entryModule.exports, makeRequireFn(entry), entryModule, entry, path.dirname(entry), gen.timeoutMs, entry);
    } catch (e) {
      if (e && e.__devErr && e.code === "TIMEOUT") gen.dirty = true;
      throw rt.err("REQUIRE_FAILED", "入口执行失败: " + ((e && e.stack) || e));
    }

    gen.manifest = collectExportsManifest(sandboxGlobal, baseKeys, entryModule);
    gen.exportsHash = hashManifest(gen.manifest);
    gen.eventsList = Object.keys(gen.events).map((api) => ({ api, count: gen.events[api].length }));
    if (!gen.manifest.length) {
      gen.warnings.push("未发现可调用导出;若目标为 UI 插件，改用 dev_ui_open 在真实窗口测渲染期逻辑");
    }
    return gen;
  }

  function ensureState(meta) {
    if (rt.CURRENT_GEN && !rt.CURRENT_GEN.dirty) return;
    const cfg = rt.restoreLast();
    if (!cfg) return;
    let fresh;
    try {
      fresh = buildGeneration(cfg);
    } catch (e) {
      rt.clearLast();
      if (meta) meta.lastRestoreFailed = (e && e.code ? "[" + e.code + "] " : "") + String((e && e.message) || e);
      return;
    }
    if (rt.CURRENT_GEN) rt.CURRENT_GEN.retired = true;
    killTimers(rt.CURRENT_GEN);
    rt.CURRENT_GEN = fresh;
    if (meta) meta.reloaded = true;
  }

  // 在真实 BrowserWindow 渲染上下文装载目标 preload：所有 window.xxx 挂载直接对前端可见
  function loadIntoCurrentWindow(cfg, winObj, opts) {
    const entry = cfg.entry;
    const gen = {
      id: Date.now(),
      entry: entry || cfg.targetRoot,
      targetRoot: cfg.targetRoot,
      mode: "ui",
      allowSideEffects: !!cfg.allowSideEffects,
      allowHostModules: cfg.allowHostModules === true ? true
        : (Array.isArray(cfg.allowHostModules) ? cfg.allowHostModules.map(String) : false),
      allowAllModules: cfg.allowHostModules === true,
      reveal: !!cfg.reveal,
      loadedAt: new Date().toISOString(),
      timeoutMs: cfg.timeoutMs || LIMITS.UI_TIMEOUT_DEFAULT,
      ctx: winObj,
      manifest: [],
      events: {},
      eventsList: [],
      tools: Object.create(null),
      warnings: [],
      timers: new Set(),
      dirty: false,
      retired: false,
      proxyCache: new WeakMap(),
      domEvents: {},
    };
    rt.CURRENT_GEN = gen;

    const proxiedUtools = proxyApi.makeUtoolsProxy(gen);
    try {
      Object.defineProperty(winObj, "utools", {
        value: proxiedUtools,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    } catch (_) {
      winObj.utools = proxiedUtools;
    }

    if (!entry || !fs.existsSync(entry)) {
      return { gen, proxiedUtools };
    }

    const timersBundle = makeTimers(gen, proxyApi.recordCall, proxyApi.guardAsyncFn);
    const processShim = makeProcessShim(proxyApi.recordUncaught);
    const fsShim = makeFsShim(gen, journalApi, proxyApi.recordCall);
    const uiConsole = (opts && opts.console) || winObj.console;
    const builtinMap = {
      "process": processShim,
      "console": uiConsole,
      "timers": timersBundle.timers,
      "timers/promises": timersBundle.promises,
      "fs": fsShim,
      "fs/promises": fsShim.promises,
      "module": null,
    };

    const { makeRequireFn } = createCjsResolver(rt, gen, entry, {
      builtinMap,
      recordCall: proxyApi.recordCall,
      compileAndRun(src, exp, req, mod, filename, dirname) {
        // 在当前真实 BrowserWindow 作用域执行目标模块，保持 window/document 同体
        const fn = new Function(
          "exports", "require", "module", "__filename", "__dirname",
          "process", "console", "window", "global", "setTimeout", "setInterval", "setImmediate",
          "clearTimeout", "clearInterval", "clearImmediate", "utools",
          src + "\n//# sourceURL=" + filename
        );
        return fn(
          exp, req, mod, filename, dirname,
          processShim, uiConsole, winObj, winObj,
          timersBundle.timers.setTimeout, timersBundle.timers.setInterval, timersBundle.timers.setImmediate,
          timersBundle.timers.clearTimeout, timersBundle.timers.clearInterval, timersBundle.timers.clearImmediate,
          proxiedUtools
        );
      },
    });
    builtinMap.module = {
      createRequire: (f) => makeRequireFn(String(f)),
      builtinModules: Module.builtinModules,
    };

    let src = fs.readFileSync(entry, "utf8");
    if (src.startsWith("#!")) src = "//" + src.slice(2);
    const entryModule = { exports: {} };
    const fn = new Function(
      "exports", "require", "module", "__filename", "__dirname",
      "process", "console", "window", "global", "setTimeout", "setInterval", "setImmediate",
      "clearTimeout", "clearInterval", "clearImmediate", "utools",
      src + "\n//# sourceURL=" + entry
    );
    fn(
      entryModule.exports, makeRequireFn(entry), entryModule, entry, path.dirname(entry),
      processShim, uiConsole, winObj, winObj,
      timersBundle.timers.setTimeout, timersBundle.timers.setInterval, timersBundle.timers.setImmediate,
      timersBundle.timers.clearTimeout, timersBundle.timers.clearInterval, timersBundle.timers.clearImmediate,
      proxiedUtools
    );

    gen.eventsList = Object.keys(gen.events).map((api) => ({ api, count: gen.events[api].length }));
    return { gen, proxiedUtools };
  }

  return {
    buildGeneration,
    ensureState,
    loadIntoCurrentWindow,
    resolvePluginManifest,
  };
}

module.exports = {
  normalizeModuleName,
  isHostModuleAllowed,
  resolvePluginManifest,
  resolveEntry,
  collectExportsManifest,
  formatManifest,
  hashManifest,
  createVmContainer,
  createLoader,
};
