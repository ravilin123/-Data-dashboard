/* 商户级独立探测（第四轮 B6）。
 *
 *     node tests/merchant_scan.mjs        # 不需要服务，也不需要 $WB_FIXTURES
 *
 * `detect()` 的循环是「遍历场景行 → 触发阈值 → 才拆商户」。一家中等商户彻底崩了、
 * 但被来源大盘稀释到没触发阈值，**它在异常明细里完全不存在** —— 而商户维度 sheet 里
 * 每个商户 × 每个指标的两期值本来就全在。
 *
 * 实测周报 2026 W37：整体少成 ≥5 单的 21 家里，**7 家在异常明细里一行都查不到，
 * 合计少成 139 单**。
 */
import { MODULES, installBrowserStubs, makeChecker } from './_harness.mjs';
installBrowserStubs();
const check = makeChecker();

const { scanMerchants, topLosers } = await import(MODULES + 'merchant_scan.js');
const { MERCHANT_SCAN_MIN_ORDERS, OVERALL_METRIC } = await import(MODULES + 'config.js');

/** 一行 merged。四个大环节：1 = 1.1×1.2，2/3/4 各有独立指标。 */
const row = (uid, po, t, y, overall, src='A') => ({
  来源:src, 用户ID:uid, 商户名称:'M'+uid, 站点:`https://${uid}.example.com`,
  'PO单数_今':po,
  '1.1 校验1通过率_今':t[0], '1.2 Paynow点击率_今':t[1],
  '2. 业务校验通过率_今':t[2], '3. 网关提交率_今':t[3], '4. 网关通过率_今':t[4],
  '1.1 校验1通过率_昨':y[0], '1.2 Paynow点击率_昨':y[1],
  '2. 业务校验通过率_昨':y[2], '3. 网关提交率_昨':y[3], '4. 网关通过率_昨':y[4],
  ...(overall ? {[OVERALL_METRIC+'_今']:overall[0], [OVERALL_METRIC+'_昨']:overall[1]} : {}),
});

/* 累乘：今 1×1×0.5×1×0.8 = 0.40，昨 1×1×0.5×1×0.9 = 0.45 */
const BIG   = row('BIG',  1000, [1,1,0.5,1,0.8], [1,1,0.5,1,0.9], [0.40,0.45]);
const SMALL = row('SMALL',  20, [1,1,0.5,1,0.5], [1,1,0.5,1,0.8], [0.25,0.40]);
const TINY  = row('TINY',  100, [1,1,0.5,1,0.8], [1,1,0.5,1,0.84],[0.40,0.42]);

console.log('[1] ★ 头条数字用源表的「业务单支付成功率」，累乘只用来归因');
{
  /* 累乘值和源表在 97 家真实商户里有 2 家对不上（个位数单量的脏数据：
     某个环节是 0 但源表整体不是 0）。源表那列是每家自己的权威值，
     而且「低于同行」那段（B14）用的也是它 —— 两处口径必须一致。 */
  const odd = row('ODD', 500, [0,1,1,1,1], [0,1,1,1,1], [0.30, 0.34]);
  const {rows} = scanMerchants([odd], true);
  const r = rows[0];
  check('★ 变动取源表的 30%−34%，不是累乘的 0%−0%',
        Math.abs(r['变动'] + 0.04) < 1e-9, r['变动']);
  check('少成 = 变动 × PO = 20 单', r['影响单量'] === -20, r['影响单量']);
  check('★ 累乘和源表对不上要标出来（归因不可全信）', r['口径存疑'] === true, r);
  check('对得上的不乱标', scanMerchants([BIG], true).rows[0]['口径存疑'] === false);
}

