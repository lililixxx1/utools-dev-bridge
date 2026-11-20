/**
 * 极简 DOM stub（仅用于 vm preload 沙箱，选择器恒 null，创建/监听惰性记录）。
 * 若需真实 DOM 渲染与交互测试，使用 dev_ui_open 家族工具。
 */
"use strict";

function makeDomShim(gen, recordCall) {
  const rec = (api, args) => recordCall("dom." + api, args || [], undefined, null, { stubbed: true });
  const makeEl = (tagName) => {
    const el = {
      tagName: String(tagName || "div").toUpperCase(),
      style: {},
      dataset: {},
      children: [],
      attributes: {},
      setAttribute(k, v) { el.attributes[k] = v; rec("setAttribute", [el.tagName, k]); },
      getAttribute(k) { return k in el.attributes ? el.attributes[k] : null; },
      appendChild(c) { el.children.push(c); return c; },
      removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; },
      addEventListener(t, fn) {
        ((el._ev = el._ev || {})[t] = el._ev[t] || []).push(fn);
        rec("el.addEventListener", [el.tagName, t]);
      },
      removeEventListener() {},
    };
    el.classList = { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false };
    return el;
  };
  return {
    createElement: (t) => makeEl(t),
    createTextNode: (t) => ({ text: String(t) }),
    createDocumentFragment: () => makeEl("#fragment"),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(type, fn) {
      if (typeof type === "string" && typeof fn === "function") {
        (gen.domEvents[type] = gen.domEvents[type] || []).push(fn);
        rec("addEventListener", [type]);
      }
    },
    removeEventListener() {},
    body: makeEl("body"),
    head: makeEl("head"),
    documentElement: makeEl("html"),
    readyState: "complete",
  };
}

module.exports = { makeDomShim };
