import { uniq } from '../broadcast.js';
import { ALLOWED_SOURCES, CHURN_TOP, FRICTION_METRICS, FUNNEL_MAIN, FUNNEL_SUBS, METRIC_CHILDREN, P, SMALL_MERCHANT_PO } from '../config.js';
import { drillMetric, totalPOBySource } from '../detect.js';
import { toRate } from '../funnel.js';
import { state } from '../store.js';
import { $, esc } from '../../shared/dom.js';
import { shortSite, trim } from '../../shared/text.js';
import { capTag, fmtVal, ordFmt, pct, ptFmt } from '../util.js';
import { renderWatchlist } from './watchlist.js';

/* ---------- 概览：优先排查 callout + 大环节瀑布 ---------- */

/** 某来源内拖累最多的大环节 + 它的归因子指标。无拖累则返回 null。 */
function worstStageOf(src, f, alarms){
  if(!f) return null;
  let st=null;
  for(const s of f.stages){
    if(s.contrib==null) continue;
    if(!st || s.contrib<st.contrib) st=s;
  }
  if(!st || st.contrib>=0) return null;
  // 该环节下有哪些异常子指标（即归因）。合计行与站点会给出同一指标，按指标去重。
  const subs=(FUNNEL_SUBS[st.code]||[]).map(x=>x[0]);
  const seen=new Set(), causes=[];
  for(const a of alarms){
    if(a['来源']!==src || !subs.includes(a['异常指标']) || a._role!=='根因') continue;
    if(seen.has(a['异常指标'])) continue;
    seen.add(a['异常指标']); causes.push(a);
  }
  return {src, st, causes};
}

/**
 * 给每条「优先排查」算出商户级下钻。
 *
 * 优先排查挑的是对该来源整体拖累最大的大环节，判据是 contrib（pt），**不看告警阈值**。
 * 所以它经常点名一个没进 alarms 的指标 —— 那种情况下 detect() 不会产出任何 drill，
 * 于是群里通知了「环节4 网关通过率拉低 0.59pt」，页面上却查不到是哪些商户干的。
 * 这里就是补这一段。
 */

/**
 * 每个来源一个「故事」：整体涨了还是跌了，主要是哪个环节，那个环节又是哪几家商户。
 *
 * 取代原来的 buildPrioDrill()。两点不同：
 *   1. 不再只看拖累。原来走 worstStageOf()，它 `contrib>=0 就 return null`，
 *      于是整体在涨的来源播报里一个字都没有。这里按 contrib 排序取首尾，涨跌都拿。
 *   2. 涨的那侧下钻要反方向（找变好的商户），所以 drillMetric 带 dir。
 */
/** 取某来源某指标在某期的场景级比率。 */
function sceneRate(dfScene, src, metric, date){
  const r=dfScene.find(o=>trim(o['来源'])===src && trim(o['类型'])===metric && String(o['统计日期'])===date);
  return r ? toRate(r['当期值']) : null;
}

/**
 * 从大环节往下找「是哪个子环节造成的」，一路穿到最细一层。
 *
 * 只说「环节3 网关提交率跌了」没法行动 —— 得知道是它下面哪一项在拖。
 * 判据是子指标自己的变动方向，**必须按指标类型判**：摩擦类（如 3.2 3DS交易占比）
 * 上升才是变差，通过率类下降才是变差。同向里取变动最大的那个，再继续往下钻。
 *
 * 返回 [{metric, rateY, rateT, delta}, ...]，从子环节到孙环节；没有可归因的下级则为空。
 */
function descendToCause(dfScene, src, stageCode, tDate, yDate, wantWorse, startMetric){
  const chain=[];
  let kids = startMetric ? (METRIC_CHILDREN[startMetric]||[])
                         : (FUNNEL_SUBS[stageCode]||[]).filter(x=>x[1]===0).map(x=>x[0]);
  let guard=0;
  while(kids.length && guard++ < 5){
    let best=null;
    for(const k of kids){
      const t=sceneRate(dfScene,src,k,tDate), y=sceneRate(dfScene,src,k,yDate);
      if(t==null||y==null) continue;
      const delta=t-y;
      if(delta===0) continue;
      const worse = FRICTION_METRICS.includes(k) ? delta>0 : delta<0;
      if(worse!==wantWorse) continue;                    // 方向不对，不是它造成的
      if(!best || Math.abs(delta)>Math.abs(best.delta)) best={metric:k, rateY:y, rateT:t, delta};
    }
    if(!best) break;
    chain.push(best);
    kids = METRIC_CHILDREN[best.metric]||[];
  }
  return chain;
}

