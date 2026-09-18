/* 纯口径 + 整理（不碰 DOM，tests/churn_page.mjs 直跑它）。
   状态机在 Python（churn/assess.py）；这里只做页面要的分组、筛选、标签。 */

/* 命中类型 → 人话。**要和 churn/assess.py 的 HIT_ORDER 一一对上**，用例钉着。 */
const HIT_LABEL = {
  '沉默30': '沉默满 30 天',
  '沉默7': '沉默满 7 天',
  '沉默2': '沉默满 2 天',
  '掉量·推': '掉量（推送档）',
  '掉量·页面': '掉量（页面档）',
  '恢复': '已恢复交易',
  '掉量关闭': '掉量已回来',
};

/* 严重度：只给沉默和掉量·推标红，页面档标黄，恢复类标绿。语义色四档，别拿品牌色当第五档。 */
const HIT_TONE = {
  '沉默30': 'crit', '沉默7': 'crit', '沉默2': 'warn', '掉量·推': 'crit', '掉量·页面': 'warn',
  '恢复': 'good', '掉量关闭': 'good',
};

/* 网关标签（第 07 张票）→ 色调和解释。**三种，缺数据是独立的一种** ——
   把它并进「全网关停止」的话，BD 会拿着一条「我们没数据」去催商户。
   文案要和 churn/assess.py 的 GW_* 一字不差，用例钉着。 */
const GW_META = {
  '其他通道仍有交易': { tone: 'warn', tip: '这家商户今天在网关报表里还有别的交易 —— 不是整个停了，是这条走掉了。⚠ 网关报表没有站点列，所以「其他通道」也可能是这家商户自己别的站点。' },
  '全网关停止': { tone: 'crit', tip: '这家商户今天在网关报表里一笔都没有：不是通道问题，是真的停了。' },
  '网关数据缺': { tone: '', tip: '这天没有网关台账，算不出来。**不猜**：没有数据不等于「全网关停止」。' },
};

/* 金额。≥100 取整（一张表里几十个数，小数点只是噪声）；更小的留两位，
   因为「$12.50」和「$13」在小额滞留那种场景里差别是有意义的。 */
const fmtMoney = n => {
  const v = Number(n) || 0;
  return '$' + (v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(v ? 2 : 0));
};
const fmtPct = r => (r == null || !isFinite(r)) ? '—' : (r > 0 ? '+' : '') + (r * 100).toFixed(0) + '%';

/** 第一档沉默天数。**跟着配置走，别写死 2** —— 配成 [3,7,30] 时顶上的说明写「满 3 天推」，
    下面的名单却从 2 天开始列，两处对不上而且谁都不报错。 */
const firstTier = state => (((state || {}).settings || {}).silence_days || [2])[0] || 2;

/** 沉默名单：沉默天数 ≥ 门槛的站点，保持 API 给的顺序（滚动 TPV 降序）。 */
function silentSites(sites, minDays = 2) {
  return (sites || []).filter(s => (s.silent_days || 0) >= minDays);
}

/** 按商户分组：同一用户ID 的站点合成一组，组按 30 天 TPV 之和降序，组内保持输入顺序。 */
function groupByMerchant(sites) {
  const map = new Map();
  for (const s of sites || []) {
    const uid = s['用户ID'] || '';
    if (!map.has(uid)) map.set(uid, { uid, name: s['商户名称'] || '', owner: s['直签人'] || '', tpv30: 0, sites: [] });
    const g = map.get(uid);
    g.tpv30 += Number(s.tpv30) || 0;
    g.sites.push(s);
    if (!g.name && s['商户名称']) g.name = s['商户名称'];
  }
  return [...map.values()].sort((a, b) => (b.tpv30 - a.tpv30) || (a.uid < b.uid ? -1 : 1));
}

/** 概览那一行要的几个数。 */
function summary(state) {
  const hits = state.hits || [], sites = state.sites || [];
  return {
    hits: hits.length,
    eligible: hits.filter(h => h.eligible).length,
    silent: silentSites(sites, firstTier(state)).length,
    sites: sites.length,
    gap: (state.gap || []).length,
    uncertain: sites.filter(s => s.uncertain).length,
    unclaimed: silentSites(sites, firstTier(state)).filter(unclaimed).length,
  };
}

