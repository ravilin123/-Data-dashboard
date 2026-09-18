import { AMOUNT_LABELS } from './amount.js';
import { DIM, dimLabel } from './config.js';
import { PRESENT, currencyBreakdown, excludeRisk, hasCol, hasDimData, withDim } from './clean.js';
import { generateConclusion } from './conclusion.js';
import { T, aggregate, bySortedKey, excludePending, inRate, isFail, isPend, isSucc,
         pct, r2, stClass } from './util.js';
import { dimAvail, dimRows, dimTable, generateCrossMatrix, generateCrossTable,
         generateFailGroupTable, generateFailreasonTable, generateGroupedTable,
         getTopNValues, pushDimDim, pushDimFail } from './tables.js';

/* ============================================================
   完整分析（对应 Python 的 generate_full_analysis）—— 编排层

   从 `merchant.html` 拆出来（2026-09-09）。这里只负责「出哪些表、按什么顺序」，
   每张表怎么算都在 `tables.js`。
   ============================================================ */
/* ============================================================
   完整分析（对应 generate_full_analysis）
   ============================================================ */
/* dfCurr/dfLast 已剔除未决；dfRawCurr/dfRawLast 是未剔除的原始集，
   只给状态分布表用 —— 未决要能被看见并讲明占比，不能剔了不说。 */
/* 流水单状态分布。这张表是唯一看得到未决的地方 —— 其余所有表都已把未决剔除，
   所以这里必须明说各状态占多少，否则「通过率的分母去哪了」无从对账。
   未归类状态单独列出并标注，不静默并进「其他」。 */
/* 订单口径。一行流水 = 一次支付尝试；一个支付单可含多次尝试。
   按 PO 去重后「至少一笔成功 → 该单成功」，这才是买家视角的转化。
   真实数据上笔数 72.90% / 订单 85.29%，差的 12.42pp 全是重试挽回的单 ——
   只报笔数口径会把「买家其实付成了」说成失败。
   拒付计入成功（钱确实收到过），另行单列拒付率。 */
function orderStats(df){
  if(!hasCol("po_id")) return null;
  const m=new Map();
  for(const r of df){
    const k=String(r.po_id==null?"":r.po_id).trim(); if(!k) continue;
    let o=m.get(k); if(!o){ o={n:0,ok:false,pst:""}; m.set(k,o); }
    o.n++; if(isSucc(r)) o.ok=true;
    if(!o.pst && r.po_status!=null) o.pst=String(r.po_status).trim();
  }
  const v=[...m.values()], U=v.length;
  if(!U) return null;
  const ok=v.filter(x=>x.ok).length;
  const dist=new Map();          // 尝试次数分布
  for(const x of v){ let d=dist.get(x.n); if(!d){ d={units:0,ok:0}; dist.set(x.n,d); } d.units++; if(x.ok) d.ok++; }
  const retried=v.filter(x=>x.n>1);
  const pst=new Map();
  for(const x of v){ const k=x.pst||"(空)"; pst.set(k,(pst.get(k)||0)+1); }
  return {
    units:U, ok, rate:pct(ok,U), rows:df.length, retry:U?r2(df.length/U):0,
    dist:[...dist.entries()].sort((a,b)=>a[0]-b[0]),
    retriedUnits:retried.length, retriedRows:retried.reduce((s,x)=>s+x.n,0),
    saved:retried.filter(x=>x.ok).length,     // 重试之后成功的单
    poStatus:[...pst.entries()].sort((a,b)=>b[1]-a[1]),
  };
}

/* 支付单状态分布 + 重试分布，两张表。 */
function generateOrderTables(dfCurr, prefix, sheets){
  const st=orderStats(dfCurr); if(!st) return null;
  const c1=["支付单状态","单数","占比"];
  sheets.push([`${prefix}_支付单状态`, T(c1, [
    ...st.poStatus.map(([k,n])=>({"支付单状态":k,"单数":n,"占比":pct(n,st.units)})),
    {"支付单状态":"合计","单数":st.units,"占比":100,__total:true},
  ])]);
  const c2=["尝试次数","支付单数","占比","最终成功","该档成功率"];
  sheets.push([`${prefix}_重试分布`, T(c2, [
    ...st.dist.map(([k,d])=>({"尝试次数":k+"次","支付单数":d.units,"占比":pct(d.units,st.units),
                              "最终成功":d.ok,"该档成功率":pct(d.ok,d.units)})),
    {"尝试次数":"合计","支付单数":st.units,"占比":100,"最终成功":st.ok,
     "该档成功率":st.rate,__total:true},
  ])]);
  return st;
}

