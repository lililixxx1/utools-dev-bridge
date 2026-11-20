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

    const closed = await ctx.tools.dev_ui_close({});
    assert.equal(closed.ok, true);
    assert.equal(closed.closed, true);
    const closedAgain = await ctx.tools.dev_ui_close({});
    assert.equal(closedAgain.closed, false);

    // dev_cleanup 必须一并还原 UI 窗口产生的 db/kv/fs 写
    const cu = await ctx.tools.dev_cleanup({});
    assert.equal(cu.ok, true);
    assert.equal(cu.restored.dbDelete >= 1, true);
    assert.equal(cu.restored.kvDelete >= 1, true);
    assert.equal(cu.restored.fsRestore >= 1, true);
    assert.equal(fs.existsSync(uiOutFile), false);
    assert.equal(ctx.dbDocs.has("_dev_:ui-doc"), false);
    assert.equal(ctx.kv.has("_dev_:ui-kv"), false);
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
