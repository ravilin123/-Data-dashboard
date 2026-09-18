import { loadBaselineForPeriod } from './baseline.js';
import { P, PERIOD, PERIOD_ORDER, setLevelThresholds, setPeriod } from './config.js';
import { anomalyCount } from './feishu.js';
import { AI_BASE_URL, WB_AI, aiDirect, aiViaWorkbench, promptSize, usageText } from '../shared/ai.js';
import { buildAIPrompt } from './ai_prompt.js';
import { initTheme } from '../shared/theme.js';
import { readReport } from './dataset.js';
import { KNOWN_UNANALYZED_SOURCES, merchantSheetName } from './load.js';
import { bcMode, download, drawChain, exportExcel, paintBroadcast, setBcMode } from './render/broadcast.js';
import { periodDates, resolvePair, run } from './render/index.js';
import { state } from './store.js';
import { $, esc } from '../shared/dom.js';

/* ============================================================
   每日转化率数据监控 v3 —— 网页版
   Python 逻辑的忠实移植：探测异常 + 生成播报素材，全程本地运行。
   ============================================================ */

/* 主题切换搬到 ../shared/theme.js —— merchant 那份没有 crm_theme 迁移，
   合并之后两个页面一致。 */
initTheme();

/* ---------- 顶部导航：面板切换 ---------- */
const PANELS=['upload','overview','detail','cast','chain','baseline','feishu','table'];
// 这些面板即使还没数据也允许进入（基准线可先算、飞书可先填凭据）
const ALWAYS_ON=['upload','baseline','feishu'];
let activePanel='upload';
function showPanel(name){
  if(!PANELS.includes(name)) return;
  activePanel=name;
  PANELS.forEach(p=>{ const el=document.getElementById('p-'+p); if(el) el.hidden = (p!==name); });
  document.querySelectorAll('#navTabs button').forEach(b=>
    b.setAttribute('aria-selected', b.dataset.panel===name ? 'true':'false'));
  // 阈值控制条只在与探测相关的面板显示
  const bar=document.getElementById('ctlBar');
  if(bar) bar.hidden = !['overview','detail'].includes(name);
  window.scrollTo({top:0,behavior:'instant'});
}
document.getElementById('navTabs').addEventListener('click',e=>{
  const b=e.target.closest('button'); if(!b||b.disabled) return;
  showPanel(b.dataset.panel);
});
/** 有数据后解锁全部标签页。 */
function unlockTabs(){
  document.querySelectorAll('#navTabs button').forEach(b=>b.disabled=false);
}
(function initPanels(){
  document.querySelectorAll('#navTabs button').forEach(b=>{
    b.disabled = !ALWAYS_ON.includes(b.dataset.panel);
  });
  showPanel('upload');
})();

/* ============================================================
   9. 事件绑定
   ============================================================ */
/** 根据探测结果启用/禁用周期按钮，并挑一个可用周期。 */
function applyPeriodAvailability(avail){
  state.periodAvail=avail;
  let firstOk=null;
  document.querySelectorAll('#periodSeg button').forEach(b=>{
    const p=b.dataset.period, ok=avail[p]&&avail[p].ok;
    b.disabled=!ok;
    b.title = ok ? `${p}：${avail[p].dates} 期数据`
                 : (avail[p]&&avail[p].rows ? `${p}只有 ${avail[p].dates} 期，不足以算环比` : `文件中无${p}数据`);
    if(ok&&!firstOk) firstOk=p;
  });
  if(!(avail[PERIOD]&&avail[PERIOD].ok)) setPeriod(firstOk || PERIOD);
  syncPeriodUI();
  const parts=PERIOD_ORDER.map(p=>`${p.replace('报','')}${avail[p]&&avail[p].ok?`✓${avail[p].dates}期`:'—'}`);
  $('#periodInfo').textContent = parts.join(' · ');
  return firstOk;
}
function syncPeriodUI(){
  document.querySelectorAll('#periodSeg button').forEach(b=>
    b.setAttribute('aria-pressed', b.dataset.period===PERIOD?'true':'false'));
  // 周期相关文案
  document.querySelectorAll('.pd-hist').forEach(el=>el.textContent=P().unit+'报');
  document.querySelectorAll('.pd-dod').forEach(el=>el.textContent=P().dod);
}
/* ---- 本期 / 对比期选择 ---- */

