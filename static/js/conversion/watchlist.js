import { OVERALL_METRIC, SMALL_MERCHANT_PO, WATCH_GAP, WATCH_LOW_RUN, WATCH_MIN_PEERS, WATCH_MIN_PO } from './config.js';
import { cmpPeriod } from './trend.js';
import { num } from './util.js';

/* ============================================================
   待观察商户名单（B14）

   **这不是告警。** 告警回答「今天出了什么事」—— 某个指标动了、动了多少、谁干的。
   这份名单回答「这几家要盯着」—— 它们可能一个月都没动静，但一直不对劲。
   两件事的处理动作和责任人都不一样：前者是排障（查网关、查风控），后者是 BD 去推。
   混在一起两边都变钝：告警被这些常年不动的条目淹，名单被当成误报忽略。

   三段，判据各不相同：

     📉 低于同行   本期成功率比同来源中位数低 WATCH_GAP，且单量够得上 WATCH_MIN_PO
     🆕 新入网     本期首次有量（复用 A2 的 churn.gained）
     🔍 量太少     PO < WATCH_MIN_PO —— 只报家数和总量，不逐家列

   为什么第三段不逐家列：1 单 0% 和 1 单 100% 都只是一单的事，比率没有意义。
   逐家列出来只会把上面两段淹掉，而真要查的话异常明细里都在。

   ⚠ **门槛是 10 单不是 50 单**（`SMALL_MERCHANT_PO`）。量少 + 成功率低正是最该盯的
     那种组合 —— 等着被风控关的就是这批 —— 用 50 的门槛会把他们整批滤掉。
     50 那个常量管的是另一件事：「这个比率变动可不可信」（B12），和这里不是一回事。
   ============================================================ */

/** 不加权中位数。偶数个取中间两个的平均。 */
function median(a){
  const s=[...a].filter(x=>Number.isFinite(x)).sort((x,y)=>x-y);
  const n=s.length;
  if(!n) return null;
  return n%2 ? s[(n-1)/2] : (s[n/2-1]+s[n/2])/2;
}

/**
 * 每个来源的「同行水平」= 该来源里够量商户的成功率**不加权**中位数。
 *
 * ⚠ 不加权是刻意的。PO 加权中位数在「一家独大」的来源上会退化成那一家自己的值 ——
 *   Element 只有 4 家、最大一家占 99% 的量，加权基准就是它，于是**谁都不会低于基准**。
 *   不加权问的是「一家典型的商户能做到多少」，正是这里要比的东西。
 *
 * 够量商户不足 WATCH_MIN_PEERS 家时退回「该来源全部商户」的中位数 ——
 * **不跳过这个来源**。基准粗一点也比整条线没人看着强。
 */
function peerBaselines(rows){
  const out={};
  for(const src of new Set(rows.map(r=>r.src))){
    const mine=rows.filter(r=>r.src===src);
    const big=mine.filter(r=>r.po>=WATCH_MIN_PO);
    const use = big.length>=WATCH_MIN_PEERS ? big : mine;
    const m = median(use.map(r=>r.rate));
    if(m!=null) out[src]={rate:m, peers:use.length, weak: use!==big};
  }
  return out;
}

/** 未合并的原始行（dfSite）→ peerBaselines 要的形状。数「连续几期」要逐期算基准。 */
function pickRaw(r, hasSite){
  return {
    src: String(r['来源']||''),
    key: String(r['用户ID']||'') + '\u0000' + (hasSite ? String(r['站点']||'') : ''),
    po:  num(r['PO单数']),
    rate: num(r[OVERALL_METRIC]),
  };
}

/**
 * 「连续几个有效期低于同行」（B14 + 用户 2026-09-08 的要求）。
 *
 * 原来只看两期（本期 + 上期），因为 merged 里就只有这两期。但「常年不动的那批」
 * 恰恰要靠期数才认得出来 —— 两期低可能只是巧合，连着三期就是长期低位。
 *
 * ⚠️ 基准要**逐期各算一次**，不能拿本期的基准去卡历史 ——
 * 同行水平自己也在动，拿今天的尺子量上个月是另一种口径混用。
 *
 * ⚠️ 单量不足的那一期**跳过**（不计数也不打断），见 config.js 的 WATCH_LOW_RUN。
 * 没数据的那一期同样跳过：那一期它可能压根没下单，不该算成「不低了」。
 * 够量但高于基准 → 断开。
 */
