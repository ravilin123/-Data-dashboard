import { ALL_METRICS, DEPS, FRICTION_METRICS, FUNNEL_MAIN, FUNNEL_SUBS, LEVEL_THRESHOLDS, METRIC_CHILDREN, METRIC_DEPTH, METRIC_STAGE, OVERALL_METRIC, P, PERIOD } from './config.js';
import { trim } from '../shared/text.js';
import { num } from './util.js';

/* ============================================================
   4. 逆算分子/分母（对应 chain_denom / calc_funnel）
   ============================================================ */
/**
 * 分母不等于「父指标分子」的例外。
 * 4.1 非3DS网关通过率：真实分母是「非3DS提交单量」，不是提交网关总量。
 * 用大盘真值（源表 分子/分母 列）核对过，直接拿父(3.)的分子会把分母高估：
 *   独立站API直连 6048 vs 真值 5211(+16%)、标准收银台 2738 vs 1960(+40%)、所有场景 11382 vs 9105(+25%)。
 * 该值无法由父链精确推出（提交总量 − 3DS验证通过量 = 5163，真值 5211，差 48，
 * 差额来自退款/重试，与「是否>PO」提示的现象同源），此处取该近似，误差约 1~2%，
 * 远小于原来的 16~40%。场景维度若带 分子/分母 列，则一律以真值为准（见 sceneCounts）。
 */
const SPECIAL_DENOM = {
  '4.1 非3DS网关通过率': (row,suf)=>
    Math.max(0, chainNumer(row,'3. 网关提交率',suf) - chainNumer(row,'3.3 3DS通过率',suf)),
};

/** 有没有完整的分母链 —— 没有就算不出「进入/通过本环节」的单量。 */
function hasDenomChain(metric){
  let m=metric, guard=0;
  while(guard++ < 20){
    if(SPECIAL_DENOM[m]) return true;
    const p=DEPS[m];
    if(p===undefined) return false;   // 复合指标（如「1. 业务单支付转化率」= 1.1×1.2）没有自己的分母
    if(p==='PO单数') return true;
    m=p;
  }
  return false;
}

function chainDenom(row, metric, suf){
  const sp = SPECIAL_DENOM[metric];
  if(sp) return sp(row, suf);
  const parent = DEPS[metric];
  // 没有父级就到头了。原来这里直接往下递归，parent 为 undefined 时
  // chainDenom(row, undefined) 又查不到 DEPS[undefined]，于是无限递归栈溢出。
  if(parent===undefined) return NaN;
  if(parent==='PO单数') return num(row['PO单数'+suf]);
  const pdenom = chainDenom(row, parent, suf);
  return pdenom * num(row[parent+suf]);
}
function chainNumer(row, metric, suf){
  return chainDenom(row, metric, suf) * num(row[metric+suf]);
}
function calcFunnel(row, metric, suf){
  const denom = chainDenom(row, metric, suf);
  const numer = denom * num(row[metric+suf]);
  return [Math.round(denom), Math.round(numer)];
}

/* ============================================================
   4.5 分层归因：大环节累乘 + 精确分解 + 阈值分层
   ============================================================ */
/** 把「当期值」统一成小数比率（0.82 = 82%）。沿用 fmtVal 的约定：|v|<=1.5 视为已是小数。 */
function toRate(v){
  if(v==null||v==='') return null;
  if(typeof v==='number') return Math.abs(v)<=1.5 ? v : v/100;
  const s=String(v).trim(), hasPct=s.includes('%');
  const n=parseFloat(s.replace(/[%,]/g,''));
  if(!Number.isFinite(n)) return null;
  return hasPct ? n/100 : (Math.abs(n)<=1.5 ? n : n/100);
}

