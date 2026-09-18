/* 商户流失页的纯口径（static/js/churn/analyze.js，第 04 张票）
 *
 *     node tests/churn_page.mjs      # 零依赖
 *
 * 状态机在 Python（tests/churn_assess.py 钉着），页面这边只做分组、筛选、标签。
 * 最要紧的一条是**命中类型的人话标签要和 Python 那边的类型一一对上** ——
 * 少一个的话页面上会直接印出「沉默30」这种内部名，而且不报错。
 */
import fs from 'fs'; import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const A = await import('../static/js/churn/analyze.js');

let fails = 0;
const check = (name, cond, extra = '') => {
  console.log((cond ? '  PASS ' : '  FAIL ') + name + (!cond && extra ? '  << ' + JSON.stringify(extra) : ''));
  if (!cond) fails++;
};

console.log('[1] 命中类型的标签和 Python 的 HIT_ORDER 一一对上');
const py = fs.readFileSync(path.join(ROOT, 'churn', 'assess.py'), 'utf8');
const m = py.match(/HIT_ORDER\s*=\s*\[([^\]]*)\]/);
const consts = Object.fromEntries([...py.matchAll(/^([A-Z_]+)\s*=\s*"([^"]+)"/gm)].map(x => [x[1], x[2]]));
const types = m[1].split(',').map(s => s.trim()).filter(Boolean)
  .map(s => s.startsWith('"') ? s.slice(1, -1) : consts[s]);
check('Python 那边有 7 种类型', types.length === 7, types);
for (const t of types) check(`「${t}」有人话标签和色调`, !!A.HIT_LABEL[t] && !!A.HIT_TONE[t], t);
check('JS 这边没有多出来的类型', Object.keys(A.HIT_LABEL).every(t => types.includes(t)), Object.keys(A.HIT_LABEL));

console.log('[1b] ★ 网关标签的文案和 Python 的 GW_* 一字不差（对不上就整个标签不显示，还不报错）');
const gws = [...py.matchAll(/^GW_[A-Z_]+\s*=\s*"([^"]+)"/gm)].map(x => x[1]);
check('Python 那边是三种', gws.length === 3, gws);
for (const g of gws) check(`「${g}」页面上有色调和解释`, !!A.GW_META[g] && !!A.GW_META[g].tip, g);
check('JS 这边没有多出来的', Object.keys(A.GW_META).every(g => gws.includes(g)), Object.keys(A.GW_META));
check('★「网关数据缺」不带严重色（它不是一个结论，是「算不出来」）', A.GW_META['网关数据缺'].tone === '');
check('「全网关停止」是红的、「其他通道仍有交易」是黄的',
  A.GW_META['全网关停止'].tone === 'crit' && A.GW_META['其他通道仍有交易'].tone === 'warn');
check('★「其他通道」那条解释里写明了它是商户级的（网关报表没有站点列）',
  /站点/.test(A.GW_META['其他通道仍有交易'].tip), A.GW_META['其他通道仍有交易'].tip);

console.log('[1c] 通道异常的人话：数的是「家」');
check('一家一个站点', A.incidentLabel({ '网关': 'A', merchants: 3, sites: 3 }) === 'A · 3 家一起掉');
check('★ 站点比家多时把站点数也写出来（否则看着像只掉了 2 家）',
  A.incidentLabel({ '网关': 'A', merchants: 2, sites: 14 }) === 'A · 2 家一起掉（14 个站点）');
check('空输入不炸', typeof A.incidentLabel(null) === 'string');

console.log('[2] 沉默名单：≥2 天才算，顺序保持');
const site = (uid, s, days, tpv, extra = {}) => ({ 用户ID: uid, 站点: s, 商户名称: '商户' + uid.slice(-1), 直签人: '张三',
  silent_days: days, tpv30: tpv, active30: 20, ...extra });
const sites = [site('1', 'a.com', 3, 900), site('2', 'b.com', 0, 800), site('1', 'c.com', 2, 100), site('3', 'd.com', 1, 50)];
const silent = A.silentSites(sites);
check('只留 ≥2 天的、顺序不变', silent.map(s => s.站点).join() === 'a.com,c.com', silent.map(s => s.站点));
check('minDays 可调', A.silentSites(sites, 3).length === 1);

console.log('[2b] ★ 沉默名单的门槛跟着 silence_days 走，不写死 2');
check('默认第一档是 2', A.firstTier({}) === 2 && A.firstTier({ settings: {} }) === 2);
check('配成 [3,7,30] 时门槛是 3', A.firstTier({ settings: { silence_days: [3, 7, 30] } }) === 3);
check('概览里的沉默数跟着门槛走',
  A.summary({ hits: [], sites, settings: { silence_days: [3, 7, 30] } }).silent === 1
  && A.summary({ hits: [], sites }).silent === 2,
  [A.summary({ hits: [], sites, settings: { silence_days: [3] } }).silent, A.summary({ hits: [], sites }).silent]);

console.log('[3] 按商户分组：组按 30 天 TPV 之和降序，组内保持顺序');
const groups = A.groupByMerchant([site('2', 'b.com', 3, 800), site('1', 'a.com', 3, 500), site('1', 'c.com', 2, 400)]);
check('两组，商户 1（900）在商户 2（800）前面', groups.map(g => g.uid).join() === '1,2', groups.map(g => [g.uid, g.tpv30]));
check('组内站点顺序不变、金额求和', groups[0].sites.map(s => s.站点).join() === 'a.com,c.com' && groups[0].tpv30 === 900);
check('空输入给空数组', A.groupByMerchant([]).length === 0 && A.groupByMerchant(null).length === 0);

console.log('[3b] ★ 谁在跟：空的明写「无人认领」，不是空白');
check('没回读到 → 无人认领', A.followLabel({}) === '无人认领' && A.unclaimed({}) === true);
check('有人有状态 → 「张三 · 跟进中」',
  A.followLabel({ follow: { 跟进人: '张三', 状态: '跟进中' } }) === '张三 · 跟进中');
check('有状态没人 → 只显示状态', A.followLabel({ follow: { 状态: '无人认领' } }) === '无人认领');
check('概览里数无人认领的',
  A.summary({ hits: [], sites: [site('1', 'a', 3, 9), { ...site('2', 'b', 3, 9), follow: { 跟进人: '张三', 状态: '跟进中' } }] }).unclaimed === 1);

console.log('[4] 直签人怎么显示');
check('人名照显示', A.ownerLabel({ 直签人: '张三' }) === '张三');
check('空 → 未分配', A.ownerLabel({ 直签人: '' }) === '未分配' && A.ownerLabel({}) === '未分配');
check('19 位数字 → 代理商', A.ownerLabel({ 直签人: '1909165812357570562', 代理商名称: '磐嶽' }) === '代理商：磐嶽');

console.log('[5] 概览数字');
const sm = A.summary({ hits: [{ eligible: true }, { eligible: false }], sites: [...sites, site('9', 'z', 5, 1, { uncertain: true })], gap: ['2026-09-08'] });
check('命中 / 有资格 / 沉默 / 缺口 / 不确定', sm.hits === 2 && sm.eligible === 1 && sm.silent === 3 && sm.gap === 1 && sm.uncertain === 1, sm);

console.log('[6] 数字格式');
check('金额：≥100 取整、小额留两位、0 不带小数',
  A.fmtMoney(81782) === '$81,782' && A.fmtMoney(400) === '$400'
  && A.fmtMoney(12.5) === '$12.50' && A.fmtMoney(0) === '$0',
  [A.fmtMoney(81782), A.fmtMoney(400), A.fmtMoney(12.5), A.fmtMoney(0)]);
check('环比', A.fmtPct(-0.75) === '-75%' && A.fmtPct(0.07) === '+7%' && A.fmtPct(null) === '—');

console.log();
process.exit(fails ? 1 : 0);
