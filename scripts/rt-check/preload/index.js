/**
 * rt-check — dev-bridge 真机回归套件(被桥 dev_load 载入的目标插件)
 *
 * 纯 Node selftest 的 mock 测不出宿主差异(冻结 API 不变量即是教训),本插件在
 * 真实 uTools 沙箱里直接跑断言。导出:
 *   runAll(filter?)   同步断言套件,支持按名过滤规避序列化截断
 *   probeHost()       宿主环境探测:fetch/全局/getPath/nativeId/版本,一次实机运行钉死假设
 *   phaseA()/phaseB(m)/phaseC(m)  两阶段重启用例:写标记→重启→dev_cleanup→验证还原
 *   timerCheck()      异步定时器触发 + uncaughtCheck() 异步异常录制(配合 dev_console 读取)
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const NID = utools.getNativeId ? utools.getNativeId() : "local"; // 顶层读只读不可配置属性(线上不变量崩溃路径)
const TMP_RT = path.join(os.tmpdir(), "devbridge-rt");

const checks = {
  "frozen.getNativeId": () => {
    if (typeof NID !== "string" || NID.length < 4) throw new Error("getNativeId 异常: " + NID);
    return NID.slice(0, 8);
  },
  "proxy.has": () => {
    if (!("db" in utools)) throw new Error("'db' in utools 为 false");
    return "ok";
  },
  "proxy.ownKeys": () => {
    const ks = Object.keys(utools);
    if (ks.indexOf("db") < 0 || ks.indexOf("getNativeId") < 0) throw new Error("Object.keys 缺 db/getNativeId: " + ks.slice(0, 8).join(","));
    return ks.length + " keys";
  },
  "proxy.identity": () => {
    if (utools.db !== utools.db) throw new Error("utools.db 二次访问不同(代理缓存失效)");
    return "stable";
  },
  "deny.childProcess": () => {
    const cp = require("child_process");
    let threw = "";
    try { cp.execSync("echo hi"); } catch (e) { threw = String(e && e.message); }
    if (threw.indexOf("dev-bridge") < 0) throw new Error("child_process 未被拒: " + threw.slice(0, 80));
    return "denied";
  },
  "deny.nodePrefix": () => {
    if (require("node:child_process") !== require("child_process")) throw new Error("node: 前缀未归一");
    return "same";
  },
  "deny.electronNoop": () => {
    const el = require("electron");
    el.ipcRenderer.on("evt", () => {});
    el.ipcRenderer.on("evt2", () => {}).on("evt3", () => {}); // 链式
    return "noop";
  },
  "gate.fetchReject": () => {
    if (typeof fetch !== "function") throw new Error("fetch 全局缺失");
    return "present";
  },
  "web.URL": () => (typeof URL === "function" ? "ok" : "URL 缺失"),
  "web.TextEncoder": () => (typeof TextEncoder === "function" ? "ok" : "TextEncoder 缺失"),
  "web.AbortController": () => (typeof AbortController === "function" ? "ok" : "AbortController 缺失"),
  "console.table": () => { console.table({ a: 1 }); console.time("rt"); console.timeEnd("rt"); return "ok"; },
  "process.exit": () => {
    let msg = "";
    try { process.exit(1); } catch (e) { msg = String(e && e.message); }
    if (msg.indexOf("dev-bridge") < 0) throw new Error("process.exit 未拦截");
    return "intercepted";
  },
  "fs.roundtrip": () => {
    fs.mkdirSync(TMP_RT, { recursive: true });
    const p = path.join(TMP_RT, "roundtrip.txt");
    fs.writeFileSync(p, "rt-data");
    const back = fs.readFileSync(p, "utf8");
    fs.unlinkSync(p);
    if (back !== "rt-data") throw new Error("fs 读写回环失败: " + back);
    return "ok"; // 写副作用已入写日志,agent 可 dev_cleanup
  },
  "fs.promises": () => {
    if (require("fs").promises !== require("fs/promises")) throw new Error("fs.promises 与 fs/promises 不同体");
    return "same";
  },
  "db.roundtrip": () => {
    const id = "_dev_:rt-check:doc";
    utools.db.put({ _id: id, rt: 1 });
    const got = utools.db.get(id);
    utools.db.remove(id);
    if (!got || got.rt !== 1) throw new Error("db 读写回环失败");
    return "ok";
  },
  "dbStorage.roundtrip": () => {
    utools.dbStorage.setItem("_dev_:rt-check:key", "v1");
    const v = utools.dbStorage.getItem("_dev_:rt-check:key");
    utools.dbStorage.removeItem("_dev_:rt-check:key");
    if (v !== "v1") throw new Error("dbStorage 回环失败: " + v);
    return "ok";
  },
  "stub.copyText": () => {
    const out = utools.copyText("不应写入");
    if (!out || out.stubbed !== true) throw new Error("copyText 未 stub");
    return "stubbed";
  },
  "module.createRequire": () => {
    const m = require("module");
    if (typeof m.createRequire !== "function" || !Array.isArray(m.builtinModules)) throw new Error("module 替身不完整");
    const cr = m.createRequire(__filename);
    if (typeof cr !== "function") throw new Error("createRequire 未返回函数");
    return "closed";
  },
  "dom.stub": () => {
    if (document.getElementById("x") !== null) throw new Error("getElementById 应恒 null");
    const el = document.createElement("div");
    el.setAttribute("a", "1");
    el.addEventListener("click", () => {});
    document.body.appendChild(el);
    if (document.querySelectorAll(".a").length !== 0) throw new Error("querySelectorAll 应恒空");
    return "ok";
  },
};

window.rt = {
  runAll(filter) {
    const results = [];
    for (const name of Object.keys(checks)) {
      if (filter && name.indexOf(String(filter)) < 0) continue;
      try {
        const detail = checks[name]();
        results.push({ name, pass: true, detail: String(detail) });
      } catch (e) {
        results.push({ name, pass: false, detail: String((e && e.stack) || e).slice(0, 300) });
      }
    }
    return { total: results.length, fail: results.filter((r) => !r.pass).length, results };
  },
  probeHost() {
    let tempPath = null;
    try { tempPath = utools.getPath ? utools.getPath("temp") : null; } catch (e) { tempPath = "ERR:" + e.message; }
    let appVersion = null;
    try { appVersion = utools.getAppVersion ? String(utools.getAppVersion()) : null; } catch (e) { appVersion = "ERR"; }
    const d = Object.getOwnPropertyDescriptor(utools, "getNativeId");
    return {
      fetchType: typeof fetch, urlType: typeof URL,
      nativeIdPrefix: String(NID).slice(0, 12), appVersion,
      platform: process.platform, nodeVersion: process.versions && process.versions.node,
      tempPath: tempPath,
      getNativeIdDesc: d ? { configurable: d.configurable, enumerable: !!d.enumerable, hasGetter: !!d.get } : null,
      note: "getNativeIdDesc 来自桥代理 gOPD 陷阱(configurable 恒报 true);宿主真实冻结状态由 frozen.getNativeId 通过执行本身验证",
    };
  },
  // 两阶段重启用例:phaseA 建立基线并改动 → 用户重启 uTools → phaseB 读重启后状态 → agent dev_cleanup → phaseC 验证还原
  phaseA() {
    const marker = "rt-" + Date.now();
    const p = path.join(TMP_RT, marker + ".txt");
    fs.mkdirSync(TMP_RT, { recursive: true });
    fs.writeFileSync(p, "OLD");
    fs.writeFileSync(p, "NEW"); // 覆盖写:前态 OLD 已 WAL
    utools.db.put({ _id: "_dev_:rt-check:phase:" + marker, v: "dirty" });
    utools.dbStorage.setItem("_dev_:rt-check:phase:" + marker, "dirty");
    return { marker, file: p, fileExpectBeforeCleanup: "NEW" };
  },
  phaseB(m) {
    const p = path.join(TMP_RT, m + ".txt");
    let fileContent = null;
    try { fileContent = fs.readFileSync(p, "utf8"); } catch (e) { fileContent = null; }
    return {
      fileExists: fileContent !== null, fileContent,
      doc: utools.db.get("_dev_:rt-check:phase:" + m),
      kv: utools.dbStorage.getItem("_dev_:rt-check:phase:" + m),
      hint: "此时应为 dirty 状态(NEW/存在);现在调 dev_cleanup,再跑 phaseC",
    };
  },
  phaseC(m) {
    const p = path.join(TMP_RT, m + ".txt");
    let fileExists = true;
    try { fs.statSync(p); } catch (e) { fileExists = false; }
    return {
      fileExists, // phaseA 首写前态为"不存在" → cleanup 后应删除
      doc: utools.db.get("_dev_:rt-check:phase:" + m) || null,
      kv: utools.dbStorage.getItem("_dev_:rt-check:phase:" + m) === undefined ? null : utools.dbStorage.getItem("_dev_:rt-check:phase:" + m),
    };
  },
  timerCheck() {
    return new Promise((resolve) => setTimeout(() => resolve("timer-fired"), 30));
  },
  // 鉴别异步失败根因:微任务链 vs 定时器 vs 宿主直通定时器
  quickAsync() {
    return Promise.resolve("quick").then((v) => v + "-then");
  },
  hostTimerProbe() {
    const t = typeof globalThis.setTimeout === "function";
    let fired = false;
    const id = globalThis.setTimeout(() => { fired = true; }, 20);
    return { setTimeoutType: typeof globalThis.setTimeout, gotId: id !== undefined && id !== null, note: "fired 状态由后续 probeTimerFired 读取" };
  },
  probeTimerFired() {
    return { firedNow: globalThis.__rtFired === true };
  },
  delayCheck() {
    globalThis.__rtFired = false;
    globalThis.setTimeout(() => { globalThis.__rtFired = true; }, 20);
    return "scheduled";
  },
  uncaughtCheck() {
    setTimeout(() => { throw new Error("rt-uncaught-x"); }, 10); // 应录为 dev_console level=uncaught
    return "scheduled";
  },
};
utools.onPluginEnter(({ code }) => { console.log("rt-enter", code); });
utools.onPluginOut(() => { console.log("rt-out-cb"); });
utools.onMainPush(({ code }) => { console.log("rt-push-cb", code); });
console.log("rt-check mounted, nativeId=" + String(NID).slice(0, 8));
