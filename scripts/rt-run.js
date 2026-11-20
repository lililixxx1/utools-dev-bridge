#!/usr/bin/env node
/**
 * 真机回归一键驱动（单进程背靠背）：
 *   UTOOLS_MCP_KEY=<key> node scripts/rt-run.js [rt-check目录]
 * 自动经 tools/list 探测开发桥工具前缀（8.0 utools_plugin_<id>_<名> / 旧版 utools.<id>.<名>）。
 * 当检测到新版 13 工具（dev_run/dev_job/dev_ui_*）时，优先走 scripts/rt-suite.json 单次批量回归并附带 UI 真窗口与脱敏验证；
 * 若当前 uTools 仍跑旧版 6 工具，则降级跑基础回归并提示重载插件目录。
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const RT = process.argv[2] || path.join(__dirname, "rt-check").replace(/\\/g, "/");
let PREFIX = null;

function loadGatewayConfig() {
  let srv = {};
  const cfgPath = process.env.UTOOLS_MCP_CONFIG;
  if (cfgPath && fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    srv = (cfg.mcpServers && cfg.mcpServers.utools)
      || (((cfg.mcp || {}).servers || {}).utools)
      || ((cfg.mcp || {}).utools)
      || {};
  }
  const url = process.env.UTOOLS_MCP_URL || srv.url || "http://127.0.0.1:3501/mcp";
  let host = "";
  try { host = new URL(url).hostname; } catch (_) {}
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    console.error("refuse non-loopback gateway: " + url);
    process.exit(2);
  }
  const key = process.env.UTOOLS_MCP_KEY || process.env.X_MCP_KEY || (srv.headers || {})["x-mcp-key"] || "";
  if (!key) {
    console.error("未找到鉴权 key：请设置环境变量 UTOOLS_MCP_KEY（从 uTools 设置 → AI Agent 连接复制）或 UTOOLS_MCP_CONFIG");
    process.exit(2);
  }
  return { url, key };
}

const { url, key } = loadGatewayConfig();
const H = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-mcp-key": key };
let nextId = 1;
let SID = null;

async function rpc(method, params) {
  const headers = SID ? Object.assign({}, H, { "Mcp-Session-Id": SID }) : H;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }) });
  if (!res.ok) throw new Error(method + " HTTP " + res.status + (res.status === 403 ? ",网关 key 轮换(请更新 UTOOLS_MCP_KEY)" : ""));
  const sid = res.headers.get("mcp-session-id");
  if (sid) SID = sid;
  const text = await res.text();
  let body = null;
  if (/^(event:|data:)/m.test(text)) {
    const lines = text.split(/\r?\n/).filter((l) => l.startsWith("data:"));
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const o = JSON.parse(lines[i].slice(5).trim());
        if (o && (o.result !== undefined || o.error !== undefined)) { body = o; break; }
      } catch (_) {}
    }
  } else if (text.trim()) {
    body = JSON.parse(text);
  }
  if (!body) throw new Error(method + ": no result");
  if (body.error) throw new Error(method + ": " + JSON.stringify(body.error));
  return body.result;
}

async function call(tool, args) {
  const r = await rpc("tools/call", { name: PREFIX + tool, arguments: args || {} });
  if (r.isError) throw new Error(tool + " isError: " + JSON.stringify(r.content || r).slice(0, 300));
  const sc = r.structuredContent || JSON.parse((r.content && r.content[0] && r.content[0].text) || "{}");
  if (sc.ok === false) throw new Error(tool + " ok:false " + JSON.stringify(sc).slice(0, 500));
  return sc;
}

const ok = (cond, label) => {
  console.log((cond ? "PASS" : "FAIL") + ": " + label);
  if (!cond) process.exitCode = 1;
};

(async () => {
  await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "rt-run", version: "0.4.0" } });
  await fetch(url, { method: "POST", headers: Object.assign({}, H, { "Mcp-Session-Id": SID }), body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }).catch(() => {});

  const tl = await rpc("tools/list", {});
  const all = (tl.tools || []).map((t) => String(t.name));
  const bridgeId = process.env.UTOOLS_BRIDGE_ID || "";
  const devLoadFull = (bridgeId && all.find((n) => n.includes(bridgeId) && /(?:_|\.)dev_load$/.test(n)))
    || all.find((n) => /(?:_|\.)dev_load$/.test(n))
    || all.find((n) => n === "dev_load")
    || null;
  if (!devLoadFull) throw new Error("tools/list 里找不到 dev_load（可能插件未装载或 UTOOLS_MCP_KEY 无效）");
  PREFIX = devLoadFull.slice(0, -"dev_load".length);
  const mine = all.filter((n) => n.startsWith(PREFIX));
  const hasV04 = mine.includes(PREFIX + "dev_run");

  if (hasV04) {
    const want13 = [
      "dev_load", "dev_call", "dev_run", "dev_job", "dev_list", "dev_console", "dev_calls_log", "dev_cleanup",
      "dev_ui_open", "dev_ui_eval", "dev_ui_snapshot", "dev_ui_screenshot", "dev_ui_close",
    ];
    ok(want13.every((w) => mine.includes(PREFIX + w)), "tools/list 13 工具齐全（前缀=" + PREFIX + "）");

    // 1) dev_run 批量运行声明式回归套件
    const suite = JSON.parse(fs.readFileSync(path.join(__dirname, "rt-suite.json"), "utf8"));
    const runRes = await call("dev_run", {
      load: { path: RT },
      steps: suite.steps,
      stopOnFail: suite.stopOnFail,
      cleanup: suite.cleanup,
    });
    const runAllStep = (runRes.steps || [])[0] || {};
    const rr = runAllStep.result || {};
    ok(runRes.ok === true && runRes.passed === suite.steps.length && rr.total >= 22,
      "dev_run 批量回归全绿（steps=" + runRes.passed + "/" + runRes.total + ", rt-check=" + rr.total + "例）");

    // 2) dev_list 终态清零 + 精简摘要
    const dl = await call("dev_list", {});
    ok(dl.exports === undefined && typeof dl.exportsCount === "number" && dl.pendingRestore === undefined && dl.untrackedJournal === undefined,
      "dev_list 默认精简且写日志终态清零（exportsCount=" + dl.exportsCount + "）");

    // 3) dev_call include + 默认脱敏
    const ph = await call("dev_call", { name: "rt.probeHost", include: ["calls"] });
    const nidCall = (ph.calls || []).find((c) => c.api === "utools.getNativeId");
    ok(!nidCall || /^<redacted len=/.test(String(nidCall.result)), "dev_calls_log 默认对敏感调用脱敏");

    // 4) dev_call async + dev_job
    const jobStart = await call("dev_call", { name: "rt.timerCheck", async: true });
    const jobDone = await call("dev_job", { id: jobStart.jobId, waitMs: 5000 });
    ok(jobDone.status === "done" && jobDone.result === "timer-fired", "dev_job 异步完成: " + jobDone.result);

    // 5) dev_ui_* 真窗口端到端（临时 UI 插件）
    const tmpUi = fs.mkdtempSync(path.join(os.tmpdir(), "devbridge-rt-ui-"));
    try {
      fs.writeFileSync(path.join(tmpUi, "plugin.json"), JSON.stringify({
        main: "index.html",
        preload: "preload.js",
        logo: "logo.png",
        features: [{ code: "rtui", cmds: ["rtui"] }],
      }));
      fs.writeFileSync(path.join(tmpUi, "logo.png"), "");
      fs.writeFileSync(path.join(tmpUi, "preload.js"), 'window.rtBridge = { writeKv: (k, v) => utools.dbStorage.setItem(k, v) };\n');
      fs.writeFileSync(path.join(tmpUi, "index.html"), '<!doctype html><html><head><title>RT-UI</title></head><body><h1 id="h">Ready</h1><button id="b" onclick="document.getElementById(\'h\').textContent=\'Done\';window.rtBridge.writeKv(\'_dev_:rtui\',\'1\')">Go</button></body></html>');

      const uiOpen = await call("dev_ui_open", { path: tmpUi });
      ok(uiOpen.ok && uiOpen.title === "RT-UI", "dev_ui_open 窗口加载成功");
      await call("dev_ui_eval", { js: "document.getElementById('b').click()" });
      const snap = await call("dev_ui_snapshot", {});
      ok(snap.ok && /Done/.test(snap.text || ""), "dev_ui_snapshot 捕获交互后 DOM");
      const shot = await call("dev_ui_screenshot", {});
      ok(shot.ok && shot.bytes > 0 && fs.existsSync(shot.path), "dev_ui_screenshot 生成 PNG (" + shot.bytes + "B)");
      try { fs.unlinkSync(shot.path); } catch (_) {}
      await call("dev_ui_close", {});
      const uiClean = await call("dev_cleanup", {});
      ok(uiClean.ok && uiClean.restored.kvDelete >= 1, "dev_cleanup 还原 UI 窗口写副作用");
    } finally {
      fs.rmSync(tmpUi, { recursive: true, force: true });
    }
  } else {
    console.log("NOTE: 网关当前挂载旧版 6 工具桥，执行兼容回归；请在 uTools 开发者工具重载新版仓库以测 13 工具。");
    const want = ["dev_load", "dev_call", "dev_list", "dev_console", "dev_calls_log", "dev_cleanup"];
    ok(want.every((w) => mine.includes(PREFIX + w)), "tools/list 六工具齐全（前缀=" + PREFIX + "）");
    await call("dev_load", { path: RT });
    const ra = await call("dev_call", { name: "rt.runAll", args: [] });
    const rr = ra.result || {};
    ok(rr.fail === 0 && rr.total >= 22, "runAll " + rr.total + " 例全绿(fail=" + rr.fail + ")");
    const cu = await call("dev_cleanup", {});
    ok(cu.ok === true && (cu.failures || []).length === 0, "dev_cleanup 还原零失败");
  }

  console.log("== RT-RUN " + (process.exitCode ? "FAILED" : "ALL PASS") + " ==");
})().catch((e) => {
  console.error("ABORT: " + (e && e.message ? e.message : String(e)));
  process.exit(1);
});
