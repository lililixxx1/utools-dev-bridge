/**
 * dev-bridge 自测(纯 Node,不依赖 uTools):mock utools 全局后 require 桥,
 * 用假目标插件验证 load→call→console→calls_log→cleanup→热重载→超时→stub 全链路。
 * 运行:node scripts/selftest.js(在 utools-dev-bridge 目录下)
 */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");

// ---------- mock utools ----------
const registered = {};
const dbDocs = new Map();
const kv = new Map();
const kvCrypto = new Map();
let revCounter = 0;
global.utools = {
  registerTool: (name, fn) => { registered[name] = fn; },
  getNativeId: () => "selftest-native",
  getAppVersion: () => "6.0.0-selftest",
  getPath: (n) => path.join(os.tmpdir(), n),
  copyText: (t) => { global.__clipboard = t; },
  onPluginEnter: () => {}, onPluginOut: () => {}, onMainPush: () => {},
  onPluginDetach: () => {}, onDbPull: () => {},
  onPluginReady: () => {}, onScheduleTrigger: () => {}, // 8.0 新增生命周期
  requestSchedule: async () => { global.__schedAsked = (global.__schedAsked || 0) + 1; },
  getSchedules: () => [],
  removeSchedule: () => { global.__schedRemoved = (global.__schedRemoved || 0) + 1; },
  db: {
    get: (id) => dbDocs.get(id) || null,
    put: (doc) => {
      const prev = dbDocs.get(doc._id);
      const out = Object.assign({}, doc, { _rev: "r" + (++revCounter) });
      dbDocs.set(doc._id, out);
      return out;
    },
    remove: (docOrId) => {
      const id = typeof docOrId === "string" ? docOrId : docOrId._id;
      if (!dbDocs.has(id)) throw new Error("missing");
      dbDocs.delete(id);
      return { ok: true, id, rev: "r" + (++revCounter) };
    },
    bulkDocs: (docs) => docs.map((d) => global.utools.db.put(d)),
  },
  dbStorage: {
    setItem: (k, v) => kv.set(k, v),
    getItem: (k) => (kv.has(k) ? kv.get(k) : undefined),
    removeItem: (k) => kv.delete(k),
  },
  dbCryptoStorage: {
    setItem: (k, v) => kvCrypto.set(k, v),
    getItem: (k) => (kvCrypto.has(k) ? kvCrypto.get(k) : undefined),
    removeItem: (k) => kvCrypto.delete(k),
  },
};

// 模拟真实 uTools 宿主:API 整树只读不可配置(freeze),代理包装不得违反 JS 不变量
for (const k of Object.keys(global.utools)) {
  const v = global.utools[k];
  if (v && typeof v === "object") Object.freeze(v);
}
Object.freeze(global.utools);

