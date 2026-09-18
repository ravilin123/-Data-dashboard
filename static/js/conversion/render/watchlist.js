import { P, SMALL_MERCHANT_PO, WATCH_GAP, WATCH_LOW_RUN, WATCH_MIN_PO, WATCH_TOP } from '../config.js';
import { $, esc } from '../../shared/dom.js';
import { shortSite, trim } from '../../shared/text.js';
import { pct } from '../util.js';

/* ---------- 待观察商户（B14） ----------
   刻意和「优先排查」「异常明细」长得不一样、也不放在一起：那两块是**告警**，
   讲的是今天动了什么；这块讲的是「这几家一直不对劲」。
   放同一个视觉层级里，人会把它当成一堆没修的告警，然后开始忽略整块。 */

/** 商户名和站点一样时只写一次（新表没有「商户名称」列，域名顶上的）。 */
function who(name, site){
  const s=shortSite(trim(site)), n=trim(name);
  return n && n!==s ? `${esc(n)} <span class="hint">${esc(s)}</span>` : esc(s);
}

const tag = (on, txt, title) => on
  ? ` <span class="tag-warn" title="${esc(title)}">${esc(txt)}</span>` : '';
/** 出单监控给的标签（B15）。用蓝底和上面那些警示标记区分开 —— 它是「来自另一个工具」，不是警告。 */
const omTags = x => (x.出单监控||[]).map(s=>
  ` <span class="tag" style="background:var(--brand);color:#fff;font-size:10.5px;padding:1px 6px;border-radius:6px"
     title="出单监控当天的分类">${esc(s)}</span>`).join('');

function lowRow(x){
  /* class 是给用例按行解析用的（e2e 要把「连续几期」和「低几 pt」配对，
     全局扫正则配不出来）。样式仍走内联，别为了这个把整块重排一遍。 */
  return `<div class="wl-row" style="display:flex;gap:10px;align-items:baseline;padding:3px 0;
                      font-variant-numeric:tabular-nums">
    <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
      ${who(x.name, x.site)} <span class="hint">· ${esc(x.src)}</span>
      ${x.长期低位
        ? ` <span class="tag-warn" title="连着 ${x.连续期数} 个有效期低于同行水平（单量不足的期次跳过不计）—— 长期低位，该找人推，不是今天才掉的">连续 ${x.连续期数} ${P().run}</span>`
        : tag(x.连续期数>=2, `连续 2 ${P().run}`, '上期也低于同行水平')}
      ${tag(x.单量少, '量少', `本期不足 ${SMALL_MERCHANT_PO} 单`)}${omTags(x)}
    </span>
    <b style="flex:none;min-width:64px;text-align:right">${pct(x.rate)}</b>
    <span class="hint" style="flex:none;min-width:56px;text-align:right">低 ${(x.缺口*100).toFixed(0)}pt</span>
    <span class="hint" style="flex:none;min-width:78px;text-align:right">${x.po.toLocaleString()} 单</span>
  </div>`;
}

function freshRow(f){
  return `<div style="display:flex;gap:10px;align-items:baseline;padding:3px 0;
                      font-variant-numeric:tabular-nums">
    <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
      ${who(f['商户名称'], f['站点'])} <span class="hint">· ${esc(f['来源'])}</span>
      ${tag(f.单量少, '量少', `本期不足 ${SMALL_MERCHANT_PO} 单`)}${omTags(f)}
    </span>
    <b style="flex:none;min-width:64px;text-align:right">${f['成功率']==null?'—':pct(f['成功率'])}</b>
    <span class="hint" style="flex:none;min-width:78px;text-align:right">${f['PO单数'].toLocaleString()} 单</span>
  </div>`;
}

/** 前 WATCH_TOP 行直列，其余收进 <details> —— 周报能有二十几家，全铺开会把概览顶下去。 */
function list(rows, render, head){
  const shown=rows.slice(0,WATCH_TOP), rest=rows.slice(WATCH_TOP);
  return `<div style="margin-top:10px">
    <div style="font-weight:700;font-size:13px">${head}</div>
    <div style="margin-top:4px">${shown.map(render).join('')}</div>
    ${rest.length?`<details style="margin-top:4px">
      <summary class="hint" style="cursor:pointer">还有 ${rest.length} 家，展开看</summary>
      <div style="margin-top:4px">${rest.map(render).join('')}</div></details>`:''}
  </div>`;
}