/** 按当前周期重填两个下拉，并把选中项同步成 run() 实际用的那一对 */
function syncDateSel(){
  const box=$('#dateSel'); if(!box) return;
  if(!state.wb){ box.hidden=true; return; }
  const {dates,t,y}=resolvePair(state.ds, PERIOD);
  if(dates.length<2){ box.hidden=true; return; }
  box.hidden=false;

  const fill=(sel,cur)=>{
    sel.replaceChildren(...dates.map(d=>{
      const o=document.createElement('option');
      o.value=d; o.textContent=d; o.selected=(d===cur);
      return o;
    }));
  };
  fill($('#selT'), t);
  fill($('#selY'), y);

  const latest = (t===dates[0] && y===dates[1]);
  $('#selLatest').disabled = latest;
  $('#selLatest').textContent = latest ? '最新两期' : '回到最新';
}

/**
 * 选完之后保证「本期晚于对比期」。
 * 撞车时自动把另一个挪开，而不是打回让人重选 ——
 * 否则想往前翻一期，得先改对比期再改本期，很别扭。
 * which: 't' = 用户刚改了本期，'y' = 刚改了对比期
 */
function onDateSelChange(which){
  const dates=periodDates(state.ds, PERIOD);   // 倒序
  const msg=$('#loadMsg');
  let t=$('#selT').value, y=$('#selY').value;

  if(t<=y){
    if(which==='t'){
      const cand=dates.find(d=>d<t);           // 比本期旧的最近一期
      if(!cand){
        msg.innerHTML='<div class="banner warn" style="margin-top:10px">这已经是最早的一期，没有更早的可对比。</div>';
        syncDateSel(); return;
      }
      y=cand;
    }else{
      const asc=[...dates].reverse();
      const cand=asc.find(d=>d>y);             // 比对比期新的最近一期
      if(!cand){
        msg.innerHTML='<div class="banner warn" style="margin-top:10px">这已经是最新一期，没有更新的可作为本期。</div>';
        syncDateSel(); return;
      }
      t=cand;
    }
  }
  state.sel[PERIOD]={t,y};
  try{
    run();
    const latest=(periodDates(state.ds,PERIOD)[0]===t);
    msg.innerHTML=`<div class="banner ok" style="margin-top:10px">✅ ${PERIOD} · 本期 ${t}（对比 ${y}）`
                + (latest?'':' —— 正在查看历史区间，要发飞书请确认下方「本次要发的内容」') + '</div>';
  }catch(err){
    msg.innerHTML=`<div class="banner warn" style="margin-top:10px">解析失败：${esc(err.message||String(err))}</div>`;
  }
}
$('#selT').addEventListener('change', ()=>onDateSelChange('t'));
$('#selY').addEventListener('change', ()=>onDateSelChange('y'));
$('#selLatest').addEventListener('click', ()=>{
  state.sel[PERIOD]=null;
  if(!state.wb) return;
  try{ run(); $('#loadMsg').innerHTML=
    `<div class="banner ok" style="margin-top:10px">✅ 已回到最新两期 · 本期 ${state.data.tDate}（对比 ${state.data.yDate}）</div>`; }
  catch(err){ $('#loadMsg').innerHTML=`<div class="banner warn" style="margin-top:10px">解析失败：${esc(err.message||String(err))}</div>`; }
});

$('#periodSeg').addEventListener('click', e=>{
  const b=e.target.closest('button'); if(!b||b.disabled||b.dataset.period===PERIOD) return;
  setPeriod(b.dataset.period);
  syncPeriodUI();
  loadBaselineForPeriod();     // 各周期独立的基准线
  if(state.wb){
    try{ run(); $('#loadMsg').innerHTML=
      `<div class="banner ok" style="margin-top:10px">✅ 已切换到 <b>${PERIOD}</b> · 本期 ${state.data.tDate}（对比 ${state.data.yDate}）</div>`; }
    catch(err){ $('#loadMsg').innerHTML=`<div class="banner warn" style="margin-top:10px">${PERIOD} 解析失败：${esc(err.message||String(err))}</div>`; }
  }
});

/* 解析入口。两条路进来：人工选文件，和工作台从邮箱取回来的存档（见文件末尾的 inbox 段）。
   抽成函数是为了后者不必伪造一个 change 事件。 */
