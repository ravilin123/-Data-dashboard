import { fmtPctCell } from '../shared/table_text.js';
import { groupFailures } from '../shared/fail_group.js';
import { AMOUNT_LABELS, cutAmount } from './amount.js';
import { withDim, hasCol, hasDimData, excludeL3 } from './clean.js';
import { COLUMN_MAP, DERIVED_COLS, DIM, DRILL_DOWN_TOP_N, dimCats, dimLabel } from './config.js';
import { T, aggregate, bySortedKey, isFail, isSucc, pct, r2, r4 } from './util.js';

/* ============================================================
   各种表（对应 Python 的 generate_*_table）

   从 `merchant.html` 拆出来（2026-09-09）。`dimRows` / `dimAvail` / `dimTable`
   本来在配置区，跟着搬到这里 —— 它们要 `withDim`（清洗层）和
   `generateGroupedTable`（就在本文件），留在配置里等于让配置依赖上面两层。
   ============================================================ */
/* 这个维度该在哪批行上算。作用域写在注册表里，调用点就不会漏 —— 
   之前 BIN 的卡支付限定是在每个调用点分别记得加的。 */
const dimRows  = (rows, col) =>
  (DIM[col] && DIM[col].scope==="card") ? withDim(rows,"bin_country") : rows;
/* 单维度表的统一入口：标签、分类种子、作用域都从注册表来，调用点只给数据。 */
/* 这个维度值不值得出表。判据是「真有值」而不是「表头在」——
   有了 支付流水明细_模板.xlsx 之后，「表头在但整列为空」会成为常态
   （模板列全、用户只填得出其中一部分），再按 hasCol 判就会凭空多出一堆空表。 */
const dimAvail = (rows, col) => hasDimData(dimRows(rows,col), col);
const dimTable = (cur, col, last) =>
  generateGroupedTable(dimRows(cur,col), col, dimLabel(col),
                       last ? dimRows(last,col) : null, dimCats(col));


/* ============================================================
   失败原因表（对应 generate_failreason_table）
   ============================================================ */
