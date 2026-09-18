import { LEVEL_MIN_ORDERS, P } from '../config.js';
import { state } from '../store.js';
import { $, esc } from '../../shared/dom.js';
import { pct, ptFmt } from '../util.js';
import { colorOf, lineChart, wire } from './trend.js';

/* ---------- 支付前 / 支付中 两段拆账（B7） ----------

   算法和口径在 ../po_rate.js 顶部。这里只管怎么画。

   ⚠️ **不给这两段配新的分类色。** 页面上已经有一套按来源固定的三支色（--s1/--s2/--s3），
   跑 dataviz 校验时试过再加一对色相：紫色和趋势图的蓝在 deutan 下 ΔE 0.5、
   青色和绿在正常视觉下 ΔE 9.5，两条都是硬 FAIL —— 同屏两套分类色本来就挤不下。
   所以这两段用**同一支品牌色 + 45° 斜纹**区分（斜纹是 dataviz 指定的 CVD/打印兜底），
   再加段内直标和表格视图。深色模式下同色相两档也塞不进明度带，斜纹这条路两套主题通吃。

   ⚠️ 条的**总长按总流失单量**在各来源之间可比（不是各画各的 100%）——
   不然「一家 4056 单流失」和「一家 300 单流失」会画成一样长。 */

const nf = n => (n == null || !Number.isFinite(n)) ? '—' : Math.round(n).toLocaleString('en-US');

/**
 * 环比小标签。掉得多是坏事（流失涨了），所以**流失单量**的涨用 critical、跌用 good；
 * 比率那边反过来。
 *
 * ⚠️ 单量差小于 `LEVEL_MIN_ORDERS`(5) 不显示 —— 和水平信号同一个门槛。
 * 实测 Element 支付前流失本期 0 单、上期 1 单，不挡的话卡片上会挂个「−1单」，
 * 读的人得停下来想一秒才发现那是噪声。整页都按单量说话，门槛也该是同一个。
 */
function dTag(v, {lossLike = false} = {}){
  if(v == null || !Number.isFinite(v)) return '';
  if(lossLike ? Math.abs(v) < LEVEL_MIN_ORDERS : Math.round(v * 10000) === 0) return '';
  const bad = lossLike ? v > 0 : v < 0;
  const txt = lossLike ? `${v > 0 ? '+' : '−'}${nf(Math.abs(v))}单` : ptFmt(v);
  return ` <b style="color:${bad ? 'var(--critical)' : 'var(--good)'}">${esc(txt)}</b>`;
}

function row(r, maxLoss){
  const w = maxLoss > 0 ? Math.max(1.5, r.总流失 / maxLoss * 100) : 0;
  const pre = r.总流失 > 0 ? r.支付前流失 / r.总流失 * 100 : 0;
  /* 段内直标看它在**整条轨道**里占多宽，不是在本行里占多少 ——
     本行只有最宽那行的四成时，「占本行 25%」还是塞不下字，标签会被切掉半截。
     标签只是加速读图，数字在右边那列一个不少，塞不下就不标。 */
  const seg = (cls, n, label) => n <= 0 ? '' :
    `<i class="${cls}" style="width:${(cls === 'pre' ? pre : 100 - pre).toFixed(2)}%"
        title="${esc(label)} ${nf(n)} 单">${maxLoss > 0 && n / maxLoss > 0.12 ? esc(label) + ' ' + nf(n) : ''}</i>`;
  return `<div class="pr-row">
    <div class="pr-name">▌${esc(r.来源)}${r.mismatch ? ' <span class="tag-warn" title="源表两行的分子对不上，两段的劈法不可全信">口径存疑</span>' : ''}
      <span class="hint">PO ${nf(r.PO单数)} 单 · 流失 ${nf(r.总流失)} 单</span></div>
    <div class="pr-track" style="width:${w.toFixed(2)}%">${seg('pre', r.支付前流失, '支付前')}${seg('mid', r.支付中流失, '支付中')}</div>
    <div class="pr-val">支付前 <b>${nf(r.支付前流失)}</b>${dTag(r.Δ支付前流失, {lossLike: true})}
      · 支付中 <b>${nf(r.支付中流失)}</b>${dTag(r.Δ支付中流失, {lossLike: true})}<br>
      <span class="hint">业务单 ${pct(r.业务单率)}${dTag(r.Δ业务单率)} · 支付单 ${r.支付单率 == null ? '—' : pct(r.支付单率)}${dTag(r.Δ支付单率)}</span></div>
  </div>`;
}

