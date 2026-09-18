import { BROADCAST_PRIO_TOP, CREEP_MIN_RUN, MERCHANT_SCAN_MIN_ORDERS, PERIODS,
         SMALL_MERCHANT_PO, WATCH_GAP, WATCH_LOW_RUN, WATCH_MIN_PO } from './config.js';
import { topLosers } from './merchant_scan.js';
import { pct, ptFmt } from './util.js';

/* ============================================================
   AI 提示词（周月报口径分开）

   原来一套提示词打三个周期，指令是「本期检出 N 项异常，请列出关键变化」——
   那是**日报的问题**。周报月报拿同一套问，问出来的还是「这周哪天出了什么事」，
   而周月报该回答的是「这段时间往哪走、结构变了没、谁在持续掉」。

   ⚠️ **不只是换套话术，喂的素材本身就该不一样。**（计划里第六轮记的就是这句。）
   日报喂播报素材（本期异常摘要）够了；周月报要喂**多期序列**（B5）和
   **水平信号**（B3）—— 那两样正是「趋势和结构」的原料，以前根本没有。

   ⚠️ **2026-09-09 又补了一轮：日报以前只有一块（播报素材）。**
   而播报是给飞书群消息写的 —— 每环节只点前 3 家、不足 50 单不点名、还有字数预算。
   页面上算好的这两块以前一个字都没喂给模型，而它们恰恰是播报答不了的：
     · 重点关注商户（B6）—— 扫全部商户排的，专捞「被大盘稀释到没触发阈值」那批。
       实测周报少成 ≥5 单的 21 家里 7 家在异常明细里一行都查不到。
     · 支付前 / 支付中 两段拆账（B7）—— 「人没走到支付」和「走到了没成」
       该找的人完全不同，而只看一个总成功率两种情况长得一模一样。
   播报那块现在自带一句 `BC_NOTE`，把它的三处刻意省略写明白。

   纯函数：吃 analyze() 的结果 + 播报素材，吐字符串。不碰 DOM、不碰 store，
   所以 tests/ai_prompt.mjs 可以直接喂字面量验「周月报有没有拿到趋势数据」。
   ============================================================ */

/** 多期序列 → 文本。只给整体成功率和四个大环节，逐来源一行。 */
function trendText(trend){
  const t=trend;
  if(!t || !t.dates || t.dates.length<2 || !t.sources.length) return '';
  const L=[`期次（从早到晚）：${t.dates.join(' → ')}`];
  if(t.partial && t.partial.some(Boolean)){
    const p=t.dates.filter((_,i)=>t.partial[i]);
    L.push(`⚠️ ${p.join('、')} 这几期**还没走完**，单量天生偏低，别当成下滑。`);
  }
  for(const m of t.measures){
    const rows=[];
    for(const s of t.sources){
      const arr=(t.series[m.key]||{})[s]||[];
      if(!arr.some(v=>v!=null)) continue;
      rows.push(`  ${s}：${arr.map(v=>v==null?'—':pct(v)).join(' ')}`);
    }
    if(rows.length) L.push(`【${m.label}】`, ...rows);
  }
  const po=Object.entries(t.po||{})
    .filter(([,a])=>a.some(v=>v!=null))
    .map(([s,a])=>`  ${s}：${a.map(v=>v==null?'—':Math.round(v).toLocaleString()).join(' ')}`);
  if(po.length) L.push('【PO 单量】', ...po);
  return L.join('\n');
}

/* 「连续 N ___」的量词。日报「天」/ 周报「周」/ 月报「个月」——
   只有日报能叫「天」，一律写「天」在周月报里就是错的。默认给日报的。 */
const RUN_DEFAULT = PERIODS['日报'].run;

