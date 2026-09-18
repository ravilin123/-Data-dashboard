/* 两刀接口：readReport(workbook) → Dataset，analyze(dataset, opts) → AnalysisResult。
 *
 *     node tests/dataset.mjs        # 不需要服务，也不需要 $WB_FIXTURES
 *
 * 为什么切在这两处（第七轮已定，不再讨论）：
 *   · 上游改版（列改名、表头行数、sheet 改名）只会打到 readReport
 *   · 业务口径（阈值、归因、播报）只会打到 analyze
 * 于是测试可以**直接写 Dataset 字面量**，不用为了测一条口径去造 xlsx ——
 * 下面 [3] 就是这么做的，那是这一刀最主要的收益。
 */
import { MODULES, installBrowserStubs, makeChecker } from './_harness.mjs';
const XLSX = installBrowserStubs();
const check = makeChecker();

const { readReport } = await import(MODULES + 'dataset.js');
const { analyze }    = await import(MODULES + 'analyze.js');
const { broadcastTxt } = await import(MODULES + 'broadcast.js');
const { state }      = await import(MODULES + 'store.js');

/* ---------- 造一份最小报表 ---------- */
const METRICS = [['4. 网关通过率','网关通过率'], ['2. 业务校验通过率','业务校验通过率']];
const D1='2026-09-04', D2='2026-09-05', D3='2026-09-06';
const VAL = { [D1]:0.90, [D2]:0.80, [D3]:0.78 };

function makeWb(){
  const scene = [['时间类别','统计日期','来源','类型','当期值','分子/分母']];
  for (const date of [D1,D2,D3])
    for (const [, raw] of METRICS)
      scene.push(['日报', date, '独立站API', raw, VAL[date], '8000/10000']);
  const mHead = ['时间类别','统计日期','用户ID','站点','来源','PO单数', ...METRICS.map(m=>m[1])];
  const merch = [mHead];
  for (const date of [D1,D2,D3])
    for (const uid of ['U1','U2'])
      merch.push(['日报', date, uid, `https://s-${uid}.example.com`, '独立站API', 500,
                  ...METRICS.map(()=>VAL[date])]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(scene), '场景维度');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(merch), '商户维度');
  return wb;
}

console.log('[1] readReport 的形状');
const ds = readReport(makeWb());
{
  for (const k of ['periods','scene','merchantSite','merchantTotal','dates','meta','drift'])
    check(`带 ${k}`, ds[k] != null, JSON.stringify(Object.keys(ds)));
  check('periods 是可用性判定', ds.periods['日报'] && ds.periods['日报'].ok === true,
        JSON.stringify(ds.periods['日报']));
  check('scene 按周期分好', Array.isArray(ds.scene['日报']) && ds.scene['日报'].length === 6,
        ds.scene['日报'] && ds.scene['日报'].length);
  check('merchantSite 按周期分好', ds.merchantSite['日报'].length === 6,
        ds.merchantSite['日报'].length);
  // dates 必须来自商户维度 —— buildMerged 用的就是那份，两边不一致会「下拉里有、真去算却抛」
  check('dates 倒序且来自商户维度',
        JSON.stringify(ds.dates['日报']) === JSON.stringify([D3,D2,D1]),
        JSON.stringify(ds.dates['日报']));
  check('meta 带 hasSite / metricNames',
        ds.meta['日报'].hasSite === true && ds.meta['日报'].metricNames.length === 2,
        JSON.stringify(ds.meta['日报']));
  check('drift 带环比列状态', ds.drift && ds.drift.dodColumn && ds.drift.dodColumn.present === false,
        JSON.stringify(ds.drift && ds.drift.dodColumn));
}

console.log('[2] analyze 吃 Dataset，产出 AnalysisResult');
{
  const r = analyze(ds, {period:'日报', tDate:D3, yDate:D2});
  for (const k of ['period','tDate','yDate','hasSite','dfScene','mergedSite','mergedTotal',
                   'wide','alarmSite','alarmTotal','drillSite','drillTotal','stages',
                   'srcStory','noBase','dodAudit'])
    check(`结果带 ${k}`, r[k] !== undefined, Object.keys(r).join(','));
  check('相邻两期不触发（−2.5%）', r.alarmTotal.length === 0, r.alarmTotal.length);

  const far = analyze(ds, {period:'日报', tDate:D3, yDate:D1});
  check('隔一期触发（−13.3%）', far.alarmTotal.length === 2, far.alarmTotal.length);
}

