/* 交易大盘的口径层（static/js/churn/overview.js，第 14 张票）
 *
 *     node tests/churn_overview.mjs      # 零依赖
 *
 * 最要紧的一条：**台账缺的那天折线要断开**，不是连过去 —— 连过去等于在图上
 * 编一个真实存在过的低谷，而看图的人没法分辨。
 */
const O = await import('../static/js/churn/overview.js');

let fails = 0;
const check = (name, cond, extra = '') => {
  console.log((cond ? '  PASS ' : '  FAIL ') + name + (!cond && extra ? '  << ' + JSON.stringify(extra) : ''));
  if (!cond) fails++;
};

const p = (date, tpv) => (tpv == null ? { date, ok: false, tpv: null } : { date, ok: true, tpv });
const series = [p('d1', 100), p('d2', 300), p('d3', null), p('d4', 200), p('d5', 250)];

console.log('[1] ★ 缺的那天断线，不连过去');
const segs = O.segments(series);
check('断成两段', segs.length === 2 && segs[0].length === 2 && segs[1].length === 2, segs.map(s => s.length));
check('段里带原始下标（x 位置按下标算，不是按段内序号）', segs[1][0].i === 3, segs[1][0]);
check('全是好点时只有一段', O.segments([p('a', 1), p('b', 2)]).length === 1);
check('全缺时一段都没有', O.segments([p('a', null)]).length === 0);

console.log('[2] 折线几何');
const g = O.lineGeom(series, 400, 100);
check('max 取有数的点里的最大值', g.max === 300, g.max);
check('x 按窗口长度均分（不是按有数的点数）', Math.abs(g.x(4) - 400) < 1e-9 && Math.abs(g.x(0)) < 1e-9);
check('y 越大越靠上', g.y(300) < g.y(100) && Math.abs(g.y(300)) < 1e-9);
check('两段各自带坐标', g.segs.length === 2 && Math.abs(g.segs[1][0].cx - 300) < 1e-9, g.segs[1][0]);
check('末点和峰值单独给（只直标这两个，不是每个点都标）', g.last.tpv === 250 && g.peak.tpv === 300, [g.last, g.peak]);
check('一个点都没有也不炸', O.lineGeom([p('a', null)], 400, 100).segs.length === 0);

console.log('[3] 轴刻度是整数');
check('0/100/200/300', O.ticks(300).join() === '0,100,200,300', O.ticks(300));
check('大数也整齐', O.ticks(146000).every(t => t % 50000 === 0 || t === 0), O.ticks(146000));
check('0 不炸', O.ticks(0).join() === '0');

console.log('[4] 堆叠条：颜色按下标固定、「其他」用专色、放不下不直标');
const stack = O.stackGeom([{ name: 'A', share: 0.6 }, { name: 'B', share: 0.35 }, { name: '其他', share: 0.05 }]);
check('起点累加、宽度按占比', Math.abs(stack[1].at - 60) < 1e-9 && Math.abs(stack[1].w - 35) < 1e-9, stack[1]);
check('★ 颜色按下标取、不循环', stack[0].color === O.SERIES[0] && stack[1].color === O.SERIES[1], stack.map(s => s.color));
check('★「其他」用专门那支灰，不占分类色', stack[2].color === O.OTHER, stack[2].color);
check('★ 段太窄就不放直标（绝不裁字）', stack[0].inline === true && stack[2].inline === false, stack.map(s => s.inline));
check('第 7 类不会生成新颜色（算数那层已折成「其他」）', O.SERIES.length === 6);

console.log('[5] 数字格式');
check('金额', O.money(146000) === '$146,000' && O.money(1.23e6) === '$1.23M' && O.money(12.5) === '$12.50' && O.money(400) === '$400');
check('环比：小幅给一位小数', O.pct(-0.8) === '-80%' && O.pct(0.023) === '+2.3%' && O.pct(null) === '—');
check('占比', O.share(0.5714) === '57.1%');
check('笔数', O.num(1288) === '1,288' && O.num(null) === '—');

console.log();
process.exit(fails ? 1 : 0);
