/**
 * WAL 写日志与副作用还原引擎：
 * - db / dbStorage / dbCryptoStorage 调用前抓前态，成功后入账
 * - fs 写操作前态二进制落盘 spill，再执行真实写入
 * - NDJSON 增量追加到插件本地数据目录 devbridge-spill/，兼容旧 temp 目录与 journal.json 迁移
 * - 越出目标插件根目录的 fs 写标 outside:true 并在 cleanup 单列
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { LIMITS, FS_DESTRUCTIVE_OPS } = require("./contract");
const { _isThenable } = require("./serialize");

const JOURNAL_FILE = "journal.ndjson";
const JOURNAL_LEGACY_FILE = "journal.json";

function isOutsideTarget(targetRoot, filePath) {
  if (!targetRoot || !filePath || typeof filePath !== "string") return false;
  const resolvedRoot = path.resolve(targetRoot);
  const resolvedPath = path.resolve(filePath);
  const cmpRoot = process.platform === "win32" ? resolvedRoot.toLowerCase() : resolvedRoot;
  const cmpPath = process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
  const rel = path.relative(cmpRoot, cmpPath);
  if (!rel) return false;
  return rel.startsWith("..") || path.isAbsolute(rel);
}

function createJournal(rt, opts) {
  const REAL = rt.REAL;
  const onEntry = opts && opts.onEntry;
  const onRollback = opts && opts.onRollback;
  let localEntrySeq = 0;

  function _safeGet(id) {
    try { return REAL.db.get(id) || null; } catch (_) { return null; }
  }

  function isJournaledApi(api) {
    return /^utools\.db(\.promises)?\.(put|remove|bulkDocs|postAttachment)$/.test(api)
      || /^utools\.db(Crypto)?Storage\.(set|remove)Item$/.test(api);
  }

  function capturePre(api, args) {
    try {
      if (/\.db(\.promises)?\.put$/.test(api)) {
        const doc = args && args[0];
        return doc && doc._id ? { kind: "put", id: doc._id, prev: _safeGet(doc._id) } : null;
      }
      if (/\.db(\.promises)?\.remove$/.test(api)) {
        const a = args && args[0];
        const id = typeof a === "string" ? a : a && a._id;
        return id ? { kind: "remove", id, prev: _safeGet(id) } : null;
      }
      if (/\.db(\.promises)?\.bulkDocs$/.test(api)) {
        const docs = (args && args[0]) || [];
        return { kind: "bulkDocs", prevs: docs.filter((d) => d && d._id).map((d) => ({ id: d._id, doc: _safeGet(d._id) })) };
      }
      if (/\.db(\.promises)?\.postAttachment$/.test(api)) {
        const aid = args && args[0];
        return { kind: "attachment", id: aid, prev: _safeGet(aid) };
      }
      if (/Storage\.(set|remove)Item$/.test(api)) {
        const key = args && args[0];
        const crypto = /dbCryptoStorage/.test(api);
        const store = crypto ? REAL.dbCryptoStorage : REAL.dbStorage;
        let prev;
        try { prev = store.getItem(key); } catch (_) { prev = undefined; }
        return { kind: "kv", key, prev, crypto, del: /removeItem$/.test(api) };
      }
    } catch (_) {}
    return null;
  }

  function journalDir() {
    if (rt.spill.dir) return rt.spill.dir;
    let base;
    try {
      const d = REAL.getPluginLocalDataPath && REAL.getPluginLocalDataPath();
      if (d && typeof d === "string") base = d;
    } catch (_) {}
    if (!base) {
      try {
        const t = REAL.getPath && REAL.getPath("temp");
        if (t && typeof t === "string") base = t;
      } catch (_) {}
    }
    if (!base) base = os.tmpdir();
    rt.spill.dir = path.join(base, "devbridge-spill");
    return rt.spill.dir;
  }

  function legacyJournalDir() {
    try {
      const t = REAL.getPath && REAL.getPath("temp");
      if (t && typeof t === "string") return path.join(t, "devbridge-journal");
    } catch (_) {}
    return path.join(os.tmpdir(), "devbridge-journal");
  }

  function ensureJournalDir() {
    if (rt.spill.dirReady) return;
    fs.mkdirSync(journalDir(), { recursive: true });
    rt.spill.dirReady = true;
  }

  function spillPath(file) {
    return path.join(journalDir(), file);
  }

  function writeSpillBuffer(buf) {
    const file = "pre-" + process.pid + "-" + Date.now() + "-" + (++rt.spill.seq) + ".bin";
    try {
      ensureJournalDir();
      fs.writeFileSync(spillPath(file), buf);
    } catch (first) {
      if (!first || first.code !== "ENOENT") throw first;
      rt.spill.dirReady = false;
      ensureJournalDir();
      fs.writeFileSync(spillPath(file), buf);
    }
    rt.spill.bytes += buf.length;
    return { file, size: buf.length };
  }

  function dropSpills(entry) {
    for (const s of entry.spills || []) {
      try { fs.unlinkSync(spillPath(s.file)); } catch (_) {}
      rt.spill.bytes -= s.size;
    }
  }

  function evictSpillOverCap() {
    let evicted = false;
    while (rt.spill.bytes > LIMITS.FS_SPILL_CAP) {
      const e = rt.journal.find((j) => j.spills && j.spills.length && !j.spillLost);
      if (!e) break;
      dropSpills(e);
      e.spillLost = true;
      rt.spill.truncated = true;
      evicted = true;
    }
    return evicted;
  }

  function rewriteJournalFile() {
    try {
      ensureJournalDir();
      const parts = [];
      for (const e of rt.journal) parts.push(JSON.stringify(e));
      const tmp = spillPath(JOURNAL_FILE + ".tmp");
      fs.writeFileSync(tmp, parts.length ? parts.join("\n") + "\n" : "");
      fs.renameSync(tmp, spillPath(JOURNAL_FILE));
      return true;
    } catch (_) {
      return false;
    }
  }

  function appendJournalEntry(e) {
    const line = JSON.stringify(e) + "\n";
    try {
      ensureJournalDir();
      fs.appendFileSync(spillPath(JOURNAL_FILE), line);
      return;
    } catch (first) {
      if (first && first.code === "ENOENT") {
        rt.spill.dirReady = false;
        try {
          ensureJournalDir();
          fs.appendFileSync(spillPath(JOURNAL_FILE), line);
          return;
        } catch (_) {}
      }
    }
    if (!rewriteJournalFile()) rt.spill.truncated = true;
  }

  function migrateLegacySpill() {
    try {
      const from = legacyJournalDir();
      const to = journalDir();
      if (from === to || !fs.existsSync(from)) return;
      ensureJournalDir();
      for (const f of fs.readdirSync(from)) {
        if (!/^pre-.*\.bin$/.test(f) && f !== JOURNAL_LEGACY_FILE && f !== JOURNAL_LEGACY_FILE + ".tmp"
          && f !== JOURNAL_FILE && f !== JOURNAL_FILE + ".tmp") continue;
        const src = path.join(from, f);
        const dst = path.join(to, f);
        if (fs.existsSync(dst)) { try { fs.unlinkSync(src); } catch (_) {} continue; }
        try { fs.renameSync(src, dst); }
        catch (_) {
          try {
            fs.copyFileSync(src, dst);
            if (fs.statSync(src).size !== fs.statSync(dst).size) { try { fs.unlinkSync(dst); } catch (_) {} continue; }
            fs.unlinkSync(src);
          } catch (_) { continue; }
        }
      }
      try { fs.rmdirSync(from); } catch (_) {}
    } catch (_) {}
  }

  function cleanStaleSpill() {
    try {
      const dir = journalDir();
      if (!fs.existsSync(dir)) return false;
      const now = Date.now();
      let files = 0;
      let stale = 0;
      for (const f of fs.readdirSync(dir)) {
        files++;
        try {
          if (now - fs.statSync(path.join(dir, f)).mtimeMs > LIMITS.SPILL_STALE_MS) stale++;
        } catch (_) {}
      }
      if (!files || stale < files) return false;
      for (const f of fs.readdirSync(dir)) { try { fs.unlinkSync(path.join(dir, f)); } catch (_) {} }
      try { fs.rmdirSync(dir); } catch (_) {}
      rt.spill.bytes = 0;
      rt.spill.dirReady = false;
      rt.spill.wiped = true;
      return true;
    } catch (_) {
      return false;
    }
  }

  function restoreJournalMeta() {
    try {
      migrateLegacySpill();
      if (cleanStaleSpill()) return;
      const entries = [];
      const fin = spillPath(JOURNAL_FILE);
      if (fs.existsSync(fin)) {
        for (const line of fs.readFileSync(fin, "utf8").split("\n")) {
          if (!line) continue;
          try {
            const e = JSON.parse(line);
            if (e && typeof e === "object") entries.push(e);
            else rt.spill.truncated = true;
          } catch (_) {
            rt.spill.truncated = true;
          }
        }
      } else {
        const legacy = spillPath(JOURNAL_LEGACY_FILE);
        if (fs.existsSync(legacy)) {
          try {
            const arr = JSON.parse(fs.readFileSync(legacy, "utf8"));
            if (Array.isArray(arr)) entries.push(...arr);
          } catch (_) {}
        }
      }
      const converted = !fs.existsSync(fin) && entries.length > 0;
      for (const e of entries) {
        for (const s of e.spills || []) {
          try { rt.spill.bytes += fs.statSync(spillPath(s.file)).size; }
          catch (_) { e.spillLost = true; rt.spill.truncated = true; }
        }
        rt.journal.push(e);
      }
      if (converted && rewriteJournalFile()) {
        try { fs.unlinkSync(spillPath(JOURNAL_LEGACY_FILE)); } catch (_) {}
      }
      rt.spill.pendingRestore = rt.journal.length;
    } catch (_) {}
  }

  function pushJournalEntry(e) {
    if (onEntry) {
      e._uid = process.pid + "-" + (++localEntrySeq);
      rt.journal.push(e);
      onEntry(e);
      return;
    }
    let dirtyOld = false;
    while (rt.journal.length >= LIMITS.JOURNAL_MAX) {
      const old = rt.journal.shift();
      dropSpills(old);
      rt.spill.truncated = true;
      dirtyOld = true;
    }
    rt.journal.push(e);
    if (evictSpillOverCap()) dirtyOld = true;
    if (dirtyOld) {
      if (!rewriteJournalFile()) rt.spill.truncated = true;
    } else {
      appendJournalEntry(e);
    }
  }

  function removeJournalEntry(entry) {
    if (!entry) return;
    const idx = rt.journal.indexOf(entry);
    if (idx >= 0) rt.journal.splice(idx, 1);
    dropSpills(entry);
    if (onRollback && entry._uid) {
      onRollback(entry._uid);
      return;
    }
    if (!onEntry) rewriteJournalFile();
  }

  function removeJournalByUid(uid) {
    if (!uid) return;
    const idx = rt.journal.findIndex((e) => e && e._uid === uid);
    if (idx < 0) return;
    const [removed] = rt.journal.splice(idx, 1);
    dropSpills(removed);
    if (!onEntry) rewriteJournalFile();
  }

  function commitJournal(pre, api, result) {
    const push = (curRev) => {
      const e = { api, ts: new Date().toISOString() };
      if (pre.kind === "put") { e.kind = "put"; e.id = pre.id; e.prev = pre.prev; e.curRev = curRev; }
      else if (pre.kind === "remove") { e.kind = "remove"; e.id = pre.id; e.prev = pre.prev; }
      else if (pre.kind === "bulkDocs") { e.kind = "bulkDocs"; e.prevs = pre.prevs; }
      else if (pre.kind === "attachment") { e.kind = "attachment"; e.id = pre.id; e.prev = pre.prev; }
      else if (pre.kind === "kv") { e.kind = "kv"; e.key = pre.key; e.prev = pre.prev; e.crypto = pre.crypto; e.del = pre.del; }
      pushJournalEntry(e);
    };
    if (_isThenable(result)) {
      result.then(
        (r) => push(Array.isArray(r) ? undefined : r && r._rev),
        () => {}
      );
    } else {
      push(result && result._rev);
    }
  }

  function snapFileStat(p) {
    let st;
    try { st = fs.lstatSync(p); } catch (_) { return { exists: false }; }
    if (st.isSymbolicLink()) {
      let linkTarget = null;
      try { linkTarget = fs.readlinkSync(p); } catch (_) {}
      return { exists: true, isLink: true, linkTarget };
    }
    if (!st.isFile()) return { exists: true, special: true };
    if (st.size > LIMITS.FS_FILE_CAP) return { exists: true, over: true, size: st.size };
    try {
      const spills = [writeSpillBuffer(fs.readFileSync(p))];
      return { exists: true, size: st.size, spills };
    } catch (_) {
      return { exists: true, over: true, size: st.size };
    }
  }

  function snapDirStat(p) {
    const files = [];
    let truncated = false;
    const walk = (dir, rel) => {
      let names;
      try { names = fs.readdirSync(dir); } catch (_) { truncated = true; return; }
      for (const n of names) {
        if (files.length >= LIMITS.FS_DIR_FILES_CAP) { truncated = true; return; }
        const fp = path.join(dir, n);
        const r = rel ? rel + "/" + n : n;
        let st;
        try { st = fs.lstatSync(fp); } catch (_) { continue; }
        if (st.isDirectory()) { walk(fp, r); continue; }
        if (!st.isFile()) continue;
        if (st.size > LIMITS.FS_FILE_CAP) { truncated = true; return; }
        try { files.push({ rel: r, spill: writeSpillBuffer(fs.readFileSync(fp)), size: st.size }); }
        catch (_) { truncated = true; return; }
      }
    };
    walk(p, "");
    if (truncated) return { exists: true, isDir: true, dirSpills: files, truncated: true };
    return { exists: true, isDir: true, dirSpills: files };
  }

  function snapPathAuto(p) {
    let st;
    try { st = fs.lstatSync(p); } catch (_) { return { exists: false }; }
    return st.isDirectory() ? snapDirStat(p) : snapFileStat(p);
  }

  function collectSnapSpills(snap) {
    if (!snap) return [];
    const out = [];
    for (const s of snap.spills || []) out.push(s);
    for (const f of snap.dirSpills || []) out.push(f.spill);
    return out;
  }

  function journalFsOp(op, args, gen) {
    const targetRoot = gen && gen.targetRoot;
    let snapSpecs;
    switch (op) {
      case "writeFile": case "appendFile": case "truncate": case "unlink":
      case "rm": case "rmdir":
        snapSpecs = [["snap", args[0]]];
        break;
      case "mkdir": {
        const recursive = !!(args[1] && (args[1] === true || args[1].recursive));
        if (recursive) {
          const missing = [];
          let cur = path.resolve(String(args[0]));
          while (!fs.existsSync(cur)) {
            missing.push(cur);
            const parent = path.dirname(cur);
            if (parent === cur) break;
            cur = parent;
          }
          const entries = [];
          for (let i = missing.length - 1; i >= 0; i--) {
            const e = { kind: "fs", op: "mkdir", ts: new Date().toISOString(), spills: [], path: missing[i], snap: { exists: false } };
            if (isOutsideTarget(targetRoot, missing[i])) e.outside = true;
            entries.push(e);
          }
          for (const e of entries) pushJournalEntry(e);
          return entries.length ? entries[entries.length - 1] : null;
        }
        snapSpecs = [["snap", args[0]]];
        break;
      }
      case "rename":
        snapSpecs = [["snapFrom", args[0]], ["snapTo", args[1]]];
        break;
      case "copyFile": case "symlink": case "link": case "cp":
        snapSpecs = [["snap", args[1]]];
        break;
      case "mkdtemp": {
        const p0 = String(args[0] || "");
        const e0 = { kind: "fs", op: "mkdtemp", ts: new Date().toISOString(), spills: [], path: p0, untracked: true };
        if (isOutsideTarget(targetRoot, p0)) e0.outside = true;
        pushJournalEntry(e0);
        return e0;
      }
      case "open": {
        const fl = args[1] && typeof args[1] === "object" ? args[1].flags : args[1];
        if (fl === undefined || fl === "r" || fl === "rs" || fl === 0) return null;
        snapSpecs = [["snap", args[0]]];
        break;
      }
      case "createWriteStream": {
        const fl = args[1] && typeof args[1] === "object" ? args[1].flags : args[1];
        if (fl === "r" || fl === "rs") return null;
        snapSpecs = [["snap", args[0]]];
        break;
      }
      default:
        return null;
    }

    const entry = { kind: "fs", op, ts: new Date().toISOString(), spills: [], path: "" };
    try {
      for (const [key, p] of snapSpecs) {
        if (typeof p !== "string") { entry.untracked = true; continue; }
        if (key === "snap" || entry.path === "") entry.path = p;
        if (key === "snapTo") entry.path2 = p;
        if (isOutsideTarget(targetRoot, p)) entry.outside = true;
        const snap = snapPathAuto(p);
        entry[key] = snap;
        entry.spills.push(...collectSnapSpills(snap));
        const over = snap.over || snap.truncated;
        if (over && FS_DESTRUCTIVE_OPS.has(op)) {
          if (gen && gen.allowAllModules) entry.untracked = true;
          else {
            throw rt.err(
              "DENIED_FS_UNTRACKED",
              "[dev-bridge] fs." + op + " 前态超限无法日志化(" + p + "),破坏性操作默认拒绝;dev_load 传 allowHostModules:true 放行(将不可还原)"
            );
          }
        } else if (over) {
          entry.untracked = true;
        }
      }
    } catch (e) {
      dropSpills(entry);
      throw e;
    }
    pushJournalEntry(entry);
    return entry;
  }

  function restoreFsEntry(j) {
    const restoreOne = (snap, p) => {
      if (!snap) return;
      if (snap.exists === false) { try { fs.unlinkSync(p); } catch (_) {} return; }
      if (j.spillLost) throw new Error("spill 已丢失(spill 超限被淘汰),无法还原: " + p);
      if (snap.isLink) {
        try { fs.unlinkSync(p); } catch (_) {}
        fs.symlinkSync(snap.linkTarget || "", p);
        return;
      }
      if (snap.isDir) {
        fs.mkdirSync(p, { recursive: true });
        if (snap.truncated) throw new Error("目录快照不完整,仅还原了 " + (snap.dirSpills || []).length + " 个文件: " + p);
        for (const f of snap.dirSpills || []) {
          const dest = path.join(p, ...String(f.rel).split("/"));
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(spillPath(f.spill.file), dest);
        }
        return;
      }
      if (snap.special) return;
      if (!snap.spills || !snap.spills.length) throw new Error("前态未 spill 化(超限),无法还原: " + p);
      fs.writeFileSync(p, fs.readFileSync(spillPath(snap.spills[0].file)));
    };
    switch (j.op) {
      case "writeFile": case "appendFile": case "truncate": case "copyFile":
      case "open": case "createWriteStream": case "unlink": case "rm": case "rmdir":
        restoreOne(j.snap, j.path);
        break;
      case "mkdir":
        if (j.snap && j.snap.exists) break;
        try { fs.rmdirSync(j.path); } catch (_) {}
        break;
      case "symlink": case "link":
        if (j.snap && j.snap.exists) restoreOne(j.snap, j.path);
        else { try { fs.unlinkSync(j.path); } catch (_) {} }
        break;
      case "rename": {
        const from = j.path;
        const to = j.path2 || "";
        if (j.snapFrom && j.snapFrom.exists) {
          if (j.snapFrom.isDir) {
            fs.rmSync(to, { recursive: true, force: true });
            restoreOne(j.snapFrom, from);
          } else {
            try { fs.renameSync(to, from); } catch (_) { restoreOne(j.snapFrom, from); }
          }
        } else {
          try { fs.unlinkSync(to); } catch (_) {}
        }
        restoreOne(j.snapTo, to);
        break;
      }
      default:
        throw new Error("未知 fs 日志操作: " + j.op);
    }
    dropSpills(j);
  }

  function cleanupSpillDir() {
    try {
      const dir = journalDir();
      for (const f of fs.readdirSync(dir)) {
        if (/^pre-.*\.bin$/.test(f) || f === JOURNAL_FILE || f === JOURNAL_FILE + ".tmp"
          || f === JOURNAL_LEGACY_FILE || f === JOURNAL_LEGACY_FILE + ".tmp") {
          fs.unlinkSync(path.join(dir, f));
        }
      }
      fs.rmdirSync(dir);
    } catch (_) {}
    rt.spill.bytes = 0;
    rt.spill.dirReady = false;
  }

  return {
    journalDir,
    ensureJournalDir,
    spillPath,
    _safeGet,
    isJournaledApi,
    capturePre,
    commitJournal,
    pushJournalEntry,
    removeJournalEntry,
    removeJournalByUid,
    rewriteJournalFile,
    restoreJournalMeta,
    journalFsOp,
    restoreFsEntry,
    dropSpills,
    cleanupSpillDir,
    isOutsideTarget,
  };
}

module.exports = { createJournal, isOutsideTarget };
