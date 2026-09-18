import { ALL_METRICS, ALLOWED_SOURCES, ARCHIVE_MAX_FILES, DEPS, FRICTION_METRICS, LEVEL_MIN_N, LEVEL_THRESHOLDS, METRIC_DEPTH, MIX_MAX_GAP, MIX_MIN_SAMPLES, P, PERIOD, POOL_MIN_MIXED, POOL_MIN_SRC } from './config.js';
import { loadScene } from './load.js';
import { dodOf, sceneMap } from './funnel.js';
import { cmpPeriod } from './trend.js';
import { download } from './render/broadcast.js';
import { run } from './render/index.js';
import { state } from './store.js';
import { $, esc } from '../shared/dom.js';

/* ============================================================
   10. 业务基准线（中位数 ± k·MAD，功能 3）
   ============================================================ */
function median(a){ if(!a.length) return 0; const s=[...a].sort((x,y)=>x-y); const m=s.length>>1; return s.length%2?s[m]:(s[m-1]+s[m])/2; }
function percentile(a,p){ if(!a.length) return 0; const s=[...a].sort((x,y)=>x-y); const i=(s.length-1)*p, lo=Math.floor(i), hi=Math.ceil(i); return s[lo]+(s[hi]-s[lo])*(i-lo); }


/* ============================================================
   10.1 攒样本（B4）—— 纯函数，可直接写字面量测

   两类样本，两套用途：
     环比（相邻两期的相对变化） → 阈值，回答「今天动得算不算大」
     水平（每一期的当期值）     → 分位数，回答「今天这个数在历史上算什么位置」（B3）

   两类都**同时进两个池**：`来源|指标` 自己的，和只按 `指标` 的混池。
   哪个作数由 pickPool() 三级回退决定 —— 分池是为了准，混池是为了有。
   ============================================================ */
const poolKey = (src, metric) => src + '|' + metric;
const push = (pool, key, v) => { (pool[key] = pool[key] || []).push(v); };
/** 第一次见返回 true，之后 false。`_seen` 缺席时调用方自己跳过这一步。 */
const once = (seen, key) => seen.has(key) ? false : (seen.add(key), true);

/**
 * 空样本集。四个池分开放，别揉成一个 —— 环比和水平的量纲不是一回事。
 *
 * `_seen` 是**跨文件去重**用的（B11）。存档是滚动窗口：每份报表都带最近 8 期，
 * 连着两天的存档重叠 7 期。不去重的话同一个观测会被算好几遍 ——
 * 分位数的形状不变（重复值不改变分布），但 **`n` 会说谎**，而 `n` 正是
 * POOL_MIN_SRC / LEVEL_MIN_N 这些门槛在看的东西。
 *
 * 实测把同一份报表喂两遍：水平样本 8 → 16，池子从 **0 个变成 54 个** ——
 * 原本「样本不足、不该出信号」的池子凭空达标，界面上还写着 n=16。
 * 那之后 B3 的水平信号就建在一个假的样本量上了。
 */
const emptySamples = () => ({dod:{}, dodMixed:{}, level:{}, levelMixed:{}, _seen:new Set()});
/* levelMixed 照样攒（stats 里要显示「这个指标全网大概什么水平」），
   但**不产出到基准线里** —— 见 buildBaseline 里那段和 pickLevelPool 的注释：
   绝对水平混池是天天误报的来源，产出了迟早有人拿去判。 */

/**
 * 从一份场景维度行里攒样本，累加进 `into`。
 *
 * ⚠️ **跨文件按 (期次, 来源, 指标) 去重**，见 emptySamples 的注释 ——
 * 存档是滚动窗口，连着两天的报表重叠 7 期，不去重 `n` 就会说谎。
 *
 * ⚠️ 期次排序走 `cmpPeriod`（自然序）不是字典序。原来这里是裸 `.sort()` ——
 * 周报期次写成 `2026 W9` / `2026 W37` 时字典序会把 W9 排到 W37 后面，
 * 于是「相邻两期」配错对，算出来的环比样本是**跨了几周的变化**。
 * 和 B5 折线那处是同一个 bug，只是这边算出来的是阈值，错了更隐蔽。
 */
