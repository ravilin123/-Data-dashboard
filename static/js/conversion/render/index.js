import { analyze } from '../analyze.js';
import { P, PERIOD } from '../config.js';
import { refreshRecInfo, updateFsSubject } from '../feishu.js';
import { distinctRootCauses, rootCauseCount } from '../funnel.js';
import { syncDateSel } from '../main.js';
import { renderBroadcast, renderChain, renderReport } from './broadcast.js';
import { fillDetailFilters } from './detail.js';
import { renderTopMerchants } from './merchants.js';
import { renderLevel } from './level.js';
import { renderPoRate } from './po_rate.js';
import { renderTrend } from './trend.js';
import { orderedSources, renderBlocks, renderOverview, renderSourceStory } from './overview.js';
import { state } from '../store.js';
import { $, esc } from '../../shared/dom.js';
import { num, pct, ptFmt } from '../util.js';

/* ============================================================
   8. 主流程 + 渲染
   ============================================================ */

/**
 * 某周期可用的统计日期，倒序。
 * 取自 Dataset 的 dates —— 那一份是从**商户维度**推出来的，和 buildMerged 用的是同一份，
 * 否则会出现「下拉里有这个日期、真去算却抛数据不足」。
 */
function periodDates(ds, period){
  return (ds && ds.dates && ds.dates[period||PERIOD]) || [];
}

/** 解析当前周期该用哪一对日期：选过就用选的，没选或选的已失效就回到最新两期 */
function resolvePair(ds, period){
  const dates=periodDates(ds, period);
  if(dates.length<2) return {dates, t:dates[0]||null, y:dates[1]||null};
  const s=state.sel[period];
  let t=s&&s.t, y=s&&s.y;
  if(!dates.includes(t) || !dates.includes(y) || t===y || t<y){ t=dates[0]; y=dates[1]; }
  return {dates, t, y};
}

/* 主流程只剩「取哪对日期 → 交给 analyze → 渲染」三件事。
   读报表在 readReport（dataset.js），算分析在 analyze（analyze.js）。 */
function run(){
  const pair=resolvePair(state.ds, PERIOD);
  /* 基准线从 store 取，但由这里**传进去** —— 分析层自己不读 store（T3）。 */
  state.data=analyze(state.ds, {period:PERIOD, tDate:pair.t, yDate:pair.y,
                                baseline:state.baseline, baselineActive:state.baselineActive,
                                /* 出单监控的名单（B15）。取的动作在 main.js 那边异步做，
                                   还没取到就是 null —— 名单照样出，只是少几个标签。
                                   取回来之后 main.js 会再调一次 run() 补上。 */
                                orderMonitor:state.om});
  render();
  if(typeof syncDateSel==='function') syncDateSel();
  // 解析完不发任何东西，只更新「本次要发的内容」那行；发不发由人点按钮
  if(typeof updateFsSubject==='function') updateFsSubject();
}

