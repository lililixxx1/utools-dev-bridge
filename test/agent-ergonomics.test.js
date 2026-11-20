"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setupBridge } = require("./helpers/mock-utools");

describe("Agent 交互效率：内联现场 / 精简清单 / 默认脱敏 / dev_run / dev_job", () => {
  const ctx = setupBridge({ nativeId: "super-secret-native-id-12345" });
  const fx = path.join(ctx.baseDir, "ergo-plugin");
  fs.mkdirSync(fx, { recursive: true });
  fs.writeFileSync(path.join(fx, "plugin.json"), JSON.stringify({ preload: "preload.js", logo: "logo.png" }));
  fs.writeFileSync(path.join(fx, "preload.js"), [
    '"use strict";',
    'utools.registerTool("long_task", async (params, tctx) => {',
    '  await tctx.sendProgress({ pct: 50, apiToken: "ghp_secret1234567890" });',
    '  await new Promise((r) => setTimeout(r, (params && params.ms) || 80));',
    '  return { done: true, val: params && params.v };',
    '});',
    'window.ergo = {',
    '  okWithLog: () => { console.log("hi-log"); utools.dbStorage.setItem("plainKey", "plainVal"); return { ok: 1 }; },',
    '  failWithCalls: () => { console.warn("warn-1"); utools.dbStorage.setItem("plainKey2", "v"); throw new Error("err-x"); },',
    '  noisy: (n) => { for (let i = 0; i < n; i++) { console.log("line-" + i); utools.dbStorage.getItem("k" + i); } return n; },',
    '  readNative: () => utools.getNativeId(),',
    '  getUserInfo: () => utools.getUser(),',
    '  getApiToken: () => "ghp_raw_secret_token_999999",',
    '  getObjWithSecret: () => ({ name: "pub", apiToken: "tok_abc123", password: "pw1", hotkey: "Alt+Space" }),',
    '  cryptoWrite: (v) => utools.dbCryptoStorage.setItem("vault", v),',
    '  cryptoRead: () => utools.dbCryptoStorage.getItem("vault"),',
    '  kvTokenWrite: (v) => utools.dbStorage.setItem("gh:token", v),',
    '  kvTokenRead: () => utools.dbStorage.getItem("gh:token"),',
    '  spinForever: () => { console.log("before-spin"); while (true) {} },',
    '  quickAsync: () => new Promise((r) => setTimeout(() => { console.log("async-done-log"); r({ items: [{ id: 7 }, { id: 9 }] }); }, 60)),',
    '  asyncFail: () => new Promise((_, rej) => setTimeout(() => rej(new Error("async-fail-msg")), 30)),',
    '};',
  ].join("\n"));

  after(() => ctx.cleanup());

  it("dev_load / dev_list 默认精简 exports 与 exportsHash，verbose:true 展开 preview", async () => {
    const ld0 = await ctx.tools.dev_load({ path: fx });
    assert.equal(ld0.ok, true);
    assert.ok(ld0.exportsCount > 5);
    assert.equal(ld0.exportsHash.length, 12);
    assert.equal(ld0.exports.find((e) => e.name === "ergo.okWithLog").preview, undefined);

    const dl0 = await ctx.tools.dev_list({});
    assert.equal(dl0.exports, undefined);
    assert.equal(dl0.exportsCount, ld0.exportsCount);
    assert.equal(dl0.exportsHash, ld0.exportsHash);

    const dl1 = await ctx.tools.dev_list({ verbose: true });
    assert.ok(Array.isArray(dl1.exports));
    assert.ok(typeof dl1.exports.find((e) => e.name === "ergo.okWithLog").preview === "string");

    const ld1 = await ctx.tools.dev_load({ path: fx, verbose: true });
    assert.ok(typeof ld1.exports.find((e) => e.name === "ergo.okWithLog").preview === "string");
  });

  it("dev_call include 默认策略、显式控制、上限截断、探针过滤与 TIMEOUT 保留调用前游标", async () => {
    await ctx.tools.dev_load({ path: fx });

    // 成功默认仅附非空 console，不附 calls
    const okRes = await ctx.tools.dev_call({ name: "ergo.okWithLog" });
    assert.equal(okRes.ok, true);
    assert.equal(okRes.console.length, 1);
    assert.equal(okRes.calls, undefined);

    // 失败默认附 console + calls
    const failRes = await ctx.tools.dev_call({ name: "ergo.failWithCalls" });
    assert.equal(failRes.ok, false);
    assert.equal(failRes.code, "THROWN");
    assert.ok(failRes.console.some((e) => e.level === "warn"));
    assert.ok(failRes.calls.some((c) => c.api === "utools.dbStorage.setItem"));
    assert.equal(failRes.calls.some((c) => String(c.api).startsWith("probe.")), false);

    // 显式 include: [] 与 include: ["calls"]
    const noInc = await ctx.tools.dev_call({ name: "ergo.okWithLog", include: [] });
    assert.equal(noInc.console, undefined);
    assert.equal(noInc.calls, undefined);
    const onlyCalls = await ctx.tools.dev_call({ name: "ergo.okWithLog", include: ["calls"] });
    assert.equal(onlyCalls.console, undefined);
    assert.ok(onlyCalls.calls.some((c) => c.api === "utools.dbStorage.setItem"));

    // 超 30 条截断标 More
    const noisy = await ctx.tools.dev_call({ name: "ergo.noisy", args: [35], include: ["console", "calls"] });
    assert.equal(noisy.console.length, 30);
    assert.equal(noisy.consoleMore, true);
    assert.equal(noisy.calls.length, 30);
    assert.equal(noisy.callsMore, true);

    // TIMEOUT 同样保留调用前游标并内联调用前打印的 console
    const spun = await ctx.tools.dev_call({ name: "ergo.spinForever", timeoutMs: 300 });
    assert.equal(spun.ok, false);
    assert.equal(spun.code, "TIMEOUT");
    assert.ok(spun.console.some((c) => JSON.stringify(c.args).includes("before-spin")));
    await ctx.tools.dev_cleanup({});
  });

  it("默认凭证脱敏、reveal:true 放行，且 dev_cleanup 还原真实原值", async () => {
    ctx.kvCrypto.set("vault", "OLD_SECRET_VAL");
    ctx.kv.set("gh:token", "OLD_GH_TOKEN");

    await ctx.tools.dev_load({ path: fx });
    // getNativeId 流水条目被脱敏
    const nat = await ctx.tools.dev_call({ name: "ergo.readNative", include: ["calls"] });
    assert.match(nat.calls.find((c) => c.api === "utools.getNativeId").result, /^<redacted len=/);

    // 敏感函数名返回值被脱敏
    const tok = await ctx.tools.dev_call({ name: "ergo.getApiToken" });
    assert.match(tok.result, /^<redacted len=/);

    // 对象敏感字段脱敏，但不误伤 hotkey
    const obj = await ctx.tools.dev_call({ name: "ergo.getObjWithSecret" });
    assert.equal(obj.result.name, "pub");
    assert.equal(obj.result.hotkey, "Alt+Space");
    assert.match(obj.result.apiToken, /^<redacted len=/);
    assert.match(obj.result.password, /^<redacted len=/);

    // dbCryptoStorage 与敏感 kv 读写在流水脱敏，但真实存储与 cleanup 还原保留原值
    await ctx.tools.dev_call({ name: "ergo.cryptoWrite", args: ["NEW_SECRET_VAL"], include: ["calls"] });
    const cRead = await ctx.tools.dev_call({ name: "ergo.cryptoRead", include: ["calls"] });
    assert.match(cRead.calls.find((c) => c.api === "utools.dbCryptoStorage.getItem").result, /^<redacted len=/);
    assert.equal(ctx.kvCrypto.get("vault"), "NEW_SECRET_VAL");

    await ctx.tools.dev_call({ name: "ergo.kvTokenWrite", args: ["NEW_GH_TOKEN"] });
    const kRead = await ctx.tools.dev_call({ name: "ergo.kvTokenRead", include: ["calls"] });
    assert.match(kRead.calls.find((c) => c.api === "utools.dbStorage.getItem").result, /^<redacted len=/);

    await ctx.tools.dev_cleanup({});
    assert.equal(ctx.kvCrypto.get("vault"), "OLD_SECRET_VAL", "cleanup 必须还原真实加密前态");
    assert.equal(ctx.kv.get("gh:token"), "OLD_GH_TOKEN", "cleanup 必须还原真实 kv 前态");

    // reveal:true 时放行原文
    await ctx.tools.dev_load({ path: fx, reveal: true });
    const tokRev = await ctx.tools.dev_call({ name: "ergo.getApiToken" });
    assert.equal(tokRev.result, "ghp_raw_secret_token_999999");
    const natRev = await ctx.tools.dev_call({ name: "ergo.readNative", include: ["calls"] });
    assert.equal(natRev.calls.find((c) => c.api === "utools.getNativeId").result, "super-secret-native-id-12345");
  });

  it("dev_run 批量断言、stopOnFail 跳过与 cleanup:true 自动还原", async () => {
    const r = await ctx.tools.dev_run({
      load: { path: fx },
      steps: [
        {
          label: "写键值并校验流水",
          call: "ergo.okWithLog",
          expect: { ok: true, path: "result.ok", eq: 1, hasCall: "utools.dbStorage.setItem", hasConsole: "hi-log" },
        },
        {
          label: "异步返回值路径数组断言",
          call: "ergo.quickAsync",
          expect: { path: "result.items.1.id", gte: 9, type: "number" },
        },
        {
          label: "预期报错检查",
          call: "ergo.failWithCalls",
          expect: { ok: false, code: "THROWN" },
        },
      ],
      cleanup: true,
    });
    assert.equal(r.ok, true);
    assert.equal(r.passed, 3);
    assert.equal(r.failed, 0);
    assert.equal(r.skipped, 0);
    assert.equal(ctx.kv.has("plainKey"), false, "cleanup:true 自动还原了写入");

    const rStop = await ctx.tools.dev_run({
      steps: [
        { call: "ergo.okWithLog", expect: { path: "result.ok", eq: 999 } },
        { call: "ergo.okWithLog" },
      ],
      stopOnFail: true,
      cleanup: true,
    });
    assert.equal(rStop.ok, false);
    assert.equal(rStop.failed, 1);
    assert.equal(rStop.skipped, 1);
  });

  it("dev_call async:true + dev_job 查询、等待、进度脱敏、取消与不阻塞串口队列", async () => {
    await ctx.tools.dev_load({ path: fx });

    const start = await ctx.tools.dev_call({
      name: "__tool:long_task",
      args: [{ ms: 90, v: "done-ok" }],
      async: true,
    });
    assert.equal(start.ok, true);
    assert.equal(start.async, true);
    assert.equal(start.status, "running");
    assert.ok(start.jobId);

    // 运行中 dev_job 与其他工具均可立即响应而不被阻塞
    const listNow = await ctx.tools.dev_list({});
    assert.equal(listNow.ok, true);

    const finished = await ctx.tools.dev_job({ id: start.jobId, waitMs: 3000 });
    assert.equal(finished.status, "done");
    assert.deepEqual(finished.result, { done: true, val: "done-ok" });
    assert.equal(finished.progress.length, 1);
    assert.match(finished.progress[0].data.apiToken, /^<redacted len=/);

    // 取消任务测试
    const startCancel = await ctx.tools.dev_call({
      name: "__tool:long_task",
      args: [{ ms: 5000, v: "x" }],
      async: true,
    });
    const cancelled = await ctx.tools.dev_job({ id: startCancel.jobId, cancel: true });
    assert.equal(cancelled.status, "cancelled");

    // 异步失败测试
    const startFail = await ctx.tools.dev_call({ name: "ergo.asyncFail", async: true });
    const failed = await ctx.tools.dev_job({ id: startFail.jobId, waitMs: 3000 });
    assert.equal(failed.status, "error");
    assert.equal(failed.code, "THROWN");
    assert.match(failed.message, /async-fail-msg/);

    // 列表与未知 jobId
    const jobsList = await ctx.tools.dev_job({});
    assert.ok(jobsList.jobs.length >= 3);
    const missing = await ctx.tools.dev_job({ id: "job-nope" });
    assert.equal(missing.code, "JOB_NOT_FOUND");
  });
});
