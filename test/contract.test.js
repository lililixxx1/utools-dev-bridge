"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { TOOLS, LIMITS } = require("../preload/contract");
const { setupBridge } = require("./helpers/mock-utools");

describe("契约单一来源与 8.0 清单校验", () => {
  const ctx = setupBridge();
  after(() => ctx.cleanup());

  it("gen-docs.js --check 零漂移", () => {
    const out = execFileSync(process.execPath, [path.join(ctx.ROOT, "scripts", "gen-docs.js"), "--check"], {
      encoding: "utf8",
    });
    assert.match(out, /DOCS CHECK PASS/);
  });

  it("plugin.json 工具清单与 preload 顶层注册完全一致（13 工具）", () => {
    const pj = JSON.parse(fs.readFileSync(path.join(ctx.ROOT, "plugin.json"), "utf8"));
    const pjNames = Object.keys(pj.tools).sort();
    const contractNames = Object.keys(TOOLS).sort();
    const regNames = Object.keys(ctx.tools).sort();
    assert.equal(pjNames.length, 13);
    assert.deepEqual(pjNames, contractNames);
    assert.deepEqual(regNames, contractNames);
    assert.ok(Array.isArray(pj.features) && pj.features.length >= 1, "8.0 校验必填 features");
    for (const [k, v] of Object.entries(pj.tools)) {
      assert.ok(typeof v.description === "string" && v.description.length > 0 && v.description.length <= LIMITS.DESCRIPTION_MAX_LEN,
        k + " description 超限或为空");
      const rawSchema = JSON.stringify(v.inputSchema);
      assert.equal(/"(oneOf|anyOf|allOf|\$ref)"/.test(rawSchema), false, k + " 禁用组合构造");
    }
  });
});
