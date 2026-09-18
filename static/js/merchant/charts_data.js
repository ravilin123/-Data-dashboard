import { isFail, isSucc, r2, r4 } from './util.js';

/* ============================================================
   图表层的**取数**（2026-09-09 从 merchant.html 的「图表」那 983 行里抽出来的）

   `static/js/merchant/README.md` 里写着接着拆的顺序：
   **先把每张卡片的取数抽成纯函数（那部分才有口径），渲染留在页面。**
   这份就是那一步 —— 只抽「算什么」，一行 DOM 都不碰。

   ⚠️ **口径（笔数 / 金额）改成显式参数 `amount`，不再读 `isAmt()` 那个界面全局。**
   原来这些函数在渲染函数内部直接读 `state.metric`，于是同一个函数在两种口径下
   行为不同、而调用点看不出来。现在调用方传 `isAmt()` 进来，行为一字不变，
   但函数可以单独喂两种口径各跑一遍（`tests/merchant_charts.mjs` 就是这么钉的）。

   还留在页面里的是纯渲染：SVG 拼装、tooltip、图例、联动筛选的接线。
   ⚠️ 别为了拆而拆 —— 纯拼 HTML 的代码搬到另一个文件里并不会变得更安全。
   ============================================================ */

/** 一批行的整体口径。`amount=true` 走金额，否则走笔数。 */
function aggMetric(rows, amount){
  let n=0, succ=0, fail=0, amt=0, sA=0, fA=0;
  for(const r of rows){
    const a=+r.amount||0; n++; amt+=a;
    if(isSucc(r)){ succ++; sA+=a; } else if(isFail(r)){ fail++; fA+=a; }
  }
  const rate = amount ? (amt>0?r2(sA/amt*100):0) : (n>0?r2(succ/n*100):0);
  return {n, succ, fail, amt, succAmt:sA, failAmt:fA, rate};
}

/**
 * 分组聚合（口径感知）。供图表层用；报表/导出仍走 `tables.js` 里已验证的计数内核。
 *
 * `impact`（影响力）= 占比 × (本组通过率 − 整体通过率)。
 * ⚠️ **Σimpact 恒等于 0**，所以它只能用来排序「谁在拖累」，
 * 不能当成「这组损失了多少」。`tests/table_text.mjs` 那边也钉着这条。
 */
function groupMetric(rows, col, categories, amount){
  const m=new Map();
  for(const r of rows){
    let k=r[col]; if(k==null) continue;
    k=String(k);
    let e=m.get(k); if(!e){ e={n:0,succ:0,amt:0,sA:0}; m.set(k,e); }
    const a=+r.amount||0; e.n++; e.amt+=a;
    if(isSucc(r)){ e.succ++; e.sA+=a; }
  }
  let keys;
  if(categories){
    for(const cc of categories) if(!m.has(cc)) m.set(cc,{n:0,succ:0,amt:0,sA:0});
    for(const k of [...m.keys()]) if(!categories.includes(k)) m.delete(k);
    keys=categories.slice();
  } else keys=[...m.keys()];
  const W=k=>amount?m.get(k).amt:m.get(k).n, SW=k=>amount?m.get(k).sA:m.get(k).succ;
  const totW=keys.reduce((s,k)=>s+W(k),0), sumS=keys.reduce((s,k)=>s+SW(k),0);
  const overall=totW>0?r2(sumS/totW*100):0;
  const out=keys.map(k=>{
    const e=m.get(k), w=W(k), sw=SW(k);
    const rate=w>0?r2(sw/w*100):0, share=totW>0?r2(w/totW*100):0;
    return {v:k, n:e.n, succ:e.succ, amt:e.amt, succAmt:e.sA, weight:w, share, rate,
            impact:r4(share/100*(rate-overall))};
  });
  return {rows:out, overall};
}

/** 失败原因帕累托：按笔数或金额降序，带累计占比。 */
function failGroups(view, amount){
  const fails=view.filter(r=>isFail(r));
  const m=new Map();
  for(const r of fails){
    const k=(r.fail_reason==null||r.fail_reason==="")?"（无原因）":String(r.fail_reason);
    let e=m.get(k); if(!e){ e={k,n:0,amt:0}; m.set(k,e); }
    e.n++; e.amt+=(+r.amount||0);
  }
  const wf=e=>amount?e.amt:e.n;
  const arr=[...m.values()].sort((a,b)=>wf(b)-wf(a));
  const total=arr.reduce((s,x)=>s+wf(x),0);
  let cum=0;
  arr.forEach(x=>{ x.share=total>0?r2(wf(x)/total*100):0; cum=r2(cum+x.share); x.cum=cum; });
  return {arr, total};
}

