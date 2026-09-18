/* 商户成功率页的计算内核（`static/js/merchant/`）。
 *
 *     node tests/merchant_core.mjs      # 不需要服务，也不需要 $WB_FIXTURES
 *
 * 这套用例是拆模块（2026-09-09）换来的东西：在此之前这些函数全在
 * `merchant.html` 的一整段 `<script>` 里，**一个都跑不了单测** ——
 * 唯一的护栏是几套 Playwright 用例，而它们覆盖不到口径细节。
 *
 * 挑的都是「错了不报错、只是数字悄悄变了」的那些：
 *   1. 状态归类的四类。退款算成功、未决不进分母、没见过的状态要认出来。
 *   2. 失败文案/编码的合成优先级。这条改过一次口径，改反了整页归因跟着反。
 *   3. 「排除风控拦截」和 L3 的保留名单（ZFWG 是通道发起的，不算我方拦截）。
 *   4. 金额档位三选一。固定档位对订阅制商户完全失效，这块是为它加的。
 *   5. 表的合计与占比 —— 分母到底是谁。
 */
import { MODULES, installBrowserStubs, makeChecker } from './_harness.mjs';
installBrowserStubs();
const check = makeChecker();
const M = MODULES.replace('/conversion/', '/merchant/');

const { AMOUNT_LABELS_FIXED, buildAmountScheme, cutFixed } = await import(M + 'amount.js');
const { excludeL3, excludeRisk, hasCol, loadAndClean, PRESENT } = await import(M + 'clean.js');
const { generateFailreasonTable, generateGroupedTable } = await import(M + 'tables.js');
const { excludePending, isFail, isPend, isSucc, stClass } = await import(M + 'util.js');

console.log('[1] 状态归类：四类，退款算成功，未决不进分母');
{
  check('支付成功 → succ', stClass('支付成功') === 'succ');
  check('★ 退款算成功（钱确实收到过）', stClass('已退款') === 'succ' && stClass('退款') === 'succ');
  check('支付失败 → fail', stClass('支付失败') === 'fail');
  check('★ 待处理/处理中 → pending（不是失败）',
        stClass('待处理') === 'pending' && stClass('处理中') === 'pending');
  check('★ 没见过的状态 → unknown，不静默吞', stClass('冻结中') === 'unknown');
  check('空值 → unknown', stClass(null) === 'unknown' && stClass('') === 'unknown');
  check('前后空格不影响', stClass('  支付成功 ') === 'succ');

  const rows = [{status:'支付成功'}, {status:'支付失败'}, {status:'处理中'}, {status:'冻结中'}];
  check('isSucc / isFail / isPend', isSucc(rows[0]) && isFail(rows[1]) && isPend(rows[2]));
  const inRateRows = excludePending(rows);
  check('★ 通过率分母只留成功+失败（未决和未归类都排除）',
        inRateRows.length === 2, JSON.stringify(inRateRows.map(r => r.status)));
}

console.log('[2] ★ 失败文案/编码的合成优先级（这条改反了整页归因跟着反）');
/* loadAndClean 吃的是 SheetJS 出来的**对象数组**（键是表头原文）+ 一份表头清单，
   不是二维数组。而且**没有可解析的「支付时间」的行会被整行丢掉**
   （对应 pandas 的 dropna(subset=["pay_time"])）—— fixtures 必须带上它。 */
const H = ['流水单状态','初始失败原因','失败原因报错','报错编码','初始失败原因编码','交易金额','支付时间'];
const row = (o = {}) => ({
  '流水单状态': o.st || '支付失败',
  '初始失败原因': o.init === undefined ? '' : o.init,
  '失败原因报错': o.full === undefined ? '' : o.full,
  '报错编码': o.code === undefined ? '' : o.code,
  '初始失败原因编码': o.code2 === undefined ? '' : o.code2,
  '交易金额': o.amt === undefined ? 10 : o.amt,
  '支付时间': o.t || '2026-09-06 10:00:00',
});
{
  const out = loadAndClean([
    row({init:'gateway raw text', full:'风控系统拦截【ZFFK00003】', code:'ZFFK00003'}),
    row({init:'only init'}),                       // 没有 full → 退到 init
    row({code2:'ZFWG00007', init:'x'}),            // 没有 code → 退到 code2
  ], H);
  check('★ 文案以「失败原因报错」为准（平台统一口径列），不是网关原样返回的那列',
        out[0].fail_reason === '风控系统拦截【ZFFK00003】', out[0].fail_reason);
  check('没有 full 时退到「初始失败原因」', out[1].fail_reason === 'only init', out[1].fail_reason);
  check('编码：没有「报错编码」时退到「初始失败原因编码」',
        out[2].fail_code === 'ZFWG00007', out[2].fail_code);
  check('合成后会 trim', loadAndClean([row({full:'  padded  '})], H)[0].fail_reason === 'padded');
  // 空串不算「有值」—— 模板表里空列是常态，当成有值会把后面的候选全挡掉
  check('★ 空串不算有值，继续往后退',
        loadAndClean([row({full:'   ', init:'real'})], H)[0].fail_reason === 'real');
}