function buildSourceStory(stages, mergedSite, hasSite, dfScene, tDate, yDate){
  const totalPO=totalPOBySource(mergedSite);
  const out=[];
  for(const src of orderedSources(stages)){
    const f=stages[src];
    if(!f || f.dOverall==null) continue;          // 没有可比期，说不了变化
    const ss=f.stages.filter(s=>s.contrib!=null).slice().sort((a,b)=>b.contrib-a.contrib);
    if(!ss.length) continue;

    const side=(st, dir)=>{
      if(!st) return null;
      const stageMetric=`${st.code}. ${st.label}`;
      // 先穿透到具体是哪个子/孙环节，商户就按那一层拆 —— 只说「大环节跌了」没法行动
      const chain=descendToCause(dfScene, src, st.code, tDate, yDate, dir!=='better');
      const leaf=chain.length ? chain[chain.length-1].metric : stageMetric;
      const rows=drillMetric(mergedSite, src, leaf,
                             {isF:FRICTION_METRICS.includes(leaf), totalPO:totalPO[src]||0,
                              hasSite, dir, stages:f});
      return {st, metric:stageMetric, chain, leaf, rows,
              reason: rows.length ? '' : '没有单个商户往这个方向动，变化来自各商户占比此消彼长'};
    };

    const top=ss[0], bottom=ss[ss.length-1];
    out.push({
      src, dOverall:f.dOverall, overallT:f.overallT, overallY:f.overallY,
      up:   top.contrib>0    ? side(top,'better')    : null,
      down: bottom.contrib<0 ? side(bottom,'worse')  : null,
    });
  }
  // 跌得最狠的来源排前面
  return out.sort((a,b)=>a.dOverall-b.dOverall);
}

/** 逐来源各取其最拖累的大环节，按严重度排序（最负在前）。 */
function pickPrioritiesPerSource(stages, alarms){
  return orderedSources(stages)
    .map(src=>worstStageOf(src, stages[src], alarms))
    .filter(Boolean)
    .sort((a,b)=>a.st.contrib-b.st.contrib);
}

/** 全局最该先看的那一个（跨来源）。用于「最需优先」标记。 */
function pickPriority(stages, alarms){
  return pickPrioritiesPerSource(stages, alarms)[0] || null;
}

/* ---------- 掉量 / 新增（第四轮 A2 + A3） ---------- */

/** 一家商户写成一行。商户名和站点一样时只写一次 —— 新表没有「商户名称」列，
    loadMerchant 拿站点域名顶上，两边都要走 shortSite 才判得出"是同一个"，
    否则会写成「sackify.shop https://sackify.shop」。 */
function churnLine(x){
  const site=shortSite(trim(x['站点'])), name=trim(x['商户名称']);
  const who = name && name!==site ? `${esc(name)} <span class="hint">${esc(site)}</span>` : esc(site);
  return `<div style="display:flex;justify-content:space-between;gap:12px;padding:3px 0;
                      font-variant-numeric:tabular-nums">
    <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${who}
      <span class="hint">· ${esc(x['来源'])}</span></span>
    <b style="flex:none">${x['PO单数'].toLocaleString()} 单</b></div>`;
}

/* 前 CHURN_TOP 家直接列出来，其余收进 <details> ——
   月报能有八十多家（本期没走完时尤其多），全铺开会把整个概览顶下去；
   但也不能只说"还有 N 家"就没了，那批同样是没有环比、别处查不到的。 */
function churnList(rows, headHtml){
  const shown=rows.slice(0, CHURN_TOP), rest=rows.slice(CHURN_TOP);
  return `<div style="margin-top:8px">
    <div style="font-weight:700;font-size:13px">${headHtml}</div>
    <div style="margin-top:4px">${shown.map(churnLine).join('')}</div>
    ${rest.length?`<details style="margin-top:4px">
      <summary class="hint" style="cursor:pointer">还有 ${rest.length} 家（各 ≤ ${
        shown[shown.length-1]['PO单数'].toLocaleString()} 单），展开看</summary>
      <div style="margin-top:4px">${rest.map(churnLine).join('')}</div></details>`:''}
  </div>`;
}

