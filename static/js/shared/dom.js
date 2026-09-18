/* ============================================================
   DOM 小工具 —— 三个页面共用

   这两个函数原来三处各有一份，而且**行为不一样**：
     conversion  esc(null) → 字面量 "null"（会印在页面上）
     merchant    esc(null) → 空串
     index       esc(null) → 空串，且多转义了 "
   统一取最严的那份。
   ============================================================ */

const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

/* 转义表带上引号：esc() 在 render/ 里有 8 处用在 HTML 属性值上
   （data-kw / data-mid / data-metric…），塞的是站点 URL、商户名、指标名这些
   源表来的字符串。只转 & < > 的话，值里出现一个引号就撑破属性。 */
const ESC_MAP = {'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'};

/** null / undefined → 空串；其余转成字符串并转义 HTML 特殊字符。 */
function esc(v){
  return String(v == null ? '' : v).replace(/[&<>"']/g, c => ESC_MAP[c]);
}

export { $, $$, esc };