/* 买家维度。按邮箱聚合，回答「是同一批人多试了几次，还是换了一批人」——
   笔数口径看不出这个区别，但两者的结论完全相反。
   全失败买家占比最关键：它高说明有一批人怎么试都过不去，
   那是人群质量或风控命中问题，不是链路抖动。 */
function generateBuyerTable(dfCurr, dfLast){
  const compare = dfLast != null;
  const cols = compare ? ["指标","上期","本期","变化"] : ["指标","本期"];
  if(!hasCol("buyer_email")) return T(cols);
  const stat = df=>{
    const by=new Map();
    for(const r of df){
      const e=String(r.buyer_email==null?"":r.buyer_email).trim().toLowerCase();
      if(!e) continue;
      let o=by.get(e); if(!o){ o={n:0,ok:0,cards:new Set(),ips:new Set()}; by.set(e,o); }
      o.n++; if(isSucc(r)) o.ok++;
      if(r.card_no)   o.cards.add(String(r.card_no).trim());
      if(r.buyer_ip)  o.ips.add(String(r.buyer_ip).trim());
    }
    const v=[...by.values()], u=v.length; if(!u) return null;
    const cnt=f=>v.filter(f).length;
    const af=v.filter(x=>x.ok===0);
    const o={ "唯一买家数":u, "笔均买家数":r2(df.length/u),
      "尝试1笔买家占比":pct(cnt(x=>x.n===1),u),
      "尝试2笔买家占比":pct(cnt(x=>x.n===2),u),
      "尝试≥3笔买家占比":pct(cnt(x=>x.n>=3),u),
      "买家级成功率(至少成功1笔)":pct(cnt(x=>x.ok>0),u),
      "全失败买家占比":pct(af.length,u),
      "全失败买家贡献笔数占比":pct(af.reduce((s,x)=>s+x.n,0),df.length) };
    if(hasCol("card_no"))  o["用≥2张卡的买家占比"]=pct(cnt(x=>x.cards.size>=2),u);
    if(hasCol("buyer_ip")) o["用≥2个IP的买家占比"]=pct(cnt(x=>x.ips.size>=2),u);
    return o;
  };
  const c=stat(dfCurr), l=compare?stat(dfLast):null;
  if(!c) return T(cols);
  return T(cols, Object.keys(c).map(k=>{
    if(!compare) return {"指标":k,"本期":c[k]};
    const lv=l?l[k]:"";
    return {"指标":k,"上期":lv,"本期":c[k],"变化":(typeof lv==="number")?r2(c[k]-lv):""};
  }));
}

/* BIN 集中度。同一个 BIN 下「笔数/卡数/邮箱数」三个数一起看才有意义：
   卡少邮箱少而笔数高 = 一张卡在反复刷（卡测试或重试死循环）；
   卡多邮箱多 = 渠道投放带来的人群批量涌入。两者只看 BIN 占比长得一模一样，
   但性质完全相反。需要 付款银行账号（掩码卡号）才算得出来。 */
function generateBinConcentration(dfCurr){
  const cols=["卡BIN(前6位)","笔数","卡数","邮箱数","笔/卡","通过率","判读"];
  if(!hasCol("card_no")) return T(cols);
  const m=new Map();
  for(const r of dfCurr){
    const c=String(r.card_no==null?"":r.card_no).trim();
    if(c.length<6) continue;
    const b=c.slice(0,6);
    let o=m.get(b); if(!o){ o={n:0,ok:0,cards:new Set(),mails:new Set()}; m.set(b,o); }
    o.n++; if(isSucc(r)) o.ok++;
    o.cards.add(c);
    const e=String(r.buyer_email==null?"":r.buyer_email).trim().toLowerCase();
    if(e) o.mails.add(e);
  }
  if(!m.size) return T(cols);
  const rows=[...m.entries()].map(([b,x])=>{
    const pc=x.cards.size?r2(x.n/x.cards.size):0;
    // 笔卡比高 = 少数卡反复刷。阈值 5 是经验值，够挑出异常又不至于误伤正常复购
    const tag = pc>=5 ? "★卡少笔多，疑似卡测试/重试循环"
              : (x.cards.size>=10 ? "人群分散，正常" : "");
    return {"卡BIN(前6位)":b,"笔数":x.n,"卡数":x.cards.size,"邮箱数":x.mails.size,
            "笔/卡":pc,"通过率":pct(x.ok,x.n),"判读":tag};
  }).sort((a,b)=>b["笔数"]-a["笔数"]);
  return T(cols, rows.slice(0,30));
}

