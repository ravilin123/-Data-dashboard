/* 商户流失（Q5）：通道异常、今日命中、掉量名单、沉默名单、生命周期、老板周报。不放大盘（交易概览已经有）。
   改自工作台 static/js/churn/render.js —— 去掉日期下拉和筛选条；「谁在跟」那列**不出现**（飞书回读的，离线拿不到）。
   口径全走同步来的 churn/analyze.js（标签、分组、门槛都是它的）。 */
import { esc } from '../../static/js/shared/dom.js';
import { DROP_TYPES, GW_META, HIT_LABEL, HIT_TONE, dropHits, firstTier, fmtDays, fmtMoney, fmtPct,
         groupByMerchant, incidentLabel, ownerLabel, silentSites, summary } from '../../static/js/churn/analyze.js';

function tags(s) {
  const out = [];
  if (s.eligible) out.push('<span class="tag on" title="最近 30 天滚动 TPV 排进前 N，有资格推">前 N</span>');
  if (s.sporadic) out.push(`<span class="tag" title="30 天里只出过 ${s.active30} 天单，它的沉默不值钱">零星型 · 30 天出 ${s.active30} 天</span>`);
  if (s.uncertain) out.push('<span class="tag warn" title="台账在它最后一次出单之后有缺口，天数算不准，不跃迁">台账缺口</span>');
  if (s.recovered_on) out.push(`<span class="tag good">已恢复 ${esc(String(s.recovered_on).slice(5))}</span>`);
  const gw = GW_META[s.gw];
  if (gw && (s.silent_days || 0) > 0) out.push(`<span class="tag ${gw.tone}" title="${esc(gw.tip)}">${esc(s.gw)}</span>`);
  if ((s.incident || []).length) out.push(`<span class="tag crit" title="同一网关今天多家一起掉 —— 先看通道，别先去催商户">通道异常 · ${esc(s.incident.join('、'))}</span>`);
  return out.join(' ');
}

const retireNote = () => `<div class="warnbox">⚠ <b>这份名单里混着「主动清退」的商户，我们拆不开。</b>
  风控没有关停清单可对，工作台只能看到「它停止交易了」，看不到「是我们停的」。照着名单找人之前，自己确认一下这一家是不是我们主动停的。</div>`;

function header(state) {
  const sm = summary(state);
  const st = state.settings || {};
  const gap = sm.gap ? `<div class="warnbox">台账缺 ${sm.gap} 天（${esc((state.gap || []).slice(0, 5).join('、'))}${sm.gap > 5 ? '…' : ''}）—— 缺口横在最后出单日之后的站点不跃迁，${sm.uncertain} 个站点标了「台账缺口」。</div>` : '';
  const gw = state.gateway || {};
  const gwbox = (gw.has_today === false)
    ? `<div class="warnbox">这天没有网关台账${gw.latest ? `（最近一份是 ${esc(gw.latest)}）` : ''} —— 沉默的站点一律标「网关数据缺」，不猜；通道异常这一块也算不了。</div>` : '';
  return `<section class="card">
    <div class="lead">今日命中 <b>${sm.hits}</b>（前 ${esc(String(st.top_n ?? 30))} 内 <b>${sm.eligible}</b>）· 沉默中的站点 <b>${sm.silent}</b> / 跟踪 ${sm.sites} 个</div>
    <p class="hint">沉默满 ${esc((st.silence_days || [2, 7, 30]).join(' / '))} 天各推一次；日环比 ≤ ${esc(fmtPct(st.drop_push ?? -0.7))} 推、≤ ${esc(fmtPct(st.drop_page ?? -0.5))} 只在页面。
    「谁在跟」是 BD 在飞书多维表格里填的，这张离线页拿不到 —— 跟进状态去工作台的商户流失页看。</p>
  </section>${gap}${gwbox}`;
}

