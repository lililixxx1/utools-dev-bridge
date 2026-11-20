"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setupBridge, createDemoPlugin } = require("./helpers/mock-utools");
const { normalizeModuleName, isHostModuleAllowed, formatManifest, hashManifest } = require("../preload/loader");

describe("沙箱核心：加载/调用/冻结不变量/门控/热重载/超时/故障降级", () => {
  const ctx = setupBridge({ nativeId: "selftest-native" });
  const fx = createDemoPlugin(ctx.baseDir);
  const loopFx = path.join(ctx.baseDir, "loop-plugin");
  fs.mkdirSync(path.join(loopFx, "preload"), { recursive: true });
  fs.writeFileSync(path.join(loopFx, "plugin.json"), JSON.stringify({ preload: "preload/index.js" }));
  fs.writeFileSync(path.join(loopFx, "preload", "index.js"), 'window.loop = { spin: () => { while (true) {} } };\n');
  after(() => ctx.cleanup());

  it("纯策略函数（normalizeModuleName / isHostModuleAllowed / formatManifest / hashManifest）", () => {
    assert.equal(normalizeModuleName("node:fs"), "fs");
    assert.equal(isHostModuleAllowed({ allowAllModules: true }, "http"), true);
    assert.equal(isHostModuleAllowed({ allowAllModules: false, allowHostModules: ["node:electron"] }, "electron"), true);
    assert.equal(isHostModuleAllowed({ allowAllModules: false, allowHostModules: [] }, "http"), false);
    const m = [{ name: "a", kind: "function", args: 1, preview: "x => x" }];
    assert.equal(formatManifest(m, false)[0].preview, undefined);
    assert.equal(formatManifest(m, true)[0].preview, "x => x");
    assert.equal(hashManifest(m).length, 12);
  });

  it("基本加载、导出发现、冻结不变量与 stub 验证", async () => {
    const rLoad = await ctx.tools.dev_load({ path: fx });
    assert.equal(rLoad.ok, true);
    assert.ok(rLoad.entry.endsWith("index.js"));
    assert.ok(rLoad.exports.some((e) => e.name === "demo.add" && e.kind === "function"));
    assert.equal((rLoad.events.find((e) => e.api === "utools.onPluginEnter") || {}).count, 1);

    const rAdd = await ctx.tools.dev_call({ name: "demo.add", args: [2, 3] });
    assert.equal(rAdd.ok, true);
    assert.equal(rAdd.result, 5);

    const rNative = await ctx.tools.dev_call({ name: "demo.native" });
    assert.equal(rNative.result, "selftest-native");

    const rHas = await ctx.tools.dev_call({ name: "demo.hasApi", args: ["db"] });
    assert.equal(rHas.result, true);

    const rKeys = await ctx.tools.dev_call({ name: "demo.apiKeys" });
    assert.ok(rKeys.result.includes("db") && rKeys.result.includes("getNativeId"));

    const rClip = await ctx.tools.dev_call({ name: "demo.echoClipboard", args: ["不应写入"] });
    assert.equal(rClip.result.stubbed, true);
    assert.equal(ctx.getClipboard(), undefined);

    const rDbTwice = await ctx.tools.dev_call({ name: "demo.dbTwice" });
    assert.equal(rDbTwice.result, true);

    const rTbl = await ctx.tools.dev_call({ name: "demo.tbl" });
    assert.equal(rTbl.result, "tbl-ok");
  });

  it("Node 内置模块门控、node: 前缀、fetch 门控与 web 全局补齐", async () => {
    const rLoad = await ctx.tools.dev_load({ path: fx });
    assert.ok(rLoad.warnings.some((w) => /child_process|electron/.test(w)));

    const rSpawn = await ctx.tools.dev_call({ name: "demo.spawnEcho" });
    assert.equal(rSpawn.ok, false);
    assert.equal(rSpawn.code, "DENIED_MODULE");
    assert.match(rSpawn.message, /child_process/);

    assert.equal((await ctx.tools.dev_call({ name: "demo.httpTwice" })).result, true);
    assert.equal((await ctx.tools.dev_call({ name: "demo.fsSame" })).result, true);
    assert.equal((await ctx.tools.dev_call({ name: "demo.fsPromisesSame" })).result, true);
    assert.equal((await ctx.tools.dev_call({ name: "demo.sib" })).result, 42);
    assert.equal((await ctx.tools.dev_call({ name: "demo.tp" })).result, "function");

    const calls = await ctx.tools.dev_calls_log({ since: 0 });
    assert.ok(calls.entries.some((e) => e.api === "require:electron.ipcRenderer.on" && e.denied));
    assert.ok(calls.entries.some((e) => String(e.api).startsWith("require:child_process.exec") && e.denied));

    assert.equal((await ctx.tools.dev_call({ name: "demo.hasFetch" })).result, "function");
    const rFetch = await ctx.tools.dev_call({ name: "demo.fetchIt" });
    assert.equal(rFetch.ok, false);
    assert.equal(rFetch.code, "DENIED_FETCH");

    const rWeb = await ctx.tools.dev_call({ name: "demo.webGlobals" });
    assert.ok(rWeb.result.every((t) => t === "function"));

    await ctx.tools.dev_load({ path: fx, allowHostModules: [] });
    const rFetchArr = await ctx.tools.dev_call({ name: "demo.fetchIt" });
    assert.equal(rFetchArr.code, "DENIED_FETCH");
  });

  it("异常、异步、services 级热重载、死循环超时自动重建", async () => {
    await ctx.tools.dev_load({ path: fx });
    const rBoom = await ctx.tools.dev_call({ name: "demo.boom" });
    assert.equal(rBoom.ok, false);
    assert.equal(rBoom.code, "THROWN");
    assert.match(rBoom.message, /boom-test/);

    const rSlow = await ctx.tools.dev_call({ name: "demo.slow", args: [60], timeoutMs: 3000 });
    assert.equal(rSlow.ok, true);
    assert.equal(rSlow.result, "slow-done");

    const rAb = await ctx.tools.dev_call({ name: "demo.asyncBoom" });
    assert.equal(rAb.ok, true);
    await new Promise((r) => setTimeout(r, 40));
    const con = await ctx.tools.dev_console({ since: 0 });
    assert.ok(con.entries.some((e) => e.level === "uncaught" && JSON.stringify(e.args).includes("async-boom-x")));

    // 热重载 services 子模块
    fs.writeFileSync(
      path.join(fx, "services", "math.js"),
      '"use strict";\nconst TAX = 99;\nconst SIB = require("./sibling.js").val;\nmodule.exports = { add: (a, b) => a + b, withTax: (a) => a + TAX, SIB };\n'
    );
    await ctx.tools.dev_load({ path: fx });
    assert.equal((await ctx.tools.dev_call({ name: "demo.withTax", args: [1] })).result, 100);

    // 同步死循环超时 + 沙箱自动重建
    await ctx.tools.dev_load({ path: loopFx, timeoutMs: 2000 });
    const rSpin1 = await ctx.tools.dev_call({ name: "loop.spin", timeoutMs: 600 });
    assert.equal(rSpin1.ok, false);
    assert.equal(rSpin1.code, "TIMEOUT");
    assert.ok(typeof rSpin1.consoleFrom === "number" && typeof rSpin1.callsFrom === "number");

    const dl = await ctx.tools.dev_list({});
    assert.equal(dl.ok, true);
    assert.equal(dl.loaded, true);

    const rSpin2 = await ctx.tools.dev_call({ name: "loop.spin", timeoutMs: 500 });
    assert.equal(rSpin2.code, "TIMEOUT");

    await ctx.tools.dev_load({ path: fx });
    const rNope = await ctx.tools.dev_call({ name: "demo.nope" });
    assert.equal(rNope.ok, false);
    assert.equal(rNope.code, "UNKNOWN_EXPORT");
    assert.match(rNope.message, /demo\.add/);
  });

  it("rt-check 真机回归套件预跑与两阶段清理", async () => {
    const rtPath = path.join(ctx.ROOT, "scripts", "rt-check");
    await ctx.tools.dev_load({ path: rtPath });
    const rRunAll = await ctx.tools.dev_call({ name: "rt.runAll" });
    assert.equal(rRunAll.ok, true);
    assert.equal(rRunAll.result.fail, 0);
    assert.ok(rRunAll.result.total >= 22);

    const rProbe = await ctx.tools.dev_call({ name: "rt.probeHost" });
    assert.match(rProbe.result.nativeIdPrefix, /^selftest/);

    const rTimer = await ctx.tools.dev_call({ name: "rt.timerCheck", timeoutMs: 5000 });
    assert.equal(rTimer.result, "timer-fired");

    const rSched = await ctx.tools.dev_call({ name: "rt.v80ScheduleStub", timeoutMs: 5000 });
    assert.equal(rSched.result, "stubbed+thenable");

    const pa = await ctx.tools.dev_call({ name: "rt.phaseA" });
    const mk = pa.result.marker;
    const pb = await ctx.tools.dev_call({ name: "rt.phaseB", args: [mk] });
    assert.equal(pb.result.fileContent, "NEW");
    await ctx.tools.dev_cleanup({});
    const pc = await ctx.tools.dev_call({ name: "rt.phaseC", args: [mk] });
    assert.equal(pc.result.fileExists, false);
    assert.equal(pc.result.doc, null);
    assert.equal(pc.result.kv, null);
  });

  it("上次目标自动恢复失效时安全降级为未加载并明示原因", async () => {
    const tmpTarget = path.join(ctx.baseDir, "temp-target.js");
    fs.writeFileSync(tmpTarget, '"use strict";\nmodule.exports = { ping: () => "pong" };\n');
    const rLoad = await ctx.tools.dev_load({ path: tmpTarget, mode: "file" });
    assert.equal(rLoad.ok, true);
    fs.rmSync(tmpTarget, { force: true });

    const tools2 = ctx.reloadBridge();
    const dl = await tools2.dev_list({});
    assert.equal(dl.ok, true);
    assert.equal(dl.loaded, false);
    assert.match(dl.lastRestoreFailed, /PATH_NOT_FOUND/);
    const lastKeys = [...ctx.kv.keys()].filter((k) => k.startsWith("devbridge:") && k.endsWith(":last"));
    assert.equal(lastKeys.length, 0);

    const rRecover = await tools2.dev_load({ path: fx });
    assert.equal(rRecover.ok, true);
  });
});
