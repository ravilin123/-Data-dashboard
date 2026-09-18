/* 出单监控分支页的口径（static/js/order_monitor/analyze.js，第十一轮）。
 *
 *     node tests/order_monitor_page.mjs      # 零依赖，不起服务也不要 fixtures
 *
 * 钉的是三条**改错了长得和对的一模一样**的性质：
 *
 *   [2] 耗时那一列里的 `0` 有两个意思。上游用 0 表达「还没走到这一步」
 *       （实测 站点_上线时长 有 223 行是 0，其中 217 行连首笔交易都没有），
 *       但 0 同时也可能是**真的秒过**（通道审核那 5 行实际 50 秒，被舍成了 0）。
 *       当成真值算中位数会把分布拉到地板；一律剔掉又会把秒过那批也扔了。
 *       只能靠**终点日期**分辨 —— 这是这套用例最要紧的一条。
 *   [1] 十二档要全部常驻，**包括常年是 0 的那几档**。「站点为空」实测就是 0，
 *       而正因为它一直是 0，从来没人显示过它，于是"这一档是 0"和
 *       "这一档我没在看"长得一模一样。
 *   [4] 被拒站点两天 +13 −2，**不是纯追加** —— 拿行数相减会算错，得做集合差；
 *       而且「读不到」和「一条都没有」必须分开（同 CLAUDE.md §2.12）。
 */
import { MODULES, makeChecker } from './_harness.mjs';
const check = makeChecker();
const OM = MODULES.replace('/conversion/', '/order_monitor/');
const { reconcile, timingSplit, classifyBuckets, rejectView, applyFilter, filterChips,
        isFiltered, FILTER_KEYS, bdRoster, NO_BD_NAME, DM_DAILY, DM_WEEKLY, DM_PENDING, DAILY_ORDER,
        PENDING_BUCKET, OVER_BUCKET,
        START_DATE_OF, END_DATE_OF, quantiles, daysBetween } = await import(OM + 'analyze.js');

const J = v => JSON.stringify(v);
const eq = (name, got, want) => check(name, J(got) === J(want), `实际 ${J(got)}`);

/* 一行明细，形状照真实台账 */
const D = o => Object.assign({
  行号: 0, 用户ID: '1', 商户名称: 'm', 站点: 's', 所属BD: 'BD甲',
  去向: '未出单', 落点: '通知+表', 累计TPV_USD: 0, 开通天数: null, 备注: '',
  站点_上线时长: 0, 支付方式_上线时长: 0, 站点_网站审核耗时: 0,
  支付方式_网站审核耗时: 0, 通道审核耗时: 0, 集成耗时: 0,
  建议进件通道: 'WORLDPAY',
  站点_商户提交日期: '2026-09-01', 站点_风控审核日期: null,
  支付方式_商户提交日期: '2026-09-01', 支付方式_风控审核日期: null,
  提交通道日期: null, 通道结果反馈日期: null, 第一笔成功交易日期: null,
}, o);

/* 第 12 张票（2026-09-16）：原来的「开通>60天」（整批丢弃）拆成「待激活」（通知+表）
   和「开通>180天」（仅表）。十二档 → 十三档。 */
const DISP = ['新出单', '测试交易', '小额滞留', '新审核通过', '未出单', '待激活',
              '存量已出单', '小额爬坡', '通道审核中', '待提交通道', '开通>180天',
              '站点为空', '老商户排除'];
const SINK = { 新出单: '通知+表', 测试交易: '通知+表', 小额滞留: '通知+表',
               新审核通过: '通知+表', 未出单: '通知+表', 待激活: '通知+表',
               存量已出单: '仅表', 小额爬坡: '仅表', 通道审核中: '仅表',
               待提交通道: '仅表', '开通>180天': '仅表',
               站点为空: '丢弃', 老商户排除: '丢弃' };

