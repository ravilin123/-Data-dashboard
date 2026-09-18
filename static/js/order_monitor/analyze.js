/* ============================================================================
   出单监控分支页 —— 纯口径层（第十一轮）

   接口只有一个：吃一份台账 json（/api/order-monitor/ledger 回来的那个），
   吐出四块要显示的东西。**不碰 DOM、不 fetch、不读任何界面全局** ——
   `tests/order_monitor_page.mjs` 因此能零依赖直跑。

   ⚠ 这一层最要紧的一件事：**耗时那一列里的 `0` 有两个意思。**
     上游用 `0` 表达「还没走到这一步」（实测 站点_上线时长 223 行是 0，
     其中 217 行连首笔交易都没有），但 `0` 同时也可能是**真的秒过**
     （通道审核那 5 行实际 50 秒，被四舍五入成了 0）。
       · 当成真值算中位数 → 分布被拉到地板（站点_上线时长 中位 183h → 0h）
       · 一律剔掉         → 把秒过那批也扔了，通道审核的分布凭空少一截
     只能靠**终点日期**分辨，见 END_DATE_OF。台账那边配套的是 report.py 的
     DATE_COLS —— 两处的键名必须对得上，改一处要改两处。
   ============================================================================ */

/* 每列耗时的**起点**日期。起点缺了同样算不出来 ——
   实测「集成耗时」有 31 行首笔交易都有了、却没有通道结果反馈日期，
   上游一律写 0。那个 0 既不是秒过也不是没走到，是**算不出来**：
   混进分布里，集成耗时的样本会从 134 涨到 165，中位数被一堆假 0 拽下去。 */
const START_DATE_OF = {
  站点_上线时长: '站点_商户提交日期',
  支付方式_上线时长: '支付方式_商户提交日期',
  站点_网站审核耗时: '站点_商户提交日期',
  支付方式_网站审核耗时: '支付方式_商户提交日期',
  通道审核耗时: '提交通道日期',
  集成耗时: '通道结果反馈日期',
};

/* 每列耗时对应的「终点日期」。终点没值 = 这一步还没走到，那个 0 不是耗时。
   ⚠ 六列一列都不能少 —— 少一列，那一列的 0 就再也分不清是秒过还是没走到。 */
const END_DATE_OF = {
  站点_上线时长: '第一笔成功交易日期',
  支付方式_上线时长: '第一笔成功交易日期',
  站点_网站审核耗时: '站点_风控审核日期',
  支付方式_网站审核耗时: '支付方式_风控审核日期',
  通道审核耗时: '通道结果反馈日期',
  集成耗时: '第一笔成功交易日期',
};

/* 每列耗时给人看的说明。界面上跟在列名后面 —— 「站点_上线时长」这种名字
   不说清楚起点终点，读的人只会按字面理解成"站点上线花了多久"。 */
const COL_NOTE = {
  站点_上线时长: '建站提交 → 第一笔成功交易',
  支付方式_上线时长: '支付方式提交 → 第一笔成功交易',
  站点_网站审核耗时: '建站提交 → 站点风控审核',
  支付方式_网站审核耗时: '支付方式提交 → 支付方式风控审核',
  通道审核耗时: '提交通道 → 通道结果反馈',
  集成耗时: '通道结果反馈 → 第一笔成功交易',
};

/** 分位数。**空数组给 null，不给 0** —— 「没有样本」和「样本都是 0」
 *  是两回事，而后者在这份报表里恰恰经常发生。 */
