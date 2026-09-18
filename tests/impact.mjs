/* 折损单量：把各环节折算到同一把尺子上（第四轮 B1 + B2 + B12）。
 *
 *     node tests/impact.mjs        # 不需要服务，也不需要 $WB_FIXTURES
 *
 * 三件事一起测，因为它们是同一处代码：
 *
 *  B1  所有排序原来都在**比率空间** —— 影响比率、重点商户、播报优先级，
 *      没有一个是按单量排的。「大来源掉 0.5pt」和「小来源掉 5pt」谁更该先看，
 *      页面给不出答案，而这个答案本来算得出来。
 *  B2  `影响比率` 是**该指标自己那一层**的 pt，跨环节根本不可比：
 *      `2. 业务校验通过率` 掉 1pt 下游几乎全量承接，`4.2.2` 掉 10pt 可能不到 0.2pt。
 *      两条以前按同一个 `_impact_abs` 排在一张表里 —— 深层指标因为分母小、波动大，
 *      **系统性地排在前面**，排序本身在骗人。
 *  B12 3 单里失败 1 单 = 100.00%→33.33%，一个 66pt 的变动，真实含义只是「有一单没成」。
 *      实测日报 2026-09-06：42 条下钻里 17 条不足 50 单。
 */
import { MODULES, installBrowserStubs, makeChecker } from './_harness.mjs';
installBrowserStubs();
const check = makeChecker();

const { downstreamPass, funnelStages, orderImpact } = await import(MODULES + 'funnel.js');
const { drillMetric } = await import(MODULES + 'detect.js');
const { ordFmt } = await import(MODULES + 'util.js');
const { SMALL_MERCHANT_PO } = await import(MODULES + 'config.js');

/* 一个走得通的四环节漏斗。数字挑成整的，好手算：
   1.1=1.0  1.2=1.0  2.=0.5  3.=1.0  4.=0.9  →  整体 0.45 */
const T = {'1.1 校验1通过率':1.0, '1.2 Paynow点击率':1.0,
           '2. 业务校验通过率':0.5, '3. 网关提交率':1.0, '4. 网关通过率':0.9};
const Y = {...T, '2. 业务校验通过率':0.6, '4. 网关通过率':1.0};   // 两个都跌 0.1
const F = funnelStages(T, Y);

console.log('[1] downstreamPass：该环节之后还要过几关');
{
  // 2. 在环节2 → 下游是环节3(1.0) × 环节4(0.9)
  check('环节2 的下游 = 0.9', Math.abs(downstreamPass(F,'2. 业务校验通过率')-0.9)<1e-9,
        downstreamPass(F,'2. 业务校验通过率'));
  check('环节4 已经是最后一关，下游 = 1', downstreamPass(F,'4. 网关通过率')===1,
        downstreamPass(F,'4. 网关通过率'));
  check('环节4 的子指标也是 1', downstreamPass(F,'4.2.2 政策3DS网关通过率')===1);
  check('不认识的指标给 1（不改变结果，也不炸）', downstreamPass(F,'不存在的指标')===1);
  check('没有 stages 时给 1', downstreamPass(null,'2. 业务校验通过率')===1);
}

console.log('\n[2] orderImpact：Δ × 分母 × 下游');
{
  check('基本算式', orderImpact(-0.1, 1000, 0.9) === -90, orderImpact(-0.1, 1000, 0.9));
  check('没有分母链就不编数', orderImpact(-0.1, null, 0.9) === null);
  check('NaN 不往下传', orderImpact(NaN, 1000, 0.9) === null);
  check('下游缺省当 1', orderImpact(-0.1, 1000, undefined) === -100);
}

/* ---------- 造两家商户 ---------- */
const row = (uid, po, over={}) => ({
  来源:'独立站API', 用户ID:uid, 商户名称:'M'+uid, 站点:`https://${uid}.example.com`,
  'PO单数_今':po, 'PO单数_昨':po,
  ...Object.fromEntries(Object.entries(T).map(([k,v])=>[k+'_今', v])),
  ...Object.fromEntries(Object.entries(Y).map(([k,v])=>[k+'_昨', v])),
  ...over,
});
const BIG = row('U1', 1000);
const opts = m => ({isF:false, totalPO:1005, hasSite:true, stages:F});

