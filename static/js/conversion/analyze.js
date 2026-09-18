import { ALL_METRICS, PERIOD } from './config.js';
import { detect } from './detect.js';
import { annotateHierarchy, buildChurn, buildMerged, buildWide, periodIncomplete, sourceChurn, stageAnalysis } from './funnel.js';
import { buildSourceStory } from './render/overview.js';
import { scanMerchants } from './merchant_scan.js';
import { coverageCheck } from './coverage.js';
import { levelSignals } from './level.js';
import { buildPoRate, buildPoRateTrend } from './po_rate.js';
import { buildTrend } from './trend.js';
import { buildWatchlist } from './watchlist.js';

/* ============================================================
   第二刀：analyze(dataset, opts) → AnalysisResult

   纯计算：吃 Dataset，吐一份结果对象，不碰 DOM、不写 store。
   业务口径的改动（阈值、归因、播报素材）都落在这一侧。

   T3 之后这里已经不碰 store：基准线经 opts 传入，播报素材经参数传入。
   单测可以直接喂 Dataset 字面量 + 基准线字面量，见 tests/dataset.mjs 的 [3][5]。
   ============================================================ */

/**
 * @param ds   readReport() 的产物，或手写的同形状字面量
 * @param opts {period, tDate, yDate, baseline, baselineActive, orderMonitor}
 *             baseline/baselineActive 由调用方给（T3）——
 *             不传就只走层级兜底阈值，函数本身不碰 store。
 *             orderMonitor 同理：它是 /api/order-monitor/latest 取回来的，
 *             **取的动作在调用方**，analyze 仍然是纯函数（B15）。
 */
function analyze(ds, {period, tDate, yDate, baseline, baselineActive, orderMonitor}={}){
  const p = period || PERIOD;
  const dfScene = ds.scene[p] || [];
  const dfSite  = ds.merchantSite[p] || [];
  const dfTotal = ds.merchantTotal[p] || [];
  const {hasSite, metricNames} = (ds.meta && ds.meta[p]) || {hasSite:false, metricNames:ALL_METRICS};

  const {merged:mergedSite, onlyT, onlyY, tDate:tD, yDate:yD} = buildMerged(dfSite, hasSite, tDate, yDate);
  const {merged:mergedTotal} = buildMerged(dfTotal, false, tD, yD);

  /* 只在一期出现的那两批（A2）+ 整个来源的出现/消失（A3）。
     buildMerged 是内连接，这些以前是被直接丢掉的，页面和播报里一个字都没有。

     latestDaily 是为了判「本期走完没有」：周报/月报选到当前这一期时，
     还没下单的商户会全被算成掉量（实测月报 81 家 / 8.5 万单，几乎全是这个）。
     不拦，但要在卡片和播报里说清楚，否则这个数字会让整块功能不可信。 */
  const latestDaily = (ds.dates && ds.dates['日报'] && ds.dates['日报'][0]) || null;
  const churn = {...buildChurn(onlyT, onlyY, hasSite), ...sourceChurn(dfScene, tD, yD),
                 partial: periodIncomplete(tD, latestDaily), latestDaily};

  const wide = buildWide(mergedSite, hasSite);

  /* stageAnalysis 提到 detect 之前：下钻要拿它算「下游各环节通过率累乘」，
     才能把各层的 pt 折算到同一把尺子上（B2）。它只依赖 dfScene 和这对日期，
     和 detect 没有先后依赖，挪上来是安全的。 */
  const stages = stageAnalysis(dfScene, tD, yD);

  const bl = {baseline, active: !!baselineActive};
  const {alarms:alarmSite,  drill:drillSite}  =
        detect(dfScene, mergedSite,  {tDate:tD, yDate:yD, hasSite, bl, stages});
  const {alarms:alarmTotal, drill:drillTotal, noBase, dodAudit} =
        detect(dfScene, mergedTotal, {tDate:tD, yDate:yD, hasSite:false, bl, stages});

  // 分层归因
  annotateHierarchy(alarmSite,  stages);
  annotateHierarchy(alarmTotal, stages);

  const srcStory = buildSourceStory(stages, mergedSite, hasSite, dfScene, tD, yD);

  /* 商户级独立探测（B6）：不看场景是否告警，每个商户当成一个小漏斗各算一遍。
     现在的 drill 是「场景先触发阈值，才拆商户」——一家中等商户彻底崩了、
     但被大盘稀释到没触发，它在异常明细里完全不存在。 */
  const merchantScan = scanMerchants(mergedSite, hasSite);

  /* 来源覆盖校验（B8）。平时一个字都不出 —— 缺口每期都有（0.2%~1.6%），
     稳定存在的不是异常。只在缺口远超常态时说话：那说明上游多了个没纳入白名单的场景。 */
  const coverage = coverageCheck(ds.scenePO && ds.scenePO[p], tD);

  /* 水平信号（B3）。环比之外的第二类判据 —— 「今天是历史上最差的 10% 之一」
     和「连着几期都在 P25 以下」，这两种环比阈值一辈子够不上。
     **不进 alarms**：它们和「今天出了什么事」不是一个问题，混进去会把告警冲淡
     （B14 那次的教训）。 */
  const levels = levelSignals(dfScene, {tDate:tD, bl, stages});

  /* 多期趋势（B5）。报表里本来就带 8~12 期，只是以前一期都没用上 ——
     每期掉 0.3pt 谁都不触发，十期下来掉 3pt 没有一天报过警。 */
  const trend = buildTrend(dfScene, {latestDaily});

  /* 支付前 / 支付中 两段拆账（B7 剩下的那半条）。`支付单支付成功率` 在
     KNOWN_UNANALYZED_METRICS 里躺了很久，一次都没被分析过 —— 而它和
     业务单成功率的分子完全相同，差别只在分母，于是总流失能精确劈成两段。
     两段的排查方向完全不同（收银台/前端 vs 风控/网关），而只看一个总成功率
     这两种情况长得一模一样。 */
  const poRate = buildPoRate(dfScene, {tDate:tD, yDate:yD, latestDaily});
  poRate.trend = buildPoRateTrend(dfScene, {latestDaily});

  /* 待观察商户（B14）。**不进 alarms、不进 drill、不占重点商户 Top N** ——
     它回答的是「这几家要盯着」，和告警的「今天出了什么事」不是一件事。 */
  const watch = buildWatchlist(mergedSite, churn, hasSite, orderMonitor, {dfSite, tDate:tD});

  return {period:p, tDate:tD, yDate:yD, hasSite, metricNames,
          dfScene, mergedSite, mergedTotal, wide,
          alarmSite, alarmTotal, drillSite, drillTotal,
          stages, srcStory, churn, watch, merchantScan, trend, poRate, levels, coverage, noBase, dodAudit};
}

export { analyze };