/**
 * 掉量 / 新增卡片。
 *
 * 为什么单独一块而不是塞进某个环节里：这两批商户**根本没有环比**——
 * 它们只在一期出现，`buildMerged` 的内连接直接把它们丢了（A2）。
 * 「昨天 3000 单今天 0 单」不是某个指标掉了几个点，是这家不在了，
 * 挂在任何一个环节下面都是错的。
 *
 * 来源整个消失（A3）比商户掉量更严重，所以单独占一条红条排在最上面。
 */
function renderChurn(churn){
  const host=$('#churn');
  if(!host) return;
  if(!churn){ host.innerHTML=''; return; }
  const {gained=[], lost=[], gainedPO=0, lostPO=0, gone=[], appeared=[],
         partial=false, latestDaily=''}=churn;
  const parts=[];
  /* 本期还没走完时，「掉量」多半只是还没下单 —— 必须说出来。
     实测月报（9 月只过了 6 天）能报出 81 家 / 8.5 万单，几乎全是这个。
     不拦着不显示：本期内真的掉没了的商户仍然值得看，只是别把它当结论。 */
  const partialNote = partial
    ? `<div class="hint" style="margin-top:6px">⚠️ 本期还没走完（报表最新到 ${esc(latestDaily)}），这里的「掉量」多半只是<b>还没下单</b>，等本期结束再看才作数。</div>`
    : '';

  if(gone.length){
    parts.push(`<div class="prio"><div style="flex:1">
      <div class="lead">来源缺数据</div>
      <div class="big">${gone.map(esc).join('、')} 本期整个没有数据<span class="tag">上期有</span></div>
      <div class="why">这不是某个指标掉了几个点 —— 整条来源本期一行都没有。
        先确认是上游没出数、还是这条线真的停了；在查清之前，下面各来源的对比都少了这一块。</div>
    </div></div>`);
  }
  if(appeared.length){
    parts.push(`<div class="prio warn"><div style="flex:1">
      <div class="lead">新来源</div>
      <div class="big">${appeared.map(esc).join('、')} 本期首次出现</div>
      <div class="why">上期没有这个来源，所以它没有环比，也不在下面的对比里。刚上线的话属正常。</div>
    </div></div>`);
  }

  if(lost.length || gained.length){
    // 掉量排在前面：它是这块里最该看的一类。新增只是提醒"有新商户要盯"。
    const body=[
      lost.length ? churnList(lost,
        `📉 上期有量、本期整个没了：<b>${lost.length}</b> 家 · 上期共 <b>${lostPO.toLocaleString()}</b> 单`) : '',
      gained.length ? churnList(gained,
        `🆕 本期首次有量：<b>${gained.length}</b> 家 · 本期共 <b>${gainedPO.toLocaleString()}</b> 单`) : '',
    ].join('');
    parts.push(`<div class="prio ${lost.length?'warn':'ok'}"><div style="flex:1">
      <div class="lead">商户进出</div>
      <div class="big">新增 ${gained.length} 家 · 掉量 ${lost.length} 家</div>
      <div class="why">这些商户<b>只在一期出现</b>，算不出环比，所以不会出现在上面的环节分析和下面的异常明细里。
        掉量那批按上期单量倒序 —— 掉一家 3000 单的和掉一家 3 单的不是一回事。</div>
      ${partialNote}
      ${body}
    </div></div>`);
  }

  host.innerHTML=parts.join('');
}

