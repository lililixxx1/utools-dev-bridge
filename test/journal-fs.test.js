"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("os");
const { spawnSync } = require("node:child_process");
const { setupBridge, createDemoPlugin } = require("./helpers/mock-utools");

describe("WAL 写日志、fs 还原、NDJSON 迁移与越界写标注", () => {
  const ctx = setupBridge();
  const fx = createDemoPlugin(ctx.baseDir);
  after(() => ctx.cleanup());

  it("db / dbStorage 增删改、bulkDocs 级联防孤儿、dropAll 先杀定时器与覆盖还原", async () => {
    await ctx.tools.dev_load({ path: fx });
    ctx.kv.set("pre:existing", "旧值");
    const kvBefore = ctx.kv.size;
    const dbBefore = ctx.dbDocs.size;

    await ctx.tools.dev_call({ name: "demo.save", args: ["_dev_:k1", "v1"] });
    await ctx.tools.dev_call({ name: "demo.saveDoc", args: ["_dev_:doc1"] });
    await ctx.tools.dev_call({ name: "demo.saveDoc", args: ["pre:doc2"] });
    await ctx.tools.dev_call({ name: "demo.save", args: ["pre:existing", "新值"] });
    assert.equal(ctx.kv.get("_dev_:k1"), "v1");
    assert.equal(ctx.kv.get("pre:existing"), "新值");

    let r = await ctx.tools.dev_cleanup({});
    assert.equal(r.ok, true);
    assert.ok(r.restored.kvRestore >= 1 && r.restored.dbDelete >= 2);
    assert.equal(ctx.kv.size, kvBefore);
    assert.equal(ctx.dbDocs.size, dbBefore);
    assert.equal(ctx.kv.get("pre:existing"), "旧值");

    // remove 前态还原
    ctx.dbDocs.set("keep:doc", { _id: "keep:doc", _rev: "r0", data: "原件" });
    await ctx.tools.dev_call({ name: "demo.removeDoc", args: ["keep:doc"] });
    assert.equal(ctx.dbDocs.has("keep:doc"), false);
    await ctx.tools.dev_cleanup({});
    assert.equal(ctx.dbDocs.get("keep:doc").data, "原件");

    // bulkDocs 新建后级联 remove：回滚后不残留孤儿
    await ctx.tools.dev_call({ name: "demo.bulkCreate", args: [["_dev_:b1", "_dev_:b2"]] });
    await ctx.tools.dev_call({ name: "demo.removeDoc", args: ["_dev_:b1"] });
    await ctx.tools.dev_call({ name: "demo.removeDoc", args: ["_dev_:b2"] });
    await ctx.tools.dev_cleanup({});
    assert.equal(ctx.dbDocs.has("_dev_:b1"), false);
    assert.equal(ctx.dbDocs.has("_dev_:b2"), false);

    // bulk 覆盖既有文档
    ctx.dbDocs.set("pre:bulk", { _id: "pre:bulk", _rev: "r0", data: "原件" });
    await ctx.tools.dev_call({ name: "demo.bulkCreate", args: [["pre:bulk"]] });
    await ctx.tools.dev_cleanup({});
    assert.equal(ctx.dbDocs.get("pre:bulk").data, "原件");
    assert.equal(ctx.dbDocs.get("pre:bulk").src, undefined);

    // 同 id 双写还原
    await ctx.tools.dev_call({ name: "demo.saveTwice", args: ["_dev_:dbl"] });
    await ctx.tools.dev_cleanup({});
    assert.equal(ctx.dbDocs.has("_dev_:dbl"), false);

    // dropAll 跳过回放并先杀目标定时器
    await ctx.tools.dev_call({ name: "demo.saveDoc", args: ["_dev_:keep1"] });
    await ctx.tools.dev_call({ name: "demo.arm", args: [120] });
    r = await ctx.tools.dev_cleanup({ dropAll: true });
    assert.equal(r.dropped, true);
    assert.ok(r.droppedEntries >= 1);
    assert.equal(ctx.dbDocs.has("_dev_:keep1"), true);
    await new Promise((res) => setTimeout(res, 220));
    assert.equal(ctx.dbDocs.has("_dev_:late"), false);
    ctx.dbDocs.delete("_dev_:keep1");
  });

  it("fs 三变体 WAL 还原、流缺省记账、失败回滚与超限分级", async () => {
    await ctx.tools.dev_load({ path: fx });
    const fsx = path.join(ctx.baseDir, "fsx");
    fs.mkdirSync(fsx, { recursive: true });
    fs.writeFileSync(path.join(fsx, "b.txt"), "旧内容");

    await ctx.tools.dev_call({ name: "demo.write", args: [path.join(fsx, "a.txt"), "hello"] });
    await ctx.tools.dev_call({ name: "demo.write", args: [path.join(fsx, "b.txt"), "新内容"] });
    await ctx.tools.dev_call({ name: "demo.writeP", args: [path.join(fsx, "c.txt"), "p"] });
    await ctx.tools.dev_call({ name: "demo.nodeFsWrite", args: [path.join(fsx, "d.txt"), "n"] });
    await ctx.tools.dev_call({ name: "demo.mkdir", args: [path.join(fsx, "sub", "deep")] });
    await ctx.tools.dev_call({ name: "demo.mv", args: [path.join(fsx, "a.txt"), path.join(fsx, "a2.txt")] });
    assert.equal((await ctx.tools.dev_call({ name: "demo.readBack", args: [path.join(fsx, "a2.txt")] })).result, "hello");

    await ctx.tools.dev_call({ name: "demo.stream", args: [path.join(fsx, "s.txt")] });
    await new Promise((res) => setTimeout(res, 60));

    // linkSync 失败回滚，不误删目标
    fs.writeFileSync(path.join(fsx, "src.txt"), "src");
    fs.writeFileSync(path.join(fsx, "dst.txt"), "PRECIOUS");
    const rLn = await ctx.tools.dev_call({ name: "demo.ln", args: [path.join(fsx, "src.txt"), path.join(fsx, "dst.txt")] });
    assert.equal(rLn.ok, false);

    await ctx.tools.dev_call({ name: "demo.mktmp", args: [path.join(fsx, "mk-")] });

    const cu = await ctx.tools.dev_cleanup({});
    assert.ok(cu.restored.fsRestore >= 7);
    assert.equal(fs.existsSync(path.join(fsx, "a2.txt")), false);
    assert.equal(fs.readFileSync(path.join(fsx, "b.txt"), "utf8"), "旧内容");
    assert.equal(fs.existsSync(path.join(fsx, "c.txt")), false);
    assert.equal(fs.existsSync(path.join(fsx, "d.txt")), false);
    assert.equal(fs.existsSync(path.join(fsx, "s.txt")), false);
    assert.equal(fs.existsSync(path.join(fsx, "sub")), false);
    assert.equal(fs.readFileSync(path.join(fsx, "dst.txt"), "utf8"), "PRECIOUS");
    assert.ok(cu.untracked.some((u) => u.startsWith("mkdtemp")));

    // 超限分级：破坏性拒绝，写类 untracked
    const big = path.join(fsx, "big.bin");
    fs.writeFileSync(big, Buffer.alloc(9 * 1024 * 1024, 1));
    const rUnlink = await ctx.tools.dev_call({ name: "demo.unlink", args: [big] });
    assert.equal(rUnlink.code, "DENIED_FS_UNTRACKED");
    assert.equal(fs.existsSync(big), true);

    const rWriteBig = await ctx.tools.dev_call({ name: "demo.write", args: [big, "small"] });
    assert.equal(rWriteBig.ok, true);
    const cu2 = await ctx.tools.dev_cleanup({});
    assert.ok(Array.isArray(cu2.untracked) && cu2.untracked.length >= 1);
  });

  it("越出目标插件根目录的 fs 写标 outside:true 并在 dev_cleanup.outsideWrites 单列", async () => {
    await ctx.tools.dev_load({ path: fx });
    const insidePath = path.join(fx, "inside-tmp.txt");
    const outsidePath = path.join(ctx.baseDir, "outside-written.txt");

    const rIn = await ctx.tools.dev_call({ name: "demo.write", args: [insidePath, "in"], include: ["calls"] });
    assert.equal(rIn.calls.find((c) => c.api === "fs.writeFileSync").outside, undefined);

    const rOut = await ctx.tools.dev_call({ name: "demo.write", args: [outsidePath, "out"], include: ["calls"] });
    assert.equal(rOut.calls.find((c) => c.api === "fs.writeFileSync").outside, true);

    const cu = await ctx.tools.dev_cleanup({});
    assert.ok(Array.isArray(cu.outsideWrites));
    assert.equal(cu.outsideWrites.length, 1);
    assert.equal(cu.outsideWrites[0], outsidePath);
    assert.equal(fs.existsSync(insidePath), false);
    assert.equal(fs.existsSync(outsidePath), false);
  });

  it("NDJSON 增量落盘、旧目录/旧格式迁移、>7 天弃置清空与 1500 次 kv 写性能门槛", async () => {
    await ctx.tools.dev_load({ path: fx });
    await ctx.tools.dev_call({ name: "demo.save", args: ["_dev_:nd1", "a"] });
    await ctx.tools.dev_call({ name: "demo.save", args: ["_dev_:nd2", "b"] });
    await ctx.tools.dev_call({ name: "demo.saveDoc", args: ["_dev_:nd3"] });
    const spillDir = path.join(ctx.localDataDir, "devbridge-spill");
    const ndjson = path.join(spillDir, "journal.ndjson");
    assert.equal(fs.existsSync(ndjson), true);
    const lines = fs.readFileSync(ndjson, "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 3);
    await ctx.tools.dev_cleanup({});
    assert.equal(fs.existsSync(spillDir), false);

    // 旧目录 + 旧 journal.json 迁移回灌
    const migBase = fs.mkdtempSync(path.join(os.tmpdir(), "devbridge-mig-"));
    try {
      const migOld = path.join(migBase, "temp", "devbridge-journal");
      const migNew = path.join(migBase, "plugindata", "devbridge-spill");
      fs.mkdirSync(migOld, { recursive: true });
      fs.writeFileSync(path.join(migOld, "pre-legacy-1.bin"), "PRE");
      fs.writeFileSync(path.join(migOld, "journal.json"), JSON.stringify([
        { kind: "kv", crypto: false, key: "pre:legacy", prev: "旧值", api: "utools.dbStorage.setItem" },
      ]));
      const migScript = [
        '"use strict";',
        'const path = require("path");',
        'const base = process.env.MIG_BASE;',
        'const tools = {};',
        'global.utools = { registerTool: (n, f) => { tools[n] = f; }, getNativeId: () => "mig", getPath: (n) => path.join(base, n), getPluginLocalDataPath: () => path.join(base, "plugindata") };',
        'Object.freeze(global.utools);',
        'require(process.env.BRIDGE_PATH);',
        'tools.dev_list().then((r) => { if (!r.ok || r.pendingRestore !== 1) process.exit(1); console.log("MIG-OK"); });',
      ].join("\n");
      const mig = spawnSync(process.execPath, ["-e", migScript], {
        env: Object.assign({}, process.env, { MIG_BASE: migBase, BRIDGE_PATH: ctx.BRIDGE_ENTRY }),
        encoding: "utf8",
        timeout: 30000,
      });
      assert.equal(mig.status, 0);
      assert.match(mig.stdout, /MIG-OK/);
      assert.equal(fs.existsSync(migOld), false);
      assert.equal(fs.existsSync(path.join(migNew, "pre-legacy-1.bin")), true);
    } finally {
      fs.rmSync(migBase, { recursive: true, force: true });
    }

    // 遗留 >7 天弃置清空
    const staleBase = fs.mkdtempSync(path.join(os.tmpdir(), "devbridge-stale-"));
    try {
      const staleDir = path.join(staleBase, "plugindata", "devbridge-spill");
      fs.mkdirSync(staleDir, { recursive: true });
      fs.writeFileSync(path.join(staleDir, "journal.ndjson"), '{"kind":"kv","key":"old","prev":"v"}\n');
      fs.writeFileSync(path.join(staleDir, "pre-old-1.bin"), "OLD");
      const oldTime = new Date(Date.now() - 8 * 24 * 3600 * 1000);
      fs.utimesSync(path.join(staleDir, "journal.ndjson"), oldTime, oldTime);
      fs.utimesSync(path.join(staleDir, "pre-old-1.bin"), oldTime, oldTime);
      const staleScript = [
        '"use strict";',
        'const fs = require("fs"), path = require("path");',
        'const base = process.env.MIG_BASE;',
        'const tools = {};',
        'global.utools = { registerTool: (n, f) => { tools[n] = f; }, getNativeId: () => "stale", getPath: (n) => path.join(base, n), getPluginLocalDataPath: () => path.join(base, "plugindata") };',
        'Object.freeze(global.utools);',
        'require(process.env.BRIDGE_PATH);',
        'tools.dev_list().then((r) => console.log("STALE:" + JSON.stringify({ wiped: r.spillWiped === true, pending: r.pendingRestore === undefined, dirGone: !fs.existsSync(path.join(base, "plugindata", "devbridge-spill")) })));',
      ].join("\n");
      const stale = spawnSync(process.execPath, ["-e", staleScript], {
        env: Object.assign({}, process.env, { MIG_BASE: staleBase, BRIDGE_PATH: ctx.BRIDGE_ENTRY }),
        encoding: "utf8",
        timeout: 30000,
      });
      const out = JSON.parse((stale.stdout || "").match(/STALE:(\{.*\})/)[1]);
      assert.deepEqual(out, { wiped: true, pending: true, dirGone: true });
    } finally {
      fs.rmSync(staleBase, { recursive: true, force: true });
    }

    // 1500 次 4KB kv 写性能门槛（<1500ms）
    const rPerf = await ctx.tools.dev_call({ name: "demo.perfKvWrites", args: [1500] });
    assert.equal(rPerf.result, 1500);
    assert.ok(rPerf.durationMs < 1500, "perfKvWrites(1500) 耗时 " + rPerf.durationMs + "ms 超过 1500ms");
    await ctx.tools.dev_cleanup({});
    assert.equal(ctx.kv.has("_dev_:perf-1499"), false);
  });
});