const LED = {
  date: '2026-09-09', 总行数: 6,
  去向顺序: DISP, 落点顺序: ['通知+表', '仅表', '丢弃'],
  对账: { ...Object.fromEntries(DISP.map(d => [d, 0])),
         新出单: 2, 通道审核中: 1, 存量已出单: 1, 待激活: 1, 老商户排除: 1 },
  落点: { '通知+表': 3, 仅表: 2, 丢弃: 1 },
  去向说明: Object.fromEntries(DISP.map(d => [d, `为什么落到${d}`])),
  落点归属: SINK,
  属性列: ['建议进件通道'],
  耗时列: ['站点_上线时长', '支付方式_上线时长', '站点_网站审核耗时',
          '支付方式_网站审核耗时', '通道审核耗时', '集成耗时'],
  耗时单位: '小时 · 不含节假日',
  明细: [
    // ① 走完全程
    D({ 行号: 0, 用户ID: 'a', 去向: '新出单', 落点: '通知+表',
        站点_上线时长: 100, 集成耗时: 50, 通道审核耗时: 10,
        提交通道日期: '2026-09-01', 通道结果反馈日期: '2026-09-02',
        第一笔成功交易日期: '2026-09-05' }),
    // ② 通道审核**真的秒过**：耗时 0，起点终点都有值（实测那 5 行是 50 秒被舍成 0）
    D({ 行号: 1, 用户ID: 'b', 去向: '新出单', 落点: '通知+表',
        站点_上线时长: 200, 通道审核耗时: 0,
        提交通道日期: '2026-09-02', 通道结果反馈日期: '2026-09-03',
        第一笔成功交易日期: '2026-09-06' }),
    // ③ 还在路上：已提交通道，等通道结果
    D({ 行号: 2, 用户ID: 'c', 去向: '通道审核中', 落点: '仅表', 建议进件通道: 'FISERV',
        站点_商户提交日期: '2026-09-01', 提交通道日期: '2026-09-02' }),
    // ④ 待激活（第 12 张票把它从「丢弃」提到「通知+表」）：通道过了，等首笔交易
    D({ 行号: 3, 用户ID: 'd', 去向: '待激活', 落点: '通知+表', 开通天数: 88,
        备注: '🟡 60-180天待激活', 所属BD: 'BD甲',
        建议进件通道: 'FISERV', 站点_商户提交日期: '2026-06-01', 提交通道日期: '2026-06-02',
        通道结果反馈日期: '2026-06-13', 通道审核耗时: 5 }),
    // ⑤ 老商户排除：上线时长 0，**有**首笔交易但它早于建站提交 —— 上游算出负数写 0
    D({ 行号: 4, 用户ID: 'e', 去向: '老商户排除', 落点: '丢弃',
        站点_商户提交日期: '2026-09-01', 第一笔成功交易日期: '2025-01-01' }),
    // ⑥ 集成耗时**起点缺**：首笔交易有了，通道反馈却没有 —— 同样算不出来，写 0
    //    实测这种行有 31 个，不排掉的话集成耗时的样本从 134 涨到 165
    D({ 行号: 5, 用户ID: 'f', 去向: '存量已出单', 落点: '仅表',
        站点_上线时长: 300, 集成耗时: 0, 第一笔成功交易日期: '2026-09-07' }),
  ],
  被拒站点: {
    行数: 3, 无BD行数: 2, 当日新增: 1, 读取失败原因: '',
    对比说明: '对比 2026-09-08 的台账',
    明细: [{ 用户ID: 'r1', 站点: 'x.com', 所属BD: '张三' },
          { 用户ID: 'r2', 站点: 'y.com', 所属BD: null },
          { 用户ID: 'r3', 站点: 'z.com', 所属BD: '' }],
    新增明细: [{ 用户ID: 'r3', 站点: 'z.com', 所属BD: '' }],
  },
};

