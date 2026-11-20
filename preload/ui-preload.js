/**
 * UI 测试子窗口注入脚本（由 utools.createBrowserWindow webPreferences.preload 加载）：
 * 1. 若处于 staging 过渡页（ui-host.html?staging=1），仅挂标记后退出
 * 2. 跳转到目标页面时，在页面脚本执行前接管 window.utools / window.console / 未捕获异常
 * 3. 如目标声明了 preload，则在当前真实 window 上按白名单门控 + WAL fs shim 执行它
 * 4. 全部调用流水、console 与 journal 条目经本机回环 HTTP 上报父进程统一落盘，使 UI 测试同样可还原
 */
"use strict";

(function () {
  try {
    const loc = typeof window !== "undefined" && window.location ? window.location : null;
    if (!loc || loc.search.indexOf("staging=1") >= 0 || /\/preload\/ui-host\.html$/i.test(loc.pathname || "")) {
      if (typeof window !== "undefined") {
        Object.defineProperty(window, "__devbridge", {
          value: { staging: true },
          configurable: true,
        });
      }
      return;
    }

    const fs = require("fs");
    const path = require("path");
    const os = require("os");
    const http = require("http");
    const { LIMITS, LIFECYCLE_SPECIALS } = require("./contract");
    const { createState } = require("./state");
    const { ser, _isThenable } = require("./serialize");
    const { createJournal } = require("./journal");
    const { createProxy } = require("./proxy");
    const { createLoader } = require("./loader");

    const REAL = (typeof window !== "undefined" && window.utools) || globalThis.utools || {};

    function resolveSessionFile() {
      let base;
      try {
        const d = REAL.getPluginLocalDataPath && REAL.getPluginLocalDataPath();
        if (d && typeof d === "string") base = d;
      } catch (_) {}
      if (!base) {
        try {
          const t = REAL.getPath && REAL.getPath("temp");
          if (t && typeof t === "string") base = t;
        } catch (_) {}
      }
      if (!base) base = os.tmpdir();
      return path.join(base, "devbridge-ui-session.json");
    }

    const sessionFile = resolveSessionFile();
    if (!fs.existsSync(sessionFile)) {
      if (typeof window !== "undefined") {
        Object.defineProperty(window, "__devbridge", {
          value: { ready: false, loadError: "未找到 devbridge-ui-session.json" },
          configurable: true,
        });
      }
      return;
    }

    const session = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
    const rt = createState(REAL);
    if (session.journalDir) rt.spill.dir = session.journalDir;

    // 批量上报队列到父进程 /ingest
    const queue = [];
    let scheduled = false;
    let inFlight = null;

    function postBatch(items) {
      return new Promise((resolve) => {
        const body = JSON.stringify({ items });
        const req = http.request({
          hostname: "127.0.0.1",
          port: session.ipcPort,
          path: "/ingest",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            "x-bridge-token": session.bridgeToken,
            "Connection": "close",
          },
        }, (res) => {
          res.resume();
          res.on("end", () => resolve(true));
        });
        req.on("error", () => resolve(false));
        req.setTimeout(3000, () => { try { req.destroy(); } catch (_) {} resolve(false); });
        req.end(body);
      });
    }

    async function drain() {
      while (queue.length > 0) {
        const batch = queue.splice(0, queue.length);
        await postBatch(batch);
      }
    }

    function scheduleSend() {
      if (scheduled || inFlight) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (!queue.length || inFlight) return;
        inFlight = drain().finally(() => {
          inFlight = null;
          if (queue.length) scheduleSend();
        });
      });
    }

    function enqueue(kind, payload) {
      queue.push({ kind, payload });
      scheduleSend();
    }

    async function flush() {
      while (queue.length > 0 || inFlight) {
        if (inFlight) await inFlight;
        if (queue.length > 0 && !inFlight) {
          inFlight = drain().finally(() => { inFlight = null; });
          await inFlight;
        }
      }
      return true;
    }

    const journalApi = createJournal(rt, {
      onEntry: (e) => enqueue("journal", e),
      onRollback: (uid) => enqueue("rollback", uid),
    });
    const proxyApi = createProxy(rt, journalApi, {
      onCall: (e) => enqueue("call", e),
      onConsole: (e) => enqueue("console", e),
    });

    // 包装真实 window.console，同时保留开发者工具原输出并按 reveal 脱敏上报
    const origConsole = window.console || {};
    const uiConsole = {};
    for (const m of ["log", "info", "warn", "error", "debug", "table", "trace", "dir",
      "time", "timeEnd", "timeLog", "group", "groupEnd", "clear", "assert", "count"]) {
      const origFn = typeof origConsole[m] === "function" ? origConsole[m].bind(origConsole) : null;
      uiConsole[m] = function (...args) {
        if (m === "assert" && args[0]) return;
        const level = m === "assert" ? "error" : m;
        enqueue("console", {
          ts: new Date().toISOString(),
          level,
          args: (m === "assert" ? args.slice(1) : args).map((a) => ser(a, true, { redact: !session.reveal })),
        });
        if (origFn) {
          try { origFn(...args); } catch (_) {}
        }
      };
    }
    try {
      Object.defineProperty(window, "console", { value: uiConsole, writable: true, configurable: true });
    } catch (_) {
      for (const m of Object.keys(uiConsole)) {
        try { window.console[m] = uiConsole[m]; } catch (_) {}
      }
    }

    window.addEventListener("error", (ev) => {
      proxyApi.recordUncaught(ev.error || ev.message || "UI Window Error");
    });
    window.addEventListener("unhandledrejection", (ev) => {
      proxyApi.recordUncaught(ev.reason || "Unhandled Promise Rejection");
    });

    const loaderApi = createLoader(rt, proxyApi, journalApi);
    let gen = null;
    let loadError = null;
    try {
      const loaded = loaderApi.loadIntoCurrentWindow({
        entry: session.preloadPath || null,
        targetRoot: session.targetRoot,
        allowSideEffects: !!session.allowSideEffects,
        allowHostModules: session.allowHostModules,
        reveal: !!session.reveal,
        timeoutMs: session.timeoutMs,
      }, window, { console: uiConsole });
      gen = loaded.gen;
    } catch (e) {
      loadError = (e && e.code ? "[" + e.code + "] " : "") + String((e && e.stack) || (e && e.message) || e);
    }

    function buildSnapshot(opts) {
      const sel = (opts && opts.selector) || "body";
      const maxDepth = Math.min(30, Math.max(1, Number(opts && opts.maxDepth) || LIMITS.UI_SNAPSHOT_MAX_DEPTH));
      const maxNodes = Math.min(1000, Math.max(10, Number(opts && opts.maxNodes) || LIMITS.UI_SNAPSHOT_MAX_NODES));
      const includeHidden = !!(opts && opts.includeHidden);
      const root = document.querySelector(sel);
      if (!root) {
        return {
          url: location.href,
          title: document.title,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          nodeCount: 0,
          truncated: false,
          tree: null,
          text: "(未匹配到节点: " + sel + ")",
        };
      }

      const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "META", "LINK"]);
      let count = 0;
      let truncated = false;
      const lines = [];

      function isHidden(el) {
        if (includeHidden) return false;
        try {
          if (el.hidden) return true;
          const st = window.getComputedStyle ? window.getComputedStyle(el) : null;
          if (st && (st.display === "none" || st.visibility === "hidden" || st.opacity === "0")) return true;
          if (el.tagName !== "BODY" && el.tagName !== "HTML" && el.getClientRects) {
            const rects = el.getClientRects();
            if ((!rects || rects.length === 0) && (!el.children || el.children.length === 0)) return true;
          }
        } catch (_) {}
        return false;
      }

      function directText(el) {
        const parts = [];
        for (const ch of el.childNodes || []) {
          if (ch.nodeType === 3) {
            const t = String(ch.nodeValue || "").replace(/\s+/g, " ").trim();
            if (t) parts.push(t);
          }
        }
        return parts.join(" ").slice(0, 120);
      }

      function walk(el, depth) {
        if (!el || count >= maxNodes) { truncated = true; return null; }
        const tag = String(el.tagName || "").toUpperCase();
        if (!tag || SKIP_TAGS.has(tag)) return null;
        if (isHidden(el)) return null;

        count++;
        const node = { tag: tag.toLowerCase() };
        const role = el.getAttribute && el.getAttribute("role");
        const id = el.id || "";
        const testid = el.getAttribute && el.getAttribute("data-testid");
        const ariaLabel = el.getAttribute && el.getAttribute("aria-label");
        const type = el.getAttribute && el.getAttribute("type");
        const name = el.getAttribute && el.getAttribute("name");
        const placeholder = el.getAttribute && el.getAttribute("placeholder");
        const href = el.getAttribute && el.getAttribute("href");
        const disabled = !!el.disabled;
        const checked = typeof el.checked === "boolean" && (type === "checkbox" || type === "radio") ? el.checked : undefined;
        const val = (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") && type !== "password"
          ? (el.value !== undefined && el.value !== "" ? String(el.value).slice(0, 80) : undefined)
          : undefined;
        const txt = directText(el);

        if (role) node.role = role;
        if (id) node.id = id;
        if (testid) node.testid = testid;
        if (ariaLabel) node.ariaLabel = ariaLabel;
        if (type) node.type = type;
        if (name) node.name = name;
        if (val !== undefined) node.value = val;
        if (checked !== undefined) node.checked = checked;
        if (disabled) node.disabled = true;
        if (placeholder) node.placeholder = placeholder;
        if (href) node.href = String(href).slice(0, 120);
        if (txt) node.text = txt;

        // 生成紧凑缩进文本行
        let desc = node.tag;
        if (id) desc += "#" + id;
        if (role) desc += "[role=" + role + "]";
        const attrs = [];
        if (type) attrs.push("type=" + type);
        if (name) attrs.push("name=" + name);
        if (testid) attrs.push("testid=" + testid);
        if (val !== undefined) attrs.push("value=" + JSON.stringify(val));
        if (checked !== undefined) attrs.push("checked=" + checked);
        if (disabled) attrs.push("disabled");
        if (placeholder) attrs.push("placeholder=" + JSON.stringify(placeholder));
        if (attrs.length) desc += "[" + attrs.join(" ") + "]";
        if (ariaLabel) desc += " aria=" + JSON.stringify(ariaLabel);
        if (txt) desc += " " + JSON.stringify(txt);
        lines.push("  ".repeat(depth) + "- " + desc);

        // <svg> 收口为叶子节点，避免内部 <path>/<g> 等矢量图元消耗快照配额与 token
        if (tag === "SVG") return node;

        if (depth < maxDepth && el.children && el.children.length) {
          const kids = [];
          for (const ch of el.children) {
            if (count >= maxNodes) { truncated = true; break; }
            const kn = walk(ch, depth + 1);
            if (kn) kids.push(kn);
          }
          if (kids.length) node.children = kids;
        } else if (el.children && el.children.length) {
          truncated = true;
        }
        return node;
      }

      const tree = walk(root, 0);
      return {
        url: location.href,
        title: document.title,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        nodeCount: count,
        truncated,
        tree,
        text: lines.join("\n"),
      };
    }

    async function triggerLifecycle(specialName, args, optional) {
      const api = LIFECYCLE_SPECIALS[specialName];
      if (!api || !gen) {
        if (optional) return { ok: true, skipped: true };
        return { ok: false, code: "UNKNOWN_EXPORT", message: "未知生命周期名: " + specialName };
      }
      const list = specialName === "__domReady" ? (gen.domEvents.DOMContentLoaded || []) : (gen.events[api] || []);
      if (!list.length) {
        if (optional) return { ok: true, skipped: true };
        return { ok: false, code: "UNKNOWN_EXPORT", message: "窗口未注册 " + api + " 回调" };
      }
      const results = [];
      try {
        for (const fn of list) {
          let r = fn.apply(undefined, args || []);
          if (_isThenable(r)) r = await r;
          results.push(r);
        }
      } catch (e) {
        return { ok: false, code: "THROWN", message: String((e && e.stack) || e) };
      }
      return { ok: true, value: list.length === 1 ? results[0] : results };
    }

    const bridgeApi = {
      ready: !loadError,
      sessionId: session.sessionId,
      loadError,
      flush,
      eventsList() {
        return gen ? Object.keys(gen.events).map((api) => ({ api, count: gen.events[api].length })) : [];
      },
      trigger: triggerLifecycle,
      async openLifecycle(enterArg) {
        const r1 = await triggerLifecycle("__ready", [], true);
        if (!r1.ok) return r1;
        const r2 = await triggerLifecycle("__enter", [enterArg], true);
        await flush();
        return r2;
      },
      snapshot: buildSnapshot,
    };

    Object.defineProperty(window, "__devbridge", {
      value: bridgeApi,
      enumerable: false,
      configurable: true,
    });
  } catch (e) {
    try {
      if (typeof window !== "undefined") {
        Object.defineProperty(window, "__devbridge", {
          value: { ready: false, loadError: String((e && e.stack) || e) },
          configurable: true,
        });
      }
    } catch (_) {}
  }
})();
