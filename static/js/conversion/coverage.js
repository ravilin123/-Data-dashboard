import { ALLOWED_SOURCES, COVERAGE_GAP_MAX, TOTAL_SOURCE } from './config.js';
import { trim } from '../shared/text.js';

/* ============================================================
   来源覆盖校验（B8）

   `FLYPAY` 是含全部子场景的全局汇总。作为**来源**它不能进分析（会和子场景
   重复计数，`ALLOWED_SOURCES` 里没有它是对的），但作为**验算**它是免费的：

       FLYPAY 的 PO  −  报表里所有子场景的 PO  =  报表自己都没单独列行的那部分

   这是「白名单漏了什么」最硬的检查。`formatDrift()` 那套是字符串比对 ——
   上游新增一个场景却沿用旧命名风格时它发现不了，而数字对不上藏不住。

   ⚠️ **这不是「缺口越小越好」的指标。** 拿两份真实报表实测，缺口每期都在：
       日报 0.23% ~ 0.89%   周报 0.3% ~ 1.4%   月报 0.3% ~ 1.6%
   稳定存在的东西不是异常（用户 2026-09-09 明确说过 0.4% 不算问题）。
   所以这块**平时一个字都不出**，只在缺口远超常态时才说话。

   真正要抓的是**跳变**：2026-09 改版时上游新增了 Element（占大盘 33%），
   那种情况缺口会从 0.4% 跳到 33%，一眼就看出来。阈值 5% 留足了余量。

   ⚠️ **同样不报「分析覆盖了大盘的 83%」。** 剩下的 17% 是 FLYLINK 两条线，
   而白名单是**故意**不纳入它们的（另一条业务线，漏斗形状不同，见 config.js）。
   天天在页面上说「你只看了 83%」是噪声，不是信息。
   ============================================================ */

/** PO 单量取自 `1.1 校验1通过率` 的分母 —— DEPS 里它的上游就是 PO单数。 */
const PO_METRIC = '1.1 校验1通过率';

/** 场景维度全量行 → `{期次: {来源: PO单量}}`。只留这几个数，不留全量行。 */
function scenePOBySource(sceneAll){
  const out={};
  for(const o of (sceneAll||[])){
    if(trim(o['类型'])!==PO_METRIC) continue;
    const d=String(o['统计日期']||''), s=trim(o['来源']);
    if(!d || !s || o._d==null || !Number.isFinite(o._d)) continue;
    (out[d]=out[d]||{})[s]=o._d;
  }
  return out;
}

/**
 * 某一期的覆盖校验。
 *
 * @returns {ok, alert, top, listed, gap, gapRatio, analyzed, extras, why}
 *   ok=false  —— 算不出来（没有 FLYPAY 行，或某个来源缺 PO）。
 *   alert     —— 缺口超过 COVERAGE_GAP_MAX，值得说一句。
 *
 * ⚠️ **算不出来时必须返回 ok:false，不能当成 0**。某个子场景缺了 PO 行的话，
 * 加总会偏小、缺口会偏大 —— 那是「读不到数」不是「上游新增了场景」，
 * 报出去就是假警报，而且长得和真警报一模一样。
 */
function coverageCheck(scenePO, date){
  const row=(scenePO||{})[String(date||'')];
  if(!row) return {ok:false, alert:false, why:'这一期没有场景维度的单量数据'};
  const top=row[TOTAL_SOURCE];
  if(top==null || !(top>0)) return {ok:false, alert:false, why:`报表里没有 ${TOTAL_SOURCE} 汇总行，算不了覆盖校验`};

  const subs=Object.keys(row).filter(s=>s!==TOTAL_SOURCE);
  if(!subs.length) return {ok:false, alert:false, why:'报表里只有汇总行、没有子场景'};

  const listed=subs.reduce((a,s)=>a+row[s],0);
  const gap=top-listed, gapRatio=gap/top;
  const analyzed=ALLOWED_SOURCES.reduce((a,s)=>a+(row[s]||0),0);
  // 报表列了、但白名单故意不纳入的那些（FLYLINK 两条线）。出警报时要一起说清。
  const extras=subs.filter(s=>!ALLOWED_SOURCES.includes(s))
                   .map(s=>({src:s, po:row[s], ratio:row[s]/top}))
                   .sort((a,b)=>b.po-a.po);
  return {ok:true, alert:gapRatio>COVERAGE_GAP_MAX,
          top, listed, gap, gapRatio, analyzed, analyzedRatio:analyzed/top, extras};
}

export { PO_METRIC, coverageCheck, scenePOBySource };
