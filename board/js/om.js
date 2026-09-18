/* 出单监控（Q6）：三落点 KPI、对账十二档、耗时（左右两栏 + 按通道）、分类九档、按分类分组的名单（折叠）、被拒站点。
   改自工作台 static/js/order_monitor/render/{recon,timing,classify}.js —— 去掉筛选和「跑一次」，可点的条子改成静态的；
   算数全走同步来的 order_monitor/analyze.js（十二档常驻、耗时的 0 分四种、通道分组都是它算的）。 */
import { esc } from '../../static/js/shared/dom.js';
import { classifyBuckets, reconcile, rejectView, timingSplit } from '../../static/js/order_monitor/analyze.js';

const SINK_CLASS = { '通知+表': '1', 仅表: '2', 丢弃: '3' };
const SINK_SHORT = { '通知+表': '看得见', 仅表: '只写表', 丢弃: '哪儿都没有' };

function hrs(v) {
  if (v == null) return '—';
  const h = Math.round(v * 100) / 100;
  if (h < 1) return `${Math.round(h * 60)} 分`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${h.toFixed(0)}h <span class="hint" style="white-space:nowrap">≈${(h / 24).toFixed(1)} 天</span>`;
}

function kpis(led) {
  const r = reconcile(led);
  const k = (label, val, sub) => `<div class="kpi"><div class="k">${esc(label)}</div><div class="v big tabnums">${val}</div><div class="d">${sub}</div></div>`;
  return `<div class="kpis">
    ${k('报表读进来', `${led.总行数}<span style="font-size:15px;font-weight:600"> 行</span>`, `${esc(led.date)} 那份`)}
    ${r.sinks.map(s => k(SINK_SHORT[s.落点], s.行数, `${s.占比}% · ${esc(s.落点)}`)).join('')}
  </div>`;
}

function recon(led) {
  const r = reconcile(led);
  const max = Math.max(...r.rows.map(x => x.行数), 1);
  const drop = r.sinks.find(s => s.落点 === '丢弃') || { 行数: 0, 占比: 0 };
  const notify = r.sinks.find(s => s.落点 === '通知+表') || { 行数: 0, 占比: 0 };
  const segs = r.sinks.map(s => {
    const w = r.total ? s.行数 / r.total * 100 : 0;
    return `<div class="seg2 a${SINK_CLASS[s.落点]}" style="flex:${s.行数} 0 0" title="${esc(s.落点)} ${s.行数} 行 · ${s.占比}%">${w >= 10 ? `${esc(SINK_SHORT[s.落点])} ${s.行数}` : ''}</div>`;
  }).join('');
  const bars = r.rows.map(x => `<div class="hbar" title="${esc(x.why)}">
      <span class="lb ${x.行数 ? '' : 'z'}">${esc(x.去向)} <span class="sk k${SINK_CLASS[x.落点] || '2'}">${esc(SINK_SHORT[x.落点] || x.落点)}</span></span>
      <span class="tk"><i class="s${SINK_CLASS[x.落点] || '2'}" style="width:${x.行数 / max * 100}%"></i></span>
      <span class="rt">${x.行数} 行 · ${x.占比}%</span></div>`).join('');
  const run = led.本次运行;
  const runLine = run ? `<div class="runline">这一份是 <b>${esc(run.mode || '?')}</b> 模式跑的${run.跑完于 ? ` · ${esc(run.跑完于)}` : ''}
      ${(run.发送 || []).map(x => `<span class="sd ${x.结果 === '成功' ? 'ok' : x.结果 === '失败' ? 'bad' : 'skip'}">${esc(x.步骤)} ${esc(x.结果)}</span>`).join('')}</div>` : '';
  return `<section class="card"><h2>对账 · 这份报表的每一行去哪了</h2>${runLine}
    <p class="hint" style="margin:0 0 10px">读进来 <b>${led.总行数}</b> 行，群通知和多维表格里加起来看得到 <b>${notify.行数}</b> 行（${notify.占比}%）；<b>${drop.行数}</b> 行（${drop.占比}%）读进来之后<b>哪儿都没有</b>。</p>
    <div class="sinkbar">${segs}</div><div class="hbars">${bars}</div>
    <div class="why"><b>十三档全部常驻，包括今天是 0 的那几档。</b>只在有数时才显示的话，「今天是 0」和「这一档我根本没在看」长得一模一样。</div></section>`;
}

function timing(led) {
  const ts = timingSplit(led);
  const maxP50 = Math.max(...ts.done.map(c => c.p50 || 0), 1);
  const left = ts.done.map(c => {
    const out = [];
    if (c.notReached) out.push(`没走到 <b>${c.notReached}</b>`);
    if (c.noCalc) out.push(`算不出 <b>${c.noCalc}</b>`);
    if (c.missing) out.push(`没这格 <b>${c.missing}</b>`);
    return `<tr><td>${esc(c.col)}<div class="hint">${esc(c.note)}</div></td><td class="n">${c.n}<span class="hint"> / ${ts.total}</span></td>
      <td class="n">${hrs(c.p50)}<div class="bar"><i style="width:${(c.p50 || 0) / maxP50 * 100}%"></i></div></td>
      <td class="n">${hrs(c.p75)}</td><td class="n">${hrs(c.max)}</td><td class="hint">${out.join(' · ') || '—'}${c.zeroDone ? `<br>秒过 <b>${c.zeroDone}</b>` : ''}</td></tr>`;
  }).join('');
  const w = ts.waiting;
  const groups = w.groups.map(g => `<div class="hbar"><span class="lb">${esc(g.stage)}</span>
      <span class="tk"><i style="width:${g.n / Math.max(w.n, 1) * 100}%"></i></span>
      <span class="rt">${g.n} 家 · 中位 ${g.p50 == null ? '—' : g.p50 + ' 天'}</span></div>`).join('');
  const top = [...w.rows].sort((a, b) => (b.等待天数 || 0) - (a.等待天数 || 0)).slice(0, 10);
  const by = ts.byChannel || [];
  const maxCa = Math.max(...by.map(c => c.审核中位 || 0), 0.01);
  const chTable = by.length <= 1 ? '' : `
    <div class="lead2" style="margin-top:16px">按建议进件通道<span class="unit">${esc(ts.unit)}</span></div>
    <div class="scroll box" style="max-height:none"><table class="tbl wide">
      <thead><tr><th>通道</th><th class="n">商户数</th><th class="n">通道审核中位</th><th class="n">P75</th><th class="n">超 24h</th><th class="n">建站→首笔中位</th><th class="n">有交易</th><th class="n">出单率</th></tr></thead>
      <tbody>${by.map(c => `<tr><td>${esc(c.channel || '（报表里没填）')}</td><td class="n">${c.n}</td>
        <td class="n">${hrs(c.审核中位)}<div class="bar"><i style="width:${(c.审核中位 || 0) / maxCa * 100}%"></i></div><div class="hint">${c.审核n} 家审完</div></td>
        <td class="n">${hrs(c.审核P75)}</td><td class="n">${c.超24h || '—'}</td><td class="n">${hrs(c.上线中位)}</td><td class="n">${c.出单}</td><td class="n">${c.出单率}%</td></tr>`).join('')}</tbody></table></div>
    <div class="why"><b>这张表里只有「通道审核」那一列是干净的因果</b>（我方的处理速度）。<b>出单率那一列别单看</b>：它同时带着选择偏差和时间偏差。</div>`;
  return `<section class="card"><h2>耗时</h2>
    <div class="two left-wide">
      <div><div class="lead2">左 · 已经走完的<span class="unit">${esc(ts.unit)}</span></div>
        <div class="scroll box"><table class="tbl wide"><thead><tr><th>列</th><th class="n">n</th><th class="n">中位</th><th class="n">P75</th><th class="n">最长</th><th>分母外</th></tr></thead><tbody>${left}</tbody></table></div></div>
      <div><div class="lead2">右 · 还在路上的<span class="unit">${esc(w.unit)}</span></div>
        <p class="hint" style="margin:0 0 8px"><b>${w.n} 家</b>还没有第一笔成功交易，左边那张表里<b>一个都看不到他们</b>。中位已经等了 <b>${w.p50 == null ? '—' : w.p50}</b> 天，最长 <b>${w.max == null ? '—' : w.max}</b> 天。</p>
        <div class="hbars" style="margin-bottom:10px;--lb-w:180px">${groups || '<div class="hint">没有还在路上的</div>'}</div>
        ${top.length ? `<div class="lead2">等最久的 ${top.length} 家</div>
        <div class="scroll box" style="max-height:270px"><table class="tbl"><thead><tr><th>商户</th><th>所属BD</th><th>卡在</th><th class="n">已等待</th></tr></thead>
          <tbody>${top.map(m => `<tr><td>${esc(m.商户名称 || '—')}<div class="hint">${esc(m.站点 || '')}</div></td><td>${esc(m.所属BD || '—')}</td><td class="hint">${esc(m.stage)}</td><td class="n">${m.等待天数 == null ? '—' : m.等待天数 + ' 天'}</td></tr>`).join('')}</tbody></table></div>` : ''}
      </div>
    </div>${chTable}
    <div class="why"><b>六列耗时直接来自报表，不自己算。</b>那一列里的 <code>0</code> 有四种意思，只有一种是真耗时 —— 靠起点和终点日期分：没走到 · 算不出 · 真的秒过。<b>左右不是同一把尺子</b>：左边是「小时 · 不含节假日」，右边是自然日（含周末）。</div></section>`;
}

const listOf = rows => {
  const showDays = rows.some(m => m.开通天数 != null), showTpv = rows.some(m => m.累计TPV_USD);
  return `<div class="scroll box"><table class="tbl"><thead><tr><th>商户</th><th>站点</th><th>所属BD</th><th>去向</th>${showDays ? '<th class="n">开通天数</th>' : ''}${showTpv ? '<th class="n">累计TPV</th>' : ''}</tr></thead>
    <tbody>${rows.map(m => `<tr><td>${esc(m.商户名称 || '—')}<div class="hint tabnums">${esc(m.用户ID)}</div></td><td>${esc(m.站点 || '—')}</td><td>${esc(m.所属BD || '—')}</td>
      <td class="hint">${esc(m.去向)}${m.备注 ? `<br>${esc(m.备注)}` : ''}</td>${showDays ? `<td class="n">${m.开通天数 == null ? '—' : m.开通天数}</td>` : ''}
      ${showTpv ? `<td class="n">${m.累计TPV_USD ? '$' + Number(m.累计TPV_USD).toLocaleString() : '—'}</td>` : ''}</tr>`).join('')}</tbody></table></div>`;
};

function classify(led) {
  const c = classifyBuckets(led);
  const max = Math.max(...c.buckets.map(b => b.n), 1);
  const bars = c.buckets.map(b => `<div class="hbar" title="${esc(b.note || '')}"><span class="lb ${b.n ? '' : 'z'}">${esc(b.name)}</span>
      <span class="tk"><i style="width:${b.n / max * 100}%"></i></span><span class="rt">${b.n} 家</span></div>`).join('');
  // 按分类分组的名单（折叠）：九档各一组，进了档的行不再进「其余」；其余的按去向分
  const inBucket = new Set();
  const groups = c.buckets.filter(b => b.n).map(b => { b.rows.forEach(r => inBucket.add(r)); return { name: b.name, rows: b.rows, note: String(b.note || '').replace(/\*\*/g, '') }; });
  const rest = (led.明细 || []).filter(r => !inBucket.has(r));
  const byDisp = new Map();
  for (const r of rest) { if (!byDisp.has(r.去向)) byDisp.set(r.去向, []); byDisp.get(r.去向).push(r); }
  for (const d of (led.去向顺序 || [])) if (byDisp.has(d)) groups.push({ name: `${d}（不进上面九档）`, rows: byDisp.get(d), note: (led.去向说明 || {})[d] || '' });
  const lists = groups.map(g => `<details class="grpd"><summary>${esc(g.name)}<span class="rt">${g.rows.length} 家${g.note ? ' · ' + esc(g.note) : ''}</span></summary>${listOf(g.rows)}</details>`).join('');
  return `<section class="card"><h2>分类</h2><div class="hbars">${bars}</div>
    <div class="why"><b>「待激活」是要发出去的一档</b>（单独一条消息、按周发），<b>「开通&gt;180天」只入表不播报</b> —— 可以不处理，不能看不见。</div>
    <h3 class="sub2">名单 · 按分类分组（点开看）</h3>${lists}</section>`;
}

function reject(led) {
  const r = rejectView(led);
  if (!r.ok) return `<section class="card"><h2>被拒站点</h2><div class="critbox">这一块<b>读不到</b>，不是「今天一条都没有」：${esc(r.error)}</div></section>`;
  const list = rows => `<div class="scroll box" style="max-height:300px"><table class="tbl"><thead><tr><th>商户</th><th>站点</th><th>所属BD</th><th>提交</th></tr></thead>
    <tbody>${rows.slice(0, 300).map(x => `<tr><td>${esc(x.商户名称 || '—')}<div class="hint tabnums">${esc(x.用户ID || '')}</div></td><td>${esc(x.站点 || '—')}</td><td>${esc(x.所属BD || '—')}</td><td class="hint">${esc(x.站点_商户提交时间 || '')}</td></tr>`).join('')}</tbody></table></div>`;
  return `<section class="card"><h2>被拒站点 · 报表第三张 sheet</h2>
    <p class="hint" style="margin:0 0 12px">「站点审核失败」是被拒站点的<b>累计</b>名单，共 <b>${r.n}</b> 行。</p>
    <div class="two">
      <div><div class="lead2">当日新增</div>
        ${r.newN == null ? `<div class="warnbox">${esc(r.compareNote || '没有可比的前一天')} —— <b>没有「新增」这个数</b>。这里不写 0：0 的意思是「今天一个新的都没有」，那是另一回事。</div>`
          : `<div class="kpi" style="margin-bottom:8px"><div class="k">${esc(r.compareNote)}</div><div class="v big tabnums">${r.newN}<span style="font-size:15px;font-weight:600"> 个</span></div></div>
             ${r.newRows.length ? list(r.newRows) : '<div class="warnbox">今天<b>一个新的被拒站点都没有</b>（和前一天那份台账按（用户ID｜站点）做集合差得出的，不是没读到）。</div>'}`}</div>
      <div><div class="lead2">没有所属 BD 的</div>
        <div class="kpi" style="margin-bottom:8px"><div class="k">被拒了也没有人跟进</div><div class="v big tabnums">${r.noBdN}<span style="font-size:15px;font-weight:600"> 行</span></div><div class="d">占 ${r.n ? Math.round(r.noBdN / r.n * 100) : 0}%</div></div>
        ${r.noBd.length ? list(r.noBd) : '<div class="hint">都有 BD</div>'}</div>
    </div></section>`;
}

function renderOm(sec, b) {
  const led = b.ledger;
  sec.querySelector('.body').innerHTML = kpis(led) + recon(led) + timing(led) + classify(led) + reject(led);
}

export { renderOm };