function collectSamples(scene, into){
  const seen=into._seen || null;
  const dates=[...new Set(scene.map(o=>o['统计日期']).filter(x=>x))].sort(cmpPeriod);
  // 水平样本：每一期每个来源每个指标各一条
  for(const d of dates){
    const m=sceneMap(scene, d);
    for(const src of Object.keys(m)) for(const metric of Object.keys(m[src])){
      if(!(metric in DEPS)) continue;
      const v=m[src][metric];
      if(v==null || !Number.isFinite(v)) continue;
      if(seen && !once(seen, `L\u0000${d}\u0000${src}\u0000${metric}`)) continue;
      push(into.level, poolKey(src,metric), v);
      push(into.levelMixed, metric, v);
    }
  }
  /* 环比样本：按**文件内的相邻两期**现算，不读源表那一列（第四轮 A1）。
     两个理由：一是口径要和 detect() 一致 —— 基准线算出来的是阈值，
     拿另一套口径的分布去卡这一套口径的值，本身就不对；
     二是 2026-09 起源表整个没有这一列了，照旧读的话历史文件喂进去
     一个样本都攒不出，界面只会说「样本不足」，没人知道是为什么。 */
  for(let i=1;i<dates.length;i++){
    const mapY=sceneMap(scene,dates[i-1]), mapT=sceneMap(scene,dates[i]);
    for(const src of Object.keys(mapT)) for(const metric of Object.keys(mapT[src])){
      if(!(metric in DEPS)) continue;
      const d=dodOf(mapT,mapY,src,metric); if(d==null) continue;
      /* key 要带**两个**日期：不同文件里同一期的「上一期」未必相同
         （某份报表缺了中间一期时，相邻对就跨过去了）。 */
      if(seen && !once(seen, `D\u0000${dates[i]}\u0000${dates[i-1]}\u0000${src}\u0000${metric}`)) continue;
      push(into.dod, poolKey(src,metric), d);
      push(into.dodMixed, metric, d);
    }
  }
  return into;
}

/** 环比池 → 阈值。中位数 ± k·稳健σ，再和最小绝对幅度取严的那个。 */
function summarizeDod(s, k, minAbs){
  const med=median(s);
  const mad=median(s.map(x=>Math.abs(x-med)));
  const p5=percentile(s,0.05), p95=percentile(s,0.95);
  let sigma=1.4826*mad;
  if(sigma<1e-6) sigma=(p95-p5)/3.2897;   // MAD 退化时用分位差估计
  if(!(sigma>0)) sigma=0.005;              // 兜底最小散度
  return {n:s.length, median:med, mad, sigma, p5, p95,
          drop:Math.min(med - k*sigma, -minAbs),
          rise:Math.max(med + k*sigma,  minAbs)};
}
/** 水平池 → 分位数。P10/P25 给「跌破历史下沿」和「温水煮青蛙」用（B3）。 */
function summarizeLevel(s){
  return {n:s.length, p10:percentile(s,0.10), p25:percentile(s,0.25),
          p50:percentile(s,0.50), p75:percentile(s,0.75), p90:percentile(s,0.90)};
}

/**
 * 样本 → 基准线对象 + 界面用的 stats。
 *
 * 产物形状（**带 `v`**，见 pickPool 的向后兼容）：
 *   {v:2, bySrc:{'来源|指标':阈值}, mixed:{'指标':阈值},
 *         level:{'来源|指标':分位数}, levelMixed:{'指标':分位数}}
 */