// ---------------------------------------------------------------- [1] 对账
console.log('[1] 对账：十三档全部常驻，加总必须等于报表行数');
{
  const r = reconcile(LED);
  eq('十三档一档不少', r.rows.length, 13);
  eq('顺序照 DISPOSITIONS', r.rows.map(x => x.去向), DISP);
  // ★ 顺序必须走 `去向顺序` 那个**数组**：工作台的 Flask 开着 sort_keys=True，
  //   dict 的键经 jsonify 会被重排成字典序，而且悄无声息 —— 踩过。
  const shuffled = { ...LED, 对账: Object.fromEntries(
    [...DISP].sort().map(d => [d, LED.对账[d] || 0])) };
  eq('★ dict 键被重排了也照样按 DISPOSITIONS 出（顺序走数组不走键序）',
     reconcile(shuffled).rows.map(x => x.去向), DISP);
  const noOrder = { ...LED, 去向顺序: undefined };
  eq('台账没带顺序数组时退回键序（老台账还读得动）',
     reconcile(noOrder).rows.length, 13);
  eq('总行数', r.total, 6);
  eq('★ 十三档加总 == 总行数', r.rows.reduce((s, x) => s + x.行数, 0), 6);
  const empty = r.rows.find(x => x.去向 === '站点为空');
  check('★ 常年是 0 的那档也在（0 和「我没在看」长得一样）', !!empty && empty.行数 === 0);
  check('每档带上「为什么落到这儿」', (empty.why || '').length > 0, empty.why);

  const over = r.rows.find(x => x.去向 === '待激活');
  eq('★ 待激活那批点得开', over.明细.length, 1);
  eq('★ 看得到各自开通了多少天', over.明细[0].开通天数, 88);
  eq('★ 落点是「通知+表」，不再是丢弃（第 12 张票把它捞上来了）', over.落点, '通知+表');

  eq('三个落点顺序固定：看得见 → 看不见',
     r.sinks.map(s => s.落点), ['通知+表', '仅表', '丢弃']);
  eq('★ 落点顺序同样走数组',
     reconcile({ ...LED, 落点: { 丢弃: 1, 仅表: 2, '通知+表': 3 } }).sinks.map(s => s.落点),
     ['通知+表', '仅表', '丢弃']);
  eq('★ 三个落点加总 == 总行数', r.sinks.reduce((s, x) => s + x.行数, 0), 6);
  eq('落点占比按总行数算', r.sinks.find(s => s.落点 === '丢弃').占比, 16.7);
}

// ---------------------------------------------------------------- [2] 耗时
console.log('[2] ★ 耗时：0 的两种含义靠终点日期分辨');
{
  const ts = timingSplit(LED);
  const site = ts.done.find(c => c.col === '站点_上线时长');
  eq('★ 0 不进左栏分母（那多半是「还没走到这一步」）', site.n, 3);
  eq('中位数只按进了分母的算（100/200/300）', site.p50, 200);
  eq('最大值', site.max, 300);
  eq('分母写出来：一共几行', ts.total, 6);

  const ch = ts.done.find(c => c.col === '通道审核耗时');
  // ① 10h · ② 0h（秒过，反馈日期有值）· ④ 5h → n=3；③⑤ 没反馈日期 → 没走到
  eq('★ 真的秒过要算进分母（实测那 5 行是 50 秒被舍成 0）', ch.n, 3);
  eq('0 / 5 / 10 的中位是 5', ch.p50, 5);
  eq('★ 秒过单独数出来（一堆 0 挤在分布里要说清来历）', ch.zeroDone, 1);
  eq('★ 没走到的也单独数出来（③⑤⑥ 都没有通道反馈日期）', ch.notReached, 3);

  // ★ 这两条是这套用例的核心：三种 0 分得开，左栏的分母才是对的
  eq('★ 终点早于起点 → 算不出来，不进分母（⑤ 老商户，实测 6 行）', site.noCalc, 1);
  eq('★ 没走到的：③④（终点没有首笔交易）', site.notReached, 2);
  const integ = ts.done.find(c => c.col === '集成耗时');
  // ⑤⑥ 都是首笔交易有了、通道结果反馈却没有 —— 起点缺，算不出来。实测这种行 31 个。
  eq('★ 起点缺 → 也算不出来（⑤⑥，实测 31 行）', integ.noCalc, 2);
  eq('集成耗时分母只剩 ①50 和 ②0', integ.n, 2);
  eq('中位是 25', integ.p50, 25);
  eq('② 那个 0 是真秒过', integ.zeroDone, 1);

  eq('★ 单位一个字都不换算', ts.unit, '小时 · 不含节假日');
  check('★ 不除 24、不换算成天', site.p50 === 200);

  const bare = { ...LED, 明细: [D({ 站点_上线时长: null })] };
  const nl = timingSplit(bare).done.find(c => c.col === '站点_上线时长');
  eq('缺列不进分母', nl.n, 0);
  eq('★ 算不出来给 null 不给 0', nl.p50, null);
}

