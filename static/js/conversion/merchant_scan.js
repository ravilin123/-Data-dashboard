import { ALL_METRICS, MERCHANT_OVERALL_TOL, MERCHANT_SCAN_MIN_ORDERS, OVERALL_METRIC } from './config.js';
import { funnelStages } from './funnel.js';
import { num } from './util.js';

/* ============================================================
   商户级独立探测（B6）

   `detect()` 的循环是「遍历场景行 → 触发阈值 → 才拆商户」。于是一家中等商户
   彻底崩了、但被来源大盘稀释到没触发阈值，**它在异常明细里完全不存在** ——
   而商户维度 sheet 里，每个商户 × 每个指标的两期值本来就全在。

   实测日报 2026-09-06：整体少成 ≥5 单的商户 13 家，现有异常明细覆盖不到其中一半；
   最大的一条 `vigorbuy.com 环节4 少成 55 单` 在明细里根本查不到（场景级 4. 没触发，
   只有子指标 4.1 触发了）。

   这里不看场景是否告警，直接把**每个商户当成一个小漏斗**算一遍。

   两个关键取舍：

   1. **头条数字用源表自己的「业务单支付成功率」，不用累乘值。**
      累乘值（`funnelStages` 的 overallT）和源表那列在 97 家里有 2 家对不上 ——
      都是个位数单量的脏数据（某个环节是 0 但源表整体不是 0）。
      源表那列是每家自己的权威值，而且「低于同行」那段（B14）用的也是它，
      两处口径一致。累乘只用来**归因**（主因是哪个环节）。
      对不上时 `mismatch` 标出来 —— 归因不可全信，别让人照着去查错环节。

   2. **按整体算，不按单个指标算。** 逐指标算会父子重复计数：
      `4. 网关通过率` 少成 55 单和 `4.1 非3DS网关通过率` 少成 47 单是同一批单。
      `funnelStages` 那套 telescoping 分解是无残差的（各环节贡献相加恰等于整体变动），
      按它来既不重复也不遗漏。
   ============================================================ */

/** 一行 merged → funnelStages 要的两张 {指标:比率} 表。 */
function ratesOf(row){
  const mT={}, mY={};
  for(const m of ALL_METRICS){
    if(!(m+'_今' in row)) continue;
    mT[m]=num(row[m+'_今']); mY[m]=num(row[m+'_昨']);
  }
  return [mT, mY];
}

/**
 * @param mergedSite analyze() 里那份两期都在的商户
 * @param hasSite    站点级还是用户ID合计级
 * @returns {rows, noBase} rows 按「少成单量」从多到少排，noBase = 算不出整体变动的家数
 */
function scanMerchants(mergedSite, hasSite){
  const rows=[]; let noBase=0;
  for(const row of (mergedSite||[])){
    const po=Math.round(num(row['PO单数_今']));
    if(!po) continue;
    const [mT,mY]=ratesOf(row);
    const f=funnelStages(mT,mY);

    const sheetT=num(row[OVERALL_METRIC+'_今']), sheetY=num(row[OVERALL_METRIC+'_昨']);
    const haveSheet=Number.isFinite(sheetT)&&Number.isFinite(sheetY)&&(sheetT>0||sheetY>0);
    const rateT = haveSheet ? sheetT : f.overallT;
    const rateY = haveSheet ? sheetY : f.overallY;
    if(rateT==null || rateY==null || !Number.isFinite(rateT) || !Number.isFinite(rateY)){
      noBase++; continue;          // 算不出整体变动的要计数报上去，不能静默
    }

    // 归因：贡献最负的那个大环节。整体在涨时不给主因 —— 「涨的主因」不是这块要回答的
    const ss=(f.stages||[]).filter(s=>s.contrib!=null);
    const worst=ss.length ? ss.slice().sort((a,b)=>a.contrib-b.contrib)[0] : null;
    const d=rateT-rateY;

    rows.push({
      来源:row['来源'], 用户ID:String(row['用户ID']||''), 商户名称:String(row['商户名称']||''),
      站点: hasSite ? String(row['站点']||'') : '(用户ID合计)',
      PO单数:po, 本期:rateT, 上期:rateY, 变动:d,
      影响单量: Math.round(d*po),
      主因: (d<0 && worst && worst.contrib<0) ? worst : null,
      /* 累乘值和源表对不上 → 归因（主因是哪个环节）不可全信。
         头条数字不受影响（它用的是源表那列），但要在卡片上标出来。 */
      口径存疑: !!(haveSheet && f.overallT!=null && Math.abs(f.overallT-sheetT)>MERCHANT_OVERALL_TOL),
    });
  }
  rows.sort((a,b)=>a['影响单量']-b['影响单量']);     // 少成最多的在最前
  return {rows, noBase};
}

/**
 * 值得进「重点关注商户」的那批：整体少成 ≥ MERCHANT_SCAN_MIN_ORDERS 单。
 *
 * 门槛用**单量**不用 pt：一家 20 单的商户掉 30pt 也就少成 6 单，
 * 而 5000 单的掉 2pt 是 100 单 —— 后者才是该先看的。
 */
function topLosers(scan, limit){
  return (scan && scan.rows || [])
    .filter(x=>x['影响单量'] <= -MERCHANT_SCAN_MIN_ORDERS)
    .slice(0, limit||6);
}

export { ratesOf, scanMerchants, topLosers };
