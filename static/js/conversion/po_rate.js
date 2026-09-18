import { ALLOWED_SOURCES } from './config.js';
import { periodIncomplete, sceneCounts } from './funnel.js';
import { cmpPeriod } from './trend.js';

/* ============================================================
   支付前 / 支付中 两段拆账（B7 剩下的那半条）

   `支付单支付成功率` 在 `KNOWN_UNANALYZED_METRICS` 里躺了很久，一次都没被分析过。
   口径已经核实（第十四轮），这里把它变成页面上答得出问题的一块。

   ⚠️ **它不是一个新指标，是一个新的切法。** 两条成功率的分子**完全相同**，
   差别只在分母：

       业务单支付成功率 = 成功单 / PO单数
       支付单支付成功率 = 成功单 / 支付单数      （支付单数 = PO单数 × 环节1）

   于是总流失可以**精确**劈成两段，没有残差、不需要任何比率相乘：

       PO单数 − 成功单 = (PO单数 − 支付单数) + (支付单数 − 成功单)
                       =     支付前流失      +     支付中流失

   实测两份真实报表 **79 组**（来源 × 期次 × 周期）：分子相同 79/79、
   `支付单数 = PO单数 × 环节1` 也 79/79 成立，零反例。

   为什么值得单出一块：这两段的**负责人不一样**。
   实测 2026-09-06 —— 独立站标准收银台 3027 单里 **1282 单（42.4%）根本没走到支付**，
   而独立站API 5043 单里只有 65 单卡在支付前、2056 单全卡在支付链路。
   同样是「成功率低」，一个要去查收银台/前端，一个要去查风控网关，
   而只看「业务单支付成功率」这一个数字，这两家长得一模一样。

   ⚠️ **数只从源表的分子/分母来（`sceneCounts` 的 `_n`/`_d`），不拿比率相乘。**
   和 `merchant_scan.js` 那条是同一个道理：源表那两列是权威值，累乘只用来归因。
   两行分子对不上时打 `mismatch` —— 头条数字照样对（PO 和成功单都来自业务单那行），
   但支付前/支付中的劈法不可全信，界面上要标出来。

   ⚠️ **缺 `支付单支付成功率` 行的来源进 `noData`，不当 0。**
   当 0 会得到「100% 卡在支付前」这种**长得像真结论的假结论**（`coverage.js` 踩过同一个坑）。
   ============================================================ */

const BIZ = '业务单支付成功率';
const PO  = '支付单支付成功率';

/** 一个来源一期的两段拆账。算不出来返回 null（调用方负责计进 noData）。 */
function splitOne(cnt){
  const b = cnt && cnt[BIZ], p = cnt && cnt[PO];
  if(!b || !p) return null;
  const poCnt = b.d, okCnt = b.n, payCnt = p.d;
  if(!Number.isFinite(poCnt) || !Number.isFinite(okCnt) || !Number.isFinite(payCnt)) return null;
  if(poCnt <= 0) return null;

  const 总流失 = poCnt - okCnt;
  const 支付前流失 = poCnt - payCnt;
  /* 支付中流失用「总流失 − 支付前流失」倒推，不用 `payCnt − p.n`。
     两者在分子一致时完全相等；不一致时（mismatch）这样算至少保证
     两段相加 === 总流失，不会出现「分了个账，加起来对不上」。 */
  const 支付中流失 = 总流失 - 支付前流失;
  return {
    PO单数: poCnt, 支付单数: payCnt, 成功单数: okCnt,
    业务单率: okCnt / poCnt,
    支付单率: payCnt > 0 ? p.n / payCnt : null,
    环节1: payCnt / poCnt,
    总流失, 支付前流失, 支付中流失,
    支付前占比: 总流失 > 0 ? 支付前流失 / 总流失 : null,
    mismatch: b.n !== p.n,
  };
}

const sumRows = rows => {
  const s = rows.reduce((a, r) => ({
    PO单数: a.PO单数 + r.PO单数, 支付单数: a.支付单数 + r.支付单数, 成功单数: a.成功单数 + r.成功单数,
  }), {PO单数:0, 支付单数:0, 成功单数:0});
  if(!s.PO单数) return null;
  const 总流失 = s.PO单数 - s.成功单数, 支付前流失 = s.PO单数 - s.支付单数;
  return {...s,
    业务单率: s.成功单数 / s.PO单数,
    支付单率: s.支付单数 > 0 ? s.成功单数 / s.支付单数 : null,
    环节1: s.支付单数 / s.PO单数,
    总流失, 支付前流失, 支付中流失: 总流失 - 支付前流失,
    支付前占比: 总流失 > 0 ? 支付前流失 / 总流失 : null,
    mismatch: rows.some(r => r.mismatch),
  };
};

/* 环比差。**只认有限数**，不是「非 null 就减」—— `yOk && yTotal.x` 在 yOk 为 false 时
   给的是 `false`，而 `false != null`，于是 `a - false` = `a - 0`：算不出上期
   被静默当成了 0，环比变成「全是新增的」。这块自己就踩过一次（tests/po_rate.mjs [5] 钉着）。 */