// ---------- 假目标插件 ----------
const fx = path.join(__dirname, "fixtures", "demo-plugin");
fs.mkdirSync(path.join(fx, "services"), { recursive: true });
fs.writeFileSync(path.join(fx, "plugin.json"), JSON.stringify({ preload: "preload/index.js", logo: "logo.png" }, null, 1));
fs.mkdirSync(path.join(fx, "preload"), { recursive: true });
fs.writeFileSync(path.join(fx, "services", "sibling.js"), '"use strict";\nmodule.exports = { val: 42 };\n');
fs.writeFileSync(path.join(fx, "services", "math.js"), '"use strict";\nconst TAX = 8;\nconst SIB = require("./sibling.js").val;\nmodule.exports = { add: (a, b) => a + b, withTax: (a) => a + TAX, SIB };\n');
fs.writeFileSync(
  path.join(fx, "preload", "index.js"),
  [
    '"use strict";',
    'const math = require("../services/math.js");',
    'const ut = () => global.utools || window.utools;',
    'const NID = utools.getNativeId ? utools.getNativeId() : "local"; // 顶层读只读不可配置属性(复现线上不变量路径)',
    'const cp = require("node:child_process"); // 懒拒绝:仅 import 不炸',
    'const el = require("electron");',
    'el.ipcRenderer.on("evt", () => {}); // 事件注册族 noop+录制,装载不炸',
    'const fsn = require("fs");',
    'const fsnn = require("node:fs");',
    'const fsp = require("fs/promises");',
    'utools.onPluginEnter(({ code, type, payload }) => { console.log("enter", code, type, payload); });',
    'utools.onPluginOut(() => { console.log("out-cb"); });',
    'utools.onMainPush(({ code }) => { console.log("push-cb", code); });',
    'utools.onPluginReady(() => { console.log("ready-cb"); });', // 8.0
    'utools.onScheduleTrigger(({ code }) => { console.log("schedule-cb", code); });', // 8.0
    'utools.registerTool("say_hi", (params, ctx) => ({ echo: params && params.text, hasCtx: !!ctx }));', // 8.0 MCP 工具
    'utools.registerTool("bad_handler", 12345);', // 审核 M3:非函数 handler 不入账
    'window.demo = {',
    '  add: math.add,',
    '  withTax: math.withTax,',
    '  native: () => NID,',
    '  hasApi: (k) => k in utools,',
    '  apiKeys: () => Object.keys(utools),',
    '  save: (k, v) => ut().dbStorage.setItem(k, v),',
    '  saveDoc: (id) => ut().db.put({ _id: id, hello: 1 }),',
    '  removeDoc: (id) => ut().db.remove(id),',
    '  bulkCreate: (ids) => ut().db.bulkDocs(ids.map((id) => ({ _id: id, src: "bulk" }))),',
    '  arm: (ms) => { setTimeout(() => { ut().db.put({ _id: "_dev_:late", n: 1 }); }, ms); return "armed"; },',
    '  echoClipboard: (t) => ut().copyText(t),',
    '  armSchedule: () => utools.requestSchedule({ code: "t1", label: "桥测", trigger: 60000 }),', // 8.0
    '  armScheduleThen: () => typeof utools.requestSchedule({ code: "t2", label: "桥测", trigger: 1 }).then === "function",', // 审核 M1:stub 保 thenable
    '  dropSchedule: () => utools.removeSchedule("t1"),', // 8.0
    '  boom: () => { throw new Error("炸了:boom-test"); },',
    '  slow: () => new Promise((r) => setTimeout(() => r("slow-done"), 100)),',
    '  spawnEcho: () => cp.exec("echo hi"),',
    '  httpTwice: () => require("http") === require("node:http"),',
    '  fsSame: () => fsn === fsnn,',
    '  fsPromisesSame: () => fsp === fsn.promises,',
    '  write: (p, c) => fsn.writeFileSync(p, c),',
    '  writeP: (p, c) => fsp.writeFile(p, c),',
    '  nodeFsWrite: (p, c) => fsnn.writeFileSync(p, c),',
    '  readBack: (p) => fsn.readFileSync(p, "utf8"),',
    '  mv: (a, b) => fsn.renameSync(a, b),',
    '  unlink: (p) => fsn.unlinkSync(p),',
    '  mkdir: (p) => fsn.mkdirSync(p, { recursive: true }),',
    '  asyncBoom: () => { setTimeout(() => { throw new Error("async-boom-x"); }, 5); return "scheduled"; },',
    '  dbTwice: () => utools.db === utools.db,',
    '  tbl: () => { console.table({ a: 1 }); console.time("t"); console.timeEnd("t"); return "tbl-ok"; },',
    '  webGlobals: () => [typeof URL, typeof TextEncoder, typeof AbortController],',
    '  hasFetch: () => typeof fetch,',
    '  fetchIt: () => fetch("http://127.0.0.1:1/x"),',
    '  sib: () => math.SIB,',
    '  stream: (p) => { const ws = fsn.createWriteStream(p); ws.write("streamed"); ws.end(); return "opened"; },',
    '  ln: (a, b) => fsn.linkSync(a, b),',
    '  mktmp: (p) => fsn.mkdtempSync(p),',
    '  tp: () => typeof (require("timers").promises || {}).setTimeout,',
    '  saveTwice: (id) => { ut().db.put({ _id: id, n: 1 }); ut().db.put({ _id: id, n: 2 }); return "ok"; },',
    '  domProbe: () => { const el = document.createElement("div"); el.setAttribute("id", "x"); el.addEventListener("click", () => {}); document.body.appendChild(el); return { byId: document.getElementById("x"), q: document.querySelector(".a"), qall: document.querySelectorAll(".a").length, children: document.body.children.length, tag: el.tagName }; },',
    '  domListen: () => { document.addEventListener("DOMContentLoaded", () => { console.log("dom-ready-cb"); }); return "listening"; },',
    '};',
    'console.log("boot", "demo preload 挂载完成");',
    '',
  ].join("\n")
);

// 死循环目标(独立文件,按需加载)
const loopFx = path.join(__dirname, "fixtures", "loop-plugin");
fs.mkdirSync(path.join(loopFx, "preload"), { recursive: true });
fs.writeFileSync(path.join(loopFx, "plugin.json"), JSON.stringify({ preload: "preload/index.js" }));
fs.writeFileSync(path.join(loopFx, "preload", "index.js"), 'window.loop = { spin: () => { while (true) {} } };\n');