function buildBaseline(samples, k, minAbs){
  const bl={v:2, bySrc:{}, mixed:{}, level:{}, noMix:{}};
  let totalN=0;

  /* ---- 哪些「来源×指标」不许混池 ----
     混池的前提是这些来源在这个指标上可比。实测 54 条里有 8 条差 10pt 以上，
     最极端的差 67pt（某来源 31.85% vs 混池 98.94%）—— 对这种拿混池的阈值去卡，
     报出来的每一条都是误报。判不了可比性（样本不足）的也不许混，
     刚上线的来源恰恰最不该用别人的阈值。 */
  const mixMed={};
  for(const [m, arr] of Object.entries(samples.levelMixed)) if(arr.length) mixMed[m]=median(arr);
  for(const src of ALLOWED_SOURCES) for(const m of ALL_METRICS){
    const key=poolKey(src,m);
    if(!samples.dod[key] && !samples.level[key]) continue;   // 这个来源压根没有这个指标
    const own=samples.level[key]||[];
    if(own.length<MIX_MIN_SAMPLES){ bl.noMix[key]={why:'样本不足以判断可比性', n:own.length}; continue; }
    if(mixMed[m]==null) continue;
    const o=median(own), gap=Math.abs(o-mixMed[m]);
    if(gap>MIX_MAX_GAP) bl.noMix[key]={why:'水平和其他来源差太远', own:o, mix:mixMed[m], gap, n:own.length};
  }
  for(const [key, s] of Object.entries(samples.dod)){
    if(s.length>=POOL_MIN_SRC) bl.bySrc[key]=summarizeDod(s,k,minAbs);
  }
  for(const [m, s] of Object.entries(samples.dodMixed)){
    if(s.length>=POOL_MIN_MIXED){ bl.mixed[m]=summarizeDod(s,k,minAbs); totalN+=s.length; }
  }
  for(const [key, s] of Object.entries(samples.level)){
    if(s.length>=LEVEL_MIN_N) bl.level[key]=summarizeLevel(s);
  }
  /* ⚠️ **水平没有混池这一级**，故意的。环比混池勉强说得过去（各来源的变化幅度
     量纲相近），绝对水平不行 —— 拿真实报表实测，混池那版每天都会报
     「某来源 · 业务校验通过率 本期 29.70% 低于混池 P10 31.88%」，
     而那个 P10 是另外两个来源的水平；这个来源那几期本来就在 30% 上下，
     在**它自己的**分布里 29.70% 完全正常。这是误报，不是那个指标有问题。
     所以这里只有 bl.level（按来源分的），没有 bl.levelMixed。 */

  // 界面：一行一个指标（混池那份），外加「几个来源有自己的池」和水平池情况
  const stats=[];
  for(const m of ALL_METRICS){
    const isF=FRICTION_METRICS.includes(m);
    const mixSamples=samples.dodMixed[m];
    const own=ALLOWED_SOURCES.filter(src=>bl.bySrc[poolKey(src,m)]).length;
    const ownLvl=ALLOWED_SOURCES.filter(src=>bl.level[poolKey(src,m)]).length;
    // 展示用：这个指标全网大概什么水平（**只作参考，不参与判断**）
    const ref=samples.levelMixed[m];
    const lvl=(ref && ref.length>=LEVEL_MIN_N) ? summarizeLevel(ref) : null;
    const noMix=ALLOWED_SOURCES.filter(src=>bl.noMix[poolKey(src,m)]);
    const base={m, isF, own, ownLvl, srcTotal:ALLOWED_SOURCES.length,
                lvl, lvlN:ref?ref.length:0, noMix};
    if(!bl.mixed[m]){ stats.push({...base, n:mixSamples?mixSamples.length:0, insufficient:true}); continue; }
    stats.push({...base, ...bl.mixed[m]});
  }
  return {bl, stats, totalN};
}

async function computeBaseline(files, k, minAbs){
  const samples=emptySamples();
  for(const f of files){
    const buf=await f.arrayBuffer();
    const wb=XLSX.read(buf,{cellDates:true});
    if(!wb.SheetNames.includes('场景维度')) continue;
    let scene; try{ scene=loadScene(wb); }catch(e){ continue; }
    collectSamples(scene, samples);
  }
  const {bl, stats, totalN}=buildBaseline(samples, k, minAbs);
  return {bl, stats, totalN, fileCount:files.length, samples};
}