console.log('\n[3] ★ B2：同样跌 0.1，浅环节比深环节贵 —— 老口径把它们判成一样重');
{
  const shallow = drillMetric([BIG], '独立站API', '2. 业务校验通过率', opts())[0];
  const deep    = drillMetric([BIG], '独立站API', '4. 网关通过率',    opts())[0];
  // 手算：环节2 分母 = 1000×1×1 = 1000，下游 0.9 → −90
  //       环节4 分母 = 1000×1×1×0.5×1 = 500，下游 1 → −50
  check('环节2 少成 90 单', shallow['影响单量'] === -90, shallow['影响单量']);
  check('环节4 少成 50 单', deep['影响单量'] === -50, deep['影响单量']);
  // ★ 老口径 = PO占比 × Δ，两条完全相同 —— 排序在这两条之间给不出任何信息
  check('★ 老口径把两条判成一模一样',
        shallow['影响比率'] === deep['影响比率'], [shallow['影响比率'], deep['影响比率']]);
  check('★ 新口径分得开，且浅的更贵',
        Math.abs(shallow['影响单量']) > Math.abs(deep['影响单量']));
  check('折算到大盘的 pt 也跟着走',
        shallow['对大盘影响'].includes('8.96pt') && deep['对大盘影响'].includes('4.98pt'),
        [shallow['对大盘影响'], deep['对大盘影响']]);
}

console.log('\n[4] ★ B1：排序按折损单量，不再被小商户的大百分比带偏');
{
  /* 小商户：5 单，通过率 100%→20%（−80pt，看着比谁都吓人）
     大商户：1000 单，只掉 0.1pt —— 但它是 1000 单 */
  const small = row('U2', 5,    {'4. 网关通过率_今':0.2,   '4. 网关通过率_昨':1.0});
  const big   = row('U1', 1000, {'4. 网关通过率_今':0.999, '4. 网关通过率_昨':1.0});
  const rows = drillMetric([small, big], '独立站API', '4. 网关通过率',
                           {isF:false, totalPO:1005, hasSite:true, stages:F});
  const by = Object.fromEntries(rows.map(r=>[r['用户ID'], r]));
  // 手算：大 = 0.001 × (1000×0.5) = 0.5 单；小 = 0.8 × (5×0.5) = 2 单
  check('大商户折损不足 1 单', Math.abs(by.U1['影响单量']) <= 1, by.U1['影响单量']);
  check('小商户折损 2 单', by.U2['影响单量'] === -2, by.U2['影响单量']);
  // ★ 老口径：小 5/1005×0.8 = 0.398%，大 1000/1005×0.001 = 0.0995% —— 小的大四倍。
  //   于是「5 单里坏了 4 单」被排在「1000 单的商户」前面，凭的是一个百分比。
  const oldKey = r => Math.abs(parseFloat(r['影响比率']));
  check('★ 老口径下小商户的「影响」是大商户的四倍',
        oldKey(by.U2) > oldKey(by.U1)*3, [by.U1['影响比率'], by.U2['影响比率']]);
  check('新口径按单量排，5 单最多也就折损 5 单 —— 量级自己压得住',
        rows[0]['用户ID'] === 'U2' && Math.abs(rows[0]['影响单量']) === 2, rows.map(r=>r['用户ID']));
}