/**
 * 变化归因：**单个维度内部**的加权分解。
 *
 *     结构效应_i   = (w2_i − w1_i) × r1_i     —— 流量搬家造成的
 *     通过率效应_i = w2_i × (r2_i − r1_i)     —— 同口径下真的变了
 *
 * 两者相加对该维度整体的变化是**恒等**的（差额只来自四舍五入）。
 * 卡片底下写出对账行，对不上就说明算错了，不藏。
 *
 * ⚠️ **上期有、本期整个没了的取值必须算进来**：它带走的权重同样解释了变化，
 * 漏掉就对不上账 —— 而对不上账时读的人只会以为是四舍五入。
 *
 * ⚠️ **本期新增的取值，反事实基线取「上期整体通过率」，不是 0。**（2026-09-09 修）
 * 恒等式对 r1 取什么值都成立（两项里的 r1 会相消），但原来的写法是
 * `eStruct` 按 r1=0 算、`eRate` 直接写死 0 —— 两处用了不同的 r1，恒等式当场破掉。
 * 实测：上期只有 A（80%），本期 A 和 D 各占一半（D 90%），整体 +5pt，
 * 分解出来只有 −40pt，**差 45pt，而卡片把它写成「差 45 pt 为四舍五入」**。
 * 取 `overall1` 之后两项都有意义：结构效应 = 新增的这批量按老平均水平该贡献多少，
 * 通过率效应 = 它实际比老平均好/差多少。`tests/merchant_charts.mjs` 的 [4] 钉着。
 *
 * ⚠️ **只对一个维度做分解。** 恒等式在单个维度内部才成立；把 BIN/金额/方式
 * 三维的分解加起来等于把同一个总变化重复解释三遍（实测算出 −38.64pt 结构
 * + 32.02pt 通过率，而整体只变了 −3.05pt），而且 BIN 维的分母是卡支付、
 * 根本不与整体对账。
 */
function changeAttrib(gm, gmLast, col){
  const lm=new Map(gmLast.rows.map(r=>[r.v,r]));
  const items=[];
  const base=gmLast.overall;          // 新增取值的反事实基线：上期整体通过率
  for(const r of gm.rows){
    const l=lm.get(r.v), w2=r.share/100, w1=l?l.share/100:0, r1=l?l.rate:base;
    const eS=r4((w2-w1)*r1), eR=r4(w2*(r.rate-r1));
    items.push({v:r.v, col, rate:r.rate, share:r.share, n:r.n,
                lastRate:l?l.rate:null, lastShare:l?l.share:null,
                eStruct:eS, eRate:eR, impact:r4(eS+eR), fresh:!l});
  }
  for(const [v,l] of lm) if(!gm.rows.some(r=>r.v===v))
    items.push({v, col, rate:0, share:0, n:0, lastRate:l.rate, lastShare:l.share,
                eStruct:r4((0-l.share/100)*l.rate), eRate:0,
                impact:r4((0-l.share/100)*l.rate), gone:true});
  const sumStruct=r2(items.reduce((a,x)=>a+x.eStruct,0));
  const sumRate  =r2(items.reduce((a,x)=>a+x.eRate,0));
  const actual   =r2(gm.overall-gmLast.overall);
  return {items, sumStruct, sumRate, actual, diff:r2(actual-(sumStruct+sumRate))};
}

/** 影响力条要画哪几项：三个维度合起来按 |影响力| 取前 N。 */
function impactItems(pairs, limit=12){
  const items=[];
  for(const [gm, col, dimLabel] of pairs){
    if(!gm) continue;
    gm.rows.forEach(r=>items.push({dim:dimLabel, col, v:r.v, impact:r.impact,
                                   rate:r.rate, share:r.share, n:r.n, amt:r.amt}));
  }
  return items.filter(x=>isFinite(x.impact) && x.impact!==0)
              .sort((a,b)=>Math.abs(b.impact)-Math.abs(a.impact))
              .slice(0, limit);
}

/** 时段 × 星期 的 7×24 网格。周一在第 0 行（`getDay()` 是周日=0，要挪一位）。 */
function timeHeatGrid(rows){
  const g=[];
  for(let d=0; d<7; d++){ g[d]=[]; for(let h=0; h<24; h++) g[d][h]={n:0, succ:0, amt:0, sA:0}; }
  for(const r of rows){
    const dt=r.pay_time, wd=(dt.getDay()+6)%7, h=dt.getHours(), a=+r.amount||0, x=g[wd][h];
    x.n++; x.amt+=a;
    if(isSucc(r)){ x.succ++; x.sA+=a; }
  }
  return g;
}
const heatRate = (g, amount) => g.n===0 ? null
  : (amount ? (g.amt>0 ? g.sA/g.amt*100 : 0) : (g.succ/g.n*100));

/** 热力图对比时的色标上界（单位 pt）。 */
const HEAT_MIN_N = 5;

/**
 * 定标**只看两期都有一定笔数的格子**。
 * 让 1~2 笔的格子参与定标的话，一个 0%→100% 就把刻度撑到 ±100，
 * 真正有量的格子全成浅色 —— 实测撑到 ±56.67pt。
 * 小样本格子照常上色，只是不参与定刻度；全是小样本时才退回全量定标。
 */
function heatScale(grid, gridLast, amount){
  let maxAbs=0;
  const scan=minN=>{
    for(let d=0; d<7; d++) for(let h=0; h<24; h++){
      const g=grid[d][h], gl=gridLast[d][h];
      if(g.n<minN || gl.n<minN) continue;
      const a=heatRate(g, amount), b=heatRate(gl, amount);
      if(a!=null && b!=null) maxAbs=Math.max(maxAbs, Math.abs(a-b));
    }
  };
  scan(HEAT_MIN_N);
  if(!maxAbs) scan(0);
  return maxAbs;
}

export { HEAT_MIN_N, aggMetric, changeAttrib, failGroups, groupMetric,
         heatRate, heatScale, impactItems, timeHeatGrid };