const d = (a, b) => (Number.isFinite(a) && Number.isFinite(b)) ? a - b : null;

/**
 * @param dfScene 某周期的场景维度行（含所有期次）
 * @param opts.tDate 本期；opts.yDate 上期（没有就不算环比）
 * @param opts.latestDaily 报表里最新的日报日期，用来判「本期还没走完」
 * @returns {rows, total, noData, partial, ok}
 *          rows 按**总流失单量**从多到少排（又是 B1/B2 那条：看单量不看 pt）。
 *          noData 是本期缺 `支付单支付成功率` 行的来源 —— 必须报出来。
 *
 * ⚠️ **本期没走完时不给单量环比**（`partial`，比率环比照给）。
 * 周报/月报选到当前这一期时，本期是「才过了几天」，上期是整整一周/一个月 ——
 * 两者的**单量**根本不可比。实测月报 2026-09（第 6 天）对 2026-08：
 * 一行写着「支付中流失 −92,036 单」，那不是改善，是这个月还没过完。
 * 而这个数字又大又醒目，会把整张卡片的读法带偏。
 * 比率不受影响（本期的比率是已发生那批单的真实比率），照常给。
 * 和 `churn` 那条「掉量会虚高」是同一个坑（CLAUDE.md §2）。
 */
function buildPoRate(dfScene, {tDate, yDate = null, latestDaily = null, sources = ALLOWED_SOURCES} = {}){
  const partial = periodIncomplete(tDate, latestDaily);
  const dn = (a, b) => partial ? null : d(a, b);      // 单量环比：本期没走完就不给
  const cntT = sceneCounts(dfScene || [], tDate);
  const cntY = yDate ? sceneCounts(dfScene || [], yDate) : {};
  const rows = [], noData = [];

  for(const src of sources){
    const t = splitOne(cntT[src]);
    if(!t){
      // 本期整个来源都没数据 ≠ 有数据但缺支付单那行。只有后者要提醒。
      if(cntT[src] && cntT[src][BIZ]) noData.push(src);
      continue;
    }
    const y = splitOne(cntY[src]);
    rows.push({
      来源: src, ...t, 上期: y,
      Δ业务单率: d(t.业务单率, y && y.业务单率),
      Δ支付单率: d(t.支付单率, y && y.支付单率),
      Δ支付前流失: dn(t.支付前流失, y && y.支付前流失),
      Δ支付中流失: dn(t.支付中流失, y && y.支付中流失),
    });
  }
  rows.sort((a, b) => b.总流失 - a.总流失);

  const total = sumRows(rows);
  if(total){
    const yTotal = sumRows(rows.map(r => r.上期).filter(Boolean));
    // 上期只有部分来源算得出来时不给合计环比 —— 那是拿不同口径的两个数相减
    const y = (yTotal && rows.every(r => r.上期)) ? yTotal : null;
    total.来源 = '合计'; total.上期 = y;
    total.Δ业务单率 = d(total.业务单率, y && y.业务单率);
    total.Δ支付单率 = d(total.支付单率, y && y.支付单率);
    total.Δ支付前流失 = dn(total.支付前流失, y && y.支付前流失);
    total.Δ支付中流失 = dn(total.支付中流失, y && y.支付中流失);
  }
  return {rows, total, noData, partial, ok: rows.length > 0};
}

/** 画几期。和 trend.js 同一个上限，横轴再多就挤了。 */
const PO_TREND_MAX = 12;

/**
 * 「支付前流失占比」的多期走势 —— 计划里要的那条「差值走势」。
 *
 * 看占比不看绝对单量：单量随大盘涨落，而这块要回答的是**结构**有没有在变
 * （流失是不是越来越多地发生在支付之前）。缺一期给 null，断线不连。
 *
 * ⚠️ `partial` 和趋势图（B5）同一套判断：窗口结束日晚于报表里最新的日报 = 那一期还没走完。
 * 月报的最后一个点天生是半个月，实线画出来会被读成「已经稳在这个水平了」。
 *
 * @returns {dates, sources, series, partial} series[source] 与 dates 等长
 */
function buildPoRateTrend(dfScene, {limit = PO_TREND_MAX, latestDaily = null, sources = ALLOWED_SOURCES} = {}){
  const all = [...new Set((dfScene || []).map(o => String(o['统计日期'] || '')).filter(Boolean))].sort(cmpPeriod);
  const dates = all.slice(-limit);
  const maps = dates.map(dt => sceneCounts(dfScene || [], dt));
  const seen = new Set();
  for(const m of maps) for(const s of Object.keys(m)) seen.add(s);
  // 固定顺序（ALLOWED_SOURCES）—— 颜色认实体不认名次，和 trend.js 一致
  const srcs = sources.filter(s => seen.has(s));

  const series = {};
  for(const src of srcs){
    series[src] = maps.map(m => {
      const x = splitOne(m[src]);
      return x ? x.支付前占比 : null;
    });
  }
  return {dates, sources: srcs, series, partial: dates.map(dt => periodIncomplete(dt, latestDaily))};
}

export { PO_TREND_MAX, buildPoRate, buildPoRateTrend, splitOne };
