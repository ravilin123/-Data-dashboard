/* 交易大盘的口径层（第 14 张票）。吃 /api/churn/overview 的结果，吐画图要的几何量。
   不碰 DOM —— tests/churn_overview.mjs 直跑它。

   ⚠ **算不出来的点不当 0**：台账缺的那天 `ok:false`，折线到那里**断开**，
     不是连过去（连过去等于在图上编一个真实存在过的低谷；同 §2.9 那条「缺环节断线」）。 */

/* 分类色。**取自 dataviz 的固定顺序（slot 1..6），按下标取、不循环**：
   第 7 类不生成新颜色，算数那层已经把尾巴折进「其他」了。
   浅深两套都跑过 validate_palette.js 的六项检查（2026-09-15）：
     light  #2a78d6,#eb6834,#1baf7a,#eda100,#e87ba4,#008300  全过
     dark   #3987e5,#d95926,#199e70,#c98500,#d55181,#008300  全过
   浅色下 aqua / yellow / magenta 对比度 < 3:1，**必须配直标或表格视图**（已配）。 */
const SERIES = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)'];
const OTHER = 'var(--c-other)';

const colorAt = (i, name) => (name === '其他' ? OTHER : SERIES[i % SERIES.length]);

const money = v => {
  const n = Number(v) || 0;
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + Math.round(n).toLocaleString('en-US');
  if (!n) return '$0';
  return '$' + (n >= 100 ? Math.round(n) : n.toFixed(2));
};
const num = v => (v == null ? '—' : Number(v).toLocaleString('en-US'));
const pct = r => (r == null || !isFinite(r) ? '—' : (r > 0 ? '+' : '') + (r * 100).toFixed(r > -0.1 && r < 0.1 ? 1 : 0) + '%');
const share = r => ((Number(r) || 0) * 100).toFixed(1) + '%';

/** 轴上的整数刻度：0 / 1,000 / 2,000 这种。

    **纵轴从 0 起**：日交易额在 27 万~43 万之间晃，截断纵轴会把日常噪声画成过山车。
    从 0 起看着「大致平稳、没有断崖」，那才是实情。 */
function ticks(max, n = 4) {
  if (!(max > 0)) return [0];
  const raw = max / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(x => x * mag).find(x => x >= raw) || mag * 10;
  const out = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(v);
  return out;
}

/** 折线的多段：台账缺的那天把线断开，一段一段画。 */
function segments(series, key = 'tpv') {
  const out = [];
  let cur = [];
  (series || []).forEach((p, i) => {
    if (p.ok && p[key] != null) cur.push({ ...p, i });
    else if (cur.length) { out.push(cur); cur = []; }
  });
  if (cur.length) out.push(cur);
  return out;
}

/** 折线的几何：点位、刻度、断段。宽高由调用方给（viewBox 坐标）。
    `key` 是画哪个指标（第 15 张票要按笔数看；一处定义，别再写一份几何层）。 */
function lineGeom(series, w, h, key = 'tpv') {
  const pts = (series || []).filter(p => p.ok && p[key] != null);
  const max = Math.max(1, ...pts.map(p => p[key]));
  const n = Math.max(1, (series || []).length - 1);
  const x = i => (i / n) * w;
  const y = v => h - (v / max) * h;
  return {
    max, x, y, key, ticks: ticks(max),
    segs: segments(series, key).map(seg => seg.map(p => ({ ...p, cx: x(p.i), cy: y(p[key]) }))),
    // 极值和末点直标 —— 不给每个点都标数（marks-and-anatomy：label selectively）
    last: pts.length ? { ...pts[pts.length - 1], cx: x(series.indexOf(pts[pts.length - 1])), cy: y(pts[pts.length - 1][key]) } : null,
    peak: pts.length ? pts.reduce((a, b) => (b[key] > a[key] ? b : a)) : null,
  };
}

/** 100% 堆叠条的分段：起点、宽度、颜色，外加「标签放不放得下」。 */
function stackGeom(groups, width = 100) {   // `share` 由算数层按当前指标算好（trade.group_by 的 metric）
  let at = 0;
  return (groups || []).map((g, i) => {
    const w = (Number(g.share) || 0) * width;
    const seg = { ...g, at, w, color: colorAt(i, g.name) };
    at += w;
    // 这一段宽到**放得下**一行字没有？现在段内不写字（白字在浅色块上看不清），
    // 留着这个标记给以后要在段里标东西的人：放不下就别放，绝不裁字。
    seg.inline = w >= 14;
    return seg;
  });
}

export { SERIES, OTHER, colorAt, money, num, pct, share, ticks, segments, lineGeom, stackGeom };