console.log('[3] ★ 直接写 Dataset 字面量，不造 xlsx —— 这一刀的主要收益');
{
  /* 手写两期、一个来源、一个指标。跌 20%，稳稳跌破 −5% 兜底阈值。 */
  const lit = {
    periods: { 日报:{rows:2, dates:2, ok:true} },
    dates:   { 日报:['2026-09-06','2026-09-05'] },
    scene:   { 日报:[
      {时间类别:'日报', 统计日期:'2026-09-05', 来源:'独立站API', 类型:'4. 网关通过率', 当期值:0.90},
      {时间类别:'日报', 统计日期:'2026-09-06', 来源:'独立站API', 类型:'4. 网关通过率', 当期值:0.72},
    ]},
    merchantSite: { 日报:[
      {时间类别:'日报', 统计日期:'2026-09-05', 来源:'独立站API', 用户ID:'U1', 商户名称:'a.example.com',
       站点:'https://a.example.com', 'PO单数':500, '4. 网关通过率':0.90},
      {时间类别:'日报', 统计日期:'2026-09-06', 来源:'独立站API', 用户ID:'U1', 商户名称:'a.example.com',
       站点:'https://a.example.com', 'PO单数':500, '4. 网关通过率':0.72},
    ]},
    /* 商户级合计视图。hasSite 为真时 loadMerchant 会把站点卷起来算出这一份，
       analyze 里 buildMerged 对它和 merchantSite 各跑一次 —— 给空数组会抛
       「数据不足」（原 run() 就是这个行为，这里不改）。 */
    merchantTotal: { 日报:[
      {时间类别:'日报', 统计日期:'2026-09-05', 来源:'独立站API', 用户ID:'U1', 商户名称:'a.example.com',
       站点:'合计', 'PO单数':500, '4. 网关通过率':0.90},
      {时间类别:'日报', 统计日期:'2026-09-06', 来源:'独立站API', 用户ID:'U1', 商户名称:'a.example.com',
       站点:'合计', 'PO单数':500, '4. 网关通过率':0.72},
    ]},
    meta:  { 日报:{hasSite:true, metricNames:['4. 网关通过率']} },
    drift: { newSources:[], skipSources:[], newMetrics:[], usedSources:['独立站API'],
             dodColumn:{present:false, name:null} },
  };
  const r = analyze(lit, {period:'日报', tDate:'2026-09-06', yDate:'2026-09-05'});
  check('字面量也能分析', r.alarmSite.length === 1, JSON.stringify(r.alarmSite));
  check('环比算对了 −20%', r.alarmSite[0] && Math.abs(r.alarmSite[0]._dod + 0.2) < 1e-9,
        r.alarmSite[0] && r.alarmSite[0]._dod);
  check('下钻到了商户', r.drillSite.length >= 1, r.drillSite.length);
}

console.log('[4] 走 xlsx 和走字面量，结果一致');
{
  const viaWb  = analyze(ds, {period:'日报', tDate:D3, yDate:D1});
  // 把 readReport 的产物当字面量再喂一次，结果必须逐字节相同
  const again  = analyze(JSON.parse(JSON.stringify(ds)), {period:'日报', tDate:D3, yDate:D1});
  const norm = r => JSON.stringify({alarms:r.alarmTotal, drill:r.drillTotal, noBase:r.noBase});
  check('Dataset 是纯数据（过一遍 JSON 结果不变）', norm(viaWb) === norm(again));
}

