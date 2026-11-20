/**
 * dev_cleanup 工具实现：
 * 逆序回放 db/dbStorage/dbCryptoStorage/fs 写日志，暴露 untracked 与 outsideWrites 越界写入清单。
 */
"use strict";

const { killTimers } = require("../shims/timers");

function collectOutsideWrites(journal) {
  const seen = new Set();
  const out = [];
  for (const j of journal) {
    if (!j || j.kind !== "fs" || !j.outside) continue;
    const desc = j.path2 ? j.path + " -> " + j.path2 : (j.path || "");
    if (!seen.has(desc)) {
      seen.add(desc);
      out.push(desc);
    }
  }
  return out;
}

function createCleanupTool(rt, journalApi, getUiFlush) {
  async function devCleanup(cfg) {
    const flushFn = typeof getUiFlush === "function" ? getUiFlush() : null;
    if (flushFn) {
      try { await flushFn(); } catch (_) {}
    }

    const REAL = rt.REAL;
    const force = !!(cfg && cfg.force);
    const dropAll = !!(cfg && cfg.dropAll);
    const stats = {
      dbRestore: 0, dbDelete: 0, kvRestore: 0, kvDelete: 0,
      kvCryptoRestore: 0, kvCryptoDelete: 0, attachment: 0, fsRestore: 0,
    };
    const failures = [];
    const untracked = [];
    const keep = [];
    const outsideWrites = collectOutsideWrites(rt.journal);

    if (dropAll) {
      killTimers(rt.CURRENT_GEN);
      let droppedEntries = 0;
      for (const e of rt.journal) {
        droppedEntries++;
        if (e && e.kind === "fs") journalApi.dropSpills(e);
      }
      rt.journal.length = 0;
      journalApi.cleanupSpillDir();
      rt.spill.pendingRestore = 0;
      rt.spill.truncated = false;
      const out = {
        ok: true,
        restored: stats,
        dropped: true,
        droppedEntries,
        note: "dropAll:已跳过回放直接清空写日志(丢弃 " + droppedEntries + " 条),现场保持现状;dropAll 优先于 force",
      };
      if (outsideWrites.length) out.outsideWrites = outsideWrites;
      return out;
    }

    const dbPutRestore = (doc, id) => {
      const cur = journalApi._safeGet(id);
      const payload = Object.assign({}, doc);
      delete payload._rev;
      const r = REAL.db.put(cur ? Object.assign(payload, { _rev: cur._rev }) : payload);
      if (r && r.error) throw new Error("db.put 还原失败: " + (r.message || r.error));
    };

    for (let i = rt.journal.length - 1; i >= 0; i--) {
      const j = rt.journal[i];
      if (j.kind === "fs") {
        if (j.untracked) {
          journalApi.dropSpills(j);
          untracked.push(j.op + " " + (j.path2 ? j.path + " -> " + j.path2 : (j.path || "")));
          continue;
        }
        try {
          journalApi.restoreFsEntry(j);
          stats.fsRestore++;
        } catch (e) {
          j.retryable = true;
          keep.unshift(j);
          failures.push("fs." + j.op + " " + (j.path || "") + ": " + ((e && e.message) || e) + " (retryable)");
        }
        continue;
      }
      try {
        if (j.kind === "put") {
          if (j.prev) { dbPutRestore(j.prev, j.id); stats.dbRestore++; }
          else {
            const cur = journalApi._safeGet(j.id);
            if (cur) {
              const r = REAL.db.remove(cur);
              if (r && r.error) throw new Error("db.remove 还原失败: " + (r.message || r.error));
              stats.dbDelete++;
            } else if (j.curRev) {
              const r = REAL.db.remove({ _id: j.id, _rev: j.curRev });
              if (r && r.error) throw new Error("db.remove(curRev) 还原失败: " + (r.message || r.error));
              stats.dbDelete++;
            } else {
              failures.push(j.api + " " + j.id + ": 无前态且无法定位当前文档");
            }
          }
        } else if (j.kind === "remove") {
          if (j.prev) { dbPutRestore(j.prev, j.id); stats.dbRestore++; }
        } else if (j.kind === "bulkDocs") {
          for (const p of j.prevs || []) {
            if (p.doc) { dbPutRestore(p.doc, p.id); stats.dbRestore++; }
            else {
              const cur = journalApi._safeGet(p.id);
              if (cur) {
                const r = REAL.db.remove(cur);
                if (r && r.error) throw new Error("db.remove 还原失败: " + (r.message || r.error));
                stats.dbDelete++;
              }
            }
          }
        } else if (j.kind === "attachment") {
          if (j.prev) { dbPutRestore(j.prev, j.id); stats.dbRestore++; }
          else {
            const cur = journalApi._safeGet(j.id);
            if (cur) {
              const r = REAL.db.remove(cur);
              if (r && r.error) throw new Error("db.remove(附件) 还原失败: " + (r.message || r.error));
              stats.attachment++;
            }
          }
        } else if (j.kind === "kv") {
          const store = j.crypto ? REAL.dbCryptoStorage : REAL.dbStorage;
          if (j.prev === undefined || j.prev === null) {
            store.removeItem(j.key);
            if (j.crypto) stats.kvCryptoDelete++;
            else stats.kvDelete++;
          } else {
            store.setItem(j.key, j.prev);
            if (j.crypto) stats.kvCryptoRestore++;
            else stats.kvRestore++;
          }
        }
      } catch (e) {
        j.retryable = true;
        keep.unshift(j);
        failures.push(j.api + " " + (j.id || j.key || "") + ": " + ((e && e.message) || e) + " (retryable)");
      }
    }

    if (force) {
      for (const e of keep) journalApi.dropSpills(e);
      keep.length = 0;
    }
    rt.journal.length = 0;
    for (const e of keep) rt.journal.push(e);
    if (rt.journal.length === 0) {
      journalApi.cleanupSpillDir();
      rt.spill.pendingRestore = 0;
    } else {
      journalApi.rewriteJournalFile();
    }
    killTimers(rt.CURRENT_GEN);

    const out = {
      ok: true,
      restored: stats,
      failures,
      note: "网络/进程副作用不在回收范围;fs 前态已按写日志还原(超限项见 untracked)",
    };
    if (untracked.length) out.untracked = untracked;
    if (outsideWrites.length) out.outsideWrites = outsideWrites;
    if (rt.spill.truncated) {
      out.truncated = true;
      if (rt.journal.length === 0) rt.spill.truncated = false;
    }
    if (rt.spill.pendingRestore > 0) out.pendingRestore = rt.spill.pendingRestore;
    if (force) out.forced = true;
    return out;
  }

  return { devCleanup };
}

module.exports = { createCleanupTool };
