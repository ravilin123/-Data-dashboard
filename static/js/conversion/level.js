import { CREEP_MIN_RUN, DEPS, FRICTION_METRICS, LEVEL_MIN_ORDERS, METRIC_ORDER } from './config.js';
import { downstreamPass, pickLevelPool, sceneMap } from './funnel.js';
import { cmpPeriod } from './trend.js';
import { trim } from '../shared/text.js';

/* ============================================================
   水平信号（B3）—— 环比之外的第二类判据

   在此之前**只有环比告警**：`computeBaseline()` 只对相邻两期的变化建分布，
   指标的绝对水平从来没建过模。后果是一整类问题结构性地报不出来：

     · 今天这个数是历史上最差的 10% 之一，但比昨天只差 1pt → 环比阈值够不上
     · 连着五期都在历史 P25 以下，每期只掉一点点 → 一天都不会告警

   两类信号：

   | 信号 | 判据 | 回答的问题 |
   |---|---|---|
   | 水平异常 | 本期值跌破该池历史 P10 | 「今天这个数在历史上算什么位置」 |
   | 温水煮青蛙 | 连续 ≥3 期不高于历史 P25 | 「是不是一直在慢慢烂」 |

   摩擦类（3DS 占比那几个）方向相反：涨破 P90 / 连续不低于 P75 才是坏。

   ⚠️ **这不是「常年趴在 60% 那块肉」。** B3 开头那句说的是「一个指标常年低、
   每天纹丝不动，永远不告警」—— P10 判据解决不了它：常年 60% 的指标，
   它自己的历史 P10 也在 60% 附近，永远跌不破。那个要的是**跨来源比较**
   （同一个指标别的来源能做到 90%），是另一条，还没做。别把这两件事混起来。

   纯函数：吃场景维度行 + 基准线，不碰 DOM、不碰 store。
   ============================================================ */

/** 某来源某指标在各期的值，按期次自然序（`2026 W9` 不能排到 `W37` 后面）。 */
function seriesOf(dfScene, source, metric, dates){
  return dates.map(d=>{
    const m=sceneMap(dfScene, d);
    return (m[source] && m[source][metric]!=null) ? m[source][metric] : null;
  });
}

/**
 * 从 `endIdx` 往前数，连着几期「不好」。
 *
 * 用 `<=` / `>=` 而不是严格不等号：分位数是样本上的点，浮点相等本来就靠不住。
 * 由此带来的「满分指标也被数成连续」由 `hasRoom()` 在外面挡掉，不在这里判 ——
 * 这个函数只负责数数。
 *
 * ⚠️ 中间断一期（没数据）就停，不跨过缺口 —— 跨过去数出来的「连续」是编的。
 */
function runLength(series, endIdx, cut, isF){
  let n=0;
  for(let i=endIdx;i>=0;i--){
    const v=series[i];
    if(v==null || !Number.isFinite(v)) break;
    const bad = isF ? v>=cut : v<=cut;
    if(!bad) break;
    n++;
  }
  return n;
}

/**
 * 「回到中位水平能多成多少单」。算不出来就 null —— 不编数。
 *
 * 复用 B1/B2 那套：`Δ比率 × 该环节分母 × 下游各环节通过率累乘`。
 * 分母取的是**来源级**真值（源表带「分子/分母」列时才有），下游累乘也是来源级 ——
 * 和 `orderImpact()` 同一个近似，那边的注释里记着为什么。
 */
function orderValue(f, metric, back, isF){
  if(isF || back==null || !(back>0)) return null;      // 摩擦类不算；比中位还好也不算
  const cnt = f && f.counts && f.counts[metric];
  if(!cnt || !Number.isFinite(cnt.d)) return null;
  return back * cnt.d * downstreamPass(f, metric);
}

/**
 * 这个池子的分布有没有「下沉空间」。
 *
 * ⚠️ 没有这一关，满分指标会天天上榜。拿真实报表实测，第一版报出来的是：
 *
 *     独立站API · 1.2 Paynow点击率   连续 8 期 ≤ P25(100.00%)   本期 100.00%   中位 100.00%
 *
 * 它是**满分**。常年 100% 的指标 P25 = P50 = 1.0，于是「不高于 P25」恒成立。
 * 值全都一样意味着没出事，本来就不该报 —— 判据得看分布**有没有区分度**，
 * 而不是看某个值落在哪一侧。摩擦类同理（P75 = P50 时上不去）。
 */
function hasRoom(st, isF){
  return isF ? st.p75 > st.p50 : st.p25 < st.p50;
}

