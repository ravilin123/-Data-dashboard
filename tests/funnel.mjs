/* 漏斗核心：funnelStages 的分解式、toRate 的量纲、逆算链。
 *
 *     node tests/funnel.mjs        # 不需要服务，也不需要 $WB_FIXTURES
 *
 * 这三样是整条链路的地基，错了不会报错、只会一路把数算歪：
 *   · funnelStages 的「贡献分解」声称对 i 求和恒等于整体差额（telescoping，无残差）。
 *     这条性质是瀑布图和播报归因的全部依据 —— 一旦有残差，「拉低整体 −1.59pt」
 *     这种话就是编的。这里用随机数据反复验它。
 *   · toRate 是 `docs/坑.md` §3（索引在 CLAUDE.md）：用错 num() 会两级放大，
 *     两级都不报错（9999.00% 或被裁成整齐的 150.00%）。
 *   · chainDenom / calcFunnel 是单量逆算，商户明细和影响排序都建在它上面。
 */
import { MODULES, installBrowserStubs, makeChecker } from './_harness.mjs';
installBrowserStubs();
const check = makeChecker();

const { funnelStages, toRate, mainRate, chainDenom, calcFunnel, hasDenomChain }
  = await import(MODULES + 'funnel.js');

const near = (a, b, eps=1e-12) => a != null && b != null && Math.abs(a - b) < eps;

console.log('[1] toRate：按形态判量纲（CLAUDE.md 会咬人 #3）');
{
  const cases = [
    ['小数原样用',              0.8257,    0.8257],
    ['1.5 是边界，仍当小数',    1.5,       1.5],
    ['超过 1.5 的数值当百分数', 84.57,     0.8457],
    ['带 % 的文本除 100',       '84.57%',  0.8457],
    ['带 % 的小数也除 100',     '0.82%',   0.0082],
    ['不带 % 的小数文本',       '0.8257',  0.8257],
    ['不带 % 的大数文本',       '84.57',   0.8457],
    ['带千分位',                '1,234%',  12.34],
    ['空串给 null',             '',        null],
    ['null 给 null',            null,      null],
    ['非数字给 null',           'N/A',     null],
  ];
  for (const [name, input, want] of cases) {
    const got = toRate(input);
    const ok = want === null ? got === null : near(got, want, 1e-9);
    check(name, ok, `toRate(${JSON.stringify(input)}) = ${got}`);
  }
  // 这一条钉住「别改回 num()」：num 只抹 %，不除 100
  check('★ 99.99% 不能读成 99.99', near(toRate('99.99%'), 0.9999, 1e-9), toRate('99.99%'));
}

console.log('[2] mainRate：环节1 没有独立指标，等于 1.1 × 1.2');
{
  const S1 = {code:'1', parts:['1.1 校验1通过率','1.2 Paynow点击率']};
  const S2 = {code:'2', metric:'2. 业务校验通过率'};
  check('两个子项相乘', near(mainRate({'1.1 校验1通过率':0.9,'1.2 Paynow点击率':0.8}, S1), 0.72),
        mainRate({'1.1 校验1通过率':0.9,'1.2 Paynow点击率':0.8}, S1));
  check('缺任一子项则整段不可算', mainRate({'1.1 校验1通过率':0.9}, S1) === null);
  check('有独立指标就直接取', near(mainRate({'2. 业务校验通过率':0.95}, S2), 0.95));
  check('独立指标缺失给 null', mainRate({}, S2) === null);
}

/** 造一份「某来源某期」的指标表 */
const mk = (a, b, c, d) => ({
  '1.1 校验1通过率': a, '1.2 Paynow点击率': b,
  '2. 业务校验通过率': c, '3. 网关提交率': d, '4. 网关通过率': 0.85,
});

console.log('[3] funnelStages：累乘与缺失环节');
{
  const f = funnelStages(mk(0.9,0.8,0.95,0.9), mk(0.9,0.8,0.95,0.9));
  check('四个大环节都在', f.stages.length === 4, f.stages.length);
  check('环节1 = 1.1×1.2', near(f.stages[0].rateT, 0.72), f.stages[0].rateT);
  check('overallT = 各环节累乘', near(f.overallT, 0.72*0.95*0.9*0.85), f.overallT);
  check('两期相同则整体差额为 0', near(f.dOverall, 0), f.dOverall);

  // 缺失环节按 1.0 跳过
  const miss = funnelStages({'2. 业务校验通过率':0.95,'3. 网关提交率':0.9,'4. 网关通过率':0.85}, {});
  check('缺环节按 1.0 跳过', near(miss.overallT, 0.95*0.9*0.85), miss.overallT);
  check('缺上期则不做分解', miss.overallY === null && miss.dOverall === null,
        JSON.stringify({overallY:miss.overallY, dOverall:miss.dOverall}));
  check('不做分解时没有 contrib', miss.stages.every(s=>s.contrib === undefined));
}

