"use strict";
const math = require("../services/math.js");
const ut = () => global.utools || window.utools;
const NID = utools.getNativeId ? utools.getNativeId() : "local"; // 顶层读只读不可配置属性(复现线上不变量路径)
const cp = require("node:child_process"); // 懒拒绝:仅 import 不炸
const el = require("electron");
el.ipcRenderer.on("evt", () => {}); // 事件注册族 noop+录制,装载不炸
const fsn = require("fs");
const fsnn = require("node:fs");
const fsp = require("fs/promises");
utools.onPluginEnter(({ code, type, payload }) => { console.log("enter", code, type, payload); });
utools.onPluginOut(() => { console.log("out-cb"); });
utools.onMainPush(({ code }) => { console.log("push-cb", code); });
window.demo = {
  add: math.add,
  withTax: math.withTax,
  native: () => NID,
  hasApi: (k) => k in utools,
  apiKeys: () => Object.keys(utools),
  save: (k, v) => ut().dbStorage.setItem(k, v),
  saveDoc: (id) => ut().db.put({ _id: id, hello: 1 }),
  removeDoc: (id) => ut().db.remove(id),
  bulkCreate: (ids) => ut().db.bulkDocs(ids.map((id) => ({ _id: id, src: "bulk" }))),
  arm: (ms) => { setTimeout(() => { ut().db.put({ _id: "_dev_:late", n: 1 }); }, ms); return "armed"; },
  echoClipboard: (t) => ut().copyText(t),
  boom: () => { throw new Error("炸了:boom-test"); },
  slow: () => new Promise((r) => setTimeout(() => r("slow-done"), 100)),
  spawnEcho: () => cp.exec("echo hi"),
  httpTwice: () => require("http") === require("node:http"),
  fsSame: () => fsn === fsnn,
  fsPromisesSame: () => fsp === fsn.promises,
  write: (p, c) => fsn.writeFileSync(p, c),
  writeP: (p, c) => fsp.writeFile(p, c),
  nodeFsWrite: (p, c) => fsnn.writeFileSync(p, c),
  readBack: (p) => fsn.readFileSync(p, "utf8"),
  mv: (a, b) => fsn.renameSync(a, b),
  unlink: (p) => fsn.unlinkSync(p),
  mkdir: (p) => fsn.mkdirSync(p, { recursive: true }),
  asyncBoom: () => { setTimeout(() => { throw new Error("async-boom-x"); }, 5); return "scheduled"; },
  dbTwice: () => utools.db === utools.db,
  tbl: () => { console.table({ a: 1 }); console.time("t"); console.timeEnd("t"); return "tbl-ok"; },
  webGlobals: () => [typeof URL, typeof TextEncoder, typeof AbortController],
  hasFetch: () => typeof fetch,
  fetchIt: () => fetch("http://127.0.0.1:1/x"),
  sib: () => math.SIB,
  stream: (p) => { const ws = fsn.createWriteStream(p); ws.write("streamed"); ws.end(); return "opened"; },
  ln: (a, b) => fsn.linkSync(a, b),
  mktmp: (p) => fsn.mkdtempSync(p),
  tp: () => typeof (require("timers").promises || {}).setTimeout,
  saveTwice: (id) => { ut().db.put({ _id: id, n: 1 }); ut().db.put({ _id: id, n: 2 }); return "ok"; },
  domProbe: () => { const el = document.createElement("div"); el.setAttribute("id", "x"); el.addEventListener("click", () => {}); document.body.appendChild(el); return { byId: document.getElementById("x"), q: document.querySelector(".a"), qall: document.querySelectorAll(".a").length, children: document.body.children.length, tag: el.tagName }; },
  domListen: () => { document.addEventListener("DOMContentLoaded", () => { console.log("dom-ready-cb"); }); return "listening"; },
};
console.log("boot", "demo preload 挂载完成");