function lowStreaks(dfSite, hasSite, dates){
  const per={};
  for(const d of dates){
    const rows=(dfSite||[]).filter(r=>String(r['统计日期'])===d).map(r=>pickRaw(r, hasSite));
    const bl=peerBaselines(rows);
    const by={};
    for(const r of rows) by[r.src+'\u0000'+r.key]=r;
    per[d]={bl, by};
  }
  return per;
}
/** 从 `tIdx` 那一期往前数。dates 必须是升序。 */
function runOf(per, dates, tIdx, src, key){
  let n=0;
  for(let i=tIdx;i>=0;i--){
    const p=per[dates[i]]; if(!p) continue;
    const e=p.by[src+'\u0000'+key];
    if(!e || !Number.isFinite(e.rate) || e.po<WATCH_MIN_PO) continue;   // 说明不了 → 跳过
    const b=p.bl[src];
    if(!b) continue;
    if((b.rate-e.rate) < WATCH_GAP) break;                              // 这期不低 → 断开
    n++;
  }
  return n;
}

/** merged 的一行 → 这里要的那几个字段。站点级和合计级都走这条。 */
function pick(r, hasSite){
  return {
    src: r['来源'],
    uid: String(r['用户ID']||''),
    name: String(r['商户名称']||''),
    site: hasSite ? String(r['站点']||'') : '(用户ID合计)',
    // 和 pickRaw 同一把钥匙 —— 两边对不上就数不出连续期数（而且是静默数成 0）
    key: String(r['用户ID']||'') + '\u0000' + (hasSite ? String(r['站点']||'') : ''),
    po:   num(r['PO单数_今']),
    rate: num(r[OVERALL_METRIC+'_今']),
    // 上期成功率。算不出（首次有量）时为 null —— 那种情况归「新入网」，不进这一段
    rateY: (OVERALL_METRIC+'_昨') in r ? num(r[OVERALL_METRIC+'_昨']) : null,
  };
}

/* 出单监控那四类里，转化率这边真正用得上的三类（B15）。
   出单监控每天已经点过名了 —— 谁刚跨过 $100、谁刚审核通过、谁在滞留 ——
   这批正是这份名单要盯的人，两个工具没必要各判一遍。
   key 是出单监控的 notify 桶名（带 emoji，`classify.py` 的 DAILY_ORDER），
   value 是名单上要显示的短标签。 */
const OM_TAGS = {
  '✅ 新出单': '刚出单',
  '🆕 新审核通过-待出单': '刚审核通过',
  '🐢 小额滞留': '出单滞留',
  '👀 3天内未出单': '还没出单',
};

/**
 * 出单监控名单 → `用户ID` → 标签。
 *
 * ⚠ **只按用户ID匹配，不按站点。** 站点归一化在 Python（`normalize_site`）和
 *   JS（`shortSite`）各有一份实现，一旦漂移就是静默匹配不上 ——
 *   这个仓库已经被「两份实现悄悄不一样」咬过两次（`esc` 三份、漏斗页影子解析）。
 *   用户ID 是 19 位整数，两边格式一致，没有归一化这回事。
 *   代价是一个商户有多个站点时会全部命中；对「这家刚出单，盯一下成功率」
 *   这个用途来说没问题。
 */
function orderMonitorTags(om){
  const m=new Map();
  for(const x of ((om && om.merchants) || [])){
    const tag=OM_TAGS[x['分类']];
    if(!tag) continue;                       // 其余几类（未出单 30-60 天等）这边用不上
    const uid=String(x['用户ID']||'');
    if(!uid) continue;
    if(!m.has(uid)) m.set(uid, new Set());
    m.get(uid).add(tag);
  }
  return m;
}

/**
 * @param mergedSite analyze() 里那份两期都在的商户
 * @param churn      A2 的产物，要它的 gained（本期首次有量 = 新入网）
 * @param om         出单监控最近一次的结果（`/api/order-monitor/latest`），可以没有
 * @param hist       {dfSite, tDate} —— 数「连续几期低于同行」要全部期次的商户行。
 *                   不传就退回只看两期（连续期数最多给到 2），功能不炸。
 * @returns {baselines, low, fresh, tiny, best, omDate, omPending}
 */