function generateFailreasonTable(dfCurr, dfLast){
  const compare = dfLast != null;
  const totalCurr = dfCurr.length, totalLast = compare ? dfLast.length : 0;
  /* 分组仍按文案（读的人关心「为什么失败」），编码只作附加列。
     不按编码分组是因为数据不支持：编码 45 种 / 文案 47 种，基本一一对应，
     一码多文案仅 1 例（7 笔）；而反过来「同一句风控拦截文案 → 两个编码」那 103 笔，
     恰恰说明合成一行才对。编码列的用处是拿去跟研发对齐、搜日志。 */
  const cols = compare
    ? ["支付失败原因","报错编码","总计_上期","总计_本期","单量对比值","占总量比_上期","占总量比_本期","占总量比差额","占失败比_上期","占失败比_本期","累计占失败比_本期"]
    : ["支付失败原因","报错编码","笔数","占总量比","占失败比","累计占失败比"];
  if(totalCurr === 0 && totalLast === 0) return T(cols);

  const data = [];
  // ---- 状态汇总 ----
  const stC = aggregate(dfCurr, "status");
  if(compare){
    const stL = aggregate(dfLast, "status");
    const keys = [...new Set([...stC.keys(), ...stL.keys()])].sort(bySortedKey);
    for(const k of keys){
      const c = stC.get(k)?.n || 0, l = stL.get(k)?.n || 0;
      data.push({"支付失败原因":k,"总计_上期":l,"总计_本期":c,"单量对比值":c-l,
        "占总量比_上期":pct(l,totalLast),"占总量比_本期":pct(c,totalCurr),
        "占总量比差额":r2(pct(c,totalCurr)-pct(l,totalLast)),
        "占失败比_上期":"","占失败比_本期":"","累计占失败比_本期":""});
    }
  } else {
    const keys = [...stC.keys()].sort(bySortedKey);
    for(const k of keys){
      const c = stC.get(k).n;
      data.push({"支付失败原因":k,"笔数":c,"占总量比":pct(c,totalCurr),"占失败比":"","累计占失败比":""});
    }
  }

  // ---- 失败原因明细 ----
  const failC = dfCurr.filter(r => isFail(r));
  const failL = compare ? dfLast.filter(r => isFail(r)) : null;
  const fTotC = failC.length, fTotL = compare ? failL.length : 0;

  // 文案 → 该文案下出现过的编码（通常一个；多个时并列，便于发现同因异码）
  const codeOf = new Map();
  for(const r of [...failC, ...(failL||[])]){
    const k = r.fail_reason==null ? null : String(r.fail_reason);
    if(k==null) continue;
    const c = r.fail_code==null ? "" : String(r.fail_code).trim();
    if(!c) continue;
    let st = codeOf.get(k); if(!st){ st = new Set(); codeOf.set(k, st); }
    st.add(c);
  }
  const codeTxt = k => [...(codeOf.get(k)||[])].sort().join(" / ");

  data.push(Object.fromEntries(cols.map(c => [c, c==="支付失败原因" ? "--- 以下为失败原因明细（占失败比分母=失败总笔数）---" : ""])));
  data[data.length-1].__sep = true;

  if(fTotC > 0 || (compare && fTotL > 0)){
    if(compare){
      const gc = new Map(), gl = new Map();
      for(const r of failC){ const k=r.fail_reason; if(k==null) continue; gc.set(String(k),(gc.get(String(k))||0)+1); }
      for(const r of failL){ const k=r.fail_reason; if(k==null) continue; gl.set(String(k),(gl.get(String(k))||0)+1); }
      let rows = [...new Set([...gc.keys(),...gl.keys()])].map(k=>{
        const c=gc.get(k)||0,l=gl.get(k)||0;
        return {k,l,c,diff:c-l,pl:pct(l,totalLast),pc:pct(c,totalCurr),
          fl:pct(l,fTotL),fc:pct(c,fTotC)};
      });
      rows.sort((a,b)=>b.c-a.c);
      let cum=0;
      for(const x of rows){ cum=r2(cum+x.fc);
        data.push({"支付失败原因":x.k,"报错编码":codeTxt(x.k),"总计_上期":x.l,"总计_本期":x.c,"单量对比值":x.diff,
          "占总量比_上期":x.pl,"占总量比_本期":x.pc,"占总量比差额":r2(x.pc-x.pl),
          "占失败比_上期":x.fl,"占失败比_本期":x.fc,"累计占失败比_本期":cum}); }
    } else {
      const g = new Map();
      for(const r of failC){ const k=r.fail_reason; if(k==null) continue; g.set(String(k),(g.get(String(k))||0)+1); }
      let rows = [...g.entries()].map(([k,c])=>({k,c,p:pct(c,totalCurr),f:pct(c,fTotC)}));
      rows.sort((a,b)=>b.c-a.c);
      let cum=0;
      for(const x of rows){ cum=r2(cum+x.f);
        data.push({"支付失败原因":x.k,"报错编码":codeTxt(x.k),"笔数":x.c,"占总量比":x.p,"占失败比":x.f,"累计占失败比":cum}); }
    }
  }

  // ---- 合计 ----
  const tot = Object.fromEntries(cols.map(c=>[c,""]));
  tot["支付失败原因"]="合计"; tot.__total=true;
  if(compare){ tot["总计_上期"]=totalLast; tot["总计_本期"]=totalCurr; tot["单量对比值"]=totalCurr-totalLast; }
  else { tot["笔数"]=totalCurr; tot["占总量比"]= totalCurr>0?100:0; }
  data.push(tot);
  return T(cols, data);
}