/* 全失败买家画像：这批人是谁、从哪来。和 BIN 集中度是一组的 ——
   都在回答「是不是有一批人在刷」，只是一个从卡看、一个从人看。 */
function generateAllFailProfile(dfCurr){
  const dim = hasDimData(dfCurr,"ip_country") ? ["ip_country",dimLabel("ip_country")]
            : (hasDimData(dfCurr,"bin_country") ? ["bin_country",dimLabel("bin_country")] : null);
  const cols=["维度值","失败笔数","占全失败买家笔数比"];
  if(!hasCol("buyer_email") || !dim) return T(cols);
  const by=new Map();
  for(const r of dfCurr){
    const e=String(r.buyer_email==null?"":r.buyer_email).trim().toLowerCase();
    if(!e) continue;
    let o=by.get(e); if(!o){ o={ok:0}; by.set(e,o); }
    if(isSucc(r)) o.ok++;
  }
  const rows=dfCurr.filter(r=>{
    const e=String(r.buyer_email==null?"":r.buyer_email).trim().toLowerCase();
    return e && by.get(e) && by.get(e).ok===0;
  });
  if(!rows.length) return T(cols);
  const m=new Map();
  for(const r of rows){ const k=String(r[dim[0]]||"(空)"); m.set(k,(m.get(k)||0)+1); }
  const data=[...m.entries()].sort((a,b)=>b[1]-a[1]).slice(0,15)
    .map(([k,n])=>({"维度值":`${dim[1]}=${k}`,"失败笔数":n,"占全失败买家笔数比":pct(n,rows.length)}));
  data.push({"维度值":"合计","失败笔数":rows.length,"占全失败买家笔数比":100,__total:true});
  return T(cols,data);
}

/* 3DS 专项。**只在 3DS 交易内部比**，不跟非 3DS 比 ——
   实测「是否支持3D」完全等于「是不是卡支付」（支持的全是 VISA/MC/AmEx，
   不支持的全是 ApplePay/GooglePay），所以「3DS vs 非3DS」实为「卡 vs 钱包」的混淆。
   而且卡支付里 96.3% 都走了 3DS，根本没有对照组。
   风控/政策决策为空严格等于非 3DS 交易（零例外），所以这两列只在 3DS 内部有意义。 */
/* 3DS 交易的识别与「谁推去验证的」分组。报表和图表共用这一份 ——
   各写一份的下场刚发生过：图表那份按「决策字段为空」判，而这两列实际存的是
   "是"/"否" 字符串，于是三组全被并成一组，图上只剩一根 65.11% 的条，
   而那是 3DS 整体通过率，不是任何一组的数。 */
function tds3(rows){
  if(!hasCol("is_3ds") || !hasCol("risk_3ds")) return null;
  const t3=rows.filter(r=>String(r.is_3ds||"").includes("3DS验证")
                        && !String(r.is_3ds||"").includes("非3DS"));
  if(!t3.length) return null;
  const m=new Map();
  for(const r of t3){
    const k=`风控=${String(r.risk_3ds||"-")} 政策=${String(r.policy_3ds||"-")}`;
    let o=m.get(k); if(!o){ o={n:0,ok:0}; m.set(k,o); }
    o.n++; if(isSucc(r)) o.ok++;
  }
  return {t3, groups:[...m.entries()].sort((a,b)=>b[1].n-a[1].n)};
}