/** 水平信号 → 文本。这块是环比一辈子报不出来的那类，周月报尤其该看。 */
function levelText(levels, runWord = RUN_DEFAULT){
  const r=levels;
  if(!r || r.noBaseline) return '';
  const L=[];
  if(r.level && r.level.length){
    L.push(`跌破历史下沿（本期值落在该来源该指标历史分布的 P10 之外，摩擦类是涨破 P90）：`);
    for(const x of r.level) L.push(`  ${x['来源']} ${x['指标']}：本期 ${pct(x['本期值'])}，`
      + `${x._isF?'高于':'低于'}历史 ${x._isF?'P90':'P10'} ${pct(x['分位线'])}，中位 ${pct(x['中位'])}`
      + (x['影响单量']!=null?`，回到中位约多成 ${Math.round(x['影响单量']).toLocaleString()} 单`:''));
  }
  if(r.creep && r.creep.length){
    L.push(`温水煮青蛙（连续 ≥${CREEP_MIN_RUN} ${runWord}不高于历史 P25，每${runWord}跌幅都够不上告警阈值）：`);
    for(const x of r.creep) L.push(`  ${x['来源']} ${x['指标']}：连续 ${x['连续期数']} ${runWord}，`
      + `本期 ${pct(x['本期值'])}，中位 ${pct(x['中位'])}`
      + (x['影响单量']!=null?`，回到中位约多成 ${Math.round(x['影响单量']).toLocaleString()} 单`:''));
  }
  return L.join('\n');
}

/** 名单类的块在提示词里列几家。比播报多（播报要顾及群消息长度，这里不用）。 */
const PROMPT_LIST_TOP = 15;

/** 待观察商户 → 文本。周月报要回答「谁在持续掉」，这份名单就是答案的一半。 */
function watchText(watch, runWord = RUN_DEFAULT){
  const w=watch;
  if(!w) return '';
  const L=[];
  const low=(w.low||[]);
  if(low.length){
    const longRun=low.filter(x=>x.长期低位);
    L.push(`低于同来源中位数 ${WATCH_GAP*100}pt 以上（本期 ≥${WATCH_MIN_PO} 单）：${low.length} 家，`
         + `其中连续 ≥${WATCH_LOW_RUN} ${runWord}的 ${longRun.length} 家`);
    if(low.length>PROMPT_LIST_TOP) L.push(`  （下面只列前 ${PROMPT_LIST_TOP} 家，按长期低位优先排序）`);
    for(const x of low.slice(0,PROMPT_LIST_TOP))
      L.push(`  ${x.site||x.name} ${x.src}：${x.po.toLocaleString()} 单 ${pct(x.rate)}，`
           + `低 ${(x.缺口*100).toFixed(0)}pt，连续 ${x.连续期数} ${runWord}`);
  }
  if(w.fresh && w.fresh.length) L.push(`本期首次有量：${w.fresh.length} 家`);
  return L.join('\n');
}

/**
 * 重点关注商户（B6）→ 文本。
 *
 * ⚠️ **这块以前一个字都没喂给 AI，而它恰恰是播报补不上的那部分。**
 * 播报按「场景先触发阈值，才拆商户」组织，每个环节只点前 ${BROADCAST_PRIO_TOP} 家；
 * B6 是把每个商户当成一个小漏斗**各算一遍**，专门捞「被大盘稀释到没触发阈值」那批 ——
 * 实测周报少成 ≥5 单的 21 家里，7 家在异常明细里一行都查不到（合计 139 单）。
 * 不喂这块，模型看到的就是一份「只有触发了阈值的大商户」的名单。
 */
function merchantScanText(scan){
  if(!scan || !scan.rows || !scan.rows.length) return '';
  const top=topLosers(scan, PROMPT_LIST_TOP);
  if(!top.length) return '';
  const L=[`按「整体少成多少单」扫全部商户排出来的（不是对告警明细做聚合，`
         + `所以包含没触发阈值、在异常明细里查不到的那批）。门槛：少成 ≥${MERCHANT_SCAN_MIN_ORDERS} 单。`];
  const all=scan.rows.filter(x=>x['影响单量'] <= -MERCHANT_SCAN_MIN_ORDERS);
  if(all.length>top.length) L.push(`共 ${all.length} 家，下面列少成最多的 ${top.length} 家。`);
  for(const x of top){
    const st=x['主因'];
    L.push(`  ${x['商户名称']||x['站点']} ${x['来源']}：PO ${Math.round(x['PO单数']).toLocaleString()} 单，`
      + `${pct(x['上期'])} → ${pct(x['本期'])}（${ptFmt(x['变动'])}，少成 ${Math.abs(x['影响单量']).toLocaleString()} 单）`
      + (st?`，主因环节${st.code} ${st.label}`:'')
      + (x['口径存疑']?`　⚠️ 累乘值和源表对不上，主因不可全信`:''));
  }
  if(scan.noBase) L.push(`  （另有 ${scan.noBase} 家算不出整体变动，未纳入）`);
  return L.join('\n');
}

