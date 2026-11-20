/**
 * 跨 realm 预算化序列化器与默认凭证脱敏工具。
 * 重要边界：脱敏只应用于面向 agent 的输出（console/calls_log/devCall 返回值），
 * 写日志（journal）中的前态 prev 绝不脱敏，确保 dev_cleanup 还原真实存储内容。
 */
"use strict";

const { LIMITS } = require("./contract");

const SENSITIVE_FIELD_RE = /\b(token|secret|password|passwd|pwd|api key|access key|private key|credential|cookie|authorization|bearer)\b/i;
const SENSITIVE_KV_KEY_RE = /\b(token|secret|password|passwd|pwd|api key|access key|private key|auth|cookie|credential|bearer|key)\b/i;
const SECRET_VALUE_RE = /^(?:gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,}|sk-[A-Za-z0-9_-]{16,}|Bearer\s+\S{8,})/;
const DIRECT_RESULT_REDACT_APIS = new Set([
  "utools.getNativeId",
  "utools.getUser",
  "utools.getUserServerTemporaryToken",
  "utools.dbCryptoStorage.getItem",
]);

function _normalizeKeyName(k) {
  return String(k || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.:/]+/g, " ");
}

function isSensitiveKey(k) {
  return SENSITIVE_FIELD_RE.test(_normalizeKeyName(k));
}

function isSensitiveKvKey(k) {
  return SENSITIVE_KV_KEY_RE.test(_normalizeKeyName(k));
}

function shouldRedactResultByName(name) {
  return SENSITIVE_FIELD_RE.test(_normalizeKeyName(name));
}

function redactValue(v) {
  if (v === null || v === undefined) return v;
  if (typeof v === "string") return "<redacted len=" + v.length + ">";
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(v)) {
    return "<redacted buffer bytes=" + v.length + ">";
  }
  if (typeof v === "object") {
    let keys = [];
    try { keys = Object.keys(v).slice(0, 12); } catch (_) {}
    return "<redacted object keys=" + keys.join(",") + ">";
  }
  return "<redacted>";
}

function _isThenable(v) {
  return v && typeof v.then === "function";
}

function _budgetStr(s, budget) {
  if (budget.left <= 0) return "[__truncated]";
  const take = Math.min(s.length, budget.left, 200000);
  budget.left -= take;
  return take < s.length ? s.slice(0, take) + "…[__truncated]" : s;
}

function _ser(v, depth, seen, budget, maxDepth, redact) {
  if (v === null || v === undefined) return v;
  const t = typeof v;
  if (t === "boolean") return v;
  if (t === "number") return Number.isFinite(v) ? v : String(v);
  if (t === "bigint") return { __bigint: String(v) };
  if (t === "string") {
    if (redact && SECRET_VALUE_RE.test(v)) return redactValue(v);
    return _budgetStr(v, budget);
  }
  if (t === "function") {
    let name = "(anonymous)", len = -1, head = "";
    try { name = v.name || name; len = v.length; head = String(v).slice(0, 160); } catch (_) {}
    return { __function: true, name, length: len, src: head };
  }
  if (t !== "object") return { __type: t };
  // 跨 realm 判型：vm 内创建的 Error/Date/Map 等对宿主 instanceof 失效，必须用 toString 标签
  const tag = Object.prototype.toString.call(v);
  if (tag === "[object Error]") {
    return { __error: true, name: String(v.name), message: String(v.message), stack: String(v.stack || "").slice(0, 2000) };
  }
  if (tag === "[object Date]") return { __date: v.toISOString ? v.toISOString() : String(v) };
  if (tag === "[object RegExp]") return { __regexp: String(v) };
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(v)) {
    return { __buffer: true, bytes: v.length, head: v.slice(0, 48).toString("base64") };
  }
  if (ArrayBuffer.isView(v)) return { __typedArray: v.constructor.name, bytes: v.byteLength };
  if (seen.has(v)) return "[Circular]";
  if (depth >= maxDepth) return { __depthLimit: true };
  if (_isThenable(v)) return { __promise: true, note: "未 await 的 Promise" };
  seen.add(v);
  try {
    if (Array.isArray(v)) {
      const out = [];
      const n = Math.min(v.length, 100);
      for (let i = 0; i < n; i++) out.push(_ser(v[i], depth + 1, seen, budget, maxDepth, redact));
      if (v.length > n) out.push({ __truncated: true, length: v.length });
      return out;
    }
    if (tag === "[object Map]") {
      const out = [];
      for (const [k, val] of v) {
        if (out.length >= 50) { out.push({ __truncated: true }); break; }
        const sk = _ser(k, depth + 1, seen, budget, maxDepth, redact);
        const sv = redact && typeof k === "string" && isSensitiveKey(k) && val != null
          ? redactValue(val)
          : _ser(val, depth + 1, seen, budget, maxDepth, redact);
        out.push([sk, sv]);
      }
      return { __map: out };
    }
    if (tag === "[object Set]") {
      const out = [];
      for (const val of v) {
        if (out.length >= 100) { out.push({ __truncated: true }); break; }
        out.push(_ser(val, depth + 1, seen, budget, maxDepth, redact));
      }
      return { __set: out };
    }
    const out = {};
    for (const k of Object.keys(v).slice(0, 100)) {
      if (redact && isSensitiveKey(k) && v[k] != null) out[k] = redactValue(v[k]);
      else out[k] = _ser(v[k], depth + 1, seen, budget, maxDepth, redact);
    }
    return out;
  } finally {
    seen.delete(v);
  }
}

function ser(v, digest, opts) {
  const redact = !!(opts && opts.redact);
  const budget = digest ? LIMITS.DIGEST_BUDGET : LIMITS.SER_BUDGET;
  const maxDepth = digest ? 4 : LIMITS.SER_DEPTH;
  try {
    return _ser(v, 0, new WeakSet(), { left: budget }, maxDepth, redact);
  } catch (e) {
    return { __serError: String(e && e.message) };
  }
}

function redactCallPayload(api, args, result, reveal) {
  const list = args || [];
  if (reveal) {
    return {
      args: list.map((a) => ser(a, true, { redact: false })),
      result: result !== undefined ? ser(result, true, { redact: false }) : undefined,
    };
  }
  const serArgs = list.map((a) => ser(a, true, { redact: true }));
  let serResult = result !== undefined ? ser(result, true, { redact: true }) : undefined;

  if (DIRECT_RESULT_REDACT_APIS.has(api) && result != null) {
    serResult = redactValue(result);
  } else if (api === "utools.dbCryptoStorage.setItem" && list.length > 1 && list[1] != null) {
    serArgs[1] = redactValue(list[1]);
  } else if (api === "utools.dbStorage.getItem" && typeof list[0] === "string" && isSensitiveKvKey(list[0]) && result != null) {
    serResult = redactValue(result);
  } else if (api === "utools.dbStorage.setItem" && typeof list[0] === "string" && isSensitiveKvKey(list[0]) && list.length > 1 && list[1] != null) {
    serArgs[1] = redactValue(list[1]);
  }
  return { args: serArgs, result: serResult };
}

module.exports = {
  _isThenable,
  ser,
  isSensitiveKey,
  isSensitiveKvKey,
  shouldRedactResultByName,
  redactValue,
  redactCallPayload,
};