async function loadWorkbook(buf, name){
  const msg=$('#loadMsg');
  msg.innerHTML='<span class="hint">正在解析…</span>';
  try{
    const wb=XLSX.read(buf,{cellDates:true});
    // 商户表两种叫法都收（旧「场景×商户维度」/ 新「商户维度」）
    const miss=[];
    if(!wb.SheetNames.includes('场景维度')) miss.push('场景维度');
    if(!merchantSheetName(wb)) miss.push('商户维度（或场景×商户维度）');
    if(miss.length) throw new Error('缺少必要 sheet：'+miss.join('、')+'。当前文件含：'+wb.SheetNames.join('、'));

    /* 整份报表读一次（三个周期一起），之后切周期、换日期都不用重读。
       实测 3.2MB 真实报表：XLSX.read 本身 2285ms，这一步 507ms —— 比原来
       每次 run() 都重解析一遍（还调两遍 loadMerchant）还快。 */
    const ds=readReport(wb);
    const firstOk=applyPeriodAvailability(ds.periods);
    if(!firstOk) throw new Error('未找到可对比的周期数据：日报/周报/月报均不足两期。');

    state.wb=wb;
    state.ds=ds;
    state.sel={};                 // 换文件了，之前选的日期多半已经不存在
    loadBaselineForPeriod();
    run();
    $('#app').hidden=false; $('#foot').hidden=false;
    unlockTabs(); showPanel('overview');
    const dr=ds.drift;
    let extra='';
    if(dr){
      const bits=[];
      if(dr.newSources.length) bits.push(`<b style="color:var(--warn-on,#8a5a10)">未识别的来源 ${dr.newSources.length} 个：`
        + `${esc(dr.newSources.join('、'))}</b>（不在分析范围内。上游改名或新增场景时会出现这条，`
        + `确认要分析就把它加进 ALLOWED_SOURCES）`);
      if(dr.newMetrics.length) bits.push(`<b style="color:var(--warn-on,#8a5a10)">未识别的指标 ${dr.newMetrics.length} 个：`
        + `${esc(dr.newMetrics.slice(0,6).join('、'))}${dr.newMetrics.length>6?' 等':''}</b>`
        + `（不进漏斗树。改名的话要在 METRIC_CANON 里补一条映射）`);
      if(dr.dodColumn && !dr.dodColumn.present) bits.push(`<span class="hint">`
        + `源表没有「环比」列 —— 告警按你选的这对日期现算，不受影响；`
        + `只是少了一道「和上游口径对账」的校验。加回来即自动启用，`
        + `换了名字就在 load.js 的 DOD_ALIASES 补一条</span>`);
      if(dr.skipSources.length) bits.push(`<span class="hint">已知不分析的来源：`
        + `${esc(dr.skipSources.map(x=>x+'（'+KNOWN_UNANALYZED_SOURCES[x]+'）').join('、'))}</span>`);
      if(bits.length) extra=`<div class="banner${(dr.newSources.length||dr.newMetrics.length)?' warn':''}" `
        + `style="margin-top:8px">${bits.join('<br>')}</div>`;
    }
    msg.innerHTML=`<div class="banner ok" style="margin-top:10px">✅ 已解析：${esc(name)} · 当前 <b>${PERIOD}</b>，本期 ${state.data.tDate}（对比 ${state.data.yDate}）`
      + `${dr?` · 分析 ${dr.usedSources.length} 个来源`:''}</div>${extra}`;
    return true;
  }catch(err){
    console.error(err);
    msg.innerHTML=`<div class="banner warn" style="margin-top:10px">解析失败：${esc(err.message||String(err))}</div>`;
    $('#app').hidden=true;
    return false;
  }
}

$('#file').addEventListener('change', async e=>{
  const f=e.target.files[0]; if(!f) return;
  await loadWorkbook(await f.arrayBuffer(), f.name);
});

$('#recalc').addEventListener('click', ()=>{
  if(!state.wb) return;
  const nv=(sel,def)=>{ const v=parseFloat($(sel).value); return Number.isFinite(v)?v/100:def; };
  setLevelThresholds({ 0:nv('#thMain',-0.05), 1:nv('#thSub',-0.03), 2:nv('#thLeaf',-0.02),
                       friction_rise:nv('#thFric',0.02) });
  syncThCur();
  run();
});

/** 折起时也要能一眼看到现在按什么阈值在判。 */
function syncThCur(){
  const el=$('#thCur'); if(!el) return;
  const v=id=>$(id) ? $(id).value : '';
  el.textContent = `${v('#thMain')} / ${v('#thSub')} / ${v('#thLeaf')} / ${v('#thFric')>=0?'+':''}${v('#thFric')}`;
}
['#thMain','#thSub','#thLeaf','#thFric'].forEach(id=>{
  const el=$(id); if(el) el.addEventListener('input', syncThCur);
});
syncThCur();

