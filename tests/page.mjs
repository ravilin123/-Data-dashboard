/* 看板页 dashboard.html 的纯函数 + 结构护栏。
 *
 *     node tests/page.mjs        # 零依赖，不起服务
 *
 * 页面把不碰 DOM 的函数放在 <script id="dashboard-lib"> 里，这里正则抓出来在 vm 里跑
 * （和 _harness.mjs 跑 UMD 的做法一样，但不改那个文件）。钉的都是图上**看不出错**的事：
 *   1. `y:null` 处折线要断开，不许连过去（契约 / §2.9）；段里带原始下标，画图按下标定 x。
 *   2. fmt 六种各自的样子，`null` 一律 `—`（契约：算不出来给 null，不给 0）。
 *   3. dod 是比率不是百分数，正负号要出来。
 *   4. 截断自报的文案带 shown / total（§2.16.5）。
 *   5. `#embedded-report` 标签原样在、内容恰好是 null —— 服务端导出靠字符串替换它。
 *   6. 零外部依赖：没有 <script src= / <link href= / import，file:// 双击要能开。
 */
import fs from 'fs'; import path from 'path'; import vm from 'vm';
import { fileURLToPath } from 'url';
import { makeChecker } from './_harness.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = makeChecker();

const htmlPath = path.join(ROOT, 'static', 'dashboard.html');
const html = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf8') : '';
check('static/dashboard.html 在', html.length > 0);

/* ---- 抓纯函数块 ---- */
const m = html.match(/<script id="dashboard-lib">([\s\S]*?)<\/script>/);
check('有 <script id="dashboard-lib"> 块', !!m);
const lib = {};
if (m) {
  const ctx = { console, Math, JSON, Number, String, Array, Object, isFinite, encodeURIComponent };
  vm.createContext(ctx);
  vm.runInNewContext(m[1], ctx);
  for (const k of ['fmtValue', 'fmtDod', 'segments', 'truncNote', 'buildQuery', 'kpiText'])
    lib[k] = ctx[k];
}
const { fmtValue, fmtDod, segments, truncNote, buildQuery, kpiText } = lib;
const fn = (f) => typeof f === 'function';
check('六个纯函数都导出了', ['fmtValue', 'fmtDod', 'segments', 'truncNote', 'buildQuery', 'kpiText'].every(k => fn(lib[k])),
      Object.entries(lib).filter(([, v]) => !fn(v)).map(([k]) => k).join(','));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---- [1] ★ y:null 处断段 ---- */
console.log('[1] ★ 折线在 y:null 处断开');
if (fn(segments)) {
  const pts = [{ x: 'a', y: 1 }, { x: 'b', y: null }, { x: 'c', y: 2 }, { x: 'd', y: 3 }];
  const seg = segments(pts);
  check('[1,null,2,3] 切成两段', seg.length === 2, JSON.stringify(seg));
  check('第一段只有下标 0', seg.length === 2 && same(seg[0].map(p => p.i), [0]), JSON.stringify(seg[0]));
  check('第二段是下标 2、3（原始下标，不是重新编号）', seg.length === 2 && same(seg[1].map(p => p.i), [2, 3]), JSON.stringify(seg[1]));
  check('段里带 y', seg.length === 2 && same(seg[1].map(p => p.y), [2, 3]));
  check('全 null → 零段', segments([{ x: 'a', y: null }, { x: 'b', y: null }]).length === 0);
  check('开头结尾 null 不产生空段', segments([{ x: 'a', y: null }, { x: 'b', y: 5 }, { x: 'c', y: null }]).length === 1);
  check('相邻两点都有值 → 一段（连线）', segments([{ x: 'a', y: 1 }, { x: 'b', y: 2 }]).length === 1);
  check('空数组 → 零段', segments([]).length === 0);
  check('y:0 是真值，不断', segments([{ x: 'a', y: 1 }, { x: 'b', y: 0 }, { x: 'c', y: 2 }]).length === 1);
}

/* ---- [2] ★ fmt 六种 + null ---- */
console.log('[2] ★ fmt 六种，null 显示 —');
if (fn(fmtValue)) {
  check('money 千分位两位小数', fmtValue(123456.78, 'money') === '123,456.78', fmtValue(123456.78, 'money'));
  check('money 补零', fmtValue(1000, 'money') === '1,000.00', fmtValue(1000, 'money'));
  check('money 负数', fmtValue(-1234.5, 'money') === '-1,234.50', fmtValue(-1234.5, 'money'));
  check('int 千分位整数', fmtValue(1234567, 'int') === '1,234,567', fmtValue(1234567, 'int'));
  check('int 小数四舍五入', fmtValue(12.6, 'int') === '13', fmtValue(12.6, 'int'));
  check('pct 是比率 → 百分数一位小数', fmtValue(0.031, 'pct') === '3.1%', fmtValue(0.031, 'pct'));
  check('pct 1 → 100.0%', fmtValue(1, 'pct') === '100.0%', fmtValue(1, 'pct'));
  check('pct 不带正号（正号是 dod 的事）', fmtValue(0.5, 'pct') === '50.0%', fmtValue(0.5, 'pct'));
  check('text 原样', fmtValue('张三', 'text') === '张三');
  check('date 原样', fmtValue('2026-09-17', 'date') === '2026-09-17');
  check('days → n 天', fmtValue(61, 'days') === '61 天', fmtValue(61, 'days'));
  for (const f of ['money', 'int', 'pct', 'text', 'date', 'days'])
    check(`null + ${f} → —`, fmtValue(null, f) === '—', fmtValue(null, f));
  check('undefined → —', fmtValue(undefined, 'money') === '—');
  check('不认识的 fmt 原样输出，不炸', fmtValue(7, 'whatever') === '7', fmtValue(7, 'whatever'));
  check('money 给了字符串数字也不炸', typeof fmtValue('abc', 'money') === 'string');
}

