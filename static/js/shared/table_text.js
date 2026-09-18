/* ============================================================
   表 → 文本（喂给 AI 的那一份）

   从 `merchant.html` 抽出来的第一块（2026-09-09）。抽它是因为**它是纯函数、
   而且刚修过一个静默出错的坑**，得能拿单元测试钉住 —— 页面那 3000 行里
   一个函数都跑不了单测，这块是往外拆的起点。

   `fmtPctCell` 一起搬过来：`serializeTable` 依赖它，留在页面里就等于这份
   还得跨文件拿一个函数。
   ============================================================ */

/* 百分比格式化（对应 Python 的 format_percentage）。
   数值 + 列名带「占」或「率」→ 加个 %；其余原样。 */
function fmtPctCell(col, val){
  if((col.includes("占")||col.includes("率")) && val!=="" && val!=null && typeof val==="number" && isFinite(val))
    return val+"%";
  return val;
}

/* 残差合计**只加计数列**，而且用白名单不用黑名单。
   黑名单（「排掉带 占/率/比 的」）漏得太容易：第一版就把 BIN集中度 的
   `笔/卡`（一个比值）和 `影响力`（Σ 恒等于 0 的贡献度）加了出来 ——
   模型看到一个数字就会用它，而那两个数一点意义都没有。
   `卡数`/`邮箱数` 也**故意不加**：同一个邮箱可能跨多个 BIN，跨行相加是重复计数。 */
const COUNT_COL_RE = /笔数|总计|单量|单数/;

/**
 * 一张表 → 提示词里的一段。
 *
 * ⚠️ **截断必须说出来，而且合计行一行都不能丢。**（2026-09-09）
 * 原来是 `data.filter(...).slice(0, max)` 一刀切，两个后果都是静默的：
 *
 * 1. **合计行被切掉。** 交叉表的 `合计` 是最后一行（`__total`），
 *    260 行的表截到 40 行，那个锚点数字直接消失 —— 模型只好拿列出来的
 *    这几十行自己加，加出来的「总失败笔数」比真值小一大截，后面每个占比都跟着错。
 * 2. **模型不知道自己看的是残表。** 实测一份 9800 笔的流水：
 *    买家IP国家×卡BIN国家 400 行只发了 40 行（丢 90%）、
 *    IP国家×失败原因 260 行发 40 行（丢 85%）、
 *    日期×失败原因 182 行发 60 行（丢 67%）。
 *    模型会照着残表算占比、下「主要集中在这几个组合」的结论，而且**语气一样肯定**。
 *
 * 现在：合计行永远单独留下；截断了就在表尾写明「共 N 行 / 只列了 M 行 /
 * 未列出的那 N−M 行合计是多少」。给残差合计是关键 —— 只说「被截断了」，
 * 模型还是没法把账合上；给了它就能。
 *
 * ⚠️ 残差合计**只加计数列**（`COUNT_COL_RE` 白名单），比率、比值、贡献度一律不加。
 * ⚠️ 「已按 X 降序」只在**真的单调不增**时才写。多数表确实按笔数降序，
 *    但按小时/按日是按键排的 —— 写死一句「已降序」会让模型以为前 N 行是最大的那批。
 */
function serializeTable(t,maxRows){
  if(!t||!t.columns.length) return "";
  const all=t.data.filter(r=>!r.__sep);
  const totals=all.filter(r=>r.__total), body=all.filter(r=>!r.__total);
  const cap=maxRows||40;
  const shown=body.slice(0,cap), cut=body.slice(cap);
  const line=r=>t.columns.map(c=>fmtPctCell(c,r[c]===undefined?"":r[c])).join(" | ");
  const body2=[...shown,...totals].map(line);
  let out=t.columns.join(" | ")+(body2.length?"\n"+body2.join("\n"):"");
  if(!cut.length) return out;

  // 残差：未列出那批的计数列合计，让模型还能把账合上
  const sums=[];
  for(const c of t.columns){
    if(!COUNT_COL_RE.test(c)) continue;
    let acc=0, any=false;
    for(const r of cut){ const v=r[c]; if(typeof v==="number" && isFinite(v)){ acc+=v; any=true; } }
    if(any) sums.push(`${c} ${Math.round(acc*100)/100}`);
  }
  // 排序说明只在真的单调不增时才给
  const numCol=t.columns.find(c=>COUNT_COL_RE.test(c) && body.every(r=>typeof r[c]==="number"));
  let ordered=false;
  if(numCol) ordered=body.every((r,i)=>i===0 || body[i-1][numCol]>=r[numCol]);
  const bits=[`本表共 ${body.length} 行（不含合计行），这里只列出前 ${shown.length} 行`];
  if(ordered) bits.push(`已按「${numCol}」从大到小排，所以列出的是最大的那批`);
  bits.push(sums.length ? `未列出的 ${cut.length} 行的计数列合计：${sums.join(" / ")}`
                        : `另有 ${cut.length} 行未列出`);
  if(totals.length) bits.push(`表中的合计行是**全表**的，不是所列这几行的`);
  return out + `\n（⚠️ ${bits.join("；")}。凡是要用到全表的结论，请用合计行或上面这个残差合计，`
             + `不要拿列出的这几行自己加总当成全量。）`;
}

export { COUNT_COL_RE, fmtPctCell, serializeTable };