function incidents(state) {
  const inc = state.incidents || [];
  if (!inc.length) return '';
  const st = state.settings || {};
  const items = inc.map(g => `<li><b>${esc(incidentLabel(g))}</b>
    <span class="sub">${esc((g.uids || []).length)} 个用户ID：${esc((g.uids || []).slice(0, 6).join('、'))}${(g.uids || []).length > 6 ? '…' : ''}</span></li>`).join('');
  return `<section class="card"><h2 class="crit">通道异常 <span class="cnt">${inc.length}</span></h2><ul class="inc">${items}</ul>
    <p class="hint">同一网关当天有 ≥ ${esc(String(st.gateway_incident_min ?? 3))} 家排名前 ${esc(String(st.gateway_incident_top_n ?? 50))} 的商户一起掉就算这一条。
    下面名单里带「通道异常」标签的就是受影响的那几条：<b>先查通道，别先去催商户</b>。</p></section>`;
}

const asof = (s, state) => (s.tpv_asof && state && s.tpv_asof !== state.date) ? `<div class="sub">截至 ${esc(String(s.tpv_asof).slice(5))}</div>` : '';

function hitRow(h, state) {
  const tone = HIT_TONE[h.type] || '';
  const extra = h.drop ? `${esc(fmtPct(h.drop.ratio))}（前一日 ${esc(fmtMoney(h.drop.base))}）`
    : h.type.startsWith('沉默') ? `最后出单 ${esc(String(h.last_active || '').slice(5))} · 已 ${h.silent_days} 天` : '';
  return `<tr class="${h.eligible ? '' : 'dim'}">
    <td><span class="pill ${tone}">${esc(HIT_LABEL[h.type] || h.type)}</span></td>
    <td class="m"><b>${esc(h['商户名称'] || '')}</b><div class="sub">${esc(h['站点'] || '')}</div></td>
    <td>${esc(ownerLabel(h))}</td><td class="n">${esc(fmtMoney(h.tpv30))}${asof(h, state)}</td><td class="sub">${extra}</td><td>${tags(h)}</td></tr>`;
}

function hits(state) {
  const hs = state.hits || [];
  if (!hs.length) return `<section class="card"><h2>今日命中</h2><p class="hint">这一天没有跃迁：没人刚沉默、没人刚掉量。</p></section>`;
  return `<section class="card"><h2>今日命中 <span class="cnt">${hs.length}</span></h2>
    <div class="scroll"><table class="tbl"><thead><tr><th>类型</th><th>商户 / 站点</th><th>直签人</th><th class="n">30 天 TPV</th><th>说明</th><th>标签</th></tr></thead>
    <tbody>${hs.map(h => hitRow(h, state)).join('')}</tbody></table></div>
    <p class="hint">灰掉的行没有推送资格（不在前 N），只在这里和多维表格里。</p></section>`;
}

function drops(state) {
  const groups = DROP_TYPES.map(t => [t, dropHits(state, t)]).filter(([, xs]) => xs.length);
  if (!groups.length) return `<section class="card"><h2>掉量名单</h2><p class="hint">这一天没有掉量：没人跌破门槛，也没有正在观察的掉量回来。</p></section>`;
  const body = groups.map(([t, xs]) => `<tbody class="grp">
      <tr class="gh"><th colspan="6"><span class="pill ${HIT_TONE[t] || ''}">${esc(HIT_LABEL[t] || t)}</span>
        <span class="sub">${xs.length} 条${t === '掉量关闭' ? ' · 两天内回到了掉量前水平，已自动关闭' : ''}</span></th></tr>
      ${xs.map(h => `<tr class="${h.eligible ? '' : 'dim'}">
        <td class="m"><b>${esc(h['商户名称'] || '')}</b><div class="sub">${esc(h['站点'] || '')}</div></td>
        <td>${esc(ownerLabel(h))}</td><td class="n">${esc(fmtPct((h.drop || {}).ratio))}</td>
        <td class="n sub">前一日 ${esc(fmtMoney((h.drop || {}).base))}</td><td class="n">${esc(fmtMoney(h.tpv30))}</td><td>${tags(h)}</td></tr>`).join('')}
    </tbody>`).join('');
  return `<section class="card"><h2>掉量名单 <span class="cnt">${groups.reduce((n, g) => n + g[1].length, 0)}</span></h2>
    <div class="scroll"><table class="tbl"><thead><tr><th>商户 / 站点</th><th>直签人</th><th class="n">较前日</th><th class="n">基数</th><th class="n">30 天 TPV</th><th>标签</th></tr></thead>${body}</table></div>
    <p class="hint">推送档会进群和 BD 私聊，页面档只在页面和多维表格里。开着的掉量两天内回到掉量前 80% 会<b>自动关闭</b>（上面单列）。灰掉的行没有推送资格。</p></section>`;
}

