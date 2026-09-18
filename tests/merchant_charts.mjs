/* 商户页图表层的**取数**（`static/js/merchant/charts_data.js`）。
 *
 *     node tests/merchant_charts.mjs      # 不需要服务，也不需要 $WB_FIXTURES
 *
 * 这些函数原来长在渲染函数肚子里，而且**直接读 `isAmt()` 那个界面全局** ——
 * 同一个函数在笔数/金额两种口径下行为不同，调用点看不出来，也没法单独跑。
 * 抽出来之后口径是显式参数，两种口径可以各喂一遍。
 *
 * 挑的是三条「算错了图照样画得出来」的性质：
 *   1. **加权分解是恒等式**：Σ结构效应 + Σ通过率效应 = 该维度整体变化。
 *      对不上账时读的人只会以为是四舍五入 —— 而真实原因可能是漏了一整类。
 *   2. **上期有、本期整个没了的取值必须算进来**（它带走的权重同样解释了变化）。
 *   3. **热力图定标只看两期都够量的格子**：让 1~2 笔的格子参与定标，
 *      一个 0%→100% 就把刻度撑到 ±100，真正有量的格子全成浅色。
 */
import { MODULES, makeChecker } from './_harness.mjs';
const check = makeChecker();
const M = MODULES.replace('/conversion/', '/merchant/');
const { HEAT_MIN_N, aggMetric, changeAttrib, failGroups, groupMetric,
        heatRate, heatScale, impactItems, timeHeatGrid } = await import(M + 'charts_data.js');

const row = (st, amt, extra = {}) => ({status: st, amount: amt, ...extra});
const OK = '支付成功', NG = '支付失败';

console.log('[1] 口径是显式参数：同一批数据，笔数和金额算出来不一样');
{
  // 3 笔：成功 1 笔 900 元，失败 2 笔各 50 元 → 笔数 33.33%，金额 90%
  const rows = [row(OK, 900), row(NG, 50), row(NG, 50)];
  check('笔数口径 = 1/3', aggMetric(rows, false).rate === 33.33, String(aggMetric(rows, false).rate));
  check('★ 金额口径 = 900/1000', aggMetric(rows, true).rate === 90, String(aggMetric(rows, true).rate));
  check('n / succ / fail 不受口径影响',
        aggMetric(rows, true).n === 3 && aggMetric(rows, true).succ === 1 && aggMetric(rows, true).fail === 2);
  // 未决不算成功也不算失败，但仍进 n 和 amt
  const withPend = [...rows, row('处理中', 1000)];
  check('★ 未决进 n 但不进 succ/fail', aggMetric(withPend, false).n === 4
        && aggMetric(withPend, false).succ === 1 && aggMetric(withPend, false).fail === 2);
  check('空输入不炸', aggMetric([], false).rate === 0 && aggMetric([], true).rate === 0);
}

console.log('[2] groupMetric：占比、通过率、影响力');
{
  const rows = [
    row(OK, 100, {m:'A'}), row(OK, 100, {m:'A'}), row(NG, 100, {m:'A'}),
    row(NG, 100, {m:'B'}), row(NG, 100, {m:'B'}),
  ];
  const g = groupMetric(rows, 'm', null, false);
  const A = g.rows.find(r => r.v === 'A'), B = g.rows.find(r => r.v === 'B');
  check('整体通过率 = 2/5', g.overall === 40, String(g.overall));
  check('A 通过率 = 2/3', A.rate === 66.67, String(A.rate));
  check('A 占比 = 3/5', A.share === 60, String(A.share));
  check('B 通过率 = 0', B.rate === 0, String(B.rate));
  /* ★ Σimpact 恒等于 0 —— 它是贡献度，只能排序「谁在拖累」，
     不能当成「这组损失了多少」。容差来自通过率先四舍五入到 2 位再乘占比。 */
  const sum = g.rows.reduce((s, r) => s + r.impact, 0);
  check('★ Σ影响力 ≈ 0（它是贡献度不是损失量）', Math.abs(sum) < 0.01, String(sum));

  check('key 为 null 的行跳过（对应 groupby dropna）',
        groupMetric([...rows, row(OK, 1, {m:null})], 'm', null, false).rows.length === 2);
  // 分类种子：没出现的档位也要播种，出现但不在种子里的要丢掉
  const seeded = groupMetric(rows, 'm', ['A','B','C'], false);
  check('★ 分类种子会播种没出现的档位', seeded.rows.some(r => r.v === 'C' && r.n === 0),
        JSON.stringify(seeded.rows.map(r => r.v)));
  check('★ 不在种子里的取值被丢掉',
        groupMetric(rows, 'm', ['A'], false).rows.length === 1);
  check('播种的空档位不影响整体（分母只算种子内的）',
        seeded.overall === 40, String(seeded.overall));
}