/** 场景维度 → {来源: {指标: 比率}}（指定期） */
function sceneMap(dfScene, date){
  const out={};
  for(const o of dfScene){
    if(o['统计日期']!==date) continue;
    const s=trim(o['来源']), m=trim(o['类型']);
    if(!s||!m) continue;
    (out[s]=out[s]||{})[m]=toRate(o['当期值']);
  }
  return out;
}
/**
 * 源表自带的「环比」单元格 → 小数比率。
 *
 * **按形态判，不按大小** —— 和 toRate 同一个道理。原来写的是
 * `Math.abs(d)<1 ? d : d/100`，用数值大小猜单位，遇到翻倍以上的变动就崩：
 * 2026-07-30 那份报表 2076 个环比单元格全是数值（没有一个带 %），其中 14 个 |值|>=1
 * 会被那句除以 100 ——
 *     7.0046（+700%）  → 读成 +7.0%
 *     1.6154（+161%）  → 读成 +1.62%
 *     -1.0000（跌到 0）→ 读成 -1.0%
 * 风控-3DS 这类摩擦指标（上升阈值 +2%）翻一倍半是常事，全被压在阈值下一声不响。
 * 和 toRate/num 那次一模一样：两级都不报错，只是一直判错。
 *
 * 现在的规则：带 % 的文本才除 100；数值原样用。
 * 万一上游哪天改发「-13.42」这种不带 % 的百分数，detect() 的口径校验会立刻叫出来
 * ——那正是它存在的意义。
 */
function parseDodCell(v){
  if(v==null || v==='') return null;
  if(typeof v==='number') return Number.isFinite(v) ? v : null;
  const s=String(v).trim(); if(!s) return null;
  const n=parseFloat(s.replace(/[,\s]/g,'').replace('%',''));
  if(!Number.isFinite(n)) return null;
  return s.includes('%') ? n/100 : n;
}

/**
 * 现算环比：(今 − 昨) / 昨。
 *
 * 口径已核实（2026-09-08，2026-07-30 旧格式报表 346 对可比数据）：源表那一列是
 * **相对环比**，不是 pt 差值 —— 所以这里照相对算，和源表能对得上。
 *
 * 为什么不再读源表那列（第四轮 A1）：瀑布图、商户下钻、影响比率走的都是你在下拉里
 * 选的那对日期，而源表的环比恒定是「对上一期」。两期相邻时恰好一致，一往前翻
 * 就是同一屏两套口径。现在告警也走这里，全屏一个口径。
 *
 * 算不出来返回 null（上期没有这一行、上期值为 0、任一期读不出比率）——
 * 调用方要把这种情况计数报出来，别静默丢：首期数据和新上线的来源都会走到这条。
 */
function dodOf(mapT, mapY, source, metric){
  const t = mapT[source] ? mapT[source][metric] : null;
  const y = mapY[source] ? mapY[source][metric] : null;
  if(t==null || y==null || !Number.isFinite(t) || !Number.isFinite(y) || y===0) return null;
  return (t - y) / y;
}

/** 源表「分子/分母」列 → {来源:{指标:{n,d}}}。有它就不必逆算，单量是真值。 */
function sceneCounts(dfScene, date){
  const out={};
  for(const o of dfScene){
    if(o['统计日期']!==date || o._n==null || o._d==null) continue;
    const s=trim(o['来源']), m=trim(o['类型']);
    if(!s||!m) continue;
    (out[s]=out[s]||{})[m]={n:o._n, d:o._d};
  }
  return out;
}

/** 取一个大环节的比率：有独立指标就直接取，否则由 parts 相乘（环节1 = 1.1 × 1.2）。 */
function mainRate(mmap, stage){
  if(stage.metric) return (mmap && mmap[stage.metric]!=null) ? mmap[stage.metric] : null;
  let p=1, ok=false;
  for(const part of stage.parts){
    const v=mmap ? mmap[part] : null;
    if(v==null) return null;      // 缺任一子项则整段不可算
    p*=v; ok=true;
  }
  return ok?p:null;
}

/**
 * 逐大环节累乘，并把「整体环比差额」精确分解到各环节。
 * 分解式： 贡献_i = (∏_{j<i} r今_j) × (r今_i − r昨_i) × (∏_{j>i} r昨_j)
 * 该式对 i 求和恒等于 ∏r今 − ∏r昨（telescoping），因此无残差。
 */
