/* 交易概览（Q4）：三个数 + 趋势 + 构成（四维）+ 前 N 排名。日 / 周 / 月 × 交易额 / 笔数六份都嵌好了，开关只是换一份画。
   改自工作台 static/js/trade/render.js —— 去掉下钻按钮和「流失状态」链接，别的写法一样；口径全走同步来的 trade/analyze.js。 */
import { esc } from '../../static/js/shared/dom.js';
import { COMP_DIMS, METRICS, METRIC_KEY, PERIODS, checkNote, dod, gapNote, lineGeom, money, num,
         partialCount, pct, share, stackGeom } from '../../static/js/trade/analyze.js';

const W = 720, H = 150;
const fmt = (v, metric) => (v == null ? '—' : metric === 'orders' ? num(v) : money(v));

function controls(st, avail) {
  const seg = (name, items, cur) => `<span class="pseg">${items.map(([v, t]) =>
    `<label class="${v === cur ? 'on' : ''}"><input type="radio" name="${name}" value="${esc(v)}" ${v === cur ? 'checked' : ''}>${esc(t)}</label>`).join('')}</span>`;
  return `<div class="ctlrow">
    ${seg('period', PERIODS.filter(p => avail.includes(p)).map(p => [p, p]), st.period)}
    ${seg('metric', METRICS, st.metric)}
    <span class="hint">周是<b>周五 → 周四</b>，跟报表一致 —— 不是周一到周日。最近 ${st.n} 期。</span>
  </div>`;
}

function kpis(d) {
  const cur = d.current || {};
  const r = dod(d.series, d.metric);
  const note = gapNote(cur);
  const tiles = [
    ['本期' + (d.metric === 'orders' ? '交易笔数' : '交易额'), fmt(cur.ok ? cur[METRIC_KEY[d.metric]] : null, d.metric),
     r == null ? '较上期 —' : `较上期 ${pct(r)}`],
    ['有交易的站点', cur.ok ? num(cur.sites) : '—', `${(d.top || []).length} 家进了排名`],
    ['这一期', esc(cur.label || d.date), note || `${cur.span || 1} 天都有台账`],
  ];
  return `<div class="tiles">${tiles.map(([t, v, s]) =>
    `<div class="tile"><div class="tl">${esc(t)}</div><div class="v">${esc(v)}</div><div class="sub">${esc(s)}</div></div>`).join('')}</div>`;
}

function trend(d) {
  const key = METRIC_KEY[d.metric];
  const g = lineGeom(d.series, W, H, key);
  const n = Math.max(1, (d.series || []).length - 1);
  const paths = g.segs.filter(s => s.length).map(seg => seg.length === 1
    ? `<circle class="dot" cx="${seg[0].cx.toFixed(1)}" cy="${seg[0].cy.toFixed(1)}" r="3.5"/>`
    : `<path class="ln" d="M${seg.map(p => `${p.cx.toFixed(1)},${p.cy.toFixed(1)}`).join('L')}"/>`).join('');
  const parts = (d.series || []).map((p, i) => ({ p, i }))
    .filter(x => x.p.ok && (x.p.gap || []).length)
    .map(x => `<circle class="dot part" cx="${g.x(x.i).toFixed(1)}" cy="${g.y(x.p[key]).toFixed(1)}" r="4"/>
      <text class="vl part" x="${g.x(x.i).toFixed(1)}" y="${(g.y(x.p[key]) + 15).toFixed(1)}"
        text-anchor="${x.i > (d.series.length - 1) / 2 ? 'end' : 'start'}">${x.p.days}/${x.p.span} 天</text>`).join('');
  const marks = [g.peak, g.last].filter(Boolean)
    .filter((p, i, a) => a.findIndex(x => x.key === p.key) === i)
    .map(p => `<circle class="dot" cx="${g.x(d.series.indexOf(p)).toFixed(1)}" cy="${g.y(p[key]).toFixed(1)}" r="3.5"/>
      <text class="vl" x="${g.x(d.series.indexOf(p)).toFixed(1)}" y="${(g.y(p[key]) - 8).toFixed(1)}" text-anchor="middle">${esc(fmt(p[key], d.metric))}</text>`).join('');
  const grid = g.ticks.map(t => `<line class="gd" x1="0" x2="${W}" y1="${g.y(t).toFixed(1)}" y2="${g.y(t).toFixed(1)}"/>
    <text class="ax" x="-6" y="${(g.y(t) + 3.5).toFixed(1)}" text-anchor="end">${esc(fmt(t, d.metric))}</text>`).join('');
  const hits = (d.series || []).map((p, i) => `<rect class="hit" x="${(g.x(i) - W / n / 2).toFixed(1)}" y="-10" width="${(W / n).toFixed(1)}" height="${H + 20}"
    data-lb="${esc(p.label)}" data-v="${esc(fmt(p.ok ? p[key] : null, d.metric))}" data-s="${esc(p.ok ? num(p.sites) : '—')}" data-g="${esc(gapNote(p))}"/>`).join('');
  const part = partialCount(d.series);
  return `<section class="card"><h2>趋势 <span class="cnt">最近 ${d.n} 期 · ${esc(d.metric === 'orders' ? '交易笔数' : '交易额')}</span></h2>
    <div class="chart"><svg viewBox="-56 -16 ${W + 72} ${H + 46}" role="img" aria-label="最近 ${d.n} 期的趋势">${grid}${paths}${marks}${parts}
      <text class="ax" x="0" y="${H + 20}">${esc((d.series[0] || {}).label || '')}</text>
      <text class="ax" x="${W}" y="${H + 20}" text-anchor="end">${esc((d.series[d.series.length - 1] || {}).label || '')}</text>
      ${hits}</svg><div class="tip" data-tip hidden></div></div>
    <p class="hint">缺台账的那期<b>断线</b>，不连过去。
    ${part ? `⚠ 有 <b>${part}</b> 期天数不全 —— 图上是<b>空心点</b>并直标了几分之几天，它们的值天然偏小，别当成「掉了」。` : ''}
    ${d.check ? esc(checkNote(d.check)) : ''}</p></section>`;
}