console.log('[4] ★ 分解式无残差：Σ contrib 恒等于 overallT − overallY');
{
  /* 注释里写的性质：贡献_i = (∏_{j<i} r今_j)(r今_i − r昨_i)(∏_{j>i} r昨_j)，
     对 i 求和是 telescoping，恒等于 ∏r今 − ∏r昨。
     瀑布图上每段标的「拉低整体 −X pt」和播报里的归因全部依赖这条 ——
     有残差就意味着那些数字对不上账。用一批伪随机数据反复验。 */
  let worst = 0, n = 0;
  let seed = 20260908;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 500; i++) {
    const r = () => 0.05 + rnd() * 0.9;
    const f = funnelStages(mk(r(),r(),r(),r()), mk(r(),r(),r(),r()));
    const sum = f.stages.reduce((s,x)=>s + x.contrib, 0);
    worst = Math.max(worst, Math.abs(sum - f.dOverall)); n++;
  }
  check(`${n} 组随机数据，残差最大 ${worst.toExponential(2)}`, worst < 1e-12, worst);

  // 单看一组，确认每段 contrib 的符号方向：本期更差 → 负贡献
  const f = funnelStages(mk(0.9,0.8,0.95,0.80), mk(0.9,0.8,0.95,0.90));
  const s3 = f.stages[2];   // 环节3 网关提交率 0.90 → 0.80
  check('变差的环节贡献为负', s3.contrib < 0, s3.contrib);
  check('dodRel 是相对环比', near(s3.dodRel, (0.80-0.90)/0.90), s3.dodRel);
  check('没动的环节贡献为 0', near(f.stages[1].contrib, 0), f.stages[1].contrib);
}

console.log('[5] 逆算链 chainDenom / calcFunnel');
{
  /* merged 行的形状：指标带 _今/_昨 后缀，PO单数 是链条起点。
     DEPS 里 '1.1 校验1通过率' 的分母就是 PO单数。 */
  const row = {'PO单数_今':1000, '1.1 校验1通过率_今':0.9, '1.2 Paynow点击率_今':0.8,
               '2. 业务校验通过率_今':0.95};
  check('链条起点是 PO单数', near(chainDenom(row,'1.1 校验1通过率','_今'), 1000),
        chainDenom(row,'1.1 校验1通过率','_今'));
  check('第二环的分母 = 上一环的分子', near(chainDenom(row,'1.2 Paynow点击率','_今'), 900),
        chainDenom(row,'1.2 Paynow点击率','_今'));
  const [d,nn] = calcFunnel(row,'1.2 Paynow点击率','_今');
  check('calcFunnel 给出 进入/通过', near(d,900) && near(nn,720), `${d}/${nn}`);
  /* hasDenomChain 只吃指标名 —— 它问的是 DEPS 这张图上能不能一路走到 PO单数，
     和某一行有没有数据无关。（第一版把 row 当第一个参数传了，两条断言一起假绿：
     DEPS[row] 是 undefined，所以一律返回 false，"为假"那条就这么"通过"了。） */
  check('能一路走到 PO单数', hasDenomChain('2. 业务校验通过率') === true);
  check('复合指标没有自己的分母', hasDenomChain('1. 业务单支付转化率') === false);
  check('SPECIAL_DENOM 里的算有链', hasDenomChain('4.1 非3DS网关通过率') === true);
  check('不认识的指标为假', hasDenomChain('不存在的指标') === false);
}

console.log('\n[N] ★ 支付单支付成功率 = 环节 2×3×4（B7 口径，核实了）');
{
  /* 计划里的 B7 写着「支付单支付成功率一次都没被分析过（待核）」，
     并猜测它的含义是「单笔业务单要试更多次才能成」。**那个猜测是错的。**

     拿两份真实报表的 172 组（来源 × 期次 × 三个周期）逐个比过：

         支付单支付成功率 = 环节2 × 环节3 × 环节4     172/172 成立，最大偏差 0.011pt
         业务单支付成功率 = 环节1 × 支付单支付成功率

     也就是说它是「**进了支付流程之后**的成功率」，把环节1（业务单 → 支付单的转化，
     即校验1 × Paynow点击）排除在外。不是重试口径，和重试没关系。

     业务含义因此很确定：
       业务单低、支付单高  → 问题在**支付之前**（用户没走到支付这步）
       两个都低            → 问题在**支付链路**（风控 / 网关 / 3DS）

     实测 2026-09-06 独立站标准收银台：业务单 43.38%、支付单 75.24%，
     差 31.86pt 全在环节1 —— 四成的业务单根本没走到支付。
     这是「业务单支付成功率」这个数字本身看不出来的。 */
  const mm={
    '1.1 校验1通过率':0.97, '1.2 Paynow点击率':0.62,     // 环节1 = 0.6014
    '2. 业务校验通过率':0.98, '3. 网关提交率':0.94, '4. 网关通过率':0.86,
  };
  const f=funnelStages(mm, {});
  const st=c=>f.stages.find(x=>x.code===c).rateT;
  const pay=st('2')*st('3')*st('4');
  check('★ 支付单 = 2×3×4', Math.abs(pay-0.98*0.94*0.86)<1e-12, pay);
  check('★ 业务单 = 环节1 × 支付单', Math.abs(f.overallT-st('1')*pay)<1e-12,
        {业务单:f.overallT, 环节1:st('1'), 支付单:pay});
  check('★ 支付单永远 ≥ 业务单（环节1 ≤ 1）', pay>=f.overallT, {pay, biz:f.overallT});
  // 环节1 = 1 时两者相等 —— 实测 Element 正是这种（99.99%）
  const g=funnelStages({...mm, '1.1 校验1通过率':1, '1.2 Paynow点击率':1}, {});
  check('★ 环节1 满分时两个率相等（Element 就是这样）',
        Math.abs(g.overallT-pay)<1e-12, {业务单:g.overallT, 支付单:pay});
}

check.report();