function renderOverview(){
  const d=state.data, P_=P();
  const stages=d.stages;
  const allAlarms=[...d.alarmTotal,...d.alarmSite];

  // ---- 优先排查 callout：每个在拖累的来源各一条 ----
  const prios=pickPrioritiesPerSource(stages,allAlarms);
  const prio=prios[0]||null;
  const host=$('#prio');
  if(prios.length){
    host.innerHTML = prios.map((p,idx)=>{
      const st=p.st;
      const causeTxt = p.causes.length
        ? '归因：'+p.causes.map(c=>`<b>${esc(c['异常指标'])}</b>（${esc(c['环比'])}）`).join('、')
        : '⚠️ <b>该环节的子指标均未触发告警</b>——存在未被子指标覆盖的因素（如校验4 camel 最小金额限制），建议人工排查。';
      // 最严重的那条用红条，其余用黄条，避免两个来源同权重争视线
      const cls = idx===0 ? 'prio' : 'prio warn';
      const rank = prios.length>1 ? `<span class="hint" style="margin-left:6px">${idx===0?'最需优先':'其次'}</span>` : '';
      return `<div class="${cls}"><div style="flex:1">
        <div class="lead">优先排查 · ${esc(p.src)}${rank}</div>
        <div class="big">环节${esc(st.code)} ${esc(st.label)}
          <span class="tag">拉低该来源整体 ${ptFmt(st.contrib)}</span></div>
        <div class="why">本环节通过率 ${pct(st.rateY)} → <b>${pct(st.rateT)}</b>（${ptFmt(st.rateT-st.rateY)}）<br>${causeTxt}</div>
      </div></div>`;
    }).join('');
  }else{
    // 大环节都没拖累，但可能存在「局部异常」（子环节异常被其他子项抵消，未传导到大环节）
    const localMetrics=uniq(allAlarms.filter(a=>a._role==='局部').map(a=>a['异常指标']));
    if(localMetrics.length){
      const list=localMetrics.slice(0,4).map(m=>`<b>${esc(m)}</b>`).join('、');
      host.innerHTML=`<div class="prio warn"><div style="flex:1"><div class="lead">优先排查</div>
        <div class="big">各大环节无拖累，但有 ${localMetrics.length} 项局部异常</div>
        <div class="why">${list} 出现异常，但所属大环节${P_.dod}持平——可能被同环节其他子项抵消。
        整体未受影响，仍建议关注是否为趋势起点。</div></div></div>`;
    }else{
      host.innerHTML=`<div class="prio ok"><div><div class="lead">优先排查</div>
        <div class="big">✅ 各大环节${P_.dod}均无明显拖累</div>
        <div class="why">各来源的四个大环节对整体成功率的贡献均为非负，未发现需要优先处理的环节。</div></div></div>`;
    }
  }

  // ---- 掉量 / 新增：只在一期出现的商户和来源，内连接会把它们丢掉 ----
  renderChurn(d.churn);

  // ---- 待观察商户：成功率低 / 单量少 / 新入网。不是告警，所以单独一块 ----
  renderWatchlist(d.watch);

  // ---- 大环节瀑布：每个来源各一块 ----
  const srcs=orderedSources(stages);
  if(!srcs.length){ $('#sourceBlocks').innerHTML='<div class="card pad"><div class="empty">无大盘数据</div></div>'; return; }
  $('#sourceBlocks').innerHTML = srcs.map(src=>sourceBlock(src, stages[src], prio)).join('');
}

/** 来源展示顺序：按 ALLOWED_SOURCES 固定顺序，其余追加在后。 */
function orderedSources(stages){
  const have=Object.keys(stages);
  return ALLOWED_SOURCES.filter(s=>have.includes(s)).concat(have.filter(s=>!ALLOWED_SOURCES.includes(s)));
}

