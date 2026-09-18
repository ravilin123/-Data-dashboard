import { state } from '../store.js';
import { $, esc } from '../../shared/dom.js';
import { ordFmt, pct, ptFmt } from '../util.js';
import { topLosers } from '../merchant_scan.js';

/* ---------- 重点关注商户：商户级独立探测，按整体少成多少单排（B6） ---------- */
/**
 * 输入从「已有的 drill 结果」换成了 `merchantScan`（B6）。
 *
 * 老做法是对 drill 做聚合 —— 而 drill 是「场景先触发阈值，才拆商户」的产物。
 * 一家中等商户彻底崩了、但被来源大盘稀释到没触发阈值，它压根不在 drill 里，
 * 聚合再怎么做也救不回来。实测周报：整体少成 ≥5 单的 21 家里，
 * **有 7 家在异常明细里一行都查不到，合计少成 139 单**。
 *
 * 换成扫全部商户之后顺带解决了两件事：
 *   · 不再父子重复计数（老做法把各指标的影响累加，而 4.2 和 4.2.2 是同一批单）
 *   · 排序回到「少成多少单」这一把尺子上，不再受「哪些场景指标恰好触发了」影响
 */
function topMerchants(scan, drill, limit){
  const inDrill=new Set((drill||[]).map(r=>r['来源']+'|'+r['用户ID']));
  return topLosers(scan, limit||6).map(x=>({
    ...x,
    key: x['来源']+'|'+x['用户ID'],
    // 明细里查不到的那批要能看出来：点卡片跳不过去，得走链路精算
    inDrill: inDrill.has(x['来源']+'|'+x['用户ID']),
  }));
}

/**
 * 卡片的严重度分档。
 *
 * 纯绝对阈值不行：不同日子的量级差太远（日报最大 102 单，周报能到 187 单）。
 * 纯相对也不行：风平浪静的一天，最大的那个哪怕只少成 6 单，也会被染成最红。
 *
 * 所以两者都要：**档位按占当天最大值的比例分**，再用绝对值封顶 ——
 * 当天最严重的也不过 20 单，那整组最多只到 warn，谁也别想标红。
 */
function sevOf(ord, max){
  if(ord < 10) return 'low';                  // 少成不到 10 单，排第几都不值得着色
  const r = ord / max;
  const tier = r>=0.6 ? 3 : r>=0.3 ? 2 : r>=0.1 ? 1 : 0;
  const cap  = max>=100 ? 3 : max>=30 ? 2 : 1;   // 当天整体不严重时的封顶
  return ['low','warn','serious','crit'][Math.min(tier, cap)];
}

function renderTopMerchants(){
  const d=state.data;
  const list=topMerchants(d.merchantScan, [...d.drillTotal, ...d.drillSite], 6);
  const host=$('#topMerchants');
  if(!list.length){ host.innerHTML=''; return; }
  /* 两种编码各做各的事：
       颜色按**绝对**严重度分档 —— 少成 6 单不该染成和 102 单一样的红
       长条按**相对**最大值 —— 一眼看出彼此差多远 */
  const ordOf=m=>-m['影响单量'];
  const max=Math.max(...list.map(ordOf), 0) || 1;
  const cards=list.map((m,i)=>{
    const sev=sevOf(ordOf(m), max);
    const w=Math.max(2, ordOf(m)/max*100).toFixed(1);
    const cause = m['主因']
      ? `主因：环节${esc(m['主因'].code)} ${esc(m['主因'].label)}（${ptFmt(m['主因'].contrib)}）`
      : '各环节都没有明显拖累 —— 可能是商户结构变化';
    /* 明细里查不到的要说出来。以前点卡片是「跳到异常明细并高亮」，
       这批跳过去是空的 —— 现在改成跳链路精算（那儿有它的完整漏斗）。 */
    const where = m.inDrill ? '点击定位到该商户的异常明细' : '异常明细里没有它（场景级没触发阈值）—— 点击看它的完整漏斗';
    const badge = m.inDrill ? '' :
      ` <span class="tag-warn" title="场景级没触发阈值，所以异常明细里没有它 —— 这正是商户级独立探测要补的那批">明细未覆盖</span>`;
    const doubt = m['口径存疑']
      ? ` <span class="tag-warn" title="各环节累乘出来的整体成功率和源表那列对不上，主因归因不可全信（头条数字用的是源表那列，不受影响）">口径存疑</span>` : '';
    return `<button class="tm" data-sev="${sev}" data-mid="${esc(m.key)}"
              data-indrill="${m.inDrill?'1':'0'}" title="${esc(where)}">
      <div class="nm"><span class="rk">${i+1}</span><span class="who">${esc(m['商户名称'])}</span>${badge}${doubt}</div>
      <div class="imp">${esc(ordFmt(m['影响单量']))}<small>整体</small></div>
      <div class="tm-bar"><i style="width:${w}%"></i></div>
      <div class="meta">${esc(m['来源'])} · PO ${Number(m['PO单数']).toLocaleString()} ·
        ${pct(m['上期'])} → ${pct(m['本期'])}</div>
      <div class="why">${cause}</div>
    </button>`;
  }).join('');
  host.innerHTML=`<div class="tm-head">🎯 重点关注商户
      <span class="cnt">按整体少成多少单排，Top ${list.length}（扫了全部 ${d.merchantScan.rows.length} 家，不看场景是否告警）</span>
    </div><div class="tm-grid">${cards}</div>`;
}

export { renderTopMerchants };
