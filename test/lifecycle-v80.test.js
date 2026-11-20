"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setupBridge, createDemoPlugin } = require("./helpers/mock-utools");

describe("生命周期触发、8.0 registerTool 与多回调顺序 await", () => {
  const ctx = setupBridge();
  const fx = createDemoPlugin(ctx.baseDir);
  after(() => ctx.cleanup());

  it("基础生命周期（__enter/__out/__mainPush/__mainPushSelect/__dbPull/__domReady）与 DOM stub", async () => {
    await ctx.tools.dev_load({ path: fx });

    const dp = await ctx.tools.dev_call({ name: "demo.domProbe" });
    assert.equal(dp.result.byId, null);
    assert.equal(dp.result.q, null);
    assert.equal(dp.result.qall, 0);
    assert.equal(dp.result.children, 1);
    assert.equal(dp.result.tag, "DIV");

    await ctx.tools.dev_call({ name: "demo.domListen" });
    const dr = await ctx.tools.dev_call({ name: "__domReady" });
    assert.equal(dr.ok, true);
    assert.ok(dr.console.some((e) => JSON.stringify(e.args).includes("dom-ready-cb")));

    const en = await ctx.tools.dev_call({ name: "__enter", args: [{ code: "demo", type: "text", payload: "hi", from: "main" }] });
    assert.equal(en.ok, true);
    assert.ok(en.console.some((e) => JSON.stringify(e.args).includes("enter")));

    const out = await ctx.tools.dev_call({ name: "__out", args: [true] });
    assert.equal(out.ok, true);
    assert.ok(out.console.some((e) => JSON.stringify(e.args).includes("out-cb") && JSON.stringify(e.args).includes("true")));

    const mp = await ctx.tools.dev_call({ name: "__mainPush", args: [{ code: "c1", type: "text", payload: "p" }] });
    assert.equal(mp.ok, true);
    assert.ok(mp.console.some((e) => JSON.stringify(e.args).includes("push-cb")));

    const mps = await ctx.tools.dev_call({ name: "__mainPushSelect", args: [{ code: "c1", type: "text", payload: "p", option: { text: "picked" } }] });
    assert.equal(mps.ok, true);
    assert.equal(mps.result, true);
    assert.ok(mps.console.some((e) => JSON.stringify(e.args).includes("picked")));

    const dbp = await ctx.tools.dev_call({ name: "__dbPull" });
    assert.equal(dbp.ok, false);
    assert.equal(dbp.code, "UNKNOWN_EXPORT");
  });

  it("8.0 onPluginReady / onScheduleTrigger / registerTool / requestSchedule thenable stub / null 原型防注入", async () => {
    const ld = await ctx.tools.dev_load({ path: fx });
    assert.ok(ld.events.some((e) => e.api === "utools.onPluginReady"));
    assert.ok(ld.events.some((e) => e.api === "utools.onScheduleTrigger"));
    assert.ok(ld.events.some((e) => e.api === "utools.onMainPush:select"));
    assert.ok(ld.tools.some((t) => t.name === "say_hi"));
    assert.ok(!ld.tools.some((t) => t.name === "bad_handler"));
    assert.ok(ld.warnings.some((w) => /bad_handler/.test(w)));

    const rr = await ctx.tools.dev_call({ name: "__ready" });
    assert.ok(rr.console.some((e) => JSON.stringify(e.args).includes("ready-cb")));

    const sc = await ctx.tools.dev_call({ name: "__schedule", args: [{ code: "drink-water" }] });
    assert.ok(sc.console.some((e) => JSON.stringify(e.args).includes("drink-water")));

    const th = await ctx.tools.dev_call({ name: "__tool:say_hi", args: [{ text: "hi8" }] });
    assert.equal(th.result.echo, "hi8");
    assert.equal(th.result.hasCtx, true);

    const tNope = await ctx.tools.dev_call({ name: "__tool:nope" });
    assert.equal(tNope.code, "UNKNOWN_EXPORT");
    assert.match(tNope.message, /say_hi/);

    ctx.resetSchedCounts();
    assert.equal((await ctx.tools.dev_call({ name: "demo.armSchedule" })).result.stubbed, true);
    assert.equal((await ctx.tools.dev_call({ name: "demo.dropSchedule" })).result.stubbed, true);
    assert.deepEqual(ctx.getSchedCounts(), { asked: 0, removed: 0 });
    assert.equal((await ctx.tools.dev_call({ name: "demo.armScheduleThen" })).result, true);

    assert.equal((await ctx.tools.dev_call({ name: "__tool:__proto__" })).code, "UNKNOWN_EXPORT");
    assert.equal((await ctx.tools.dev_call({ name: "__tool:constructor" })).code, "UNKNOWN_EXPORT");
  });

  it("多生命周期回调顺序执行并逐个 await 返回数组", async () => {
    const multiJs = path.join(ctx.baseDir, "multi-lc.js");
    fs.writeFileSync(multiJs, [
      '"use strict";',
      'const order = [];',
      'utools.onPluginReady(() => new Promise((r) => setTimeout(() => { order.push("first"); r("r1"); }, 35)));',
      'utools.onPluginReady(async () => { order.push("second"); return "r2"; });',
      'utools.onDbPull((docs) => docs.length);',
      'window.getOrder = () => order;',
    ].join("\n"));

    await ctx.tools.dev_load({ path: multiJs, mode: "file" });
    const r = await ctx.tools.dev_call({ name: "__ready" });
    assert.equal(r.ok, true);
    assert.deepEqual(r.result, ["r1", "r2"]);
    assert.deepEqual((await ctx.tools.dev_call({ name: "getOrder" })).result, ["first", "second"]);

    const dp = await ctx.tools.dev_call({ name: "__dbPull", args: [[{ _id: "d1" }, { _id: "d2" }]] });
    assert.equal(dp.result, 2);
  });
});