/** 单个来源的大环节漏斗卡片。每个来源自己的最差环节高亮。 */
function sourceBlock(src, f, prio){
  const P_=P();
  if(!f) return `<div class="card pad"><div class="chart-head"><span class="t">▌${esc(src)}</span></div><div class="empty">该来源无大盘数据</div></div>`;

  // 该来源自己拖累最多的环节（不是全局最差）
  let worst=null;
  for(const st of f.stages){
    if(st.contrib==null||st.contrib>=0) continue;
    if(!worst||st.contrib<worst.contrib) worst=st;
  }
  const worstCode=worst?worst.code:null;
  const isGlobalWorst = prio && prio.src===src;

  let html='';
  for(const st of f.stages){
    const w = st.rateT==null?0:Math.max(0,Math.min(1,st.after));
    const wY = (st.afterY!=null && st.rateY!=null) ? Math.max(0,Math.min(1,st.afterY)) : null;
    const dRate = (st.rateT!=null&&st.rateY!=null)?st.rateT-st.rateY:null;
    const cls = dRate==null?'':(dRate>=0?'up':'dn');
    // 贡献为负才叫「拉低」，非负时用中性措辞
    const ctb = st.contrib!=null
      ? `<span class="ctb">${st.contrib<0?'拉低整体':'对整体'} ${ptFmt(st.contrib)}</span>` : '';
    // 源表带「分子/分母」时显示真实单量，否则退回累计/流失口径
    const cm = f.counts && FUNNEL_MAIN.find(x=>x.code===st.code);
    const cnt = (cm && cm.metric && f.counts[cm.metric]) ? f.counts[cm.metric] : null;
    const sub = cnt
      ? `进入 ${cnt.d.toLocaleString()} · 通过 ${cnt.n.toLocaleString()} · 本环节流失 ${(st.loss*100).toFixed(2)}pt`
      : `累计转化 ${(st.after*100).toFixed(2)}% · 本环节流失 ${(st.loss*100).toFixed(2)}pt`;
    html+=`<div class="wf-row${worstCode===st.code?' worst':''}">
      <div class="wf-lab">
        <div><span class="code">${esc(st.code)}</span><span class="nm">${esc(st.label)}</span></div>
        <div class="sm">${sub}</div>
      </div>
      <div class="wf-track"><i style="width:${(w*100).toFixed(2)}%"></i>${
        wY!=null?`<u style="left:${(wY*100).toFixed(2)}%" title="上期累计 ${(wY*100).toFixed(2)}%"></u>`:''}</div>
      <div class="wf-val"><b>${st.rateT==null?'—':pct(st.rateT)}</b>
        ${dRate!=null?`<span class="${cls}">${ptFmt(dRate)}</span>`:''}
        ${ctb}</div>
    </div>`;
  }

  const ov=f.overallT, ovY=f.overallY;
  const sheetNote = (f.overallSheetT!=null && Math.abs(f.overallSheetT-ov)>0.005)
    ? `（源表口径 ${pct(f.overallSheetT)}，与累乘值差 ${ptFmt(f.overallSheetT-ov)}）` : '';
  const meta = `业务单支付成功率 <b>${pct(ov)}</b>` +
    (ovY!=null?` ${P_.dod} <b style="color:${f.dOverall>=0?'var(--good)':'var(--critical)'}">${ptFmt(f.dOverall)}</b>（上期 ${pct(ovY)}）`:'') +
    esc(sheetNote);

  return `<div class="card pad">
    <div class="chart-head">
      <span class="t">▌${esc(src)}${isGlobalWorst?' <span class="tag" style="background:var(--critical);font-size:10.5px;padding:1px 7px;border-radius:6px;color:#fff;font-weight:700;margin-left:6px">最需优先</span>':''}</span>
      <span class="s">${meta}</span>
    </div>
    ${html}
  </div>`;
}

/* ---------- 下钻表格里共用的三小块（B1 / B2 / B12） ---------- */

/** 单量太少的行打个标：3 单里失败 1 单也是 66pt，那不是信号。排序里它们已经沉底了。 */
const smallTag = r => r._small
  ? ` <span class="tag-warn" title="本期不足 ${SMALL_MERCHANT_PO} 单，比率变动多半是一两单的抖动">样本少</span>` : '';

/** 「对大盘」那一格：折损单量为主、pt 为辅；摩擦类算不出单量，退回老的影响比率。 */
function impText(r){
  if(r['影响单量']==null) return esc(r['影响比率']);
  const pt = r['对大盘影响'] ? ` <span class="hint">${esc(r['对大盘影响'])}</span>` : '';
  return esc(ordFmt(r['影响单量'])) + pt;
}
function impCell(r){
  const neg = r['影响单量']!=null ? r['影响单量']<0 : String(r['影响比率']).startsWith('-');
  return `<td class="imp ${neg?'neg':'pos'}">${impText(r)}</td>`;
}
/** 条长的归一化基准。有折损单量就用它 —— 同一张表里 metric 相同，量纲一致。 */
const barVal = r => r['影响单量']!=null
  ? Math.abs(r['影响单量'])
  : Math.abs(parseFloat(String(r['影响比率']).replace('%',''))||0);

