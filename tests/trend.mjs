/* 多期趋势（B5）。
 *
 *     node tests/trend.mjs        # 不需要服务，也不需要 $WB_FIXTURES
 *
 * 兜三件在图上**看不出错**的事：
 *   1. 期次顺序。周报写成 `2026 W9` / `2026 W37`，字典序会把 W9 排到 W37 后面 ——
 *      折线照画，只是讲了个假故事。
 *   2. 缺环节时的整体成功率。funnelStages 缺一环按 1.0 跳过（瀑布图要的就是这个），
 *      拿来画折线就成了「那一期凭空跳高」。这里钉住：缺就断线，不给数。
 *   3. 纵轴范围。第一版把 lo/hi 撑到刻度线上，0.17~0.63 一撑就是 0~80%，
 *      八期数据挤在中间三分之一 —— 图没错，但要看的那点变化被压没了。
 * 外加一条颜色的：取色按 ALLOWED_SOURCES 的下标，某个来源整个没数据时
 * 剩下两条**不许换色**。
 */
import { MODULES, installBrowserStubs, makeChecker } from './_harness.mjs';
const XLSX = installBrowserStubs();
const check = makeChecker();

const { buildTrend, cmpPeriod } = await import(MODULES + 'trend.js');
const { colorOf, domainOf, niceStep, tickLabel } = await import(MODULES + 'render/trend.js');
const { readReport } = await import(MODULES + 'dataset.js');
const { analyze }    = await import(MODULES + 'analyze.js');

/* ---- 场景维度直接写字面量：buildTrend 吃的就是这个形状，不必为它造 xlsx ---- */
const M = {ck:'1.1 校验1通过率', pn:'1.2 Paynow点击率', biz:'2. 业务校验通过率',
           sub:'3. 网关提交率', gw:'4. 网关通过率'};
const BASE = {
  '独立站API':       {ck:0.99, pn:0.98, biz:0.97, sub:0.96, gw:0.60},
  '独立站标准收银台': {ck:0.99, pn:0.60, biz:0.99, sub:0.94, gw:0.80},
  'Element':         {ck:0.99, pn:0.99, biz:0.30, sub:0.92, gw:0.85},
};
const D = ['2026-09-03','2026-09-04','2026-09-05','2026-09-06'];

/** @param skip {date, src, metric}[] —— 故意不给这一行，制造缺口 */
function scene(dates, skip=[]){
  const gone = new Set(skip.map(s=>`${s.date}|${s.src}|${s.metric||'*'}`));
  const rows=[];
  dates.forEach((d,i)=>{
    for(const [src,r] of Object.entries(BASE)){
      if(gone.has(`${d}|${src}|*`)) continue;
      for(const [k,m] of Object.entries(M)){
        if(gone.has(`${d}|${src}|${m}`)) continue;
        // 只让 gw 随期次动，其余固定 —— 期望值算得出来，断言才有意义
        const v = k==='gw' ? r.gw + i*0.01 : r[k];
        rows.push({'统计日期':d, '来源':src, '类型':m, '当期值':v,
                   _n: k==='ck' ? Math.round(1000*v) : null, _d: k==='ck' ? 1000+i : null});
      }
    }
  });
  return rows;
}
const overallOf = (src,i) => {
  const r=BASE[src];
  return r.ck*r.pn*r.biz*r.sub*(r.gw+i*0.01);
};

console.log('[1] ★ 期次自然序 —— 周报 W9 排在 W37 前面');
{
  check('cmpPeriod 认数字不认字符', cmpPeriod('2026 W9','2026 W37') < 0,
        `字典序会判成 ${'2026 W9' < '2026 W37'}`);
  check('日报照样对', cmpPeriod('2026-08-31','2026-09-01') < 0);
  check('月报照样对', cmpPeriod('2026-09','2026-10') < 0);
  const wk=['2026 W37','2026 W9','2026 W10'].flatMap(d=>scene([d]).map(r=>({...r,'统计日期':d})));
  const t=buildTrend(wk);
  check('★ buildTrend 排出 W9 → W10 → W37',
        t.dates.join(' | ') === '2026 W9 | 2026 W10 | 2026 W37', t.dates);
}

console.log('\n[2] 形状：期数、来源顺序、每条序列和期次等长');
{
  const t=buildTrend(scene(D));
  check('四期', t.dates.join()===D.join(), t.dates);
  check('来源按 ALLOWED_SOURCES 固定顺序，不按表里出现的顺序',
        t.sources.join()==='独立站API,独立站标准收银台,Element', t.sources);
  check('五条度量（整体 + 四个大环节）',
        t.measures.map(m=>m.key).join()==='overall,1,2,3,4', t.measures.map(m=>m.key));
  const lens=new Set();
  for(const m of t.measures) for(const s of t.sources) lens.add(t.series[m.key][s].length);
  check('每条序列都和期次等长', lens.size===1 && lens.has(4), [...lens]);
  check('PO 取 1.1 的分母', t.po['独立站API'].join()==='1000,1001,1002,1003', t.po['独立站API']);
}

console.log('\n[3] 整体成功率 = 四个大环节累乘');
{
  const t=buildTrend(scene(D));
  const got=t.series.overall['独立站API'];
  const want=D.map((_,i)=>overallOf('独立站API',i));
  check('逐期对得上', got.every((v,i)=>Math.abs(v-want[i])<1e-12), {got, want});
  check('末期比首期高（gw 每期 +1pt）', got[3]>got[0], got);
  check('大环节序列取的是各自的比率',
        Math.abs(t.series['4']['独立站API'][2] - 0.62) < 1e-12, t.series['4']['独立站API']);
}