console.log('[2] ★ 右栏：还在路上的那批（左栏一个人都看不到他们）');
{
  const ts = timingSplit(LED);
  eq('★ 只放真的还在等的：③④ 在等；⑤⑥ 有首笔交易，不算', ts.waiting.n, 2);
  check('★ 老商户那条上线时长也是 0，但已经有首笔交易 —— 不是"在等"',
        !ts.waiting.rows.some(r => r.用户ID === 'e'));
  check('待激活那批正是最该看的', ts.waiting.rows.some(r => r.用户ID === 'd'));

  const g = Object.fromEntries(ts.waiting.groups.map(x => [x.stage, x.n]));
  eq('④ 通道过了等交易 → 该催商户接入', g['通道通过，等首笔交易'], 1);
  eq('③ 提交了没反馈 → 该催通道', g['已提交通道，等通道结果'], 1);
  eq('分组加总 == 在等的家数',
     ts.waiting.groups.reduce((s, x) => s + x.n, 0), ts.waiting.n);

  eq('★ 右栏是自然日，和左栏那把尺子不是一回事', ts.waiting.unit, '自然日 · 含周末');
  eq('从建站提交算到报表日期',
     ts.waiting.rows.find(r => r.用户ID === 'd').等待天数,
     daysBetween('2026-06-01', '2026-09-09'));
}

// ---------------------------------------------------------------- [3] 分类
console.log('[3] 分类：现有 7 档 + 待激活 + 超 180 天（第 12 张票）');
{
  const c = classifyBuckets(LED);
  eq('现有 7 档照原样', c.buckets.slice(0, 7).map(b => b.name).join(), DAILY_ORDER.join());
  eq('★ 一共九档（7 + 待激活 + 超180）', c.buckets.length, 9);
  const nb = c.buckets.find(b => b.name === PENDING_BUCKET);
  check('★ 待激活不再是「页面独有」—— 它真的会发出去了', !!nb && nb.pageOnly === false);
  check('★ 它那句说明写明「按周发、不混进日报」', /按周发/.test(nb.note) && /日报/.test(nb.note), nb.note);
  eq('条数对', nb.n, 1);
  const ob = c.buckets.find(b => b.name === OVER_BUCKET);
  check('★ 超 180 天那档也常驻（哪怕是 0）—— 0 和「我没在看」长得一模一样', !!ob);
  check('★ 它标着 quiet（进表但不播报），不是 pageOnly',
        ob.quiet === true && ob.pageOnly === false, J({ q: ob.quiet, p: ob.pageOnly }));
  check('BD 清单给得出来（页面要按它筛）', c.bds.includes('BD甲'), J(c.bds));
  eq('明细带着 BD', nb.rows[0].所属BD, 'BD甲');
}

// ---------------------------------------------------------------- [4] 被拒站点
console.log('[4] 被拒站点：无 BD 的单独一块；读不到 ≠ 一条都没有');
{
  const r = rejectView(LED);
  eq('行数', r.n, 3);
  eq('★ null 和空串都算「没有 BD」', r.noBd.length, 2);
  eq('当日新增', r.newN, 1);
  check('说清楚比的是哪一天', r.compareNote.includes('2026-09-08'), r.compareNote);

  const bad = rejectView({ ...LED, 被拒站点: {
    行数: null, 无BD行数: null, 当日新增: null, 明细: [],
    读取失败原因: '没有名叫「站点审核失败」的 sheet，这份有：数据口径、商户审核耗时' } });
  eq('★ 读不到给 null 不给 0', bad.n, null);
  check('把原因原样摆出来（照着就能改）', bad.error.includes('站点审核失败'), bad.error);
  check('标成不 ok', bad.ok === false);

  const first = rejectView({ ...LED, 被拒站点: { ...LED.被拒站点,
    当日新增: null, 新增明细: undefined, 对比说明: '首份台账，没有前一天可比' } });
  eq('★ 首份没有前一天可比时不许把「新增」说成 0', first.newN, null);
  check('说清楚是首份', first.compareNote.includes('首份'));
}

