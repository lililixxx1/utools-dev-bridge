"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setupBridge } = require("./helpers/mock-utools");

describe("真窗口 UI 渲染层测试：dev_ui_open / eval / snapshot / screenshot / close + cleanup", () => {
  const ctx = setupBridge();
  const uiPlugin = path.join(ctx.baseDir, "ui-plugin");
  fs.mkdirSync(uiPlugin, { recursive: true });
  fs.writeFileSync(path.join(uiPlugin, "plugin.json"), JSON.stringify({
    main: "index.html",
    preload: "preload.js",
    logo: "logo.png",
    features: [{ code: "ui", cmds: ["ui"] }],
  }));
  fs.writeFileSync(path.join(uiPlugin, "logo.png"), "");
  fs.writeFileSync(path.join(uiPlugin, "preload.js"), [
    '"use strict";',
    'const fs = require("fs");',
    'utools.onPluginReady(() => { console.log("ui-ready"); });',
    'utools.onPluginEnter((a) => { console.log("ui-enter", a && a.code); });',
    'window.uiApi = {',
    '  saveAll: (filePath, val) => {',
    '    utools.db.put({ _id: "_dev_:ui-doc", val });',
    '    utools.dbStorage.setItem("_dev_:ui-kv", val);',
    '    fs.writeFileSync(filePath, val);',
    '    return "saved:" + val;',
    '  },',
    '};',
  ].join("\n"));

  const uiOutFile = path.join(uiPlugin, "ui-output.txt");
  fs.writeFileSync(path.join(uiPlugin, "index.html"), [
    "<!doctype html>",
    `<html><head><title>Test UI Plugin</title><script type="module">window.__esmFlag = 1;</script><script>window.__uiOutFile = ${JSON.stringify(uiOutFile)};</script></head>`,
    "<body>",
    '<h1 id="title">Initial Heading</h1>',
    '<svg id="ico" aria-label="icon"><path d="M0 0" /><circle cx="1" cy="1" r="1" /></svg>',
    '<button id="btn" onclick="document.getElementById(\'title\').textContent=\'Updated\';window.__lastSave=window.uiApi.saveAll(window.__uiOutFile, \'from-ui\')">Save</button>',
    '<div id="secret" hidden>Hidden Text</div>',
    "</body></html>",
  ].join("\n"));

  after(async () => {
    await ctx.tools.dev_ui_close({});
    ctx.cleanup();
  });

  it("自动探测 ESM 启静态服务、enter 触发、eval/snapshot/screenshot、关闭及还原 UI 写副作用", async () => {
    const opened = await ctx.tools.dev_ui_open({
      path: uiPlugin,
      enter: { code: "ui", type: "text", payload: "go", from: "main" },
    });
    assert.equal(opened.ok, true);
    assert.equal(opened.servedVia, "http", "检测到 type=module 自动启回环静态服务");
    assert.equal(opened.title, "Test UI Plugin");
    assert.ok(opened.console.some((c) => JSON.stringify(c.args).includes("ui-ready")));
    assert.ok(opened.console.some((c) => JSON.stringify(c.args).includes("ui-enter")));

    const dl = await ctx.tools.dev_list({});
    assert.equal(dl.ui.open, true);

    const snapBefore = await ctx.tools.dev_ui_snapshot({});
    assert.equal(snapBefore.ok, true);
    assert.match(snapBefore.text, /Initial Heading/);
    assert.match(snapBefore.text, /- svg#ico/);
    assert.equal(/\b(path|circle)\b/.test(snapBefore.text), false, "svg 内部图元收口为叶子节点");
    assert.equal(snapBefore.tree.children.find((c) => c.id === "ico").children, undefined);
    assert.equal(/Hidden Text/.test(snapBefore.text), false, "默认跳过隐藏节点");

    const ev = await ctx.tools.dev_ui_eval({
      js: "document.getElementById('btn').click(); window.__lastSave",
      include: ["calls"],
    });
    assert.equal(ev.ok, true);
    assert.equal(ev.result, "saved:from-ui");
    assert.ok(ev.calls.some((c) => c.api === "utools.db.put"));
    assert.ok(ev.calls.some((c) => c.api === "utools.dbStorage.setItem"));
    assert.ok(ev.calls.some((c) => c.api === "fs.writeFileSync"));
    assert.equal(fs.readFileSync(uiOutFile, "utf8"), "from-ui");
    assert.equal(ctx.dbDocs.get("_dev_:ui-doc").val, "from-ui");
    assert.equal(ctx.kv.get("_dev_:ui-kv"), "from-ui");

    const snapAfter = await ctx.tools.dev_ui_snapshot({});
    assert.match(snapAfter.text, /Updated/);

    const shot = await ctx.tools.dev_ui_screenshot({ returnBase64: true });
    assert.equal(shot.ok, true);
    assert.ok(shot.bytes > 0 && fs.existsSync(shot.path));
    assert.match(shot.dataUrl, /^data:image\/png;base64,/);

    // 传出会话目录外 outPath 未传 confirmOutPath:true 时拒绝，且不创建目录/文件
    const outsideShot = path.join(ctx.baseDir, "outside-shot-dir", "shot.png");
    const shotBlocked = await ctx.tools.dev_ui_screenshot({ outPath: outsideShot });
    assert.equal(shotBlocked.ok, false);
    assert.equal(shotBlocked.code, "CONFIRM_REQUIRED");
    assert.equal(fs.existsSync(path.dirname(outsideShot)), false);

    // 显式传 confirmOutPath:true 时允许写入并标记 outsideSessionDir
    const shotOutsideOk = await ctx.tools.dev_ui_screenshot({ outPath: outsideShot, confirmOutPath: true });
    assert.equal(shotOutsideOk.ok, true);
    assert.equal(shotOutsideOk.outsideSessionDir, true);
    assert.equal(fs.existsSync(outsideShot), true);

    // 高危开关未二次确认时，dev_ui_open 返回 CONFIRM_REQUIRED 且不销毁已打开窗口
    const uiRiskBlocked = await ctx.tools.dev_ui_open({ path: uiPlugin, allowSideEffects: true });
    assert.equal(uiRiskBlocked.ok, false);
    assert.equal(uiRiskBlocked.code, "CONFIRM_REQUIRED");
    assert.equal((await ctx.tools.dev_list({})).ui.open, true);

    const closed = await ctx.tools.dev_ui_close({});
    assert.equal(closed.ok, true);
    assert.equal(closed.closed, true);
    const closedAgain = await ctx.tools.dev_ui_close({});
    assert.equal(closedAgain.closed, false);

    // 模拟异常中断遗留的 devbridge-ui-session.json；dev_cleanup 应连同 devbridge-shots 一起清理
    const sessionFile = path.join(ctx.localDataDir, "devbridge-ui-session.json");
    const shotsDir = path.join(ctx.localDataDir, "devbridge-shots");
    fs.writeFileSync(sessionFile, JSON.stringify({ stale: true }));
    assert.equal(fs.existsSync(shotsDir), true);

    // dev_cleanup 必须一并还原 UI 窗口产生的 db/kv/fs 写，并清理 shots 与残留会话文件
    const cu = await ctx.tools.dev_cleanup({});
    assert.equal(cu.ok, true);
    assert.equal(cu.restored.dbDelete >= 1, true);
    assert.equal(cu.restored.kvDelete >= 1, true);
    assert.equal(cu.restored.fsRestore >= 1, true);
    assert.equal(cu.restored.uiShotsCleaned >= 1, true);
    assert.equal(cu.restored.uiSessionCleaned, 1);
    assert.equal(fs.existsSync(shotsDir), false);
    assert.equal(fs.existsSync(sessionFile), false);
    assert.equal(fs.existsSync(uiOutFile), false);
    assert.equal(ctx.dbDocs.has("_dev_:ui-doc"), false);
    assert.equal(ctx.kv.has("_dev_:ui-kv"), false);

    // 确认 confirmRisk:true 时 dev_ui_open 可放行高危开关并返回 riskNotice；活跃窗口打开时 dev_cleanup 不误删活跃会话文件
    const uiRiskOk = await ctx.tools.dev_ui_open({ path: uiPlugin, reveal: true, confirmRisk: true });
    assert.equal(uiRiskOk.ok, true);
    assert.ok(Array.isArray(uiRiskOk.riskNotice) && uiRiskOk.riskNotice.length === 1);
    const shotDuringActive = await ctx.tools.dev_ui_screenshot({});
    assert.equal(shotDuringActive.ok, true);
    const cuActive = await ctx.tools.dev_cleanup({});
    assert.equal(cuActive.restored.uiShotsCleaned >= 1, true);
    assert.equal(cuActive.restored.uiSessionCleaned, 0);
    assert.equal(fs.existsSync(sessionFile), true, "活跃窗口未关闭时不应删除会话文件");
    await ctx.tools.dev_ui_close({});
  });

  it("未打开窗口调用 eval/snapshot/screenshot 报 UI_NOT_OPEN；无 CreateBrowserWindow 报 UI_UNAVAILABLE", async () => {
    const rEval = await ctx.tools.dev_ui_eval({ js: "1+1" });
    assert.equal(rEval.code, "UI_NOT_OPEN");
    const rSnap = await ctx.tools.dev_ui_snapshot({});
    assert.equal(rSnap.code, "UI_NOT_OPEN");

    const prevUtools = global.utools;
    const noUiCtx = setupBridge({ withBrowserWindow: false });
    try {
      const rOpen = await noUiCtx.tools.dev_ui_open({ path: uiPlugin });
      assert.equal(rOpen.code, "UI_UNAVAILABLE");
    } finally {
      noUiCtx.cleanup();
      global.utools = prevUtools;
    }
  });
});
