/* 支付前 / 支付中 两段拆账（B7 剩下的那半条）。
 *
 *     node tests/po_rate.mjs      # 不需要服务；[8] 有真实报表才跑
 *
 * 钉五件一旦破了**卡片上看不出来**的事：
 *   1. 两段相加必须等于总流失。劈账最怕的不是劈错，是劈完加起来对不上 ——
 *      读的人会拿其中一段当结论，而那一段可能把残差吃进去了。
 *   2. 数只从源表的分子/分母来，不拿比率相乘（和 merchant_scan 同一条纪律）。
 *   3. 缺「支付单支付成功率」行的来源要**报出来**，不能当 0 ——
 *      当 0 会得到「100% 卡在支付前」这种长得像真结论的假结论（coverage.js 踩过）。
 *   4. 两行分子对不上要打 mismatch，而且**头条数字不受影响**（PO 和成功单
 *      都来自业务单那行），只是劈法不可全信。
 *   5. 本期没走完时不给**单量**环比。周月报选到当前这一期，本期才过了几天、
 *      上期是整整一周/一个月，单量根本不可比 —— 实测月报会写出「支付中流失
 *      −92,036 单」，又大又醒目，能把整张卡片的读法带偏。比率环比不受影响。
 */
import { MODULES, installBrowserStubs, makeChecker } from './_harness.mjs';
const XLSX = installBrowserStubs();
const check = makeChecker();

const { buildPoRate, buildPoRateTrend, splitOne } = await import(MODULES + 'po_rate.js');

/* 造场景行：只给这块用得上的三个指标。`当期值` 故意和 _n/_d 对不上，
   用来验证「只认分子分母」那条 —— 真按 当期值 算的话下面每个断言都会挂。 */
const row = (date, src, 类型, n, d) =>
  ({'统计日期':date, '来源':src, '类型':类型, '当期值':'99.99%', _n:n, _d:d});
/** @param po 支付单数；@param ok 成功单；@param poN 支付单率的分子（默认 = ok） */
const pair = (date, src, poCnt, payCnt, ok, poN) => [
  row(date, src, '业务单支付成功率', ok, poCnt),
  row(date, src, '支付单支付成功率', poN===undefined?ok:poN, payCnt),
];

console.log('[1] ★ 两段相加 === 总流失，且总流失 = PO − 成功');
{
  // 独立站标准收银台 2026-09-06 的真实量级：3027 → 1745 → 1313
  const sc = pair('D1','独立站标准收银台', 3027, 1745, 1313);
  const r = buildPoRate(sc, {tDate:'D1'}).rows[0];
  check('支付前流失 = PO − 支付单数', r.支付前流失===3027-1745, String(r.支付前流失));
  check('支付中流失 = 支付单数 − 成功单', r.支付中流失===1745-1313, String(r.支付中流失));
  check('★ 两段相加 === 总流失', r.支付前流失+r.支付中流失===r.总流失, `${r.支付前流失}+${r.支付中流失}≠${r.总流失}`);
  check('总流失 = PO − 成功', r.总流失===3027-1313, String(r.总流失));
  check('业务单率 = 成功/PO', Math.abs(r.业务单率-1313/3027)<1e-12);
  check('支付单率 = 成功/支付单数', Math.abs(r.支付单率-1313/1745)<1e-12);
  check('环节1 = 支付单数/PO', Math.abs(r.环节1-1745/3027)<1e-12);
  check('★ 业务单率 = 环节1 × 支付单率（核实过的那条恒等式）',
        Math.abs(r.业务单率-r.环节1*r.支付单率)<1e-12);
  check('支付前占比 = 支付前/总流失', Math.abs(r.支付前占比-(3027-1745)/(3027-1313))<1e-12);
  check('没有 mismatch', r.mismatch===false);
}

console.log('[2] ★ 只认源表的分子/分母，不拿比率相乘');
{
  /* 每行的 当期值 都写着 99.99%。若实现里有任何一处退回去读 当期值，
     业务单率就会变成 0.9999 而不是 1313/3027。 */
  const r = buildPoRate(pair('D1','Element', 5289, 5289, 1233), {tDate:'D1'}).rows[0];
  check('★ 业务单率没被 当期值 污染', Math.abs(r.业务单率-1233/5289)<1e-12, String(r.业务单率));
  check('环节1 = 100% 时支付前流失为 0', r.支付前流失===0, String(r.支付前流失));
  check('全部流失都在支付中', r.支付中流失===r.总流失);
  check('支付前占比 = 0', r.支付前占比===0, String(r.支付前占比));
}