function renderWatchlist(w){
  const host=$('#watch');
  if(!host) return;
  if(!w || (!w.low.length && !w.fresh.length && !w.tiny.count && !(w.omPending||[]).length)){
    host.innerHTML=''; return;
  }

  /* 同行水平要写出来。不写的话「低 43pt」是低于什么、43pt 算多算少，读的人无从判断；
     而且 weak（够量的商户不足 WATCH_MIN_PEERS 家、退回全量算的）必须标出来 ——
     那种基准是粗的，据它下结论要留余地。 */
  const bl=Object.entries(w.baselines||{}).map(([src,b])=>
    `${esc(src)} <b>${pct(b.rate)}</b><span class="hint">（${b.peers} 家${
      b.weak?`，够 ${WATCH_MIN_PO} 单的不足 3 家，退回全部商户算`:''}）</span>`).join('　·　');

  const parts=[`<div class="lead">待观察商户</div>
    <div class="big">低于同行 ${w.low.length} 家 · 新入网 ${w.fresh.length} 家 · 量太少 ${w.tiny.count} 家</div>
    <div class="why"><b>这不是告警。</b>告警管「今天出了什么事」，这份名单管「这几家要盯着」——
      它们可能一个月都没动静，但一直不对劲，处理的人也不一样。<br>
      同行水平（同来源、本期 ≥${WATCH_MIN_PO} 单的商户成功率中位数）：${bl||'—'}</div>`];

  if(w.low.length){
    parts.push(list(w.low, lowRow,
      `📉 比同行低 ${WATCH_GAP*100}pt 以上：<b>${w.low.length}</b> 家
       <span class="hint">（本期 ≥${WATCH_MIN_PO} 单才算 —— 再少的话比率没有意义）</span>`));
    if(w.best)
      parts.push(`<div class="hint" style="margin-top:6px">💰 这批里最值钱的是
        <b>${who(w.best.name, w.best.site)}</b>：${w.best.po.toLocaleString()} 单，
        做到同行水平能多成 <b>${w.best.可多成.toLocaleString()}</b> 单。
        它缺口不算大、排在上面靠后，但量在那儿。</div>`);
  }
  if(w.fresh.length){
    /* 逐家只列够量的那批。不足 WATCH_MIN_PO 单的另起一行报家数 ——
       「新上线了」这件事本身有信息，但一两单的成功率说明不了任何事。 */
    if(w.freshNamed.length)
      parts.push(list(w.freshNamed, freshRow,
        `🆕 本期首次有量：<b>${w.fresh.length}</b> 家
         <span class="hint">（还没有环比，成功率好不好要连着盯几期）</span>`));
    if(w.freshTiny.count)
      parts.push(`<div class="hint" style="margin-top:${w.freshNamed.length?4:10}px">${
        w.freshNamed.length?'其中':'🆕 本期首次有量的'} <b>${w.freshTiny.count}</b> 家本期不足
        ${WATCH_MIN_PO} 单（合计 ${w.freshTiny.po.toLocaleString()} 单），成功率还看不出来，没逐家列。</div>`);
  }
  /* 出单监控说「刚审核通过、还没出单」的那批（B15）。它们在转化率报表里往往
     一行都没有（还没交易），所以上面两段都装不下 —— 单独列，不然这条信息就丢了。
     这是「在等谁上量」，正是这份名单最该回答的问题之一。 */
  if((w.omPending||[]).length){
    const rows=w.omPending.map(x=>`<div style="display:flex;gap:10px;padding:3px 0">
      <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
        ${who(x['商户名称'], x['站点'])}${x['所属BD']?` <span class="hint">· BD ${esc(x['所属BD'])}</span>`:''}</span>
      <span class="hint" style="flex:none">通道通过 ${esc(x['通道通过日期']||'—')}</span>
    </div>`).join('');
    parts.push(`<div style="margin-top:10px">
      <div style="font-weight:700;font-size:13px">🕒 刚审核通过、还没出单：<b>${w.omPending.length}</b> 家
        <span class="hint">（出单监控 ${esc(w.omDate||'')} 的名单；转化率报表里还没有它们的数据）</span></div>
      <div style="margin-top:4px">${rows}</div></div>`);
  }

  if(w.tiny.count)
    parts.push(`<div class="hint" style="margin-top:10px">🔍 另有 <b>${w.tiny.count}</b> 家本期不足
      ${WATCH_MIN_PO} 单（合计 ${w.tiny.po.toLocaleString()} 单），比率算不出来所以没逐家列 ——
      1 单 0% 和 1 单 100% 都只是一单的事。要查的话异常明细里都在。</div>`);

  host.innerHTML=`<div class="prio warn"><div style="flex:1">${parts.join('')}</div></div>`;
}

export { renderWatchlist };