/* ============================================================
   失败原因归类表（2026-09-09）

   为什么要有这张：AI 提示词原来只写「按可优化程度归组（如：需风控侧评估、
   需先确认状态、优化空间有限）」，「如：」后面那三个只是举例 —— 没有任何映射，
   每次跑分组名都可能不一样，同一个失败原因这次进这组下次进那组，没法跨期比。

   ⚠️ **归类在工具里算好，不交给 AI**。理由不是省 token，是文案里「风控拦截」
   四个字飞来汇和发卡行两边都在用：模型只看文案会把发卡行风控拒绝算成我方拦截，
   方向完全反了。判定口径见 static/js/shared/fail_group.js（编码优先，无码才看文案）。

   ⚠️ 网关拦截里**一条关键词都没命中的兜底进「发卡行拒绝」**（用户 2026-09-09 定的），
   但兜底笔数要写进「备注」列。失败文案 71.2% 是网关英文原文，写法随网关变，兜底的量
   只会涨 —— 不写这个数，「发卡行拒绝」看上去就是个干净结论，实际可能大半是它凑的。
   ============================================================ */
function failGroupTableOf(rows){
  return groupFailures((rows||[]).filter(r=>isFail(r)),
                       {methodOf:r=>r.payment_method==null?"":String(r.payment_method)});
}
function generateFailGroupTable(dfCurr, dfLast){
  const compare = dfLast != null;
  const cols = compare
    ? ["失败归类","总计_上期","总计_本期","单量对比值","占失败比_上期","占失败比_本期","占失败比差额","主要支付方式","备注","典型文案"]
    : ["失败归类","笔数","占失败比","主要支付方式","备注","典型文案"];
  const gc = failGroupTableOf(dfCurr);
  const gl = compare ? failGroupTableOf(dfLast) : null;
  if(!gc.total && (!gl || !gl.total)) return T(cols);

  const mOf = g => new Map((g?g.groups:[]).map(x=>[x.label,x]));
  const mc = mOf(gc), ml = mOf(gl);
  const mtxt = x => (x&&x.methods||[]).map(m=>`${m.m}(${m.n})`).join(" / ");
  const stxt = x => (x&&x.samples||[]).slice(0,2).join(" ｜ ");
  /* 兜底进来的要在表上写出来：没有这一列，「发卡行拒绝」看上去就是一个干净的结论，
     而它可能大半是「网关没给出可辨认理由」凑起来的。 */
  const ntxt = x => (x&&x.fallbackN) ? `其中 ${x.fallbackN} 笔未命中关键词，按兜底归入` : "";
  const keys = [...new Set([...mc.keys(), ...ml.keys()])]
    .sort((a,b)=>((mc.get(b)||{n:0}).n-(mc.get(a)||{n:0}).n));

  const data = keys.map(k=>{
    const c=mc.get(k), l=ml.get(k);
    const cn=c?c.n:0, ln=l?l.n:0;
    if(!compare) return {"失败归类":k,"笔数":cn,"占失败比":pct(cn,gc.total),
      "主要支付方式":mtxt(c),"备注":ntxt(c),"典型文案":stxt(c)};
    const pc=pct(cn,gc.total), pl=pct(ln,gl.total);
    return {"失败归类":k,"总计_上期":ln,"总计_本期":cn,"单量对比值":cn-ln,
      "占失败比_上期":pl,"占失败比_本期":pc,"占失败比差额":r2(pc-pl),
      "主要支付方式":mtxt(c||l),"备注":ntxt(c||l),"典型文案":stxt(c||l)};
  });

  const tot = Object.fromEntries(cols.map(c=>[c,""]));
  tot["失败归类"]="失败合计"; tot.__total=true;
  tot["备注"]= gc.fallback.n
    ? `全表共 ${gc.fallback.n} 笔（占失败 ${pct(gc.fallback.n,gc.total)}%）未命中关键词，按兜底归入「${gc.fallback.label}」`
    : "";
  if(compare){ tot["总计_上期"]=gl.total; tot["总计_本期"]=gc.total; tot["单量对比值"]=gc.total-gl.total; }
  else { tot["笔数"]=gc.total; tot["占失败比"]= gc.total>0?100:0; }
  data.push(tot);
  return T(cols, data);
}

