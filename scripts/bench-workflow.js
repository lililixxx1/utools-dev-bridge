#!/usr/bin/env node
/**
 * Agent 交互效率基准对比（纯本地 mock 环境）：
 * 对比"旧模式（dev_load 全量预览 + dev_call 分离 dev_console/dev_calls_log 往返 + dev_list 全量）"
 * 与"新模式（精简 exports + dev_call 内联现场 / dev_run 单次背靠背）"的工具调用次数与返回字节数。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const base = fs.mkdtempSync(path.join(os.tmpdir(), "devbridge-bench-"));
const fx = path.join(base, "plugin");
const localData = path.join(base, "localdata");
fs.mkdirSync(fx, { recursive: true });

// 模拟真实业务插件：40 个导出函数 + 生命周期 + db/kv 写入与一次报错
const methods = [];
for (let i = 0; i < 40; i++) {
  methods.push(`  fn${i}: (x) => { console.log("run-fn${i}", x); utools.dbStorage.setItem("k${i}", String(x)); return { idx: ${i}, val: x }; }`);
}
methods.push(`  failOp: () => { console.log("about-to-fail"); utools.dbStorage.setItem("tmp", "v"); throw new Error("boom"); }`);
fs.writeFileSync(path.join(fx, "plugin.json"), JSON.stringify({ preload: "preload.js", logo: "logo.png", main: "index.html", features: [{ code: "b", cmds: ["b"] }] }));
fs.writeFileSync(path.join(fx, "preload.js"), `"use strict";
utools.onPluginEnter((a) => { console.log("entered", a.code); });
window.api = {
${methods.join(",\n")}
};
`);

const registered = {};
const kv = new Map();
global.utools = {
  registerTool: (n, fn) => { registered[n] = fn; },
  getNativeId: () => "bench-native",
  getPluginLocalDataPath: () => localData,
  getPath: (n) => path.join(base, n),
  onPluginEnter: () => {},
  db: { get: () => null, put: (d) => d, remove: () => ({ ok: true }), bulkDocs: () => [] },
  dbStorage: { setItem: (k, v) => kv.set(k, v), getItem: (k) => kv.get(k), removeItem: (k) => kv.delete(k) },
  dbCryptoStorage: { setItem: () => {}, getItem: () => undefined, removeItem: () => {} },
};
Object.freeze(global.utools);

const bridgePath = path.resolve(__dirname, "..", "preload", "index.js");
delete require.cache[require.resolve(bridgePath)];
require(bridgePath);

function measure(calls, bytes) {
  return { calls, bytes };
}

(async () => {
  // 场景 A：旧方式（verbose load + 3 次 calls 每次跟 console/calls_log + verbose list + cleanup）
  let oldCalls = 0;
  let oldBytes = 0;
  const invokeOld = async (tool, args) => {
    oldCalls++;
    const r = await registered[tool](args);
    oldBytes += Buffer.byteLength(JSON.stringify(r), "utf8");
    return r;
  };
  await invokeOld("dev_load", { path: fx, verbose: true });
  const c1 = await invokeOld("dev_call", { name: "api.fn0", args: ["a"], include: [] });
  await invokeOld("dev_console", { since: c1.consoleFrom });
  await invokeOld("dev_calls_log", { since: c1.callsFrom });
  const c2 = await invokeOld("dev_call", { name: "api.failOp", args: [], include: [] });
  await invokeOld("dev_console", { since: c2.consoleFrom });
  await invokeOld("dev_calls_log", { since: c2.callsFrom });
  const c3 = await invokeOld("dev_call", { name: "__enter", args: [{ code: "b", type: "text", payload: "" }], include: [] });
  await invokeOld("dev_console", { since: c3.consoleFrom });
  await invokeOld("dev_calls_log", { since: c3.callsFrom });
  await invokeOld("dev_list", { verbose: true });
  await invokeOld("dev_cleanup", {});

  // 场景 B：新内联方式（精简 load + 内联 dev_call + 精简 dev_list + cleanup）
  let inlineCalls = 0;
  let inlineBytes = 0;
  const invokeInline = async (tool, args) => {
    inlineCalls++;
    const r = await registered[tool](args);
    inlineBytes += Buffer.byteLength(JSON.stringify(r), "utf8");
    return r;
  };
  await invokeInline("dev_load", { path: fx });
  await invokeInline("dev_call", { name: "api.fn0", args: ["a"] });
  await invokeInline("dev_call", { name: "api.failOp", args: [] });
  await invokeInline("dev_call", { name: "__enter", args: [{ code: "b", type: "text", payload: "" }] });
  await invokeInline("dev_list", {});
  await invokeInline("dev_cleanup", {});

  // 场景 C：新批量方式（单次 dev_run 完成 load + 3 步断言 + cleanup）
  const rRun = await registered.dev_run({
    load: { path: fx },
    steps: [
      { call: "api.fn0", args: ["a"], expect: { ok: true, path: "result.idx", eq: 0, hasCall: "utools.dbStorage.setItem" } },
      { call: "api.failOp", expect: { ok: false, code: "THROWN", hasConsole: "about-to-fail" } },
      { call: "__enter", args: [{ code: "b", type: "text", payload: "" }], expect: { hasConsole: "entered" } },
    ],
    cleanup: true,
  });
  const runBytes = Buffer.byteLength(JSON.stringify(rRun), "utf8");

  console.log("=== Agent 交互效率基准对比（40 导出 + 3 步调用含报错 + 状态查验 + 还原）===");
  console.log(`旧式分离往返 : ${oldCalls} 次工具调用, ${oldBytes} bytes 返回载荷`);
  console.log(`v0.4 内联模式: ${inlineCalls} 次工具调用, ${inlineBytes} bytes 返回载荷 (调用 -${Math.round((1 - inlineCalls / oldCalls) * 100)}%, 载荷 -${Math.round((1 - inlineBytes / oldBytes) * 100)}%)`);
  console.log(`v0.4 dev_run : 1 次工具调用, ${runBytes} bytes 返回载荷 (调用 -${Math.round((1 - 1 / oldCalls) * 100)}%, 载荷 -${Math.round((1 - runBytes / oldBytes) * 100)}%)`);
  fs.rmSync(base, { recursive: true, force: true });
})();
