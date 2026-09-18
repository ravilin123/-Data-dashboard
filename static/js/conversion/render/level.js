import { CREEP_MIN_RUN, LEVEL_MIN_ORDERS, P } from '../config.js';
import { state } from '../store.js';
import { $, esc } from '../../shared/dom.js';
import { ordFmt, pct } from '../util.js';

/* ---------- 水平信号（B3） ----------
   和「优先排查」放在一起（都是「今天该看什么」），但**样式分开**：
   那块讲的是环比动了多少，这块讲的是绝对水平落在历史的什么位置。
   两种判据回答的问题不一样，混在一张表里读的人会以为是同一件事的两种写法。 */

const ptGap = v => (v*100).toFixed(2)+'pt';

/** 一行：谁 · 哪个指标 · 本期多少 · 参照线多少 · 差多远。 */
function row(x, kind){
  const isF=x._isF;
  const cut = isF ? (kind==='level'?'P90':'P75') : (kind==='level'?'P10':'P25');
  const run = kind==='creep'
    ? `<span class="lv-run" title="从本期往前连着数，中间断一期就停">连续 ${x['连续期数']} 期</span>` : '';
  /* 「值多少单」是这一行的重点，所以它排在最右、加粗 —— 和异常明细那边
     `对大盘 · 支付成功单` 一列同一个口径（B1/B2）。算不出的写「—」不写 0：
     真的是零，和算不出来，是两件事。 */
  const ord = x['影响单量']!=null
    ? `<b class="lv-ord" title="回到自己的历史中位水平能多成多少支付成功单">${esc(ordFmt(x['影响单量']).replace('增加 ','+'))}</b>`
    : `<span class="hint lv-ord" title="${isF?'摩擦类不算折损单量 —— 占比上升本身不损失单量':'源表这一行没给分子/分母，算不出单量'}">—</span>`;
  return `<div class="lv-row">
    <span class="lv-who">${esc(x['来源'])} <b>${esc(x['指标'])}</b>${isF?' <span class="hint">(摩擦类)</span>':''}${run}</span>
    <b class="lv-v">${pct(x['本期值'])}</b>
    <span class="hint lv-cut">历史 ${cut} ${pct(x['分位线'])}</span>
    <span class="hint lv-med">中位 ${pct(x['中位'])}</span>
    <span class="lv-gap ${isF?'up':'down'}">${isF?'高':'低'} ${ptGap(x._gap)}</span>
    ${ord}
  </div>`;
}

function renderLevel(){
  const host=$('#level'); if(!host) return;
  const r=state.data && state.data.levels;
  if(!r){ host.innerHTML=''; return; }
  const P_=P();

  /* 没基准线时**要说出来**，而且要说清去哪开 ——
     不然「今天没有水平信号」和「压根没算」在页面上长得一模一样，
     而后者会让人以为这块功能坏了或者干脆没注意到它存在。 */
  if(r.noBaseline){
    host.innerHTML=`<div class="card pad lv-card">
      <div class="sec-title">水平信号 <span class="hint" style="font-weight:400">还没启用</span></div>
      <div class="empty">这块看的是「今天这个数在历史上算什么位置」，要先有历史分布才算得出来。
        去「业务基准线」面板传几份历史${esc(P_.unit)}报、点「计算基准线」，
        再勾上「使用基准线阈值探测」。</div>
    </div>`;
    return;
  }

  const n=r.level.length + r.creep.length;
  const why=[];
  if(r.noPool) why.push(`${r.noPool} 条还没攒够本来源的历史样本`);
  if(r.flat)   why.push(`${r.flat} 条历史上就没波动过（分位数没有区分度）`);
  if(r.thin)   why.push(`${r.thin} 条折算下来不到 ${LEVEL_MIN_ORDERS} 单`);
  const tail = why.length ? `<div class="hint" style="margin-top:8px">另有 ${why.join('、')}，这些不出信号 —— 撑不住的判据不如不报。</div>` : '';

  if(!n){
    host.innerHTML=`<div class="card pad lv-card">
      <div class="sec-title">水平信号 <span class="hint" style="font-weight:400">${r.checked} 条已比对</span></div>
      <div class="banner ok">✅ 本期 ${r.checked} 条指标都在各自的历史正常范围内。</div>${tail}
    </div>`;
    return;
  }

  const sec=(list, kind, icon, title, note)=> list.length ? `<div style="margin-top:10px">
      <div class="lv-head">${icon} ${title} <span class="cnt">${list.length}</span></div>
      <div class="hint" style="margin:2px 0 4px">${note}</div>
      ${list.map(x=>row(x,kind)).join('')}
    </div>` : '';

  host.innerHTML=`<div class="card pad lv-card">
    <div class="sec-title">水平信号 <span class="hint" style="font-weight:400">环比之外的第二类判据 ——
      「今天是历史上最差的 10% 之一」和「连着几期慢慢烂」，这两种环比阈值一辈子够不上</span></div>
    ${sec(r.level, 'level', '⚠️', '跌破历史下沿',
          '本期值落在该来源该指标历史分布的 P10 之外（摩擦类是涨破 P90）。')}
    ${sec(r.creep, 'creep', '🌡️', '温水煮青蛙',
          `连续 ${CREEP_MIN_RUN} ${P().run}以上不高于历史 P25（摩擦类是不低于 P75）—— 每${P().run}跌幅都够不上阈值，累计已经很难看。`)}
    <div class="hint" style="margin-top:8px">最右一列是<b>回到自己的历史中位水平能多成多少单</b> ——
      排序按它，不按 pt（pt 跨指标不可比：<code>3.1 风控综合通过率</code> 掉 0.06pt
      和 <code>4. 网关通过率</code> 掉 0.06pt 差着几个数量级）。摩擦类和源表没给分子分母的写「—」。<br>
      参照的是<b>该来源自己</b>的历史分布，不跨来源混算 ——
      同一个指标各来源的绝对水平能差几十 pt，混在一起的分位数会让常年低位的那家天天上榜。</div>
    ${tail}
  </div>`;
}

export { renderLevel };