/* ============================================================
   维度分析表（对应 generate_grouped_table）
   categories: 传入则视为 pd.cut 的分类维度（如 amount_range），播种全部分类、丢弃非分类键
   ============================================================ */
function groupedRows(rows, col, categories){
  const m = aggregate(rows, col);
  let keys;
  if(categories){
    for(const c of categories) if(!m.has(c)) m.set(c,{n:0,succ:0});
    for(const k of [...m.keys()]) if(!categories.includes(k)) m.delete(k);
    keys = categories.slice();
  } else {
    keys = [...m.keys()];
  }
  return keys.map(k => ({ key:k, n:m.get(k).n, succ:m.get(k).succ }));
}

function generateGroupedTable(dfCurr, groupCol, groupLabel, dfLast, categories){
  const compare = dfLast != null;
  const totalCurr = dfCurr.length, totalLast = compare ? dfLast.length : 0;
  const cols = compare
    ? [groupLabel,"交易单量_上期","交易单量_本期","单量对比值","占比_上期","占比_本期","占比差额","通过率_上期","通过率_本期","通过率对比值","乘积"]
    : [groupLabel,"交易笔数","占比","成功笔数","通过率","影响力"];
  if(totalCurr===0 && totalLast===0) return T(cols);
  // hasCol 查的是源文件里有没有这一列，派生字段天然查不到 ——
  // amount_range 由 cutAmount 算出、day 由 pay_time 截出，都不在 COLUMN_MAP 里。
  // 以前这里只给 amount_range 开了个特例，新增 day 时踩了同一个坑：表头出来了、一行数据没有。
  if(!hasCol(groupCol) && !DERIVED_COLS.has(groupCol)) return T(cols);

  if(compare){
    const gc = new Map(groupedRows(dfCurr,groupCol,categories).map(x=>[x.key,x]));
    const gl = new Map(groupedRows(dfLast,groupCol,categories).map(x=>[x.key,x]));
    const keys = categories ? categories.slice() : [...new Set([...gc.keys(),...gl.keys()])];
    let rows = keys.map(k=>{
      const c=gc.get(k)||{n:0,succ:0}, l=gl.get(k)||{n:0,succ:0};
      const pC=pct(c.n,totalCurr), pL=pct(l.n,totalLast);
      const rC=pct(c.succ,c.n), rL=pct(l.succ,l.n);
      const rDiff=r2(rC-rL);
      return {key:k,nl:l.n,nc:c.n,diff:c.n-l.n,pL,pC,pd:r2(pC-pL),rL,rC,rDiff,prod:r4(pC/100*rDiff)};
    });
    rows.sort((a,b)=>Math.abs(b.prod)-Math.abs(a.prod));
    const data = rows.map(x=>({[groupLabel]:x.key,"交易单量_上期":x.nl,"交易单量_本期":x.nc,"单量对比值":x.diff,
      "占比_上期":x.pL,"占比_本期":x.pC,"占比差额":x.pd,"通过率_上期":x.rL,"通过率_本期":x.rC,"通过率对比值":x.rDiff,"乘积":x.prod}));
    const tot=Object.fromEntries(cols.map(c=>[c,""])); tot[groupLabel]="合计"; tot.__total=true;
    tot["交易单量_上期"]=rows.reduce((s,x)=>s+x.nl,0); tot["交易单量_本期"]=rows.reduce((s,x)=>s+x.nc,0);
    tot["单量对比值"]=rows.reduce((s,x)=>s+x.diff,0); tot["乘积"]=r4(rows.reduce((s,x)=>s+x.prod,0));
    data.push(tot);
    return T(cols,data);
  } else {
    const g = groupedRows(dfCurr,groupCol,categories);
    const sumSucc = g.reduce((s,x)=>s+x.succ,0);
    const overall = totalCurr>0 ? sumSucc/totalCurr*100 : 0;
    let rows = g.map(x=>{
      const p=pct(x.n,totalCurr), rate=pct(x.succ,x.n);
      return {key:x.key,n:x.n,succ:x.succ,p,rate,impact:r4(p/100*(rate-overall))};
    });
    rows.sort((a,b)=>Math.abs(b.impact)-Math.abs(a.impact));
    const data = rows.map(x=>({[groupLabel]:x.key,"交易笔数":x.n,"占比":x.p,"成功笔数":x.succ,"通过率":x.rate,"影响力":x.impact}));
    const tot=Object.fromEntries(cols.map(c=>[c,""])); tot[groupLabel]="合计"; tot.__total=true;
    tot["交易笔数"]=rows.reduce((s,x)=>s+x.n,0); tot["成功笔数"]=rows.reduce((s,x)=>s+x.succ,0); tot["通过率"]=r2(overall);
    data.push(tot);
    return T(cols,data);
  }
}