function render(){
  const d=state.data;
  const totPO = d.mergedTotal.reduce((s,r)=>s+num(r['PO单数_今']),0)
              || d.mergedSite.reduce((s,r)=>s+num(r['PO单数_今']),0);
  const P_=P();
  const nTot=d.alarmTotal.length, nSite=d.alarmSite.length, n=nTot+nSite;
  const rootTot=rootCauseCount(d.alarmTotal), rootSite=rootCauseCount(d.alarmSite);
  const nRoot=distinctRootCauses(d.alarmTotal,d.alarmSite);   // 跨维度去重
  // 与根因数一致地跨维度去重：同一 来源+指标 在合计行与站点会各出现一次
  const unexplained=new Set([...d.alarmTotal,...d.alarmSite]
    .filter(a=>a._role==='未解释').map(a=>a['来源']+'|'+a['异常指标'])).size;

  // 各来源的成功率各出一张卡（此前只取第一个来源，另一个被丢掉）
  const srcs=orderedSources(d.stages);
  const srcKpis = srcs.map(s=>{
    const f=d.stages[s];
    return kpi(`${s} 成功率`, pct(f.overallT),
      f.dOverall!=null?`${P_.dod} ${ptFmt(f.dOverall)}`:'无上期可比',
      f.dOverall!=null?(f.dOverall<0?'critical':'good'):'');
  });

  // KPIs
  $('#kpis').innerHTML = [
    kpi(P_.dl, d.tDate, `对比 ${P_.prev} ${d.yDate}`),
    ...(srcKpis.length?srcKpis:[kpi('业务单支付成功率','—','大盘数据不足')]),
    kpi('根因数', nRoot, `共 ${n} 项告警，已去重下游回声与跨维度重复`, nRoot>0?'critical':'good'),
    kpi(`${P_.span}总 PO`, Math.round(totPO).toLocaleString(), `${srcs.length} 个来源合计`),
  ].join('');

  /* summary banner
     告警的环比现在按选中的这对日期现算（第四轮 A1），不再读源表那一列，
     所以 n===0 就是真的没触发。但有两件事仍要说出来，否则又变成静默：
       · noBase   —— 上期没有可比值的行（首期数据 / 新上线来源），压根没参与探测
       · dodAudit —— 两期相邻时现算值和源表那列对不上，多半是上游口径变了 */
  const notes=[];
  if(d.noBase) notes.push(`<span class="hint">${d.noBase} 项指标上期无可比值（首期或新上线来源），未参与探测。</span>`);
  if(d.dodAudit && d.dodAudit.mismatch) notes.push(
    `<span style="color:var(--warn-on,#8a5a10)">⚠️ 上游环比口径可能变了：相邻两期里有 `
    + `<b>${d.dodAudit.mismatch}</b>/${d.dodAudit.compared} 项，源表「环比」列和按当期值现算的对不上`
    + `（例：${esc(d.dodAudit.samples.map(s=>`${s['来源']}·${s['指标']} 现算 ${s['现算']} vs 源表 ${s['源表']}`).slice(0,2).join('；'))}）。`
    + `告警走的是现算值，不受影响。</span>`);
  /* 来源覆盖校验（B8）。**只在缺口远超常态时才出现** —— 缺口每期都有
     （实测 0.2%~1.6%），天天报「差 0.4%」是噪声不是信息。
     真正要抓的是跳变：上游新增一个没进白名单的场景，缺口会一下子到两位数。 */
  const cov=d.coverage;
  if(cov && cov.alert){
    const ex=(cov.extras||[]).map(x=>`${esc(x.src)} ${pct(x.ratio)}`).join('、');
    notes.push(`<span style="color:var(--warn-on,#8a5a10)">⚠️ 上游可能新增了场景，白名单没跟上：`
      + `<b>${esc(P_.key)}汇总行</b>比报表里所有子场景之和多 <b>${Math.round(cov.gap).toLocaleString()}</b> 单`
      + `（占 ${pct(cov.gapRatio)}）—— 也就是有这么多量<b>连报表都没单独列行</b>。`
      + `本期分析覆盖了大盘的 ${pct(cov.analyzedRatio)}`
      + (ex?`，另有${ex}是白名单故意排除的（另一条业务线）`:'')
      + `。请核对 <code>ALLOWED_SOURCES</code>。</span>`);
  }
  const noteHtml = notes.length ? `<div class="hint" style="margin-top:6px">${notes.join('<br>')}</div>` : '';

  $('#summary').innerHTML = (n===0
    ? `<div class="banner ok">✅ 大盘平稳，无指标触发告警阈值。</div>`
    : `<div class="banner warn">⚠️ 触发异常：合计行 <b>${nTot}</b> 项 / 站点 <b>${nSite}</b> 项，去重后 <b>${nRoot}</b> 个根因`
      + (unexplained?`，其中 <b>${unexplained}</b> 项为大环节异常但子指标未能解释（需人工排查）`:'')
      + `。到「异常明细」按来源 → 环节 → 商户逐层展开。</div>`) + noteHtml;

  // 导航角标
  const badge=$('#tabBadge');
  if(nRoot>0){ badge.hidden=false; badge.textContent=nRoot; } else badge.hidden=true;

  $('#totCnt').textContent = nTot?`${nTot} 项（根因 ${rootTot}）`:'无';
  $('#siteCnt').textContent = nSite?`${nSite} 项（根因 ${rootSite}）`:'无';
  renderOverview();
  renderPoRate();
  renderLevel();
  renderTrend();
  $('#prioDrillWrap').innerHTML = renderSourceStory(d.srcStory);
  $('#totalBlocks').innerHTML = renderBlocks(d.drillTotal, d.alarmTotal, false);
  $('#siteBlocks').innerHTML  = renderBlocks(d.drillSite,  d.alarmSite,  true);
  renderTopMerchants();
  fillDetailFilters();

  renderBroadcast();
  renderChain();
  renderReport();
  $('#reportCnt').textContent = `${d.wide.length} 行`;
  if(typeof refreshRecInfo==='function') refreshRecInfo();
}

function kpi(k,v,d,cls){
  return `<div class="kpi"><div class="k">${esc(k)}</div><div class="v ${cls||''}">${esc(String(v))}</div><div class="d">${esc(d||'')}</div></div>`;
}


export { periodDates, resolvePair, run };