console.log('\n[2] ★ 按整体算，不按单个指标算（否则父子重复计数）');
{
  const {rows} = scanMerchants([BIG], true);
  const r = rows[0];
  // 环节4 从 0.9 掉到 0.8，前三环节没动 → 整体 0.45→0.40，少成 0.05×1000 = 50 单
  check('少成 50 单', r['影响单量'] === -50, r['影响单量']);
  check('★ 主因指到环节4', r['主因'] && r['主因'].code === '4', r['主因']);
  /* 逐指标算的话，「4. 网关通过率」和它下面的 4.1/4.2 会各算一遍同一批单 ——
     funnelStages 那套 telescoping 分解是无残差的，各环节贡献相加恰等于整体变动。 */
  check('主因的贡献就是整体变动（这里只有一个环节在动）',
        Math.abs(r['主因'].contrib - r['变动']) < 1e-9, [r['主因'].contrib, r['变动']]);
}

console.log('\n[3] 排序和门槛');
{
  const {rows} = scanMerchants([TINY, SMALL, BIG], true);
  check('★ 少成最多的排最前', rows.map(x=>x['用户ID']).join()==='BIG,SMALL,TINY',
        rows.map(x=>[x['用户ID'], x['影响单量']]));
  // SMALL 掉 15pt 但只有 20 单 → 少成 3 单；BIG 只掉 5pt 但 1000 单 → 50 单
  check('小商户掉得狠也排在后面（门槛看单量不看 pt）',
        rows[1]['影响单量'] === -3, rows[1]['影响单量']);
  const top = topLosers({rows}, 6);
  check(`★ 少成不足 ${MERCHANT_SCAN_MIN_ORDERS} 单的不进榜`,
        top.map(x=>x['用户ID']).join()==='BIG', top.map(x=>x['用户ID']));
  check('Top N 截断生效', topLosers({rows:[BIG,SMALL,TINY].map((_,i)=>
        ({用户ID:'X'+i, 影响单量:-100}))}, 2).length === 2);
}

console.log('\n[4] 变好的商户不给主因，也不进榜');
{
  const up = row('UP', 1000, [1,1,0.5,1,0.9], [1,1,0.5,1,0.8], [0.45,0.40]);
  const {rows} = scanMerchants([up], true);
  check('整体在涨', rows[0]['影响单量'] === 50, rows[0]['影响单量']);
  check('★ 涨的时候不给「主因」（这块只回答「谁掉了」）', rows[0]['主因'] === null, rows[0]['主因']);
  check('不进榜', topLosers({rows}, 6).length === 0);
}

console.log('\n[5] 算不出的要计数报上去，不能静默');
{
  // 既没有源表那列，四个环节也缺一个 → 整体算不出来
  const blind = {来源:'A', 用户ID:'B1', 商户名称:'M', 站点:'https://b1.example.com',
                 'PO单数_今':100, '2. 业务校验通过率_今':0.5, '2. 业务校验通过率_昨':0.6};
  const {rows, noBase} = scanMerchants([blind, BIG], true);
  check('★ 算不出的那家计了数', noBase === 1, noBase);
  check('算得出的照常在', rows.length === 1 && rows[0]['用户ID']==='BIG', rows.map(x=>x['用户ID']));
  check('PO 为 0 的直接跳过（连分母都没有）',
        scanMerchants([{...BIG, 'PO单数_今':0}], true).rows.length === 0);
  check('空输入不炸', scanMerchants([], true).rows.length === 0
        && scanMerchants(null, true).noBase === 0);
}

