#!/usr/bin/env node
/**
 * MCP 网关直连排障脚本（仅本机回环调试用）：
 *   UTOOLS_MCP_KEY=<key> node scripts/gw-call.js <toolName> [jsonArgs]
 * 鉴权读取顺序：UTOOLS_MCP_KEY / X_MCP_KEY → UTOOLS_MCP_CONFIG（JSON 文件内 mcpServers/mcp.servers.utools）。
 * 工具名自动经 tools/list 解析：支持全名或裸名（兼容 8.0 utools_plugin_<id>_<名> 与旧版 utools.<id>.<名>）。
 */
"use strict";

const fs = require("fs");

const tool = process.argv[2];
if (!tool) {
  console.error("usage: UTOOLS_MCP_KEY=<key> node scripts/gw-call.js <toolName> [jsonArgs]");
  process.exit(2);
}

let args = {};
if (process.argv[3]) {
  try {
    args = JSON.parse(process.argv[3]);
  } catch (e) {
    console.error("args JSON parse failed: " + e.message);
    process.exit(2);
  }
}

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
const baseHeaders = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  "x-mcp-key": key,
};
let nextId = 1;

async function rpc(method, params, sessionId) {
  const headers = Object.assign({}, baseHeaders);
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  if (!res.ok) throw new Error(method + " HTTP " + res.status + " " + (await res.text()).slice(0, 300));
  const sid = res.headers.get("mcp-session-id") || sessionId;
  const text = await res.text();
  let body = null;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("text/event-stream") || /^(event:|data:)/m.test(text)) {
    const lines = text.split(/\r?\n/).filter((l) => l.startsWith("data:"));
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const o = JSON.parse(lines[i].slice(5).trim());
        if (o && (o.result !== undefined || o.error !== undefined || o.jsonrpc)) { body = o; break; }
      } catch (_) {}
    }
  } else if (text.trim()) {
    body = JSON.parse(text);
  }
  return { body, sid };
}

(async () => {
  const init = await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "devbridge-gw-call", version: "0.4.0" },
  });
  const sid = init.sid;
  if (!sid) throw new Error("no session id in initialize response");
  await fetch(url, {
    method: "POST",
    headers: Object.assign({}, baseHeaders, { "Mcp-Session-Id": sid }),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  }).catch(() => {});

  const tl = await rpc("tools/list", {}, sid);
  const all = ((tl.body && tl.body.result && tl.body.result.tools) || []).map((t) => String(t.name));
  const bridgeId = process.env.UTOOLS_BRIDGE_ID || "";
  const devLoadFull = (bridgeId && all.find((n) => n.includes(bridgeId) && /(?:_|\.)dev_load$/.test(n)))
    || all.find((n) => /(?:_|\.)dev_load$/.test(n))
    || all.find((n) => n === "dev_load")
    || null;
  const prefix = devLoadFull ? devLoadFull.slice(0, -"dev_load".length) : null;

  const fullTool = all.find((n) => n === tool)
    || (prefix && all.find((n) => n === prefix + tool))
    || all.find((n) => n.endsWith("_" + tool) || n.endsWith("." + tool))
    || null;

  if (!fullTool) {
    console.error("tool '" + tool + "' not found in tools/list (gateway has " + all.length + " tools); utools plugin loaded? name spelled right?");
    process.exit(1);
  }

  const out = await rpc("tools/call", { name: fullTool, arguments: args }, sid);
  if (!out.body || out.body.result === undefined) {
    console.error("GW-FAIL: no result in gateway response");
    process.exit(1);
  }
  if (out.body.error) {
    console.log(JSON.stringify({ rpcError: out.body.error }, null, 2));
    process.exit(1);
  }
  const r = out.body.result || {};
  if (r.isError) {
    console.log(JSON.stringify(r, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(r, null, 2));
})().catch((e) => {
  console.error("GW-FAIL: " + (e && e.message ? e.message : String(e)));
  process.exit(1);
});
