/**
 * console 录制替身：补全 table/time/group/assert 等常用方法，按 reveal 开关自动脱敏。
 */
"use strict";

const { ser } = require("../serialize");

const CONSOLE_METHODS = [
  "log", "info", "warn", "error", "debug", "table", "trace", "dir",
  "time", "timeEnd", "timeLog", "timeStamp", "group", "groupEnd", "groupCollapsed",
  "clear", "assert", "count", "countReset", "dirxml", "profile", "profileEnd",
];

function makeConsole(rt, opts) {
  const onConsole = opts && opts.onConsole;
  const wrap = (level) => (...args) => {
    const redact = !rt.isRevealActive();
    const entry = {
      seq: ++rt.consoleSeq,
      ts: new Date().toISOString(),
      level,
      args: args.map((a) => ser(a, true, { redact })),
    };
    rt.pushRing(rt.ringConsole, entry);
    if (onConsole) onConsole(entry);
  };
  const out = {};
  for (const m of CONSOLE_METHODS) {
    out[m] = m === "assert"
      ? (cond, ...args) => { if (!cond) wrap("error")(...args); }
      : wrap(m);
  }
  return out;
}

module.exports = { makeConsole };