console.log('\n[6] ★ 榜上要能看出「异常明细里查不到」的那批');
{
  const { state } = await import(MODULES + 'store.js');
  const scan = scanMerchants([BIG, SMALL], true);
  // 只有 BIG 进过 drill
  const drill = [{来源:'A', 用户ID:'BIG', 异常指标:'4. 网关通过率'}];
  const inDrill=new Set(drill.map(r=>r['来源']+'|'+r['用户ID']));
  const marked = topLosers(scan, 6).map(x=>({...x, inDrill:inDrill.has(x['来源']+'|'+x['用户ID'])}));
  check('BIG 在明细里', marked[0].inDrill === true, marked[0]);
  /* 这一条正是 B6 的全部意义：老做法是对 drill 做聚合，
     没进 drill 的商户聚合再怎么做也救不回来。 */
  const scan2 = scanMerchants([BIG, row('GHOST', 2000, [1,1,0.5,1,0.85], [1,1,0.5,1,0.9], [0.425,0.45])], true);
  const ghost = topLosers(scan2, 6).find(x=>x['用户ID']==='GHOST');
  check('★ 没进过 drill 的大商户照样上榜', ghost && ghost['影响单量'] === -50, ghost);
  state.data = null;
}

console.log('\n[N] ★ 跨来源商户按来源分开算，**不合并**（B9：核过了，不做）');
{
  /* 计划里的 B9 是「上游有 来源=合计 的真值行，商户视图里它就是标准答案」。
     核过了，**不做** —— 两个理由，都有实测数据：

     1. **收益接近零。** 拿真实报表比过：vigorbuy.com 在两个来源下
        99 单 49.02% / 1073 单 42.03%，上游合计行是 42.64%，
        而现在按 PO 加权算出来是 42.62% —— 差 **0.02pt**。
        影响面也极小：日报 77 家里只有 2 家跨来源，周报 2/97，月报 3/116。

     2. **拆开反而更有诊断价值。**（用户 2026-09-09 定的：「不合并，跨来源商户，
        按来源做单独分析」。）同一个商户在两个来源差 8pt
        （月报 53.09% vs 44.83%），合并成 45.61% 正好把这个信息抹掉 ——
        而「同一家店换个收银台就好 8pt」恰恰是最该查的那种线索。

     所以这条用例钉的是**故意的行为**：同一个用户ID 出现在两个来源时，
     scanMerchants 产出两条独立记录，各来源各算各的。
     以后有人照着计划文档来「修」成合并的话，这里会挂。 */
  const merged=[
    // 同一个用户ID、同一个站点，两个来源；两边跌幅不同
    row('U1', 1073, [1,1,0.5,1,0.80], [1,1,0.5,1,0.90], null, '独立站标准收银台'),
    row('U1',   99, [1,1,0.5,1,0.88], [1,1,0.5,1,0.90], null, '独立站API'),
    row('U2',  500, [1,1,0.5,1,0.80], [1,1,0.5,1,0.90], null, '独立站API'),
  ];
  const scan=scanMerchants(merged, true);
  const mine=scan.rows.filter(r=>r['用户ID']==='U1');
  check('★ 跨来源的商户是两条，不是一条', mine.length===2, scan.rows.map(r=>[r['用户ID'],r['来源']]));
  check('★ 两条各自带自己的来源',
        mine.map(r=>r['来源']).sort().join()==='独立站API,独立站标准收银台',
        mine.map(r=>r['来源']));
  check('★ 单量没被加到一起（各算各的）',
        mine.map(r=>r['PO单数']).sort((a,b)=>a-b).join()==='99,1073',
        mine.map(r=>r['PO单数']));
  /* 折损单量各算各的：1073 单跌 10pt ≈ −107，99 单跌 2pt ≈ −2。
     合并的话会变成一个 1172 单的加权值，两边差 8pt 这个信息就没了。 */
  check('★ 两条的折损单量分别算，不是一个合并值',
        new Set(mine.map(r=>r['影响单量'])).size===2,
        mine.map(r=>[r['来源'], r['影响单量']]));
  check('★ 大的那条跌得多、小的那条跌得少（差 8pt 这个信息留住了）',
        Math.abs(mine.find(r=>r['来源']==='独立站标准收银台')['变动'])
        > Math.abs(mine.find(r=>r['来源']==='独立站API')['变动']),
        mine.map(r=>[r['来源'], r['变动']]));
  check('别的商户不受影响', scan.rows.filter(r=>r['用户ID']==='U2').length===1);
}

check.report();