console.log('[3] 列识别与整行丢弃');
{
  const out = loadAndClean([row({st:'支付成功', amt:30})], H);
  check('认出来的列进 PRESENT', hasCol('status') && hasCol('amount'));
  check('没给的列不在 PRESENT', !hasCol('buyer_email'));
  check('派生出 amount_range', out[0].amount_range != null, String(out[0].amount_range));
  check('★ 有 fail_reason_* 就补一个 fail_reason（下游只认合成后的那个）', hasCol('fail_reason'));

  /* ⚠️ 支付时间解析不了的行会被**整行丢掉**，页面上只会说「清洗后无有效数据」。
     这是故意的（时间是一切时序分析的地基），但它是个很容易被忘掉的静默行为。 */
  check('★ 支付时间解析不了 → 整行丢掉',
        loadAndClean([row(), row({t:'不是日期'})], H).length === 1,
        String(loadAndClean([row(), row({t:'不是日期'})], H).length));
  check('★ 全丢光时返回空数组（调用方据此提示，不是崩）',
        loadAndClean([row({t:'xx'})], H).length === 0);
}

console.log('[4] ★ 排除风控拦截 / L3：ZFWG 是通道发起的，不算我方拦截');
{
  const rows = [
    {fail_reason:'风控系统拦截', fail_code:'ZFFK00003'},
    {fail_reason:'3DS验证失败',  fail_code:'ZF3D00002'},
    {fail_reason:'Insufficient funds', fail_code:''},
    {fail_reason:'通道3DS失败',  fail_code:'ZFWG00007'},
    {fail_reason:null,           fail_code:null},
  ];
  const noRisk = excludeRisk(rows);
  check('风控拦截被排掉', !noRisk.some(r => r.fail_code === 'ZFFK00003'), JSON.stringify(noRisk.map(r=>r.fail_code)));
  check('★ 空的失败原因保留（isna → 保留，成功单也是这一类）',
        noRisk.some(r => r.fail_reason === null));
  check('普通失败保留', noRisk.some(r => r.fail_reason === 'Insufficient funds'));

  const l3 = excludeL3(rows);
  check('L3：3DS 验证失败被排掉', !l3.some(r => r.fail_code === 'ZF3D00002'));
  check('L3：风控拦截被排掉', !l3.some(r => r.fail_code === 'ZFFK00003'));
  check('★ L3：ZFWG 在保留名单里，不排（通道发起的 3DS，不是我方拦的）',
        l3.some(r => r.fail_code === 'ZFWG00007'), JSON.stringify(l3.map(r=>r.fail_code)));
}

