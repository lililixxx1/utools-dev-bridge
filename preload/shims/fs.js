/**
 * fs / fs/promises WAL 写日志替身：
 * 覆盖 callback / *Sync / promises 三套变体，执行真实文件操作前先落盘前态，失败则自动回滚日志。
 */
"use strict";

const fs = require("fs");
const { FS_JOURNAL_OP_NAMES } = require("../contract");

function makeFsWrapFn(name, realFn, gen, journalApi, recordCall) {
  const op = name.replace(/Sync$/, "");
  return function (...args) {
    let entry = null;
    try {
      entry = journalApi.journalFsOp(op, args, gen);
    } catch (e) {
      recordCall("fs." + name, args, undefined, e);
      throw e;
    }
    const flags = {
      untracked: !!(entry && entry.untracked),
      outside: !!(entry && entry.outside),
    };
    const rollback = () => {
      if (entry) journalApi.removeJournalEntry(entry);
    };
    try {
      const res = realFn.apply(fs, args);
      if (res && typeof res.then === "function") res.catch(() => rollback());
      recordCall("fs." + name, args, res, null, flags);
      return res;
    } catch (e) {
      rollback();
      recordCall("fs." + name, args, undefined, e, flags);
      throw e;
    }
  };
}

function makeFsPromisesShim(gen, journalApi, recordCall) {
  const real = fs.promises;
  const shim = Object.create(null);
  for (const k of Object.getOwnPropertyNames(real)) {
    const v = real[k];
    shim[k] = typeof v === "function" && FS_JOURNAL_OP_NAMES.has(k)
      ? makeFsWrapFn(k, v, gen, journalApi, recordCall)
      : v;
  }
  return shim;
}

function makeFsShim(gen, journalApi, recordCall) {
  const shim = Object.create(null);
  for (const k of Object.keys(fs)) {
    if (k === "promises") continue;
    const v = fs[k];
    shim[k] = typeof v === "function" && FS_JOURNAL_OP_NAMES.has(k.replace(/Sync$/, ""))
      ? makeFsWrapFn(k, v, gen, journalApi, recordCall)
      : v;
  }
  shim.promises = makeFsPromisesShim(gen, journalApi, recordCall);
  return shim;
}

module.exports = { makeFsShim, makeFsPromisesShim };
