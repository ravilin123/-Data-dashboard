import { ALLOWED_SOURCES, PERIOD_ORDER } from './config.js';
import { scenePOBySource } from './coverage.js';
import { trim } from '../shared/text.js';
import { detectPeriods, discoverPeriods, formatDrift, loadMerchant, loadScene } from './load.js';

/* ============================================================
   第一刀：readReport(workbook) → Dataset

   把「读报表」和「做分析」切开。上游改版（列改名、表头从两行压成一行、
   sheet 改名、整列消失）只会打到这一侧；业务口径（阈值、归因、播报）
   只会打到 analyze 那一侧。两边互不牵连。

   Dataset 是**纯数据**，没有方法、没有 DOM、没有 workbook 引用 ——
   所以测试可以直接写字面量，不用为了测一条口径去造 xlsx。
   见 tests/dataset.mjs 的 [3]。
   ============================================================ */

/**
 * 一次把三个周期都读出来。
 *
 * 为什么急切而不是按需：实测 3.2MB 的真实报表，`XLSX.read` 本身 2285ms，
 * 三个周期全解析加起来 507ms。而按需那条路上，光 `run()` 一次就要调两遍
 * `loadMerchant`（一遍自己用、一遍 `periodDates` 用）≈530ms —— 急切一次
 * 反而比原来更快，之后切周期、换日期全是零成本。
 */
/**
 * @param opts.allSources  不按 ALLOWED_SOURCES 过滤
 * @param opts.allPeriods  时间类别从数据里发现（含季报），不限于 PERIOD_ORDER
 *
 * 这两个开关是给 **merchant 漏斗页**用的：它要看「合计」来源（单商户跨来源汇总）、
 * FLYLINK 和季报，而转化率分析要的恰恰是滤掉这些之后的口径。实测真实报表
 * 商户维度 7273 行，默认模式只剩 1985 行 —— 直接拿默认 Dataset 给漏斗页用会砍掉
 * 七成可选行。开了开关会多出一个 `merchantAll`（换算后、拆分前的原始行）。
 *
 * **默认参数下行为和以前一字不差**，转化率那条路不受影响。
 */
function readReport(wb, {allSources=false, allPeriods=false}={}){
  const periods = detectPeriods(wb);          // 可用性判定，读的是场景维度
  const scene={}, merchantSite={}, merchantTotal={}, dates={}, meta={}, scenePO={};
  const merchantAll = (allSources||allPeriods) ? {} : undefined;
  const wanted = allPeriods ? discoverPeriods(wb) : PERIOD_ORDER;
  const lo = {allSources};

  for(const p of wanted){
    // 场景维度里一行都没有就不用往下读；allPeriods 时 periods 里没有季报，跳过这层判断
    if(!allPeriods && (!periods[p] || !periods[p].rows)) continue;
    /* 场景维度**先全量读一次**再自己过滤，不是读两遍：
       覆盖率校验（B8）要看 FLYPAY 和被白名单排除的那几个来源的单量，
       而默认模式的 sc 里它们已经没了。loadScene 每次调用都会重解析整个 sheet，
       两遍就是白花一倍时间。 */
    let scAll=[]; try{ scAll=loadScene(wb, p, {allSources:true}); }catch(e){ scAll=[]; }
    const sc = allSources ? scAll
             : scAll.filter(o=>ALLOWED_SOURCES.includes(trim(o['来源'])));
    let m={dfSite:[], dfTotal:[], hasSite:false, metricNames:[], all:[]};
    try{ m=loadMerchant(wb, p, lo); }catch(e){ /* 商户维度缺这个周期，留空由上层判断 */ }

    if(merchantAll) merchantAll[p]=m.all||[];
    scene[p]=sc;
    /* 只留「各来源各期的 PO 单量」这么几个数，不留全量行 ——
       覆盖率校验用得着，而全量行在默认模式下是下游不该看见的（会重复计数）。 */
    scenePO[p]=scenePOBySource(scAll);
    merchantSite[p]=m.dfSite;
    merchantTotal[p]=m.dfTotal;
    meta[p]={hasSite:m.hasSite, metricNames:m.metricNames};
    /* dates 取自**商户维度**，不是场景维度 —— buildMerged 用的就是那份。
       两边不一致时会出现「下拉里有这个日期、真去算却抛数据不足」，
       periodDates() 的注释里记过这个坑。 */
    dates[p]=[...new Set(m.dfSite.map(o=>o['统计日期']).filter(d=>d))].sort().reverse();
  }

  const ds={periods, scene, merchantSite, merchantTotal, dates, meta, scenePO, drift: formatDrift(wb)};
  if(merchantAll) ds.merchantAll=merchantAll;
  return ds;
}

export { readReport };
