/**
 * 运行时状态工厂：每代际/每次加载独立持有状态，避免子模块顶层单例在热重载或重建时相互污染。
 */
"use strict";

const { LIMITS } = require("./contract");

function createState(REAL) {
  const nativeId = REAL && REAL.getNativeId ? REAL.getNativeId() : "local";
  const ns = "devbridge:" + String(nativeId).slice(0, 12) + ":";

  const rt = {
    REAL,
    ns,
    ringConsole: { buf: [], start: 0 },
    ringCalls: { buf: [], start: 0 },
    consoleSeq: 0,
    callsSeq: 0,
    journal: [],
    jobs: [],
    jobSeq: 0,
    CURRENT_GEN: null,
    lastConfig: null,
    chain: Promise.resolve(),
    uiSession: null,
    spill: {
      seq: 0,
      bytes: 0,
      truncated: false,
      pendingRestore: 0,
      wiped: false,
      dir: null,
      dirReady: false,
    },
    deniedModuleCache: new Map(),
    deniedNodeCache: new Map(),

    err(code, message) {
      const e = new Error(message);
      e.__devErr = true;
      e.code = code;
      return e;
    },

    // 均摊 O(1) 环形写入：越界槽置 undefined 释放引用，满一轮才物理压缩
    pushRing(ring, entry) {
      ring.buf.push(entry);
      if (ring.buf.length - ring.start > LIMITS.RING_MAX) {
        ring.buf[ring.start] = undefined;
        ring.start++;
        if (ring.start >= LIMITS.RING_MAX) {
          ring.buf.splice(0, ring.start);
          ring.start = 0;
        }
      }
    },

    ringItems(ring) {
      return ring.buf.slice(ring.start);
    },

    readRing(ring, since, clear) {
      const live = ring.buf.slice(ring.start);
      const s = Number(since) || 0;
      const idx = live.findIndex((e) => e.seq > s);
      const expired = s > 0 && live.length > 0 && live[0].seq > s + 1;
      const entries = idx >= 0 ? live.slice(idx) : [];
      const out = {
        ok: true,
        entries,
        count: entries.length,
        to: entries.length ? entries[entries.length - 1].seq : s,
      };
      if (expired) {
        out.expired = true;
        out.hint = "since 已被环形覆盖,本次为当前全量;下次请用返回的 to 做游标";
      }
      if (clear) {
        ring.buf.length = 0;
        ring.start = 0;
      }
      return out;
    },

    // 内联日志切片：支持过滤探针条目与上限截断，返回 { items, more }
    sliceRingSince(ring, since, cap, excludeProbe) {
      const limit = cap || LIMITS.INLINE_LOG_CAP;
      const s = Number(since) || 0;
      const matched = [];
      for (let i = ring.start; i < ring.buf.length; i++) {
        const e = ring.buf[i];
        if (!e || e.seq <= s) continue;
        if (excludeProbe && String(e.api || "").indexOf("probe.") === 0) continue;
        matched.push(e);
      }
      return {
        items: matched.slice(0, limit),
        more: matched.length > limit,
      };
    },

    serialized(fn) {
      return function (args) {
        const p = rt.chain.then(() => fn(args || {}));
        rt.chain = p.catch(() => {});
        return p;
      };
    },

    persistLast(cfg) {
      rt.lastConfig = cfg;
      try {
        if (rt.REAL && rt.REAL.dbStorage) {
          rt.REAL.dbStorage.setItem(rt.ns + "last", JSON.stringify(cfg));
        }
      } catch (_) {}
    },

    restoreLast() {
      if (rt.lastConfig) return rt.lastConfig;
      try {
        if (rt.REAL && rt.REAL.dbStorage) {
          const raw = rt.REAL.dbStorage.getItem(rt.ns + "last");
          if (raw) {
            rt.lastConfig = JSON.parse(raw);
            return rt.lastConfig;
          }
        }
      } catch (_) {}
      return null;
    },

    clearLast() {
      rt.lastConfig = null;
      try {
        if (rt.REAL && rt.REAL.dbStorage) {
          rt.REAL.dbStorage.removeItem(rt.ns + "last");
        }
      } catch (_) {}
    },

    isRevealActive() {
      return !!(rt.CURRENT_GEN && rt.CURRENT_GEN.reveal);
    },
  };

  return rt;
}

module.exports = { createState };
