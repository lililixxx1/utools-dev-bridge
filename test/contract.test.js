"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TOOLS, LIMITS } = require("../preload/contract");
const { setupBridge } = require("./helpers/mock-utools");

function sumDirBytes(dir) {
  let total = 0;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    total += ent.isDirectory() ? sumDirBytes(abs) : fs.statSync(abs).size;
  }
  return total;
}

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

  it("pack-stage 生成纯净发行包（零 dev/test 残留且独立可加载 13 工具）", () => {
    const tmpStage = fs.mkdtempSync(path.join(os.tmpdir(), "devbridge-stage-"));
    try {
      const stageOut = execFileSync(process.execPath, [path.join(ctx.ROOT, "scripts", "pack-stage.js"), tmpStage], {
        encoding: "utf8",
      });
      assert.match(stageOut, /STAGED/);
      for (const forbid of ["test", "scripts", "skills", "docs", "package.json", "README.md", "AGENTS.md", "CHANGELOG.md", "PLAN.md"]) {
        assert.equal(fs.existsSync(path.join(tmpStage, forbid)), false, "发行包不应包含 " + forbid);
      }
      assert.ok(sumDirBytes(tmpStage) < 450 * 1024, "纯净发行包体积应 < 450KB（实际应远低于含开发残留的 868KB）");

      const bootCheck = [
        '"use strict";',
        'const path = require("path");',
        'const dir = process.env.STAGE_DIR;',
        'const reg = [];',
        'global.utools = { registerTool: (n) => reg.push(n), getNativeId: () => "pkg-check", getPath: () => dir, getPluginLocalDataPath: () => path.join(dir, ".tmpdata") };',
        'Object.freeze(global.utools);',
        'require(path.join(dir, "preload", "index.js"));',
        'console.log("TOOLS:" + JSON.stringify(reg.sort()));',
      ].join("\n");
      const res = spawnSync(process.execPath, ["-e", bootCheck], {
        env: Object.assign({}, process.env, { STAGE_DIR: tmpStage }),
        encoding: "utf8",
        timeout: 15000,
      });
      assert.equal(res.status, 0, res.stderr || res.stdout);
      const m = (res.stdout || "").match(/TOOLS:(\[.*\])/);
      assert.ok(m, "发行包 preload/index.js 应正常初始化");
      assert.deepEqual(JSON.parse(m[1]), Object.keys(TOOLS).sort());
    } finally {
      fs.rmSync(tmpStage, { recursive: true, force: true });
    }
  });
});