console.log('[5] 金额档位三选一：价位点 / 固定档 / 分位档');
{
  // 1. 价位点：少数几个价位覆盖绝大多数（订阅制、数字商品长这样）
  const price = buildAmountScheme([...Array(300)].map((_, i) => [0.99, 6.99, 19.99][i % 3]));
  check('★ 少数价位覆盖大多数 → 按价位点分档', price.kind === 'price', price.kind + ' / ' + price.note);
  check('价位点档位名就是价格本身', price.labels.includes('6.99'), JSON.stringify(price.labels));

  /* 2. 数据在固定档位上铺得开 → 不动（跨商户跨周期可比）。
     ⚠️ 每档里得有**很多个不同金额**：第一版每档只放一个价格重复 40 次，
     结果 8 个价位覆盖 100%，先命中了价位点那条 —— 判据的顺序就是这么起作用的。 */
  const spread = [];
  for(const base of [0.5, 10, 30, 70, 300, 700, 2000, 4000])
    for(let i = 0; i < 40; i++) spread.push(base + i * 0.13);
  check('★ 固定档铺得开就不动', buildAmountScheme(spread).kind === 'fixed', buildAmountScheme(spread).note);

  // 3. 连续分布但固定档不合身 → 分位档
  const cont = [...Array(400)].map((_, i) => 1000 + i * 3.7);
  check('★ 连续分布且固定档不合身 → 分位档', buildAmountScheme(cont).kind === 'quantile',
        buildAmountScheme(cont).kind + ' / ' + buildAmountScheme(cont).note);

  check('没有有效金额 → 退回固定档，不硬造', buildAmountScheme([]).kind === 'fixed');
  check('全是同一个金额 → 分位切点重合，退回固定档',
        buildAmountScheme([...Array(50)].map(() => 9.9)).kind !== 'quantile');

  // 固定档的边界：第一档闭区间，其余左开右闭
  check('固定档第一档含 0', cutFixed(0) === AMOUNT_LABELS_FIXED[0]);
  check('固定档 1 落在第一档（左闭右闭）', cutFixed(1) === '0-1');
  check('固定档 1.01 落在第二档', cutFixed(1.01) === '1-20');
  check('超出上界 → null，不硬塞进最后一档', cutFixed(99999) === null);
  check('非数值 → null', cutFixed(null) === null && cutFixed(NaN) === null);
}

console.log('[6] 表的合计与占比：分母到底是谁');
{
  /* ⚠️ 这些表都要先过 `hasCol(维度)`，而 `PRESENT` 是 `loadAndClean` 设的全局。
     直接写字面量行、跳过 loadAndClean 的话，`generateGroupedTable` 会**返回空表**
     （只有表头），断言拿到 undefined —— 不是算错，是根本没算。所以走一遍清洗。 */
  const H6 = [...H, '支付方式'];
  const rows = loadAndClean([
    {...row({st:'支付成功'}), '支付方式':'VISA'},
    {...row({st:'支付成功'}), '支付方式':'VISA'},
    {...row({full:'A'}),      '支付方式':'VISA'},
    {...row({full:'A'}),      '支付方式':'MC'},
    {...row({full:'B'}),      '支付方式':'MC'},
  ], H6);
  check('清洗后 5 行都在', rows.length === 5, String(rows.length));
  const t = generateFailreasonTable(rows, null);
  const line = k => t.data.find(r => r['支付失败原因'] === k);
  check('★ 「占总量比」的分母是全部笔数', line('A')['占总量比'] === 40, String(line('A')['占总量比']));
  check('★ 「占失败比」的分母是失败笔数（不是全部）', line('A')['占失败比'] === 66.67, String(line('A')['占失败比']));
  check('累计占失败比是累加的', line('B')['累计占失败比'] === 100, String(line('B')['累计占失败比']));
  const tot = t.data.find(r => r.__total);
  check('合计行是全部笔数', tot['笔数'] === 5, String(tot['笔数']));
  check('分隔行标了 __sep（提示词那边要剔掉）', t.data.some(r => r.__sep));

  const g = generateGroupedTable(rows, 'payment_method', '支付方式', null, null);
  const visa = g.data.find(r => r['支付方式'] === 'VISA');
  check('分组通过率 = 成功/该组笔数', visa['通过率'] === 66.67, String(visa['通过率']));
  check('分组占比 = 该组笔数/总笔数', visa['占比'] === 60, String(visa['占比']));
  check('成功笔数列', visa['成功笔数'] === 2, String(visa['成功笔数']));
  /* 影响力 = 占比 × (本组通过率 − 整体通过率)。Σ 恒等于 0 ——
     所以它只能用来排序，不能当成「这组损失了多少」（table_text.mjs 那边也钉着这条）。 */
  const sumImpact = g.data.filter(r => !r.__total)
                          .reduce((s, r) => s + (typeof r['影响力'] === 'number' ? r['影响力'] : 0), 0);
  check('★ 影响力各组相加 ≈ 0（它是贡献度，不是损失量）',
        Math.abs(sumImpact) < 0.01, String(sumImpact)
        + '（容差 0.01：通过率先四舍五入到 2 位再乘占比，残差量级是 Σ占比×0.005，不是浮点误差）');
}

check.report();
