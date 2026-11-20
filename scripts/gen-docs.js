#!/usr/bin/env node
/**
 * 从 preload/contract.js（单一来源）同步生成并校验：
 *   - plugin.json (version / description / tools)
 *   - README.md 与 skills/utools-dev-bridge/SKILL.md 中的工具表 & 错误码表
 *   - fallback-ui.html 中的版本与工具清单
 * 用法：
 *   node scripts/gen-docs.js           # 写入同步
 *   node scripts/gen-docs.js --check   # 仅校验，有漂移则非零退出
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { VERSION, LIMITS, ERROR_CODES, TOOLS } = require("../preload/contract");

const ROOT = path.resolve(__dirname, "..");
const CHECK_ONLY = process.argv.includes("--check");

function findForbiddenSchemaKeyword(node, loc) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const hit = findForbiddenSchemaKeyword(node[i], loc + "[" + i + "]");
      if (hit) return hit;
    }
    return null;
  }
  for (const k of Object.keys(node)) {
    if (k === "oneOf" || k === "anyOf" || k === "allOf" || k === "$ref") {
      return loc + "." + k;
    }
    const hit = findForbiddenSchemaKeyword(node[k], loc + "." + k);
    if (hit) return hit;
  }
  return null;
}

function validateContract() {
  const names = Object.keys(TOOLS);
  if (!names.length) throw new Error("contract.TOOLS 为空");
  for (const name of names) {
    const t = TOOLS[name];
    if (typeof t.description !== "string" || !t.description.trim()) {
      throw new Error("TOOLS." + name + ".description 不能为空");
    }
    if (t.description.length > LIMITS.DESCRIPTION_MAX_LEN) {
      throw new Error("TOOLS." + name + ".description 超出 " + LIMITS.DESCRIPTION_MAX_LEN + " 字符: " + t.description.length);
    }
    const bad = findForbiddenSchemaKeyword(t.inputSchema, "TOOLS." + name + ".inputSchema");
    if (bad) throw new Error("禁止的 JSON Schema 组合构造（uTools 8.0 校验器拒收）: " + bad);
  }
  const seenCodes = new Set();
  for (const e of ERROR_CODES) {
    if (seenCodes.has(e.code)) throw new Error("重复错误码: " + e.code);
    seenCodes.add(e.code);
  }
}

function renderToolsTable() {
  const lines = [
    "| 工具 | 用途 | 关键参数 |",
    "| --- | --- | --- |",
  ];
  for (const [name, t] of Object.entries(TOOLS)) {
    lines.push("| `" + name + "` | " + t.summary + " | " + t.keyParams + " |");
  }
  return lines.join("\n");
}

function renderErrorCodesTable() {
  const lines = [
    "| code | 含义与处置 |",
    "| --- | --- |",
  ];
  for (const e of ERROR_CODES) {
    lines.push("| `" + e.code + "` | " + e.meaning + " |");
  }
  return lines.join("\n");
}

function renderFallbackToolsLines() {
  const names = Object.keys(TOOLS);
  const rows = [];
  for (let i = 0; i < names.length; i += 4) {
    const chunk = names.slice(i, i + 4).join(" ");
    const label = i === 0 ? "tools" : "　　　";
    rows.push("      <p><span class=\"k\">" + label + "</span><span>" + chunk + "</span></p>");
  }
  return rows.join("\n");
}

function replaceBlock(content, marker, replacement) {
  const startTag = "<!-- GENERATED:" + marker + ":START -->";
  const endTag = "<!-- GENERATED:" + marker + ":END -->";
  const s = content.indexOf(startTag);
  const e = content.indexOf(endTag);
  if (s < 0 || e < 0 || e < s) {
    throw new Error("缺少生成标记区块: " + marker);
  }
  return content.slice(0, s + startTag.length) + "\n" + replacement + "\n" + content.slice(e);
}

function replaceInlineBlock(content, marker, replacement) {
  const startTag = "<!-- GENERATED:" + marker + ":START -->";
  const endTag = "<!-- GENERATED:" + marker + ":END -->";
  const s = content.indexOf(startTag);
  const e = content.indexOf(endTag);
  if (s < 0 || e < 0 || e < s) {
    throw new Error("缺少内联生成标记区块: " + marker);
  }
  return content.slice(0, s + startTag.length) + replacement + content.slice(e);
}

function normEol(s) {
  return s.replace(/\r\n/g, "\n");
}

function applyFile(relPath, transform) {
  const full = path.join(ROOT, relPath);
  const raw = fs.readFileSync(full, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const nextNorm = normEol(transform(normEol(raw)));
  const currentNorm = normEol(raw);
  if (nextNorm === currentNorm) return false;
  if (CHECK_ONLY) {
    console.error("DRIFT: " + relPath + " 与 preload/contract.js 不一致; 请运行 node scripts/gen-docs.js");
    return true;
  }
  const out = eol === "\r\n" ? nextNorm.replace(/\n/g, "\r\n") : nextNorm;
  fs.writeFileSync(full, out, "utf8");
  console.log("UPDATED: " + relPath);
  return false;
}

validateContract();

const toolsTable = renderToolsTable();
const errorCodesTable = renderErrorCodesTable();
const fallbackToolsLines = renderFallbackToolsLines();

let hasDrift = false;

hasDrift = applyFile("plugin.json", (raw) => {
  const pj = JSON.parse(raw);
  pj.version = VERSION;
  pj.description = "面向 AI Agent 的 uTools 插件开发测试桥:沙箱加载/批量断言/异步任务/UI 真窗口调试与副作用还原";
  const tools = {};
  for (const [name, t] of Object.entries(TOOLS)) {
    tools[name] = {
      description: t.description,
      inputSchema: t.inputSchema,
    };
  }
  pj.tools = tools;
  return JSON.stringify(pj, null, 2) + "\n";
}) || hasDrift;

hasDrift = applyFile("README.md", (raw) => {
  let out = replaceBlock(raw, "TOOLS_TABLE", toolsTable);
  out = replaceBlock(out, "ERROR_CODES", errorCodesTable);
  return out;
}) || hasDrift;

hasDrift = applyFile("skills/utools-dev-bridge/SKILL.md", (raw) => {
  let out = replaceBlock(raw, "TOOLS_TABLE", toolsTable);
  out = replaceBlock(out, "ERROR_CODES", errorCodesTable);
  return out;
}) || hasDrift;

hasDrift = applyFile("fallback-ui.html", (raw) => {
  let out = replaceInlineBlock(raw, "META_VERSION", VERSION + " · CommonJS 模块化");
  out = replaceBlock(out, "TOOLS_LINES", fallbackToolsLines);
  return out;
}) || hasDrift;

if (CHECK_ONLY && hasDrift) {
  process.exit(1);
}
if (CHECK_ONLY) {
  console.log("DOCS CHECK PASS (" + Object.keys(TOOLS).length + " tools, v" + VERSION + ")");
}
