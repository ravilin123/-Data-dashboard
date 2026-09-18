/* 转化率（Q7 / Q12 / Q13）：概览 + 异常明细两个面板，**渲染代码和工作台同一份** —— 直接 import 同步来的
   static/js/conversion/render/*.js，面板骨架和 CSS 是生成时从 conversion.html 原样抽的。
   嵌的是 ds（readReport 的产物）+ 三个周期的基准线；这里用同步来的 analyze.js 现算现画，切周期不用重新生成。

   不 import 的：render/index.js（它引 main.js / feishu.js，顶层就绑一堆不存在的按钮、还会 fetch）。
   index.js 的 render() 里 KPI 和 summary 那几十行在这儿照抄了一份 —— 那是界面胶水不是口径；
   其余（概览 / 明细 / 重点商户 / 水平信号 / 拆账 / 趋势）全是原函数。 */
import { P, PERIOD_ORDER, setPeriod } from '../../static/js/conversion/config.js';
import { analyze } from '../../static/js/conversion/analyze.js';
import { state } from '../../static/js/conversion/store.js';
import { distinctRootCauses, periodIncomplete, rootCauseCount } from '../../static/js/conversion/funnel.js';
import { orderedSources, renderBlocks, renderOverview, renderSourceStory } from '../../static/js/conversion/render/overview.js';
import { fillDetailFilters } from '../../static/js/conversion/render/detail.js';
import { renderTopMerchants } from '../../static/js/conversion/render/merchants.js';
import { renderLevel } from '../../static/js/conversion/render/level.js';
import { renderPoRate } from '../../static/js/conversion/render/po_rate.js';
import { renderTrend } from '../../static/js/conversion/render/trend.js';
import { num, pct, ptFmt } from '../../static/js/conversion/util.js';
import { $, esc } from '../../static/js/shared/dom.js';

const kpi = (k, v, d, cls) => `<div class="kpi"><div class="k">${esc(k)}</div><div class="v ${cls || ''}">${esc(String(v))}</div><div class="d">${esc(d || '')}</div></div>`;

/* 照 render/index.js 的 render()：KPI + summary banner + 各面板。 */
function paint() {
  const d = state.data;
  const totPO = d.mergedTotal.reduce((s, r) => s + num(r['PO单数_今']), 0) || d.mergedSite.reduce((s, r) => s + num(r['PO单数_今']), 0);
  const P_ = P();
  const nTot = d.alarmTotal.length, nSite = d.alarmSite.length, n = nTot + nSite;
  const rootTot = rootCauseCount(d.alarmTotal), rootSite = rootCauseCount(d.alarmSite);
  const nRoot = distinctRootCauses(d.alarmTotal, d.alarmSite);
  const unexplained = new Set([...d.alarmTotal, ...d.alarmSite].filter(a => a._role === '未解释').map(a => a['来源'] + '|' + a['异常指标'])).size;
  const srcs = orderedSources(d.stages);
  const srcKpis = srcs.map(s => {
    const f = d.stages[s];
    return kpi(`${s} 成功率`, pct(f.overallT), f.dOverall != null ? `${P_.dod} ${ptFmt(f.dOverall)}` : '无上期可比',
               f.dOverall != null ? (f.dOverall < 0 ? 'critical' : 'good') : '');
  });
  $('#kpis').innerHTML = [
    kpi(P_.dl, d.tDate, `对比 ${P_.prev} ${d.yDate}`),
    ...(srcKpis.length ? srcKpis : [kpi('业务单支付成功率', '—', '大盘数据不足')]),
    kpi('根因数', nRoot, `共 ${n} 项告警，已去重下游回声与跨维度重复`, nRoot > 0 ? 'critical' : 'good'),
    kpi(`${P_.span}总 PO`, Math.round(totPO).toLocaleString(), `${srcs.length} 个来源合计`),
  ].join('');

  const notes = [];
  if (d.noBase) notes.push(`<span class="hint">${d.noBase} 项指标上期无可比值（首期或新上线来源），未参与探测。</span>`);
  if (d.dodAudit && d.dodAudit.mismatch) notes.push(`<span style="color:var(--warn-on,#8a5a10)">⚠️ 上游环比口径可能变了：相邻两期里有 <b>${d.dodAudit.mismatch}</b>/${d.dodAudit.compared} 项，源表「环比」列和按当期值现算的对不上。告警走的是现算值，不受影响。</span>`);
  const cov = d.coverage;
  if (cov && cov.alert) {
    notes.push(`<span style="color:var(--warn-on,#8a5a10)">⚠️ 上游可能新增了场景，白名单没跟上：<b>${esc(P_.key)}汇总行</b>比报表里所有子场景之和多 <b>${Math.round(cov.gap).toLocaleString()}</b> 单（占 ${pct(cov.gapRatio)}）。本期分析覆盖了大盘的 ${pct(cov.analyzedRatio)}。</span>`);
  }
  const noteHtml = notes.length ? `<div class="hint" style="margin-top:6px">${notes.join('<br>')}</div>` : '';
  $('#summary').innerHTML = (n === 0
    ? '<div class="banner ok">✅ 大盘平稳，无指标触发告警阈值。</div>'
    : `<div class="banner warn">⚠️ 触发异常：合计行 <b>${nTot}</b> 项 / 站点 <b>${nSite}</b> 项，去重后 <b>${nRoot}</b> 个根因`
      + (unexplained ? `，其中 <b>${unexplained}</b> 项为大环节异常但子指标未能解释（需人工排查）` : '') + '。往下看「异常明细」按来源 → 环节 → 商户逐层展开。</div>') + noteHtml;
  $('#totCnt').textContent = nTot ? `${nTot} 项（根因 ${rootTot}）` : '无';
  $('#siteCnt').textContent = nSite ? `${nSite} 项（根因 ${rootSite}）` : '无';
  renderOverview();
  renderPoRate();
  renderLevel();
  renderTrend();
  $('#prioDrillWrap').innerHTML = renderSourceStory(d.srcStory);
  $('#totalBlocks').innerHTML = renderBlocks(d.drillTotal, d.alarmTotal, false);
  $('#siteBlocks').innerHTML = renderBlocks(d.drillSite, d.alarmSite, true);
  renderTopMerchants();
  fillDetailFilters();
}