function funnelStages(mT, mY){
  const info=FUNNEL_MAIN.map(s=>({
    code:s.code, label:s.label,
    rateT:mainRate(mT,s), rateY:mainRate(mY,s),
  }));
  // 累乘（缺失环节按 1.0 跳过，与参考看板一致）
  let cum=1, cumY=1;
  for(const x of info){
    x.before=cum;
    x.after = x.rateT==null ? cum : cum*x.rateT;
    x.loss  = x.before-x.after;      // 本环节流失（占整体的 pt）
    cum=x.after;
    x.afterY = x.rateY==null ? cumY : cumY*x.rateY;   // 上期累计，用于瀑布虚线对照
    cumY=x.afterY;
  }
  const overallT=cum;

  const haveBoth = info.every(x=>x.rateT!=null && x.rateY!=null);
  let overallY=null, dOverall=null;
  if(haveBoth){
    overallY=info.reduce((p,x)=>p*x.rateY,1);
    dOverall=overallT-overallY;
    for(let i=0;i<info.length;i++){
      let pre=1;  for(let j=0;j<i;j++)            pre*=info[j].rateT;
      let post=1; for(let j=i+1;j<info.length;j++) post*=info[j].rateY;
      info[i].contrib = pre*(info[i].rateT-info[i].rateY)*post;
      info[i].dodRel  = info[i].rateY ? (info[i].rateT-info[i].rateY)/info[i].rateY : null;
    }
  }
  return {
    stages:info, overallT, overallY, dOverall,
    overallSheetT: mT? mT[OVERALL_METRIC]??null : null,
    overallSheetY: mY? mY[OVERALL_METRIC]??null : null,
  };
}

/* ============================================================
   4.6 折算到大盘：折损单量（B1 + B2）
   ============================================================ */
/**
 * 某来源里，该指标所在大环节**之后**那些大环节的通过率累乘。
 *
 * 这是 B2 的关键：`影响比率` 是**该指标自己那一层**的 pt，跨环节不可比。
 *   · `2. 业务校验通过率` 掉 1pt → 下游几乎全量承接，大盘直接掉 ~1pt
 *   · `4.2.2 政策3DS网关通过率` 掉 10pt → 只作用在「政策 3DS 那一小撮单」上
 * 两条以前按同一个 `_impact_abs` 排在一张表里，深层指标因为分母小、波动大，
 * **系统性地排在前面** —— 排序本身在骗人。
 *
 * ⚠ 用的是**来源级**的下游通过率，不是这家商户自己的。商户级的下游值稀疏又噪，
 *   而「这一单过了这个节点之后还要过几关」对同来源的商户基本一致。
 *   这是个近似，写在这里免得以后有人以为它是精确值。
 */
function downstreamPass(f, metric){
  const code = METRIC_STAGE[metric];
  if(!f || !f.stages || code==null) return 1;
  let p=1;
  for(const s of f.stages){
    if(String(s.code) <= String(code)) continue;   // 大环节编号是单个数字，字符串比较够用
    if(s.rateT!=null) p*=s.rateT;
  }
  return p;
}

/**
 * 一条「商户 × 指标」的变动，折算成**大盘最终增减了多少支付成功单**。
 *
 *   影响单量 = Δ比率 × 该环节分母 × 下游各环节通过率累乘
 *
 * 符号跟着 Δ 走：**负数 = 少了这么多单**，和 `影响比率` 同向，读起来不用换脑子。
 * 除以该来源的 PO 总量就是「对大盘的 pt 贡献」，这一步让所有环节回到同一把尺子上。
 *
 * denom 为 null（复合指标没有自己的分母链）时返回 null —— 不编数。
 */
function orderImpact(delta, denom, downstream){
  if(delta==null || denom==null) return null;
  if(!Number.isFinite(delta) || !Number.isFinite(denom)) return null;
  return delta * denom * (Number.isFinite(downstream) ? downstream : 1);
}

/** 各来源的大环节分析。 */
function stageAnalysis(dfScene, tDate, yDate){
  const mapT=sceneMap(dfScene,tDate), mapY=sceneMap(dfScene,yDate);
  const cntT=sceneCounts(dfScene,tDate);
  const out={};
  for(const src of Object.keys(mapT)){
    out[src]=funnelStages(mapT[src], mapY[src]||{});
    out[src].counts = cntT[src] || null;   // 大盘真实单量（源表带 分子/分母 时才有）
  }
  return out;
}

