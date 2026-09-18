import { ALLOWED_SOURCES, FUNNEL_MAIN } from './config.js';
import { funnelStages, periodIncomplete, sceneCounts, sceneMap } from './funnel.js';

/* ============================================================
   多期趋势（B5）

   在此之前整个页面只认「两期」：本期 vs 上期。于是一类问题结构性地看不见 ——
   每期只掉 0.3pt，任何阈值都不触发，十期下来掉了 3pt，没有一天会报警。
   （第五轮把它记成「温水煮青蛙」，B3 的判据也要靠这份序列。）

   ⚠️ 报表里本来就带多期：实测一份日报 8 期、周报 5 期、月报 4 期，
   都在同一个 dfScene 里躺着（loadScene 读的是整个周期，不是某一天）。
   所以这块不用等归档接口（B11），现在就能算。

   纯函数：吃场景维度的行 + 一个「最新日报日期」，吐一份序列。不碰 DOM、不碰 store。
   ============================================================ */

/** 画几期。12 期够覆盖「两周日报 / 一季周报 / 一年月报」，再多横轴就挤了。 */
const TREND_MAX_POINTS = 12;

/**
 * 期次排序：**自然序**，不是字典序。
 *
 * 周报的期次写成 `2026 W9` / `2026 W37`，字典序会把 W9 排到 W37 后面 ——
 * 跨年初那几周（W1~W9 和 W37 同时在表里时）折线的点会前后颠倒，
 * 而颠倒之后的图**看起来完全正常**，只是讲了个假故事。
 * 日报（2026-09-06）和月报（2026-09）本来就零填充，自然序和字典序一致。
 */
function cmpPeriod(a, b){
  const A=String(a).match(/\d+|\D+/g)||[], B=String(b).match(/\d+|\D+/g)||[];
  for(let i=0;i<Math.max(A.length,B.length);i++){
    const x=A[i], y=B[i];
    if(x===undefined) return -1;
    if(y===undefined) return 1;
    const nx=/^\d/.test(x), ny=/^\d/.test(y);
    if(nx&&ny){ const d=parseInt(x,10)-parseInt(y,10); if(d) return d; }
    else if(x!==y) return x<y?-1:1;
  }
  return 0;
}

/** 画哪几条线：整体 + 四个大环节。和瀑布图同一套 code，配色也共用一份。 */
function trendMeasures(){
  return [{key:'overall', label:'整体成功率'},
          ...FUNNEL_MAIN.map(s=>({key:s.code, label:`${s.code}. ${s.label}`}))];
}

/**
 * @param dfScene  某周期的场景维度全部行（含所有期次）
 * @param opts.latestDaily  报表里最新的那个日报日期，用来判「本期还没走完」
 * @returns {dates, sources, measures, series, po, partial}
 *          series[measure][source] 是一个和 dates 等长的数组，缺一期就是 null。
 */
function buildTrend(dfScene, {limit=TREND_MAX_POINTS, latestDaily=null, sources=ALLOWED_SOURCES}={}){
  const all=[...new Set((dfScene||[]).map(o=>String(o['统计日期']||'')).filter(Boolean))].sort(cmpPeriod);
  const dates=all.slice(-limit);
  const measures=trendMeasures();

  const series={}, po={};
  for(const m of measures) series[m.key]={};

  const seen=new Set();
  const maps=dates.map(d=>({mapT:sceneMap(dfScene,d), cnt:sceneCounts(dfScene,d)}));
  for(const {mapT} of maps) for(const s of Object.keys(mapT)) seen.add(s);
  // 固定顺序（ALLOWED_SOURCES），**不按数据里出现的顺序** —— 颜色要认实体不认名次
  const srcs=sources.filter(s=>seen.has(s));

  for(const src of srcs){
    for(const m of measures) series[m.key][src]=[];
    po[src]=[];
    for(const {mapT, cnt} of maps){
      const mm=mapT[src];
      if(!mm){
        for(const m of measures) series[m.key][src].push(null);
        po[src].push(null);
        continue;
      }
      const f=funnelStages(mm, {});
      /* 整体成功率要求四个大环节**全都算得出来**。
         funnelStages 缺环节按 1.0 跳过（和瀑布图一致），拿来画折线就成了
         「少一环 → 那一期凭空跳高」—— 序列图上这种跳跃会被读成真实变化。
         宁可断线。 */
      const full=f.stages.every(s=>s.rateT!=null);
      series.overall[src].push(full ? f.overallT : null);
      for(const s of f.stages) series[String(s.code)][src].push(s.rateT);
      const c=cnt[src] && cnt[src]['1.1 校验1通过率'];
      po[src].push(c && Number.isFinite(c.d) ? c.d : null);
    }
  }

  /* 哪几期还没走完。周报/月报选到当前这一期时最后一个点天生偏低
     （月份才过了几天），不标出来就会被读成「刚开始掉」。 */
  const partial=dates.map(d=>periodIncomplete(d, latestDaily));

  return {dates, sources:srcs, measures, series, po, partial};
}

export { TREND_MAX_POINTS, buildTrend, cmpPeriod, trendMeasures };
