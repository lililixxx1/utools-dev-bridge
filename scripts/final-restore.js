#!/usr/bin/env node
/**
 * 背靠背网关编排范式示例（适合多步终态核对与清理）：
 *   UTOOLS_MCP_KEY=<key> TARGET_PLUGIN_PATH=<目标插件根目录> ORPHAN_FEED=<feedId> node scripts/final-restore.js
 * 自动经 tools/list 探测开发桥前缀，不再写死插件 ID 与本机路径。
 */
"use strict";

const fs = require("fs");

const TARGET = process.env.TARGET_PLUGIN_PATH || process.argv[2];
const ORPHAN_FEED = process.env.ORPHAN_FEED || process.argv[3];
if (!TARGET || !ORPHAN_FEED) {
  console.error("usage: UTOOLS_MCP_KEY=<key> TARGET_PLUGIN_PATH=<path> ORPHAN_FEED=<id> node scripts/final-restore.js");
  process.exit(2);
}

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
  const key = process.env.UTOOLS_MCP_KEY || process.env.X_MCP_KEY || (srv.headers || {})["x-mcp-key"] || "";
  if (!key) {
    console.error("请设置 UTOOLS_MCP_KEY 或 UTOOLS_MCP_CONFIG");
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
  if (!res.ok) throw new Error(method + " HTTP " + res.status);
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
  const r = await rpc("tools/call", { name: PREFIX + tool, arguments: args });
  const sc = r.structuredContent || {};
  if (sc.ok === false) throw new Error(tool + " ok:false " + JSON.stringify(sc).slice(0, 400));
  return sc;
}

const ok = (cond, label) => {
  console.log((cond ? "PASS" : "FAIL") + ": " + label);
  if (!cond) process.exitCode = 1;
};

(async () => {
  await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "final-restore", version: "0.4.0" } });
  await fetch(url, { method: "POST", headers: Object.assign({}, H, { "Mcp-Session-Id": SID }), body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }).catch(() => {});

  const tl = await rpc("tools/list", {});
  const all = (tl.tools || []).map((t) => String(t.name));
  const cand = all.find((n) => /(?:_|\.)dev_load$/.test(n)) || all.find((n) => n === "dev_load");
  if (!cand) throw new Error("tools/list 里找不到 dev_load");
  PREFIX = cand.slice(0, -"dev_load".length);

  const load = await call("dev_load", { path: TARGET, allowHostModules: ["http", "https"] });
  ok(load.ok === true, "dev_load target");
  const orphans = await call("dev_call", { name: "airss.db.itemsOfFeed", args: [ORPHAN_FEED] });
  ok(Array.isArray(orphans.result), "核对孤儿列表");
  await call("dev_call", { name: "airss.db.retentionClean", args: [{ _id: ORPHAN_FEED }, 0] });
  const drop = await call("dev_cleanup", { dropAll: true });
  ok(drop.dropped === true, "dropAll 生效");
  console.log("== FINAL-RESTORE " + (process.exitCode ? "FAILED" : "ALL PASS") + " ==");
})().catch((e) => {
  console.error("ABORT: " + (e && e.message ? e.message : String(e)));
  process.exit(1);
});
