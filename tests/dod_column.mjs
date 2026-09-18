/* 环比：现算、校验、以及源表那一列剩下的角色。
 *
 *     node tests/dod_column.mjs        # 不需要服务，也不需要 $WB_FIXTURES
 *
 * 兜两件事。
 *
 * 一、**告警的环比必须和你选的那对日期是同一回事**（第四轮 A1）。
 * detect() 原来读源表自带的 `环比` 列，而瀑布图 / 商户下钻 / 影响比率走的是下拉里
 * 选的那对日期。两期相邻时恰好一致，一往前翻就是同一屏两套口径。现在改成用
 * sceneMap(tDate) / sceneMap(yDate) 现算，源表那列降级成校验。
 *
 * 二、**源表那列 2026-09 起整个没了**，上游说后面会加回来。识别收在 load.js 的
 * DOD_ALIASES 一处；它在与不在都不该影响告警（现算不依赖它），只影响能不能做校验。
 *
 * ⚠️ 口径：这列是**相对环比** (今−昨)/昨，不是 pt 差值 —— 2026-09-08 拿 2026-07-30
 * 旧格式报表核实过，346 对可比数据里 143 对只符合相对、0 对符合 pt。现算也按相对来。
 */
import { MODULES, installBrowserStubs, makeChecker } from './_harness.mjs';

const XLSX = installBrowserStubs();
const check = makeChecker();

const { loadScene, loadMerchant, formatDrift } = await import(MODULES + 'load.js');
const { detect } = await import(MODULES + 'detect.js');
const { buildMerged, parseDodCell } = await import(MODULES + 'funnel.js');
const { computeBaseline } = await import(MODULES + 'baseline.js');

/* ---------- 造报表 ----------
   三期，一个来源，两个 depth 0 指标（兜底阈值 −5%）。当期值挑成：
     D3 vs D2（相邻）  = (0.78−0.80)/0.80 = −2.5%  → 不触发
     D3 vs D1（隔一期）= (0.78−0.90)/0.90 = −13.3% → 触发
   于是「选哪对日期」直接决定有没有告警——A1 说的就是这件事。 */
const METRICS = [['4. 网关通过率','网关通过率'], ['2. 业务校验通过率','业务校验通过率']];
const D1='2026-09-04', D2='2026-09-05', D3='2026-09-06';
const VAL = { [D1]:0.90, [D2]:0.80, [D3]:0.78 };
/* 源表自带的环比一律按「对上一期」给，也就是 D3 那行写的是 D3 vs D2 = −2.5% */
const SRC_DOD = { [D1]:0.01, [D2]:-0.1111, [D3]:-0.025 };

function makeWb({dodHeader='环比', srcDod=SRC_DOD, dropD2Rows=false} = {}) {
  const head = ['时间类别','统计日期','来源','类型','当期值','分子/分母'];
  if (dodHeader) head.push(dodHeader);
  const scene = [head];
  for (const date of [D1, D2, D3]) {
    for (const [, raw] of METRICS) {
      // dropD2Rows：让 D2 缺掉这个来源的行，模拟「上期没有可比值」
      if (dropD2Rows && date === D2) continue;
      const row = ['日报', date, '独立站API', raw, VAL[date], '8000/10000'];
      if (dodHeader) row.push(srcDod[date]);
      scene.push(row);
    }
  }
  const mHead = ['时间类别','统计日期','用户ID','站点','来源','PO单数', ...METRICS.map(m => m[1])];
  const merch = [mHead];
  for (const date of [D1, D2, D3])
    for (const uid of ['U1','U2'])
      merch.push(['日报', date, uid, `https://s-${uid}.example.com`, '独立站API', 500,
                  ...METRICS.map(() => VAL[date])]);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(scene), '场景维度');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(merch), '商户维度');
  return wb;
}

function analyse(wb, tD = D3, yD = D2) {
  const scene = loadScene(wb, '日报');
  const { dfSite, dfTotal, hasSite } = loadMerchant(wb, '日报');
  const { merged } = buildMerged(dfTotal.length ? dfTotal : dfSite, hasSite, tD, yD);
  return { drift: formatDrift(wb), res: detect(scene, merged, {tDate:tD, yDate:yD, hasSite}) };
}

