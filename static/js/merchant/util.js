/* ============================================================
   小工具 + 状态归类

   从 `merchant.html` 拆出来（2026-09-09）。状态归类那几条原来在「配置」区，
   搬到这里是因为 `aggregate()` 要用 `isSucc` —— 留在配置里就得让工具层
   反过来 import 配置，白白多一个环。这几个谓词本来也是工具性质的。
   ============================================================ */
const r2 = x => Math.round((x + Number.EPSILON) * 100) / 100;
const r4 = x => Math.round((x + Number.EPSILON) * 10000) / 10000;
const pct = (n, d) => d > 0 ? r2(n / d * 100) : 0;
// pandas 默认按 key 升序分组：用码点排序模拟
const bySortedKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// 一张表的统一结构
function T(columns, data){ return { columns, data: data || [] }; }

/* 聚合：key -> {n, succ}，跳过 null/undefined（对应 pandas groupby dropna=True） */
function aggregate(rows, keyField){
  const m = new Map();
  for(const r of rows){
    let k = r[keyField];
    if(k === null || k === undefined) continue;
    k = String(k);
    let e = m.get(k);
    if(!e){ e = {n:0, succ:0}; m.set(k, e); }
    e.n++;
    if(isSucc(r)) e.succ++;
  }
  return m;
}


/* 状态分类。以前只有下面两个常量硬比字符串，于是「待处理」「处理中」「退款」
   既不算成功也不算失败 —— 它们在通过率的分母里，却进不了分子，等于默默把通过率算低。
   现在归四类：
     succ    支付成功、退款（先成功后退，钱确实收到过）
     fail    支付失败
     pending 待处理（订单创建未支付）、处理中（已进入买家操作流程，订阅/本地支付常见）
             —— **不进通过率分母**，但要出现在状态分布表里并讲明占比，不能剔了不说
     unknown 没见过的状态 —— 报出来，不静默吞
   导出用长写法（支付成功/支付失败），短写法一并收作兜底。 */
const STATUS_CLASS = {
  "支付成功":"succ",  "成功":"succ",  "已退款":"succ",  "退款":"succ",
  "支付失败":"fail",  "失败":"fail",
  "待处理":"pending", "处理中":"pending",
};
const stClass = v => STATUS_CLASS[String(v==null?"":v).trim()] || "unknown";
const isSucc  = r => stClass(r.status)==="succ";
const isFail  = r => stClass(r.status)==="fail";
const isPend  = r => stClass(r.status)==="pending";
/* 只有成功和失败进通过率分母。未决和未归类都排除 —— 前者是还没有结果，
   后者是我们不知道它算什么，两种都不该被当成失败摊进分母。 */
const inRate  = r => { const c=stClass(r.status); return c==="succ"||c==="fail"; };
const excludePending = rows => rows.filter(inRate);

export { STATUS_CLASS, T, aggregate, bySortedKey, excludePending,
         inRate, isFail, isPend, isSucc, pct, r2, r4, stClass };
