import { broadcastMd, broadcastTxt, watchMd, watchTxt } from '../broadcast.js';
import { ALLOWED_SOURCES, ALL_METRICS, PERIOD } from '../config.js';
import { calcFunnel } from '../funnel.js';
import { download } from '../../shared/file.js';
import { state } from '../store.js';
import { $, esc } from '../../shared/dom.js';
import { num, pct } from '../util.js';

/* ---- broadcast ---- */
let bcMode='txt';
/**
 * 播报是**两条独立消息**，不是一条（B14）：
 *   1. 转化率监控 —— 今天出了什么事
 *   2. 待观察商户 —— 这几家一直不对劲
 * 混在一条里，飞书上纯文本版两套缩进打架、卡片版一大坨；
 * 而且读的人会把下半截当成没修完的告警，然后连上半截一起忽略。
 * 第二条没人要盯时是空串，界面和推送都据此整块隐藏 / 跳过。
 */
function renderBroadcast(){
  const d=state.data;
  /* 渲染层保留 store（T3 只收分析层）——这里把整份分析结果传给播报，
     播报本身不再读 state。 */
  const txt=broadcastTxt(d.alarmTotal,d.drillTotal,d.alarmSite,d.drillSite,d.tDate,d);
  const md =broadcastMd (d.alarmTotal,d.drillTotal,d.alarmSite,d.drillSite,d.tDate,d);
  const wTxt=watchTxt(d.tDate, d), wMd=watchMd(d.tDate, d);
  state.bc={txt, md, watchTxt:wTxt, watchMd:wMd};
  paintBroadcast();
}
/** 切 txt/md 时两块一起重画 —— 以前只有一块，切换逻辑散在 main.js 里。 */
function paintBroadcast(){
  const b=state.bc||{};
  $('#bcOut').textContent = bcMode==='txt' ? (b.txt||'') : (b.md||'');
  const w = bcMode==='txt' ? (b.watchTxt||'') : (b.watchMd||'');
  const wrap=$('#watchCastWrap');
  if(wrap) wrap.hidden = !w;
  $('#watchCastOut').textContent = w;
}

/* ---- chain funnel ---- */
function renderChain(){
  const d=state.data;
  const sel=$('#chainSel');
  // 按来源分组：两个来源下可能出现同名商户/站点，不带来源会分不清
  const bySrc=new Map();
  d.mergedSite.forEach((r,i)=>{
    const s=r['来源']||'(未知来源)';
    if(!bySrc.has(s)) bySrc.set(s,[]);
    bySrc.get(s).push({r,i});
  });
  const have=[...bySrc.keys()];
  const order=ALLOWED_SOURCES.filter(s=>have.includes(s)).concat(have.filter(s=>!ALLOWED_SOURCES.includes(s)));
  sel.innerHTML = order.map(s=>{
    const opts=bySrc.get(s).map(({r,i})=>{
      const label=`${s}｜${r['商户名称']} (ID:${r['用户ID']})${d.hasSite?' / '+r['站点']:''} · PO ${Math.round(num(r['PO单数_今']))}`;
      return `<option value="${i}">${esc(label)}</option>`;
    }).join('');
    return `<optgroup label="${esc(s)}">${opts}</optgroup>`;
  }).join('');
  const first=order.length?bySrc.get(order[0])[0].i:0;
  sel.value=String(first);
  drawChain(first);
}
function drawChain(idx){
  const d=state.data;
  const r=d.mergedSite[idx];
  if(!r){ $('#chainView').innerHTML='<div class="empty">无数据</div>'; return; }
  const po=Math.round(num(r['PO单数_今']));
  let html='';
  for(const m of ALL_METRICS){
    if(!(m+'_今' in r)) continue;
    const [dT,nT]=calcFunnel(r,m,'_今');
    const rateT=num(r[m+'_今']), rateY=num(r[m+'_昨']);
    const delta=rateT-rateY;
    // 累计转化率（相对于 PO 的通过占比），用作条形宽度
    const w = po>0 ? Math.max(0,Math.min(1, nT/po)) : 0;
    const dSign = delta>=0?'▲':'▼';
    const dCls = delta>=0?'var(--good)':'var(--critical)';
    html += `<div class="fbar">
      <div class="flab"><div>${esc(m)}</div><div class="fn">进入 ${dT.toLocaleString()} · 通过 ${nT.toLocaleString()}</div></div>
      <div class="ftrack"><i style="width:${(w*100).toFixed(1)}%"></i></div>
      <div class="fval"><b>${pct(rateT)}</b> <span style="color:${dCls}">${dSign}${Math.abs(delta*100).toFixed(2)}pt</span></div>
    </div>`;
  }
  $('#chainView').innerHTML = `<div class="hint" style="margin-bottom:8px">条形宽度 = 该环节通过单量占本期 PO(${po.toLocaleString()}) 的比例；右侧为本环节通过率及环比(pt)。</div>`+html;
}

/* ---- report wide table ---- */
function renderReport(){
  const wide=state.data.wide;
  if(!wide.length){ $('#reportTable').innerHTML='<div class="empty">无数据</div>'; return; }
  const cols=Object.keys(wide[0]);
  const th=cols.map((c,i)=>`<th class="${i===0?'l':''}">${esc(c)}</th>`).join('');
  const trs=wide.map(row=>'<tr>'+cols.map((c,i)=>`<td class="${i<(state.data.hasSite?5:4)?'l':''}">${esc(String(row[c]??''))}</td>`).join('')+'</tr>').join('');
  $('#reportTable').innerHTML=`<table class="grid-tbl"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
}

/* ---- Excel export ---- */
function exportExcel(){
  const d=state.data;
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(d.wide), '链式精算宽表');
  const dt = d.drillTotal.length ? d.drillTotal : [{说明:'合计行无异常'}];
  const ds = d.drillSite.length  ? d.drillSite  : [{说明:'站点无异常'}];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dt), '合计异常');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(ds), '站点异常');
  XLSX.writeFile(wb, `转化率监控_${d.period||PERIOD}_${d.tDate}.xlsx`);
}



export function setBcMode(v){ bcMode = v; }

export { bcMode, download, drawChain, exportExcel, paintBroadcast, renderBroadcast, renderChain, renderReport };