// ---------------------------------------------------------------- [5] 小工具
console.log('[5] quantiles / daysBetween / END_DATE_OF 的边界');
{
  eq('空的给 null 不给 0', quantiles([]), null);
  eq('一个值', quantiles([5]).p50, 5);
  eq('偶数个取中间两个的平均', quantiles([1, 2, 3, 4]).p50, 2.5);
  eq('天数差', daysBetween('2026-09-01', '2026-09-09'), 8);
  eq('缺一头给 null', daysBetween(null, '2026-09-09'), null);
  eq('★ 六列耗时各有各的终点日期，一列不少', Object.keys(END_DATE_OF).length, 6);
  eq('★ 起点日期也是六列一列不少', Object.keys(START_DATE_OF).length, 6);
  for (const c of LED.耗时列) check(`${c} 起点终点都有`, !!END_DATE_OF[c] && !!START_DATE_OF[c]);
  check('★ 键名和台账明细对得上（report.py 的 DATE_COLS，改一处要改两处）',
        LED.耗时列.every(c => END_DATE_OF[c] in LED.明细[0] && START_DATE_OF[c] in LED.明细[0]),
        LED.耗时列.filter(c => !(END_DATE_OF[c] in LED.明细[0])
                            || !(START_DATE_OF[c] in LED.明细[0])).join(','));
}

// ---------------------------------------------------------------- [6] 筛选
console.log('[6] ★ 筛选：一处选中，整页跟着变');
{
  const all = applyFilter(LED, {});
  eq('空筛选 = 全量', all.明细.length, LED.明细.length);
  check('空筛选不复制一份新台账的头部字段', all.总行数 === LED.总行数);

  // ★ 筛选之后 `总行数` 必须跟着变 —— 否则 KPI 上写着 392，
  //   下面的表只有 76 行，两个数在同一屏里互相打脸
  // 第 12 张票之后「丢弃」只剩老商户排除那一行了 —— 待激活被捞到了「通知+表」
  const drop = applyFilter(LED, { sink: '通知+表' });
  eq('★ 按落点筛：只剩通知+表那三行', drop.明细.length, 3);
  eq('★ 总行数跟着变（KPI 不能还写全量）', drop.总行数, 3);
  eq('★ 对账那十三档也跟着重算', drop.对账['待激活'], 1);
  eq('没被选中的档归 0，但**还在**（十三档常驻）',
     Object.keys(drop.对账).length, 13);
  eq('落点计数也重算', drop.落点['通知+表'], 3);
  eq('没选中的落点归 0 不消失', drop.落点['丢弃'], 0);

  const one = applyFilter(LED, { disp: '待激活' });
  eq('按去向筛', one.明细.length, 1);
  eq('★ 去向筛选后落点也对', one.落点['通知+表'], 1);

  const bd = applyFilter(LED, { bd: 'BD甲' });
  eq('按 BD 筛（fixture 里全是 BD甲）', bd.明细.length, LED.明细.length);
  eq('★「没有 BD」是个真选项，不是"没筛"',
     applyFilter({ ...LED, 明细: [...LED.明细, D({ 用户ID: 'z', 所属BD: '' })] },
                 { bd: '__none__' }).明细.length, 1);

  eq('按关键词筛（商户名 / 站点 / 用户ID）',
     applyFilter(LED, { kw: 'd' }).明细.length, 1);
  eq('关键词不区分大小写', applyFilter(LED, { kw: 'D' }).明细.length, 1);

  // 「卡在哪一步」是耗时右栏那三组，也要能当筛选条件用
  const st = applyFilter(LED, { stage: '通道通过，等首笔交易' });
  eq('★ 按「卡在哪一步」筛', st.明细.length, 1);
  eq('筛到的正是 ④', st.明细[0].用户ID, 'd');

  // 多条件是**与**的关系
  eq('★ 多个条件同时生效（与）',
     applyFilter(LED, { sink: '丢弃', disp: '老商户排除' }).明细.length, 1);
  eq('互斥的组合给 0 行，不报错',
     applyFilter(LED, { sink: '通知+表', disp: '开通>60天' }).明细.length, 0);

  // ★ 被拒站点是**另一张表**，跟这些筛选没关系 —— 不能被一起筛掉
  eq('★ 被拒站点不受商户筛选影响（它是另一张表）',
     applyFilter(LED, { sink: '丢弃' }).被拒站点.行数, LED.被拒站点.行数);
}

console.log('[6] 筛选条件要能显示成 chips，并且逐个撤掉');
{
  const chips = filterChips({ sink: '丢弃', bd: 'BD甲', kw: 'abc' });
  eq('三个条件三个 chip', chips.length, 3);
  check('每个 chip 带 key（点 × 时知道撤哪个）', chips.every(c => c.key && c.label));
  eq('空筛选没有 chip', filterChips({}).length, 0);
  const nb = filterChips({ bd: '__none__' });
  eq('★「没有 BD」显示成人话不是 __none__', nb[0].label.includes('没有'), true);
}

