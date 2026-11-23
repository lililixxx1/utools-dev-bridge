#!/usr/bin/env node
/**
 * 打包暂存脚本：仅复制 uTools 插件运行时必需文件（plugin.json / logo.png / fallback-ui.html / preload/**），
 * 默认输出到 dist/ 并自检禁止包含 test/ / scripts/ / skills/ / docs/ / 根 package.json，便于 uTools 开发者工具打包 .upx。
 * 用法：
 *   node scripts/pack-stage.js --dry-run
 *   node scripts/pack-stage.js [输出目录，默认 ./dist]
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const dryRun = process.argv.includes("--dry-run");
const argDir = process.argv.slice(2).find((a) => !a.startsWith("-"));
const outDir = argDir ? path.resolve(argDir) : path.join(ROOT, "dist");

const INCLUDE_FILES = ["plugin.json", "logo.png", "fallback-ui.html"];
const INCLUDE_DIRS = ["preload"];
const REQUIRED_RUNTIME_FILES = [
  "plugin.json",
  "logo.png",
  "fallback-ui.html",
  "preload/index.js",
  "preload/ui-host.html",
  "preload/ui-preload.js",
];
const FORBIDDEN_TOP_ENTRIES = [
  "test", "scripts", "skills", "docs",
  "package.json", "README.md", "AGENTS.md", "CHANGELOG.md", "PLAN.md",
  ".git", ".gitignore", "node_modules",
];

function collectFiles(relDir, acc) {
  const abs = path.join(ROOT, relDir);
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(relDir, ent.name);
    if (ent.isDirectory()) collectFiles(rel, acc);
    else if (ent.isFile()) acc.push(rel);
  }
}

function walkDir(dir, acc) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) walkDir(abs, acc);
    else if (ent.isFile()) acc.push(abs);
  }
}

function verifyStagedDir(dir) {
  for (const rel of REQUIRED_RUNTIME_FILES) {
    const p = path.join(dir, rel);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
      throw new Error("打包产物缺少运行必需文件: " + rel);
    }
  }
  for (const entry of FORBIDDEN_TOP_ENTRIES) {
    if (fs.existsSync(path.join(dir, entry))) {
      throw new Error("打包产物存在禁止残留项: " + entry);
    }
  }
  const allFiles = [];
  walkDir(dir, allFiles);
  for (const abs of allFiles) {
    if (/\.test\.js$/i.test(abs)) {
      throw new Error("打包产物禁止包含测试文件: " + path.relative(dir, abs));
    }
  }
  const pj = JSON.parse(fs.readFileSync(path.join(dir, "plugin.json"), "utf8"));
  for (const field of ["main", "preload", "logo"]) {
    if (!pj[field]) throw new Error("plugin.json 缺少字段: " + field);
    const resolved = path.resolve(dir, pj[field]);
    const rel = path.relative(dir, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error("plugin.json." + field + " 未指向发行包内真实文件: " + pj[field]);
    }
  }
}

const files = [...INCLUDE_FILES];
for (const d of INCLUDE_DIRS) collectFiles(d, files);

if (dryRun) {
  console.log("PACK STAGE DRY-RUN (" + files.length + " files):");
  for (const f of files) console.log("  " + f.replace(/\\/g, "/"));
  process.exit(0);
}

if (outDir === ROOT) {
  throw new Error("拒绝以仓库根目录作为输出目录，请使用 dist/ 或其它独立目录");
}

fs.rmSync(outDir, { recursive: true, force: true });
let totalBytes = 0;
for (const rel of files) {
  const src = path.join(ROOT, rel);
  const dst = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  totalBytes += fs.statSync(dst).size;
}
verifyStagedDir(outDir);
const kb = (totalBytes / 1024).toFixed(1);
console.log("STAGED " + files.length + " files (" + totalBytes + " bytes / " + kb + " KB) -> " + outDir);
console.log("请在 uTools 开发者工具中选择该目录打包 .upx（勿直接打包仓库根目录）");