/**
 * 支付前 / 支付中 两段拆账（B7）→ 文本。
 *
 * 两条成功率的分子相同、差别只在分母，所以总流失能精确劈成两段。
 * 这两段的排查方向完全不同（收银台/前端 vs 风控/网关），而只看一个总成功率
 * 两种情况长得一模一样 —— 模型尤其容易把「人没走到支付」说成「支付失败」。
 */
function poRateText(po){
  if(!po || !po.ok || !po.rows.length) return '';
  const L=['业务单支付成功率 = 环节1 × 支付单支付成功率，两条的分子相同（都是成功单），',
           '差别只在分母。所以总流失能精确劈成两段，没有残差：',
           '  支付前流失 = PO单数 − 支付单数（人根本没走到支付：校验1 / Paynow点击）',
           '  支付中流失 = 支付单数 − 成功单（走到了没成：业务校验 / 风控 / 3DS / 网关）',
           '**这两段该找的人完全不同**：支付前查收银台和前端，支付中查风控网关。'];
  const t=po.total;
  if(t) L.push(`合计：PO ${t['PO单数'].toLocaleString()} 单，流失 ${t['总流失'].toLocaleString()} 单 —— `
             + `支付前 ${t['支付前流失'].toLocaleString()} 单（${pct(t['支付前占比'])}），`
             + `支付中 ${t['支付中流失'].toLocaleString()} 单`);
  for(const r of po.rows)
    L.push(`  ${r['来源']}：PO ${r['PO单数'].toLocaleString()}，`
         + `业务单 ${pct(r['业务单率'])} / 支付单 ${r['支付单率']==null?'—':pct(r['支付单率'])}；`
         + `支付前流失 ${r['支付前流失'].toLocaleString()} 单，支付中流失 ${r['支付中流失'].toLocaleString()} 单`
         + (r['mismatch']?`　⚠️ 源表两行分子对不上，劈法不可全信`:''));
  if(po.noData.length) L.push(`  ⚠️ ${po.noData.join('、')} 本期缺「支付单支付成功率」行，未纳入（**没有按 0 计**）。`);
  if(po.partial) L.push(`  ⚠️ 本期还没走完，单量环比不可比，上面只给本期值。`);
  return L.join('\n');
}

/** 商户进出 → 文本。 */
function churnText(churn){
  const c=churn; if(!c) return '';
  const L=[];
  if(c.lost && c.lost.length)
    L.push(`上期有量、本期整个没了：${c.lost.length} 家，上期共 ${(c.lostPO||0).toLocaleString()} 单`
         + (c.partial?`（⚠️ 本期还没走完，多半只是还没下单，别当结论）`:''));
  if(c.gone && c.gone.length) L.push(`整个来源本期没数据：${c.gone.join('、')}`);
  return L.join('\n');
}

const DAILY_ASK = [
  '这是**巡检**：回答「本期出了什么事、该先查哪个」。',
  '',
  '请只依据下面给出的数据作答，不要编造未提供的数字。输出：',
  '1. 一句话结论（本期整体是好是坏，最该关注什么）',
  '2. 按影响从大到小列出关键变化，指明是哪个来源、哪个环节',
  '3. 可能的原因方向和建议排查动作（明确区分「数据支持的推断」和「需要进一步验证的猜测」）',
  '4. 如果本期平稳，直接说平稳，不要硬凑问题',
];

/**
 * 周月报的问法。和日报的差别不是话术，是**问题本身**：
 * 日报问「今天出了什么事」，周月报问「这段时间往哪走、结构变了没、谁在持续掉」。
 */
const PERIODIC_ASK = [
  '这是**周期复盘**，不是巡检 —— 不要逐条罗列本期的告警，那是日报干的事。',
  '',
  '请只依据下面给出的数据作答，不要编造未提供的数字。输出：',
  '1. **走势**：各来源的整体成功率在这几期里是升是降、幅度多少、有没有拐点。',
  '   拿多期序列说话，不要只比首末两期 —— 中间的形状（一路滑 / 掉一次就回来 /',
  '   来回震荡）指向完全不同的原因。',
  '2. **是哪一环在动**：四个大环节的序列里，哪个环节的变化能解释整体的变化。',
  '   环节之间是乘法关系，某一环掉 1pt 对整体的影响要乘上下游通过率。',
  '3. **慢性问题**：「温水煮青蛙」和「连续 N 期低于同行」那两块讲的是持续恶化，',
  '   每期跌幅都够不上告警阈值，只有拉长看才成立。**这是周月报最该讲的部分**，',
  '   优先级高于任何单期的波动。',
  '4. **结构变化**：商户进出、单量在来源之间的迁移 —— 整体成功率变了但各来源都没变，',
  '   那是结构问题不是能力问题，要分开讲。',
  '5. **下一步**：按「能确认的程度 + 影响单量」排序，标明责任方（技术 / 风控 / BD / 产品）。',
  '',
  '⚠️ 单期的小波动不要当成趋势。一期的异常归日报管，这里只讲**至少两期以上**站得住的东西。',
];