/* ============================================================
   通用：取绝对值 TOP N 行 / TOP N 取值
   ============================================================ */
function dataRows(table, label){ return table.data.filter(r => r[label] !== "合计" && !r.__sep); }
function filterTopNRows(table, label, rankCol, topN){
  let d = dataRows(table, label).filter(r => r[rankCol] !== "" && r[rankCol] != null);
  d = d.map(r => ({r, a: Math.abs(parseFloat(r[rankCol])||0)})).sort((x,y)=>y.a-x.a).slice(0,topN).map(x=>x.r);
  return T(table.columns, d);
}
function getTopNValues(table, label, rankCol, topN){
  let d = dataRows(table, label).filter(r => r[label]!=null && String(r[label]).trim()!=="" && r[rankCol]!=="" && r[rankCol]!=null);
  d = d.map(r=>({v:r[label], a:Math.abs(parseFloat(r[rankCol])||0)})).sort((x,y)=>y.a-x.a).slice(0,topN);
  return d.map(x=>x.v);
}

/* ============================================================
   维度×维度 长列表（对应 generate_cross_table）
   ============================================================ */
function crossAgg(rows, colA, colB){
  const m = new Map();
  for(const r of rows){
    const a=r[colA], b=r[colB];
    if(a==null || b==null) continue;         // observed=True + 双键 dropna
    /* 分隔符必须写成 \u0000 转义，不能直接放一个裸 NUL 字节 ——
       HTML 解析器会把源码里的裸 NUL 换成 U+FFFD，于是「建键时用裸字符、
       查键时用转义」的两处永远对不上，交叉表对比会把每个格子都判成「新增」。
       写成转义之后两边都是真 U+0000，也让这个文件不再被 grep 当成二进制。 */
    const k = String(a)+"\u0000"+String(b);
    let e=m.get(k); if(!e){e={a:String(a),b:String(b),n:0,succ:0}; m.set(k,e);}
    e.n++; if(isSucc(r)) e.succ++;
  }
  return m;
}
function generateCrossTable(dfCurr, colA, labelA, colB, labelB, dfLast){
  const compare = dfLast != null;
  const totalCurr=dfCurr.length, totalLast=compare?dfLast.length:0;
  const cols = compare
    ? [labelA,labelB,"交易单量_上期","交易单量_本期","单量对比值","占比_上期","占比_本期","占比差额","通过率_上期","通过率_本期","通过率对比值","乘积"]
    : [labelA,labelB,"交易笔数","占比","成功笔数","通过率","影响力"];
  if(totalCurr===0 && totalLast===0) return T(cols);
  if((!hasCol(colA)&&!DERIVED_COLS.has(colA))||(!hasCol(colB)&&!DERIVED_COLS.has(colB))) return T(cols);

  if(compare){
    const gc=crossAgg(dfCurr,colA,colB), gl=crossAgg(dfLast,colA,colB);
    const keys=[...new Set([...gc.keys(),...gl.keys()])];
    let rows=keys.map(k=>{
      const c=gc.get(k)||{n:0,succ:0}, l=gl.get(k)||{n:0,succ:0};
      const ref=gc.get(k)||gl.get(k);
      const pC=pct(c.n,totalCurr),pL=pct(l.n,totalLast),rC=pct(c.succ,c.n),rL=pct(l.succ,l.n),rDiff=r2(rC-rL);
      return {a:ref.a,b:ref.b,nl:l.n,nc:c.n,diff:c.n-l.n,pL,pC,pd:r2(pC-pL),rL,rC,rDiff,prod:r4(pC/100*rDiff)};
    }).filter(x=>x.nl>0||x.nc>0);
    rows.sort((a,b)=>Math.abs(b.prod)-Math.abs(a.prod));
    const data=rows.map(x=>({[labelA]:x.a,[labelB]:x.b,"交易单量_上期":x.nl,"交易单量_本期":x.nc,"单量对比值":x.diff,
      "占比_上期":x.pL,"占比_本期":x.pC,"占比差额":x.pd,"通过率_上期":x.rL,"通过率_本期":x.rC,"通过率对比值":x.rDiff,"乘积":x.prod}));
    const tot=Object.fromEntries(cols.map(c=>[c,""])); tot[labelA]="合计"; tot.__total=true;
    tot["交易单量_上期"]=rows.reduce((s,x)=>s+x.nl,0); tot["交易单量_本期"]=rows.reduce((s,x)=>s+x.nc,0);
    tot["单量对比值"]=rows.reduce((s,x)=>s+x.diff,0); tot["乘积"]=r4(rows.reduce((s,x)=>s+x.prod,0));
    data.push(tot); return T(cols,data);
  } else {
    const g=[...crossAgg(dfCurr,colA,colB).values()].filter(x=>x.n>0);
    const sumSucc=g.reduce((s,x)=>s+x.succ,0), overall=totalCurr>0?sumSucc/totalCurr*100:0;
    let rows=g.map(x=>{const p=pct(x.n,totalCurr),rate=pct(x.succ,x.n);return {...x,p,rate,impact:r4(p/100*(rate-overall))};});
    rows.sort((a,b)=>Math.abs(b.impact)-Math.abs(a.impact));
    const data=rows.map(x=>({[labelA]:x.a,[labelB]:x.b,"交易笔数":x.n,"占比":x.p,"成功笔数":x.succ,"通过率":x.rate,"影响力":x.impact}));
    const tot=Object.fromEntries(cols.map(c=>[c,""])); tot[labelA]="合计"; tot.__total=true;
    tot["交易笔数"]=rows.reduce((s,x)=>s+x.n,0); tot["成功笔数"]=rows.reduce((s,x)=>s+x.succ,0); tot["通过率"]=r2(overall);
    data.push(tot); return T(cols,data);
  }
}