console.log('\n[5] ★ B12：小样本标出来，但只在「算不出单量」时才沉底');
{
  const small = row('U2', 5, {'4. 网关通过率_今':0.2, '4. 网关通过率_昨':1.0});
  const rows = drillMetric([small, BIG], '独立站API', '4. 网关通过率', opts());
  check('★ 小商户被标了「样本少」', rows.find(r=>r['用户ID']==='U2')._small === true);
  check('大商户没被误标', rows.find(r=>r['用户ID']==='U1')._small === false);
  check(`门槛就是 ${SMALL_MERCHANT_PO} 单（等于不算小）`,
        drillMetric([row('U3', SMALL_MERCHANT_PO, {'4. 网关通过率_今':0.5}), BIG],
                    '独立站API','4. 网关通过率', opts())
          .find(r=>r['用户ID']==='U3')._small === false);

  /* ★ 有折损单量时**不**沉底 —— 折损单量的上界就是这家自己的单量，
     量级排序天然压得住小商户；再额外沉一次，万一它真是当天最大的一笔损失就漏报了。
     这里 BIG 折损 50 单、小商户 2 单，所以大的在前；[4] 里把 BIG 的 Δ 调小之后
     小商户就排到了前面 —— 排序只认量级，不认样本大小。 */
  check('样本大小不参与排序，只看折损单量',
        Math.abs(rows[0]['影响单量']) >= Math.abs(rows[1]['影响单量']),
        rows.map(r=>[r['用户ID'], r['影响单量']]));
  const flipped = drillMetric([small, row('U1', 1000, {'4. 网关通过率_今':0.999})],
                              '独立站API', '4. 网关通过率', opts());
  check('★ 小商户折损更多时它就排前面（不埋）',
        flipped[0]['用户ID'] === 'U2' && flipped[0]._small === true,
        flipped.map(r=>[r['用户ID'], r['影响单量'], r._small]));

  /* 摩擦类退回影响比率，那个没有天花板（PO占比 × Δ，Δ 能到 80pt），
     样本量是唯一还站得住的判据 —— 这时候才沉底。 */
  const frBig   = row('U1', 1000, {'3.2 3DS交易占比_今':0.31, '3.2 3DS交易占比_昨':0.30,
                                   '3.1 风控综合通过率_今':1.0, '3.1 风控综合通过率_昨':1.0});
  const frSmall = row('U2', 5,    {'3.2 3DS交易占比_今':0.90, '3.2 3DS交易占比_昨':0.10,
                                   '3.1 风控综合通过率_今':1.0, '3.1 风控综合通过率_昨':1.0});
  const fr = drillMetric([frSmall, frBig], '独立站API', '3.2 3DS交易占比',
                         {isF:true, totalPO:1005, hasSite:true, stages:F});
  check('★ 算不出单量时小样本沉底', fr[0]['用户ID'] === 'U1', fr.map(r=>r['用户ID']));
}

console.log('\n[6] 摩擦类不编折损单量');
{
  const fr = row('U4', 1000, {'3.2 3DS交易占比_今':0.5, '3.2 3DS交易占比_昨':0.3,
                              '3.1 风控综合通过率_今':1.0, '3.1 风控综合通过率_昨':1.0});
  const rows = drillMetric([fr], '独立站API', '3.2 3DS交易占比',
                           {isF:true, totalPO:1000, hasSite:true, stages:F});
  check('3DS 占比上升不算「少成多少单」', rows[0]['影响单量'] === null, rows[0]['影响单量']);
  check('对大盘那格留空，不是 0', rows[0]['对大盘影响'] === '', rows[0]['对大盘影响']);
  // 占比上升本身不损失单量，损失发生在下游那几个通过率上 —— 硬套公式会算出
  // 一个看着精确、其实没有业务含义的数
  check('退回老口径排序，仍然排得出来', rows[0]['影响比率'] !== '');
}

console.log('\n[7] ordFmt：群里那句话要是「减少 210 单」');
{
  // ⚠ 动词就用最普通的那两个。「少成/多成」是内部黑话，读的人得先反应一下
  //   「成」指的是成交还是成功 —— 用户明确说过看不懂。
  check('负数 = 减少', ordFmt(-210) === '减少 210 单', ordFmt(-210));
  check('正数 = 增加', ordFmt(158) === '增加 158 单', ordFmt(158));
  check('千分位', ordFmt(-1200) === '减少 1,200 单', ordFmt(-1200));
  check('★ 不出现「少成/多成」', !/少成|多成/.test(ordFmt(-210)+ordFmt(158)));
  // 「真的是零」和「四舍五入成零」在这里是两件事
  check('不足一单不写成 0 单', ordFmt(-0.4) === '减少不足 1 单', ordFmt(-0.4));
  check('null 给空串（摩擦类那格）', ordFmt(null) === '');
}

check.report();