console.log('[3] failGroups：帕累托累计到 100%');
{
  const rows = [row(NG, 10, {fail_reason:'A'}), row(NG, 10, {fail_reason:'A'}),
                row(NG, 90, {fail_reason:'B'}), row(OK, 500, {fail_reason:null})];
  const byN = failGroups(rows, false);
  check('成功单不进（只看失败）', byN.total === 3, String(byN.total));
  check('按笔数排：A 在前', byN.arr[0].k === 'A', byN.arr[0].k);
  check('累计到 100%', byN.arr[byN.arr.length-1].cum === 100, String(byN.arr[byN.arr.length-1].cum));
  const byAmt = failGroups(rows, true);
  check('★ 换金额口径排序会翻转：B 在前', byAmt.arr[0].k === 'B', byAmt.arr[0].k);
  check('空失败原因写成「（无原因）」',
        failGroups([row(NG, 1, {fail_reason:''})], false).arr[0].k === '（无原因）');
  check('全是成功时 total=0，不炸', failGroups([row(OK, 1)], false).total === 0);
}

console.log('[4] ★ 变化归因：加权分解是恒等式');
{
  const mk = (spec) => groupMetric(
    spec.flatMap(([v, n, succ]) => [
      ...[...Array(succ)].map(() => row(OK, 100, {m:v})),
      ...[...Array(n - succ)].map(() => row(NG, 100, {m:v})),
    ]), 'm', null, false);

  // 上期：A 80/100 通过 80%，B 20/100 通过 50% → 整体 (80+10)/200... 用 groupMetric 算
  const last = mk([['A', 100, 80], ['B', 100, 50]]);
  // 本期：流量搬去了 B（结构效应），同时 A 自己也变差了（通过率效应）
  const curr = mk([['A', 50, 35], ['B', 150, 75]]);
  const a = changeAttrib(curr, last, 'm');
  check('★ Σ结构 + Σ通过率 = 该维度整体变化（差额只来自四舍五入）',
        Math.abs(a.diff) < 0.05, `结构 ${a.sumStruct} + 通过率 ${a.sumRate} vs 实际 ${a.actual}（差 ${a.diff}）`);
  check('两种效应都不为 0（这个 fixture 是两者都动）',
        a.sumStruct !== 0 && a.sumRate !== 0, `${a.sumStruct} / ${a.sumRate}`);

  /* ★ 上期有、本期整个没了的取值。漏掉它，账就对不上 ——
     而对不上时读的人只会以为是四舍五入。 */
  const lastWithC = mk([['A', 100, 80], ['B', 100, 50], ['C', 100, 10]]);
  const g = changeAttrib(curr, lastWithC, 'm');
  const gone = g.items.find(x => x.v === 'C');
  check('★ 消失的取值出现在明细里并标了 gone', !!gone && gone.gone === true, JSON.stringify(gone));
  check('★ 它的结构效应不为 0（它带走的权重解释了一部分变化）',
        gone.eStruct !== 0, String(gone.eStruct));
  check('★ 加上它之后账仍然对得上', Math.abs(g.diff) < 0.05,
        `结构 ${g.sumStruct} + 通过率 ${g.sumRate} vs 实际 ${g.actual}（差 ${g.diff}）`);

  /* ★ 本期新增的取值：反事实基线取**上期整体通过率**，不是 0。
     这是 2026-09-09 修的一个真 bug —— 原来 eStruct 按 r1=0 算、eRate 写死 0，
     两处用了不同的 r1，恒等式当场破掉：上期只有 A（80%），本期 A 和 D 各占一半
     （D 90%），整体 +5pt 而分解出来只有 −40pt，**卡片把差的 45pt 写成「四舍五入」**。 */
  const lastA = mk([['A', 100, 80]]);
  const fresh = changeAttrib(mk([['A', 100, 80], ['D', 100, 90]]), lastA, 'm');
  const d = fresh.items.find(x => x.v === 'D');
  check('★ 新增的取值标 fresh', d.fresh === true && d.lastRate === null, JSON.stringify(d));
  check('★ 结构效应 = 新增的量按上期整体水平该贡献多少（0.5 × 80）',
        d.eStruct === 40, String(d.eStruct));
  check('★ 通过率效应 = 它比上期整体好多少（0.5 × (90−80)）', d.eRate === 5, String(d.eRate));
  check('★ 新增场景账对得上（修之前差 45pt，还被写成「四舍五入」）',
        Math.abs(fresh.diff) < 0.05, String(fresh.diff));

  // 两期完全一样 → 两种效应都是 0
  const same = changeAttrib(last, last, 'm');
  check('两期一样 → 结构和通过率效应都是 0',
        same.sumStruct === 0 && same.sumRate === 0 && same.actual === 0, JSON.stringify(same));
}

