#!/usr/bin/env node
/**
 * 统一本地测试入口（兼容 `node scripts/selftest.js` 命令）：
 * 自动运行 test/*.test.js 全套 node:test 用例并输出兼容摘要。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("node:child_process");

const testDir = path.resolve(__dirname, "..", "test");
const files = fs.readdirSync(testDir)
  .filter((f) => f.endsWith(".test.js"))
  .sort()
  .map((f) => path.join(testDir, f));

const res = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
if (res.status === 0) {
  console.log("\n== SELFTEST ALL PASS ==");
  process.exit(0);
}
console.error("\n== SELFTEST FAILED ==");
process.exit(res.status || 1);
