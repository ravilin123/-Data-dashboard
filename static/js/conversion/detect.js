import { DEPS, METRIC_ORDER, SMALL_MERCHANT_PO } from './config.js';
import { calcFunnel, dodOf, downstreamPass, hasDenomChain, isTriggered, orderImpact, parseDodCell, sceneMap } from './funnel.js';
import { trim } from '../shared/text.js';
import { num, pct, ptFmt } from './util.js';

/* ============================================================
   6. 异常探测（对应 detect）
   ============================================================ */
/** 某来源某指标的 PO 加权总量。下钻算「影响比率」要用。 */
function totalPOBySource(merged){
  const m={};
  merged.forEach(r=>{ const s=r['来源']; m[s]=(m[s]||0)+num(r['PO单数_今']); });
  return m;
}

/**
 * 把「某来源某指标」拆到商户/站点级，**按对大盘的折损单量降序**。
 *
 * 从 detect() 里抽出来的，目的是让「优先排查」那条路也能用 —— 它挑的是对整体
 * 拖累最大的大环节，不看告警阈值，所以经常是个没进 alarms 的指标；
 * 以前那种情况就只有一句「建议人工排查」，查不到是哪些商户。
 *
 * @param opts.isF      摩擦类（3DS 占比那几个）：涨才是变差
 * @param opts.totalPO  该来源的 PO 总量，算「对大盘 pt」的分母
 * @param opts.hasSite  站点级还是用户ID合计级
 * @param opts.dir      'worse'（默认）留变差的 —— 找拖累源，detect() 走这条；
 *                      'better' 留变好的 —— 播报要回答「涨是谁拉起来的」
 * @param opts.stages   该来源的 funnelStages 结果，算下游通过率累乘用（B2）。
 *                      不给就退回老口径（影响比率），只是跨环节仍不可比。
 *
 * 排序变了（B1 + B2 + B12），三层：
 *   1. 小样本沉底 —— 3 单里失败 1 单也是 66pt，那不是信号（B12）
 *   2. 折损单量绝对值降序 —— 「少了多少支付成功单」是唯一跨环节可比的尺子（B1/B2）
 *   3. 算不出折损单量时（复合指标没有分母链）退回老的影响比率
 */
function drillMetric(merged, source, metric, opts){
  const {isF=false, totalPO=0, hasSite=false, dir, stages=null} = opts||{};
  const wantWorse = dir!=='better';
  const down = downstreamPass(stages, metric);
  const recs=[];
  for(const r of merged.filter(x=>x['来源']===source)){
    const rateT=num(r[metric+'_今']), rateY=num(r[metric+'_昨']);
    const delta=rateT-rateY;
    const po=num(r['PO单数_今']);
    // 摩擦类涨=坏、通过率类跌=坏；取反就是"变好"
    const worse = isF ? delta>0 : delta<0;
    if(delta===0 || worse!==wantWorse) continue;
    // 「影响」= PO占比 × 该商户比率变动，只要有比率和 PO 就算得出来。
    // 「进入/通过本环节」的单量才需要分母链 —— 复合指标（如「1. 业务单支付转化率」
    // = 1.1×1.2）没有自己的分母，那两列留空即可，不该因此拒绝整条下钻。
    const canFunnel = hasDenomChain(metric);
    const [dT,nT] = canFunnel ? calcFunnel(r,metric,'_今') : [null,null];
    const impactRate = totalPO ? (po/totalPO)*delta : 0;
    /* 折损单量：Δ比率 × 该环节分母 × 下游通过率累乘。负数 = 少了这么多单。
       摩擦类（3DS 占比）**不算** —— 占比上升本身不损失单量，损失发生在下游那几个
       通过率上；硬套这个公式会算出一个看着精确、其实没有业务含义的数。 */
    const ordImp = isF ? null : orderImpact(delta, dT, down);
    recs.push({
      来源:source,异常指标:metric,
      用户ID:String(r['用户ID']||''),商户名称:String(r['商户名称']||''),
      站点: hasSite ? String(r['站点']||'') : '(用户ID合计)',
      本期PO总单量:Math.round(po),
      '进入本环节(单)':dT,'通过本环节(单)':nT,'是否>PO': (dT!=null && dT>po) ? '是':'否',
      本期比率:pct(rateT),上期比率:pct(rateY),
      // 空串 = 没被封顶。渲染时据此决定要不要加「封顶」标记
      本期封顶原值: r['_clip_'+metric+'_今']!=null ? pct(r['_clip_'+metric+'_今']) : '',
      上期封顶原值: r['_clip_'+metric+'_昨']!=null ? pct(r['_clip_'+metric+'_昨']) : '',
      比率环比变动:`${delta>=0?'+':''}${(delta*100).toFixed(2)}%`,
      影响比率:`${impactRate>=0?'+':''}${(impactRate*100).toFixed(3)}%`,
      影响单量: ordImp==null ? null : Math.round(ordImp),
      对大盘影响: (ordImp==null || !totalPO) ? '' : ptFmt(ordImp/totalPO),
      _impact_abs:Math.abs(impactRate),
      _ord_abs: ordImp==null ? null : Math.abs(ordImp),
      _small: po < SMALL_MERCHANT_PO,
    });
  }
  /* 排序键：有折损单量就用它，没有才退回影响比率。
     两者不同量纲，所以**不能混在一个数里比** —— 同一次调用里 metric 是同一个，
     要么全有要么全没有，不会真的混着排。

     ⚠ 小样本**只在退回影响比率时才沉底**。理由：折损单量的上界就是这家自己的单量，
     5 单的商户再怎么崩也只能折损 5 单，量级排序天然压得住它，再额外沉一次是错的 ——
     万一它真是当天最大的一笔损失，埋了就是漏报。而影响比率没有这个天花板
     （`PO占比 × Δ`，Δ 可以是 80pt），那时候样本量是唯一还站得住的判据。
     「样本少」的标记两种情况都打，播报也两种情况都不点名 —— 那两件事管的是
     「这个比率可不可信」，和「它值多少单」是两回事。 */
  const key = r => r._ord_abs!=null ? r._ord_abs : r._impact_abs;
  const sink = r => (r._ord_abs==null && r._small) ? 1 : 0;
  recs.sort((a,b)=> (sink(a)-sink(b)) || (key(b)-key(a)));
  return recs;
}