// ---------- require 桥 ----------
// 清掉上次运行遗留的 journal spill(桥 require 时会回灌,污染本次断言)
fs.rmSync(path.join(os.tmpdir(), "temp", "devbridge-journal"), { recursive: true, force: true });
require(path.join(__dirname, "..", "preload", "index.js"));

const assert = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; throw new Error(msg); } console.log("PASS:", msg); };
const tools = registered;
assert(Object.keys(tools).length === 6, "注册了 6 个工具: " + Object.keys(tools).join(","));

(async () => {
  // 1) dev_load
  let r = await tools.dev_load({ path: fx });
  assert(r.ok && r.entry.endsWith("index.js"), "dev_load 成功, entry=" + r.entry);
  assert(r.exports.some((e) => e.name === "demo.add" && e.kind === "function"), "发现导出 demo.add");
  assert((r.events.find((e) => e.api === "utools.onPluginEnter") || {}).count === 1, "登记 onPluginEnter x1");

  // 2) 基本调用
  r = await tools.dev_call({ name: "demo.add", args: [2, 3] });
  assert(r.ok && r.result === 5, "demo.add(2,3)=5");

  // 2b) 冻结 API 不变量(freeze 后只读不可配置属性):顶层读不炸,包装/has/ownKeys 均有效
  r = await tools.dev_call({ name: "demo.native" });
  assert(r.ok && r.result === "selftest-native", "冻结 API 下顶层 getNativeId 可读可调");
  r = await tools.dev_call({ name: "demo.hasApi", args: ["db"] });
  assert(r.ok && r.result === true, "代理 has 陷阱生效('db' in utools)");
  r = await tools.dev_call({ name: "demo.apiKeys" });
  assert(r.ok && Array.isArray(r.result) && r.result.includes("db") && r.result.includes("getNativeId"), "代理 ownKeys/gOPD 陷阱生效(Object.keys 含 db/getNativeId)");
  const c2b = await tools.dev_calls_log({ since: 0 });
  assert(c2b.entries.some((e) => e.api === "utools.getNativeId" && e.ok), "冻结属性调用仍被录制(shim 包装未失效)");

  // 3) __enter 触发回调 → console 增量
  r = await tools.dev_call({ name: "__enter", args: [{ code: "demo", type: "text", payload: "hi" }] });
  assert(r.ok, "__enter 执行成功");
  let con = await tools.dev_console({ since: r.consoleFrom });
  assert(con.entries.some((e) => e.level === "log" && JSON.stringify(e.args).includes("enter")), "console 捕获 enter 日志");

  // 4) stub 验证:剪贴板未被写
  r = await tools.dev_call({ name: "demo.echoClipboard", args: ["不应写入"] });
  assert(r.ok && r.result && r.result.stubbed === true, "copyText 被 stub");
  assert(global.__clipboard === undefined, "真实剪贴板未动");

  // 5) db/dbStorage 写 + calls_log + cleanup 还原
  kv.set("pre:existing", "旧值");
  const kvSizeBefore = kv.size, dbSizeBefore = dbDocs.size;
  await tools.dev_call({ name: "demo.save", args: ["_dev_:k1", "v1"] });
  await tools.dev_call({ name: "demo.saveDoc", args: ["_dev_:doc1"] });
  await tools.dev_call({ name: "demo.saveDoc", args: ["pre:doc2"] }); // 覆盖已有文档?pre:doc2 不存在,新增
  assert(kv.get("_dev_:k1") === "v1" && dbDocs.has("_dev_:doc1"), "写入真实发生");
  await tools.dev_call({ name: "demo.save", args: ["pre:existing", "新值"] }); // 覆盖已有键 → cleanup 应还原旧值
  assert(kv.get("pre:existing") === "新值", "覆盖写入生效");
  let calls = await tools.dev_calls_log({ since: 0 });
  assert(calls.entries.some((e) => e.api === "utools.dbStorage.setItem"), "calls_log 记录 setItem");
  assert(calls.entries.some((e) => e.api === "utools.db.put"), "calls_log 记录 db.put");
  r = await tools.dev_cleanup();
  assert(r.ok && r.restored.kvRestore >= 1 && r.restored.dbDelete >= 2, "cleanup 还原计数: " + JSON.stringify(r.restored));
  assert(kv.size === kvSizeBefore && !kv.has("_dev_:k1"), "dbStorage 复原");
  assert(dbDocs.size === dbSizeBefore && !dbDocs.has("_dev_:doc1"), "db 复原");
  assert(kv.get("pre:existing") === "旧值", "覆盖写入被还原为旧值");

  // 5b) remove 的前态还原
  dbDocs.set("keep:doc", { _id: "keep:doc", _rev: "r0", data: "原件" });
  await tools.dev_call({ name: "demo.removeDoc", args: ["keep:doc"] });
  assert(!dbDocs.has("keep:doc"), "remove 真实删除");
  await tools.dev_cleanup();
  const restored = dbDocs.get("keep:doc");
  assert(restored && restored.data === "原件", "remove 前态被还原(新 rev=" + (restored && restored._rev) + ")");

  // 5c) bulkDocs 新建文档回滚删除(2026-09-16 airss 实测孤儿回归:bulk 建的文档被级联 remove 后,
  //     逆序回放先还原 remove 前态复活文档,bulkDocs 回滚若无前态必须删掉,否则残留孤儿)
  await tools.dev_call({ name: "demo.bulkCreate", args: [["_dev_:b1", "_dev_:b2"]] });
  assert(dbDocs.has("_dev_:b1") && dbDocs.has("_dev_:b2"), "bulkDocs 写入真实发生");
  await tools.dev_call({ name: "demo.removeDoc", args: ["_dev_:b1"] });
  await tools.dev_call({ name: "demo.removeDoc", args: ["_dev_:b2"] });
  assert(!dbDocs.has("_dev_:b1") && !dbDocs.has("_dev_:b2"), "remove 后文档不在");
  r = await tools.dev_cleanup();
  assert(r.ok, "5c cleanup 执行");
  assert(!dbDocs.has("_dev_:b1") && !dbDocs.has("_dev_:b2"),
    "cleanup 后 bulkDocs 新建文档不残留孤儿(restored=" + JSON.stringify(r.restored) + ")");

  // 5d) dropAll:跳过回放直接清空写日志(现场保持现状的逃生口)
  await tools.dev_call({ name: "demo.saveDoc", args: ["_dev_:keep1"] });
  assert(dbDocs.has("_dev_:keep1"), "dropAll 前写入存在");
  await tools.dev_call({ name: "demo.arm", args: [250] }); // M1:残留定时器必须被 dropAll 先杀掉
  r = await tools.dev_cleanup({ dropAll: true });
  assert(r.ok && r.dropped === true && r.droppedEntries >= 1, "dropAll 执行(丢弃 " + (r && r.droppedEntries) + " 条)");
  assert(dbDocs.has("_dev_:keep1"), "dropAll 不回放,写入保留");
  await new Promise((res) => setTimeout(res, 450));
  assert(!dbDocs.has("_dev_:late"), "dropAll 已杀目标定时器,清理后无迟到写入");
  r = await tools.dev_cleanup();
  assert(r.ok && r.restored.dbRestore === 0 && r.restored.dbDelete === 0, "dropAll 后写日志已空");
  dbDocs.delete("_dev_:keep1"); // 手工清场,不影响后续用例

  // 5e) bulk 覆盖既有文档:cleanup 应还原原文档而非删除
  dbDocs.set("pre:bulk", { _id: "pre:bulk", _rev: "r0", data: "原件" });
  await tools.dev_call({ name: "demo.bulkCreate", args: [["pre:bulk"]] });
  assert(dbDocs.get("pre:bulk") && dbDocs.get("pre:bulk").src === "bulk", "bulk 覆盖生效");
  await tools.dev_cleanup();
  const be = dbDocs.get("pre:bulk");
  assert(be && be.data === "原件" && be.src === undefined, "bulk 覆盖被还原为原文档(未误删)");

  // 6) 异常传播
  r = await tools.dev_call({ name: "demo.boom" });
  assert(!r.ok && r.code === "THROWN" && /boom-test/.test(r.message), "异常栈完整回传");

  // 7) 异步
  r = await tools.dev_call({ name: "demo.slow", timeoutMs: 3000 });
  assert(r.ok && r.result === "slow-done", "异步调用收结果");

  // 8) 热重载(services 级)
  fs.writeFileSync(path.join(fx, "services", "math.js"), '"use strict";\nconst TAX = 99;\nconst SIB = require("./sibling.js").val;\nmodule.exports = { add: (a, b) => a + b, withTax: (a) => a + TAX, SIB };\n');
  await tools.dev_load({ path: fx });
  r = await tools.dev_call({ name: "demo.withTax", args: [1] });
  assert(r.ok && r.result === 100, "热重载后 TAX=99 生效(100)");

  // 9) 同步死循环超时 + 沙箱自动重建
  await tools.dev_load({ path: loopFx, timeoutMs: 2000 });
  r = await tools.dev_call({ name: "loop.spin", timeoutMs: 700 });
  assert(!r.ok && r.code === "TIMEOUT", "死循环受超时保护");
  r = await tools.dev_list();
  assert(r.ok === true && r.loaded === true, "超时后 dev_list 仍可用");
  r = await tools.dev_call({ name: "loop.spin", timeoutMs: 500 });
  assert(!r.ok && r.code === "TIMEOUT", "脏沙箱自动重建后行为一致");

  // 10) 未知名回候选(切回 demo 插件,候选应含其函数)
  await tools.dev_load({ path: fx });
  r = await tools.dev_call({ name: "demo.nope" });
  assert(!r.ok && r.code === "UNKNOWN_EXPORT" && /demo\.add/.test(r.message), "未知名返回候选清单");

  // 11) Node 模块门控(v3 B1):懒拒绝 + node: 前缀 + 装载期 warnings + 单例 identity
  r = await tools.dev_load({ path: fx });
  assert(r.warnings.some((w) => /child_process|electron/.test(w)), "dev_load warnings 汇总装载期模块拦截");
  r = await tools.dev_call({ name: "demo.spawnEcho" });
  assert(!r.ok && r.code === "DENIED_MODULE" && /child_process/.test(r.message), "child_process 调用被拒(DENIED_MODULE)");
  r = await tools.dev_call({ name: "demo.httpTwice" });
  assert(r.ok && r.result === true, "node: 前缀规范化+denied 模块单例(http===node:http)");
  r = await tools.dev_call({ name: "demo.fsSame" });
  assert(r.ok && r.result === true, "fs 与 node:fs 映射同一 shim");
  r = await tools.dev_call({ name: "demo.fsPromisesSame" });
  assert(r.ok && r.result === true, "fs/promises 与 fs.promises 映射同一 shim");
  calls = await tools.dev_calls_log({ since: 0 });
  assert(calls.entries.some((e) => e.api === "require:electron.ipcRenderer.on" && e.denied), "electron.ipcRenderer.on noop+录制(denied)");
  assert(calls.entries.some((e) => String(e.api).indexOf("require:child_process.exec") === 0 && e.denied), "child_process.exec 拦截入流水");

  // 12) fetch 门控 + web 全局补齐(v3 M5/M7)
  r = await tools.dev_call({ name: "demo.hasFetch" });
  assert(r.ok && r.result === "function", "fetch 全局存在");
  r = await tools.dev_call({ name: "demo.fetchIt" });
  assert(!r.ok && r.code === "DENIED_FETCH", "fetch 默认 rejected Promise(DENIED_FETCH)");
  r = await tools.dev_call({ name: "demo.webGlobals" });
  assert(r.ok && r.result.every((t) => t === "function"), "web 全局补齐(URL/TextEncoder/AbortController)");

  // 13) fs 写日志 + cleanup 还原(v3 决策1:B2 三变体四入口/WAL/还原)
  const fsx = path.join(os.tmpdir(), "devbridge-fsx");
  fs.rmSync(fsx, { recursive: true, force: true });
  fs.mkdirSync(fsx, { recursive: true });
  r = await tools.dev_call({ name: "demo.write", args: [path.join(fsx, "a.txt"), "hello"] });
  assert(r.ok && fs.existsSync(path.join(fsx, "a.txt")), "fs.writeFileSync 真实写入");
  fs.writeFileSync(path.join(fsx, "b.txt"), "旧内容"); // 宿主侧预置,cleanup 应还原
  await tools.dev_call({ name: "demo.write", args: [path.join(fsx, "b.txt"), "新内容"] });
  assert(fs.readFileSync(path.join(fsx, "b.txt"), "utf8") === "新内容", "覆盖写入生效");
  await tools.dev_call({ name: "demo.writeP", args: [path.join(fsx, "c.txt"), "p"] }); // promises 变体
  await tools.dev_call({ name: "demo.nodeFsWrite", args: [path.join(fsx, "d.txt"), "n"] }); // node: 前缀
  await tools.dev_call({ name: "demo.mkdir", args: [path.join(fsx, "sub", "deep")] });
  await tools.dev_call({ name: "demo.mv", args: [path.join(fsx, "a.txt"), path.join(fsx, "a2.txt")] });
  assert(!fs.existsSync(path.join(fsx, "a.txt")) && fs.existsSync(path.join(fsx, "a2.txt")), "rename 真实生效");
  r = await tools.dev_call({ name: "demo.readBack", args: [path.join(fsx, "a2.txt")] });
  assert(r.ok && r.result === "hello", "写入后读回真实(零分歧)");
  calls = await tools.dev_calls_log({ since: 0 });
  assert(calls.entries.some((e) => e.api === "fs.writeFileSync"), "calls_log 记录 fs 写操作");
  r = await tools.dev_cleanup();
  assert(r.ok && r.restored.fsRestore >= 6, "fs 前态还原计数: " + JSON.stringify(r.restored));
  assert(!fs.existsSync(path.join(fsx, "a2.txt")), "新建文件被清理(a→a2 链)");
  assert(fs.readFileSync(path.join(fsx, "b.txt"), "utf8") === "旧内容", "覆盖文件还原旧内容");
  assert(!fs.existsSync(path.join(fsx, "c.txt")) && !fs.existsSync(path.join(fsx, "d.txt")), "promises/node: 前缀写入被清理");
  assert(!fs.existsSync(path.join(fsx, "sub")), "mkdir 被清理");

  // 13b) 超限分级(v3 M3):破坏性超限默认拒绝,写类超限 untracked
  const big = path.join(fsx, "big.bin");
  fs.writeFileSync(big, Buffer.alloc(9 * 1024 * 1024, 1)); // >8MB 上限
  r = await tools.dev_call({ name: "demo.unlink", args: [big] });
  assert(!r.ok && r.code === "DENIED_FS_UNTRACKED", "破坏性操作前态超限默认拒绝");
  assert(fs.existsSync(big), "大文件未被删除(拒绝生效)");
  r = await tools.dev_call({ name: "demo.write", args: [big, "small"] });
  assert(r.ok, "写类超限放行");
  calls = await tools.dev_calls_log({ since: 0 });
  assert(calls.entries.some((e) => e.api === "fs.writeFileSync" && e.untracked), "写类超限 untracked 标记");
  r = await tools.dev_cleanup();
  assert(r.ok && Array.isArray(r.untracked) && r.untracked.length >= 1, "cleanup 报告 untracked 清单");
  fs.rmSync(fsx, { recursive: true, force: true });

  // 14) 目标异步异常录入(v3 M2):不冒宿主
  r = await tools.dev_call({ name: "demo.asyncBoom" });
  assert(r.ok && r.result === "scheduled", "异步炸弹调度成功");
  await new Promise((res) => setTimeout(res, 60));
  con = await tools.dev_console({ since: 0 });
  assert(con.entries.some((e) => e.level === "uncaught" && JSON.stringify(e.args).indexOf("async-boom-x") >= 0), "异步异常录入 dev_console(level=uncaught)");

  // 15) 代理 identity 缓存 + console 补全(v3 P3)
  r = await tools.dev_call({ name: "demo.dbTwice" });
  assert(r.ok && r.result === true, "代理 identity 稳定(utools.db===utools.db)");
  r = await tools.dev_call({ name: "demo.tbl" });
  assert(r.ok && r.result === "tbl-ok", "console.table/time/timeEnd 不炸");

  // 16) rt-check 真机回归套件自检(纯 Node 预跑;真机由 agent 在 uTools 里实跑)
  await tools.dev_load({ path: path.join(__dirname, "rt-check") });
  r = await tools.dev_call({ name: "rt.runAll" });
  const rr = r.ok ? r.result : null;
  assert(r.ok && rr && rr.fail === 0 && rr.total >= 18,
    "rt-check runAll 全过(" + (rr ? rr.total + " 项" : "失败") + ")"
    + (rr && rr.fail ? ": " + rr.results.filter((x) => !x.pass).map((x) => x.name + "→" + x.detail.slice(0, 60)).join(" | ") : ""));
  r = await tools.dev_call({ name: "rt.probeHost" });
  assert(r.ok && r.result && /^selftest/.test(r.result.nativeIdPrefix), "rt-check probeHost 工作");
  r = await tools.dev_call({ name: "rt.timerCheck", timeoutMs: 5000 });
  assert(r.ok && r.result === "timer-fired", "rt-check timerCheck 异步触发");
  r = await tools.dev_call({ name: "rt.v80ScheduleStub", timeoutMs: 5000 });
  assert(r.ok && r.result === "stubbed+thenable", "rt-check v80ScheduleStub:8.0 定时任务 stub 保 thenable");
  r = await tools.dev_call({ name: "rt.phaseA" });
  const mk = r.result.marker;
  r = await tools.dev_call({ name: "rt.phaseB", args: [mk] });
  assert(r.ok && r.result.fileContent === "NEW" && r.result.doc && r.result.kv === "dirty", "phaseA/B dirty 状态正确");
  r = await tools.dev_cleanup();
  assert(r.ok, "两阶段用例 cleanup 执行");
  r = await tools.dev_call({ name: "rt.phaseC", args: [mk] });
  assert(r.ok && r.result.fileExists === false && !r.result.doc && r.result.kv === null, "phaseC 还原验证(文件删/文档删/键删)");

  // 17) 审核修复回归:B1 数组语义/B2 流缺省记账/M1 失败回滚/M2 双写还原/M3 相对解析
  await tools.dev_load({ path: fx });
  r = await tools.dev_call({ name: "demo.sib" });
  assert(r.ok && r.result === 42, "services 相对路径按 fromFile 解析(M3)");
  r = await tools.dev_call({ name: "demo.tp" });
  assert(r.ok && r.result === "function", "require('timers').promises 存在");
  const sx = path.join(os.tmpdir(), "devbridge-fsx2");
  fs.rmSync(sx, { recursive: true, force: true });
  fs.mkdirSync(sx, { recursive: true });
  r = await tools.dev_call({ name: "demo.stream", args: [path.join(sx, "s.txt")] });
  assert(r.ok && r.result === "opened", "createWriteStream(缺省 flags)打开");
  await new Promise((res) => setTimeout(res, 80)); // 等流落盘
  assert(fs.readFileSync(path.join(sx, "s.txt"), "utf8") === "streamed", "流写入落盘");
  fs.writeFileSync(path.join(sx, "src.txt"), "src");
  fs.writeFileSync(path.join(sx, "dst.txt"), "PRECIOUS");
  r = await tools.dev_call({ name: "demo.ln", args: [path.join(sx, "src.txt"), path.join(sx, "dst.txt")] });
  assert(!r.ok, "linkSync 对已存在目标失败(预期 EEXIST)");
  await tools.dev_call({ name: "demo.mktmp", args: [path.join(sx, "mk-")] });
  await tools.dev_call({ name: "demo.saveTwice", args: ["_dev_:dbl"] });
  r = await tools.dev_cleanup();
  assert(r.ok && r.restored.fsRestore >= 1, "流前态还原计数: " + r.restored.fsRestore);
  assert(!fs.existsSync(path.join(sx, "s.txt")), "createWriteStream 无 flags 写入被还原(B2)");
  assert(fs.readFileSync(path.join(sx, "dst.txt"), "utf8") === "PRECIOUS", "失败 link 的目标未被误删(M1)");
  assert(r.untracked && r.untracked.some((u) => u.indexOf("mkdtemp") === 0), "mkdtemp 报 untracked");
  assert(!dbDocs.has("_dev_:dbl"), "同 id 双写还原干净(M2)");
  // B1:数组(含空数组)不得解除 fetch 门控与破坏性超限拒绝
  await tools.dev_load({ path: fx, allowHostModules: [] });
  r = await tools.dev_call({ name: "demo.fetchIt" });
  assert(!r.ok && r.code === "DENIED_FETCH", "allowHostModules:[] 不放行 fetch(B1)");
  fs.writeFileSync(path.join(sx, "big2.bin"), Buffer.alloc(9 * 1024 * 1024, 1));
  r = await tools.dev_call({ name: "demo.unlink", args: [path.join(sx, "big2.bin")] });
  assert(!r.ok && r.code === "DENIED_FS_UNTRACKED", "allowHostModules:[] 不解除破坏性超限拒绝(B1)");
  await tools.dev_cleanup();
  fs.rmSync(sx, { recursive: true, force: true });

  // 18) P2:生命周期模拟(__out/__mainPush/__dbPull/__domReady) + DOM stub
  await tools.dev_load({ path: fx });
  r = await tools.dev_call({ name: "demo.domProbe" });
  assert(r.ok && r.result.byId === null && r.result.q === null && r.result.qall === 0 && r.result.children === 1 && r.result.tag === "DIV",
    "DOM stub:查询恒 null/创建-追加记录(" + JSON.stringify(r.result) + ")");
  r = await tools.dev_call({ name: "demo.domListen" });
  assert(r.ok && r.result === "listening", "DOMContentLoaded 监听登记");
  r = await tools.dev_call({ name: "__domReady" });
  assert(r.ok, "__domReady 触发");
  con = await tools.dev_console({ since: 0 });
  assert(con.entries.some((e) => JSON.stringify(e.args).indexOf("dom-ready-cb") >= 0), "dom-ready 回调执行");
  r = await tools.dev_call({ name: "__out" });
  assert(r.ok, "__out 触发 onPluginOut");
  con = await tools.dev_console({ since: 0 });
  assert(con.entries.some((e) => JSON.stringify(e.args).indexOf("out-cb") >= 0), "onPluginOut 回调执行");
  r = await tools.dev_call({ name: "__mainPush", args: [{ code: "c1", type: "text", payload: "p" }] });
  assert(r.ok, "__mainPush 触发");
  con = await tools.dev_console({ since: 0 });
  assert(con.entries.some((e) => JSON.stringify(e.args).indexOf("push-cb") >= 0), "onMainPush 回调执行");
  r = await tools.dev_call({ name: "__dbPull" });
  assert(!r.ok && r.code === "UNKNOWN_EXPORT", "__dbPull 未注册时给明确错误");

  // 19) 8.0 适配:onPluginReady/onScheduleTrigger 登记+触发、registerTool 捕获为 __tool:、定时任务 API stub
  r = await tools.dev_load({ path: fx });
  assert(r.events.some((e) => e.api === "utools.onPluginReady") && r.events.some((e) => e.api === "utools.onScheduleTrigger"),
    "8.0 事件登记(onPluginReady/onScheduleTrigger)");
  assert(r.tools.some((t) => t.name === "say_hi"), "dev_load 返回 registerTool 捕获的工具清单");
  r = await tools.dev_call({ name: "__ready" });
  assert(r.ok, "__ready 触发 onPluginReady");
  con = await tools.dev_console({ since: r.consoleFrom });
  assert(con.entries.some((e) => JSON.stringify(e.args).indexOf("ready-cb") >= 0), "onPluginReady 回调执行");
  r = await tools.dev_call({ name: "__schedule", args: [{ code: "drink-water" }] });
  assert(r.ok, "__schedule 触发 onScheduleTrigger");
  con = await tools.dev_console({ since: r.consoleFrom });
  assert(con.entries.some((e) => JSON.stringify(e.args).indexOf("schedule-cb") >= 0 && JSON.stringify(e.args).indexOf("drink-water") >= 0),
    "onScheduleTrigger 回调执行(code 透传)");
  r = await tools.dev_call({ name: "__tool:say_hi", args: [{ text: "hi8" }] });
  assert(r.ok && r.result && r.result.echo === "hi8" && r.result.hasCtx === true, "__tool:say_hi 调用捕获的 handler(params+仿真 ctx)");
  r = await tools.dev_call({ name: "__tool:nope" });
  assert(!r.ok && r.code === "UNKNOWN_EXPORT" && /say_hi/.test(r.message), "__tool 未知名返回已注册清单");
  global.__schedAsked = 0; global.__schedRemoved = 0;
  r = await tools.dev_call({ name: "demo.armSchedule" });
  assert(r.ok && r.result && r.result.stubbed === true && global.__schedAsked === 0, "requestSchedule 默认 stub(宿主未触达)");
  r = await tools.dev_call({ name: "demo.dropSchedule" });
  assert(r.ok && r.result && r.result.stubbed === true && global.__schedRemoved === 0, "removeSchedule 默认 stub");
  r = await tools.dev_list();
  assert(r.ok && r.tools.some((t) => t.name === "say_hi"), "dev_list 返回工具清单");

  // 19b) 审核 M1-M3 回归:stub 保 thenable / null 原型防 __proto__/constructor / 非函数 handler 装载期暴露
  assert(r.warnings.some((w) => /bad_handler/.test(w)), "非函数 handler 装载期警告(M3)");
  assert(!r.tools.some((t) => t.name === "bad_handler"), "非函数 handler 不入 tools 清单(M3)");
  r = await tools.dev_call({ name: "demo.armScheduleThen" });
  assert(r.ok && r.result === true, "requestSchedule stub 保 thenable(.then 可用)(M1)");
  r = await tools.dev_call({ name: "__tool:__proto__" });
  assert(!r.ok && r.code === "UNKNOWN_EXPORT", "__tool:__proto__ 不命中原型链(M2)");
  r = await tools.dev_call({ name: "__tool:constructor" });
  assert(!r.ok && r.code === "UNKNOWN_EXPORT", "__tool:constructor 不命中原型链(M2)");

  console.log(process.exitCode ? "\n== SELFTEST FAILED ==" : "\n== SELFTEST ALL PASS ==");
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exitCode = 1; });