/* ============================================================
   维度×维度 矩阵（对应 generate_cross_matrix，始终看本期数据）
   ============================================================ */
function generateCrossMatrix(dfCurr, colA, labelA, colB, labelB){
  if((!hasCol(colA)&&!DERIVED_COLS.has(colA))||(!hasCol(colB)&&!DERIVED_COLS.has(colB))||dfCurr.length===0) return null;
  const norm = v => { let s=(v==null)?"":String(v).trim(); if(["nan","none",""].includes(s.toLowerCase()))s=""; return s; };
  const rows = dfCurr.filter(r => norm(r[colA])!=="" && norm(r[colB])!=="");
  if(rows.length===0) return null;

  const rowKeys=[...new Set(rows.map(r=>norm(r[colA])))].sort(bySortedKey);
  const colKeys=[...new Set(rows.map(r=>norm(r[colB])))].sort(bySortedKey);
  const cnt={}, suc={};
  for(const rk of rowKeys){cnt[rk]={};suc[rk]={};for(const ck of colKeys){cnt[rk][ck]=0;suc[rk][ck]=0;}}
  for(const r of rows){const rk=norm(r[colA]),ck=norm(r[colB]);cnt[rk][ck]++;if(isSucc(r))suc[rk][ck]++;}
  /* 用 pct（两位小数）而不是 r2(x*1000)/10。后者先在千分位取整再除以 10，
     把浮点误差又引了回来 —— 实测 1/7 显示成 14.286000000000001%。
     而且三位小数对 7 笔样本是虚假精度，工具里其余地方一律两位。 */
  const cell=(c,s)=> c===0?"":`${c}笔(${pct(s,c)}%)`;

  const headCol = `${labelA}↓ \\ ${labelB}→`;
  const cols=[headCol,...colKeys,"行合计"];
  const data=[];
  for(const rk of rowKeys){
    const o={[headCol]:rk}; let rTot=0,rSuc=0;
    for(const ck of colKeys){o[ck]=cell(cnt[rk][ck],suc[rk][ck]); rTot+=cnt[rk][ck]; rSuc+=suc[rk][ck];}
    o["行合计"]=cell(rTot,rSuc); data.push(o);
  }
  const colTot={[headCol]:"列合计"}; colTot.__total=true; let gT=0,gS=0;
  for(const ck of colKeys){let cT=0,cS=0;for(const rk of rowKeys){cT+=cnt[rk][ck];cS+=suc[rk][ck];}colTot[ck]=cell(cT,cS);gT+=cT;gS+=cS;}
  colTot["行合计"]=cell(gT,gS); data.push(colTot);
  return T(cols,data);
}

