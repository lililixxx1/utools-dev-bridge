/**
 * node:test 测试夹具工厂：
 * - 构造整树 Object.freeze 的 mock utools（不污染仓库内 scripts/fixtures/）
 * - 提供贴近 uTools 8.0 真实限制的 BrowserWindow mock（仅收相对路径、无 loadFile/loadURL、真实执行 ui-preload.js 并打通 /ingest）
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const vm = require("vm");
const http = require("http");
const { fileURLToPath } = require("url");

const ROOT = path.resolve(__dirname, "..", "..");
const BRIDGE_ENTRY = path.join(ROOT, "preload", "index.js");

// 1x1 合法 PNG 占位二进制
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

function parseHtmlMiniDom(html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : "";
  const scripts = [];
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = scriptRe.exec(html)) !== null) {
    scripts.push({ attrs: m[1] || "", body: m[2] || "" });
  }
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyHtml = bodyMatch ? bodyMatch[1] : html;
  const cleanBody = bodyHtml.replace(/<script[\s\S]*?<\/script>/gi, "");

  function makeNode(tagName, attrs, text) {
    const node = {
      tagName: tagName.toUpperCase(),
      nodeType: 1,
      id: attrs.id || "",
      attributes: attrs,
      children: [],
      childNodes: [],
      style: {},
      disabled: "disabled" in attrs,
      hidden: "hidden" in attrs,
      checked: "checked" in attrs,
      value: attrs.value !== undefined ? attrs.value : "",
      _listeners: {},
      getAttribute(k) { return k in node.attributes ? node.attributes[k] : null; },
      setAttribute(k, v) { node.attributes[k] = String(v); if (k === "id") node.id = String(v); },
      getClientRects() { return node.hidden || node.style.display === "none" ? [] : [{ width: 100, height: 20 }]; },
      addEventListener(t, fn) { (node._listeners[t] = node._listeners[t] || []).push(fn); },
      click() {
        const ev = { type: "click", target: node, preventDefault() {} };
        for (const fn of node._listeners.click || []) fn(ev);
        if (node.attributes.onclick) {
          node._evalHandler && node._evalHandler(node.attributes.onclick, node);
        }
      },
      get textContent() {
        let s = "";
        for (const c of node.childNodes) s += c.nodeType === 3 ? c.nodeValue : c.textContent;
        return s;
      },
      set textContent(v) {
        node.children = [];
        node.childNodes = v ? [{ nodeType: 3, nodeValue: String(v) }] : [];
      },
    };
    if (text) node.childNodes.push({ nodeType: 3, nodeValue: text });
    return node;
  }

  const parseAttrs = (attrStr) => {
    const attrs = {};
    const aRe = /([a-zA-Z0-9_-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let am;
    while ((am = aRe.exec(attrStr)) !== null) {
      attrs[am[1]] = am[2] !== undefined ? am[2] : (am[3] !== undefined ? am[3] : (am[4] !== undefined ? am[4] : ""));
    }
    return attrs;
  };

  const root = makeNode("BODY", {}, "");
  const tagRe = /<(h1|h2|p|div|span|button|input|a|svg)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/gi;
  while ((m = tagRe.exec(cleanBody)) !== null) {
    const tag = m[1];
    const attrStr = m[2] || "";
    const rawInner = m[3] || "";
    const inner = rawInner.replace(/<[^>]+>/g, "").trim();
    const el = makeNode(tag, parseAttrs(attrStr), inner);
    if (tag.toLowerCase() === "svg" && rawInner) {
      const subRe = /<(path|g|circle|rect|polygon)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/gi;
      let sm;
      while ((sm = subRe.exec(rawInner)) !== null) {
        const subEl = makeNode(sm[1], parseAttrs(sm[2] || ""), "");
        el.children.push(subEl);
        el.childNodes.push(subEl);
      }
    }
    root.children.push(el);
    root.childNodes.push(el);
  }
  return { title, root, scripts };
}

function createMockBrowserWindowFactory(getPluginRoot, baseUtools) {
  let winSeq = 0;

  return function createBrowserWindow(relUrl, options, callback) {
    // 复刻 uTools 8.0 真实限制：url 与 webPreferences.preload 必须为相对路径
    if (!relUrl || /^(?:https?|file):/i.test(relUrl) || path.isAbsolute(relUrl)) {
      throw new Error("参数 url 无效");
    }
    const pluginRoot = getPluginRoot();
    const htmlPath = path.resolve(pluginRoot, relUrl.split("?")[0]);
    if (!fs.existsSync(htmlPath)) {
      throw new Error("'" + relUrl + "' 文件不存在");
    }
    const preloadRel = options && options.webPreferences && options.webPreferences.preload;
    const preloadAbs = preloadRel ? path.resolve(pluginRoot, preloadRel) : null;

    let destroyed = false;
    let currentCtx = null;
    let currentHref = "file:///" + htmlPath.replace(/\\/g, "/") + (relUrl.includes("?") ? "?" + relUrl.split("?")[1] : "");

    function fetchText(urlStr) {
      if (urlStr.startsWith("file:///")) {
        return Promise.resolve(fs.readFileSync(fileURLToPath(new URL(urlStr)), "utf8"));
      }
      return new Promise((resolve, reject) => {
        http.get(urlStr, (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        }).on("error", reject);
      });
    }

    async function loadUrlIntoWindow(targetUrl) {
      currentHref = targetUrl;
      const html = await fetchText(targetUrl);
      const parsed = parseHtmlMiniDom(html);
      const u = new URL(targetUrl);
      const listeners = {};
      const winGlobal = {
        innerWidth: (options && options.width) || 800,
        innerHeight: (options && options.height) || 600,
        location: { href: targetUrl, pathname: u.pathname, search: u.search },
        console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
        utools: Object.assign({}, baseUtools),
        Buffer,
        process,
        setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, Promise, URL,
        addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
        getComputedStyle(el) { return { display: el.style.display || "block", visibility: "visible", opacity: "1" }; },
        document: {
          title: parsed.title,
          readyState: "complete",
          body: parsed.root,
          querySelector(sel) {
            if (sel === "body") return parsed.root;
            if (sel.startsWith("#")) {
              const id = sel.slice(1);
              return parsed.root.children.find((c) => c.id === id) || null;
            }
            return parsed.root.children.find((c) => c.tagName.toLowerCase() === sel.toLowerCase()) || null;
          },
          getElementById(id) {
            return parsed.root.children.find((c) => c.id === id) || null;
          },
          addEventListener() {},
        },
      };
      winGlobal.window = winGlobal;
      winGlobal.globalThis = winGlobal;
      const ctx = vm.createContext(winGlobal);
      currentCtx = ctx;

      for (const ch of parsed.root.children) {
        ch._evalHandler = (code, el) => vm.runInContext("(function(){" + code + "}).call(window)", ctx);
      }

      if (preloadAbs && fs.existsSync(preloadAbs)) {
        const pSrc = fs.readFileSync(preloadAbs, "utf8");
        const wrapper = vm.runInContext(
          "(function(require, module, exports, __filename, __dirname){" + pSrc + "\n})",
          ctx,
          { filename: preloadAbs }
        );
        const mod = { exports: {} };
        const req = require("module").createRequire(preloadAbs);
        wrapper(req, mod, mod.exports, preloadAbs, path.dirname(preloadAbs));
      }

      for (const sc of parsed.scripts) {
        if (sc.body && sc.body.trim()) {
          vm.runInContext(sc.body, ctx);
        }
      }
    }

    const win = {
      id: ++winSeq,
      isDestroyed: () => destroyed,
      destroy: () => { destroyed = true; currentCtx = null; },
      close: () => { destroyed = true; currentCtx = null; },
      show: () => {},
      hide: () => {},
      capturePage: async () => ({
        toPNG: () => PNG_1X1,
        toDataURL: () => "data:image/png;base64," + PNG_1X1.toString("base64"),
        getSize: () => ({ width: (options && options.width) || 800, height: (options && options.height) || 600 }),
      }),
      // 刻意不提供 win.loadFile / win.loadURL 与 webContents.loadFile / loadURL，对齐 uTools 8.0 实机
      webContents: {
        executeJavaScript: async (code) => {
          if (destroyed) throw new Error("Window destroyed");
          const navMatch = String(code).match(/^\s*location\.href\s*=\s*(.+)$/);
          if (navMatch) {
            const nextUrl = JSON.parse(navMatch[1]);
            await loadUrlIntoWindow(nextUrl);
            return nextUrl;
          }
          if (!currentCtx) throw new Error("No window context");
          const val = vm.runInContext(code, currentCtx);
          return val;
        },
      },
    };

    loadUrlIntoWindow(currentHref).then(() => {
      if (typeof callback === "function") setImmediate(callback);
    }).catch((e) => {
      console.error("mock BrowserWindow load error:", e);
    });
    return win;
  };
}

function setupBridge(opts) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "devbridge-test-"));
  const localDataDir = path.join(baseDir, "plugindata");
  fs.mkdirSync(localDataDir, { recursive: true });

  const registered = {};
  const dbDocs = new Map();
  const kv = new Map();
  const kvCrypto = new Map();
  let revCounter = 0;
  let clipboard;
  let schedAsked = 0;
  let schedRemoved = 0;

  const mockUtools = {
    registerTool: (name, fn) => { registered[name] = fn; },
    getNativeId: () => (opts && opts.nativeId) || "selftest-native-id-999",
    getUser: () => ({ nickname: "devtester", avatar: "https://example.com/a.png", type: "member" }),
    getAppVersion: () => "8.0.2-selftest",
    getPath: (n) => path.join(baseDir, n),
    getPluginLocalDataPath: () => localDataDir,
    copyText: (t) => { clipboard = t; },
    onPluginEnter: () => {},
    onPluginOut: () => {},
    onMainPush: () => {},
    onPluginDetach: () => {},
    onDbPull: () => {},
    onPluginReady: () => {},
    onScheduleTrigger: () => {},
    requestSchedule: async () => { schedAsked++; },
    getSchedules: () => [],
    removeSchedule: () => { schedRemoved++; },
    db: {
      get: (id) => dbDocs.get(id) || null,
      put: (doc) => {
        const out = Object.assign({}, doc, { _rev: "r" + (++revCounter) });
        dbDocs.set(doc._id, out);
        return out;
      },
      remove: (docOrId) => {
        const id = typeof docOrId === "string" ? docOrId : docOrId._id;
        if (!dbDocs.has(id)) throw new Error("missing");
        dbDocs.delete(id);
        return { ok: true, id, rev: "r" + (++revCounter) };
      },
      bulkDocs: (docs) => docs.map((d) => mockUtools.db.put(d)),
      postAttachment: (id, buf, type) => {
        const out = { _id: id, _rev: "r" + (++revCounter), _attachments: { data: { content_type: type, length: buf.length } } };
        dbDocs.set(id, out);
        return out;
      },
    },
    dbStorage: {
      setItem: (k, v) => kv.set(k, v),
      getItem: (k) => (kv.has(k) ? kv.get(k) : undefined),
      removeItem: (k) => kv.delete(k),
    },
    dbCryptoStorage: {
      setItem: (k, v) => kvCrypto.set(k, v),
      getItem: (k) => (kvCrypto.has(k) ? kvCrypto.get(k) : undefined),
      removeItem: (k) => kvCrypto.delete(k),
    },
  };

  if (!opts || opts.withBrowserWindow !== false) {
    mockUtools.createBrowserWindow = createMockBrowserWindowFactory(() => ROOT, mockUtools);
  }

  for (const k of Object.keys(mockUtools)) {
    const v = mockUtools[k];
    if (v && typeof v === "object") Object.freeze(v);
  }
  Object.freeze(mockUtools);

  global.utools = mockUtools;
  delete require.cache[require.resolve(BRIDGE_ENTRY)];
  require(BRIDGE_ENTRY);

  return {
    ROOT,
    BRIDGE_ENTRY,
    baseDir,
    localDataDir,
    tools: registered,
    dbDocs,
    kv,
    kvCrypto,
    getClipboard: () => clipboard,
    getSchedCounts: () => ({ asked: schedAsked, removed: schedRemoved }),
    resetSchedCounts: () => { schedAsked = 0; schedRemoved = 0; },
    reloadBridge() {
      delete require.cache[require.resolve(BRIDGE_ENTRY)];
      for (const k of Object.keys(registered)) delete registered[k];
      require(BRIDGE_ENTRY);
      return registered;
    },
    cleanup() {
      try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (_) {}
    },
  };
}

function createDemoPlugin(parentDir) {
  const fx = path.join(parentDir, "demo-plugin");
  fs.mkdirSync(path.join(fx, "services"), { recursive: true });
  fs.mkdirSync(path.join(fx, "preload"), { recursive: true });
  fs.writeFileSync(path.join(fx, "plugin.json"), JSON.stringify({ preload: "preload/index.js", logo: "logo.png" }, null, 2));
  fs.writeFileSync(path.join(fx, "services", "sibling.js"), '"use strict";\nmodule.exports = { val: 42 };\n');
  fs.writeFileSync(path.join(fx, "services", "math.js"), '"use strict";\nconst TAX = 8;\nconst SIB = require("./sibling.js").val;\nmodule.exports = { add: (a, b) => a + b, withTax: (a) => a + TAX, SIB };\n');
  fs.writeFileSync(path.join(fx, "preload", "index.js"), [
    '"use strict";',
    'const math = require("../services/math.js");',
    'const ut = () => global.utools || window.utools;',
    'const NID = utools.getNativeId ? utools.getNativeId() : "local";',
    'const cp = require("node:child_process");',
    'const el = require("electron");',
    'el.ipcRenderer.on("evt", () => {});',
    'const fsn = require("fs");',
    'const fsnn = require("node:fs");',
    'const fsp = require("fs/promises");',
    'utools.onPluginEnter(({ code, type, payload }) => { console.log("enter", code, type, payload); });',
    'utools.onPluginOut((isKill) => { console.log("out-cb", isKill); });',
    'utools.onMainPush(({ code }) => { console.log("push-cb", code); }, (act) => { console.log("push-sel", act && act.option && act.option.text); return true; });',
    'utools.onPluginReady(() => { console.log("ready-cb"); });',
    'utools.onScheduleTrigger(({ code }) => { console.log("schedule-cb", code); });',
    'utools.registerTool("say_hi", (params, ctx) => ({ echo: params && params.text, hasCtx: !!ctx }));',
    'utools.registerTool("bad_handler", 12345);',
    'window.demo = {',
    '  add: math.add,',
    '  withTax: math.withTax,',
    '  native: () => NID,',
    '  hasApi: (k) => k in utools,',
    '  apiKeys: () => Object.keys(utools),',
    '  save: (k, v) => ut().dbStorage.setItem(k, v),',
    '  saveCrypto: (k, v) => ut().dbCryptoStorage.setItem(k, v),',
    '  getCrypto: (k) => ut().dbCryptoStorage.getItem(k),',
    '  perfKvWrites: (n) => { const v = "x".repeat(4096); for (let i = 0; i < n; i++) ut().dbStorage.setItem("_dev_:perf-" + i, v); return n; },',
    '  saveDoc: (id) => ut().db.put({ _id: id, hello: 1 }),',
    '  removeDoc: (id) => ut().db.remove(id),',
    '  bulkCreate: (ids) => ut().db.bulkDocs(ids.map((id) => ({ _id: id, src: "bulk" }))),',
    '  arm: (ms) => { setTimeout(() => { ut().db.put({ _id: "_dev_:late", n: 1 }); }, ms); return "armed"; },',
    '  echoClipboard: (t) => ut().copyText(t),',
    '  armSchedule: () => utools.requestSchedule({ code: "t1", label: "桥测", trigger: 60000 }),',
    '  armScheduleThen: () => typeof utools.requestSchedule({ code: "t2", label: "桥测", trigger: 1 }).then === "function",',
    '  dropSchedule: () => utools.removeSchedule("t1"),',
    '  boom: () => { console.log("before-boom"); throw new Error("炸了:boom-test"); },',
    '  slow: (ms) => new Promise((r) => setTimeout(() => r("slow-done"), ms || 80)),',
    '  spawnEcho: () => cp.exec("echo hi"),',
    '  httpTwice: () => require("http") === require("node:http"),',
    '  fsSame: () => fsn === fsnn,',
    '  fsPromisesSame: () => fsp === fsn.promises,',
    '  write: (p, c) => fsn.writeFileSync(p, c),',
    '  writeP: (p, c) => fsp.writeFile(p, c),',
    '  nodeFsWrite: (p, c) => fsnn.writeFileSync(p, c),',
    '  readBack: (p) => fsn.readFileSync(p, "utf8"),',
    '  mv: (a, b) => fsn.renameSync(a, b),',
    '  unlink: (p) => fsn.unlinkSync(p),',
    '  mkdir: (p) => fsn.mkdirSync(p, { recursive: true }),',
    '  asyncBoom: () => { setTimeout(() => { throw new Error("async-boom-x"); }, 5); return "scheduled"; },',
    '  dbTwice: () => utools.db === utools.db,',
    '  tbl: () => { console.table({ a: 1 }); console.time("t"); console.timeEnd("t"); return "tbl-ok"; },',
    '  webGlobals: () => [typeof URL, typeof TextEncoder, typeof AbortController],',
    '  hasFetch: () => typeof fetch,',
    '  fetchIt: () => fetch("http://127.0.0.1:1/x"),',
    '  sib: () => math.SIB,',
    '  stream: (p) => { const ws = fsn.createWriteStream(p); ws.write("streamed"); ws.end(); return "opened"; },',
    '  ln: (a, b) => fsn.linkSync(a, b),',
    '  mktmp: (p) => fsn.mkdtempSync(p),',
    '  tp: () => typeof (require("timers").promises || {}).setTimeout,',
    '  saveTwice: (id) => { ut().db.put({ _id: id, n: 1 }); ut().db.put({ _id: id, n: 2 }); return "ok"; },',
    '  domProbe: () => { const el = document.createElement("div"); el.setAttribute("id", "x"); el.addEventListener("click", () => {}); document.body.appendChild(el); return { byId: document.getElementById("x"), q: document.querySelector(".a"), qall: document.querySelectorAll(".a").length, children: document.body.children.length, tag: el.tagName }; },',
    '  domListen: () => { document.addEventListener("DOMContentLoaded", () => { console.log("dom-ready-cb"); }); return "listening"; },',
    '};',
    'console.log("boot", "demo preload 挂载完成");',
  ].join("\n"));
  return fx;
}

module.exports = { setupBridge, createDemoPlugin };
