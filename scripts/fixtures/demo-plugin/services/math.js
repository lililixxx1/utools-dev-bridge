"use strict";
const TAX = 99;
const SIB = require("./sibling.js").val;
module.exports = { add: (a, b) => a + b, withTax: (a) => a + TAX, SIB };
