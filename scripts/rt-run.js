#!/usr/bin/env node
/**
 * 真机回归一键驱动(单进程背靠背,防 uTools 挂起隐藏页;范式同 final-restore.js):
 *   node scripts/rt-run.js [rt-check目录]     # 目录缺省 = <仓库>/scripts/rt-check
 * 步骤:tools/list 核对六工具(顺带探测插件前缀:8.0 为 utools_plugin_<id>_<名>,旧版 utools.<id>.<名>)
 *   → dev_load rt-check → runAll(含 v80 用例)→ probeHost → v80ScheduleStub
 *   → __tool:rt8_probe(合成 ToolContext 端到端)→ dev_cleanup 还原并核对终态为空
 * key 从 ~/.zcode/cli/config.json 读取,只发往本机回环网关,不打印。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const RT = process.argv[2] || path.join(__dirname, "rt-check").replace(/\\/g, "/");
// 插件前缀不写死:initialize 后经 tools/list 探测(8.0 网关改了命名规范)
let PREFIX = null;

const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".zcode", "cli", "config.json"), "utf8"));
const srv = (((cfg.mcp || {}).servers || {})["utools"]) || {};
const url = srv.url || "http://127.0.0.1:3501/mcp";
// 只允许回环地址:key 会随请求发出,不得离开本机
{
  let host = "";
  try { host = new URL(url).hostname; } catch (_) {}
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    console.error("refuse non-loopback gateway: " + url);
    process.exit(2);
  }
}
const key = (srv.headers || {})["x-mcp-key"] || "";
if (!key) { console.error("x-mcp-key not found in config"); process.exit(2); }
const H = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-mcp-key": key };
let nextId = 1, SID = null;

async function rpc(method, params) {
  const headers = SID ? { ...H, "Mcp-Session-Id": SID } : H;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }) });
  const sid = res.headers.get("mcp-session-id"); if (sid) SID = sid;
  const text = await res.text();
  let body = null;
  if (/^event:|data:/.test(text)) {
    const lines = text.split(/\r?\n/).filter((l) => l.startsWith("data:"));
    for (let i = lines.length - 1; i >= 0; i--) {
      try { const o = JSON.parse(lines[i].slice(5).trim()); if (o && (o.result !== undefined || o.error !== undefined)) { body = o; break; } } catch (_) {}
    }
  } else if (text.trim()) body = JSON.parse(text);
  if (!body) throw new Error(method + ": no result");
  if (body.error) throw new Error(method + ": " + JSON.stringify(body.error));
  return body.result;
}
async function call(tool, args) {
  const r = await rpc("tools/call", { name: PREFIX + tool, arguments: args });
  const sc = r.structuredContent || {};
  if (sc.ok === false) throw new Error(tool + " ok:false " + JSON.stringify(sc).slice(0, 500));
  return sc;
}
const ok = (cond, label) => { console.log((cond ? "PASS" : "FAIL") + ": " + label); if (!cond) process.exitCode = 1; };

(async () => {
  await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "rt-run", version: "0.1" } });
  await fetch(url, { method: "POST", headers: { ...H, "Mcp-Session-Id": SID }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }).catch(() => {});

  // 1) tools/list:六工具应全部注册到 MCP;并探测本插件前缀(8.0 下划线/旧版点分隔)
  const tl = await rpc("tools/list", {});
  const all = (tl.tools || []).map((t) => String(t.name));
  const devLoadFull = all.find((n) => n.includes("dev_zii2hjtj") && n.endsWith("dev_load"));
  PREFIX = devLoadFull ? devLoadFull.slice(0, -"dev_load".length) : null;
  if (!PREFIX) throw new Error("tools/list 里找不到本插件的 dev_load(可能插件未装载/网关 key 失效)");
  const mine = all.filter((n) => n.startsWith(PREFIX));
  const want = ["dev_load", "dev_call", "dev_list", "dev_console", "dev_calls_log", "dev_cleanup"];
  ok(want.every((w) => mine.includes(PREFIX + w)), "tools/list 六工具齐全(前缀=" + PREFIX + ",本插件 " + mine.length + " 个,网关共 " + all.length + " 个)");

  // 2) dev_list:桥存活
  const dl = await call("dev_list", {});
  ok(dl.ok === true, "dev_list ok(loaded=" + dl.loaded + ")");

  // 3) dev_load rt-check(rt-check 在 runAll 里才 registerTool,装载时刻 tools 为空是预期)
  const load = await call("dev_load", { path: RT });
  ok(load.ok === true, "dev_load rt-check(exports=" + (load.exports || []).length + ",tools=[" + ((load.tools || []).map((t) => t.name)).join(",") + "])");

  // 4) runAll:全部用例断言全绿(含 v80.events / v80.registerTool)
  const ra = await call("dev_call", { name: "rt.runAll", args: [] });
  const results = (ra.result && ra.result.results) || [];
  const bad = results.filter((r) => !r.pass);
  ok(ra.result && ra.result.fail === 0, "runAll " + ra.result.total + " 例全绿(fail=" + ra.result.fail + ")");
  for (const r of bad) console.log("  FAIL-Detail " + r.name + ": " + r.detail);
  const v80e = results.find((r) => r.name === "v80.events");
  const v80r = results.find((r) => r.name === "v80.registerTool");
  ok(v80e && v80e.pass, "v80.events:onPluginReady/onScheduleTrigger 登记不挂宿主(" + (v80e && v80e.detail) + ")");
  ok(v80r && v80r.pass, "v80.registerTool:处理器捕获");

  // 4b) runAll 之后 tools 清单应出现 rt8_probe(装载期/运行期注册都能被捕获)
  const dl2 = await call("dev_list", {});
  ok((dl2.tools || []).some((t) => t.name === "rt8_probe"),
    "registerTool 捕获:runAll 后 dev_list tools 含 rt8_probe([" + ((dl2.tools || []).map((t) => t.name)).join(",") + "])");

  // 5) probeHost:记录真实运行时版本(8.0 beta / Node 20)
  const ph = await call("dev_call", { name: "rt.probeHost", args: [] });
  ok(ph.result && ph.result.appVersion, "probeHost 返回 appVersion=" + (ph.result && ph.result.appVersion) + " node=" + (ph.result && ph.result.nodeVersion));

  // 6) 8.0 定时 API stub(requestSchedule 保 thenable)
  const sc = await call("dev_call", { name: "rt.v80ScheduleStub", args: [] });
  ok(sc.result === "stubbed+thenable", "v80ScheduleStub:thenable+删除 stub(" + sc.result + ")");

  // 7) __tool:rt8_probe 端到端(合成 ToolContext 注入)
  const tp = await call("dev_call", { name: "__tool:rt8_probe", args: [{ x: 42 }] });
  ok(tp.result && tp.result.got === 42, "__tool:rt8_probe({x:42}) → {got:" + (tp.result && tp.result.got) + "}");

  // 8) 还原:回放写日志,随后核对终态为空
  const cu = await call("dev_cleanup", {});
  const rc2 = (cu.restored || {});
  ok(cu.ok === true, "dev_cleanup 还原(dbRestore=" + rc2.dbRestore + ",dbDelete=" + rc2.dbDelete + ",kvRestore=" + rc2.kvRestore + ",kvDelete=" + rc2.kvDelete + ")");
  const fin = await call("dev_cleanup", {});
  const fr = (fin.restored || {});
  ok((fr.dbRestore + fr.dbDelete + fr.kvRestore + fr.kvDelete) === 0, "写日志终态为空");

  console.log("== RT-RUN " + (process.exitCode ? "FAILED" : "ALL PASS") + " ==");
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error("ABORT: " + (e && e.message ? e.message : String(e))); process.exit(1); });