function renderConversion(sec, b) {
  const ds = b.ds;
  const avail = PERIOD_ORDER.filter(p => ds.periods && ds.periods[p] && ds.periods[p].ok && (ds.dates[p] || []).length >= 2);
  const ctl = $('#cvCtl'), note = $('#cvNote');
  if (!avail.length) {
    ctl.innerHTML = '';
    note.innerHTML = `<div class="empty">报表 ${esc(b.file || '')} 里日报 / 周报 / 月报都不足两期，算不了环比。</div>`;
    $('#app').hidden = true;
    return;
  }
  state.ds = ds;
  state.om = b.om || null;
  let cur = avail.includes('日报') ? '日报' : avail[0];

  const run = () => {
    setPeriod(cur);
    const bl = (b.baselines || {})[cur] || null;
    state.baseline = bl;
    state.baselineActive = !!(bl && Object.keys(bl).length);
    const dates = ds.dates[cur];
    const [tDate, yDate] = dates;
    state.data = analyze(ds, { period: cur, tDate, yDate, baseline: state.baseline, baselineActive: state.baselineActive, orderMonitor: state.om });
    const latestDaily = ((ds.dates && ds.dates['日报']) || [])[0] || null;
    const partial = cur !== '日报' && periodIncomplete(tDate, latestDaily);
    ctl.innerHTML = `<span class="pseg">${PERIOD_ORDER.map(p => `<button type="button" data-period="${p}" aria-pressed="${p === cur}" ${avail.includes(p) ? '' : 'disabled'}
        title="${avail.includes(p) ? `${p}：${ds.dates[p].length} 期` : `文件中${p}不足两期`}">${esc(P().key === p ? p : p)}</button>`).join('')}</span>
      <span class="hint">本期 <b>${esc(tDate)}</b>（对比 ${esc(yDate)}）· 报表 ${esc(b.file || '')}${(b.baselineNotes || {})[cur] ? ' · ' + esc(b.baselineNotes[cur]) : ''}</span>`;
    note.innerHTML = partial
      ? `<div class="note">⚠ ${esc(cur)} <b>${esc(tDate)}</b> 还没走完（报表里最新的日报是 ${esc(latestDaily || '—')}）—— 这一期的掉量、单量环比不是结论，工作台同样的规矩：走完了才播报。</div>` : '';
    paint();
  };
  ctl.addEventListener('click', e => {
    const btn = e.target.closest('button[data-period]');
    if (!btn || btn.disabled || btn.dataset.period === cur) return;
    cur = btn.dataset.period;
    run();
  });
  run();
}

export { renderConversion };
