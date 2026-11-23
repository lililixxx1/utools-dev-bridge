/**
 * dev_run 批量断言运行器：单次网关往返背靠背完成 load + 多步调用断言 + cleanup。
 */
"use strict";

function canonicalValue(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(canonicalValue);
  const out = {};
  for (const k of Object.keys(v).sort()) {
    out[k] = canonicalValue(v[k]);
  }
  return out;
}

function canonicalEq(a, b) {
  return JSON.stringify(canonicalValue(a)) === JSON.stringify(canonicalValue(b));
}

function getByPath(obj, dotPath) {
  if (!dotPath) return obj;
  const parts = String(dotPath).split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

function checkType(val, expectedType) {
  if (expectedType === "null") return val === null;
  if (expectedType === "array") return Array.isArray(val);
  if (val === null) return false;
  if (Array.isArray(val)) return expectedType === "array";
  return typeof val === expectedType;
}

function assertExpect(res, expect, stepConsole, stepCalls) {
  const failures = [];
  if (!expect) {
    if (res.ok !== true) {
      failures.push("期望 ok===true, 实际 ok=false" + (res.code ? " (" + res.code + ")" : ""));
    }
    return failures;
  }

  const wantOk = expect.ok !== undefined ? expect.ok : (expect.code ? false : true);
  if (res.ok !== wantOk) {
    failures.push("期望 ok===" + wantOk + ", 实际 ok=" + res.ok + (res.code ? " (" + res.code + ")" : ""));
  }
  if (expect.code !== undefined && res.code !== expect.code) {
    failures.push("期望 code===" + expect.code + ", 实际 " + res.code);
  }

  const val = expect.path ? getByPath(res, expect.path) : res.result;

  if ("eq" in expect && !canonicalEq(val, expect.eq)) {
    failures.push("期望 eq " + JSON.stringify(expect.eq) + ", 实际 " + JSON.stringify(val));
  }
  if ("ne" in expect && canonicalEq(val, expect.ne)) {
    failures.push("期望 ne " + JSON.stringify(expect.ne) + ", 实际相等");
  }
  if (expect.gt !== undefined && !(typeof val === "number" && val > expect.gt)) {
    failures.push("期望 > " + expect.gt + ", 实际 " + JSON.stringify(val));
  }
  if (expect.gte !== undefined && !(typeof val === "number" && val >= expect.gte)) {
    failures.push("期望 >= " + expect.gte + ", 实际 " + JSON.stringify(val));
  }
  if (expect.lt !== undefined && !(typeof val === "number" && val < expect.lt)) {
    failures.push("期望 < " + expect.lt + ", 实际 " + JSON.stringify(val));
  }
  if (expect.lte !== undefined && !(typeof val === "number" && val <= expect.lte)) {
    failures.push("期望 <= " + expect.lte + ", 实际 " + JSON.stringify(val));
  }
  if ("contains" in expect) {
    const okContains = Array.isArray(val)
      ? val.some((x) => canonicalEq(x, expect.contains))
      : String(val == null ? "" : val).indexOf(String(expect.contains)) >= 0;
    if (!okContains) failures.push("期望 contains " + JSON.stringify(expect.contains));
  }
  if (expect.matches !== undefined) {
    let re;
    try { re = new RegExp(expect.matches); } catch (e) { re = null; }
    if (!re || !re.test(String(val == null ? "" : val))) {
      failures.push("期望 matches /" + expect.matches + "/, 实际 " + JSON.stringify(val));
    }
  }
  if (expect.truthy !== undefined && Boolean(val) !== expect.truthy) {
    failures.push("期望 truthy===" + expect.truthy + ", 实际 " + JSON.stringify(val));
  }
  if (expect.type !== undefined && !checkType(val, expect.type)) {
    failures.push("期望 type===" + expect.type + ", 实际 " + (val === null ? "null" : (Array.isArray(val) ? "array" : typeof val)));
  }
  if (expect.hasCall !== undefined) {
    const hit = stepCalls.some((c) => String(c.api || "").indexOf(expect.hasCall) === 0);
    if (!hit) failures.push("期望调用流水含 '" + expect.hasCall + "'");
  }
  if (expect.hasConsole !== undefined) {
    const hit = stepConsole.some((c) => JSON.stringify(c.args).indexOf(expect.hasConsole) >= 0);
    if (!hit) failures.push("期望 console 含 '" + expect.hasConsole + "'");
  }
  return failures;
}

function createRunTool(rt, loadApi, callApi, cleanupApi) {
  async function devRun(cfg) {
    const t0 = Date.now();
    const stopOnFail = !cfg || cfg.stopOnFail !== false;
    const steps = cfg && Array.isArray(cfg.steps) ? cfg.steps : null;
    if (!steps || !steps.length) {
      throw rt.err("INVALID_ARGS", "dev_run 需要非空 steps 数组");
    }

    let loadSummary = null;
    if (cfg.load) {
      try {
        const lr = loadApi.devLoad(cfg.load);
        loadSummary = {
          ok: true,
          entry: lr.entry,
          exportsCount: lr.exportsCount,
          exportsHash: lr.exportsHash,
          warnings: lr.warnings,
        };
        if (lr.riskNotice) loadSummary.riskNotice = lr.riskNotice;
      } catch (e) {
        return {
          ok: false,
          stage: "load",
          code: (e && e.code) || "ERROR",
          message: String((e && e.message) || e),
          total: steps.length,
          passed: 0,
          failed: 0,
          skipped: steps.length,
          durationMs: Date.now() - t0,
        };
      }
    }

    const stepResults = [];
    let passed = 0;
    let failed = 0;
    let skipped = 0;

    try {
      for (let i = 0; i < steps.length; i++) {
        const st = steps[i] || {};
        const callName = st.call || st.name;
        const label = st.label || callName || ("step-" + i);
        let res;
        try {
          if (!callName) throw rt.err("INVALID_ARGS", "步骤缺少 call 名称");
          res = await callApi.executeCall(
            { name: callName, args: st.args || [], timeoutMs: st.timeoutMs, include: st.include },
            {}
          );
        } catch (e) {
          res = {
            ok: false,
            code: (e && e.code) || "ERROR",
            message: String((e && e.message) || e),
            durationMs: 0,
            consoleFrom: rt.consoleSeq,
            callsFrom: rt.callsSeq,
          };
        }

        const stepConsole = rt.sliceRingSince(rt.ringConsole, res.consoleFrom, 500, false).items;
        const stepCalls = rt.sliceRingSince(rt.ringCalls, res.callsFrom, 500, true).items;
        const failures = assertExpect(res, st.expect, stepConsole, stepCalls);
        const pass = failures.length === 0;
        if (pass) passed++;
        else failed++;

        const rec = {
          index: i,
          label,
          call: callName,
          pass,
          ok: res.ok,
          durationMs: res.durationMs,
        };
        if (res.result !== undefined) rec.result = res.result;
        if (!res.ok) {
          rec.code = res.code;
          rec.message = res.message;
        }
        if (res.console) rec.console = res.console;
        if (res.calls) rec.calls = res.calls;
        if (!pass) rec.failures = failures;
        stepResults.push(rec);

        if (!pass && stopOnFail) {
          skipped = steps.length - i - 1;
          break;
        }
      }
    } finally {
      if (cfg.cleanup) {
        try {
          cfg._cleanupRes = await cleanupApi.devCleanup({});
        } catch (e) {
          cfg._cleanupRes = { ok: false, code: (e && e.code) || "ERROR", message: String((e && e.message) || e) };
        }
      }
    }

    const out = {
      ok: failed === 0,
      total: steps.length,
      passed,
      failed,
      skipped,
      durationMs: Date.now() - t0,
      steps: stepResults,
    };
    if (loadSummary) out.load = loadSummary;
    if (cfg.cleanup && cfg._cleanupRes) out.cleanup = cfg._cleanupRes;
    return out;
  }

  return { devRun };
}

module.exports = { createRunTool, assertExpect, getByPath };
