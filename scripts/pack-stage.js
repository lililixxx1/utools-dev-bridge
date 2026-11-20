#!/usr/bin/env node
/**
 * 打包暂存脚本：仅复制 uTools 插件运行时必需文件（plugin.json / logo.png / fallback-ui.html / preload/**），
 * 排除 test/ / scripts/ / skills/ / docs/ / .git/，便于 uTools 开发者工具直接打包为 .upx。
 * 用法：
 *   node scripts/pack-stage.js --dry-run
 *   node scripts/pack-stage.js [输出目录]
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.resolve(__dirname, "..");
const dryRun = process.argv.includes("--dry-run");
const argDir = process.argv.slice(2).find((a) => !a.startsWith("-"));
const outDir = argDir ? path.resolve(argDir) : path.join(os.tmpdir(), "utools-dev-bridge-stage");

const INCLUDE_FILES = ["plugin.json", "logo.png", "fallback-ui.html"];
const INCLUDE_DIRS = ["preload"];

function collectFiles(relDir, acc) {
  const abs = path.join(ROOT, relDir);
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(relDir, ent.name);
    if (ent.isDirectory()) collectFiles(rel, acc);
    else if (ent.isFile()) acc.push(rel);
  }
}

const files = [...INCLUDE_FILES];
for (const d of INCLUDE_DIRS) collectFiles(d, files);

if (dryRun) {
  console.log("PACK STAGE DRY-RUN (" + files.length + " files):");
  for (const f of files) console.log("  " + f.replace(/\\/g, "/"));
  process.exit(0);
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
console.log("STAGED " + files.length + " files (" + totalBytes + " bytes) -> " + outDir);