function generate3dsTables(dfCurr, prefix, sheets){
  const g=tds3(dfCurr); if(!g) return;
  const t3=g.t3;
  const c1=["3DS触发方","笔数","占3DS比","通过率"];
  sheets.push([`${prefix}_3DS触发方`, T(c1, [
    ...g.groups.map(([k,x])=>({"3DS触发方":k,"笔数":x.n,"占3DS比":pct(x.n,t3.length),"通过率":pct(x.ok,x.n)})),
    {"3DS触发方":"合计","笔数":t3.length,"占3DS比":100,
     "通过率":pct(t3.filter(isSucc).length,t3.length),__total:true},
  ])]);
  // ② 政策3DS × 卡BIN国家：政策 3DS 是 SCA 强制，本该只命中欧洲卡。
  //    出现美国卡就是配置异常 —— 这张表是守卫，平时应该看不到 US
  if(hasCol("bin_country")){
    const pol=t3.filter(r=>String(r.policy_3ds||"")==="是");
    if(pol.length){
      const g=new Map();
      for(const r of pol){ const k=String(r.bin_country||"(无BIN)");
        let o=g.get(k); if(!o){ o={n:0,ok:0}; g.set(k,o); } o.n++; if(isSucc(r)) o.ok++; }
      const c2=["卡BIN国家","笔数","占政策3DS比","通过率","判读"];
      sheets.push([`${prefix}_政策3DSx卡BIN国家`, T(c2,
        [...g.entries()].sort((a,b)=>b[1].n-a[1].n).map(([k,x])=>({
          "卡BIN国家":k,"笔数":x.n,"占政策3DS比":pct(x.n,pol.length),"通过率":pct(x.ok,x.n),
          "判读": k==="US" ? "⚠️美国不在 SCA 强制范围，命中政策3DS 属配置异常" : ""}))
      )]);
    }
  }
}

/* IP 国家 × 卡BIN 国家一致性。两者不一致本身不是问题，
   但占比明显上升且该组通过率显著更低时，是人群来源变化的直接证据。
   下结论前要先按金额档对齐，避免把客单价结构当成人群质量。 */
function generateIpBinConsistency(dfCurr){
  const cols=["一致性","笔数","占卡支付比","通过率"];
  if(!hasCol("ip_country") || !hasCol("bin_country")) return T(cols);
  const card=dfCurr.filter(r=>String(r.bin_country||"").trim());
  if(!card.length) return T(cols);
  const same=card.filter(r=>String(r.ip_country||"")===String(r.bin_country||""));
  const diff=card.filter(r=>String(r.ip_country||"")!==String(r.bin_country||""));
  const row=(lbl,sub)=>({"一致性":lbl,"笔数":sub.length,"占卡支付比":pct(sub.length,card.length),
                         "通过率":pct(sub.filter(isSucc).length,sub.length)});
  return T(cols,[row("IP国家 = 卡BIN国家",same), row("IP国家 ≠ 卡BIN国家",diff),
                 {"一致性":"合计","笔数":card.length,"占卡支付比":100,
                  "通过率":pct(card.filter(isSucc).length,card.length),__total:true}]);
}

/* 按小时。找的是时段规律（不同地区买家结构 / 通道夜间抖动），
   和「按日」找故障窗口是两件事。 */
function generateHourTable(dfCurr){
  const cols=["小时","笔数","占比","通过率"];
  const g=new Map();
  for(const r of dfCurr){
    const t=r.pay_time; if(!(t instanceof Date)) continue;
    const k=t.getHours();
    let o=g.get(k); if(!o){ o={n:0,ok:0}; g.set(k,o); } o.n++; if(isSucc(r)) o.ok++;
  }
  if(!g.size) return T(cols);
  return T(cols,[...g.entries()].sort((a,b)=>a[0]-b[0]).map(([h,x])=>({
    "小时":String(h).padStart(2,"0")+"时","笔数":x.n,"占比":pct(x.n,dfCurr.length),
    "通过率":pct(x.ok,x.n)})));
}