/** 该指标在没有基准线时会退回到的层级阈值（用于对照展示）。 */
function levelFallback(m,isF){
  if(isF) return `+${(LEVEL_THRESHOLDS.friction_rise*100).toFixed(1)}%`;
  const d=METRIC_DEPTH[m]!=null?METRIC_DEPTH[m]:0;
  return `${(LEVEL_THRESHOLDS[d]*100).toFixed(1)}%`;
}
/** 「几个来源用自己的池」那一格。B4 要求界面上能看出当前这条走的是哪一级。 */
function tierCell(own, total){
  if(own>=total) return `<span class="bl-tier own">${own}/${total} 全部本来源</span>`;
  if(own>0)      return `<span class="bl-tier mix">${own}/${total} 本来源，其余混池</span>`;
  return `<span class="bl-tier mix">全部混池</span>`;
}
function renderBaseline(res){
  state.baselineMeta=res;
  const rows=res.stats.map(x=>{
    if(x.insufficient){
      return `<tr class="bl-insuf"><td class="l">${esc(x.m)}</td><td>${x.n}</td>`
           + `<td colspan="7">样本不足（&lt;${POOL_MIN_MIXED}），沿用固定阈值 ${levelFallback(x.m,x.isF)}</td></tr>`;
    }
    const band=`${(x.p5*100).toFixed(2)}% ~ ${(x.p95*100).toFixed(2)}%`;
    const rec = x.isF ? `≥ ${(x.rise*100).toFixed(2)}%` : `≤ ${(x.drop*100).toFixed(2)}%`;
    const recCls = x.isF?'rise':'drop';
    /* 水平那一列写的是**这个指标全网的参考分位**，不是判据本身 ——
       判据只用「该来源自己」的池（见 pickLevelPool）。列头也这么写，
       不然会有人拿这个数去解释某条水平信号，然后发现对不上。 */
    const lvl = x.lvl
      ? `${(x.lvl.p10*100).toFixed(1)}% / ${(x.lvl.p50*100).toFixed(1)}%`
      : `<span class="hint">样本不足</span>`;
    return `<tr>
      <td class="l">${esc(x.m)}${x.isF?' <span class="hint">(摩擦类)</span>':''}</td>
      <td>${x.n}</td>
      <td class="l">${tierCell(x.own, x.srcTotal)}</td>
      <td>${(x.median*100).toFixed(2)}%</td>
      <td>${(x.sigma*100).toFixed(2)}%</td>
      <td class="bl-band">${band}</td>
      <td class="bl-rec ${recCls}">${rec}</td>
      <td>${x.ownLvl}/${x.srcTotal} · ${lvl}</td>
      <td class="l">${x.noMix.length
        ? `<span class="bl-tier nomix" title="这些来源在这个指标上和其他来源水平差太远（或样本不足以判断），混池阈值对它们是错的 —— 直接走层级兜底">${esc(x.noMix.join('、'))}</span>`
        : '<span class="hint">—</span>'}</td>
    </tr>`;
  }).join('');
  $('#baselineResult').innerHTML = `<div class="tbl-scroll" style="margin-top:10px"><table class="dtl">
    <thead><tr><th class="l">指标</th><th>样本数</th><th class="l">环比用哪级</th><th>历史中位数</th>
      <th>稳健σ(1.4826·MAD)</th><th>P5~P95</th><th>建议告警阈值</th>
      <th title="有自己水平池的来源数 · 以及该指标全网的 P10/中位（仅参考，判据只用本来源池）">水平池 · 全网P10/中位</th>
      <th class="l" title="和其他来源水平差太远、不参与混池的来源">不许混池</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    <div class="hint" style="margin-top:8px">周期 <b>${PERIOD}</b> · 来自 ${res.fileCount} 个文件、共 ${res.totalN} 个历史${P().dod}样本。摩擦类看「涨破上界」，其余看「跌破下界」。</div>
    <div class="hint" style="margin-top:4px">环比三级回退：<b>本来源池</b>（≥${POOL_MIN_SRC} 个样本）→ <b>混池</b>（≥${POOL_MIN_MIXED}）→ <b>层级兜底</b>。
      分池是为了准（小来源的噪声不该抬高大来源的阈值），混池是为了有（周报/月报按来源分池样本常常不够）。<br>
      ⚠️ <b>混池不是无条件的</b>：某来源在某指标上和其他来源水平差 ${(MIX_MAX_GAP*100).toFixed(0)}pt 以上
      （或水平样本不足 ${MIX_MIN_SAMPLES} 个、判断不了），就<b>跳过混池直接走层级兜底</b> ——
      混池的前提是这些来源可比，不可比时那个阈值报出来的每一条都是误报。<br>
      水平信号（跌破 P10 / 连续低于 P25）<b>只用本来源自己的池，没有混池这一级</b> ——
      同一个指标各来源的绝对水平能差几十 pt，混算会让常年低位的那家天天上榜。</div>`;
  const valid=res.stats.filter(x=>!x.insufficient).length;
  $('#blCnt').textContent = valid ? `${PERIOD} · 已算 ${valid} 个指标` : `${PERIOD} · 样本不足`;
}