function tableView(g){
  const head = ['来源', 'PO单数', '支付单数', '成功单数', '业务单成功率', '支付单成功率', '支付前流失', '支付中流失', '支付前占比'];
  const line = r => `<tr><td>${esc(r.来源)}</td><td>${nf(r.PO单数)}</td><td>${nf(r.支付单数)}</td><td>${nf(r.成功单数)}</td>
    <td>${pct(r.业务单率)}</td><td>${r.支付单率 == null ? '—' : pct(r.支付单率)}</td>
    <td>${nf(r.支付前流失)}</td><td>${nf(r.支付中流失)}</td><td>${r.支付前占比 == null ? '—' : pct(r.支付前占比)}</td></tr>`;
  return `<details class="tr-tbl"><summary class="hint">数据表（每个数这里都拿得到，不只靠条形和 tooltip）</summary>
    <div class="tbl-wrap"><table><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${g.rows.map(line).join('')}${g.total ? line(g.total) : ''}</tbody></table></div></details>`;
}

function renderPoRate(){
  const host = $('#porate'); if(!host) return;
  const d = state.data, g = d && d.poRate;
  if(!g || !g.ok){ host.innerHTML = ''; return; }
  const P_ = P();
  const t = g.total;
  const maxLoss = Math.max(...g.rows.map(r => r.总流失), 1);

  /* 走势画「支付前占比」，不画绝对单量 —— 单量随大盘涨落，这里要看的是**结构**
     有没有在变。复用趋势图那套 lineChart：同一个来源、同一支颜色，别再写一份。 */
  const tr = g.trend || {dates: [], sources: [], series: {}, partial: []};
  // lineChart 吃的是趋势图那套形状：series[key][src] + partial + po
  const tShape = {...tr, series: {pre: tr.series}, po: {}};
  const chart = tr.dates.length >= 2
    ? lineChart(tShape, 'pre', {w: 1160, h: 220, padL: 52, padR: 150, padT: 14, padB: 30,
                                dots: true, endLabels: true, title: '支付前流失占比'})
    : null;

  host.innerHTML = `<div class="card pad">
    <div class="sec-title">支付前 / 支付中 · 这一期的流失卡在哪一半
      <span class="hint" style="font-weight:400">两条成功率的分子相同（都是成功单），差别只在分母 ——
        所以总流失能精确劈成两段，没有残差</span></div>
    <div class="pr-lead">合计 <b>${nf(t.PO单数)}</b> 单里流失 <b>${nf(t.总流失)}</b> 单：
      支付前 <b>${nf(t.支付前流失)}</b> 单（${t.支付前占比 == null ? '—' : pct(t.支付前占比)}）${dTag(t.Δ支付前流失, {lossLike: true})}
      · 支付中 <b>${nf(t.支付中流失)}</b> 单${dTag(t.Δ支付中流失, {lossLike: true})}</div>
    <div class="pr-legend">
      <span><i class="pre"></i>支付前流失 = PO单数 − 支付单数（人根本没走到支付：校验1 / Paynow点击）</span>
      <span><i class="mid"></i>支付中流失 = 支付单数 − 成功单（走到了没成：业务校验 / 风控 / 3DS / 网关）</span>
    </div>
    ${g.rows.map(r => row(r, maxLoss)).join('')}
    <div class="hint" style="margin-top:8px">这两段的排查方向完全不同：支付前要去看收银台和前端，支付中要去看风控网关。
      而只看「业务单支付成功率」一个数字，两种情况长得一模一样。</div>
    ${g.partial ? `<div class="hint" style="color:var(--warning)">⚠️ 本期还没走完（窗口结束日晚于报表里最新的日报），
      <b>单量环比一律不给</b> —— 拿走了几天的量去比上一个完整周期，差出来的全是「还没发生」。
      比率环比不受影响，照常显示。</div>` : ''}
    ${g.noData.length ? `<div class="hint" style="color:var(--warning)">⚠️ ${esc(g.noData.join('、'))}
      本期缺「支付单支付成功率」行，<b>没有按 0 计</b> —— 当 0 会算出「全部卡在支付前」这种假结论。</div>` : ''}
    ${chart ? `<div class="tr-legend" style="margin-top:12px">${tr.sources.map(s =>
        `<span class="tr-lg"><i style="background:${colorOf(s)}"></i>${esc(s)}</span>`).join('')}</div>
      <div class="tr-box" data-key="pre">
        <div class="tr-cap">支付前流失占比 · 最近 ${tr.dates.length} 期${esc(P_.key)}
          <span class="hint"> · 看占比不看单量：单量随大盘涨落，这里问的是结构有没有在变${
            tr.partial.some(Boolean) ? '。带 * 的那一期还没走完，虚线段就是它' : ''}</span></div>
        ${chart.html}<div class="tr-tip" hidden></div>
      </div>` : ''}
    ${tableView(g)}
  </div>`;

  if(chart){
    const box = host.querySelector('.tr-box');
    if(box) wire(box, chart.geom, tShape, pct);
  }
}

export { renderPoRate };