function generateStatusTable(dfCurr, dfLast){
  const compare = dfLast != null;
  const cols = compare
    ? ["流水单状态","归类","笔数_上期","笔数_本期","占比_上期","占比_本期","占比差额"]
    : ["流水单状态","归类","笔数","占比","金额"];
  if(!dfCurr || !dfCurr.length) return T(cols);
  const LBL={succ:"计入成功",fail:"计入失败",pending:"未决·不进分母",unknown:"⚠️未归类·不进分母"};
  const tally=df=>{
    const m=new Map();
    for(const r of df){
      const k=String(r.status==null?"(空)":r.status).trim()||"(空)";
      let o=m.get(k); if(!o){ o={n:0,amt:0,cls:stClass(r.status)}; m.set(k,o); }
      o.n++; o.amt+=(+r.amount||0);
    }
    return m;
  };
  const c=tally(dfCurr), l=compare?tally(dfLast):null;
  const nC=dfCurr.length, nL=compare?dfLast.length:0;
  const keys=[...new Set([...c.keys(), ...(l?l.keys():[])])]
    .sort((a,b)=>(c.get(b)?.n||0)-(c.get(a)?.n||0));
  const data=keys.map(k=>{
    const x=c.get(k)||{n:0,amt:0,cls:stClass(k)}, y=l?(l.get(k)||{n:0}):null;
    if(!compare) return {"流水单状态":k,"归类":LBL[x.cls]||x.cls,
                         "笔数":x.n,"占比":pct(x.n,nC),"金额":r2(x.amt)};
    const pC=pct(x.n,nC), pL=pct(y.n,nL);
    return {"流水单状态":k,"归类":LBL[x.cls]||x.cls,
            "笔数_上期":y.n,"笔数_本期":x.n,"占比_上期":pL,"占比_本期":pC,"占比差额":r2(pC-pL)};
  });
  const tot=Object.fromEntries(cols.map(x=>[x,""]));
  tot["流水单状态"]="合计"; tot.__total=true;
  if(compare){ tot["笔数_上期"]=nL; tot["笔数_本期"]=nC; }
  else { tot["笔数"]=nC; tot["占比"]=100; }
  data.push(tot);
  return T(cols,data);
}