/**
 * 在一串存档日期里**均匀取样** N 个，**永远含最新那一份**（B11）。
 *
 * 为什么不是「取最近 N 份」：报表是滚动窗口，每份带最近若干期，连着两天的存档
 * 重叠得厉害。取最近 12 份日报 ≈ 19 个不同期次；均匀取样 12 份能覆盖上百个。
 * 去重（见 emptySamples）保证重叠不会让 n 说谎，均匀取样保证同样的等待时间
 * 换到更多信息。
 *
 * @param dates 倒序（接口就是这么给的）
 */
function spreadPick(dates, n){
  const a=[...(dates||[])];
  if(a.length<=n) return a;
  const out=[a[0]];                                  // 最新那份一定要
  const step=(a.length-1)/(n-1);
  for(let i=1;i<n;i++) out.push(a[Math.round(i*step)]);
  return [...new Set(out)];
}

/** 把本机存档取回来当成 File 用。computeBaseline 只调 `.arrayBuffer()`，Blob 就够。 */
async function fetchArchives(dates, onProgress){
  const files=[];
  for(let i=0;i<dates.length;i++){
    const d=dates[i];
    if(onProgress) onProgress(i, dates.length, d);
    const r=await fetch(`/api/inbox/file/conversion/${d}`);
    if(!r.ok) continue;                              // 少一份不该让整批失败
    const b=await r.blob();
    b.name=`存档 ${d}`;                               // 只为出错时说得清是哪一份
    files.push(b);
  }
  return files;
}

$('#blArchive').addEventListener('click', async ()=>{
  const st=$('#blStatus');
  const k=parseFloat($('#blK').value)||3, minAbs=(parseFloat($('#blMin').value)||1)/100;
  st.className='status'; st.textContent='正在读本机存档清单…';
  try{
    const r=await fetch('/api/inbox/dates/conversion');
    const j=await r.json();
    const all=(j&&j.dates)||[];
    if(!all.length){
      st.className='status err';
      st.textContent='本机还没有存档。邮箱自动化每天会把报表落到 data/inbox/conversion/，'
                    +'也可以在首页点「立即收取」先取一次。';
      return;
    }
    const pick=spreadPick(all, ARCHIVE_MAX_FILES);
    const files=await fetchArchives(pick, (i,n,d)=>{
      st.textContent=`正在读第 ${i+1}/${n} 份存档（${d}）…`;
    });
    if(!files.length){ st.className='status err'; st.textContent='存档一份都没取回来。'; return; }
    st.textContent=`正在解析 ${files.length} 份存档…`;
    const res=await computeBaseline(files, k, minAbs);
    state.baseline=res.bl;
    renderBaseline(res);
    saveBaseline();
    /* 说清「取了几份、覆盖多少期次」—— 存档重叠时这两个数差得很远，
       不写出来的话人会以为 12 份就只有 12 个样本。 */
    const periods=Math.max(0, ...Object.values(res.samples.level).map(a=>a.length));
    st.className='status ok';
    st.textContent=`✅ 已用本机存档算好：存档共 ${all.length} 份，均匀取了 ${files.length} 份，`
                  +`去重后每个「来源×指标」最多 ${periods} 个期次。勾选下面那项即可应用。`;
    if($('#blUse').checked){ state.baselineActive=true; run(); }
  }catch(err){
    console.error(err);
    st.className='status err'; st.textContent='用本机存档计算失败：'+(err.message||err);
  }
});