/* ============================================================
   4.7 基准线三级回退（B4）
   ============================================================ */
/**
 * 从基准线里挑该 `来源 × 指标` 该用哪个池子。三级，**顺序不能换**：
 *
 *   1. 本来源自己的池   —— 准。Element 和独立站API 的波动尺度差得远，
 *                          混在一起算出来的稳健 σ 被小来源的噪声抬高，
 *                          大来源的真异常会被那个抬高的阈值吃掉（B4 说的就是这件事）
 *   2. 全来源混池       —— 有。实测周报/月报按来源分池样本根本不够（0/54 个池够格），
 *                          没有这一级等于分池之后大家一起退回层级兜底，比不分还差
 *   3. null → 调用方走层级兜底
 *
 * ⚠️ **向后兼容**：v2 之前存下来的基准线形状是 `{指标: 阈值}`（没有 `v`）。
 *    用户的 localStorage 里就躺着这种，直接按新形状读会得到 undefined ——
 *    然后**静默**退回层级兜底，界面还照样说「基准线已启用」。
 *    所以没有 `v` 的一律当混池收，`tests/baseline.mjs` 的 [5] 钉着。
 */
function pickPool(b, metric, source){
  if(!b) return null;
  if(!(b.v>=2)) return b[metric] ? {stat:b[metric], basis:'基准线·混池'} : null;
  const k = source ? source+'|'+metric : null;
  if(k && b.bySrc && b.bySrc[k]) return {stat:b.bySrc[k], basis:'基准线·本来源'};
  /* ⚠️ 混池**不是无条件**的。这些来源在这个指标上水平差太远（或样本不足以判断）时，
     混池阈值对它就是错的 —— 直接跳到层级兜底，见 buildBaseline 里那段和
     config.js 的 MIX_MAX_GAP。实测差 67pt 的都有，那种混池报出来的每一条都是误报。 */
  if(k && b.noMix && b.noMix[k]) return null;
  if(b.mixed && b.mixed[metric])  return {stat:b.mixed[metric], basis:'基准线·混池'};
  return null;
}
/**
 * 水平分位数（B3）**只认本来源自己的池，没有混池这一级**。
 *
 * ⚠️ 这一条和上面的环比不一样，别照抄。环比混池勉强说得过去 ——
 * 各来源的「变化幅度」量纲相近；**绝对水平不行**，来源之间差几十 pt。
 * 拿真实报表实测过，混池那版报出来的头几条是这样的：
 *
 *     某来源 · 2. 业务校验通过率   本期 29.70%   混池 P10 31.88%   混池中位 98.94%
 *
 * 中位 98.94% 是**另外两个来源**的水平；这个来源那几期就在 30% 上下 ——
 * 它自己的分布里 29.70% 一点也不异常（自己的中位是 31.85%）。
 * 于是混池会让它每天都「低于 P10」，每天都报，而且那种噪声还特别像真的。
 * 同一个指标各来源水平接近时混池碰巧能用，差得远时天天误报，两者没法在代码里区分。
 * 所以宁可不出信号：`levelSignals` 会把「没池子」和「没信号」分开说。
 *
 * ⚠️ **这是「混池会误报」的例子，不是「那个指标有问题」。** 数据截到 2026-09-06；
 * 之后报表结构优化，那个来源的 `2. 业务校验通过率` / `1.2 Paynow点击率` 已稳定 100%
 * （恒 100% 的指标由 level.js 的 hasRoom() 挡掉，一条都不会报）。
 */
function pickLevelPool(b, metric, source){
  if(!b || !(b.v>=2) || !source) return null;   // 老形状里根本没有水平池
  const k = source+'|'+metric;
  return (b.level && b.level[k]) ? {stat:b.level[k], basis:'本来源'} : null;
}

