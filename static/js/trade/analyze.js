/* 交易概览页的纯口径（第 15 张票）。不碰 DOM —— tests/trade_page.mjs 直跑它。

   ⚠ **几何和配色全部复用第 14 张票那层**（`../churn/overview.js`），这里不写第二份：
     两份的话改一处忘一处，而漂掉的样子是「两个页面上同一个数画出来不一样」。 */
export { SERIES, OTHER, colorAt, money, num, pct, share, ticks, segments, lineGeom, stackGeom }
  from '../churn/overview.js';

/* 三档周期 / 两个指标。**字面量要和 churn/trade.py 的 PERIODS / METRICS 一字不差** ——
   对不上的话接口会 400，而界面上看着就是「点了没反应」。用例钉着。 */
const PERIODS = ['日', '周', '月'];
const METRICS = [['tpv', '按交易额'], ['orders', '按笔数']];
const METRIC_KEY = { tpv: 'tpv', orders: 'orders' };

/* 构成分几块。顺序 = 界面上的顺序，**走数组**（Flask 的 sort_keys 会把 dict 键重排，§2.18.5）。 */
const COMP_DIMS = ['接入模式', '直签人', '代理商', '商户'];

/* 下钻的筛选维度。**唯一真相源在后端 `trade.DRILL_KEYS`**，接口把它带回来（`keys`）——
   这里这份只是读不到时的兜底，别在渲染层再抄第三份（§2.18.7）。 */
const DRILL_FALLBACK = ['接入模式', '直签人', '代理商', '商户', 'kw'];
const drillKeys = data => ((data && data.keys) || DRILL_FALLBACK);

/** 当前指标下这一点的值。算不出来给 null，**不给 0**。 */
const valueOf = (pt, metric) => (pt && pt.ok ? pt[METRIC_KEY[metric] || 'tpv'] : null);

/** 一期缺了几天要说出来：少三天的一周和完整的一周画在同一条线上，看着就是「那周掉了」。 */
function gapNote(pt) {
  if (!pt) return '';
  if (!pt.ok) return '这一期台账里一天都没有';
  const miss = (pt.gap || []).length;
  return miss ? `只有 ${pt.days}/${pt.span} 天有台账，缺 ${miss} 天` : '';
}

/** 趋势下面那行小字：这一段里有几期是不全的。**不全的期不许闷头画成正常的。** */
function partialCount(series) {
  return (series || []).filter(p => p.ok && (p.gap || []).length).length;
}

/** 环比：和上一期比。上一期算不出来时给 null，不是 +100%。 */
function dod(series, metric) {
  const s = series || [];
  const a = valueOf(s[s.length - 2], metric);
  const b = valueOf(s[s.length - 1], metric);
  return (a && b != null) ? b / a - 1 : null;
}

/** 校验那一行的人话。对不上不改数 —— 只说清楚差多少。 */
function checkNote(check) {
  if (!check) return '';
  if (check['同']) return `和报表的 ${check['期次']} 对得上`;
  const d = check['差'];
  return `⚠ 和报表的 ${check['期次']} 差 ${d > 0 ? '+' : ''}${Math.round(d).toLocaleString('en-US')}`;
}

/** 一条筛选的人话（chip 上显示）。 */
const chipLabel = (k, v) => (k === 'kw' ? `搜「${v}」` : `${k}：${v}`);

/** 在筛的那几维。空串不算 —— 不然「清空」按钮一直挂着。 */
function activeFilters(f, keys) {
  return (keys || DRILL_FALLBACK)
    .filter(k => String((f || {})[k] || '').trim())
    .map(k => ({ key: k, value: String(f[k]).trim(), label: chipLabel(k, String(f[k]).trim()) }));
}

export { PERIODS, METRICS, METRIC_KEY, COMP_DIMS, DRILL_FALLBACK,
         drillKeys, valueOf, gapNote, partialCount, dod, checkNote, chipLabel, activeFilters };