// ------------------------------------------------------- [7] 建议进件通道
console.log('[7] ★ 建议进件通道：筛选维度 + 耗时按通道分组');
{
  eq('按通道筛', applyFilter(LED, { channel: 'FISERV' }).明细.length, 2);
  eq('筛完落点跟着重算', applyFilter(LED, { channel: 'FISERV' }).落点['通知+表'], 1);
  eq('和别的条件是与的关系',
     applyFilter(LED, { channel: 'FISERV', sink: '通知+表' }).明细.length, 1);
  const chips = filterChips({ channel: 'WORLDPAY' });
  eq('通道也能显示成 chip', chips.length, 1);
  check('chip 上写得出通道名', chips[0].label.includes('WORLDPAY'), chips[0].label);
  eq('★「没有通道」是个真选项（报表里那一格可能是空的）',
     applyFilter({ ...LED, 明细: [...LED.明细, D({ 用户ID: 'z', 建议进件通道: '' })] },
                 { channel: '__none__' }).明细.length, 1);

  const ts = timingSplit(LED);
  const by = ts.byChannel;
  check('★ 按通道分组出来了', Array.isArray(by) && by.length > 0, JSON.stringify(by));
  const w = by.find(x => x.channel === 'WORLDPAY');
  const f = by.find(x => x.channel === 'FISERV');
  eq('WORLDPAY 4 家', w.n, 4);
  eq('FISERV 2 家', f.n, 2);
  eq('★ 各通道加起来 == 总行数', by.reduce((s, x) => s + x.n, 0), LED.明细.length);

  // ★ 这一列是这块的主角：通道审核耗时的中位。实测 WORLDPAY 0.08h / FISERV 99.62h
  eq('WORLDPAY 的通道审核中位（①10h ②0h 两条进分母）', w.审核中位, 5);
  eq('FISERV 的通道审核中位（只有 ④ 那条 5h）', f.审核中位, 5);
  eq('★ 没走到通道审核的不进分母（③ 没有反馈日期）', f.审核n, 1);

  // 出单率：有第一笔成功交易的比例
  eq('WORLDPAY 出单率（①②⑥ 有交易，⑤ 也有 → 4/4）', w.出单率, 100);
  eq('FISERV 出单率（③④ 都没交易 → 0）', f.出单率, 0);

  eq('★ 通道排序按商户数从多到少', by.map(x => x.channel), ['WORLDPAY', 'FISERV']);

  // ★★ 加维度只改 FILTER_KEYS 一处。原来 renderList / renderKpis 各硬编码了一份
  //    维度清单，加 channel 时**两处都漏了** —— 按通道筛完，数字筛过了，
  //    标题却还写「全部 40 行」，两个说法在同一屏里打架而且不报错。
  eq('★ 每个维度 isFiltered 都认得（漏一个界面就会自相矛盾）',
     FILTER_KEYS.filter(k => !isFiltered({ [k]: 'x' })), []);
  check('空筛选就是没筛', !isFiltered({}) && !isFiltered(null));
  check('★ applyFilter 支持的维度都在 FILTER_KEYS 里',
        ['sink', 'disp', 'bd', 'channel', 'kw', 'stage'].every(k => FILTER_KEYS.includes(k)),
        FILTER_KEYS.join(','));

  // 报表里那一格是空的时候要有个去处，不能凭空消失
  const withNone = timingSplit({ ...LED,
    明细: [...LED.明细, D({ 用户ID: 'z', 建议进件通道: '' })] });
  const none = withNone.byChannel.find(x => x.channel === '');
  check('★ 没填通道的单独一组，不丢', !!none && none.n === 1, JSON.stringify(withNone.byChannel));
  eq('加上它之后仍然加总 == 总行数',
     withNone.byChannel.reduce((s, x) => s + x.n, 0), LED.明细.length + 1);
}