/* ============================================================
   维度×失败原因（对应 generate_dim_failreason_cross）
   ============================================================ */
function generateDimFailreasonCross(dfCurrEx, colA, labelA, dfLastEx, onlyDims){
  const compare = dfLastEx != null;
  const cols = compare
    ? [labelA,"支付失败原因","失败笔数_上期","失败笔数_本期","失败单量对比值","占该维度失败比_上期","占该维度失败比_本期","占总失败比_本期"]
    : [labelA,"支付失败原因","失败笔数","占该维度失败比","占总失败比"];
  if(!hasCol(colA) && !DERIVED_COLS.has(colA)) return T(cols);

  let failC = excludeL3(dfCurrEx.filter(r=>isFail(r)));
  let failL = compare ? excludeL3(dfLastEx.filter(r=>isFail(r))) : null;
  if(onlyDims){
    const keep = new Set(onlyDims.map(String));
    failC = failC.filter(r=>keep.has(String(r[colA])));
    if(compare) failL = failL.filter(r=>keep.has(String(r[colA])));
  }
  const fTotC=failC.length, fTotL=compare?failL.length:0;
  if(fTotC===0 && fTotL===0) return T(cols);

  const key=(r)=>{const a=r[colA],f=r.fail_reason; if(a==null||f==null) return null; return String(a)+"\u0000"+String(f);};
  const dimTot = (rows)=>{const m=new Map();for(const r of rows){const a=r[colA];if(a==null)continue;m.set(String(a),(m.get(String(a))||0)+1);}return m;};

  if(compare){
    const gc=new Map(),gl=new Map();
    for(const r of failC){const k=key(r);if(!k)continue;let e=gc.get(k);if(!e){e={a:String(r[colA]),f:String(r.fail_reason),n:0};gc.set(k,e);}e.n++;}
    for(const r of failL){const k=key(r);if(!k)continue;let e=gl.get(k);if(!e){e={a:String(r[colA]),f:String(r.fail_reason),n:0};gl.set(k,e);}e.n++;}
    const dtC=dimTot(failC), dtL=dimTot(failL);
    const keys=[...new Set([...gc.keys(),...gl.keys()])];
    let rows=keys.map(k=>{const c=gc.get(k),l=gl.get(k),ref=c||l;const nc=c?c.n:0,nl=l?l.n:0;
      return {a:ref.a,f:ref.f,nl,nc,diff:nc-nl,pdl:pct(nl,dtL.get(ref.a)||0),pdc:pct(nc,dtC.get(ref.a)||0),ptc:pct(nc,fTotC)};});
    rows.sort((a,b)=>b.nc-a.nc);
    const data=rows.map(x=>({[labelA]:x.a,"支付失败原因":x.f,"失败笔数_上期":x.nl,"失败笔数_本期":x.nc,"失败单量对比值":x.diff,
      "占该维度失败比_上期":x.pdl,"占该维度失败比_本期":x.pdc,"占总失败比_本期":x.ptc}));
    const tot=Object.fromEntries(cols.map(c=>[c,""]));tot[labelA]="合计";tot.__total=true;
    tot["失败笔数_上期"]=rows.reduce((s,x)=>s+x.nl,0);tot["失败笔数_本期"]=rows.reduce((s,x)=>s+x.nc,0);tot["失败单量对比值"]=rows.reduce((s,x)=>s+x.diff,0);
    data.push(tot); return T(cols,data);
  } else {
    const g=new Map();
    for(const r of failC){const k=key(r);if(!k)continue;let e=g.get(k);if(!e){e={a:String(r[colA]),f:String(r.fail_reason),n:0};g.set(k,e);}e.n++;}
    const dt=dimTot(failC);
    let rows=[...g.values()].map(x=>({...x,pd:pct(x.n,dt.get(x.a)||0),pt:pct(x.n,fTotC)}));
    rows.sort((a,b)=>b.n-a.n);
    const data=rows.map(x=>({[labelA]:x.a,"支付失败原因":x.f,"失败笔数":x.n,"占该维度失败比":x.pd,"占总失败比":x.pt}));
    const tot=Object.fromEntries(cols.map(c=>[c,""]));tot[labelA]="合计";tot.__total=true;
    tot["失败笔数"]=rows.reduce((s,x)=>s+x.n,0);
    data.push(tot); return T(cols,data);
  }
}