function siteRow(s, state) {
  const lvl = s.silence_level ? '已推过「' + (HIT_LABEL['沉默' + s.silence_level] || s.silence_level + ' 天') + '」' : '还没到推送档';
  return `<tr><td class="sub">${esc(s['站点'] || '')}</td><td class="n"><b>${s.silent_days}</b> 天</td>
    <td class="sub">最后出单 ${esc(String(s.last_active || '').slice(5))} · ${lvl}</td>
    <td class="n">${esc(fmtMoney(s.tpv30))}${asof(s, state)}</td><td class="n">${s.active30}</td><td>${tags(s)}</td></tr>`;
}

function silent(state) {
  const tier = firstTier(state);
  const groups = groupByMerchant(silentSites(state.sites, tier));
  if (!groups.length) return `<section class="card"><h2>沉默名单</h2><p class="hint">没有沉默满 ${tier} 天的站点。</p>${retireNote()}</section>`;
  const body = groups.map(g => `<tbody class="grp">
      <tr class="gh"><th colspan="6"><b>${esc(g.name || g.uid)}</b> <span class="sub">${esc(g.uid)} · ${esc(ownerLabel(g.sites[0]))} · ${g.sites.length} 个站点 · 30 天 ${esc(fmtMoney(g.tpv30))}</span></th></tr>
      ${g.sites.map(x => siteRow(x, state)).join('')}</tbody>`).join('');
  return `<section class="card"><h2>沉默名单 <span class="cnt">${groups.length} 家 · ${groups.reduce((n, g) => n + g.sites.length, 0)} 个站点</span></h2>
    <div class="scroll"><table class="tbl"><thead><tr><th>站点</th><th class="n">沉默</th><th>状态</th><th class="n">30 天 TPV</th><th class="n">30 天活跃天数</th><th>标签</th></tr></thead>${body}</table></div>
    <p class="hint">按商户分组、按 30 天滚动 TPV 降序。同一商户的站点各算各的。网关标签来自站外网关报表，它只有用户ID、没有站点，所以「其他通道仍有交易」是<b>商户级</b>的。</p>
    ${retireNote()}</section>`;
}