console.log('[3] ★ 缺「支付单支付成功率」行 → 进 noData，不当 0');
{
  const sc = [ row('D1','独立站API','业务单支付成功率', 2922, 5043) ];   // 故意不给支付单那行
  const g = buildPoRate(sc, {tDate:'D1'});
  check('★ 不出现在 rows 里（不能当 0 算出「全卡在支付前」）', g.rows.length===0, JSON.stringify(g.rows));
  check('★ 进了 noData，界面能报出来', g.noData.includes('独立站API'), JSON.stringify(g.noData));
  check('ok=false', g.ok===false);

  // 整个来源都没数据 ≠ 有数据但缺那一行。前者不该提醒（本来就没这个来源）
  const g2 = buildPoRate(pair('D1','Element',100,100,50), {tDate:'D1'});
  check('★ 整个来源没数据时不误报 noData', g2.noData.length===0, JSON.stringify(g2.noData));
  check('空输入不炸', buildPoRate([], {tDate:'D1'}).ok===false && buildPoRate().ok===false);
}

console.log('[4] ★ 两行分子对不上 → mismatch，但头条数字不受影响');
{
  // 支付单率的分子给 1300（比业务单那行的 1313 少），模拟脏数据
  const r = buildPoRate(pair('D1','独立站标准收银台', 3027, 1745, 1313, 1300), {tDate:'D1'}).rows[0];
  check('★ mismatch 标出来了', r.mismatch===true);
  check('头条：PO 单数仍取业务单那行', r.PO单数===3027);
  check('头条：成功单仍取业务单那行', r.成功单数===1313);
  check('★ 两段相加仍然等于总流失（不把残差藏进某一段）',
        r.支付前流失+r.支付中流失===r.总流失, `${r.支付前流失}+${r.支付中流失}≠${r.总流失}`);
}

console.log('[5] 多来源：排序看单量、合计、环比');
{
  const sc = [
    ...pair('D0','独立站API',        5000, 4900, 3000),
    ...pair('D0','独立站标准收银台',  3000, 1800, 1400),
    ...pair('D0','Element',          5000, 5000, 1300),
    ...pair('D1','独立站API',        5043, 4978, 2922),
    ...pair('D1','独立站标准收银台',  3027, 1745, 1313),
    ...pair('D1','Element',          5289, 5289, 1233),
  ];
  const g = buildPoRate(sc, {tDate:'D1', yDate:'D0'});
  check('三个来源都在', g.rows.length===3, String(g.rows.length));
  const loss = g.rows.map(r=>r.总流失);
  check('★ 按总流失单量从多到少排（看单量不看 pt）',
        loss.every((v,i)=>i===0||loss[i-1]>=v), JSON.stringify(g.rows.map(r=>[r.来源,r.总流失])));
  check('最大的是 Element（5289−1233=4056）', g.rows[0].来源==='Element' && g.rows[0].总流失===4056);

  const api = g.rows.find(r=>r.来源==='独立站API');
  check('环比：Δ支付前流失', api.Δ支付前流失===(5043-4978)-(5000-4900), String(api.Δ支付前流失));
  check('环比：Δ业务单率', Math.abs(api.Δ业务单率-(2922/5043-3000/5000))<1e-12);

  const t=g.total;
  check('合计 PO = 三家相加', t.PO单数===5043+3027+5289, String(t.PO单数));
  check('★ 合计也无残差', t.支付前流失+t.支付中流失===t.总流失);
  check('合计带环比', t.Δ支付前流失!=null);

  // 上期只有部分来源算得出来 → 不给合计环比（那是拿不同口径的两个数相减）
  const sc2 = sc.filter(o=>!(o['统计日期']==='D0' && o['来源']==='Element'));
  const t2 = buildPoRate(sc2, {tDate:'D1', yDate:'D0'}).total;
  check('★ 上期缺一个来源时不给合计环比', t2.Δ支付前流失===null && t2.上期===null,
        JSON.stringify({d:t2.Δ支付前流失, y:!!t2.上期}));
}