function comp(d) {
  const blocks = COMP_DIMS.filter(k => (d.by || {})[k] && d.by[k].length).map(k => {
    const segs = stackGeom(d.by[k]);
    const bar = segs.map(s => `<div class="sg" style="left:${s.at}%;width:${s.w}%;background:${s.color}" title="${esc(s.name)} ${esc(share(s.share))}"></div>`).join('');
    const legend = segs.map(s => `<span class="lg"><i style="background:${s.color}"></i>${esc(s.name)} <b>${esc(share(s.share))}</b></span>`).join('');
    const rows = d.by[k].map(g => `<tr><td>${esc(g.name)}</td>
      <td class="n">${esc(money(g.tpv))}</td><td class="n">${esc(num(g.orders))}</td><td class="n">${esc(num(g.sites))}</td><td class="n">${esc(share(g.share))}</td></tr>`).join('');
    return `<div class="comp"><h3 class="sub2">按${esc(k)}</h3>
      <div class="stack">${bar}</div><div class="legend">${legend}</div>
      <details><summary>表格视图</summary><div class="scroll"><table class="tbl">
        <thead><tr><th>${esc(k)}</th><th class="n">交易额</th><th class="n">笔数</th><th class="n">站点</th><th class="n">占比</th></tr></thead>
        <tbody>${rows}</tbody></table></div></details></div>`;
  }).join('');
  if (!blocks) return '';
  return `<section class="card"><h2>构成 <span class="cnt">${esc(d.current ? d.current.label : '')} · ${esc(d.metric === 'orders' ? '按笔数' : '按交易额')}</span></h2>
    <div class="comps">${blocks}</div>
    <p class="hint">超过 6 类折进「其他」。⚠ 换成「按笔数」时排序也跟着换：按金额排前 6 的和按笔数排前 6 的不是同一批。颜色分不清时看表格视图。</p></section>`;
}

function top(d) {
  if (!(d.top || []).length) return '';
  const key = METRIC_KEY[d.metric];
  const max = Math.max(1, ...d.top.map(t => t[key] || 0));
  const rows = d.top.map(t => `<tr>
    <td class="m"><b>${esc(t['商户名称'] || t['用户ID'])}</b><div class="sub">${esc(t['直签人'])} · ${t['站点数']} 个站点</div></td>
    <td class="bar"><span class="track"><i style="width:${Math.max(1, Math.round((t[key] || 0) / max * 100))}%"></i></span></td>
    <td class="n">${esc(fmt(t[key], d.metric))}</td><td class="n sub">${esc(share(t.share))}</td><td class="n">${esc(pct(t.dod))}</td></tr>`).join('');
  return `<section class="card"><h2>排名 <span class="cnt">前 ${d.top.length} 家商户</span></h2>
    <div class="scroll"><table class="tbl rank">
      <thead><tr><th>商户</th><th>相对第一名</th><th class="n">${esc(d.metric === 'orders' ? '笔数' : '交易额')}</th><th class="n">占比</th><th class="n">较上期</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <p class="hint">商户级 —— 同一商户的多个站点合起来。这一期才出现的商户「较上期」是「—」，不是 +100%。</p></section>`;
}

function renderTrade(sec, b) {
  const body = sec.querySelector('.body');
  const avail = (b.order || PERIODS).filter(p => b.periods[p]);
  const st = { period: avail.includes('日') ? '日' : avail[0], metric: 'tpv', n: b.n || 12 };
  const paint = () => {
    const d = b.periods[st.period][st.metric];
    body.innerHTML = controls(st, avail) + (d.ok ? kpis(d) + trend(d) + comp(d) + top(d)
      : `<section class="card"><h2>交易概览</h2><p class="hint">${esc(d.reason || '这一期没有数据')}</p></section>`);
  };
  body.addEventListener('change', e => {
    const t = e.target;
    if (t && t.name === 'period') { st.period = t.value; paint(); }
    if (t && t.name === 'metric') { st.metric = t.value; paint(); }
  });
  body.addEventListener('mouseover', e => {
    const h = e.target.closest && e.target.closest('.hit');
    const tip = body.querySelector('[data-tip]');
    if (!h || !tip) return;
    tip.hidden = false;
    tip.innerHTML = `<b>${h.dataset.lb}</b><br>${h.dataset.v}<br>站点 ${h.dataset.s}` + (h.dataset.g ? `<br><span class="warn">${h.dataset.g}</span>` : '');
    const box = h.closest('.chart').getBoundingClientRect();
    const at = h.getBoundingClientRect();
    tip.style.left = Math.min(box.width - 150, Math.max(0, at.left - box.left)) + 'px';
  });
  body.addEventListener('mouseleave', e => {
    if (e.target.closest && e.target.closest('.chart') && body.querySelector('[data-tip]')) body.querySelector('[data-tip]').hidden = true;
  }, true);
  paint();
}

export { renderTrade };