/* ============================================================
   编排：维度×维度 三张表 / 维度×失败 两张表
   ============================================================ */
function pushDimDim(dfCurrEx, prefix, colA, labelA, shortA, colB, labelB, shortB, sheets, dfLastEx){
  const compare = dfLastEx != null;
  const full = generateCrossTable(dfCurrEx,colA,labelA,colB,labelB,compare?dfLastEx:null);
  const rankCol = compare ? "乘积" : "影响力";
  const top = filterTopNRows(full,labelA,rankCol,DRILL_DOWN_TOP_N);
  const matrix = generateCrossMatrix(dfCurrEx,colA,labelA,colB,labelB);
  const combo=`${shortA}x${shortB}`;
  sheets.push([`${prefix}_${combo}_全量`,full]);
  sheets.push([`${prefix}_${combo}_高影响力`,top]);
  sheets.push([`${prefix}_${combo}_矩阵`, matrix || T(["（无有效数据）"])]);
}
function pushDimFail(dfCurrEx, prefix, colA, labelA, shortA, singleTable, sheets, dfLastEx){
  const compare = dfLastEx != null;
  const rankCol = compare ? "乘积" : "影响力";
  const full = generateDimFailreasonCross(dfCurrEx,colA,labelA,compare?dfLastEx:null,null);
  const topVals = getTopNValues(singleTable,labelA,rankCol,DRILL_DOWN_TOP_N);
  const top = topVals.length ? generateDimFailreasonCross(dfCurrEx,colA,labelA,compare?dfLastEx:null,topVals) : T(full.columns);
  const combo=`${shortA}x失败`;
  sheets.push([`${prefix}_${combo}_全量`,full]);
  sheets.push([`${prefix}_${combo}_高影响力`,top]);
}


export { crossAgg, dataRows, dimAvail, dimRows, dimTable, failGroupTableOf,
         filterTopNRows, generateCrossMatrix, generateCrossTable,
         generateDimFailreasonCross, generateFailGroupTable, generateFailreasonTable,
         generateGroupedTable, getTopNValues, groupedRows, pushDimDim, pushDimFail };