console.log('[6] ★ 本期没走完：不给单量环比，比率环比照给');
{
  const sc = [
    ...pair('2026-09','独立站API', 35278, 34343, 17874),   // 本期：月才过了几天
    ...pair('2026-08','独立站API', 60000, 58000, 30000),   // 上期：整整一个月
  ];
  const g = buildPoRate(sc, {tDate:'2026-09', yDate:'2026-08', latestDaily:'2026-09-06'});
  const r = g.rows[0];
  check('★ partial 标出来了', g.partial===true);
  check('★ 不给 Δ支付前流失（拿半个月比一个月，差的全是「还没发生」）',
        r.Δ支付前流失===null, String(r.Δ支付前流失));
  check('★ 不给 Δ支付中流失', r.Δ支付中流失===null, String(r.Δ支付中流失));
  check('★ 比率环比照给（本期比率是已发生那批单的真实比率）',
        r.Δ业务单率!=null && Math.abs(r.Δ业务单率-(17874/35278-30000/60000))<1e-12, String(r.Δ业务单率));
  check('★ 合计也一样不给单量环比', g.total.Δ支付前流失===null && g.total.Δ业务单率!=null);

  // 走完了就照常给 —— 别把这条做成「周月报一律不给」
  const g2 = buildPoRate(sc, {tDate:'2026-08', yDate:'2026-09', latestDaily:'2026-09-06'});
  check('★ 本期已走完时单量环比照给', g2.partial===false && g2.rows[0].Δ支付前流失!=null,
        JSON.stringify({p:g2.partial, d:g2.rows[0].Δ支付前流失}));
  // 不传 latestDaily 就判不出来 → 当成走完了（和 periodIncomplete 一致）
  check('没有 latestDaily 时不乱判', buildPoRate(sc, {tDate:'2026-09', yDate:'2026-08'}).partial===false);
}

console.log('[7] 走势：占比、期次自然序、缺期断线');
{
  const sc = [
    ...pair('2026 W9', '独立站API', 1000, 900, 500),
    ...pair('2026 W37','独立站API', 1000, 800, 500),
    ...pair('2026 W9', 'Element',   1000, 1000, 400),
    // Element 在 W37 只有业务单那行 → 算不出来，要断线
    row('2026 W37','Element','业务单支付成功率', 400, 1000),
  ];
  const tr = buildPoRateTrend(sc);
  check('★ 期次自然序：W9 在 W37 前面', tr.dates.join('|')==='2026 W9|2026 W37', tr.dates.join('|'));
  check('来源顺序按 ALLOWED_SOURCES 固定（颜色认实体不认名次）',
        tr.sources.join('|')==='独立站API|Element', tr.sources.join('|'));
  check('支付前占比 W9 = 100/500', Math.abs(tr.series['独立站API'][0]-100/500)<1e-12);
  check('支付前占比 W37 = 200/500', Math.abs(tr.series['独立站API'][1]-200/500)<1e-12);
  check('★ 缺支付单行的那一期断线（null，不是 0）', tr.series['Element'][1]===null,
        String(tr.series['Element'][1]));
  check('limit 生效', buildPoRateTrend(sc, {limit:1}).dates.length===1);
  check('没给 latestDaily 时 partial 全 false', tr.partial.every(x=>x===false), JSON.stringify(tr.partial));

  // 月报最后一期还没走完 → 要标出来（虚线 + *），不然会被读成「已经稳在这个水平了」
  const mo = buildPoRateTrend([...pair('2026-08','独立站API',1000,900,500),
                               ...pair('2026-09','独立站API',300,280,150)],
                              {latestDaily:'2026-09-06'});
  check('★ 没走完的那一期标出来了', mo.partial.join('|')==='false|true', mo.partial.join('|'));
}

console.log('[8] 真实报表（有 $WB_FIXTURES/real.xlsx 才跑）');
{
  const fs = await import('fs');
  const path = (process.env.WB_FIXTURES || (process.env.HOME + '/wb-fixtures')) + '/real.xlsx';
  if(!fs.existsSync(path)){
    console.log('  跳过：没有 ' + path);
  }else{
    const { readReport } = await import(MODULES + 'dataset.js');
    const ds = readReport(XLSX.read(fs.readFileSync(path), {type:'buffer'}));
    let groups=0, bad=[];
    for(const per of Object.keys(ds.scene||{})){
      const sc = ds.scene[per]||[];
      for(const dt of [...new Set(sc.map(o=>o['统计日期']))]){
        const g = buildPoRate(sc, {tDate:dt});
        for(const r of g.rows){
          groups++;
          if(r.支付前流失+r.支付中流失 !== r.总流失) bad.push(`${per} ${dt} ${r.来源} 残差`);
          if(r.mismatch) bad.push(`${per} ${dt} ${r.来源} 分子对不上`);
          if(Math.abs(r.业务单率 - r.环节1*r.支付单率) > 1e-9)
            bad.push(`${per} ${dt} ${r.来源} 业务单 ≠ 环节1×支付单`);
        }
      }
    }
    check('比了足够多组（否则等于没测）', groups>=40, String(groups));
    check('★ 真实数据上无残差、分子一致、恒等式成立',
          bad.length===0, bad.slice(0,5).join(' | '));
    console.log(`    实测 ${groups} 组（来源 × 期次 × 周期）`);
  }
}

check.report();