function funnel(f) {
  if (!f || !f.ok) return `<section class="card"><h2>生命周期</h2><p class="hint">${esc((f && f.reason) || '算不出来')}</p></section>`;
  const top = (f.levels[0] || {}).sites || 0;
  const bars = f.levels.map(l => {
    const w = top ? Math.max(1, Math.round(l.sites / top * 100)) : 0;
    return `<tr><td>${esc(l.name)}</td><td class="n"><b>${l.merchants}</b> 家</td><td class="n sub">${l.sites} 个站点</td>
      <td class="bar"><span class="track"><i style="width:${w}%"></i></span></td><td class="n sub">${top ? Math.round(l.sites / top * 100) : 0}%</td></tr>`;
  }).join('');
  const steps = f.steps.map(x => {
    const drop = [x.no_end && `${x.no_end} 行还没走到`, x.no_start && `${x.no_start} 行起点缺`, x.negative && `${x.negative} 行终点早于起点`].filter(Boolean).join(' · ');
    return `<tr><td>${esc(x.from)} → ${esc(x.to)}</td><td class="n"><b>${esc(fmtDays(x.median))}</b></td>
      <td class="n sub">75% ${esc(fmtDays(x.p75))} · 90% ${esc(fmtDays(x.p90))}</td><td class="n sub">样本 ${x.n}</td><td class="sub">${esc(drop || '没有排除的行')}</td></tr>`;
  }).join('');
  const stuck = f.stuck.map(x => `<tr><td>${esc(x.name)}</td><td class="n"><b>${x.merchants}</b> 家</td><td class="n sub">${x.sites} 个站点</td>
    <td class="n">已等 <b>${esc(fmtDays(x.median))}</b></td><td class="sub">${esc(x.note)}</td></tr>`).join('');
  const unc = f.uncovered && f.uncovered.sites
    ? `<div class="warnbox">有 ${f.uncovered.sites} 个站点出过首单、但流失台账里还没有它 —— 它们<b>没算进「稳定出单」</b>。</div>` : '';
  return `<section class="card"><h2>生命周期 <span class="cnt">注册 → 开通 → 首单 → 稳定出单 → 沉默</span></h2>${unc}
    <div class="scroll"><table class="tbl"><thead><tr><th>到这一级</th><th class="n">家数</th><th class="n">站点</th><th>相对注册</th><th class="n">占比</th></tr></thead><tbody>${bars}</tbody></table></div>
    <h3 class="sub2">每段花多久</h3>
    <div class="scroll"><table class="tbl"><thead><tr><th>这一段</th><th class="n">中位</th><th class="n">分位</th><th class="n">样本</th><th>排除了哪些行</th></tr></thead><tbody>${steps}</tbody></table></div>
    <h3 class="sub2">还卡在路上的</h3>
    <div class="scroll"><table class="tbl"><thead><tr><th>卡在哪</th><th class="n">家数</th><th class="n">站点</th><th class="n">已等多久</th><th>说明</th></tr></thead><tbody>${stuck}</tbody></table></div>
    <p class="hint">⚠ 这张表一律 <b>${esc(f.ruler)}</b>；出单监控那六列耗时是小时 · 不含节假日，<b>两边不可比</b>。算不出来的写「算不出」，不写 0。
    前三级来自出单监控 ${esc(f.order_monitor_date || '')} 那份报表，后两级来自流失状态 ${esc(f.state_date || '—')}。</p></section>`;
}

function weekly(w) {
  if (!w || !w.ok) return `<section class="card"><h2>老板周报</h2><p class="hint">${esc((w && w.reason) || '算不出来')}</p></section>`;
  const num = (v, s) => `<div class="wk"><div class="tl">${esc(s)}</div><div class="v">${esc(v == null ? '算不出' : fmtMoney(v))}</div></div>`;
  return `<section class="card"><h2>老板周报 <span class="cnt">${esc(w.cur || '')}</span></h2>
    <div class="wks">
      ${num(w.lost.tpv, `上周还在、这周一笔没有（${w.lost.merchants} 家）`)}
      ${num(w.risk.tpv, w.risk.ok === false ? `在途风险：${w.risk.reason || '算不出来'}` : `在途风险（${w.risk.merchants} 家新进沉默满 ${w.risk.tier} 天）`)}
      ${num(w.drop.tpv, `周掉量少了（${w.drop.merchants} 家，还在出单）`)}
    </div>
    <p class="hint">三个数<b>不该相加</b>：第一个是已经走了的，第二个还没掉完，第三个还在出单。报表的周是<b>周五 → 周四</b>。</p>
    <details open><summary>发出去的原文（私聊老板 + 抄送运营群，两边一个字不差）</summary><pre class="wkt">${esc(w.text || '')}</pre></details></section>`;
}

function renderChurn(sec, b) {
  const st = b.state;
  sec.querySelector('.body').innerHTML = header(st) + incidents(st) + hits(st) + drops(st) + silent(st) + funnel(b.funnel) + weekly(b.weekly);
}

export { renderChurn };