function renderBlocks(drill, alarms, hasSite){
  if(!drill.length) return `<div class="card pad"><div class="empty">无异常</div></div>`;
  let html='';
  for(const source of uniq(drill.map(x=>x['来源']))){
    const sdf=drill.filter(x=>x['来源']===source);
    let inner='';
    for(const metric of uniq(sdf.map(x=>x['异常指标']))){
      const mdf=sdf.filter(x=>x['异常指标']===metric);
      const a=alarms.find(x=>x['来源']===source && x['异常指标']===metric);
      const isF=a&&a._is_f;
      const pillCls=isF?'rise':'drop';
      const basisTag = a && a._basis==='基准线' ? ` <span class="hint" title="按该指标自身的历史波动带触发">· 基准线</span>` : '';
      const roleTitle={根因:'该指标解释了其所属大环节的异常',已解释:'已被其下级异常解释，不重复计入根因',
                       未解释:'大环节异常但子指标均正常——存在未被覆盖的因素',局部:'子环节异常但所属大环节正常，可能被其他子项抵消'};
      /* `无子指标` 一个字都不出 —— 环节2 在漏斗树里就没有子指标，那是它本来的样子，
         不是一件要告诉人的事。内部还留着这个角色，只是为了和真的「未解释」分开计数。 */
      const roleTag = (a && a._role && a._role!=='无子指标')
        ? ` <span class="role ${a._role}" title="${roleTitle[a._role]||''}">${a._role}</span>` : '';
      const stageTag = a && a._stage && a._stage!=='-' ? ` <span class="hint">环节${a._stage}</span>` : '';
      const head = a
        ? `<span class="mv">${esc(fmtVal(a['上期比率']))} → <b>${esc(fmtVal(a['本期比率']))}</b></span><span class="pill ${pillCls}">${esc(a['环比'])}</span>${roleTag}${stageTag}${basisTag}`
        : '';
      const rows = mdf.map(r=>{
        const flag = r['是否>PO']==='是' ? ' <span class="tag-warn" title="该环节含退款/重试">&gt;PO</span>' : '';
        const site = hasSite ? `<td class="l">${esc(r['站点'])}</td>` : '';
        const kw = `${r['商户名称']} ${r['用户ID']} ${r['站点']} ${metric}`.toLowerCase();
        return `<tr data-kw="${esc(kw)}" data-mid="${esc(r['来源']+'|'+r['用户ID'])}">
          <td class="l">${esc(r['商户名称'])} <span class="hint">${esc(r['用户ID'])}</span></td>
          ${site}
          <td>${r['本期PO总单量'].toLocaleString()}${smallTag(r)}</td>
          <td>${r['进入本环节(单)']==null?'—':r['进入本环节(单)'].toLocaleString()}${flag}</td>
          <td>${r['通过本环节(单)']==null?'—':r['通过本环节(单)'].toLocaleString()}</td>
          <td>${esc(r['上期比率'])}${capTag(r['上期封顶原值'])} → ${esc(r['本期比率'])}${capTag(r['本期封顶原值'])}</td>
          <td>${esc(r['比率环比变动'])}</td>
          ${impCell(r)}
        </tr>`;
      }).join('');
      inner += `<div class="metric-block" data-src="${esc(source)}" data-stage="${esc((a&&a._stage)||'')}" data-role="${esc((a&&a._role)||'')}" data-metric="${esc(metric)}">
        <div class="metric-head"><span>◆ ${esc(metric)}</span>${head}</div>
        <div class="tbl-scroll"><table class="dtl">
          <thead><tr>
            <th class="l">商户 / ID</th>${hasSite?'<th class="l">站点</th>':''}
            <th>本期PO</th><th>进入本环节</th><th>通过本环节</th><th>比率(上期→本期)</th><th>环比变动</th>
            <th title="Δ比率 × 该环节分母 × 下游各环节通过率累乘。所有环节折算到同一把尺子上">对大盘<br><span class="hint">支付成功单</span></th>
          </tr></thead><tbody>${rows}</tbody>
        </table></div>
      </div>`;
    }
    html += `<div class="src-block" data-src="${esc(source)}"><div class="src-head">▌ ${esc(source)}</div>${inner}</div>`;
  }
  return html;
}

/**
 * 「优先排查」的商户下钻。
 *
 * 和下面那两块（合计行 / 站点明细异常）的区别必须写清楚：
 * 那两块是「过了告警阈值」的指标；这一块是「没过阈值、但对整体拖累最大」的环节，
 * 播报里点名的就是它。以前这里什么都没有，通知说了却查不到人。
 */
/**
 * 「每来源一个故事」的页面版：整体涨/跌，主因是哪个环节，那个环节又是哪几家商户。
 *
 * 和下面两块（合计行/站点明细异常）的区别：那两块是**过了告警阈值**的指标；
 * 这一块按对整体的 pt 拖累/拉动挑环节，不看阈值 —— 播报里点名的就是它。
 * 之前这里只渲染拖累侧，整体在涨的来源一个字都没有。
 */
