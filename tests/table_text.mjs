/* 表 → 文本（喂给 AI 的那一份，`static/js/shared/table_text.js`）。
 *
 *     node tests/table_text.mjs
 *
 * 这块原来在 `merchant.html` 里，是 `data.filter(...).slice(0, max)` 一刀切，
 * 两个后果**都是静默的**，而且模型的语气一样肯定：
 *
 *   1. **合计行被切掉。** 交叉表的「合计」是最后一行，260 行截到 40 行时
 *      那个锚点数字直接消失，模型只好拿列出来的几十行自己加。
 *   2. **模型不知道自己看的是残表。** 实测一份 9800 笔的流水：
 *      买家IP国家×卡BIN国家 400 行只发了 40 行（丢 90%）、
 *      IP国家×失败原因 260 行发 40 行（丢 85%）、日期×失败原因 182 行发 60 行（丢 67%）。
 *
 * 所以这套钉的是：合计行永远在、截断要自报、残差合计只加计数列。
 */
import { MODULES, makeChecker } from './_harness.mjs';
const check = makeChecker();
const SHARED = MODULES.replace('/conversion/', '/shared/');
const { COUNT_COL_RE, fmtPctCell, serializeTable } = await import(SHARED + 'table_text.js');

const COLS = ['国家', '失败笔数', '占该维度失败比'];
/** n 行正文（笔数从大到小）+ 一行合计 */
function table(n, {total = true, desc = true} = {}){
  const data = [];
  for(let i = 0; i < n; i++){
    const k = desc ? n - i : i + 1;          // desc: 100, 99, 98…
    data.push({国家: 'C' + i, 失败笔数: k, 占该维度失败比: 12.5});
  }
  if(total) data.push({国家: '合计', 失败笔数: data.reduce((s, r) => s + r.失败笔数, 0),
                       占该维度失败比: '', __total: true});
  return {columns: COLS, data};
}
const lines = s => s.split('\n');

console.log('[1] 没超上限：原样，不加任何说明');
{
  const out = serializeTable(table(3), 40);
  check('表头 + 3 行 + 合计 = 5 行', lines(out).length === 5, String(lines(out).length));
  check('★ 不出现截断说明（没截就别啰嗦）', !out.includes('本表共'), out);
  check('合计行在', out.includes('合计'), out);
}

console.log('[2] ★ 截断时合计行必须活下来');
{
  const out = serializeTable(table(100), 10);
  const rows = lines(out);
  check('★ 合计行还在（原来会被 slice 直接切掉）',
        rows.some(r => r.startsWith('合计')), rows.slice(-3).join(' ⏎ '));
  check('正文只列 10 行', rows.filter(r => /^C\d+ \|/.test(r)).length === 10,
        String(rows.filter(r => /^C\d+ \|/.test(r)).length));
  check('合计值是**全表**的（1+…+100）', out.includes('合计 | 5050'), rows.find(r => r.startsWith('合计')));
}

console.log('[3] ★ 截断要自报：共几行、列了几行、没列的合计多少');
{
  const out = serializeTable(table(100), 10);
  check('★ 说了共多少行', out.includes('本表共 100 行'), out.slice(-260));
  check('★ 说了只列了几行', out.includes('只列出前 10 行'), out.slice(-260));
  // 没列出的是 1..90，合计 4095
  check('★ 给了未列出那批的残差合计（不然模型没法把账合上）',
        out.includes('失败笔数 4095'), out.slice(-260));
  check('★ 点明合计行是全表的', out.includes('合计行是**全表**的'), out.slice(-260));
}

console.log('[4] ★ 残差只加计数列 —— 比率/比值/贡献度一律不加');
{
  const t = {
    columns: ['BIN', '笔数', '卡数', '邮箱数', '笔/卡', '影响力', '占总量比'],
    data: [...Array(5)].map((_, i) => ({BIN: 'B' + i, 笔数: 10, 卡数: 9, 邮箱数: 8,
                                        '笔/卡': 1.11, 影响力: 0.02, 占总量比: 20})),
  };
  const out = serializeTable(t, 2);
  /* 只对**残差那一行**断言 —— 表头和正文里当然有这些列名，
     要钉的是「它们有没有被加进残差合计」。 */
  const note = out.slice(out.indexOf('计数列合计：'));
  check('★ 计数列加了', note.includes('笔数 30'), note);
  check('★ 比值列没加（笔/卡 相加毫无意义）', !note.includes('笔/卡'), note);
  check('★ 贡献度没加（影响力 Σ 恒等于 0）', !note.includes('影响力'), note);
  check('★ 百分比列没加', !note.includes('占总量比'), note);
  /* 卡数 / 邮箱数 故意不加：同一个邮箱可能跨多个 BIN，跨行相加是重复计数。
     它们长得最像计数列，白名单漏一个字就会把它们放进来。 */
  check('★ 卡数 / 邮箱数 故意不加（跨行会重复计数）',
        !note.includes('卡数') && !note.includes('邮箱数'), note);
  check('白名单认得出计数列', COUNT_COL_RE.test('失败笔数_本期') && COUNT_COL_RE.test('总计_上期')
        && COUNT_COL_RE.test('单量对比值') && !COUNT_COL_RE.test('影响力'));
}

console.log('[5] ★ 「已按 X 降序」只在真的降序时才写');
{
  const desc = serializeTable(table(100), 10);
  check('★ 真降序 → 写出来（模型才知道列的是最大的那批）',
        desc.includes('从大到小排'), desc.slice(-260));
  const asc = serializeTable(table(100, {desc: false}), 10);
  check('★ 不是降序 → 不许写（按小时/按日是按键排的，写了会让模型以为前 N 行最大）',
        !asc.includes('从大到小排'), asc.slice(-260));
}

console.log('[6] 边界：没有合计行、空表、__sep 行');
{
  const noTot = serializeTable(table(50, {total: false}), 10);
  check('没有合计行时不瞎说「合计行是全表的」', !noTot.includes('合计行是**全表**的'), noTot.slice(-200));
  check('但截断说明照出', noTot.includes('本表共 50 行'), noTot.slice(-200));
  check('空表给空串', serializeTable({columns: [], data: []}) === '');
  check('null 给空串', serializeTable(null) === '' && serializeTable(undefined) === '');
  // 分隔行（失败原因表里那条「--- 以下为明细 ---」）不进文本，也不占行数
  const sep = {columns: COLS, data: [{国家: '---', __sep: true}, {国家: 'A', 失败笔数: 1, 占该维度失败比: 5}]};
  check('__sep 行被剔掉', !serializeTable(sep).includes('---'), serializeTable(sep));
  // 没有任何数据行时只出表头，不留一个空行（空行会被当成一条空记录读）
  check('没有数据行时只出表头', serializeTable({columns: COLS, data: []}) === COLS.join(' | '),
        JSON.stringify(serializeTable({columns: COLS, data: []})));
}

console.log('[7] fmtPctCell：只给「占 / 率」列的数值加 %');
{
  check('占比列加 %', fmtPctCell('占失败比', 12.5) === '12.5%');
  check('通过率列加 %', fmtPctCell('通过率_本期', 90) === '90%');
  check('笔数列不加', fmtPctCell('失败笔数', 12) === 12);
  check('空串原样', fmtPctCell('占失败比', '') === '');
  check('null 原样', fmtPctCell('占失败比', null) === null);
  check('非数值原样', fmtPctCell('占失败比', 'N/A') === 'N/A');
}

check.report();