console.log('[1] ★ 告警用的是你选的那对日期，不是源表那一列');
{
  // 相邻：现算 −2.5%，不该触发。源表那行写的也是 −2.5%，两者一致。
  const adj = analyse(makeWb(), D3, D2);
  check('相邻两期不触发', adj.res.alarms.length === 0, adj.res.alarms.length);

  // 隔一期：现算 −13.3% 应当触发。源表那列仍是 −2.5% ——
  // 旧行为读它，于是一条都不报；这条挂了就说明还在读源表列。
  const far = analyse(makeWb(), D3, D1);
  check('隔一期按选中日期现算并触发', far.res.alarms.length === 2, far.res.alarms.length);
  const d = far.res.alarms[0] && far.res.alarms[0]._dod;
  check('现算的环比 ≈ −13.3%', d != null && Math.abs(d - (0.78-0.90)/0.90) < 1e-9, d);
}

console.log('[2] 没有环比列 —— 告警照常出（现算不依赖它）');
{
  const { drift, res } = analyse(makeWb({dodHeader: null}), D3, D1);
  check('formatDrift 仍报告列缺失', drift.dodColumn && drift.dodColumn.present === false,
        JSON.stringify(drift && drift.dodColumn));
  check('告警不受影响', res.alarms.length === 2, res.alarms.length);
  check('校验无从做起，如实说明', res.dodAudit && res.dodAudit.compared === 0,
        JSON.stringify(res.dodAudit));
}

console.log('[3] 源表那列降级成校验');
{
  // 相邻两期且列在：现算值应当和源表对得上
  const ok = analyse(makeWb(), D3, D2);
  check('相邻时被拿来校验', ok.res.dodAudit.adjacent === true && ok.res.dodAudit.compared === 2,
        JSON.stringify(ok.res.dodAudit));
  check('对得上就不报警', ok.res.dodAudit.mismatch === 0, JSON.stringify(ok.res.dodAudit));

  // 源表给一个明显对不上的值 → 要报出来（「上游环比口径可能变了」）
  const bad = analyse(makeWb({srcDod: {[D1]:0.01, [D2]:-0.1111, [D3]:-0.5}}), D3, D2);
  check('对不上要报出来', bad.res.dodAudit.mismatch === 2, JSON.stringify(bad.res.dodAudit));
  check('报告里带得出样本', (bad.res.dodAudit.samples || []).length > 0,
        JSON.stringify(bad.res.dodAudit.samples));

  // 非相邻时源表那列本来就不该和现算值一致，不能拿来判
  const far = analyse(makeWb(), D3, D1);
  check('非相邻时不做校验', far.res.dodAudit.adjacent === false && far.res.dodAudit.compared === 0,
        JSON.stringify(far.res.dodAudit));
}

console.log('[4] 列名换成「日环比」—— 别名仍然认（校验用）');
{
  const { drift, res } = analyse(makeWb({dodHeader: '日环比'}), D3, D2);
  check('formatDrift 认出别名', drift.dodColumn && drift.dodColumn.name === '日环比',
        JSON.stringify(drift && drift.dodColumn));
  check('别名也能用来校验', res.dodAudit.compared === 2, JSON.stringify(res.dodAudit));
}

console.log('[5] 上期没有可比值 —— 计数报上来，不静默丢');
{
  // D2 整个来源的行没了：选 D3 vs D2 时算不出环比
  const { res } = analyse(makeWb({dropD2Rows: true}), D3, D2);
  check('算不出的行被计数', res.noBase === 2, `noBase=${res.noBase}`);
  check('这些行确实没进告警', res.alarms.length === 0, res.alarms.length);
}