/* ---- [3] ★ dod 正负号 ---- */
console.log('[3] ★ dod 正负号与 null');
if (fn(fmtDod)) {
  check('+3.1%', fmtDod(0.031) === '+3.1%', fmtDod(0.031));
  check('-2.0%', fmtDod(-0.02) === '-2.0%', fmtDod(-0.02));
  check('0 → 0.0%（不带号）', fmtDod(0) === '0.0%', fmtDod(0));
  check('null → —', fmtDod(null) === '—', fmtDod(null));
  check('undefined → —', fmtDod(undefined) === '—');
  check('NaN → —', fmtDod(NaN) === '—', fmtDod(NaN));
}

/* ---- [4] ★ 截断自报 ---- */
console.log('[4] ★ 截断文案');
if (fn(truncNote)) {
  const t = truncNote({ shown: 10, total: 57 });
  check('带 shown 和 total', t.includes('10') && t.includes('57'), t);
  check('文案是「只列了 10 / 57 行」', t === '只列了 10 / 57 行', t);
  check('null → 空串', truncNote(null) === '', truncNote(null));
  check('undefined → 空串', truncNote(undefined) === '');
}

/* ---- [5] buildQuery ---- */
console.log('[5] buildQuery');
if (fn(buildQuery)) {
  check('两个参数', buildQuery({ source: 'workbench', date: '2026-09-17' }) === '?source=workbench&date=2026-09-17', buildQuery({ source: 'workbench', date: '2026-09-17' }));
  check('null / 空串 / undefined 跳过', buildQuery({ source: 'workbench', date: null, x: '', y: undefined }) === '?source=workbench', buildQuery({ source: 'workbench', date: null, x: '' }));
  check('全空 → 空串', buildQuery({ date: null }) === '', buildQuery({ date: null }));
  check('会编码', buildQuery({ q: 'a b&c' }) === '?q=a%20b%26c', buildQuery({ q: 'a b&c' }));
  check('数字 0 不算空', buildQuery({ refresh: 0 }) === '?refresh=0', buildQuery({ refresh: 0 }));
}

/* ---- [6] kpiText ---- */
console.log('[6] kpiText');
if (fn(kpiText)) {
  const k = kpiText({ key: 'tpv', label: '交易额', value: 123456.78, unit: 'USD', fmt: 'money', dod: 0.031, prev: 119700.5, note: '环比昨日' });
  check('主值按 fmt + 单位', k.main === '123,456.78 USD', k.main);
  check('副行：note + 带号 dod + 上期值', k.sub === '环比昨日 +3.1%（上期 119,700.50）', k.sub);
  const k2 = kpiText({ label: '笔数', value: null, fmt: 'int', dod: null, prev: null });
  check('value null → —', k2.main === '—', k2.main);
  check('dod null → 副行 —', k2.sub === '—', k2.sub);
  const k3 = kpiText({ label: '站点数', value: 12, fmt: 'int', dod: -0.1, prev: null });
  check('没 note 用「环比」', k3.sub === '环比 -10.0%', k3.sub);
  check('没 unit 不带空格尾巴', k3.main === '12', k3.main);
}

/* ---- [7] ★ 页面结构 ---- */
console.log('[7] ★ 页面结构：嵌入标签 / 零依赖');
{
  const emb = html.match(/<script id="embedded-report" type="application\/json">([\s\S]*?)<\/script>/);
  check('#embedded-report 标签在（id 和 type 一字不差）', !!emb);
  check('内容恰好是 null（服务端导出靠替换它）', !!emb && emb[1] === 'null', emb && JSON.stringify(emb[1]));
  check('只有一个 #embedded-report', (html.match(/id="embedded-report"/g) || []).length === 1);
  check('没有 <script src=（零外部依赖）', !/<script[^>]*\ssrc=/i.test(html));
  check('没有 <link href=（零外部依赖）', !/<link[^>]*\shref=/i.test(html));
  check('没有 import 语句', !/(^|[\s;])import\s/m.test(html.replace(/<!--[\s\S]*?-->/g, '')));
  check('没有 type="module"', !/type="module"/.test(html));
  check('dashboard-lib 块不碰 DOM', !!m && !/\b(document|window|location|fetch|localStorage|sessionStorage)\b/.test(m[1]));
  check('请求带 Authorization: Bearer', /Bearer/.test(html));
  check('导出走 fetch 拿 blob 再下载（不用 <a href>）', /blob/i.test(html) && /createObjectURL/.test(html));
  check('顺序走数组：页面里没有 .sort(', !/\.sort\(/.test(html));
  check('错误不 alert', !/\balert\(/.test(html));
  check('有 lang="zh"', /<html[^>]*lang="zh/.test(html));
}

check.report();