function quantiles(xs) {
  const a = xs.filter(v => typeof v === 'number' && isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const at = q => {
    const i = (a.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
    return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (i - lo);
  };
  return { n: a.length, p50: at(0.5), p75: at(0.75), p90: at(0.9),
           min: a[0], max: a[a.length - 1] };
}

/** 两个 YYYY-MM-DD 之间差几天。缺一头给 null（不给 0 —— 同上）。 */
function daysBetween(from, to) {
  if (!from || !to) return null;
  const a = Date.parse(from + 'T00:00:00Z'), b = Date.parse(to + 'T00:00:00Z');
  if (!isFinite(a) || !isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

const pct = (n, total) => (total ? Math.round(n / total * 1000) / 10 : 0);

/* ------------------------------------------------------------ ⓪ 筛选 */

/**
 * 全部筛选维度。**这是唯一的真相源** —— `applyFilter` / `filterChips` /
 * `isFiltered` 都从它派生。
 *
 * ⚠ 加维度只改这里。原来 `renderList` 和 `renderKpis` 各自硬编码了一份
 *   `f.sink || f.disp || f.bd || f.kw || f.stage`，加 `channel` 时**两处都漏了** ——
 *   表现是：按通道筛完，KPI 上不写「筛过的」、名单标题还写着「全部 40 行」，
 *   而数字其实已经筛过了。两个说法在同一屏里打架，而且不报错。
 */
const FILTER_KEYS = ['sink', 'disp', 'bd', 'channel', 'kw', 'stage', 'bucket'];

/** 现在是不是筛过的状态。界面上「全部 N 行」还是「当前筛选下 N 家」看它。 */
const isFiltered = f => FILTER_KEYS.some(k => f && f[k]);

/**
 * 按条件筛一份台账，**返回一份新的台账**（形状和原来完全一样）。
 *
 * 这样下游那四个函数（reconcile / timingSplit / classifyBuckets / rejectView）
 * 一行都不用改 —— 它们吃什么吐什么，筛选只是换了喂进去的那份。
 *
 * ⚠ **`总行数` / `对账` / `落点` 必须跟着重算。** 只筛 `明细` 不改这三个的话，
 *   KPI 上写着 392 行、下面的表只有 76 行，两个数在同一屏里互相打脸。
 * ⚠ **被拒站点原样带过去** —— 那是报表的**另一张 sheet**（站点审核失败），
 *   和商户那 392 行不是一个维度，被商户筛选连坐是错的。
 *
 * 支持的条件（都可空，多个之间是**与**）：
 *   sink   落点（通知+表 / 仅表 / 丢弃）
 *   disp   去向（十二档之一）
 *   bd     所属BD；`__none__` = 没有 BD 的那批（这是个真选项，不是"没筛"）
 *   channel 建议进件通道；`__none__` = 报表里那一格是空的那批
 *   kw     关键词，match 商户名称 / 站点 / 用户ID
 *   stage  卡在哪一步（耗时右栏那三组）
 */
function applyFilter(led, f) {
  f = f || {};
  const kw = (f.kw || '').trim().toLowerCase();
  const rows = (led.明细 || []).filter(m => {
    if (f.sink && m.落点 !== f.sink) return false;
    if (f.disp && m.去向 !== f.disp) return false;
    if (f.bd === '__none__') { if (String(m.所属BD || '').trim()) return false; }
    else if (f.bd && String(m.所属BD || '').trim() !== f.bd) return false;
    if (f.channel === '__none__') { if (String(m.建议进件通道 || '').trim()) return false; }
    else if (f.channel && String(m.建议进件通道 || '').trim() !== f.channel) return false;
    if (f.stage && waitStage(m) !== f.stage) return false;
    if (f.stage && m.第一笔成功交易日期) return false;   // stage 只对"还在等的"有意义
    if (kw && !`${m.商户名称 || ''} ${m.站点 || ''} ${m.用户ID || ''}`
                .toLowerCase().includes(kw)) return false;
    return true;
  });

  // 十二档和三个落点**重算，但一档都不删** —— 常驻是这一页的规矩（见 reconcile）
  const tally = {};
  for (const d of (led.去向顺序 || Object.keys(led.对账 || {}))) tally[d] = 0;
  const sinks = {};
  for (const k of (led.落点顺序 || Object.keys(led.落点 || {}))) sinks[k] = 0;
  for (const m of rows) {
    if (m.去向 in tally) tally[m.去向]++;
    if (m.落点 in sinks) sinks[m.落点]++;
  }

  return { ...led, 总行数: rows.length, 明细: rows, 对账: tally, 落点: sinks,
           _全量行数: led.总行数 };
}

/** 当前筛选条件 → 一排可撤销的 chip。`key` 是给「点 × 撤掉这一条」用的。 */
function filterChips(f) {
  f = f || {};
  const out = [];
  if (f.sink) out.push({ key: 'sink', label: `落点：${f.sink}` });
  if (f.disp) out.push({ key: 'disp', label: `去向：${f.disp}` });
  if (f.bd) out.push({ key: 'bd', label: f.bd === '__none__' ? 'BD：没有 BD 的' : `BD：${f.bd}` });
  if (f.channel) out.push({ key: 'channel',
    label: f.channel === '__none__' ? '通道：报表里没填' : `通道：${f.channel}` });
  if (f.stage) out.push({ key: 'stage', label: `卡在：${f.stage}` });
  if ((f.kw || '').trim()) out.push({ key: 'kw', label: `搜「${f.kw.trim()}」` });
  return out;
}

/* ---------------------------------------------------------------- ① 对账 */

/**
 * 「报表 N 行去哪了」。十二档 + 三个落点。
 *
 * ⚠ **十二档全部常驻，包括行数是 0 的那几档。** 「站点为空」实测常年就是 0，
 *   而正因为它一直是 0，从来没人在界面上显示过它 —— 于是「这一档是 0」
 *   和「这一档我根本没在看」长得一模一样。这一轮要治的就是这个病。
 */
function reconcile(led) {
  const total = led.总行数 || 0;
  const tally = led.对账 || {};
  const sinkOf = led.落点归属 || {};
  const why = led.去向说明 || {};
  const byDisp = {};
  for (const m of led.明细 || []) (byDisp[m.去向] = byDisp[m.去向] || []).push(m);

  // ⚠ 顺序走 `去向顺序` 那个**数组**，不能用 `对账` 的键序 ——
  //   工作台的 Flask 开着 sort_keys，dict 的键经 jsonify 会被重排成字典序，
  //   而且悄无声息（页面上只是那十二行的次序不对，看着像"随便排的"）。
  //   数组不受影响。台账文件里那个 dict 的顺序其实是对的，别被它误导。
  const order = led.去向顺序 && led.去向顺序.length ? led.去向顺序 : Object.keys(tally);
  const rows = order.map(d => ({
    去向: d, 落点: sinkOf[d] || '', 行数: tally[d] || 0,
    占比: pct(tally[d] || 0, total), why: why[d] || '',
    明细: byDisp[d] || [],
  }));

  const sinkTally = led.落点 || {};
  // 固定「看得见 → 看不见」的顺序，不按行数排 —— 这一块要讲的是一条线索，
  // 不是一个排行榜：人看完第一行就该问"那剩下的呢"。
  const sinks = (led.落点顺序 && led.落点顺序.length
                 ? led.落点顺序 : ['通知+表', '仅表', '丢弃']).map(s => ({
    落点: s, 行数: sinkTally[s] || 0, 占比: pct(sinkTally[s] || 0, total),
  }));

  return { total, rows, sinks, date: led.date || '' };
}

/* ---------------------------------------------------------------- ② 耗时 */

/**
 * 六列耗时，**左右两栏**。
 *
 * 只放左栏（已完成的分布）会有幸存者偏差：真正的问题商户根本没出单，
 * 压根没有「上线时长」，不在分母里 —— 于是那块数字永远好看。
 * 右栏专门放**还在路上的那批**，并按「卡在哪一步」分组（该催谁不一样）。
 *
 * ⚠ 两栏**不是同一把尺子**：
 *     左栏是报表给的，单位小时、**不含节假日**；
 *     右栏是拿日期自己相减的**自然日**（含周末）。
 *   实测某行提交到首笔 67.4 个自然日，报表给 1176.32h（÷24 = 49 天）——
 *   差的 18 天全是周末。两个数摆在一起直接比就是错的，所以各自带 unit。
 */
function timingSplit(led) {
  const cols = led.耗时列 || Object.keys(END_DATE_OF);
  const rows = led.明细 || [];

  // 每一格的 `0` 分四种，只有第一种才是真的耗时。四种都单独数出来 ——
  // 界面上那句「n=169 / 392」不说清剩下的 223 去哪了，读的人会以为报表缺数据。
  const done = cols.map(col => {
    const startKey = START_DATE_OF[col], endKey = END_DATE_OF[col];
    const vals = [];
    let zeroDone = 0, notReached = 0, noCalc = 0, missing = 0;
    for (const m of rows) {
      const v = m[col];
      if (typeof v !== 'number' || !isFinite(v)) { missing++; continue; }
      const s0 = startKey ? m[startKey] : null, e0 = endKey ? m[endKey] : null;
      if (endKey && !e0) { notReached++; continue; }        // ① 这一步还没走到
      if (startKey && !s0) { noCalc++; continue; }          // ② 起点缺，算不出来
      if (s0 && e0 && e0 < s0) { noCalc++; continue; }      // ③ 终点早于起点，同上
      if (v === 0) zeroDone++;                              // ④ 走到了还是 0 = 真秒过
      vals.push(v);
    }
    const q = quantiles(vals);
    return {
      col, note: COL_NOTE[col] || '', startKey, endKey,
      n: q ? q.n : 0,
      p50: q ? q.p50 : null, p75: q ? q.p75 : null,
      p90: q ? q.p90 : null, max: q ? q.max : null,
      zeroDone,      // 走到了、耗时确实是 0 —— 真的秒过（实测通道审核那 5 行是 50 秒）
      notReached,    // 这一步还没走到，那个 0 不是耗时
      noCalc,        // 起点缺 / 终点早于起点 —— 上游算出负数一律写 0
      missing,       // 报表里这一格根本没有数（实测是 0 行，但别假设）
    };
  });

  // 还在路上 = 建站到首笔这条主线没走完（没有第一笔成功交易日期）。
  // ⚠ 不能只看「站点_上线时长 == 0」：老商户排除那批上线时长也是 0
  //   （首笔早于建站提交，上游算出来是负数才写 0），但它们**已经有首笔交易**，
  //   不是在等 —— 混进来会把右栏的"等待天数"算成好几年。
  const asOf = led.date || '';
  const waitingRows = rows
    .filter(m => !m.第一笔成功交易日期)
    .map(m => ({
      ...m,
      等待天数: daysBetween(m.站点_商户提交日期, asOf),
      stage: waitStage(m),
    }));

  const order = ['还没提交通道', '已提交通道，等通道结果', '通道通过，等首笔交易'];
  const groups = order.map(stage => {
    const g = waitingRows.filter(r => r.stage === stage);
    const q = quantiles(g.map(r => r.等待天数));
    return { stage, n: g.length, rows: g,
             p50: q ? q.p50 : null, max: q ? q.max : null };
  }).filter(g => g.n > 0);

  const q = quantiles(waitingRows.map(r => r.等待天数));
  return {
    total: rows.length,
    byChannel: channelStats(rows),
    unit: led.耗时单位 || '小时 · 不含节假日',
    note: led.耗时口径 || '',
    done,
    waiting: {
      n: waitingRows.length, rows: waitingRows, groups,
      unit: '自然日 · 含周末',
      p50: q ? q.p50 : null, max: q ? q.max : null,
    },
  };
}

/**
 * 按「建议进件通道」分组看耗时和出单。
 *
 * 这一列**以前一次都没读过**，而它里面有东西：实测通道审核耗时
 * WORLDPAY 中位 **0.08h**（5 分钟）、FISERV **99.62h**（4 天），差一千多倍，
 * 三分之二的 FISERV 单子卡超 24 小时。
 *
 * ⚠ **只有「通道审核耗时」这一列是干净的因果**：那是我方的处理速度，
 *   不受"哪个通道分到了什么样的商户"影响。
 *   出单率也一起给，但它有选择偏差和时间偏差（实测 WORLDPAY 的商户
 *   进来得更早，中位 76 天 vs 41 天），**别单看那一列下结论**。
 * ⚠ 报表里通道那一格可能是空的 —— 单独成一组，不能凭空消失（加总要等于总行数）。
 */
function channelStats(rows) {
  const g = {};
  for (const m of rows) {
    const k = String(m.建议进件通道 || '').trim();
    (g[k] = g[k] || []).push(m);
  }
  return Object.keys(g).map(k => {
    const a = g[k];
    // 只有真的审完了的才进分母（同 done 那边的规矩：没走到不算数）
    const done = a.filter(m => m.通道结果反馈日期 && m.提交通道日期
                            && !(m.通道结果反馈日期 < m.提交通道日期)
                            && typeof m.通道审核耗时 === 'number');
    const qq = quantiles(done.map(m => m.通道审核耗时));
    const ok = a.filter(m => m.第一笔成功交易日期).length;
    // 上线时长同理，给一个"从建站到首笔"的中位当参考
    const sl = quantiles(a.filter(m => m.第一笔成功交易日期
                                    && typeof m.站点_上线时长 === 'number'
                                    && m.站点_上线时长 > 0)
                          .map(m => m.站点_上线时长));
    return {
      channel: k, n: a.length, rows: a,
      审核n: done.length,
      审核中位: qq ? qq.p50 : null,
      审核P75: qq ? qq.p75 : null,
      超24h: done.filter(m => m.通道审核耗时 > 24).length,
      上线中位: sl ? sl.p50 : null,
      出单: ok,
      出单率: a.length ? Math.round(ok / a.length * 1000) / 10 : 0,
    };
  }).sort((x, y) => y.n - x.n);   // 商户数从多到少 —— 不按耗时排，那会让 1 家的通道冒头
}

/** 还在等的那批卡在哪一步 —— 该催谁完全不一样。 */
function waitStage(m) {
  if (m.通道结果反馈日期) return '通道通过，等首笔交易';   // 催商户接入
  if (m.提交通道日期) return '已提交通道，等通道结果';      // 催通道
  return '还没提交通道';                                    // 催自己人
}

/* ---------------------------------------------------------------- ③ 分类 */

/* 群通知里那 7 档，顺序照 classify.DAILY_ORDER。 */
const DAILY_ORDER = ['✅ 新出单', '🧪 测试交易', '🐢 小额滞留', '🆕 新审核通过-待出单',
                     '👀 3天内未出单', '🔴 3-30天未出单', '🟠 30-60天未出单'];

/* 第 12 张票（2026-09-16）：原来那 68 家「开通>60天」整批丢弃，现在拆成两档。
   ⚠ **待激活是要发出去的一档**（单独一条消息、按周发），不是 pageOnly；
     >180 天才是只入表 —— 它进多维表格但不播报，所以 pageOnly=false 而 quiet=true。 */
const PENDING_BUCKET = '🟡 60-180天待激活';
const OVER_BUCKET = '⏸ 开通>180天';

/**
 * 现有 7 档 + 待激活 + 超 180 天。
 *
 * ⚠ 待激活那一档**真的会发出去**（第 12 张票把它从「丢弃」提上来了）——
 *   界面上别再写「只在这个页面上看得见」，那句话现在是错的。
 */
function classifyBuckets(led) {
  const rows = led.明细 || [];
  const byRemark = {};
  for (const m of rows) if (m.备注) (byRemark[m.备注] = byRemark[m.备注] || []).push(m);

  const buckets = DAILY_ORDER.map(name => ({
    name, pageOnly: false, n: (byRemark[name] || []).length, rows: byRemark[name] || [],
  }));

  const pending = byRemark[PENDING_BUCKET] || [];
  buckets.push({
    name: PENDING_BUCKET, pageOnly: false, n: pending.length, rows: pending,
    note: '进多维表格，也播报 —— 但**单独一条消息、按周发**，不混进日报',
  });

  const over = rows.filter(m => m.去向 === '开通>180天');
  buckets.push({
    name: OVER_BUCKET, pageOnly: false, quiet: true, n: over.length, rows: over,
    note: '只入表不播报：过了 90 分位那一带催不动了，但账要对得齐',
  });

  const bds = [...new Set(rows.map(m => (m.所属BD || '').trim()).filter(Boolean))].sort();
  return { buckets, bds, total: rows.length };
}

/* -------------------------------------------------- ③.5 BD 私聊名单 */

/* `notify.py` 的 `clean_bd_name()` 把空 BD 归到这个名字。
   ⚠ **它是个真能配的名字**，不是占位符 —— 给「未分配BD」配上邮箱，
     那批没有所属 BD 的商户就有人收得到。实测今天 124 行通知里 94 行没有 BD，
     不把它当成名单上的一项，这 94 行没有任何人看得见。 */
const NO_BD_NAME = '未分配BD';

/* 哪些档会私聊。照 `notify.py` 的 DAILY_STATUS / WEEKLY_STATUS，一字不差。
   ⚠ 周报那两档**只在 `weekly_send_weekday` 那天发**，和日报分开数 ——
     合在一起会把「这个 BD 今天会收到几条」说大。 */
const DM_DAILY = ['🆕 新审核通过-待出单', '👀 3天内未出单', '🐢 小额滞留',
                  '🧪 测试交易', '✅ 新出单'];
const DM_WEEKLY = ['🔴 3-30天未出单', '🟠 30-60天未出单'];
/* 第 12 张票：待激活**自己一条**，和上面那条周报分开发（notify.PENDING_STATUS）。
   ⚠ 别并进 DM_WEEKLY —— 并了就改到了现有那条「商户长期未出单周报」的内容。 */
const DM_PENDING = [PENDING_BUCKET];

/**
 * 配置页那张「BD 私聊名单」要的全部素材。
 *
 * ⚠ **这张名单错了不会报错。** `_send_for_map` 找不到邮箱只 print 一行警告
 *   就 continue —— 「名字打错一个字」和「这个 BD 今天没有需要跟进的商户」
 *   在群里、在日志里长得一模一样。所以这里把两件事**分开数**：
 *     rows[].configured=false → 台账里有这个人、名单里没有（要加）
 *     orphans                → 名单里有这个名字、台账里没有（名字对不上，要改）
 *
 * ⚠ **只数 `落点 === '通知+表'` 的行**：仅表 / 丢弃的那些配了也收不到，
 *   算进来会让人以为配上就有用。
 */
function bdRoster(led, bdEmails) {
  const emails = {};
  for (const [k, v] of Object.entries(bdEmails || {})) {
    const name = String(k).trim();
    if (name) emails[name] = String(v || '');
  }
  const notifySink = (led && led.落点顺序 && led.落点顺序[0]) || '通知+表';
  const daily = new Set(DM_DAILY), weekly = new Set(DM_WEEKLY), pending = new Set(DM_PENDING);

  const seen = new Map();
  for (const m of ((led && led.明细) || [])) {
    if (m.落点 !== notifySink) continue;          // 仅表 / 丢弃的收不到
    const name = String(m.所属BD || '').trim() || NO_BD_NAME;
    if (!seen.has(name)) seen.set(name, { name, dailyN: 0, weeklyN: 0, pendingN: 0 });
    const it = seen.get(name);
    // 三条私聊各自一条消息、各自数：合起来会把「这个 BD 今天会收到几条」说大
    if (daily.has(m.备注)) it.dailyN++;
    else if (weekly.has(m.备注)) it.weeklyN++;
    else if (pending.has(m.备注)) it.pendingN++;
  }

  const rows = [...seen.values()].map(it => ({
    ...it, dmN: it.dailyN + it.weeklyN + it.pendingN,
    email: emails[it.name] || '', configured: !!emails[it.name],
  })).sort((a, b) => b.dmN - a.dmN || b.dailyN - a.dailyN ||
                     a.name.localeCompare(b.name, 'zh'));

  const orphans = Object.keys(emails).filter(n => !seen.has(n))
    .sort((a, b) => a.localeCompare(b, 'zh'))
    .map(name => ({ name, email: emails[name] }));

  return { rows, orphans, notifySink,
           dmTotal: rows.reduce((s, x) => s + x.dmN, 0),
           missingN: rows.filter(x => !x.configured).length };
}

/* ------------------------------------------------------------ ④ 被拒站点 */

/**
 * 第三张 sheet「站点审核失败」。实测 711 行 / 528 个商户，**511 行没有所属 BD**。
 *
 * ⚠ 「读不到」和「一条都没有」必须分开（同 CLAUDE.md §2.12）：读不到给 null，
 *   界面上写出原因；当成 0 的话页面显示「今天没有被拒站点」——
 *   长得像个好消息，其实是上游改了表名。
 * ⚠ 「当日新增」也一样：首份台账没有前一天可比，那时候 newN 是 null 不是 0。
 */
function rejectView(led) {
  const r = led.被拒站点 || {};
  const rows = r.明细 || [];
  const noBd = rows.filter(x => !String(x.所属BD || '').trim());
  return {
    ok: r.行数 != null,
    n: r.行数 == null ? null : r.行数,
    error: r.读取失败原因 || '',
    rows,
    noBd,
    noBdN: r.无BD行数 == null ? noBd.length : r.无BD行数,
    newN: r.当日新增 == null ? null : r.当日新增,
    newRows: r.新增明细 || [],
    compareNote: r.对比说明 || '',
  };
}

export { reconcile, timingSplit, classifyBuckets, rejectView, applyFilter, filterChips,
         channelStats, isFiltered, FILTER_KEYS,
         bdRoster, NO_BD_NAME, DM_DAILY, DM_WEEKLY, DM_PENDING, PENDING_BUCKET, OVER_BUCKET,
         START_DATE_OF, END_DATE_OF, COL_NOTE, DAILY_ORDER,
         quantiles, daysBetween, pct };
