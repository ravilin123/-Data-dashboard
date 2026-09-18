import { ANOMALY_BELOW_OVERALL_PCT, ANOMALY_LOW_RATE_ABS, ANOMALY_MIN_SHARE,
         ANOMALY_MIN_SHARE_ABS, ANOMALY_MIN_SHARE_SINGLE, ANOMALY_RATE_DROP_URGENT,
         ANOMALY_RATE_DROP_WARN, dimLabel } from './config.js';
import { AMOUNT_SCHEME } from './amount.js';
import { currencyBreakdown, hasCol } from './clean.js';
import { dataRows, getTopNValues } from './tables.js';
import { isFail, isSucc, pct, r2, stClass } from './util.js';

/* ============================================================
   异常检测 + 文字结论（对应 find_anomalies / generate_conclusion）

   从 `merchant.html` 拆出来（2026-09-09）。
   ============================================================ */
/* ============================================================
   异常检测（对应 find_anomalies）
   ============================================================ */
function findAnomalies(tablesWithLabels, compare){
  const out=[];
  for(const [table,label] of tablesWithLabels){
    if(!table || table.data.length===0) continue;
    const d = dataRows(table,label);
    if(d.length===0) continue;
    if(compare){
      for(const row of d){
        const name=String(row[label]);
        const rd=parseFloat(row["通过率对比值"])||0, pc=parseFloat(row["占比_本期"])||0;
        if(rd<=ANOMALY_RATE_DROP_WARN && pc>=ANOMALY_MIN_SHARE) out.push(`${name}：通过率下降 ${Math.abs(rd)} 个百分点，占比 ${pc}%，影响显著`);
        if(rd<=ANOMALY_RATE_DROP_URGENT) out.push(`${name}：通过率暴跌 ${Math.abs(rd)} 个百分点，需紧急关注`);
      }
    } else {
      const totalRow = table.data.find(r=>r[label]==="合计"); if(!totalRow) continue;
      const overall=parseFloat(totalRow["通过率"])||0;
      for(const row of d){
        const name=String(row[label]);
        const rate=parseFloat(row["通过率"])||0, p=parseFloat(row["占比"])||0;
        if(p>=ANOMALY_MIN_SHARE_SINGLE && (overall-rate)>=ANOMALY_BELOW_OVERALL_PCT)
          out.push(`${name}：通过率 ${rate}%，低于整体 ${overall}% 达 ${r2(overall-rate)*1/1} 个百分点，占比 ${p}%`);
        if(p>=ANOMALY_MIN_SHARE_ABS && rate<ANOMALY_LOW_RATE_ABS)
          out.push(`${name}：通过率仅 ${rate}%（极低），占比 ${p}%，需紧急关注`);
      }
    }
  }
  return out;
}

/* ============================================================
   文字结论（对应 append_dim_conclusion / generate_conclusion）
   ============================================================ */
function appendDimConclusion(table, label, C, compare){
  if(!table || table.data.length===0){ C.push(label===dimLabel("bin_country")?"  无数据（本地支付/钱包等无卡BIN）":"  无数据"); return; }
  const d=dataRows(table,label);
  if(d.length===0){ C.push("  无数据"); return; }
  const rankCol=compare?"乘积":"影响力";
  const top=d.map(r=>({r,a:Math.abs(parseFloat(r[rankCol])||0)})).sort((x,y)=>y.a-x.a).slice(0,compare?3:5).map(x=>x.r);
  for(const row of top){
    const name=String(row[label]);
    if(compare){
      const rdf=parseFloat(row["通过率对比值"])||0;
      const dir=rdf<0?"下降":rdf>0?"上升":"持平";
      C.push(`  - ${name}：占比 ${row["占比_本期"]}%，通过率 ${row["通过率_上期"]}% -> ${row["通过率_本期"]}%（${dir} ${Math.abs(rdf)} 个百分点），乘积 ${row["乘积"]}`);
    } else {
      C.push(`  - ${name}：占比 ${row["占比"]}%，通过率 ${row["通过率"]}%，影响力 ${row["影响力"]}`);
    }
  }
}

function fmtDate(d){ return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); }

