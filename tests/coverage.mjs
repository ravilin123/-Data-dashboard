/* 来源覆盖校验（B8）。
 *
 *     node tests/coverage.mjs      # 不需要服务，也不需要 $WB_FIXTURES
 *
 * `FLYPAY` 是含全部子场景的全局汇总，作为来源不能进分析（重复计数），
 * 作为验算免费：FLYPAY 的 PO 减去报表里所有子场景的 PO，剩下的就是
 * 「连报表都没单独列行」的那部分。上游新增一个场景却沿用旧命名风格时，
 * `formatDrift()` 那套字符串比对发现不了，数字对不上藏不住。
 *
 * ★ 的几条是这块最容易做错的地方：
 *   · 缺口是**常态**，不是「越小越好」—— 天天报 0.4% 是噪声（用户 2026-09-09 明确说过）
 *   · 算不出来时必须 ok:false，不能当 0 —— 否则「读不到数」会伪装成「新增了场景」
 */
import { MODULES, installBrowserStubs, makeChecker } from './_harness.mjs';
installBrowserStubs();
const check = makeChecker();

const { coverageCheck, scenePOBySource } = await import(MODULES + 'coverage.js');
const { COVERAGE_GAP_MAX, TOTAL_SOURCE } = await import(MODULES + 'config.js');

const PO='1.1 校验1通过率';
/** 场景维度里带分子/分母的那种行。loadScene 会把「分子/分母」拆成 _n/_d。 */
const row=(date,src,po,metric=PO)=>({'统计日期':date,'来源':src,'类型':metric,_n:Math.round(po*0.9),_d:po});
const D='2026-09-06';

console.log('[1] scenePOBySource：只挑 1.1 那一行的分母');
{
  const rows=[
    row(D,TOTAL_SOURCE,16089), row(D,'独立站API',5043), row(D,'Element',5289),
    row(D,'独立站API',999,'4. 网关通过率'),          // 别的指标的分母，不该被当成 PO
    {'统计日期':D,'来源':'独立站标准收银台','类型':PO},   // 没有 _d，跳过
    row('2026-09-05',TOTAL_SOURCE,16404),
  ];
  const m=scenePOBySource(rows);
  check('按期次分开', Object.keys(m).sort().join()==='2026-09-05,2026-09-06', Object.keys(m));
  check('★ 只取 1.1 的分母', m[D]['独立站API']===5043, m[D]);
  check('缺 _d 的不进', !('独立站标准收银台' in m[D]), m[D]);
  check('空输入不炸', Object.keys(scenePOBySource()).length===0);
}

console.log('\n[2] ★ 缺口是常态，不是「越小越好」');
{
  // 真实数据的量级：FLYPAY 16089，子场景加总 16029，缺口 0.37%
  const m=scenePOBySource([
    row(D,TOTAL_SOURCE,16089), row(D,'独立站API',5043),
    row(D,'独立站标准收银台',3027), row(D,'Element',5289),
    row(D,'FLYLINK商品订单',2016), row(D,'FLYLINK快捷订单',654),
  ]);
  const r=coverageCheck(m, D);
  check('算得出来', r.ok===true, r);
  check('缺口 = 16089 − 16029 = 60', r.gap===60, r.gap);
  check('缺口比例 0.37%', Math.abs(r.gapRatio-60/16089)<1e-12, r.gapRatio);
  check('★ 常态缺口不报警', r.alert===false, {gapRatio:r.gapRatio, max:COVERAGE_GAP_MAX});
  check('分析覆盖率 = 白名单三家 / 大盘',
        Math.abs(r.analyzedRatio-(5043+3027+5289)/16089)<1e-12, r.analyzedRatio);
  check('列出白名单排除的那些，按量倒序',
        r.extras.map(x=>x.src).join()==='FLYLINK商品订单,FLYLINK快捷订单', r.extras);
}

console.log('\n[3] ★ 上游新增一个没进白名单的场景 → 报出来');
{
  /* 2026-09 改版时上游新增了 Element（占大盘 33%）。假设当时白名单没跟上、
     报表里连行都没列，缺口就会从 0.4% 跳到 33%。 */
  const m=scenePOBySource([
    row(D,TOTAL_SOURCE,16089), row(D,'独立站API',5043),
    row(D,'独立站标准收银台',3027),
    row(D,'FLYLINK商品订单',2016), row(D,'FLYLINK快捷订单',654),
  ]);
  const r=coverageCheck(m, D);
  check('★ 报出来了', r.alert===true, r);
  check('缺口 = 5349 单', r.gap===16089-10740, r.gap);
  check(`比例 ${(r.gapRatio*100).toFixed(1)}% 远超阈值 ${COVERAGE_GAP_MAX*100}%`,
        r.gapRatio>0.3, r.gapRatio);
}

console.log('\n[4] ★ 算不出来 ≠ 缺口为 0');
{
  /* 某个子场景缺了 PO 行时，加总会偏小、缺口会偏大 —— 那是「读不到数」
     不是「上游新增了场景」，报出去就是假警报，而且长得和真警报一模一样。 */
  check('★ 没有 FLYPAY 行 → ok:false 且不报警',
        (()=>{ const r=coverageCheck(scenePOBySource([row(D,'独立站API',5043)]), D);
               return r.ok===false && r.alert===false && /FLYPAY/.test(r.why); })());
  check('★ 只有汇总行、没有子场景 → ok:false',
        (()=>{ const r=coverageCheck(scenePOBySource([row(D,TOTAL_SOURCE,16089)]), D);
               return r.ok===false && r.alert===false; })());
  check('这一期没数据 → ok:false', coverageCheck({}, D).ok===false);
  check('scenePO 整个没有 → 不炸', coverageCheck(undefined, D).ok===false);
  check('FLYPAY 是 0 → ok:false（不做除零）',
        coverageCheck(scenePOBySource([row(D,TOTAL_SOURCE,0), row(D,'独立站API',5)]), D).ok===false);
}

console.log('\n[5] 阈值边界');
{
  const mk=sub=>scenePOBySource([row(D,TOTAL_SOURCE,10000), row(D,'独立站API',sub)]);
  const at=coverageCheck(mk(10000*(1-COVERAGE_GAP_MAX)), D);      // 正好等于阈值
  const over=coverageCheck(mk(10000*(1-COVERAGE_GAP_MAX)-1), D);  // 差一单，超过
  check('正好等于阈值不报（要「超过」）', at.alert===false, at.gapRatio);
  check('超过一点就报', over.alert===true, over.gapRatio);
}

check.report();