$('#blCompute').addEventListener('click', async ()=>{
  const files=[...$('#blFiles').files];
  if(!files.length){ $('#blStatus').className='status err'; $('#blStatus').textContent='请先选择历史日报文件（可多选）。'; return; }
  const k=parseFloat($('#blK').value)||3, minAbs=(parseFloat($('#blMin').value)||1)/100;
  $('#blStatus').className='status'; $('#blStatus').textContent='正在读取历史文件并计算…';
  try{
    const res=await computeBaseline(files,k,minAbs);
    state.baseline=res.bl;
    renderBaseline(res);
    saveBaseline();
    $('#blStatus').className='status ok';
    $('#blStatus').textContent='✅ 基准线已计算。勾选「使用基准线阈值探测」即可应用。';
    if($('#blUse').checked){ state.baselineActive=true; run(); }
  }catch(err){
    console.error(err);
    $('#blStatus').className='status err'; $('#blStatus').textContent='计算失败：'+(err.message||err);
  }
});
$('#blUse').addEventListener('change', e=>{
  if(e.target.checked && !state.baseline){ e.target.checked=false; $('#blStatus').className='status err'; $('#blStatus').textContent='请先「计算基准线」。'; return; }
  state.baselineActive=e.target.checked;
  saveBaseline();
  if(state.wb) run();
});
$('#blExport').addEventListener('click', ()=>{
  if(!state.baseline){ alert('请先计算基准线。'); return; }
  download(`baseline_${PERIOD}.json`, JSON.stringify({period:PERIOD,
    k:parseFloat($('#blK').value)||3, minAbs:(parseFloat($('#blMin').value)||1)/100,
    baseline:state.baseline},null,2));
});
$('#blImport').addEventListener('change', async e=>{
  const f=e.target.files[0]; if(!f) return;
  try{
    const j=JSON.parse(await f.text());
    if(j.period && j.period!==PERIOD &&
       !confirm(`该文件是「${j.period}」的基准线，当前周期是「${PERIOD}」。\n不同周期的波动尺度不同，混用会误报。仍要导入吗？`)){
      e.target.value=''; return;
    }
    state.baseline=j.baseline||j;
    if(j.k) $('#blK').value=j.k;
    if(j.minAbs!=null) $('#blMin').value=(j.minAbs*100);
    $('#baselineResult').innerHTML=`<div class="hint" style="margin-top:10px">已导入 ${Object.keys(state.baseline).length} 个指标的基准线${j.period?`（来源周期：${j.period}）`:''}。</div>`;
    $('#blCnt').textContent=`${PERIOD} · 已导入`;
    saveBaseline();
    $('#blStatus').className='status ok'; $('#blStatus').textContent='✅ 已导入基准线。';
    if($('#blUse').checked){ state.baselineActive=true; if(state.wb) run(); }
  }catch(err){ $('#blStatus').className='status err'; $('#blStatus').textContent='导入失败：'+(err.message||err); }
});

/* 基准线按周期隔离：周环比的正常波动天然大于日环比，混用必然误报。 */
const blKey = p => 'crm_baseline_'+(p||PERIOD);
function saveBaseline(){
  try{ localStorage.setItem(blKey(), JSON.stringify({
    period:PERIOD, baseline:state.baseline, active:state.baselineActive,
    k:parseFloat($('#blK').value)||3, minAbs:(parseFloat($('#blMin').value)||1)/100
  })); }catch(e){}
}
/** 切换周期时调用：载入该周期自己的基准线（没有就清空）。 */
function loadBaselineForPeriod(){
  state.baseline=null; state.baselineActive=false;
  const use=$('#blUse'); if(use) use.checked=false;
  let j=null;
  try{ j=JSON.parse(localStorage.getItem(blKey())||'null'); }catch(e){}
  if(j&&j.baseline){
    state.baseline=j.baseline;
    if(j.k) $('#blK').value=j.k;
    if(j.minAbs!=null) $('#blMin').value=(j.minAbs*100);
    if(j.active){ state.baselineActive=true; if(use) use.checked=true; }
    $('#blCnt').textContent=`${PERIOD} · 已恢复 ${Object.keys(state.baseline).length} 个指标`;
    $('#baselineResult').innerHTML=`<div class="hint" style="margin-top:10px">已从本机恢复 <b>${PERIOD}</b> 的基准线（${Object.keys(state.baseline).length} 个指标）。可重新计算刷新。</div>`;
  }else{
    $('#blCnt').textContent=`${PERIOD} · 未计算`;
    $('#baselineResult').innerHTML=`<div class="hint" style="margin-top:10px">当前周期（<b>${PERIOD}</b>）尚无基准线。上传历史${P().unit}报文件后点「计算基准线」。</div>`;
    $('#blStatus').textContent='';
  }
}
loadBaselineForPeriod();


export { buildBaseline, collectSamples, computeBaseline, emptySamples, loadBaselineForPeriod, percentile, poolKey, spreadPick, summarizeDod, summarizeLevel };