function generateConclusion(prefix, dfCurr, dfLast, tBin, tAmount, tMethod, C, dfRawCurr, ordC, ordL, binScope){
  const compare = dfLast != null;
  const totalCurr=dfCurr.length, totalLast=compare?dfLast.length:0;
  const succCurr=dfCurr.filter(r=>isSucc(r)).length;
  const rateCurr=totalCurr>0?r2(succCurr/totalCurr*100):0;

  C.push("=".repeat(60)); C.push(`【${prefix}】分析结论`); C.push("=".repeat(60)); C.push("");
  C.push("一、整体概览");
  if(compare){
    const succLast=dfLast.filter(r=>isSucc(r)).length;
    const rateLast=totalLast>0?r2(succLast/totalLast*100):0;
    const volChange=totalCurr-totalLast, volPct=totalLast>0?r2(volChange/totalLast*100):0, rateChange=r2(rateCurr-rateLast);
    C.push(`  交易量：上期 ${totalLast} 笔 -> 本期 ${totalCurr} 笔（${volChange>=0?"增长":"下降"} ${Math.abs(volChange)} 笔，${Math.abs(volPct)}%）`);
    C.push(`  笔数通过率：上期 ${rateLast}% -> 本期 ${rateCurr}%（${rateChange>=0?"上升":"下降"} ${Math.abs(rateChange)} 个百分点）`);
      if(ordC && ordL){
        const d=r2(ordC.rate-ordL.rate);
        C.push(`  订单通过率：上期 ${ordL.rate}% -> 本期 ${ordC.rate}%（${d>=0?"上升":"下降"} ${Math.abs(d)} 个百分点）`);
        C.push(`  重试率：上期 ${ordL.retry} -> 本期 ${ordC.retry} 笔/单`);
        // 两个口径背离本身就是信号：笔数跌而订单没跌 = 重试变多，是链路问题不是转化问题
        if(rateChange<=-1 && d>-1) C.push("  ! 笔数通过率下降但订单通过率基本持平 —— 多为重试增加，优先查链路而非转化");
      }
    if(rateChange<=-10) C.push("  !! 成功率大幅下降，需重点关注");
    else if(rateChange<=-3) C.push("  ! 成功率有所下降，建议关注");
    else if(rateChange>=3) C.push("  成功率有所改善");
    else C.push("  成功率基本持平");
  } else {
    if(totalCurr>0){
      let mn=dfCurr[0].pay_time,mx=dfCurr[0].pay_time;
      for(const r of dfCurr){ if(r.pay_time<mn)mn=r.pay_time; if(r.pay_time>mx)mx=r.pay_time; }
      C.push(`  分析时段：${fmtDate(mn)} ~ ${fmtDate(mx)}`);
    }
    C.push(`  总交易量：${totalCurr} 笔`);
    C.push(`  笔数通过率：${rateCurr}%（每一次支付尝试的成功率）`);
    /* 两个口径一起报。只报笔数口径会把「买家重试后其实付成了」说成失败 ——
       真实数据上两者差 12.4pt，差额全是重试挽回的单。 */
    if(ordC){
      C.push(`  订单通过率：${ordC.rate}%（按支付单去重，买家最终有没有付成）`);
      C.push(`  重试率：${ordC.retry} 笔/单；${ordC.retriedUnits} 单重试过，其中 ${ordC.saved} 单最终成功`);
    }
    // 未决已从通过率分母剔除，但必须说清剔了多少，否则分母对不上账
    if(dfRawCurr && dfRawCurr.length>totalCurr){
      const nd=dfRawCurr.length-totalCurr;
      C.push(`  注：另有 ${nd} 笔（占 ${r2(nd/dfRawCurr.length*100)}%）为未决或未归类状态，`
            +`已排除出通过率分母，明细见「流水单状态」表`);
    }
    if(rateCurr>=80) C.push("  成功率处于较好水平");
    else if(rateCurr>=60) C.push("  成功率处于一般水平，有优化空间");
    else C.push("  !! 成功率偏低，需重点关注");
  }
  const cur=currencyBreakdown(dfCurr);
  if(cur.length) C.push(`  涉及币种：${cur.map(([c,n,p])=>`${c}(${n}笔,${p}%)`).join("，")}`);
  C.push("");

  C.push("二、失败原因 " + (compare?"TOP 3（占比恶化最大的）":"TOP 5"));
  const failC=dfCurr.filter(r=>isFail(r));
  if(compare){
    const failL=dfLast.filter(r=>isFail(r));
    if(failC.length>0){
      const gc=new Map(),gl=new Map();
      for(const r of failC){const k=r.fail_reason;if(k==null)continue;gc.set(String(k),(gc.get(String(k))||0)+1);}
      for(const r of failL){const k=r.fail_reason;if(k==null)continue;gl.set(String(k),(gl.get(String(k))||0)+1);}
      let rows=[...new Set([...gc.keys(),...gl.keys()])].map(k=>{const c=gc.get(k)||0,l=gl.get(k)||0;
        const pc=pct(c,totalCurr),pl=pct(l,totalLast);return {k,pc,pl,pd:r2(pc-pl)};});
      rows.sort((a,b)=>b.pd-a.pd); rows=rows.slice(0,3);
      for(const x of rows){ C.push(`  - ${String(x.k).slice(0,80)}`);
        C.push(`    占比：${x.pl}% -> ${x.pc}%（${x.pd>0?"恶化":"改善"} ${Math.abs(x.pd)}%）`); }
    } else C.push("  本期无失败数据");
  } else {
    if(failC.length>0){
      const g=new Map();
      for(const r of failC){const k=r.fail_reason;if(k==null)continue;g.set(String(k),(g.get(String(k))||0)+1);}
      let rows=[...g.entries()].map(([k,c])=>({k,c,p:pct(c,totalCurr)})).sort((a,b)=>b.p-a.p).slice(0,5);
      for(const x of rows) C.push(`  - ${String(x.k).slice(0,80)}：${x.c} 笔（占总量 ${x.p}%）`);
    } else C.push("  无失败数据");
  }
  C.push("");

  const rankTag = compare?"TOP 3（乘积排序，已排除风控拦截）":"TOP 5（影响力排序，已排除风控拦截）";
  C.push(`三、BIN 国家 ${rankTag}`);
  if(!tBin || tBin.data.length===0) C.push("  本数据无有效『支付卡BIN国家』（本地支付/钱包等无卡BIN），已跳过该维度分析");
  else {
    /* 这一节的分母是卡支付笔数，不是全量 —— 钱包没有卡BIN，把它们当成一个"空国家"
       一起排名，比出来的是钱包 vs 卡，不是国家之间的差异。明写出来，
       免得有人拿这里的占比去跟别的表对账对不上。 */
    if(binScope && binScope.card < binScope.all){
      const w = binScope.all - binScope.card;
      C.push(`  （本节分母＝卡支付 ${binScope.card} 笔；另有 ${w} 笔钱包/本地支付无卡BIN，`
             + `占 ${pct(w, binScope.all)}%，不参与本维度排名）`);
    }
    appendDimConclusion(tBin,dimLabel("bin_country"),C,compare);
  }
  C.push("");
  C.push(`四、金额区间 ${rankTag}`);
  /* 档位是按数据挑的，不是固定的 —— 不写出来，两个商户（甚至同一商户两个周期）
     的「金额区间」表会用不同档位，读的人无从察觉。 */
  if(AMOUNT_SCHEME && AMOUNT_SCHEME.kind!=="fixed") C.push(`  （档位：${AMOUNT_SCHEME.note}）`);
  appendDimConclusion(tAmount,dimLabel("amount_range"),C,compare); C.push("");
  C.push(`五、支付方式 ${rankTag}`); appendDimConclusion(tMethod,dimLabel("payment_method"),C,compare); C.push("");

  C.push("六、需要关注的异常");
  const an=findAnomalies([[tBin,dimLabel("bin_country")],[tAmount,dimLabel("amount_range")],[tMethod,dimLabel("payment_method")]],compare);
  if(an.length) an.forEach(a=>C.push(`  - ${a}`)); else C.push("  未发现显著异常");
  C.push(""); C.push("");
}


export { appendDimConclusion, findAnomalies, fmtDate, generateConclusion };