/* 现算值与源表那列的允许误差。源表的当期值只给到两位小数（'40.31%'），
   反推出来的环比天然带舍入误差；实测 346 对里最大偏差远小于这个数。
   超过它才算「上游口径可能变了」，免得拿舍入噪声报警。 */
const DOD_AUDIT_TOL = 0.01;

/**
 * 场景级探测 + 命中后的商户下钻。
 *
 * @param opts {tDate, yDate, hasSite, bl, stages}
 *        stages 是 stageAnalysis() 的结果，`drillMetric` 拿它算下游通过率累乘（B2）。
 *        参数改成对象是因为已经到 7 个了，位置参数再加就没人记得住第 5 个是什么。
 */
function detect(dfScene, merged, opts){
  const {tDate, yDate, hasSite=false, bl, stages=null} = opts||{};
  const today = dfScene.filter(o=>o['统计日期']===tDate);
  const yest  = dfScene.filter(o=>o['统计日期']===yDate);

  const srcTotalPO=totalPOBySource(merged);

  /* 告警的环比改成按**选中的这对日期**现算（第四轮 A1）——
     瀑布图、商户下钻、影响比率本来就走这对日期，以前只有告警读源表那列，
     一往前翻就是同一屏两套口径。 */
  const mapT=sceneMap(dfScene,tDate), mapY=sceneMap(dfScene,yDate);

  /* 源表那列降级成校验：只有两期相邻时它才该和现算值一致。 */
  const allDates=[...new Set(dfScene.map(o=>o['统计日期']).filter(d=>d))].sort().reverse();
  const adjacent = allDates[allDates.indexOf(tDate)+1] === yDate;
  const dodAudit = {adjacent, compared:0, mismatch:0, samples:[]};

  const alarms=[], drill=[];
  /* 算不出环比的行要计数报上去，不能静默 —— 首期数据、新上线的来源都会走到这条。 */
  let noBase=0;
  for(const row of today){
    const source=trim(row['来源']), metric=trim(row['类型']);
    if(!(metric in DEPS)) continue;

    const dod = dodOf(mapT, mapY, source, metric);
    if(dod==null){ noBase++; continue; }

    if(adjacent){
      const srcDod = parseDodCell(row['环比']);
      if(srcDod!=null){
        dodAudit.compared++;
        if(Math.abs(srcDod-dod) > DOD_AUDIT_TOL){
          dodAudit.mismatch++;
          if(dodAudit.samples.length<5) dodAudit.samples.push(
            {来源:source, 指标:metric, 现算:pct(dod), 源表:pct(srcDod)});
        }
      }
    }

    // 传 source：基准线优先用这个来源自己的池子，样本不够才退混池（B4）
    const {hit:triggered, basis, isF} = isTriggered(metric, dod, bl, source);
    if(!triggered) continue;

    const prev = yest.find(o=> trim(o['类型'])===metric && trim(o['来源'])===source);
    const valY = prev ? prev['当期值'] : 'N/A';
    const valT = row['当期值'];
    alarms.push({来源:source,异常指标:metric,本期比率:valT,上期比率:valY,
      环比:`${dod>0?'+':''}${(dod*100).toFixed(1)}%`,_is_f:isF,_basis:basis,_dod:dod});

    const recs = drillMetric(merged, source, metric,
                             {isF, totalPO:srcTotalPO[source]||0, hasSite,
                              stages:(stages||{})[source]});
    // 两个排序键是内部用的，别带进导出的宽表；_small 留着，渲染要靠它打「样本少」
    recs.forEach(x=>{ delete x._impact_abs; delete x._ord_abs; });
    drill.push(...recs);
  }
  // 按漏斗顺序排列（原 Python 按 sheet 行序，顺序是乱的）
  const ord=a=>METRIC_ORDER[a['异常指标']]!=null?METRIC_ORDER[a['异常指标']]:999;
  alarms.sort((a,b)=> a['来源']===b['来源'] ? ord(a)-ord(b) : String(a['来源']).localeCompare(String(b['来源'])));
  drill.sort((a,b)=> a['来源']===b['来源'] ? ord(a)-ord(b) : String(a['来源']).localeCompare(String(b['来源'])));
  return {alarms, drill, noBase, dodAudit};
}


export { detect, drillMetric, totalPOBySource };