console.log('\n[4] ★ 缺一个大环节 → 断线，不是「按 1.0 跳过」后的虚高值');
{
  const t=buildTrend(scene(D, [{date:D[3], src:'Element', metric:M.sub}]));
  const o=t.series.overall['Element'];
  const inflated=BASE.Element.ck*BASE.Element.pn*BASE.Element.biz*(BASE.Element.gw+0.03);
  check('★ 末期整体是 null', o[3]===null, o);
  check('★ 不是少乘一环的那个虚高值',
        o[3]!==inflated && !(o[3]>overallOf('Element',3)), {got:o[3], inflated});
  check('缺的那个大环节自己也是 null', t.series['3']['Element'][3]===null, t.series['3']['Element']);
  check('其余来源不受影响', t.series.overall['独立站API'][3]!=null);
}

console.log('\n[5] 某来源某期整个没数据 → 中间留一个洞');
{
  const t=buildTrend(scene(D, [{date:D[1], src:'独立站标准收银台'}]));
  const o=t.series.overall['独立站标准收银台'];
  check('中间那期是 null', o[1]===null, o);
  check('两头都还在', o[0]!=null && o[2]!=null && o[3]!=null, o);
  check('来源仍然在名单里（不是整个消失）', t.sources.includes('独立站标准收银台'), t.sources);
}

console.log('\n[6] ★ 颜色认来源不认名次');
{
  const c1=colorOf('独立站API'), c2=colorOf('独立站标准收银台'), c3=colorOf('Element');
  check('三支各不相同', new Set([c1,c2,c3]).size===3, [c1,c2,c3]);
  // 中间那个来源整期没数据时，buildTrend 会把它从 sources 里去掉
  const t=buildTrend(scene(D).filter(r=>r['来源']!=='独立站标准收银台'));
  check('少了中间那个来源', t.sources.join()==='独立站API,Element', t.sources);
  check('★ 剩下两条颜色不变', colorOf(t.sources[0])===c1 && colorOf(t.sources[1])===c3,
        [colorOf(t.sources[0]), colorOf(t.sources[1])]);
}

console.log('\n[7] 本期还没走完 → 标出来');
{
  const t=buildTrend(scene(D), {latestDaily:'2026-09-05'});
  check('走完的那几期不标', t.partial.slice(0,3).every(x=>!x), t.partial);
  check('最新那期（晚于最新日报）标出来', t.partial[3]===true, t.partial);
  const mon=[{'统计日期':'2026-09','来源':'Element','类型':M.gw,'当期值':0.8}];
  check('月报按窗口结束日判', buildTrend(mon,{latestDaily:'2026-09-06'}).partial[0]===true);
  check('不知道最新日报就不瞎标', buildTrend(scene(D)).partial.every(x=>!x));
}

console.log('\n[8] ★ 纵轴：不把范围撑到刻度线上');
{
  const d=domainOf([0.2204, 0.5794, 0.43]);
  check('★ 下界没被撑到 0', d.lo>0.1 && d.lo<0.2204, d);
  check('★ 上界没被撑到 0.8', d.hi<0.7 && d.hi>0.5794, d);
  const n=Math.floor(d.hi/d.step)-Math.ceil(d.lo/d.step)+1;
  check('网格线 2~6 条', n>=2 && n<=6, {n, step:d.step});
  check('刻度是整齐数', [0.05,0.1,0.2,0.25].includes(d.step), d.step);

  const flat=domainOf([0.5,0.5,0.5]);
  check('全都一样高也不除以 0', flat && flat.hi>flat.lo, flat);
  const tiny=domainOf([0.9502,0.9518,0.9509]);
  check('小幅波动能撑开', tiny.hi-tiny.lo < 0.01, tiny);
  check('比率不画到负数', domainOf([0.001,0.004]).lo>=0, domainOf([0.001,0.004]));
  check('没有可画的就返回 null', domainOf([null,undefined])===null);
  check('niceStep 单调', niceStep(0.5,6)>=niceStep(0.05,6));
}

console.log('\n[9] 横轴标签：日报去年份、周报只留 W');
{
  check('日报', tickLabel('2026-09-06')==='09-06');
  check('周报', tickLabel('2026 W37 (2026-09-04~2026-09-10)')==='W37');
  check('月报原样', tickLabel('2026-09')==='2026-09');
}

console.log('\n[10] 接线：analyze 的结果里带 trend');
{
  const sc=[['时间类别','统计日期','来源','类型','当期值','分子/分母']];
  for(const d of D) for(const [src,r] of Object.entries(BASE))
    for(const [k,m] of Object.entries(M))
      sc.push(['日报', d, src, m.replace(/^[\d.]+\s*/,''), r[k], '900/1000']);
  const mh=['时间类别','统计日期','用户ID','站点','来源','PO单数','网关通过率'];
  const mr=[mh];
  for(const d of D) mr.push(['日报', d, 'U1', 'https://u1.example.com', '独立站API', 100, 0.6]);
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sc), '场景维度');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(mr), '商户维度');
  const r=analyze(readReport(wb), {period:'日报', tDate:D[3], yDate:D[2]});
  check('analyze 带回 trend', !!r.trend && r.trend.dates.length===4, r.trend && r.trend.dates);
  check('整体成功率算得出来', r.trend.series.overall['独立站API'][0]!=null,
        r.trend.series.overall['独立站API']);
}

check.report();
