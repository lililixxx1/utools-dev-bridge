/**
 * 真窗口渲染层测试工具（dev_ui_open / dev_ui_eval / dev_ui_snapshot / dev_ui_screenshot / dev_ui_close）：
 * - 通过 utools.createBrowserWindow 打开隐藏或可见窗口，经 ui-host.html 跳转加载目标前端
 * - 注入 ui-preload.js 接管 window.utools / console / fs，写副作用通过本机 /ingest 单点进父进程写日志
 * - 自动检测 ESM / 根路径静态资源，按需启本机回环静态文件服务
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const crypto = require("crypto");
const hostTimers = require("timers");
const { LIMITS } = require("../contract");
const { ser } = require("../serialize");
const { isOutsideTarget } = require("../journal");
const { resolvePluginManifest } = require("../loader");
const { attachInlineLogs } = require("./call");
const { assertHighRiskConfirmed } = require("./load");

const MIME_MAP = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".cjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".map": "application/json",
};

function needsHttpStaticServer(mainPath) {
  try {
    const html = fs.readFileSync(mainPath, "utf8");
    if (/<script[^>]+type\s*=\s*["']module["']/i.test(html)) return true;
    if (/(?:src|href)\s*=\s*["']\/(?!\/)/i.test(html)) return true;
  } catch (_) {}
  return false;
}

function createStaticServer(rootDir) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const u = new URL(req.url || "/", "http://127.0.0.1");
        let relPath = decodeURIComponent(u.pathname || "/");
        if (relPath === "/") relPath = "/index.html";
        let target = path.resolve(rootDir, "." + relPath);
        if (isOutsideTarget(rootDir, target)) {
          res.writeHead(403);
          res.end("Forbidden");
          return;
        }
        if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
          target = path.join(target, "index.html");
        }
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
          res.writeHead(404);
          res.end("Not Found");
          return;
        }
        const ext = path.extname(target).toLowerCase();
        res.writeHead(200, { "Content-Type": MIME_MAP[ext] || "application/octet-stream" });
        fs.createReadStream(target).pipe(res);
      } catch (e) {
        res.writeHead(500);
        res.end(String(e && e.message));
      }
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function createCollectorServer(rt, journalApi, token) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/ingest" || req.headers["x-bridge-token"] !== token) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          for (const item of data.items || []) {
            if (!item || !item.kind) continue;
            if (item.kind === "console") {
              const p = item.payload || {};
              rt.pushRing(rt.ringConsole, {
                seq: ++rt.consoleSeq,
                ts: p.ts || new Date().toISOString(),
                level: p.level || "log",
                args: p.args || [],
                fromUi: true,
              });
            } else if (item.kind === "call") {
              const p = Object.assign({}, item.payload || {}, { seq: ++rt.callsSeq, fromUi: true });
              rt.pushRing(rt.ringCalls, p);
            } else if (item.kind === "journal") {
              journalApi.pushJournalEntry(item.payload);
            } else if (item.kind === "rollback") {
              journalApi.removeJournalByUid(item.payload);
            }
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"ok":true}');
        } catch (e) {
          res.writeHead(400);
          res.end(String(e && e.message));
        }
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function createUiTools(rt, journalApi) {
  const REAL = rt.REAL;

  function resolveSessionDir() {
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
    return base || os.tmpdir();
  }

  function getOpenSession() {
    const s = rt.uiSession;
    if (!s || !s.win || (typeof s.win.isDestroyed === "function" && s.win.isDestroyed())) {
      throw rt.err("UI_NOT_OPEN", "尚未打开测试 UI 窗口;先调用 dev_ui_open");
    }
    return s;
  }

  async function flushSession() {
    const s = rt.uiSession;
    if (!s || !s.win || (typeof s.win.isDestroyed === "function" && s.win.isDestroyed())) return;
    try {
      await Promise.race([
        s.win.webContents.executeJavaScript("window.__devbridge && window.__devbridge.flush ? window.__devbridge.flush() : true"),
        new Promise((r) => hostTimers.setTimeout(r, 1500)),
      ]);
    } catch (_) {}
  }

  function closeServer(srv) {
    if (!srv) return;
    try { if (typeof srv.closeAllConnections === "function") srv.closeAllConnections(); } catch (_) {}
    try { srv.close(); } catch (_) {}
  }

  async function closeActiveSession() {
    const s = rt.uiSession;
    if (!s) return false;
    rt.uiSession = null;
    try {
      if (s.win && (!s.win.isDestroyed || !s.win.isDestroyed())) {
        try {
          await Promise.race([
            s.win.webContents.executeJavaScript("window.__devbridge && window.__devbridge.flush ? window.__devbridge.flush() : true"),
            new Promise((r) => hostTimers.setTimeout(r, 800)),
          ]);
        } catch (_) {}
        try { s.win.destroy(); } catch (_) {}
      }
    } catch (_) {}
    closeServer(s.staticServer);
    closeServer(s.collectorServer);
    if (s.sessionFile) { try { fs.unlinkSync(s.sessionFile); } catch (_) {} }
    return true;
  }

  async function devUiOpen(cfg) {
    if (!REAL || typeof REAL.createBrowserWindow !== "function") {
      throw rt.err("UI_UNAVAILABLE", "当前宿主环境不支持 utools.createBrowserWindow");
    }
    const targetPath = (cfg && cfg.path) || (rt.CURRENT_GEN && rt.CURRENT_GEN.targetRoot);
    if (!targetPath) {
      throw rt.err("PATH_NOT_FOUND", "请传目标插件根目录 path（或先调用 dev_load）");
    }
    const manifest = resolvePluginManifest(rt, targetPath);
    if (!manifest.mainPath || !fs.existsSync(manifest.mainPath)) {
      throw rt.err("NO_MAIN", "目标 plugin.json 未声明有效的 main HTML 入口");
    }
    const risks = assertHighRiskConfirmed(rt, cfg || {});
    const preloadPath = manifest.preloadPath && fs.existsSync(manifest.preloadPath) ? manifest.preloadPath : null;

    await closeActiveSession();

    const timeoutMs = (cfg && cfg.timeoutMs) || LIMITS.UI_TIMEOUT_DEFAULT;
    const bridgeToken = crypto.randomBytes(24).toString("hex");
    const sessionId = "ui-" + Date.now();
    const sessionDir = resolveSessionDir();
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, "devbridge-ui-session.json");

    const collectorServer = await createCollectorServer(rt, journalApi, bridgeToken);
    let staticServer = null;
    let targetUrl;
    let servedVia;
    const useHttp = cfg && cfg.serveHttp !== undefined
      ? !!cfg.serveHttp
      : needsHttpStaticServer(manifest.mainPath);

    try {
      if (useHttp) {
        staticServer = await createStaticServer(manifest.targetRoot);
        const port = staticServer.address().port;
        const rel = path.relative(manifest.targetRoot, manifest.mainPath).split(path.sep).map(encodeURIComponent).join("/");
        targetUrl = "http://127.0.0.1:" + port + "/" + rel;
        servedVia = "http";
      } else {
        targetUrl = "file:///" + manifest.mainPath.replace(/\\/g, "/");
        servedVia = "file";
      }

      const sessionData = {
        sessionId,
        ipcPort: collectorServer.address().port,
        bridgeToken,
        targetRoot: manifest.targetRoot,
        preloadPath,
        journalDir: journalApi.journalDir(),
        allowSideEffects: !!(cfg && cfg.allowSideEffects),
        allowHostModules: cfg && cfg.allowHostModules !== undefined ? cfg.allowHostModules : false,
        reveal: !!(cfg && cfg.reveal),
        timeoutMs,
      };
      fs.writeFileSync(sessionFile, JSON.stringify(sessionData));

      const consoleFrom = rt.consoleSeq;
      const callsFrom = rt.callsSeq;
      const width = (cfg && cfg.width) || 800;
      const height = (cfg && cfg.height) || 600;
      const show = !!(cfg && cfg.show);

      // uTools 8.0 createBrowserWindow 仅收相对插件根目录的路径，先建过渡页再跳转目标 URL
      let win;
      await new Promise((resolve, reject) => {
        const t = hostTimers.setTimeout(() => reject(rt.err("TIMEOUT", "创建 BrowserWindow 过渡页超时")), timeoutMs);
        try {
          win = REAL.createBrowserWindow(
            "preload/ui-host.html?staging=1",
            {
              show,
              width,
              height,
              webPreferences: { preload: "preload/ui-preload.js" },
            },
            () => {
              hostTimers.clearTimeout(t);
              resolve();
            }
          );
        } catch (e) {
          hostTimers.clearTimeout(t);
          reject(e);
        }
      });

      rt.uiSession = {
        sessionId,
        win,
        winId: win.id,
        url: targetUrl,
        servedVia,
        targetRoot: manifest.targetRoot,
        reveal: sessionData.reveal,
        staticServer,
        collectorServer,
        sessionFile,
      };

      await win.webContents.executeJavaScript("location.href = " + JSON.stringify(targetUrl));

      const deadline = Date.now() + timeoutMs;
      let status = null;
      while (Date.now() < deadline) {
        if (win.isDestroyed && win.isDestroyed()) {
          throw rt.err("UI_EVAL_FAILED", "测试窗口在加载过程中意外销毁");
        }
        try {
          status = await win.webContents.executeJavaScript(
            "window.__devbridge && !window.__devbridge.staging ? { ready: !!window.__devbridge.ready, loadError: window.__devbridge.loadError || null, readyState: document.readyState, title: document.title, href: location.href, events: window.__devbridge.eventsList ? window.__devbridge.eventsList() : [] } : null"
          );
          if (status && (status.loadError || (status.ready && status.readyState === "complete"))) break;
        } catch (_) {}
        await new Promise((r) => hostTimers.setTimeout(r, 30));
      }

      if (!status) {
        throw rt.err("TIMEOUT", "等待目标 UI 页面就绪超时(>" + timeoutMs + "ms)");
      }
      if (status.loadError) {
        throw rt.err("REQUIRE_FAILED", "UI preload 加载失败: " + status.loadError);
      }

      if (cfg && cfg.enter) {
        const lcRes = await win.webContents.executeJavaScript(
          "window.__devbridge.openLifecycle(" + JSON.stringify(cfg.enter) + ")"
        );
        if (lcRes && lcRes.ok === false) {
          throw rt.err(lcRes.code || "THROWN", lcRes.message || "UI 生命周期执行失败");
        }
      }

      await flushSession();

      const out = {
        ok: true,
        winId: win.id,
        url: status.href || targetUrl,
        servedVia,
        title: status.title || "",
        events: status.events || [],
        consoleFrom,
        callsFrom,
        consoleTo: rt.consoleSeq,
        callsTo: rt.callsSeq,
      };
      if (risks.length) out.riskNotice = risks;
      return attachInlineLogs(out, rt, consoleFrom, callsFrom, undefined, true);
    } catch (e) {
      await closeActiveSession();
      closeServer(staticServer);
      closeServer(collectorServer);
      try { fs.unlinkSync(sessionFile); } catch (_) {}
      if (e && e.__devErr) throw e;
      throw rt.err("UI_EVAL_FAILED", "打开 UI 测试窗口失败: " + String((e && e.message) || e));
    }
  }

  async function devUiEval(cfg) {
    const s = getOpenSession();
    if (!cfg || (!cfg.js && !cfg.lifecycle)) {
      throw rt.err("UI_EVAL_FAILED", "dev_ui_eval 需要提供 js 或 lifecycle 参数");
    }
    const timeoutMs = (cfg && cfg.timeoutMs) || LIMITS.UI_TIMEOUT_DEFAULT;
    const t0 = Date.now();
    const consoleFrom = rt.consoleSeq;
    const callsFrom = rt.callsSeq;

    let script;
    if (cfg.lifecycle) {
      script = "window.__devbridge.trigger(" + JSON.stringify(cfg.lifecycle) + ", " + JSON.stringify(cfg.args || []) + ")";
    } else {
      const awaitPromise = cfg.awaitPromise !== false;
      script = "(async () => { try { let __v = eval(" + JSON.stringify(cfg.js) + "); "
        + (awaitPromise
          ? "if (__v && typeof __v.then === 'function') __v = await __v; return { ok: true, value: __v };"
          : "const __p = __v && typeof __v.then === 'function'; return { ok: true, value: __p ? { __promise: true, note: '未 await 的 Promise' } : __v };")
        + " } catch (e) { return { ok: false, code: 'THROWN', message: String((e && e.stack) || e) }; } })()";
    }

    let guardId;
    let res;
    try {
      const execP = s.win.webContents.executeJavaScript(script, true);
      const guardP = new Promise((_, rej) => {
        guardId = hostTimers.setTimeout(() => rej(rt.err("TIMEOUT", "UI 执行超时(>" + timeoutMs + "ms)")), timeoutMs);
      });
      res = await Promise.race([execP, guardP]);
    } catch (e) {
      await flushSession();
      const outErr = {
        ok: false,
        code: (e && e.__devErr) ? e.code : "UI_EVAL_FAILED",
        message: String((e && e.message) || e),
        durationMs: Date.now() - t0,
        consoleFrom,
        callsFrom,
        consoleTo: rt.consoleSeq,
        callsTo: rt.callsSeq,
      };
      return attachInlineLogs(outErr, rt, consoleFrom, callsFrom, cfg.include, false);
    } finally {
      hostTimers.clearTimeout(guardId);
    }

    await flushSession();

    if (res && res.ok === false) {
      const outFail = {
        ok: false,
        code: res.code || "THROWN",
        message: res.message || "UI 执行异常",
        durationMs: Date.now() - t0,
        consoleFrom,
        callsFrom,
        consoleTo: rt.consoleSeq,
        callsTo: rt.callsSeq,
      };
      return attachInlineLogs(outFail, rt, consoleFrom, callsFrom, cfg.include, false);
    }

    const out = {
      ok: true,
      result: ser(res ? res.value : res, false, { redact: !s.reveal }),
      durationMs: Date.now() - t0,
      consoleFrom,
      callsFrom,
      consoleTo: rt.consoleSeq,
      callsTo: rt.callsSeq,
    };
    return attachInlineLogs(out, rt, consoleFrom, callsFrom, cfg.include, true);
  }

  async function devUiSnapshot(cfg) {
    const s = getOpenSession();
    const opts = {
      selector: (cfg && cfg.selector) || "body",
      maxDepth: (cfg && cfg.maxDepth) || LIMITS.UI_SNAPSHOT_MAX_DEPTH,
      maxNodes: (cfg && cfg.maxNodes) || LIMITS.UI_SNAPSHOT_MAX_NODES,
      includeHidden: !!(cfg && cfg.includeHidden),
    };
    const snap = await s.win.webContents.executeJavaScript(
      "window.__devbridge && window.__devbridge.snapshot ? window.__devbridge.snapshot(" + JSON.stringify(opts) + ") : null"
    );
    if (!snap) throw rt.err("UI_EVAL_FAILED", "页面未注入 __devbridge.snapshot");
    return Object.assign({ ok: true }, snap);
  }

  async function devUiScreenshot(cfg) {
    const s = getOpenSession();
    const shotsDir = path.join(resolveSessionDir(), "devbridge-shots");
    const outPath = (cfg && cfg.outPath)
      ? path.resolve(String(cfg.outPath))
      : path.join(shotsDir, "shot-" + Date.now() + ".png");
    const sameAsShotsDir = process.platform === "win32"
      ? outPath.toLowerCase() === path.resolve(shotsDir).toLowerCase()
      : outPath === path.resolve(shotsDir);
    const outsideShots = isOutsideTarget(shotsDir, outPath) || sameAsShotsDir;
    if (outsideShots && !(cfg && cfg.confirmOutPath === true)) {
      throw rt.err(
        "CONFIRM_REQUIRED",
        "outPath 超出会话截图目录(" + shotsDir + ")，目标路径: " + outPath + "；如确认写入该路径，请显式传 confirmOutPath: true"
      );
    }

    const img = cfg && cfg.rect ? await s.win.capturePage(cfg.rect) : await s.win.capturePage();
    const buf = Buffer.isBuffer(img) ? img : img.toPNG();
    const size = img && typeof img.getSize === "function" ? img.getSize() : { width: null, height: null };
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, buf);

    const out = {
      ok: true,
      path: outPath,
      bytes: buf.length,
      width: size.width,
      height: size.height,
    };
    if (outsideShots) {
      out.outsideSessionDir = true;
      out.riskNotice = "截图已按 confirmOutPath 写入会话目录之外，dev_cleanup 不会自动清理该文件";
    }
    if (cfg && cfg.returnBase64) {
      out.dataUrl = img && typeof img.toDataURL === "function"
        ? img.toDataURL()
        : "data:image/png;base64," + buf.toString("base64");
    }
    return out;
  }

  function cleanupUiArtifacts() {
    const sessionDir = resolveSessionDir();
    const shotsDir = path.join(sessionDir, "devbridge-shots");
    let shotsCleaned = 0;
    if (fs.existsSync(shotsDir)) {
      try {
        shotsCleaned = fs.readdirSync(shotsDir).length;
      } catch (_) {}
      try { fs.rmSync(shotsDir, { recursive: true, force: true }); } catch (_) {}
    }
    const hasActiveWin = !!(rt.uiSession && rt.uiSession.win && (!rt.uiSession.win.isDestroyed || !rt.uiSession.win.isDestroyed()));
    let sessionCleaned = false;
    if (!hasActiveWin) {
      const sessionFile = path.join(sessionDir, "devbridge-ui-session.json");
      if (fs.existsSync(sessionFile)) {
        try {
          fs.unlinkSync(sessionFile);
          sessionCleaned = true;
        } catch (_) {}
      }
    }
    return { shotsCleaned, sessionCleaned };
  }

  async function devUiClose() {
    const closed = await closeActiveSession();
    return { ok: true, closed };
  }

  return {
    devUiOpen,
    devUiEval,
    devUiSnapshot,
    devUiScreenshot,
    devUiClose,
    flushSession,
    cleanupUiArtifacts,
  };
}

module.exports = { createUiTools, needsHttpStaticServer };
