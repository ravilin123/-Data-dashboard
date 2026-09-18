/* readReport 的全量模式：给 merchant 漏斗用。
 *
 *     node tests/dataset_all.mjs
 *
 * 为什么要这个模式：默认的 Dataset 是给转化率分析用的，会按 ALLOWED_SOURCES 过滤
 * 并且只收日/周/月报。实测真实报表 商户维度 7273 行，默认模式只剩 1985 行 ——
 * 丢掉「合计」来源 3587 行（单商户跨来源汇总）、FLYLINK 784 行、整个季报 3212 行。
 * 而 merchant 的漏斗页这些都能选。所以加一个全量模式，两边共用同一套解析和量纲，
 * 但各取所需。**默认行为必须一个字不变** —— 下面 [1] 就是钉这条的。
 */
import { MODULES, installBrowserStubs, makeChecker } from './_harness.mjs';
const XLSX = installBrowserStubs();
const check = makeChecker();
const { readReport } = await import(MODULES + 'dataset.js');

/* 造一份含「该被默认模式滤掉」的东西的报表：
   来源里有 FLYLINK快捷订单 和 合计，时间类别里有季报。 */
const METRICS = [['4. 网关通过率','网关通过率'], ['2. 业务校验通过率','业务校验通过率']];
const SRCS = ['独立站API', 'FLYLINK快捷订单', '合计'];
const CATS = ['日报', '季报'];
const DATES = {'日报':['2026-09-05','2026-09-06'], '季报':['2026-Q2','2026-Q3']};

function makeWb(){
  const scene = [['时间类别','统计日期','来源','类型','当期值','分子/分母']];
  for (const cat of CATS) for (const d of DATES[cat]) for (const s of SRCS)
    for (const [, raw] of METRICS) scene.push([cat, d, s, raw, 0.80, '8000/10000']);

  /* 商户维度的比率故意写成**数值 84.57**（源表里出现过这种形态）。
     merchant 原来那套换算对数值分支原样用、不除 100 也不封顶，
     于是 84.57 一路走到显示层变成 8457%。走 toRate 应当得到 0.8457。 */
  const mHead = ['时间类别','统计日期','用户ID','站点','来源','PO单数', ...METRICS.map(m=>m[1])];
  const merch = [mHead];
  for (const cat of CATS) for (const d of DATES[cat]) for (const s of SRCS)
    for (const site of ['https://a.example.com', '合计'])
      merch.push([cat, d, 'U1', site, s, 500, 84.57, 84.57]);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(scene), '场景维度');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(merch), '商户维度');
  return wb;
}
const wb = makeWb();
const srcOf = rows => [...new Set(rows.map(o => o['来源']))].sort();

console.log('[1] 默认模式行为一个字不变');
{
  const ds = readReport(wb);
  check('只留 ALLOWED_SOURCES', JSON.stringify(srcOf(ds.merchantSite['日报'])) === '["独立站API"]',
        JSON.stringify(srcOf(ds.merchantSite['日报'])));
  check('季报不在默认模式里', ds.scene['季报'] === undefined, Object.keys(ds.scene));
  check('默认模式不带 merchantAll', ds.merchantAll === undefined, Object.keys(ds));
}

console.log('[2] allSources：不按 ALLOWED_SOURCES 过滤');
{
  const ds = readReport(wb, {allSources:true});
  // 比集合不比顺序：srcOf 用的是 JS 默认 sort，中文的次序不值得钉
  const got = new Set(srcOf(ds.merchantAll['日报']));
  check('三个来源都在', ['独立站API','FLYLINK快捷订单','合计'].every(s=>got.has(s)) && got.size===3,
        JSON.stringify([...got]));
  check('季报仍不在（没开 allPeriods）', ds.merchantAll['季报'] === undefined,
        Object.keys(ds.merchantAll));
}

console.log('[3] allPeriods：时间类别从数据里发现，含季报');
{
  const ds = readReport(wb, {allSources:true, allPeriods:true});
  check('季报被收进来', Array.isArray(ds.merchantAll['季报']) && ds.merchantAll['季报'].length > 0,
        Object.keys(ds.merchantAll));
  check('日报也还在', (ds.merchantAll['日报']||[]).length > 0);
  const all = Object.values(ds.merchantAll).reduce((n,a)=>n+a.length, 0);
  // 2 期 × 3 来源 × 2 站点 × 2 时间类别 = 24 行，全在
  check('一行不少', all === 24, all);
}

console.log('[4] ★ 全量模式的比率同样走 toRate —— 8457% 不该出现');
{
  const ds = readReport(wb, {allSources:true, allPeriods:true});
  const row = ds.merchantAll['日报'][0];
  const v = row['4. 网关通过率'];
  check('数值 84.57 读成 0.8457，不是 84.57', Math.abs(v - 0.8457) < 1e-9, v);
  check('乘 100 显示才是 84.57%', Math.abs(v*100 - 84.57) < 1e-6, v*100);
}

console.log('[5] 全量模式保留「站点=合计」的行（漏斗页能选）');
{
  const ds = readReport(wb, {allSources:true, allPeriods:true});
  const sites = [...new Set(ds.merchantAll['日报'].map(o=>o['站点']))];
  check('站点=合计 没被丢掉', sites.includes('合计'), JSON.stringify(sites));
}

check.report();