console.log('[6] ★ 源表环比按「形态」判，不按大小 —— 别再把翻倍的跳变除以 100');
/* 原来是 `Math.abs(d)<1 ? d : d/100`，用大小猜单位。2026-07-30 那份报表的 2076 个
   环比单元格**全是数值、没有一个带 %**，其中 14 个 |值|>=1，会被这句除以 100：
     7.0046（+700%）  → 读成 +7.0%
     1.6154（+161%）  → 读成 +1.62%
     -1.0000（跌到 0）→ 读成 -1.0%   ← 离 -5% 阈值十万八千里，归零的指标从没报过警
   风控-3DS 这类摩擦指标（上升阈值 +2%）翻一倍半是常事，全被压在阈值下。
   正确的判法和 toRate 一样：**看形态**，带 % 的文本才除 100，数值原样用。 */
{
  const cases = [
    ['1.6154 是 +161.54%，不是 +1.62%',  1.6154,  1.6154],
    ['7.0046 是 +700%',                  7.0046,  7.0046],
    ['-1 是跌到 0，不是 -1%',            -1,      -1],
    ['小数原样用',                       -0.1342, -0.1342],
    ["带 % 的文本要除 100",              '-13.42%', -0.1342],
    ['带 % 的大数也除 100',              '161.54%', 1.6154],
    ['空值给 null',                      '',      null],
    ['null 给 null',                     null,    null],
  ];
  for (const [name, input, want] of cases) {
    const got = parseDodCell(input);
    const ok = want === null ? got === null : (got != null && Math.abs(got - want) < 1e-9);
    check(name, ok, `parseDodCell(${JSON.stringify(input)}) = ${got}`);
  }
}

console.log('[7] 基准线也得能在「没有环比列」的报表上算出来');
/* computeBaseline 原来同样读源表那一列 —— 2026-09 起那列没了，于是历史文件喂进去
   一个样本都攒不出，界面只说「样本不足」。基准线是拿这些值的分布当阈值的，
   口径必须和 detect() 一致，所以这里也改成按文件内的相邻两期现算。 */
{
  /* 九期，一个来源，两个指标 → 每个指标 8 个环比样本。
     ⚠️ 期数要同时够 POOL_MIN_MIXED（5）和 POOL_MIN_SRC（8）—— B4 把混池门槛
     从 3 提到了 5，又给「来源×指标」单开了一档 8。原来这里是 5 期 / 4 个样本，
     两档都卡在门槛下。 */
  const dates = ['2026-09-01','2026-09-02','2026-09-03','2026-09-04','2026-09-05',
                 '2026-09-06','2026-09-07','2026-09-08','2026-09-09'];
  const vals  = [0.80, 0.78, 0.81, 0.76, 0.79, 0.77, 0.82, 0.75, 0.80];
  const mk = (withDod) => {
    const head = ['时间类别','统计日期','来源','类型','当期值','分子/分母'];
    if (withDod) head.push('环比');
    const scene = [head];
    dates.forEach((date, i) => METRICS.forEach(([, raw]) => {
      const row = ['日报', date, '独立站API', raw, vals[i], '8000/10000'];
      if (withDod) row.push(i === 0 ? 0 : (vals[i]-vals[i-1])/vals[i-1]);
      scene.push(row);
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(scene), '场景维度');
    return { arrayBuffer: async () => XLSX.write(wb, {type:'array', bookType:'xlsx'}) };
  };
  const noCol = await computeBaseline([mk(false)], 3, 0.01);
  check('没有环比列也攒得出样本', noCol.totalN > 0, `totalN=${noCol.totalN}`);
  /* B4 之后基准线是分池的：{v, bySrc, mixed, level}。这里只有一个来源，
     混池和本来源池装的是同一批样本，两个都该有这两个指标。 */
  check('两个指标都有混池基准线', Object.keys(noCol.bl.mixed).length === 2,
        Object.keys(noCol.bl.mixed));
  check('本来源池也建起来了',
        Object.keys(noCol.bl.bySrc).length === 2, Object.keys(noCol.bl.bySrc));

  // 有列时结果应当一致 —— 现算值和上游那列本来就该相等
  const withCol = await computeBaseline([mk(true)], 3, 0.01);
  const a = noCol.bl.mixed['4. 网关通过率'], b2 = withCol.bl.mixed['4. 网关通过率'];
  check('有没有那一列，算出来的基准线一样',
        a && b2 && Math.abs(a.median - b2.median) < 1e-9 && a.n === b2.n,
        JSON.stringify({无列:a && {n:a.n, median:a.median}, 有列:b2 && {n:b2.n, median:b2.median}}));
}

check.report();