/** 跟进状态怎么显示。**空 = 无人认领，明写出来** —— 那正是老板要看的信息，
    显示成空白的话看着像「还没同步」。 */
function followLabel(s) {
  const f = (s && s.follow) || {};
  const st = String(f['状态'] || '无人认领');
  const who = String(f['跟进人'] || '').trim();
  return who ? `${who} · ${st}` : st;
}

/** 这条是不是没人认领。概览里要数它。 */
const unclaimed = s => followLabel(s) === '无人认领';

/** 直签人怎么显示：19 位数字是代理商的 ID，不是人名。 */
function ownerLabel(s) {
  const o = String(s['直签人'] || '').trim();
  if (!o) return '未分配';
  if (/^\d{15,}$/.test(o)) return '代理商' + (s['代理商名称'] ? '：' + s['代理商名称'] : '');
  return o;
}

/* 筛选维度（第 09 张票）。**只有这一处** —— 渲染层再抄一份的话，
   加一维时两边必漂，而漂掉的样子是「筛选框在、点了没反应」（坑.md §2.18.7）。
   顺序就是界面上的顺序，走数组。 */
const FILTER_KEYS = ['owner', 'mode', 'type', 'kw'];
const FILTER_META = {
  owner: { label: '直签人', of: s => ownerLabel(s) },
  mode: { label: '接入模式', of: s => String(s['接入模式'] || '').trim() || '—' },
  type: { label: '类型', of: s => String(s.type || '').trim() },
  kw: { label: '搜商户 / 站点', free: true },
};

/** 某一维有哪些取值（按出现次数降序，同数按字典序）。`type` 走 HIT_LABEL 显示人话。 */
function filterOptions(rows, key) {
  const meta = FILTER_META[key];
  if (!meta || meta.free) return [];
  const n = new Map();
  for (const r of rows || []) {
    const v = meta.of(r);
    if (v) n.set(v, (n.get(v) || 0) + 1);
  }
  return [...n.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))
    .map(([value, count]) => ({ value, count, label: key === 'type' ? (HIT_LABEL[value] || value) : value }));
}

/** 选了几维就筛几维；空的那维不筛。关键词在商户名 / 站点 / 用户ID 里找。 */
function applyFilter(rows, f) {
  const sel = f || {};
  return (rows || []).filter(r => FILTER_KEYS.every(k => {
    const want = String(sel[k] || '').trim();
    if (!want) return true;
    if (k === 'kw') {
      const hay = `${r['商户名称'] || ''} ${r['站点'] || ''} ${r['用户ID'] || ''}`.toLowerCase();
      return hay.includes(want.toLowerCase());
    }
    return FILTER_META[k].of(r) === want;
  }));
}

/** 有没有在筛。界面上据此决定要不要显示「清空」。 */
const isFiltered = f => FILTER_KEYS.some(k => String((f || {})[k] || '').trim());

/** 掉量名单：推送档 / 页面档 / 已自动关闭，**三档分开**。
    合成一档的话「已经回来了」和「正在掉」混在一起，名单读起来是反的。 */
const DROP_TYPES = ['掉量·推', '掉量·页面', '掉量关闭'];
const dropHits = (state, type) => (state.hits || []).filter(h => h.type === type);

/** 一条通道异常的人话。数的是**家**不是条 —— 一家商户 7 个站点一起沉默是一家，不是七家。 */
function incidentLabel(g) {
  const n = Number((g || {}).merchants) || 0;
  const sites = Number((g || {}).sites) || 0;
  const more = sites > n ? `（${sites} 个站点）` : '';
  return `${(g || {})['网关'] || ''} · ${n} 家一起掉${more}`;
}

/** 漏斗那张表里的一个数怎么显示。**算不出来写「算不出」，不写 0**（坑.md §2.18 同一条）。 */
const fmtDays = v => (v == null || !isFinite(v)) ? '算不出' : `${Math.round(v)} 天`;

export { HIT_LABEL, HIT_TONE, GW_META, DROP_TYPES, FILTER_KEYS, FILTER_META,
         fmtMoney, fmtPct, fmtDays, firstTier, followLabel, unclaimed, silentSites,
         groupByMerchant, summary, ownerLabel, incidentLabel,
         filterOptions, applyFilter, isFiltered, dropHits };
