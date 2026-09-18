#!/usr/bin/env node
/**
 * MCP 网关直连排障脚本(仅本机调试用):
 *   node gw-call.js <toolName> [jsonArgs]
 * key 从 ~/.zcode/cli/config.json (mcp.servers["utools"].headers["x-mcp-key"]) 读取,只发往本机网关,不打印。
 * 用途:绕过 MCP 客户端侧缓存的旧 inputSchema(如 allowHostModules 未出现在会话 schema 时)。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const tool = process.argv[2];
if (!tool) {
  console.error("usage: node gw-call.js <toolName> [jsonArgs]");
  process.exit(2);
}
// 网关侧工具名带 utools.<pluginId>. 前缀;裸名自动补 dev 桥前缀
const fullTool = tool.includes(".") ? tool : "utools.dev_zii2hjtj." + tool;
let args = {};
if (process.argv[3]) {
  try {
    args = JSON.parse(process.argv[3]);
  } catch (e) {
    console.error("args JSON parse failed: " + e.message);
    process.exit(2);
  }
}

const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".zcode", "cli", "config.json"), "utf8"));
const srv = (((cfg.mcp || {}).servers || {})["utools"]) || ((cfg.mcp || {})["utools"]) || {};
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
const key = (srv.headers || {})["x-mcp-key"] || process.env.X_MCP_KEY || "";
if (!key) {
  console.error("x-mcp-key not found in config");
  process.exit(2);
}

const baseHeaders = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  "x-mcp-key": key,
};

let nextId = 1;

async function rpc(method, params, sessionId) {
  const headers = { ...baseHeaders };
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
  if (ct.includes("text/event-stream") || /^event:|data:/.test(text)) {
    // SSE:从后向前找第一条能解析且带 result/error 的 data 行(尾部 ping/通知/分段 data 不误取)
    const lines = text.split(/\r?\n/).filter((l) => l.startsWith("data:"));
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const o = JSON.parse(lines[i].slice(5).trim());
        if (o && (o.result !== undefined || o.error !== undefined || o.jsonrpc)) { body = o; break; }
      } catch (_) { /* 继续向前找 */ }
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
    clientInfo: { name: "devbridge-gw-debug", version: "0.1.0" },
  });
  const sid = init.sid;
  if (!sid) throw new Error("no session id in initialize response");
  // notifications/initialized(无 id,204/200 皆可,失败不致命)
  await fetch(url, {
    method: "POST",
    headers: { ...baseHeaders, "Mcp-Session-Id": sid },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  }).catch(() => {});
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
    // 工具级错误包在 result 里(isError:true),也要非零退出
    console.log(JSON.stringify(r, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(r, null, 2));
})().catch((e) => {
  console.error("GW-FAIL: " + (e && e.message ? e.message : String(e)));
  process.exit(1);
});