function buildWatchlist(mergedSite, churn, hasSite, om, hist){
  const rows=(mergedSite||[]).map(r=>pick(r, hasSite))
                             .filter(r=>Number.isFinite(r.rate) && r.po>0);
  const baselines=peerBaselines(rows);

  /* 历史期次（升序，自然序 —— 周报 `2026 W9` 不能排到 `W37` 后面）。 */
  const dfSite=(hist&&hist.dfSite)||null;
  const dates = dfSite
    ? [...new Set(dfSite.map(o=>String(o['统计日期']||'')).filter(Boolean))].sort(cmpPeriod)
    : [];
  const tIdx = dates.indexOf(String((hist&&hist.tDate)||''));
  const per = (dfSite && tIdx>=0) ? lowStreaks(dfSite, hasSite, dates.slice(0, tIdx+1)) : null;

  const low=[];
  for(const r of rows){
    const b=baselines[r.src];
    if(!b || r.po<WATCH_MIN_PO) continue;
    const gap=b.rate-r.rate;
    if(gap < WATCH_GAP) continue;
    low.push({
      ...r, 基准:b.rate, 缺口:gap,
      /* 连续几个有效期低于（各期自己的）基准。这两种不是一回事：
         连续多期 = 长期低位，该找人；只有本期 = 这期才掉下去的，那是告警该管的事。
         拿不到历史时退回两期口径（本期 + 上期），最多数到 2。 */
      连续期数: per
        ? runOf(per, dates, tIdx, r.src, r.key)
        : (r.rateY!=null && Number.isFinite(r.rateY) && (b.rate-r.rateY)>=WATCH_GAP ? 2 : 1),
      单量少: r.po < SMALL_MERCHANT_PO,
      // 做到同行中位数能多成多少单。风险口径排序，但钱要看得见
      可多成: Math.round(r.po*gap),
    });
  }
  /* 排序：**连续期数降序，同期数内按缺口降序**。
     用户的原话是「连续 3 个工作日看到它，就应该被归到待观察商户了」——
     按期数排自然就把长期低位的顶到最前，不用再单排一档
     （第一版写成 `长期低位 → 连续期数 → 缺口` 三级，第一级是多余的：
      连续期数降序本来就会让 ≥3 的全排在 <3 前面）。 */
  for(const x of low) x.长期低位 = x.连续期数 >= WATCH_LOW_RUN;
  low.sort((a,b)=> (b.连续期数-a.连续期数) || (b.缺口-a.缺口));

  /* 新入网：本期首次有量。A2 已经把这批捞出来了，这里只是补上成功率 ——
     新商户上来就不行，是这份名单里最该早发现的一种。 */
  const fresh=[...((churn&&churn.gained)||[])]
    .map(g=>({...g, 单量少: g['PO单数'] < SMALL_MERCHANT_PO}))
    .sort((a,b)=>b['PO单数']-a['PO单数']);
  /* 逐家点名的只到 WATCH_MIN_PO 为止 —— 和上面「低于同行」同一条线：
     不足这个单量，那个成功率说明不了任何事（1 单 0% 和 1 单 100% 都是一单）。
     剩下的**不丢**，用一行报家数：「新上线了」这件事本身有信息，
     但 15 个名字里 11 个是一两单的，逐个列出来只会把前面几家淹掉。 */
  const freshNamed=fresh.filter(f=>f['PO单数']>=WATCH_MIN_PO);
  const rest=fresh.filter(f=>f['PO单数']<WATCH_MIN_PO);
  const freshTiny={count:rest.length, po:rest.reduce((s,f)=>s+f['PO单数'],0)};

  const tinyRows=rows.filter(r=>r.po<WATCH_MIN_PO);
  const tiny={count:tinyRows.length, po:tinyRows.reduce((s,r)=>s+r.po,0)};

  /* 出单监控的标签打到已有的两段上（B15）。打完再算 best —— 标签不影响排序。 */
  const omTags=orderMonitorTags(om);
  const stamp=x=>{ const s=omTags.get(String(x.uid ?? x['用户ID'] ?? '')); if(s) x.出单监控=[...s]; return x; };
  low.forEach(stamp); fresh.forEach(stamp);

  /* 「刚审核通过-待出单」这批**转化率报表里往往一行都没有**（还没交易），
     所以它们既不在 low 也不在 fresh 里 —— 单独拎出来，不然这条信息就丢了。
     这正是 B15 最值钱的部分：知道「在等谁上量」。 */
  const seen=new Set([...low.map(x=>String(x.uid)), ...fresh.map(f=>String(f['用户ID']))]);
  const omPending=((om && om.merchants) || [])
    .filter(x=>x['分类']==='🆕 新审核通过-待出单' && !seen.has(String(x['用户ID'])))
    .map(x=>({来源:'', 用户ID:String(x['用户ID']||''), 商户名称:x['商户名称']||'',
              站点:x['站点']||'', 所属BD:x['所属BD']||'', 通道通过日期:x['通道通过日期']||''}));

  /* 缺口最大的排前面（风险），但缺口小、量大的那家才是钱最多的 ——
     不单独点一句会被忽略。实测周报：ifonetool.com 缺口只有 13pt 排在末尾，
     但 7031 单，做到中位数一周多成 729 单。 */
  const best=low.reduce((a,b)=>(!a||b.可多成>a.可多成)?b:a, null);

  return {baselines, low, fresh, freshNamed, freshTiny, tiny, best,
          omDate: (om && om.date) || '', omPending};
}

export { OM_TAGS, buildWatchlist, lowStreaks, median, orderMonitorTags, peerBaselines, runOf };