console.log('[5] impactItems：三维合起来按 |影响力| 取前 N');
{
  const gm = v => ({rows: v.map((impact, i) => ({v:'v'+i, impact, rate:50, share:10, n:10, amt:100})), overall:50});
  const items = impactItems([[gm([1, -5, 0.5]), 'a', 'A维'], [gm([-9, 2]), 'b', 'B维']], 3);
  check('按绝对值降序', items.map(x => x.impact).join(',') === '-9,-5,2', items.map(x => x.impact).join(','));
  check('带上维度标签（不然分不清是哪一维的哪个值）', items[0].dim === 'B维', items[0].dim);
  check('★ impact = 0 的丢掉（画出来是根 0 长度的条，只占位置）',
        !impactItems([[gm([0, 0, 3]), 'a', 'A维']], 9).some(x => x.impact === 0));
  check('limit 生效', impactItems([[gm([1,2,3,4,5]), 'a', 'A维']], 2).length === 2);
  check('gm 为 null 时跳过，不炸', impactItems([[null, 'a', 'A维'], [gm([1]), 'b', 'B维']], 9).length === 1);
}

console.log('[6] ★ 热力图：周一在第 0 行；定标只看两期都够量的格子');
{
  const at = (dow, hour, st, amt = 100) => {
    // 2026-09-07 是周一
    const d = new Date(2026, 8, 7 + dow, hour, 0, 0);
    return {status: st, amount: amt, pay_time: d};
  };
  const g = timeHeatGrid([at(0, 3, OK), at(0, 3, NG), at(6, 20, OK)]);
  check('★ 周一落在第 0 行（getDay() 周日=0，要挪一位）', g[0][3].n === 2, String(g[0][3].n));
  check('★ 周日落在第 6 行', g[6][20].n === 1, String(g[6][20].n));
  check('空格子是 0 不是 undefined', g[3][11].n === 0);
  check('单元格比率：无交易给 null（不是 0）', heatRate(g[3][11], false) === null);
  check('单元格比率：笔数口径', heatRate(g[0][3], false) === 50, String(heatRate(g[0][3], false)));

  /* 定标：一个 1 笔的格子从 0% 跳到 100%，不该把色标撑到 ±100 ——
     否则真正有量的格子全成浅色（实测撑到过 ±56.67pt）。 */
  const bulk = (dow, hour, n, succ) => [
    ...[...Array(succ)].map(() => at(dow, hour, OK)),
    ...[...Array(n - succ)].map(() => at(dow, hour, NG)),
  ];
  const curr = timeHeatGrid([...bulk(1, 10, 20, 10), ...bulk(2, 14, 1, 1)]);   // 50% / 100%
  const last = timeHeatGrid([...bulk(1, 10, 20, 14), ...bulk(2, 14, 1, 0)]);   // 70% / 0%
  const scale = heatScale(curr, last, false);
  check(`★ 小样本格子（<${HEAT_MIN_N} 笔）不参与定标`, scale === 20, String(scale));
  check('★ 全是小样本时退回全量定标（不然色标是 0，整张图无色）',
        heatScale(timeHeatGrid(bulk(2, 14, 1, 1)), timeHeatGrid(bulk(2, 14, 1, 0)), false) === 100,
        String(heatScale(timeHeatGrid(bulk(2, 14, 1, 1)), timeHeatGrid(bulk(2, 14, 1, 0)), false)));
  check('两期一样 → 色标 0', heatScale(curr, curr, false) === 0);
}

check.report();