/* ======================================================================
 * [8] BD 私聊名单（第十二轮）
 *
 * 这张名单错了**不会报错**：notify.py 的 `_send_for_map` 找不到邮箱只 print
 * 一行警告就 continue，于是"名字打错一个字"和"这个 BD 今天没有需要跟进的商户"
 * 在群里、在日志里、在页面上长得一模一样。所以页面必须自己把两件事分开：
 *   · 台账里有这个名字、名单里没有   → 这个人收不到（要加）
 *   · 名单里有这个名字、台账里没有   → 名字对不上，**永远**发不出去（要改）
 *
 * ⚠ 数的是**会私聊的那批**，不是全部 392 行：仅表 / 丢弃的行配了也收不到。
 * ⚠ 没有 BD 的行归到 `未分配BD` —— 那是 notify.py `clean_bd_name()` 的字面量，
 *   **是个真能配的名字**（给它配邮箱，这批就有人收）。实测今天 124 行通知里
 *   94 行没有 BD，不把它当成一项的话这 94 行没有任何人看得到。
 * ==================================================================== */
{
  const R = (bd, sink, note) => D({ 所属BD: bd, 落点: sink, 备注: note });
  const led = { ...LED, 明细: [
    R('甲', '通知+表', '✅ 新出单'),
    R('甲', '通知+表', '🐢 小额滞留'),
    R('甲', '通知+表', '🔴 3-30天未出单'),   // 周报档
    R('乙', '通知+表', '✅ 新出单'),
    R('乙', '仅表',   '✅ 新出单'),          // 仅表：配了也收不到
    R('丙', '丢弃',   '✅ 新出单'),          // 丢弃：同上
    R('',   '通知+表', '✅ 新出单'),          // 没有 BD
    R('  ', '通知+表', '🟠 30-60天未出单'),   // 全是空白，也算没有
  ] };

  const r = bdRoster(led, { 甲: 'a@x.com', 丁: 'd@x.com' });
  const byName = Object.fromEntries(r.rows.map(x => [x.name, x]));

  eq('★ 只数会私聊的那批（仅表/丢弃不算）', byName['乙'].dmN, 1);
  check('★ 丢弃里的 BD 根本不出现在名单上', !byName['丙'], J(r.rows.map(x => x.name)));
  eq('日报档 / 周报档分开数（周报只在那一天发）',
     [byName['甲'].dailyN, byName['甲'].weeklyN], [2, 1]);
  eq('dmN = 日报 + 周报', byName['甲'].dmN, 3);

  check(`★ 没有 BD 的归到「${NO_BD_NAME}」`, !!byName[NO_BD_NAME], J(Object.keys(byName)));
  eq('★ 全是空白的格子也算没有 BD', byName[NO_BD_NAME].dmN, 2);
  check('★ 它和 notify.py 的 clean_bd_name() 是同一个字面量',
        NO_BD_NAME === '未分配BD', NO_BD_NAME);

  check('配了邮箱的标出来', byName['甲'].email === 'a@x.com' && byName['甲'].configured);
  check('★ 台账里有、名单里没有 → 收不到（要加）',
        byName['乙'].configured === false && byName['乙'].email === '');

  eq('★ 名单里有、台账里没有 → orphan（名字对不上，永远发不出去）',
     r.orphans.map(x => x.name), ['丁']);
  eq('orphan 也带着邮箱，好让人认出是谁', r.orphans[0].email, 'd@x.com');

  eq('★ 按会私聊的行数倒序（量大的先配）', r.rows.map(x => x.name),
     ['甲', NO_BD_NAME, '乙']);

  // 台账那一格前后带空格时，和名单里的名字是同一个人
  const r2 = bdRoster({ ...LED, 明细: [R(' 甲 ', '通知+表', '✅ 新出单')] },
                      { 甲: 'a@x.com' });
  check('★ 台账里的名字 strip 之后再比', r2.rows[0].configured, J(r2.rows[0]));
  eq('strip 之后不算 orphan', r2.orphans.length, 0);

  // 两张档期表要和 notify.py 对得上 —— 漏一档就会把"周报才发"数成"今天就发"
  eq('日报档 5 项', DM_DAILY.length, 5);
  eq('周报档 2 项', DM_WEEKLY.length, 2);
  eq('★ 两张表合起来正好是群通知那 7 档，不重不漏',
     [...DM_DAILY, ...DM_WEEKLY].slice().sort(), DAILY_ORDER.slice().sort());

  // 一条都没有的时候：空名单，不是报错
  eq('台账是空的就给空名单', bdRoster({ ...LED, 明细: [] }, {}).rows, []);
  eq('名单是空的也不炸', bdRoster(led, null).rows.filter(x => x.configured).length, 0);
}

check.report();