$('#bcTabs').addEventListener('click', e=>{
  const b=e.target.closest('.tab'); if(!b) return;
  setBcMode(b.dataset.bc);
  $('#bcTabs').querySelectorAll('.tab').forEach(t=>t.classList.toggle('on',t===b));
  // 两块（转化率监控 / 待观察商户）共用一个 txt|md 开关，一起重画
  paintBroadcast();
});
/** 复制 / 下载在两块之间只差取哪个 pre、文件名叫什么。 */
function bindCast(btnCopy, btnDl, sel, name){
  $(btnCopy).addEventListener('click', async()=>{
    try{
      await navigator.clipboard.writeText($(sel).textContent);
      $(btnCopy).textContent='已复制 ✓'; setTimeout(()=>$(btnCopy).textContent='复制',1400);
    }catch(e){ alert('复制失败，请手动选择文本复制。'); }
  });
  $(btnDl).addEventListener('click', ()=>{
    const d=state.data; download(`${name(d)}.${bcMode}`, $(sel).textContent);
  });
}
bindCast('#copyBc', '#dlBc', '#bcOut', d=>`${P().unit}报播报_${d.tDate}`);
bindCast('#copyWatchCast', '#dlWatchCast', '#watchCastOut', d=>`待观察商户_${d.tDate}`);
/* ---- AI 总结 ----
   提示词主体直接用 state.bc.md（播报素材已经是整理好的本期异常摘要），
   不另起一套数据组装。工作台托管时走代转，直连打开时退回填 key / 手动粘贴。 */
/* AI 的常量与调用栈都搬到 ../shared/ai.js 了。两页原来各一份，而且
   conversion 这份功能更少：base URL 写死、不返回 finish_reason、
   用量只有一行朴素文本。合并取功能齐的那份。 */

/* 提示词本体搬到 ./ai_prompt.js 了 —— 它是纯函数（吃 analyze 的结果 + 播报素材），
   所以 tests/ai_prompt.mjs 能直接喂字面量验「周月报有没有拿到趋势数据」。
   ⚠️ 周报/月报和日报**问的不是同一个问题**，喂的素材也不一样，别再合成一套。 */
const buildPrompt = () => buildAIPrompt(state.data, state.bc && state.bc.md);

function applyAISummary(text){
  const out=$('#aiOut');
  out.hidden=false; out.textContent=text;
}




$('#aiBtn').addEventListener('click', async ()=>{
  const st=$('#aiStatus');
  if(!state.data){ st.className='status err'; st.textContent='请先上传并解析文件。'; return; }
  const key=$('#aiKey').value.trim();
  if(!WB_AI.available && !key){
    st.className='status err';
    st.textContent='请填写 AI Key；或在 config.json 的 ai.api_key 里配好，由工作台代转（不用填、也不会被 CORS 拦）。';
    return;
  }
  const btn=$('#aiBtn'), label=btn.textContent;
  btn.disabled=true; btn.textContent='生成中…';
  st.className='status'; st.textContent = WB_AI.available
    ? `正在经工作台调用 ${WB_AI.model||'AI'} …`
    : `正在直连 ${AI_BASE_URL.replace(/^https?:\/\//,'')} …`;
  const prompt=buildPrompt();
  const sz=promptSize(prompt);
  st.textContent += `（提示词 ${sz.chars} 字符，约 ${sz.est} tokens）`;
  try{
    const res = WB_AI.available ? await aiViaWorkbench(prompt) : await aiDirect(prompt, key);
    applyAISummary(res.content);
    st.className='status ok'; st.textContent='✅ 已生成'+usageText(res.usage);
  }catch(err){
    st.className='status err';
    st.textContent='AI 总结失败：'+(err.message||String(err))+'　已打开下方「手动跑」作为退路。';
    $('#aiManual').open=true; $('#aiPromptOut').value=prompt;
  }finally{ btn.disabled=false; btn.textContent=label; }
});

$('#aiCopy').addEventListener('click', async ()=>{
  if(!state.data){ $('#aiStatus').className='status err'; $('#aiStatus').textContent='请先上传并解析文件。'; return; }
  const prompt=buildPrompt();
  $('#aiManual').open=true; $('#aiPromptOut').value=prompt;
  try{ await navigator.clipboard.writeText(prompt);
       $('#aiStatus').className='status ok'; $('#aiStatus').textContent='提示词已复制，粘到任意大模型即可。'; }
  catch(e){ $('#aiPromptOut').select();
       $('#aiStatus').className='status'; $('#aiStatus').textContent='请在下方框中手动全选复制。'; }
});

$('#aiApply').addEventListener('click', ()=>{
  const v=$('#aiPaste').value.trim();
  if(!v){ $('#aiStatus').className='status err'; $('#aiStatus').textContent='请先把大模型的回答粘进来。'; return; }
  applyAISummary(v);
  $('#aiStatus').className='status ok'; $('#aiStatus').textContent='✅ 已应用粘贴的总结';
});