function generateFullAnalysis(dfCurr, prefix, sheets, C, dfLast, dfRawCurr, dfRawLast){
  const compare = dfLast != null;
  const dfCurrEx = excludeRisk(dfCurr);
  const dfLastEx = compare ? excludeRisk(dfLast) : null;

  // 状态分布（走原始集，看得到未决与未归类）
  sheets.push([`${prefix}_流水单状态`, generateStatusTable(dfRawCurr||dfCurr, compare?(dfRawLast||dfLast):null)]);
  // 订单口径：支付单状态 + 重试分布。没有 支付单号 列时自动跳过
  const ordC = generateOrderTables(dfCurr, prefix, sheets);
  const ordL = compare ? orderStats(dfLast) : null;
  // 买家维度三张：行为汇总 / BIN 集中度 / 全失败画像。缺列时各自返回空表，不报错
  if(hasCol("buyer_email")){
    sheets.push([`${prefix}_买家行为`, generateBuyerTable(dfCurrEx, compare?dfLastEx:null)]);
    sheets.push([`${prefix}_全失败买家画像`, generateAllFailProfile(dfCurrEx)]);
  }
  if(hasCol("card_no")) sheets.push([`${prefix}_BIN集中度`, generateBinConcentration(dfCurrEx)]);
  // 3DS 专项（内部两张）
  generate3dsTables(dfCurrEx, prefix, sheets);
  /* IP国家、按日 在下面和它们的交叉表一起出（要复用 tIp/tDay），这里只补
     不参与交叉的两张：IP×BIN 一致性、按小时。 */
  if(dimAvail(dfCurrEx,"ip_country")) sheets.push([`${prefix}_IPvsBIN一致性`, generateIpBinConsistency(dfCurrEx)]);
  sheets.push([`${prefix}_按小时`, generateHourTable(dfCurrEx)]);

  /* 归类表排在明细前：先看「哪一层拦的」，再看逐条文案。
     归类口径在 shared/fail_group.js，编码优先、无码才看文案 —— 别在这里另写一份。 */
  sheets.push([`${prefix}_失败原因归类`, generateFailGroupTable(dfCurr, compare?dfLast:null)]);
  sheets.push([`${prefix}_失败原因`, generateFailreasonTable(dfCurr, compare?dfLast:null)]);

  const binAvail = hasDimData(dfCurrEx, "bin_country");
  /* BIN 维度只在卡支付内部算（见 withDim 上方注释）。分母因此不是全量而是卡支付笔数，
     结论里会把这个分母和钱包占比明说，避免看表的人拿它跟别的表对不上。 */
  const dfCurrBin = binAvail ? dimRows(dfCurrEx,"bin_country") : dfCurrEx;
  const dfLastBin = (binAvail && compare) ? dimRows(dfLastEx,"bin_country") : dfLastEx;
  const tBin = binAvail ? dimTable(dfCurrEx,"bin_country",compare?dfLastEx:null) : null;
  const tAmount = dimTable(dfCurrEx,"amount_range",compare?dfLastEx:null);
  const tMethod = dimTable(dfCurrEx,"payment_method",compare?dfLastEx:null);

  if(binAvail) sheets.push([`${prefix}_BIN国家`,tBin]);
  sheets.push([`${prefix}_金额区间`,tAmount]);
  sheets.push([`${prefix}_支付方式`,tMethod]);

  /* 按日时序。刻意**不做**两期对齐 —— 两个周期的日期集合本来就不重合，
     硬按日期对齐会得到一堆只有单边数据的行，占比差额毫无意义。
     这张表回答的是「本期内部哪天出现突变」，两期各出一张各看各的。 */
  /* 买家维度。有 ip_country 就当成和 BIN国家 同级的维度跑一遍，
     两者一起看才能回答「IP 国家和发卡国家对不对得上」。 */
  if(dimAvail(dfCurrEx,"ip_country")){
    const tIp = dimTable(dfCurrEx,"ip_country",compare?dfLastEx:null);
    sheets.push([`${prefix}_IP国家`,tIp]);
    if(binAvail) pushDimDim(dfCurrBin,prefix,"ip_country",dimLabel("ip_country"),DIM.ip_country.short,"bin_country",dimLabel("bin_country"),DIM.bin_country.short,sheets,compare?dfLastBin:null);
    pushDimFail(dfCurrEx,prefix,"ip_country",dimLabel("ip_country"),DIM.ip_country.short,tIp,sheets,compare?dfLastEx:null);
  }
  if(dimAvail(dfCurrEx,"ship_country")) sheets.push([`${prefix}_收货国家`, dimTable(dfCurrEx,"ship_country",compare?dfLastEx:null)]);
  if(dimAvail(dfCurrEx,"card_brand"))   sheets.push([`${prefix}_卡组`,     dimTable(dfCurrEx,"card_brand",compare?dfLastEx:null)]);
  const tDay = dimTable(dfCurrEx,"day",null);
  sheets.push([`${prefix}_按日`,tDay]);
  if(compare) sheets.push([`${prefix}_按日_上期`, dimTable(dfLastEx,"day",null)]);
  // 日期×失败原因：找错误码的结构切换（某个码从低位跳高位、或码之间整体换挡）
  pushDimFail(dfCurrEx,prefix,"day",dimLabel("day"),DIM.day.short,tDay,sheets,null);

  if(binAvail){
    pushDimDim(dfCurrBin,prefix,"bin_country",dimLabel("bin_country"),DIM.bin_country.short,"amount_range",dimLabel("amount_range"),DIM.amount_range.short,sheets,compare?dfLastBin:null);
    pushDimDim(dfCurrBin,prefix,"bin_country",dimLabel("bin_country"),DIM.bin_country.short,"payment_method",dimLabel("payment_method"),DIM.payment_method.short,sheets,compare?dfLastBin:null);
  }
  pushDimDim(dfCurrEx,prefix,"amount_range",dimLabel("amount_range"),DIM.amount_range.short,"payment_method",dimLabel("payment_method"),DIM.payment_method.short,sheets,compare?dfLastEx:null);

  if(binAvail) pushDimFail(dfCurrBin,prefix,"bin_country",dimLabel("bin_country"),DIM.bin_country.short,tBin,sheets,compare?dfLastBin:null);
  pushDimFail(dfCurrEx,prefix,"amount_range",dimLabel("amount_range"),DIM.amount_range.short,tAmount,sheets,compare?dfLastEx:null);
  pushDimFail(dfCurrEx,prefix,"payment_method",dimLabel("payment_method"),DIM.payment_method.short,tMethod,sheets,compare?dfLastEx:null);

  generateConclusion(prefix, dfCurr, compare?dfLast:null, tBin, tAmount, tMethod, C, dfRawCurr, ordC, ordL,
                     binAvail ? {card:dfCurrBin.length, all:dfCurrEx.length} : null);
}

export { tds3, generate3dsTables, generateAllFailProfile, generateBinConcentration,
         generateBuyerTable, generateFullAnalysis, generateHourTable,
         generateIpBinConsistency, generateOrderTables, generateStatusTable, orderStats };