/** 该指标当前生效的阈值：基准线优先，样本不足时回退到按层级的固定阈值。 */
/**
 * @param bl {baseline, active} —— 由调用方传入，**不再从 store 读**（T3）。
 *           不传 = 只走层级兜底阈值。这样 analyze() 才是纯函数，
 *           单测里给一份基准线字面量就能验阈值分支。
 * @param source 来源名。不给就跳过第 1 级 —— 调用方拿不到来源时的降级，不是错误。
 */
function thresholdFor(metric, bl, source){
  const isF=FRICTION_METRICS.includes(metric);
  const p=(bl && bl.active) ? pickPool(bl.baseline, metric, source) : null;
  if(p) return {drop:p.stat.drop, rise:p.stat.rise, basis:p.basis, isF};
  const d=METRIC_DEPTH[metric]!=null ? METRIC_DEPTH[metric] : 0;
  return {drop:LEVEL_THRESHOLDS[d], rise:LEVEL_THRESHOLDS.friction_rise, basis:'层级兜底', isF};
}
function isTriggered(metric, dod, bl, source){
  const t=thresholdFor(metric, bl, source);
  return {hit: t.isF ? dod>=t.rise : dod<=t.drop, basis:t.basis, isF:t.isF};
}

/**
 * 三态标注。因果是自下而上的（子环节恶化 → 大环节恶化），所以：
 *   根因   = 异常子环节，且其所属大环节也异常  → 它解释了大环节
 *   已解释 = 异常大环节，且其下有异常子环节    → 计数归给子环节，避免一因多计
 *   未解释 = 异常大环节，但子环节全正常        → ⚠️ 存在子指标未覆盖的因素，重点提示
 *   无子指标 = 异常大环节，而它**压根没有子指标**  → 不是发现，别当「未解释」报
 *   局部   = 异常子环节，但大环节正常          → 局部问题或子项互相抵消，降级保留不漏
 */
function annotateHierarchy(alarms, stageInfo){
  const bySrc={};
  alarms.forEach(a=>{ (bySrc[a['来源']]=bySrc[a['来源']]||[]).push(a); });

  for(const src of Object.keys(bySrc)){
    const list=bySrc[src];
    const abnormal=new Set(list.map(a=>a['异常指标']));
    // 大环节是否异常：有独立指标的看告警；环节1 无独立指标，用其累乘比率的环比判断
    const stageAbn={};
    for(const s of FUNNEL_MAIN){
      if(s.metric){ stageAbn[s.code]=abnormal.has(s.metric); continue; }
      const st=(stageInfo[src]&&stageInfo[src].stages||[]).find(x=>x.code===s.code);
      stageAbn[s.code] = !!(st && st.dodRel!=null && st.dodRel<=LEVEL_THRESHOLDS[0]);
    }
    for(const a of list){
      const m=a['异常指标'];
      const stage=METRIC_STAGE[m], depth=METRIC_DEPTH[m];
      a._stage=stage!=null?stage:'-';
      a._depth=depth!=null?depth:0;
      if(stage==null){ a._role='其他'; continue; }
      // 有异常的直接下级 → 该项已被下级解释，计数归给下级（任意层级通用）
      const kids=(depth===0 ? (FUNNEL_SUBS[stage]||[]).filter(x=>x[1]===0).map(x=>x[0])
                            : (METRIC_CHILDREN[m]||[]));
      if(kids.some(k=>abnormal.has(k))){ a._role='已解释'; continue; }
      /* 无下级解释：大环节 → 存在未被子指标覆盖的因素；子环节 → 看所属大环节是否也异常。
         ⚠️ **但要先分清「子指标都正常」和「压根没有子指标」。**
         `FUNNEL_SUBS['2'] = []` —— 环节2 业务校验通过率在漏斗树里就没有子指标，
         于是它只要告警**必然**判成「未解释」。实测两份报表 14 对期次，
         每一条「未解释」都是它。而播报里那句「子指标查不出原因」会让人去查
         一批根本不存在的子指标 —— 这不是发现，是结构决定的。 */
      a._role = depth!==0 ? (stageAbn[stage] ? '根因' : '局部')
              : (kids.length ? '未解释' : '无子指标');
    }
  }
  return alarms;
}