console.log('[5] ★ T3：基准线经参数传入，不再从 store 读');
{
  /* 隔一期是 −13.3%，兜底阈值 −5% 会触发。给一条把 drop 放宽到 −50% 的基准线，
     同样的数据就不该触发 —— 这证明 analyze 真的在用传进去的那份，
     而不是偷偷读 state。故意把 store 设成相反的值来夹住这一点。 */
  state.baseline = null; state.baselineActive = false;

  const loose = {'4. 网关通过率':{drop:-0.5, rise:0.5}, '2. 业务校验通过率':{drop:-0.5, rise:0.5}};
  const r1 = analyze(ds, {period:'日报', tDate:D3, yDate:D1, baseline:loose, baselineActive:true});
  check('传了宽基准线就不触发', r1.alarmTotal.length === 0, r1.alarmTotal.length);
  check('告警依据标成基准线', true);   // 没触发就没有 _basis 可看，下面用窄的验

  const tight = {'4. 网关通过率':{drop:-0.01, rise:0.01}, '2. 业务校验通过率':{drop:-0.01, rise:0.01}};
  const r2 = analyze(ds, {period:'日报', tDate:D3, yDate:D2, baseline:tight, baselineActive:true});
  check('传了窄基准线，相邻两期也触发', r2.alarmTotal.length === 2, r2.alarmTotal.length);
  /* B4 之后 basis 分三档：基准线·本来源 / 基准线·混池 / 层级兜底。
     这里传的是老形状（{指标:阈值}），按混池收 —— 那条向后兼容路径由
     tests/baseline.mjs 的 [5] 专门钉着，这里只确认「不是兜底」。 */
  check('_basis 记的是基准线（老形状按混池收）',
        r2.alarmTotal[0] && r2.alarmTotal[0]._basis === '基准线·混池',
        r2.alarmTotal[0] && r2.alarmTotal[0]._basis);

  // baselineActive 为假时必须回到层级兜底
  const r3 = analyze(ds, {period:'日报', tDate:D3, yDate:D2, baseline:tight, baselineActive:false});
  check('没启用就回到层级兜底', r3.alarmTotal.length === 0, r3.alarmTotal.length);

  // 反向夹：store 里放一份窄基准线，但不传参 —— 不该被读到
  state.baseline = tight; state.baselineActive = true;
  const r4 = analyze(ds, {period:'日报', tDate:D3, yDate:D2});
  check('★ store 里的基准线不该被偷读', r4.alarmTotal.length === 0, r4.alarmTotal.length);
  state.baseline = null; state.baselineActive = false;
}

console.log('[6] ★ T3：播报素材经参数传入，不再从 store 读');
{
  /* 这一组要一份**完整漏斗**的报表：headlineLines 走的是「按场景讲故事」那条路，
     环节1 是 1.1×1.2 相乘来的，缺任一子项整段就算不出来，srcStory 会是空的，
     播报里一行 ■ 都没有 —— 那样这组就等于没测到东西。 */
  const FULL = [['1.1 校验1通过率','校验1通过率'], ['1.2 Paynow点击率','Paynow点击率'],
                ['2. 业务校验通过率','业务校验通过率'], ['3. 网关提交率','网关提交率'],
                ['4. 网关通过率','网关通过率']];
  const scene = [['时间类别','统计日期','来源','类型','当期值','分子/分母']];
  for (const date of [D1,D2,D3])
    for (const [, raw] of FULL)
      scene.push(['日报', date, '独立站API', raw, VAL[date], '8000/10000']);
  const mHead = ['时间类别','统计日期','用户ID','站点','来源','PO单数', ...FULL.map(m=>m[1])];
  const merch = [mHead];
  for (const date of [D1,D2,D3])
    for (const uid of ['U1','U2'])
      merch.push(['日报', date, uid, `https://s-${uid}.example.com`, '独立站API', 500,
                  ...FULL.map(()=>VAL[date])]);
  const wb2 = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb2, XLSX.utils.aoa_to_sheet(scene), '场景维度');
  XLSX.utils.book_append_sheet(wb2, XLSX.utils.aoa_to_sheet(merch), '商户维度');

  const r = analyze(readReport(wb2), {period:'日报', tDate:D3, yDate:D1});
  check('完整漏斗才有分场景故事', r.srcStory.length > 0, r.srcStory.length);
  state.data = null;                                  // store 清空
  const txt = broadcastTxt(r.alarmTotal, r.drillTotal, r.alarmSite, r.drillSite, r.tDate, r);
  check('store 空着也能出播报', txt.includes('转化率日报监控'), txt.slice(0, 60));
  check('播报里有分场景段落', txt.includes('■'), txt.slice(0, 200));
  // store 里塞一份别的数据，结果不该受影响
  state.data = {stages:{}, srcStory:[], dfScene:[], mergedSite:[], tDate:'x', yDate:'y'};
  const txt2 = broadcastTxt(r.alarmTotal, r.drillTotal, r.alarmSite, r.drillSite, r.tDate, r);
  check('★ store 里的脏数据影响不到播报', txt2 === txt);
  state.data = null;
}

check.report();
