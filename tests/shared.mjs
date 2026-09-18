/* static/js/shared/ —— 三个页面共用的那几样。
 *
 *     node tests/shared.mjs
 *
 * 建这一层的起因是**同一个函数有三份实现，而且行为不一样**（第七轮 T7）。
 * 最要命的是 esc：
 *
 *   conversion  String(s)                → esc(null) 给出字面量 "null"，会印在页面上
 *   merchant    String(v==null?"":v)     → 给空串
 *   index       String(s==null?'':s) 且多转义 "  → 只有它在属性上下文里是安全的
 *
 * 而 esc() 在 render/ 里有 8 处用在 HTML 属性值里（data-kw / data-mid / data-metric…），
 * 塞的是站点 URL、商户名、指标名这些源表来的字符串。不转义引号就是等着某天崩。
 * 统一取最严的那份：null/undefined → 空串，& < > " ' 全转。
 */
import { MODULES, installBrowserStubs, makeChecker } from './_harness.mjs';
installBrowserStubs();
const check = makeChecker();
const SHARED = MODULES.replace('/conversion/', '/shared/');
const { esc } = await import(SHARED + 'dom.js');
const { promptSize } = await import(SHARED + 'ai.js');

console.log('[1] esc：空值给空串，不给字面量 "null"');
{
  check('null → 空串', esc(null) === '', JSON.stringify(esc(null)));
  check('undefined → 空串', esc(undefined) === '', JSON.stringify(esc(undefined)));
  check('0 保留', esc(0) === '0', JSON.stringify(esc(0)));
  check('空串保留', esc('') === '', JSON.stringify(esc('')));
  check('false 保留', esc(false) === 'false', JSON.stringify(esc(false)));
}

console.log('[2] esc：属性上下文安全 —— 引号必须转');
{
  check('双引号', esc('a"b') === 'a&quot;b', esc('a"b'));
  check('单引号', esc("a'b") === 'a&#39;b', esc("a'b"));
  check('尖括号与和号', esc('<a & b>') === '&lt;a &amp; b&gt;', esc('<a & b>'));
  // 真实场景：站点 URL 进 data-kw
  const evil = 'https://x.com/" onmouseover="alert(1)';
  const out = esc(evil);
  check('★ 带引号的站点值不会撑破属性', !out.includes('"'), out);
  check('  转义后仍可读', out.includes('onmouseover=&quot;'), out);
}

console.log('[3] esc：正常内容一个字不动（老行为不变）');
{
  for (const s of ['独立站API', '4. 网关通过率', 'shopifly.net', '83.92%', 'U123'])
    check(`原样：${s}`, esc(s) === s, esc(s));
}

console.log('[4] promptSize：两页原本各有一份逐字节相同的实现');
{
  const r = promptSize('中文abc');   // 2 个中文 + 3 个 ASCII
  check('字符数照实数', r.chars === 5, JSON.stringify(r));
  check('中文按 0.8 估、ASCII 按 0.28', r.est === Math.round(2*0.8 + 3*0.28), JSON.stringify(r));
  check('空串不炸', promptSize('').chars === 0 && promptSize('').est === 0);
  // 纯中文：1000 字约 800 tokens，这是「会不会太大」的判断依据
  check('1000 个中文约 800 tokens', promptSize('汉'.repeat(1000)).est === 800,
        promptSize('汉'.repeat(1000)).est);
}

check.report();