/**
 * 一条信号值多少单：**回到自己的中位水平能多成多少支付成功单**。
 *
 *     影响单量 = (中位 − 本期值) × 该环节分母 × 下游各环节通过率累乘
 *
 * 和 B1/B2 的折损单量是同一把尺子，只是反事实换了 —— 那边是「和上期比」，
 * 这边是「和自己的正常水平比」。**触发看 P10，排序和取舍看这个数**：
 * pt 跨指标不可比（`3.1 风控综合通过率` 掉 0.06pt 和 `4. 网关通过率` 掉 0.06pt
 * 差着几个数量级），只按 pt 排会让一堆没人会处理的条目占着前排。
 *
 * ⚠️ 摩擦类**不算**折损单量 —— 占比上升本身不损失单量，损失发生在下游那几个
 * 通过率上。硬套公式会算出一个看着精确、其实没有业务含义的数（和 B1/B2 同一条规矩）。
 * 算不出来的（摩擦类、源表没给分子分母）**不埋**：`null` 排在后面，但不因为
 * 「算不出金额」就当它不存在。
 *
 * ⚠️ 中位数作反事实有个已知的钝处：一个指标要是连着几个月在滑，中位数本身
 * 已经跟着滑下来了，「回到中位」就低估了真实损失。这块由「温水煮青蛙」那一段兜。
 *
 * @param dfScene 某周期的场景维度全部行（含所有期次）
 * @param opts.tDate 本期
 * @param opts.bl    {baseline, active} —— 和 thresholdFor 同一份，没启用就不出信号
 * @param opts.stages stageAnalysis() 的结果，用来取该环节分母和下游累乘。
 *                    不给就只是没有单量，信号照出。
 * @returns {level:[...], creep:[...], pools:{used,total}}
 *
 * 没有基准线时返回空名单 + `noBaseline:true`：**要说出来**，
 * 不然「今天没有水平信号」和「压根没算」在界面上长得一样。
 */
function levelSignals(dfScene, {tDate, bl, stages}={}){
  const empty={level:[], creep:[], noBaseline:true, checked:0, flat:0, noPool:0, thin:0};
  if(!bl || !bl.active || !bl.baseline) return empty;

  const dates=[...new Set((dfScene||[]).map(o=>String(o['统计日期']||'')).filter(Boolean))].sort(cmpPeriod);
  const tIdx=dates.indexOf(String(tDate));
  if(tIdx<0) return {...empty, noBaseline:false};

  const mapT=sceneMap(dfScene, tDate);
  const level=[], creep=[];
  let checked=0, flat=0, noPool=0;

  for(const source of Object.keys(mapT)){
    for(const metric of Object.keys(mapT[source])){
      if(!(metric in DEPS)) continue;
      const v=mapT[source][metric];
      if(v==null || !Number.isFinite(v)) continue;
      const p=pickLevelPool(bl.baseline, metric, source);
      if(!p){ noPool++; continue; }          // 样本撑不住就不出信号，不编
      const isF=FRICTION_METRICS.includes(metric);
      const st=p.stat;
      if(!hasRoom(st, isF)){ flat++; continue; }   // 分布压根没有区分度，判什么都是噪声
      checked++;

      const f=(stages||{})[source] || null;
      const back=st.p50 - v;                      // 回到中位要补多少（负数 = 本期比中位还好）
      const ord=orderValue(f, metric, back, isF);

      const outer = isF ? st.p90 : st.p10;
      if(isF ? v>st.p90 : v<st.p10){
        level.push({来源:source, 指标:metric, 本期值:v, 分位线:outer, 中位:st.p50,
                    影响单量:ord, _isF:isF, _basis:p.basis, _n:st.n,
                    _gap: isF ? v-outer : outer-v});
      }

      const cut = isF ? st.p75 : st.p25;
      const series=seriesOf(dfScene, source, metric, dates);
      const run=runLength(series, tIdx, cut, isF);
      if(run>=CREEP_MIN_RUN){
        creep.push({来源:source, 指标:metric, 本期值:v, 分位线:cut, 中位:st.p50,
                    连续期数:run, 影响单量:ord, _isF:isF, _basis:p.basis, _n:st.n,
                    _gap: isF ? v-cut : cut-v});
      }
    }
  }

  /* 太小的直接不列（算得出单量、又不到门槛的那些）。
     算不出单量的（摩擦类、源表没给分子分母）**留着** —— 不能因为标不出价就当没有。 */
  const tooSmall=r=>r['影响单量']!=null && r['影响单量']<LEVEL_MIN_ORDERS;
  const kept={level:level.filter(r=>!tooSmall(r)), creep:creep.filter(r=>!tooSmall(r))};
  const thin=(level.length-kept.level.length)+(creep.length-kept.creep.length);

  /* 排序：**按影响单量**，不按 pt 缺口（pt 跨指标不可比，B1/B2 那次的教训）。
     算不出单量的排在后面，同档按漏斗顺序 —— 上游的问题会往下游传导，先看上游省事。 */
  const seq=r=>METRIC_ORDER[r['指标']]!=null?METRIC_ORDER[r['指标']]:999;
  const val=r=>r['影响单量']!=null?r['影响单量']:-Infinity;
  const cmp=(a,b)=> (val(b)-val(a)) || (b._gap-a._gap) || (seq(a)-seq(b));
  kept.level.sort(cmp);
  kept.creep.sort((a,b)=> (b['连续期数']-a['连续期数']) || cmp(a,b));

  /* checked / flat / noPool 三个计数要报上去 —— 「今天没有水平信号」和
     「一条都没算」在界面上不能长一样，这是这仓库反复踩过的那类问题。 */
  return {level:kept.level, creep:kept.creep, noBaseline:false, checked, flat, noPool, thin};
}

export { levelSignals, runLength, seriesOf };