/** 单个维度内的根因数：某项若已被其下级异常解释，则不重复计入。 */
function rootCauseCount(alarms){
  return alarms.filter(a=>a._role!=='已解释').length;
}
/** 跨维度去重的根因数：合计行与站点是同一批数据的两个视角，同一 来源+指标 只算一个。 */
function distinctRootCauses(...lists){
  const s=new Set();
  for(const list of lists) for(const a of (list||[]))
    if(a._role!=='已解释') s.add(a['来源']+'|'+a['异常指标']);
  return s.size;
}

/* ============================================================
   5. 合并今昨（对应 build_merged / build_wide）
   ============================================================ */
function buildMerged(df, hasSite, tDate, yDate){
  const dates = [...new Set(df.map(o=>o['统计日期']).filter(d=>d))].sort().reverse();
  if(dates.length<2) throw new Error(`${PERIOD}数据不足${P().minGap}。现有：${dates.join(' , ')||'无'}`);
  // 不传就沿用老行为（最新两期）；run() 会把选中的那一对传进来，
  // 保证 dfSite / dfTotal 两次调用算的是同一对日期。
  if(!tDate || !yDate){ tDate=dates[0]; yDate=dates[1]; }
  else if(!dates.includes(tDate) || !dates.includes(yDate))
    throw new Error(`所选日期在${PERIOD}数据中不存在：${tDate} / ${yDate}`);

  const keys=['来源'];
  for(const k of ['用户ID','商户名称']) if(k in (df[0]||{})) keys.push(k);
  if(hasSite) keys.push('站点');

  const keyOf = o => keys.map(k=>o[k]).join('');
  const yMap = new Map();
  df.filter(o=>o['统计日期']===yDate).forEach(o=> yMap.set(keyOf(o),o));

  /* 内连接：两期都有的才进 merged —— 环比本来就要两期才算得出来。
     但**只在一期出现的那两批不能就地丢掉**（第四轮 A2）：
     「昨天 3000 单今天 0 单」比「某指标掉 2pt」严重得多，
     而它以前连一行日志都没有，页面上、播报里、明细里全都看不到。
     这里把它们原样带出去，由 buildChurn() 整理成人看得懂的两张名单。 */
  const merged=[], onlyT=[], matchedY=new Set();
  df.filter(o=>o['统计日期']===tDate).forEach(t=>{
    const k = keyOf(t);
    const y = yMap.get(k);
    if(!y){ onlyT.push(t); return; }
    matchedY.add(k);
    const m={}; keys.forEach(k2=>m[k2]=t[k2]);
    for(const c of Object.keys(t)){
      if(keys.includes(c)) continue;
      m[c+'_今']=t[c];
    }
    for(const c of Object.keys(y)){
      if(keys.includes(c)) continue;
      m[c+'_昨']=y[c];
    }
    merged.push(m);
  });
  const onlyY=[];
  yMap.forEach((y,k)=>{ if(!matchedY.has(k)) onlyY.push(y); });
  return {merged, onlyT, onlyY, tDate, yDate, keys};
}

/**
 * 只在一期出现的商户，整理成两张名单（第四轮 A2）。
 *
 *   lost   = 上期有量、本期整个没了 —— **最该报的一类**：商户掉线或切走了
 *   gained = 本期首次有量 —— 新商户上量，成功率好不好要盯
 *
 * 两边都按 PO 倒序：掉一家 3000 单的和掉一家 3 单的不是一回事，
 * 而 buildMerged 的内连接对这两种情况一视同仁 —— 都是直接不存在。
 */
function buildChurn(onlyT, onlyY, hasSite){
  const tidy = rows => rows.map(r=>({
    来源: r['来源'],
    用户ID: String(r['用户ID']||''),
    商户名称: String(r['商户名称']||''),
    站点: hasSite ? String(r['站点']||'') : '(用户ID合计)',
    PO单数: Math.round(num(r['PO单数'])),
    /* 带上成功率：新入网的那批要进「待观察商户」名单（B14），
       「新商户上来就只有 12%」是这份名单里最该早发现的一种。
       算不出就留 null，渲染那边据此显示「—」，不要写成 0.00%。 */
    成功率: (OVERALL_METRIC in r) && r[OVERALL_METRIC]!=null && r[OVERALL_METRIC]!==''
            ? num(r[OVERALL_METRIC]) : null,
  })).sort((a,b)=> b['PO单数']-a['PO单数']);
  const gained=tidy(onlyT), lost=tidy(onlyY);
  const sum = a => a.reduce((s,x)=>s+x['PO单数'], 0);
  return {gained, lost, gainedPO:sum(gained), lostPO:sum(lost)};
}