$('#chainSel').addEventListener('change', e=>drawChain(+e.target.value));
$('#export').addEventListener('click', exportExcel);

/* ============================================================
   13. 从工作台的邮箱存档直接加载

   报表每天由邮件发来，工作台已经按业务日期存好了。这里省掉「下载附件 → 选文件」
   那两步：带 ?inbox=<日期> 进来（首页待办卡片就是这么跳的）就直接解析；
   直接打开本页则只提示一句，点了才加载 —— 不替用户做决定。

   注意这里**不碰任何飞书推送**：解析完是否发群、是否写多维表格，仍然只有点按钮才发。
   ============================================================ */
(async function inboxAutoLoad(){
  // 离线快照（dashboard/offline.py）没有 URL 参数，靠 <html data-inbox="日期"> 传同一件事
  // ⚠ 无头跑法（jobs/conversion_run.mjs）里 document 是桩，没有 dataset —— 判一下，别让整个模块炸在这一行
  const root=document.documentElement;
  const want=new URLSearchParams(location.search).get('inbox') || (root && root.dataset && root.dataset.inbox) || '';
  let info;
  try{
    const r=await fetch('/api/inbox/latest',{cache:'no-store'});
    if(!r.ok) return;                       // 不是工作台在服务本页，或功能没开
    info=await r.json();
  }catch(e){ return; }
  const c=info && info.conversion;
  if(!c || !c.url) return;

  const load=async ()=>{
    const msg=$('#loadMsg');
    msg.innerHTML='<span class="hint">正在从邮箱存档加载…</span>';
    let buf;
    try{
      const r=await fetch(c.url,{cache:'no-store'});
      if(!r.ok) throw new Error(`HTTP ${r.status}`);
      buf=await r.arrayBuffer();
    }catch(e){
      msg.innerHTML=`<div class="banner warn" style="margin-top:10px">邮箱存档加载失败：${esc(e.message||String(e))}。请手动选择文件。</div>`;
      return;
    }
    if(await loadWorkbook(buf, `${c.date} 报表（邮箱自动获取）`)){
      // 回报一声，首页那张待办卡片就消掉了
      fetch('/api/inbox/analyzed',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({kind:'conversion',date:c.date})}).catch(()=>{});
    }
  };

  if(want && want===c.date){ await load(); return; }

  const box=document.createElement('div');
  box.className='banner ok';
  box.style.margin='0 0 12px';
  box.innerHTML=`📥 工作台已从邮箱取到 <b>${esc(c.date)}</b> 的报表${c.analyzed?'（本机已分析过）':''}　`;
  const btn=document.createElement('button');
  btn.type='button'; btn.className='btn'; btn.textContent='直接加载';
  btn.addEventListener('click',()=>{ box.remove(); load(); });
  box.appendChild(btn);
  const anchor=$('#loadMsg');
  if(anchor && anchor.parentNode) anchor.parentNode.insertBefore(box, anchor);
})();

/* ---------- 出单监控的商户名单（B15） ----------
   出单监控每天已经点过名了：谁刚跨过 $100、谁刚审核通过、谁在滞留。
   那批正是「待观察商户」要盯的人，两个工具没必要各判一遍。

   异步取、取不到也不影响任何事：`state.om` 一直是 null 的话，名单照样出，
   只是少几个标签。取到了而且已经分析过报表，就再跑一次 run() 把标签补上
   —— 重算是纯计算（analyze 不碰网络、不碰 DOM），几十毫秒的事。

   离线打开工具页（没有工作台）时 fetch 直接失败，catch 掉就行 —— 这条路本来就是可选的。 */
(async ()=>{
  try{
    const r=await fetch('/api/order-monitor/latest',{cache:'no-store'});
    if(!r.ok) return;
    const d=await r.json();
    if(!d || !d.found || !(d.merchants||[]).length) return;
    state.om=d;
    if(state.ds) run();          // 报表已经加载过了 → 重算一遍，把标签补上
  }catch(e){ /* 没有工作台 / 没跑过出单监控，都不是错 */ }
})();

/* 模块化之后页面不再往 window 上挂任何东西 —— 这一个是唯一的例外，明确要留的。
   tests/e2e.py 用它切面板：容器里资源紧张时 Playwright 的 click 容易超时，
   用例注释里写了为什么绕开 click 直接调函数。改名字之前先看那套用例。 */
window.showPanel = showPanel;

export { syncDateSel };
