#!/usr/bin/env node
/**
 * 一次性终态还原(孤儿清除):适合桥渲染页易被 uTools 挂起的场景,单进程背靠背完成全部步骤。
 * 前提:dev_cleanup 回放已做过(db 仅剩 feed:7a8d0aff 下的 3 item + 3 itemfull 孤儿)。
 * 步骤:dev_load airss → 核对孤儿清单 → retentionClean(feed:7a8d,0) → 核对全空 → dev_cleanup{dropAll} → 终态汇报
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ORPHAN_FEED = "feed:7a8d0aff-51b9-4494-bc2f-6f487cbe04b8";
// 插件前缀不写死:8.0 网关为 utools_plugin_dev_zii2hjtj_<名>(下划线),旧版为 utools.dev_zii2hjtj.<名>;
// initialize 后经 tools/list 探测(见下方 main 里 PREFIX 赋值)
let PREFIX = null;

const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".zcode", "cli", "config.json"), "utf8"));
const srv = (((cfg.mcp || {}).servers || {})["utools"]) || {};
const url = srv.url || "http://127.0.0.1:3501/mcp";
const key = (srv.headers || {})["x-mcp-key"] || "";
const H = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-mcp-key": key };
let nextId = 1, SID = null;

async function rpc(method, params) {
  const headers = SID ? { ...H, "Mcp-Session-Id": SID } : H;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }) });
  const sid = res.headers.get("mcp-session-id"); if (sid) SID = sid;
  const text = await res.text();
  let body = null;
  if (/^(event:|data:)/m.test(text)) {
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
  if (sc.ok === false) throw new Error(tool + " ok:false " + JSON.stringify(sc).slice(0, 400));
  return sc;
}
const ok = (cond, label) => { console.log((cond ? "PASS" : "FAIL") + ": " + label); if (!cond) process.exitCode = 1; };

(async () => {
  await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "final-restore", version: "0.1" } });
  await fetch(url, { method: "POST", headers: { ...H, "Mcp-Session-Id": SID }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }).catch(() => {});
  {
    const tl = await rpc("tools/list", {});
    const cand = ((tl.tools) || []).map((t) => String(t.name)).find((n) => n.includes("dev_zii2hjtj") && n.endsWith("dev_load"));
    if (!cand) throw new Error("tools/list 里找不到本插件的 dev_load(插件未装载或网关 key 失效)");
    PREFIX = cand.slice(0, -"dev_load".length);
  }

  const t0 = Date.now();
  const load = await call("dev_load", { path: "C:/Users/Administrator/Desktop/ccc/ccc/airss", allowHostModules: ["http", "https"] });
  ok(load.ok === true, "dev_load airss(" + (Date.now() - t0) + "ms)");

  const orphans = await call("dev_call", { name: "airss.db.itemsOfFeed", args: [ORPHAN_FEED] });
  const items = orphans.result || [];
  ok(items.length === 3, "孤儿 item 数=3(实际 " + items.length + "): " + items.map((i) => i._id.slice(-12)).join(","));

  const feeds0 = await call("dev_call", { name: "airss.db.getFeeds", args: [] });
  ok((feeds0.result || []).length === 0, "孤儿核对前 feed 列表为空");

  const rc = await call("dev_call", { name: "airss.db.retentionClean", args: [{ _id: ORPHAN_FEED }, 0] });
  ok(rc.result === 3, "retentionClean 删除 3 篇(返回 " + rc.result + ";连带 itemfull 级联)");

  const feeds1 = await call("dev_call", { name: "airss.db.getFeeds", args: [] });
  const items1 = await call("dev_call", { name: "airss.db.itemsOfFeed", args: [ORPHAN_FEED] });
  const snap = await call("dev_call", { name: "airss.db.snapshotItems", args: [] });
  ok((feeds1.result || []).length === 0 && (items1.result || []).length === 0 && (snap.result || []).length === 0,
    "终态 db 全空(feeds=" + (feeds1.result || []).length + ",孤儿=" + (items1.result || []).length + ",snapshot=" + (snap.result || []).length + ")");

  const drop = await call("dev_cleanup", { dropAll: true });
  ok(drop.dropped === true && drop.droppedEntries >= 1, "dropAll 生效(丢弃 " + drop.droppedEntries + " 条,现场保持)");

  const fin = await call("dev_cleanup", {});
  ok(fin.ok === true && fin.restored && (fin.restored.dbRestore + fin.restored.dbDelete + fin.restored.kvRestore + fin.restored.kvDelete) === 0,
    "写日志终态为空");
  console.log("== FINAL-RESTORE " + (process.exitCode ? "FAILED" : "ALL PASS") + " ==");
})().catch((e) => { console.error("ABORT: " + (e && e.message ? e.message : String(e))); process.exit(1); });