/**
 * 本期窗口的结束日。认三种写法，认不出来给 null：
 *   2026-09-06                        日报 —— 就是它自己
 *   2026 W37 (2026-09-04~2026-09-10)  周报 —— 括号里的第二个日期
 *   2026-09                           月报 —— 该月最后一天
 */
function periodEnd(tDate){
  const s=String(tDate||'');
  const range=s.match(/(\d{4}-\d{2}-\d{2})\s*[~～]\s*(\d{4}-\d{2}-\d{2})/);
  if(range) return range[2];
  if(/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const mon=s.match(/^(\d{4})-(\d{2})$/);
  if(mon){
    // Date.UTC 的 month 是 0-based，传 +mon[2] 就是"下个月"，day=0 = 上个月最后一天
    const last=new Date(Date.UTC(+mon[1], +mon[2], 0)).getUTCDate();
    return `${mon[1]}-${mon[2]}-${String(last).padStart(2,'0')}`;
  }
  return null;
}

/**
 * 本期还没走完？
 *
 * 掉量名单对「没走完的周期」天生不公平：9 月只过了 6 天，8 月有量、9 月还没下单的
 * 商户会全被算成掉量 —— 拿真实报表实测，月报能报出 81 家 / 8.5 万单，几乎全是这个。
 * 比率不受影响（它是个比值），所以以前没人被这件事咬到，是 A2 把它暴露出来的。
 *
 * 判据：本期窗口的结束日 > 报表里最新的那个**日报**日期。认不出窗口就返回 false ——
 * 宁可不提示，也不要瞎提示。
 */
function periodIncomplete(tDate, latestDaily){
  const end=periodEnd(tDate);
  return !!(end && latestDaily && end > latestDaily);
}

/**
 * 整个来源在两期之间的出现/消失（第四轮 A3）。
 *
 * stageAnalysis() 遍历的是本期有哪些来源（`Object.keys(mapT)`），
 * 所以某个来源今天整个没数据时，页面上就是**少一张卡**——不报错、不提示。
 * 少一张卡没人会注意到，而"整个来源没了"是比任何单指标波动都大的事。
 */
function sourceChurn(dfScene, tDate, yDate){
  const mapT=sceneMap(dfScene,tDate), mapY=sceneMap(dfScene,yDate);
  return {
    gone:     Object.keys(mapY).filter(s=>!mapT[s]),
    appeared: Object.keys(mapT).filter(s=>!mapY[s]),
  };
}

function buildWide(merged, hasSite){
  return merged.map(r=>{
    const base={来源:r['来源'],用户ID:r['用户ID']||'',商户名称:r['商户名称']||'',本期PO:Math.round(num(r['PO单数_今']))};
    if(hasSite) base['站点']=r['站点']||'';
    for(const m of ALL_METRICS){
      if(!(m+'_今' in r)) continue;
      const [dT,nT]=calcFunnel(r,m,'_今');
      base[`[${m}] 进入`]=dT;
      base[`[${m}] 通过`]=nT;
      base[`[${m}] 本期比率`]=(num(r[m+'_今'])*100).toFixed(2)+'%';
      base[`[${m}] 上期比率`]=(num(r[m+'_昨'])*100).toFixed(2)+'%';
    }
    return base;
  });
}


export { annotateHierarchy, buildChurn, pickLevelPool, pickPool, buildMerged, buildWide, calcFunnel, chainDenom, distinctRootCauses, dodOf, downstreamPass, funnelStages, hasDenomChain, isTriggered, mainRate, orderImpact, parseDodCell, periodEnd, periodIncomplete, rootCauseCount, sceneCounts, sceneMap, sourceChurn, stageAnalysis, thresholdFor, toRate };