/**
 * @param d   analyze() 的结果
 * @param bcMd 播报素材（markdown）—— 日报的主素材
 * @returns 提示词字符串；没数据时空串
 */
function buildAIPrompt(d, bcMd){
  if(!d) return '';
  const period=d.period || '日报';
  const P_=PERIODS[period] || PERIODS['日报'];
  const daily = period==='日报';
  const n=(d.alarmTotal||[]).length + (d.alarmSite||[]).length;

  const L=[
    `你是一名支付业务数据分析师。下面是「${period}」口径的转化率分析结果，`,
    `本期 ${d.tDate}，对比期 ${d.yDate}，本期检出 ${n} 项${P_.dod}告警。`,
    '',
    ...(daily ? DAILY_ASK : PERIODIC_ASK),
  ];

  const block=(title, body)=>{ if(body) L.push('', `===== ${title} =====`, body); };

  /* ⚠️ 播报素材是**给飞书群消息写的**：每个环节只点名前 BROADCAST_PRIO_TOP 家、
     不足 SMALL_MERCHANT_PO 单的不点名、整条还有字数预算会往下砍。
     以前提示词一个字没说这件事，模型看到「点名的这 3 家」就会当成全部。
     AI 没有群消息的长度限制，所以：一是把这个前提写出来，
     二是另喂「重点关注商户」那块（B6，扫全部商户排的，不受阈值和 Top N 限制）。 */
  const BC_NOTE = `⚠️ 下面这段是给飞书群消息写的，有三处**刻意的省略**：`
    + `每个环节只点名前 ${BROADCAST_PRIO_TOP} 家商户；本期不足 ${SMALL_MERCHANT_PO} 单的商户只计数不点名`
    + `（几单的抖动算不出可信的比率变动）；整条还有字数预算，超了会砍掉靠后的段落并注明。`
    + `**所以点名的商户不是全部** —— 完整的商户名单看「重点关注商户」那一块。\n`;

  if(daily){
    block('播报素材（本期异常摘要）', bcMd ? BC_NOTE + bcMd : '（无）');
    /* 这两块以前日报周报都没喂，而它们回答的正是播报答不了的两个问题：
       「哪些商户没触发阈值但其实在掉」（B6）、「这一期的流失卡在支付前还是支付中」（B7）。 */
    block('重点关注商户（扫全部商户排出来的，不受告警阈值限制）', merchantScanText(d.merchantScan));
    block('支付前 / 支付中 两段拆账（这一期的流失该找谁）', poRateText(d.poRate));
    block('水平信号（环比报不出来的那类）', levelText(d.levels, P_.run));
  }else{
    /* 周月报把趋势放第一块 —— 它是这份报告的主语。播报素材降到最后当补充：
       那份是按「本期 vs 上期」组织的，周月报要的恰恰不是那个视角。 */
    block(`多期趋势（${period}，从早到晚）`, trendText(d.trend));
    block('水平信号（环比报不出来的那类，周月报重点）', levelText(d.levels, P_.run));
    block('重点关注商户（扫全部商户排出来的，不受告警阈值限制）', merchantScanText(d.merchantScan));
    block('支付前 / 支付中 两段拆账（流失卡在支付前还是支付中）', poRateText(d.poRate));
    block('持续低于同行的商户', watchText(d.watch, P_.run));
    block('商户进出', churnText(d.churn));
    block('本期告警摘要（补充，不是主线）', bcMd ? BC_NOTE + bcMd : '（无）');
  }
  L.push('', '===== 数据结束 =====');
  return L.join('\n');
}

export { PROMPT_LIST_TOP, buildAIPrompt, churnText, levelText, merchantScanText,
         poRateText, trendText, watchText };