function renderSourceStory(story){
  if(!story || !story.length) return '';

  const table=(rows, up)=>{
    const shown = rows.slice(0,20);
    // 条长按**本表内**最大绝对影响归一化。必须同一个基准，
    // 每行各自为政的话条形本身就是错的信息。
    const mx = Math.max(...shown.map(barVal), 0) || 1;
    return `<div class="tbl-scroll"><table class="dtl ${up?'up':'down'}">
      <thead><tr>
        <th class="l">商户 / ID</th><th class="l">站点</th>
        <th>本期PO</th><th>进入本环节</th><th>通过本环节</th><th>比率(上期→本期)</th><th>环比变动</th>
        <th title="Δ比率 × 该环节分母 × 下游各环节通过率累乘">对大盘<br><span class="hint">支付成功单</span></th>
      </tr></thead><tbody>${
        shown.map(r=>{
          const flag = r['是否>PO']==='是' ? ' <span class="tag-warn" title="该环节含退款/重试">&gt;PO</span>' : '';
          const w = (barVal(r)/mx*100).toFixed(1);
          return `<tr>
            <td class="l">${esc(r['商户名称'])} <span class="hint">${esc(r['用户ID'])}</span></td>
            <td class="l">${esc(r['站点'])}</td>
            <td>${r['本期PO总单量'].toLocaleString()}${smallTag(r)}</td>
            <td>${r['进入本环节(单)']==null?'—':r['进入本环节(单)'].toLocaleString()}${flag}</td>
            <td>${r['通过本环节(单)']==null?'—':r['通过本环节(单)'].toLocaleString()}</td>
            <td>${esc(r['上期比率'])}${capTag(r['上期封顶原值'])} → ${esc(r['本期比率'])}${capTag(r['本期封顶原值'])}</td>
            <td>${esc(r['比率环比变动'])}</td>
            <td class="imp bx"><i style="width:${w}%"></i><span>${impText(r)}</span></td>
          </tr>`;
        }).join('')
      }</tbody></table></div>${
        rows.length>20 ? `<div class="hint" style="margin-top:6px">仅显示影响最大的 20 个，共 ${rows.length} 个</div>` : ''
      }`;
  };

  const sideBlock=(side, up)=>{
    if(!side) return '';
    const st=side.st, dPt=st.rateT-st.rateY;
    // 穿透链：大环节是结果，真正动的是下面某一层；商户表也是按 leaf 那层拆的
    const chain = (side.chain||[]).length
      ? `<div class="hint" style="margin:2px 0 8px">穿透：${
          side.chain.map(c=>`<b>${esc(c.metric)}</b> ${pct(c.rateY)}→${pct(c.rateT)}（${ptFmt(c.delta)}）`).join(' → ')
        }　·　下表按 <b>${esc(side.leaf)}</b> 拆到商户</div>`
      : '';
    return `<div class="metric-block" data-metric="${esc(side.metric)}">
      <div class="metric-head">
        <span>${up?'▲ 拉升':'▼ 拖累'} ${esc(side.metric)}</span>
        <span class="mv">${pct(st.rateY)} → <b>${pct(st.rateT)}</b></span>
        <span class="pill ${up?'rise':'drop'}">${ptFmt(dPt)}</span>
        <span class="hint">${st.contrib<0?'拉低':'拉动'}该来源整体 ${ptFmt(st.contrib)}</span>
      </div>
      ${chain}
      ${side.rows.length ? table(side.rows, up) : `<div class="empty">${esc(side.reason||'无可下钻的商户')}</div>`}
    </div>`;
  };

  const blocks = story.map(s=>{
    const rising = s.dOverall>=0;
    // 和整体同向的那侧先渲染 —— 那才是"为什么涨/为什么跌"的答案
    const order = rising ? [[s.up,true],[s.down,false]] : [[s.down,false],[s.up,true]];
    return `<div class="src-block" data-src="${esc(s.src)}">
      <div class="src-head">▌ ${esc(s.src)} · 业务单支付成功率 ${pct(s.overallT)}
        <span class="pill ${rising?'rise':'drop'}" style="margin-left:8px">${ptFmt(s.dOverall)}</span></div>
      ${order.map(([side,up])=>sideBlock(side,up)).join('')}
    </div>`;
  }).join('');

  return `<div class="sec-title">按场景看 · 涨跌各自由谁造成 <span class="cnt">${story.length} 个来源</span></div>${blocks}`;
}


export { buildSourceStory, orderedSources, renderBlocks, renderOverview, renderSourceStory };
